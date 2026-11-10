import { emptyInput, type FlightInput } from '../sim/ship';

export type Action =
  | 'warpUp'
  | 'warpDown'
  | 'camera'
  | 'map'
  | 'galaxy'
  | 'journal'
  | 'target'
  | 'hud'
  | 'help'
  | 'debug'
  | 'stop'
  | 'photo'
  | 'capture'
  | 'look'
  | 'snapshot'
  | 'info'
  | 'back';

/** Seconds a throttle key must be held before it sweeps instead of stepping one notch. */
export const NOTCH_HOLD = 0.25;
/** Throttle lever notch size. */
export const NOTCH = 0.1;

/** Pure: the next lever notch above (dir 1) or below (dir -1) the current setting, on the 10% grid. */
export function stepNotch(current: number, dir: 1 | -1): number {
  const g = current / NOTCH;
  const next = dir > 0 ? Math.floor(g + 1e-3) + 1 : Math.ceil(g - 1e-3) - 1;
  return Math.min(1, Math.max(0, Math.round(next * 1000) / 1000 * NOTCH));
}

/**
 * Mouse + keyboard. The mouse drives a virtual joystick that slowly recenters, so small
 * pushes give gentle turns. Pointer lock is requested on click.
 */
export class Input {
  /** Virtual stick, -1..1 each axis. */
  readonly stick = { x: 0, y: 0 };
  sensitivity = 0.0022;
  recenterTime = 0.9;
  invertY = false;
  rightMouse = false;
  /** True on touch devices; the HUD adapts. */
  touchMode = false;
  /** Axes injected by other devices (touch). Merged in poll(); values are -1..1. */
  readonly external = {
    active: false,
    pitch: 0,
    yaw: 0,
    roll: 0,
    boost: false,
    align: false,
    /** Absolute throttle 0..1, consumed by the next poll. */
    throttleSet: null as number | null,
    /** Gamepad channel, rewritten every frame by Gamepad. Always merged (zeros when absent). */
    pad: { pitch: 0, yaw: 0, roll: 0, throttleDelta: 0, boost: false, brake: false, align: false, look: false },
  };
  /** False in photo mode: clicks no longer grab the pointer. */
  lockEnabled = true;
  /** Wheel notches consumed by the last poll (signed, 0.08 per notch), for photo zoom. */
  wheelUsed = 0;
  /** Look mode: the camera orbits the ship and mouse steering is suspended. */
  lookMode = false;
  /** Current throttle setting 0..1, so taps can step to the next notch. Wired by main. */
  throttleNow: () => number = () => 0;
  /** Orbit zoom accumulated since the last consume (wheel, pinch). Positive zooms out. */
  private zoom = 0;
  /** Raw mouse delta this frame while right mouse is held (free look). */
  readonly look = { x: 0, y: 0 };
  private keys = new Set<string>();
  private listeners = new Map<Action, (() => void)[]>();
  private throttleSet: number | null = null;
  private notches = 0;
  private heldSince = new Map<string, number>();
  private wheelAcc = 0;
  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      if (this.lockEnabled && document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      if (this.rightMouse || this.lookMode) {
        this.look.x += e.movementX;
        this.look.y += e.movementY;
        return;
      }
      this.stick.x = clamp(this.stick.x + e.movementX * this.sensitivity, -1, 1);
      this.stick.y = clamp(this.stick.y + e.movementY * this.sensitivity * (this.invertY ? -1 : 1), -1, 1);
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.rightMouse = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightMouse = false;
    });
    window.addEventListener('wheel', (e) => {
      const step = Math.sign(e.deltaY) * -0.08;
      this.wheel += step;
      if (this.lookMode) {
        this.zoom -= step * 6;
        return;
      }
      // One notch per wheel step; smooth trackpads accumulate until a step's worth.
      const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      this.wheelAcc += px;
      while (Math.abs(this.wheelAcc) >= 40) {
        this.notches += this.wheelAcc < 0 ? 1 : -1;
        this.wheelAcc -= Math.sign(this.wheelAcc) * 100;
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyW' || e.code === 'KeyS') {
        this.heldSince.set(e.code, performance.now());
        if (this.lockEnabled) this.notches += e.code === 'KeyW' ? 1 : -1;
      }
      const action = KEY_ACTIONS[e.code];
      if (action) {
        this.emit(action);
        if (e.code === 'F3') e.preventDefault();
      }
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        this.throttleSet = n === 0 ? 1 : n / 10;
      }
      if (e.code === 'Backquote') this.throttleSet = 0;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.heldSince.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.heldSince.clear();
    });
    // V toggles look mode, but not while the photo panel owns the camera.
    this.on('look', () => {
      if (!this.lockEnabled) return;
      this.lookMode = !this.lookMode;
      this.stick.x = this.stick.y = 0;
    });
  }

  /** Adds a throttle notch step from a non-keyboard source (tests, buttons). */
  addNotch(dir: 1 | -1): void {
    this.notches += dir;
  }

  /** Orbit zoom since the last call, in log units (positive zooms out). */
  consumeZoom(): number {
    const z = this.zoom;
    this.zoom = 0;
    return z;
  }

  /** Pinch or other zoom source. */
  addZoom(v: number): void {
    this.zoom += v;
  }

  private heldFor(code: string): number {
    const t = this.heldSince.get(code);
    return t === undefined ? 0 : (performance.now() - t) / 1000;
  }

  private wheel = 0;

  on(action: Action, fn: () => void): void {
    const list = this.listeners.get(action) ?? [];
    list.push(fn);
    this.listeners.set(action, list);
  }

  emit(action: Action): void {
    for (const fn of this.listeners.get(action) ?? []) fn();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  poll(realDt: number): FlightInput {
    const inp = emptyInput();
    const dz = 0.04;
    const shape = (v: number): number => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      const t = (a - dz) / (1 - dz);
      return Math.sign(v) * t * t * 0.4 + Math.sign(v) * t * 0.6;
    };
    inp.pitch = -shape(this.stick.y);
    inp.yaw = shape(this.stick.x);
    const k = Math.exp(-realDt / this.recenterTime);
    this.stick.x *= k;
    this.stick.y *= k;

    if (this.down('KeyA')) inp.roll -= 1;
    if (this.down('KeyD')) inp.roll += 1;
    if (this.down('KeyQ')) inp.yaw -= 1;
    if (this.down('KeyE')) inp.yaw += 1;
    if (this.down('ArrowUp')) inp.pitch -= 1;
    if (this.down('ArrowDown')) inp.pitch += 1;
    if (this.down('ArrowLeft')) inp.yaw -= 1;
    if (this.down('ArrowRight')) inp.yaw += 1;
    const ext = this.external;
    if (ext.active) {
      inp.pitch += ext.pitch;
      inp.yaw += ext.yaw;
      inp.roll = clamp(inp.roll + ext.roll, -1, 1);
    }
    const pad = ext.pad;
    inp.pitch += pad.pitch;
    inp.yaw += pad.yaw;
    inp.roll = clamp(inp.roll + pad.roll, -1, 1);
    inp.yaw = clamp(inp.yaw, -1, 1);
    inp.pitch = clamp(inp.pitch, -1, 1);

    // Lever: a tap steps one notch (applied at keydown), a hold past NOTCH_HOLD sweeps.
    if (this.down('KeyW') && this.heldFor('KeyW') > NOTCH_HOLD) inp.throttleDelta += 1;
    if (this.down('KeyS') && this.heldFor('KeyS') > NOTCH_HOLD) inp.throttleDelta -= 1;
    inp.throttleDelta += pad.throttleDelta;
    this.wheelUsed = this.wheel;
    this.wheel = 0;
    let set = this.throttleSet ?? ext.throttleSet;
    if (this.notches !== 0) {
      let cur = set ?? this.throttleNow();
      const dir = this.notches > 0 ? 1 : -1;
      for (let i = Math.abs(this.notches); i > 0; i--) cur = stepNotch(cur, dir);
      set = cur;
      this.notches = 0;
    }
    inp.throttleSet = set;
    this.throttleSet = null;
    ext.throttleSet = null;
    inp.boost = this.down('ShiftLeft') || this.down('ShiftRight') || ext.boost || pad.boost;
    inp.brake = this.down('KeyX') || pad.brake;
    return inp;
  }

  consumeLook(): { x: number; y: number } {
    const l = { x: this.look.x, y: this.look.y };
    this.look.x = 0;
    this.look.y = 0;
    return l;
  }

  /** True while the align key is held. */
  get aligning(): boolean {
    return this.down('KeyF') || this.external.align || this.external.pad.align;
  }
}

const KEY_ACTIONS: Record<string, Action> = {
  Period: 'warpUp',
  Comma: 'warpDown',
  KeyC: 'camera',
  KeyM: 'map',
  KeyG: 'galaxy',
  KeyJ: 'journal',
  KeyT: 'target',
  KeyH: 'help',
  KeyU: 'hud',
  KeyP: 'photo',
  KeyV: 'look',
  KeyK: 'snapshot',
  KeyI: 'info',
  F3: 'debug',
  KeyX: 'stop',
};

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
