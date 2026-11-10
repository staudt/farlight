import { Vector3 } from 'three';
import { DEFAULT_SCALE } from '../data/scale';
import type { StarSystemDef } from '../data/types';
import { cometState, scaleComets, type ScaledComet } from '../render/space/spaceData';
import type { Targetable } from './landmarks';

/** A comet on its rails, lockable like a body: target marker, ETA and align work through `Targetable`. */
export class CometTarget implements Targetable {
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  constructor(readonly comet: ScaledComet) {}

  get name(): string {
    return this.comet.def.name;
  }

  /** The nucleus is tiny; a floor keeps the marker and the arrival distance sensible. */
  get radius(): number {
    return Math.max(100, this.comet.def.nucleusRadius);
  }

  update(time: number): void {
    cometState(this.comet, time, this.position, this.velocity);
  }
}

export function makeCometTargets(system: StarSystemDef): CometTarget[] {
  return scaleComets(system, DEFAULT_SCALE).map((c) => new CometTarget(c));
}
