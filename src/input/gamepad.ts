import { config } from '../core/config';
import type { Action, Input } from './input';
import { settings } from '../ui/settingsStore';
import { shapeAxis } from './touchMath';

/** The subset of the Gamepad API the mapping reads, so tests can pass plain objects. */
export interface PadLike {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

/** Standard mapping button indices. */
export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export interface PadFrame {
  pitch: number;
  yaw: number;
  roll: number;
  /** Right stick, shaped, -1..1 (screen y down is positive). */
  lookX: number;
  lookY: number;
  /** Left stick, shaped, -1..1 (screen y down is positive), for photo mode. */
  moveX: number;
  moveY: number;
  throttleDelta: number;
  boost: boolean;
  brake: boolean;
  align: boolean;
  lt: number;
  rt: number;
}

function axis(pad: PadLike, i: number): number {
  const v = pad.axes[i];
  return v !== undefined && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function btn(pad: PadLike, i: number): number {
  const b = pad.buttons[i];
  return b ? (b.value > 0 ? b.value : b.pressed ? 1 : 0) : 0;
}

/** Small deadzone so a resting trigger never nudges the lever. */
function trigger(v: number): number {
  return v < 0.06 ? 0 : v;
}

/** Radial deadzone plus expo on a stick pair. */
export function shapeStick(x: number, y: number, deadzone: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len < deadzone || len === 0) return { x: 0, y: 0 };
  const k = shapeAxis(Math.min(1, len), deadzone) / len;
  return { x: x * k, y: y * k };
}

/**
 * Continuous controls from one pad. Pure. Left stick up is nose down (flight stick), and
 * `invert` flips it. Triggers set the throttle change rate: RT up, LT down.
 */
export function mapPad(pad: PadLike, invert: boolean, deadzone = 0.16): PadFrame {
  const l = shapeStick(axis(pad, 0), axis(pad, 1), deadzone);
  const r = shapeStick(axis(pad, 2), axis(pad, 3), deadzone);
  const lt = btn(pad, BTN.LT);
  const rt = btn(pad, BTN.RT);
  const rollRight = btn(pad, BTN.RB) > 0.5 ? 1 : 0;
  const rollLeft = btn(pad, BTN.LB) > 0.5 ? 1 : 0;
  return {
    pitch: invert ? -l.y : l.y,
    yaw: l.x,
    roll: rollRight - rollLeft,
    lookX: r.x,
    lookY: r.y,
    moveX: l.x,
    moveY: l.y,
    throttleDelta: trigger(rt) - trigger(lt),
    boost: btn(pad, BTN.A) > 0.5,
    brake: btn(pad, BTN.B) > 0.5,
    align: btn(pad, BTN.X) > 0.5,
    lt,
    rt,
  };
}

export type PadMode = 'flight' | 'overlay' | 'photo';

/** One-shot actions per button. Overlay and photo modes narrow this. */
export function actionFor(button: number, mode: PadMode): Action | null {
  if (mode === 'photo') {
    if (button === BTN.A) return 'capture';
    if (button === BTN.B || button === BTN.R3) return 'photo';
    return null;
  }
  if (mode === 'overlay') {
    if (button === BTN.B) return 'back';
    if (button === BTN.START) return 'galaxy';
    if (button === BTN.BACK) return 'map';
    return null;
  }
  switch (button) {
    case BTN.Y:
      return 'target';
    case BTN.LEFT:
      return 'warpDown';
    case BTN.RIGHT:
      return 'warpUp';
    case BTN.UP:
      return 'camera';
    case BTN.DOWN:
      return 'hud';
    case BTN.START:
      return 'galaxy';
    case BTN.BACK:
      return 'map';
    case BTN.R3:
      return 'photo';
    case BTN.L3:
      return 'look';
    default:
      return null;
  }
}

/** Buttons that went from released to pressed. */
export function risingEdges(prev: readonly boolean[], pad: PadLike): number[] {
  const out: number[] = [];
  pad.buttons.forEach((b, i) => {
    if (b.pressed && !prev[i]) out.push(i);
  });
  return out;
}

export interface PadContext {
  mode(): PadMode;
  notify(big: string, small: string): void;
}

const ARROWS: Partial<Record<number, string>> = {
  [BTN.UP]: 'ArrowUp',
  [BTN.DOWN]: 'ArrowDown',
  [BTN.LEFT]: 'ArrowLeft',
  [BTN.RIGHT]: 'ArrowRight',
};

/**
 * Polls the first connected standard gamepad each frame and feeds `Input.external.pad`
 * plus `Input.emit` actions, so the sim stays agnostic.
 */
export class GamepadControls {
  /** Latest mapped frame, null with no pad. Photo mode reads it. */
  frame: PadFrame | null = null;
  connected = false;
  private prev: boolean[] = [];
  private index = -1;
  private backHeld = 0;
  private backFired = false;
  private startHeld = 0;
  private startFired = false;

