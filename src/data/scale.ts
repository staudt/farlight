import type { BodyDef } from './types';

/**
 * Converts real world values into game proportions. Feel over accuracy: every number here
 * is an artistic knob, and per body `visual` overrides always win.
 */
export interface ScaleProfile {
  /** Real radius -> game radius for planets and moons. */
  radiusScale: number;
  /** Real radius -> game radius for stars. */
  starRadiusScale: number;
  /** Real semi major axis -> game distance for bodies orbiting a star. */
  planetOrbitScale: number;
  /**
   * Moon orbit compression in parent radii: ratios up to `moonLinearUntil` are kept,
   * beyond that the excess is raised to `moonExponent` so far moons pull in close.
   */
  moonLinearUntil: number;
  moonExponent: number;
  /** Default angular diameter floor in radians. */
  minApparentSize: number;
  /** Default sphere of influence in radii, per kind. */
  soiFactorPlanet: number;
  soiFactorMoon: number;
}

export const DEFAULT_SCALE: ScaleProfile = {
  radiusScale: 0.1,
  starRadiusScale: 0.005,
  planetOrbitScale: 0.001,
  moonLinearUntil: 4,
  moonExponent: 0.7,
  minApparentSize: 0.012, // ~0.7 degrees
  soiFactorPlanet: 30,
  soiFactorMoon: 10,
};

export function scaledRadius(def: BodyDef, s: ScaleProfile): number {
  if (def.visual.radius !== undefined) return def.visual.radius;
  return def.physical.radius * (def.kind === 'star' ? s.starRadiusScale : s.radiusScale);
}

export function compressMoonRatio(ratio: number, s: ScaleProfile): number {
  if (ratio <= s.moonLinearUntil) return ratio;
  return s.moonLinearUntil + Math.pow(ratio - s.moonLinearUntil, s.moonExponent);
}

/**
 * Game semi major axis. Planets (parent is a star) use a linear scale; moons are placed in
 * parent radii with a compression curve so they loom large in the parent's sky.
 */
export function scaledOrbitDistance(def: BodyDef, parent: BodyDef | undefined, s: ScaleProfile): number {
  if (def.visual.orbitDistance !== undefined) return def.visual.orbitDistance;
  if (!def.orbit || !parent) return 0;
  if (parent.kind === 'star') return def.orbit.semiMajorAxis * s.planetOrbitScale;
  const ratio = def.orbit.semiMajorAxis / parent.physical.radius;
  return compressMoonRatio(ratio, s) * scaledRadius(parent, s);
}

export function soiFactor(def: BodyDef, parent: BodyDef | undefined, s: ScaleProfile): number {
  if (def.visual.soiFactor !== undefined) return def.visual.soiFactor;
  if (def.kind === 'star') return Infinity;
  return parent && parent.kind !== 'star' ? s.soiFactorMoon : s.soiFactorPlanet;
}
