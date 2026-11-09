/** Pure math for touch controls. No DOM, so it is unit tested. */

export interface Axes {
  pitch: number;
  yaw: number;
  roll: number;
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Deadzone plus a mild expo curve, same shape as Input.poll. v in -1..1. */
export function shapeAxis(v: number, deadzone: number): number {
  const a = Math.abs(v);
  if (a < deadzone) return 0;
  const t = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(v) * (t * t * 0.4 + t * 0.6);
}

/**
 * Floating stick: pixel offset from the touch origin to flight axes.
 * Screen down is positive dy. Default: push up = nose up (pitch = -y); invert flips it.
 * Roll follows x by `rollFactor` (use 0 in atmosphere, where the assist banks the turn).
 */
export function stickToAxes(
  dx: number,
  dy: number,
  radius: number,
  deadzone: number,
  invert: boolean,
  rollFactor: number,
): Axes {
  const len = Math.hypot(dx, dy);
  const k = len > radius && len > 0 ? radius / len : 1;
  const x = (dx * k) / radius;
  const y = (dy * k) / radius;
  const sx = shapeAxis(x, deadzone);
  const sy = shapeAxis(y, deadzone);
  return { pitch: invert ? sy : -sy, yaw: sx, roll: sx * rollFactor };
}

/** Knob position in px, clamped to the stick radius. */
export function clampKnob(dx: number, dy: number, radius: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  return { x: (dx / len) * radius, y: (dy / len) * radius };
}

/** Throttle 0..1 from a pointer y on a vertical slider (top = 1). */
export function sliderValue(y: number, top: number, height: number): number {
  if (height <= 0) return 0;
  return clamp(1 - (y - top) / height, 0, 1);
}

export interface Tilt {
  /** Radians, positive = top edge toward the sky (pulling back). */
  pitch: number;
  /** Radians, positive = right side of the screen down. */
  roll: number;
}

/**
 * Device orientation (degrees, W3C beta/gamma) to tilt relative to the screen as the user
 * sees it, for any screen rotation angle (0, 90, 180, 270). Built from the gravity vector in
 * device coordinates so it stays stable when the phone is held upright in landscape.
 */
export function tiltFromOrientation(beta: number, gamma: number, screenAngle: number): Tilt {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  // Direction of "up" in device coordinates.
  const ux = -Math.sin(g) * Math.cos(b);
  const uy = Math.sin(b);
  const uz = Math.cos(b) * Math.cos(g);
  const a = ((Math.round(screenAngle / 90) % 4) + 4) % 4;
  // Screen right and screen top axes in device coordinates.
  const right: [number, number] = [[1, 0], [0, -1], [-1, 0], [0, 1]][a] as [number, number];
  const top: [number, number] = [[0, 1], [1, 0], [0, -1], [-1, 0]][a] as [number, number];
  const sx = ux * right[0] + uy * right[1];
  const sy = ux * top[0] + uy * top[1];
  return { pitch: Math.atan2(sy, uz), roll: Math.asin(clamp(-sx, -1, 1)) };
}

/** Tilt relative to a calibrated neutral to flight axes. rangeDeg is full deflection. */
export function tiltToAxes(
  tilt: Tilt,
  neutral: Tilt,
  rangeDeg: number,
  deadzone: number,
  invert: boolean,
): Axes {
  const range = (rangeDeg * Math.PI) / 180;
  const x = clamp((tilt.roll - neutral.roll) / range, -1, 1);
  const y = clamp((tilt.pitch - neutral.pitch) / range, -1, 1);
  const sy = shapeAxis(y, deadzone);
  return { pitch: invert ? -sy : sy, yaw: shapeAxis(x, deadzone), roll: 0 };
}
