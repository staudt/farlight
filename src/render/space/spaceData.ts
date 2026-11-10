import { Vector3 } from 'three';
import { hashInts, mulberry32 } from '../../core/rng';
import type { BeltDef, CometDef, RGB, StarSystemDef } from '../../data/types';
import type { ScaleProfile } from '../../data/scale';
import { orbitState, type ScaledOrbit } from '../../sim/ephemeris';

/** Pure scenery math shared by the renderer, the map and the tests. No Three objects are created here. */

const AU = 1.495978707e11;
const YEAR = 365.256 * 86400;

export interface ScaledBelt {
  def: BeltDef;
  /** Game meters from the root star. */
  inner: number;
  outer: number;
  mid: number;
  /** Half thickness, game meters. */
  halfThickness: number;
}

export function scaleBelts(system: StarSystemDef, scale: ScaleProfile): ScaledBelt[] {
  return (system.belts ?? []).map((def) => {
    const inner = def.innerAU * AU * scale.planetOrbitScale;
    const outer = def.outerAU * AU * scale.planetOrbitScale;
    const mid = (inner + outer) / 2;
    return { def, inner, outer, mid, halfThickness: def.thickness * mid };
  });
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0..1 relative density at cylindrical radius r and height y (game meters, star at the origin). */
export function beltDensity(b: ScaledBelt, r: number, y: number): number {
  const w = (b.outer - b.inner) * 0.22;
  const radial = smooth(b.inner, b.inner + w, r) * (1 - smooth(b.outer - w, b.outer, r));
  if (radial <= 0) return 0;
  const k = y / b.halfThickness;
  return radial * Math.exp(-k * k);
}

/**
 * The belt the point (star centred game meters) is inside, with hysteresis so the edge does not flicker:
 * entering needs density above `enter`, a belt already `current` is kept until it falls below `leave`.
 */
export function beltAt(belts: readonly ScaledBelt[], x: number, y: number, z: number, current: ScaledBelt | null = null, enter = 0.3, leave = 0.12): ScaledBelt | null {
  const r = Math.hypot(x, z);
  if (current && beltDensity(current, r, y) >= leave) return current;
  for (const b of belts) if (beltDensity(b, r, y) >= enter) return b;
  return null;
}

/** Keplerian angular speed in rad per sim second for a circular orbit at game radius r. */
export function beltOmega(r: number, scale: ScaleProfile): number {
  const au = r / (AU * scale.planetOrbitScale);
  return (Math.PI * 2) / (YEAR * Math.pow(Math.max(0.05, au), 1.5));
}

/** Near rock grid levels. Cells are in game meters; `range` is the number of cells reached each way. */
export interface RockLevel {
  cell: number;
  range: number;
  /** Chance of a rock per cell at full belt density. */
  chance: number;
  /** Size range as multiples of the belt's sizeMax (level 0 uses sizeMin..sizeMax directly). */
  min: number;
  max: number;
}

export const ROCK_LEVELS: readonly RockLevel[] = [
  { cell: 1400, range: 4, chance: 0.7, min: 0, max: 1 },
  { cell: 18000, range: 3, chance: 0.14, min: 1.5, max: 6 },
  { cell: 300000, range: 2, chance: 0.06, min: 12, max: 40 },
];

export interface Rock {
  /** World position (game meters, float64 numbers). */
  x: number;
  y: number;
  z: number;
  size: number;
  /** Non uniform stretch. */
  sx: number;
  sy: number;
  sz: number;
  /** Tumble axis (unit) and rate, rad per real second. */
  ax: number;
  ay: number;
  az: number;
  spin: number;
  phase: number;
  tone: number;
}

/** The rock (if any) of one cell. Deterministic in (belt seed, level, cell). Returns false when the cell is empty. */
export function rockInCell(b: ScaledBelt, level: number, ix: number, iy: number, iz: number, density: number, out: Rock): boolean {
  const L = ROCK_LEVELS[level]!;
  const rnd = mulberry32(hashInts(b.def.seed, level, ix, iy, iz));
  const x = (ix + rnd()) * L.cell;
  const y = (iy + rnd()) * L.cell;
  const z = (iz + rnd()) * L.cell;
  const d = beltDensity(b, Math.hypot(x, z), y);
  if (rnd() > L.chance * d * density) return false;
  const lo = level === 0 ? b.def.sizeMin : b.def.sizeMax * L.min;
  const hi = level === 0 ? b.def.sizeMax : b.def.sizeMax * L.max;
  // Many small, few large.
  out.size = lo + (hi - lo) * Math.pow(rnd(), 2.2);
  out.x = x;
  out.y = y;
  out.z = z;
  out.sx = 0.7 + rnd() * 0.6;
  out.sy = 0.6 + rnd() * 0.6;
  out.sz = 0.7 + rnd() * 0.6;
  const ax = rnd() * 2 - 1;
  const ay = rnd() * 2 - 1;
  const az = rnd() * 2 - 1;
  const l = Math.hypot(ax, ay, az) || 1;
  out.ax = ax / l;
  out.ay = ay / l;
  out.az = az / l;
  out.spin = (rnd() * 2 - 1) * 0.35;
  out.phase = rnd() * Math.PI * 2;
  out.tone = 0.65 + rnd() * 0.7;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Comets

export interface ScaledComet {
  def: CometDef;
  orbit: ScaledOrbit;
  /** Tail length at full activity, game meters. */
  tailLength: number;
  /** Activity radius, game meters. */
  activityRadius: number;
}

export function scaleComets(system: StarSystemDef, scale: ScaleProfile): ScaledComet[] {
  return (system.comets ?? []).map((def) => {
    const o = def.orbit;
    return {
      def,
      orbit: {
        a: o.semiMajorAxis * scale.planetOrbitScale,
        e: o.eccentricity,
        i: o.inclination,
        node: o.ascendingNode,
        argPeri: o.argPeriapsis,
        m0: o.meanAnomalyAtEpoch,
        period: o.period,
      },
      tailLength: def.tailAU * AU * scale.planetOrbitScale,
      activityRadius: def.activityAU * AU * scale.planetOrbitScale,
    };
  });
}

/** Comet position and velocity around the origin star (game meters) at sim time t. */
export function cometState(c: ScaledComet, t: number, pos: Vector3, vel: Vector3): void {
  orbitState(c.orbit, t, pos, vel);
}

/** 0..1: how developed the coma and tails are at distance r from the star. Grows as the comet falls inward. */
export function cometActivity(c: ScaledComet, r: number): number {
  const x = Math.min(1, Math.max(0, 1 - r / c.activityRadius));
  return Math.pow(x, 0.8);
}

export interface TailGeometry {
  /** Unit vector from the star through the comet: the straight ion tail points this way. */
  ion: Vector3;
  /** Unit vector the dust tail leaves along: mostly away from the star but bent against the motion. */
  dust: Vector3;
  /** Unit vector the dust tail curves toward (against the velocity, perpendicular to dust). */
  bend: Vector3;
}

const _v = new Vector3();

/** Tail directions. The ion tail points exactly away from the star; the dust tail lags behind the motion. */
export function cometTails(pos: Vector3, vel: Vector3, starPos: Vector3, out: TailGeometry = { ion: new Vector3(), dust: new Vector3(), bend: new Vector3() }): TailGeometry {
  out.ion.copy(pos).sub(starPos).normalize();
  // Component of the velocity perpendicular to the sun line, reversed: the dust trails the path.
  _v.copy(vel).addScaledVector(out.ion, -vel.dot(out.ion));
  if (_v.lengthSq() < 1e-12) _v.set(0, 0, 0);
  else _v.normalize().negate();
  out.bend.copy(_v);
  out.dust.copy(out.ion).addScaledVector(_v, 0.28).normalize();
  return out;
}

export function rgbArray(c: RGB): [number, number, number] {
  return [c[0], c[1], c[2]];
}

/** Unit direction of the system's hero nebula, from the sky seed. The bake shader and the scenarios agree on it. */
export function skyFocusDir(sky: { seed: number }, out: Vector3 = new Vector3()): Vector3 {
  const rnd = mulberry32((sky.seed ^ 0x9e3779b9) >>> 0);
  const u = rnd() * 1.4 - 0.7;
  const t = rnd() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(t), u, s * Math.sin(t));
}
