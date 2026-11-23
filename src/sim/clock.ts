import { config } from '../core/config';

/** Sim time in seconds with discrete time warp levels (rails ephemeris makes any warp exact). */
export class SimClock {
  time: number;
  /** The warp level the player chose. It survives situation limits (see `limitTo`). */
  warpIndex = 0;
  /** Highest level the situation allows this step; the player's level comes back once it lifts. */
  capIndex = Infinity;
  paused = false;

  constructor(startTime = 0) {
    this.time = startTime;
  }

  get levels(): readonly number[] {
    return config.warp.levels;
  }

  get warp(): number {
    return this.paused ? 0 : (this.levels[this.index] ?? 1);
  }

  /** Effective level index: the player's choice under the current cap. */
  get index(): number {
    return Math.min(this.warpIndex, this.capIndex);
  }

  /** True while a situation limit holds the warp below the player's choice. */
  get limited(): boolean {
    return this.warpIndex > this.capIndex;
  }

  /** Index of the largest level not above `value`. */
  indexFor(value: number): number {
    let idx = 0;
    this.levels.forEach((l, i) => {
      if (l <= value) idx = i;
    });
    return idx;
  }

  /** Steps from the level in effect (a capped choice is re-based on what the player sees). */
  step(delta: number): void {
    this.warpIndex = Math.max(0, Math.min(this.levels.length - 1, this.index + delta));
  }

  /**
   * Caps the effective warp at `maxWarp` for now without forgetting the player's level.
   * Returns true when the cap holds the warp below the choice.
   */
  limitTo(maxWarp: number): boolean {
    this.capIndex = this.indexFor(maxWarp);
    return this.limited;
  }

  /** Back to 1x (entering a sphere of influence after a fast trip). */
  resetWarp(): void {
    this.warpIndex = 0;
  }

  /** Advances by real seconds and returns the sim seconds elapsed. */
  advance(realDt: number): number {
    const dt = realDt * this.warp;
    this.time += dt;
    return dt;
  }
}
