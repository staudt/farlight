import type { CloudDef } from '../../data/types';
import { config } from '../../core/config';
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

/** Structure strength for a cloud layer: overcast worlds (Venus, Titan) keep plain noise, banded weather fades out between 0.6 and 0.93 coverage. */
export function cloudStructure(c: CloudDef): number {
  return config.clouds.structure * (1 - Math.min(1, Math.max(0, (c.coverage - 0.6) * 3)));
}

const DEG = Math.PI / 180;
/** Fixed cyclone seeds: latitude, longitude (degrees) and a relative size. Same list feeds the shader. */
const CYCLONE_SEEDS: readonly (readonly [number, number, number])[] = [
  [36, -48, 1],
  [-40, 95, 0.9],
  [18, 142, 1.1],
  [-27, -72, 0.8],
];
export const MAX_CYCLONES = CYCLONE_SEEDS.length;

/** Active cyclones as body fixed unit direction plus cos of the angular radius (4 floats each, `MAX_CYCLONES` entries, cos 2 = unused). */
export function cycloneData(out: Float32Array = new Float32Array(MAX_CYCLONES * 4)): Float32Array {
  for (let i = 0; i < MAX_CYCLONES; i++) {
    const [lat, lon, size] = CYCLONE_SEEDS[i]!;
    const on = i < config.clouds.cyclones;
    const cl = Math.cos(lat * DEG);
    out[i * 4] = cl * Math.cos(lon * DEG);
    out[i * 4 + 1] = Math.sin(lat * DEG);
    out[i * 4 + 2] = -cl * Math.sin(lon * DEG);
    out[i * 4 + 3] = on ? Math.cos(config.clouds.cycloneSize * size) : 2;
  }
  return out;
}

const _cyc = new Float32Array(MAX_CYCLONES * 4);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Coverage 0..1 at a body fixed position (any distance from the centre). Mirrors `cloudCover` in
 * clouds.glsl.ts: noise weather map, then latitude bands (ITCZ, dry subtropics, mid latitude storm
 * tracks), meandering fronts and spiral cyclones.
 */
export function weatherCover(c: CloudDef, radius: number, px: number, py: number, pz: number, simTime: number, coverageBias = 0): number {
  const scale = c.scale * radius;
  const drift = cloudDrift(c, radius, simTime);
  const w1 = sampleR((px + drift.x) / (scale * 28), py / (scale * 28), (pz + drift.z) / (scale * 28));
  const w2 = sampleR(px / (scale * 9) + 0.37, py / (scale * 9) + 0.37, pz / (scale * 9) + 0.37);
  const s = cloudStructure(c);
  let cov = c.coverage + coverageBias + (w1 - 0.5) * (1.3 - 0.75 * s) + (w2 - 0.5) * (0.4 - 0.1 * s);
  if (s > 0) {
    const len = Math.hypot(px, py, pz) || 1;
    const dx = px / len, dy = py / len, dz = pz / len;
    const lat = Math.asin(Math.min(1, Math.max(-1, dy)));
    const lon = Math.atan2(-dz, dx + 1e-6);
    const al = Math.abs(lat + s * (0.1 * Math.sin(lon * 4 + w1 * 9) + (w2 - 0.5) * 0.25));
    const itcz = Math.exp(-((al / 0.13) ** 2));
    const sub = Math.exp(-(((al - 0.45) / 0.14) ** 2));
    const storm = Math.exp(-(((al - 0.95) / 0.2) ** 2));
    const polar = smoothstep(1.2, 1.5, al);
    cov += s * (0.32 * itcz - 0.4 * sub + 0.3 * storm - 0.1 * polar);
    const cy = cycloneData(_cyc);
    for (let i = 0; i < MAX_CYCLONES; i++) {
      const cx = cy[i * 4]!, cyy = cy[i * 4 + 1]!, cz = cy[i * 4 + 2]!, cr = cy[i * 4 + 3]!;
      const cd = dx * cx + dy * cyy + dz * cz;
      if (cd <= cr) continue;
      const r = Math.sqrt((1 - cd) / (1 - cr));
      const ul = Math.hypot(cz, cx) || 1;
      const ux = -cz / ul, uz = cx / ul;
      // v = c x u
      const vx = cyy * uz, vy = cz * ux - cx * uz, vz = -cyy * ux;
      const th = Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dz * uz + 1e-6) * (cyy >= 0 ? 1 : -1);
      const arm = 0.5 + 0.5 * Math.sin(2 * th + 7 * Math.log(r + 0.08) + (w2 - 0.5) * 2.5);
      const env = smoothstep(1, 0.25, r);
      const wall = smoothstep(0.04, 0.12, r) * (1 - smoothstep(0.25, 0.5, r));
      const spiral = Math.max(0.2 + 0.8 * arm, wall) * smoothstep(0.02, 0.1, r);
      cov += (spiral - cov) * env * Math.min(1, s) * 0.9;
    }
    // Heavy weather closes up into overcast.
    cov += 0.2 * s * smoothstep(0.55, 0.9, cov);
  }
  // Soft ceiling: fully saturated coverage is a flat grey sheet with no relief.
  if (cov > 0.86) cov = 0.86 + (cov - 0.86) * 0.4;
  return Math.min(1, Math.max(0, cov));
}

