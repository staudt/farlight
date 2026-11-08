import { Vector3 } from 'three';
import { config } from '../core/config';
import type { Universe } from './universe';

export type FlightPhase = 'landed' | 'atmosphere' | 'near' | 'space';

/** Max warp allowed by the ship's situation. */
export function phaseMaxWarp(phase: FlightPhase): number {
  switch (phase) {
    case 'landed':
      return config.warp.landedMax;
    case 'atmosphere':
      return config.warp.atmosphereMax;
    default:
      return Infinity;
  }
}

/** Ray vs sphere: smallest positive t where |o + d t - c| = r, or Infinity. */
export function raySphere(o: Vector3, d: Vector3, c: Vector3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a === 0) return Infinity;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc < 0) return Infinity; // already inside: no entry boundary ahead
  const disc = b * b - a * cc;
  if (disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t > 0 ? t : Infinity;
}

const _relVel = new Vector3();

/**
 * Sim seconds until the ship (world position and velocity) crosses into any body's
 * near zone (atmosphere top or terrain clearance). Bodies are treated as moving
 * linearly over the prediction horizon, which is plenty for an auto drop.
 */
export function timeToNextBoundary(universe: Universe, wp: Vector3, wv: Vector3): number {
  let best = Infinity;
  for (const b of universe.bodies) {
    _relVel.copy(wv).sub(b.velocity);
    const t = raySphere(wp, _relVel, b.position, b.nearZoneRadius);
    if (t < best) best = t;
  }
  return best;
}

/**
 * The largest warp such that the next boundary stays at least `minRealEta` real seconds
 * away, combined with the phase limit.
 */
export function allowedWarp(phase: FlightPhase, simTimeToBoundary: number): number {
  const byEta = simTimeToBoundary / config.warp.minRealEta;
  return Math.max(1, Math.min(phaseMaxWarp(phase), byEta));
}
