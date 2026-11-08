import { Vector3 } from 'three';

/** Orbit elements in game units. Angles in radians, period in seconds (negative = retrograde). */
export interface ScaledOrbit {
  a: number;
  e: number;
  i: number;
  node: number;
  argPeri: number;
  m0: number;
  period: number;
}

const TWO_PI = Math.PI * 2;

export function solveKepler(meanAnomaly: number, e: number): number {
  let M = meanAnomaly % TWO_PI;
  if (M < 0) M += TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 12; k++) {
    const f = E - e * Math.sin(E) - M;
    const d = 1 - e * Math.cos(E);
    const step = f / d;
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

/**
 * Converts an ecliptic vector (x, y in the plane, z north) to Three.js world coordinates
 * (Y up). The ecliptic plane is the world XZ plane and counterclockwise seen from +Y is prograde.
 */
function eclipticToWorld(x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, z, -y);
}

/** Position and velocity relative to the parent at sim time t (seconds). */
export function orbitState(o: ScaledOrbit, t: number, outPos: Vector3, outVel?: Vector3): void {
  const n = TWO_PI / o.period;
  const E = solveKepler(o.m0 + n * t, o.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const b = o.a * Math.sqrt(1 - o.e * o.e);
  const xp = o.a * (cosE - o.e);
  const yp = b * sinE;

  const cO = Math.cos(o.node), sO = Math.sin(o.node);
  const cw = Math.cos(o.argPeri), sw = Math.sin(o.argPeri);
  const ci = Math.cos(o.i), si = Math.sin(o.i);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;

  eclipticToWorld(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp, outPos);

  if (outVel) {
    const Edot = n / (1 - o.e * cosE);
    const vxp = -o.a * sinE * Edot;
    const vyp = b * cosE * Edot;
    eclipticToWorld(r11 * vxp + r12 * vyp, r21 * vxp + r22 * vyp, r31 * vxp + r32 * vyp, outVel);
  }
}