  constructor(
    private readonly input: Input,
    private readonly ctx: PadContext,
  ) {
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.index) this.drop();
    });
  }

  setInvert(on: boolean): void {
    settings.set('invertPad', on); // persisted; applied to config by the settings listener
  }

  private onConnect(pad: Gamepad): void {
    this.index = pad.index;
    this.connected = true;
    this.prev = pad.buttons.map((b) => b.pressed); // a held button on connect is not an edge
    this.ctx.notify('CONTROLLER CONNECTED', pad.id.replace(/\(.*$/, '').trim().slice(0, 28));
  }

  private drop(): void {
    this.connected = false;
    this.index = -1;
    this.frame = null;
    this.clear();
  }

  private clear(): void {
    const p = this.input.external.pad;
    p.pitch = p.yaw = p.roll = p.throttleDelta = 0;
    p.boost = p.brake = p.align = p.look = false;
  }

  private find(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    const cur = pads[this.index];
    if (cur?.connected) return cur;
    for (const p of pads) if (p?.connected) return p;
    return null;
  }

  update(realDt: number): void {
    const pad = this.find();
    if (!pad) {
      if (this.connected) this.drop();
      return;
    }
    if (!this.connected || pad.index !== this.index) this.onConnect(pad);
    const mode = this.ctx.mode();
    const f = mapPad(pad, config.gamepad.invertPitch, config.gamepad.deadzone);
    this.frame = f;
    const out = this.input.external.pad;
    if (mode === 'flight') {
      out.pitch = f.pitch;
      out.yaw = f.yaw;
      out.roll = f.roll;
      out.throttleDelta = f.throttleDelta;
      out.boost = f.boost;
      out.brake = f.brake;
      out.align = f.align;
      out.look = f.lookX !== 0 || f.lookY !== 0;
      if (out.look) {
        const k = config.gamepad.lookSpeed * realDt;
        this.input.look.x += f.lookX * k;
        this.input.look.y += f.lookY * k;
      }
    } else {
      this.clear();
    }

    // View/Back: a tap opens the map on release, a 0.6 s hold saves a snapshot.
    const back = pad.buttons[BTN.BACK]?.pressed ?? false;
    if (mode === 'flight') {
      if (back) {
        this.backHeld += realDt;
        if (!this.backFired && this.backHeld >= config.gamepad.snapshotHold) {
          this.backFired = true;
          this.input.emit('snapshot');
        }
      } else if (this.prev[BTN.BACK]) {
        if (!this.backFired) this.input.emit('map');
      }
    }
    if (!back) {
      this.backHeld = 0;
      this.backFired = false;
    }

    // Start: a tap opens the galaxy map on release, a 0.6 s hold opens settings.
    const start = pad.buttons[BTN.START]?.pressed ?? false;
    if (mode === 'flight') {
      if (start) {
        this.startHeld += realDt;
        if (!this.startFired && this.startHeld >= config.gamepad.snapshotHold) {
          this.startFired = true;
          this.input.emit('settings');
        }
      } else if (this.prev[BTN.START] && !this.startFired) {
        this.input.emit('galaxy');
      }
    }
    if (!start) {
      this.startHeld = 0;
      this.startFired = false;
    }

    for (const b of risingEdges(this.prev, pad)) {
      if ((b === BTN.BACK || b === BTN.START) && mode === 'flight') continue;
      const action = actionFor(b, mode);
      if (action) this.input.emit(action);
      else if (mode === 'overlay' && ARROWS[b]) {
        const key = ARROWS[b]!;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: key, key }));
      }
    }
    this.prev = pad.buttons.map((b) => b.pressed);
  }
}
