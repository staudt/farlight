import { Simplex3 } from '../core/noise';
import type { RGB, TerrainDef } from '../data/types';
import type { TerrainSample } from './heightfield';

let jitterNoise: Simplex3 | null = null;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Vertex/face color for a surface sample. `slope` is tan(angle from horizontal), clamped to 0..1
 * (0 flat, 1 is 45 degrees and beyond). Biome rules are ordered, first match wins; lookups are
 * jittered with small noise so borders are ragged instead of straight.
 */
export function biomeColor(def: TerrainDef, s: TerrainSample, slope: number, jitterFreq = 55): RGB {
  jitterNoise ??= new Simplex3(4242);
  const j = jitterNoise;
  const jn = j.noise(s.x * jitterFreq, s.y * jitterFreq, s.z * jitterFreq);
  const jn2 = j.noise(s.x * jitterFreq * 0.42 + 9, s.y * jitterFreq * 0.42, s.z * jitterFreq * 0.42 + 5);
  const absLat = Math.abs(s.lat) + jn2 * 0.05;

  let r: number, g: number, b: number;
  if (s.water) {
    const w = def.water;
    const c0 = w?.color ?? [0.1, 0.3, 0.5];
    const c1 = w?.deepColor ?? [0.03, 0.1, 0.25];
    const t = 1 - Math.exp(-s.depthN * 3.2);
    r = c0[0] + (c1[0] - c0[0]) * t;
    g = c0[1] + (c1[1] - c0[1]) * t;
    b = c0[2] + (c1[2] - c0[2]) * t;
  } else {
    const n = s.n + jn * 0.035;
    const moist = s.moisture + jn2 * 0.1;
    let col: RGB | undefined;
    for (const rule of def.biomes) {
      if (rule.minHeight !== undefined && n < rule.minHeight) continue;
      if (rule.maxHeight !== undefined && n > rule.maxHeight) continue;
      if (rule.maxSlope !== undefined && slope > rule.maxSlope) continue;
      if (rule.latitude && (absLat < rule.latitude[0] || absLat > rule.latitude[1])) continue;
      if (rule.moisture && (moist < rule.moisture[0] || moist > rule.moisture[1])) continue;
      col = rule.color;
      break;
    }
    col ??= def.biomes[def.biomes.length - 1]?.color ?? [0.5, 0.5, 0.5];
    r = col[0];
    g = col[1];
    b = col[2];
    // Steep slopes blend to darkened rock.
    const rock = smoothstep(0.55, 0.95, slope);
    if (rock > 0) {
      const lum = 0.3 * r + 0.55 * g + 0.15 * b;
      const rr = lum * 0.35 + 0.1;
      r += (rr * 1.05 - r) * rock * 0.85;
      g += (rr * 0.97 - g) * rock * 0.85;
      b += (rr * 0.9 - b) * rock * 0.85;
    }
  }

  const caps = def.polarCaps;
  if (caps) {
    const edge = smoothstep(caps.latitude - 0.02, caps.latitude + 0.04, absLat + jn * 0.03);
    if (edge > 0) {
      r += (caps.color[0] - r) * edge;
      g += (caps.color[1] - g) * edge;
      b += (caps.color[2] - b) * edge;
    }
  }
  return [r, g, b];
}