/** Coverage 0..1 at a body fixed unit direction (sampled on the cloud base sphere). */
export function cloudCoverage(c: CloudDef, radius: number, atmosphereHeight: number, dir: { x: number; y: number; z: number }, simTime: number, coverageBias = 0): number {
  const r = radius + c.altitude * atmosphereHeight;
  return weatherCover(c, radius, dir.x * r, dir.y * r, dir.z * r, simTime, coverageBias);
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

type V3 = { x: number; y: number; z: number };

const remap01 = (v: number, a: number, b: number): number => Math.min(1, Math.max(0, (v - a) / (Math.abs(b - a) < 1e-4 ? 1e-4 : b - a)));

/** Cloud density 0..1 at a body fixed position (meters from the body centre), mirroring `cloudDensity` in clouds.glsl.ts without the erosion detail. */
export function cloudDensityAt(c: CloudDef, radius: number, px: number, py: number, pz: number, h01: number, simTime: number, coverageBias = 0): number {
  const shape = remap01(h01, 0, 0.12) * remap01(h01, 1, 0.55);
  if (shape <= 0) return 0;
  const scale = c.scale * radius;
  const drift = cloudDrift(c, radius, simTime);
  const cov = weatherCover(c, radius, px, py, pz, simTime, coverageBias);
  const base = sampleR((px + drift.x) / scale, py / scale, (pz + drift.z) / scale);
  return remap01(base * shape, 1 - cov, 1);
}

/**
 * Optical depth of the cloud layer along a ray (body fixed origin in meters from the centre, unit
 * direction). Zero when the origin is above the layer. Same extinction as the shader (1/180 per meter).
 */
export function cloudRayOpticalDepth(c: CloudDef, radius: number, atmosphereHeight: number, origin: V3, dir: V3, simTime: number, coverageBias = 0, steps = 16): number {
  const rIn = radius + c.altitude * atmosphereHeight;
  const thick = c.thickness * atmosphereHeight;
  const rOut = rIn + thick;
  const r0 = Math.hypot(origin.x, origin.y, origin.z);
  if (r0 >= rOut) return 0;
  const b = origin.x * dir.x + origin.y * dir.y + origin.z * dir.z;
  const exit = (r: number): number => -b + Math.sqrt(Math.max(b * b - (r0 * r0 - r * r), 0));
  const t1 = exit(rOut);
  const t0 = r0 < rIn ? exit(rIn) : 0;
  if (t1 <= t0) return 0;
  const seg = (t1 - t0) / steps;
  let od = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 0.5) * seg;
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    const h01 = (Math.hypot(x, y, z) - rIn) / thick;
    od += cloudDensityAt(c, radius, x, y, z, h01, simTime, coverageBias) * seg;
  }
  return od / 180;
}
