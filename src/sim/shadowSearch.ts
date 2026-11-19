import { Vector3 } from 'three';
import type { Body, Universe } from './universe';
import { orbitState } from './ephemeris';

/**
 * Search helpers for eclipse scenarios: find a sim time when one body's shadow falls on another.
 * Uses on-rails positions of the few bodies involved (no full universe update per sample), so a
 * year long scan at one hour steps is cheap.
 */

export interface Transit {
  /** Sim time of the best alignment. */
  time: number;
  /** Distance of the target's centre from the shadow axis, in target radii. */
  impact: number;
  /** Where the shadow axis meets the target, world space (nearest point to the caster). */
  point: Vector3;
}

/** Sets the world position of `b` (and its parents) at sim time `t`, without touching the rest. */
function placeAt(b: Body, t: number): void {
  if (!b.orbit || !b.parent) {
    b.position.set(0, 0, 0);
    return;
  }
  placeAt(b.parent, t);
  orbitState(b.orbit, t, b.localPosition, b.localVelocity);
  b.position.copy(b.parent.position).add(b.localPosition);
}

const _ax = new Vector3();
const _d = new Vector3();

/** Score of an alignment at time t: |impact - want|, or Infinity when the target is not behind the caster. */
function score(u: Universe, target: Body, caster: Body, t: number, want: number): number {
  placeAt(caster, t);
  placeAt(target, t);
  _ax.copy(caster.position).sub(u.root.position).normalize();
  _d.copy(target.position).sub(caster.position);
  const along = _d.dot(_ax);
  if (along <= 0) return Infinity;
  const b = _d.addScaledVector(_ax, -along).length();
  return Math.abs(b / target.radius - want);
}

/**
 * Time in [from, to) when the shadow axis of `casterId` (sun through caster) passes `want` target
 * radii from the centre of `targetId`, with the target behind the caster. Coarse scan, then refine.
 * Leaves body positions at the result time.
 */
export function findTransit(u: Universe, targetId: string, casterId: string, from: number, to: number, step: number, want = 0): Transit {
  const target = u.get(targetId);
  const caster = u.get(casterId);
  let best = from;
  let bestScore = Infinity;
  for (let t = from; t < to; t += step) {
    const s = score(u, target, caster, t, want);
    if (s < bestScore) {
      bestScore = s;
      best = t;
    }
  }
  // Refine around the best sample.
  let lo = best - step;
  let hi = best + step;
  for (let pass = 0; pass < 3; pass++) {
    const fine = (hi - lo) / 40;
    for (let t = lo; t <= hi; t += fine) {
      const s = score(u, target, caster, t, want);
      if (s < bestScore) {
        bestScore = s;
        best = t;
      }
    }
    lo = best - fine;
    hi = best + fine;
  }
  placeAt(caster, best);
  placeAt(target, best);
  _ax.copy(caster.position).sub(u.root.position).normalize();
  _d.copy(target.position).sub(caster.position);
  const along = _d.dot(_ax);
  const off = _d.clone().addScaledVector(_ax, -along);
  const b = off.length();
  const R = target.radius;
  const point = new Vector3();
  if (b < R) {
    point.copy(caster.position).addScaledVector(_ax, along - Math.sqrt(R * R - b * b));
  } else {
    point.copy(target.position).addScaledVector(off.normalize(), -R);
  }
  return { time: best, impact: b / R, point };
}
