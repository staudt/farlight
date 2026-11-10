import { Simplex3 } from '../core/noise';
import type { BiomeDef, RGB, TerrainDef } from '../data/types';
import type { TerrainSample } from './heightfield';

let jitterNoise: Simplex3 | null = null;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Soft window: 1 inside [lo, hi], fading over `w` on each side. Undefined bounds are open. */
function window(x: number, lo: number | undefined, hi: number | undefined, w: number): number {
  let m = 1;
  if (lo !== undefined) m *= smoothstep(lo - w, lo + w, x);
  if (hi !== undefined) m *= 1 - smoothstep(hi - w, hi + w, x);
  return m;
}

/**
 * Membership from the optional hemisphere and direction rules of a biome (1 when it has none).
 * `lat` is the signed latitude-like coordinate, `w` the soft edge width.
 */
function placeMask(rule: BiomeDef, s: TerrainSample, lat: number, w: number): number {
  let m = 1;
  if (rule.hemisphere) m *= smoothstep(-w, w, rule.hemisphere === 'north' ? lat : -lat);
  const d = rule.direction;
  if (d) {
    const a = d.axis;
    const dot = (s.x * a[0] + s.y * a[1] + s.z * a[2]) / (Math.hypot(a[0], a[1], a[2]) || 1);
    m *= window(dot, d.minDot, d.maxDot, d.softness ?? 0.08);
  }
  return m;
}

/**
 * Color for a surface sample. `slope` is tan(angle from horizontal), clamped to 0..1.
 * `detail` is 1 for close views and falls to 0 for coarse chunks: it shrinks the noise jitter and
 * widens the biome transitions so far views read as smooth regions instead of per-facet patchwork.
 * Biome rules are composited in order with soft (smoothstep) membership, so there are no hard
 * threshold flips between neighbouring vertices.
 * `emit`, when given, is a zeroed [r, g, b, dayWeighted, weight] filled with the weighted biome glow.
 */
