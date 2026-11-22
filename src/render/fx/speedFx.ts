import { config } from '../../core/config';

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * Warp travel look, 0..1. Scales with the log of the effective speed (speed x warp) and needs a real
 * time warp, so slow flight and landed time warp stay clean. Zero when nothing moves.
 */
export function warpIntensity(speed: number, warp: number): number {
  const c = config.speedFx;
  if (!c.enabled || speed < 1 || warp < c.warpMin) return 0;
  const eff = Math.log10(speed * warp);
  return smooth(c.warpLogMin, c.warpLogFull, eff) * smooth(c.warpMin, c.warpMin * 3, warp);
}

/**
 * Condensation cone trigger: a brief pulse when a boosting ship in dense air crosses a fraction of the
 * speed cap. Call every frame with real dt. It re arms once the ship drops under the threshold or
 * stops boosting, so it fires on the crossing and not continuously.
 */
export class VaporPulse {
  value = 0;
  private armed = true;
  /** Seconds since the last pulse fired. */
  age = 99;

  update(dt: number, boosting: boolean, density: number, speed: number, cap: number): number {
    const c = config.speedFx;
    const hot = boosting && density > c.vaporDensity && speed > cap * c.vaporCapFraction && speed > 150;
    if (hot && this.armed) {
      this.armed = false;
      this.age = 0;
    } else if (!hot) {
      this.armed = true;
    }
    this.age += dt;
    // Quick attack, slow fade, about two seconds in all.
    this.value = this.age > 2.4 ? 0 : smooth(0, 0.18, this.age) * (1 - smooth(0.5, 2.4, this.age));
    return this.value;
  }
}
