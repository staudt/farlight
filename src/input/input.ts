import { emptyInput, type FlightInput } from '../sim/ship';

export type Action =
  | 'warpUp'
  | 'warpDown'
  | 'camera'
  | 'map'
  | 'target'
  | 'hud'
  | 'debug'
  | 'stop';

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
  /** Raw mouse delta this frame while right mouse is held (free look). */
  readonly look = { x: 0, y: 0 };
  private keys = new Set<string>();
  private listeners = new Map<Action, (() => void)[]>();
  private throttleSet: number | null = null;
  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock?.();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      if (this.rightMouse) {
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
      this.wheel += Math.sign(e.deltaY) * -0.08;
    });
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
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
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
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
    inp.yaw = clamp(inp.yaw, -1, 1);
    inp.pitch = clamp(inp.pitch, -1, 1);

    if (this.down('KeyW')) inp.throttleDelta += 1;
    if (this.down('KeyS')) inp.throttleDelta -= 1;
    if (this.wheel !== 0) {
      inp.throttleDelta += this.wheel / Math.max(realDt, 1e-3) / 0.6;
      this.wheel = 0;
    }
    inp.throttleSet = this.throttleSet;
    this.throttleSet = null;
    inp.boost = this.down('ShiftLeft') || this.down('ShiftRight');
    inp.brake = this.down('KeyX');
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
    return this.down('KeyF');
  }
}

const KEY_ACTIONS: Record<string, Action> = {
  Period: 'warpUp',
  Comma: 'warpDown',
  KeyC: 'camera',
  KeyM: 'map',
  KeyT: 'target',
  KeyH: 'hud',
  F3: 'debug',
  KeyX: 'stop',
};

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