export function biomeColor(def: TerrainDef, s: TerrainSample, slope: number, detail = 1, emit?: number[]): RGB {
  jitterNoise ??= new Simplex3(4242);
  const j = jitterNoise;
  const jn = detail > 0.01 ? j.noise(s.x * 55, s.y * 55, s.z * 55) * detail : 0;
  const jn2 = j.noise(s.x * 23 + 9, s.y * 23, s.z * 23 + 5);
  // Mid frequency patches (forest vs meadow) fade in with detail.
  const patch = j.noise(s.x * 9 + 3, s.y * 9 + 7, s.z * 9) * detail;
  const absLat = Math.abs(s.lat) + jn2 * 0.03 * detail;
  const soft = 1 - detail;

  let r: number, g: number, b: number;
  if (s.water) {
    const w = def.water;
    const c0 = w?.color ?? [0.1, 0.3, 0.5];
    const c1 = w?.deepColor ?? [0.03, 0.1, 0.25];
    const t = 1 - Math.exp(-s.depthN * 7);
    r = c0[0] + (c1[0] - c0[0]) * t;
    g = c0[1] + (c1[1] - c0[1]) * t;
    b = c0[2] + (c1[2] - c0[2]) * t;
    const we = w?.emissive;
    if (emit && we) {
      // Glow follows the shallows, a bit stronger over deeper colour.
      const c = we.color ?? c0;
      const k = we.intensity * (0.6 + 0.4 * t);
      emit[0]! += c[0] * k;
      emit[1]! += c[1] * k;
      emit[2]! += c[2] * k;
      emit[3]! += (we.day ?? 0) * k;
      emit[4]! += k;
    }
  } else {
    const n = s.n + jn * 0.03;
    const moist = s.moisture + patch * 0.22;
    const hw = 0.012 + soft * 0.12;
    const mw = 0.05 + soft * 0.12;
    const lw = 0.04 + soft * 0.1;
    r = g = b = 0;
    let rem = 1;
    const rules = def.biomes;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      let m = window(n, rule.minHeight, rule.maxHeight, hw);
      if (rule.maxSlope !== undefined) m *= 1 - smoothstep(rule.maxSlope - 0.1, rule.maxSlope + 0.1, slope);
      if (rule.latitude) m *= window(absLat, rule.latitude[0], rule.latitude[1], lw);
      if (rule.hemisphere || rule.direction) m *= placeMask(rule, s, s.lat + jn2 * 0.03 * detail, lw);
      if (rule.moisture) m *= window(moist, rule.moisture[0], rule.moisture[1], mw);
      const wgt = i === rules.length - 1 ? rem : m * rem;
      r += rule.color[0] * wgt;
      g += rule.color[1] * wgt;
      b += rule.color[2] * wgt;
      if (emit && rule.emissive) {
        const e = rule.emissive;
        const c = e.color ?? rule.color;
        const k = e.intensity * wgt;
        emit[0]! += c[0] * k;
        emit[1]! += c[1] * k;
        emit[2]! += c[2] * k;
        // Day share, weighted by how much light this rule adds.
        emit[3]! += (e.day ?? 0) * k;
        emit[4]! += k;
      }
      rem -= wgt;
      if (rem <= 0.001) break;
    }
    // Steep slopes blend to darkened, warm rock.
    const rock = smoothstep(0.45, 0.9, slope);
    if (rock > 0) {
      const lum = 0.3 * r + 0.55 * g + 0.15 * b;
      const rr = lum * 0.5 + 0.07;
      r += (rr * 1.08 - r) * rock * 0.8;
      g += (rr * 0.96 - g) * rock * 0.8;
      b += (rr * 0.84 - b) * rock * 0.8;
    }
  }

  if (s.ice > 0.02 && !s.water) {
    const e = smoothstep(0.25 - soft * 0.15, 0.75 + soft * 0.15, s.ice + jn * 0.08);
    const c = def.polarCaps?.color ?? [0.88, 0.92, 0.96];
    r += (c[0] - r) * e;
    g += (c[1] - g) * e;
    b += (c[2] - b) * e;
  }

  const caps = def.polarCaps;
  if (caps) {
    const edge = smoothstep(caps.latitude - 0.02 - soft * 0.04, caps.latitude + 0.04 + soft * 0.04, absLat + jn * 0.03);
    if (edge > 0) {
      r += (caps.color[0] - r) * edge;
      g += (caps.color[1] - g) * edge;
      b += (caps.color[2] - b) * edge;
    }
  }
  return [r, g, b];
}

/**
 * Name of the dominant biome rule at a sample (same membership logic as `biomeColor` at full
 * detail). Water returns 'water'. Used by prop scattering, so props agree with the ground color.
 */
export function biomeNameAt(def: TerrainDef, s: TerrainSample, slope: number): string {
  if (s.water) return 'water';
  jitterNoise ??= new Simplex3(4242);
  const j = jitterNoise;
  const jn = j.noise(s.x * 55, s.y * 55, s.z * 55);
  const jn2 = j.noise(s.x * 23 + 9, s.y * 23, s.z * 23 + 5);
  const patch = j.noise(s.x * 9 + 3, s.y * 9 + 7, s.z * 9);
  const absLat = Math.abs(s.lat) + jn2 * 0.03;
  const n = s.n + jn * 0.03;
  const moist = s.moisture + patch * 0.22;
  let rem = 1;
  const rules = def.biomes;
  let best = rules[rules.length - 1]?.name ?? '';
  let bestW = -1;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    let m = window(n, rule.minHeight, rule.maxHeight, 0.012);
    if (rule.maxSlope !== undefined) m *= 1 - smoothstep(rule.maxSlope - 0.1, rule.maxSlope + 0.1, slope);
    if (rule.latitude) m *= window(absLat, rule.latitude[0], rule.latitude[1], 0.04);
    if (rule.hemisphere || rule.direction) m *= placeMask(rule, s, s.lat + jn2 * 0.03, 0.04);
    if (rule.moisture) m *= window(moist, rule.moisture[0], rule.moisture[1], 0.05);
    const wgt = i === rules.length - 1 ? rem : m * rem;
    if (wgt > bestW) {
      bestW = wgt;
      best = rule.name;
    }
    rem -= wgt;
    if (rem <= 0.001) break;
  }
  if (s.ice > 0.5) return 'ice';
  return best;
}
