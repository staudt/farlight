import type { WeatherDef } from '../../data/types';

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t);

/** Cheap 3D value noise, 0..1. */
export function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const fz = fade(z - zi);
  let r = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * (k ? fz : 1 - fz);
        r += w * hash3(xi + i, yi + j, zi + k);
      }
    }
  }
  return r;
}

/** Weather cell size as a fraction of the body radius. */
const CELL = 0.2;
/** Seconds of sim time for the weather pattern to drift by about a cell. */
const CYCLE = 240;

export interface Dir3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Cheap CPU proxy for local cloud cover: 0..1 noise over body fixed direction and sim time.
 * Rain and lightning use the same field so storms cluster.
 */
export function cloudProxy(dir: Dir3, time: number, salt = 0): number {
  const s = 1 / CELL;
  const t = time / CYCLE;
  const a = valueNoise3(dir.x * s + t * 0.7 + salt, dir.y * s + t * 0.25, dir.z * s - t * 0.5);
  const b = valueNoise3(dir.x * s * 2.3 - 5 + salt, dir.y * s * 2.3 + t * 0.9, dir.z * s * 2.3 + 11);
  return a * 0.7 + b * 0.3;
}

export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Latitude band weight 0..1 with soft edges. */
export function bandWeight(def: WeatherDef, absLat: number): number {
  const band = def.latitudeBand;
  if (!band) return 1;
  const soft = 0.08;
  return smooth(band[0] - soft, band[0] + soft, absLat) * (1 - smooth(band[1] - soft, band[1] + soft, absLat));
}

/** 0..1 how strongly this weather is happening at a body fixed direction (before altitude fading). */
export function weatherAmount(def: WeatherDef, dir: Dir3, time: number): number {
  const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, dir.y))));
  const band = bandWeight(def, lat);
  if (band <= 0) return 0;
  const n = cloudProxy(dir, time, def.kind === 'snow' ? 3.7 : 0);
  const thr = 0.74 - 0.5 * def.intensity;
  return band * smooth(thr, thr + 0.1, n) * (0.55 + 0.45 * def.intensity);
}
