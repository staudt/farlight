import { config } from '../core/config';

/** Sim time in seconds with discrete time warp levels (rails ephemeris makes any warp exact). */
export class SimClock {
  time: number;
  warpIndex = 0;
  paused = false;

  constructor(startTime = 0) {
    this.time = startTime;
  }

  get levels(): readonly number[] {
    return config.warp.levels;
  }

  get warp(): number {
    return this.paused ? 0 : (this.levels[this.warpIndex] ?? 1);
  }

  /** Index of the largest level not above `value`. */
  indexFor(value: number): number {
    let idx = 0;
    this.levels.forEach((l, i) => {
      if (l <= value) idx = i;
    });
    return idx;
  }

  step(delta: number): void {
    this.warpIndex = Math.max(0, Math.min(this.levels.length - 1, this.warpIndex + delta));
  }

  /** Lowers the warp so it does not exceed `maxWarp`. */
  clampTo(maxWarp: number): boolean {
    const maxIdx = this.indexFor(maxWarp);
    if (this.warpIndex > maxIdx) {
      this.warpIndex = maxIdx;
      return true;
    }
    return false;
  }

  /** Advances by real seconds and returns the sim seconds elapsed. */
  advance(realDt: number): number {
    const dt = realDt * this.warp;
    this.time += dt;
    return dt;
  }
}
