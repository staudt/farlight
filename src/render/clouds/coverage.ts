import type { CloudDef } from '../../data/types';
import { CLOUD_NOISE_SIZE, cloudNoiseData } from './noiseTexture';

/**
 * CPU mirror of the cloud shader's coverage field, so gameplay effects (rain, snow,
 * lightning, scenario placement) happen under the clouds you can actually see.
 * Keep in sync with `clouds.glsl.ts` (weather map terms and drift).
 */

/**
 * Drift offset in meters (body fixed X and Z). Each axis wraps at the weather map period,
 * which is a whole multiple of every noise period, so wrapping is seamless.
 */
export function cloudDrift(c: CloudDef, radius: number, simTime: number): { x: number; z: number } {
  const period = c.scale * radius * 28;
  return { x: (simTime * c.speed) % period, z: (simTime * c.speed * 0.35) % period };
}

/** Coverage 0..1 at a body fixed unit direction (sampled on the cloud base sphere). */
export function cloudCoverage(c: CloudDef, radius: number, atmosphereHeight: number, dir: { x: number; y: number; z: number }, simTime: number, coverageBias = 0): number {
  const scale = c.scale * radius;
  const r = radius + c.altitude * atmosphereHeight;
  const drift = cloudDrift(c, radius, simTime);
  const px = dir.x * r, py = dir.y * r, pz = dir.z * r;
  const w1 = sampleR((px + drift.x) / (scale * 28), py / (scale * 28), (pz + drift.z) / (scale * 28));
  const w2 = sampleR(px / (scale * 9) + 0.37, py / (scale * 9) + 0.37, pz / (scale * 9) + 0.37);
  return Math.min(1, Math.max(0, c.coverage + coverageBias + (w1 - 0.5) * 1.3 + (w2 - 0.5) * 0.4));
}

/** Trilinear, repeat wrapped sample of the R channel, matching WebGL LinearFilter. */
function sampleR(u: number, v: number, w: number): number {
  const data = cloudNoiseData();
  const n = CLOUD_NOISE_SIZE;
  const x = u * n - 0.5, y = v * n - 0.5, z = w * n - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  let acc = 0;
  for (let k = 0; k < 2; k++)
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const xi = (((x0 + i) % n) + n) % n;
        const yi = (((y0 + j) % n) + n) % n;
        const zi = (((z0 + k) % n) + n) % n;
        const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * (k ? fz : 1 - fz);
        acc += wgt * data[(xi + yi * n + zi * n * n) * 2]!;
      }
  return acc / 255;
}
