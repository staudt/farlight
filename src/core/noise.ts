import { mulberry32 } from './rng';

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);
const F3 = 1 / 3;
const G3 = 1 / 6;

/** Seeded 3D simplex noise. Output is roughly in [-1, 1]. Pure and deterministic. */
export class Simplex3 {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255]!;
      this.permMod12[i] = this.perm[i]! % 12;
    }
  }

  noise(x: number, y: number, z: number): number {
    const perm = this.perm;
    const pm = this.permMod12;
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) {
      const g = pm[ii + perm[jj + perm[kk]!]!]! * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g]! * x0 + GRAD3[g + 1]! * y0 + GRAD3[g + 2]! * z0);
    }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) {
      const g = pm[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]! * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g]! * x1 + GRAD3[g + 1]! * y1 + GRAD3[g + 2]! * z1);
    }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) {
      const g = pm[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]! * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g]! * x2 + GRAD3[g + 1]! * y2 + GRAD3[g + 2]! * z2);
    }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) {
      const g = pm[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]! * 3;
      tt *= tt;
      n += tt * tt * (GRAD3[g]! * x3 + GRAD3[g + 1]! * y3 + GRAD3[g + 2]! * z3);
    }
    return 32 * n;
  }
}

/** Fractal sum, normalized to roughly [-1, 1]. */
export function fbm(s: Simplex3, x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * s.noise(x * f, y * f, z * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal. Output in [0, 1], sharp crests. */
export function ridged(s: Simplex3, x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let w = 1;
  for (let o = 0; o < octaves; o++) {
    let r = 1 - Math.abs(s.noise(x * f, y * f, z * f));
    r *= r;
    r *= w;
    w = Math.min(1, Math.max(0, r * 2));
    sum += amp * r;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Billow (rounded hills). Output in [-1, 1]. */
export function billow(s: Simplex3, x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (2 * Math.abs(s.noise(x * f, y * f, z * f)) - 1);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Domain warp: returns the warped coordinates in `out`. `strength` is in coordinate units. */
export function warp3(s: Simplex3, x: number, y: number, z: number, strength: number, out: { x: number; y: number; z: number }): void {
  out.x = x + strength * s.noise(x * 0.7 + 13.1, y * 0.7 + 7.7, z * 0.7 + 3.3);
  out.y = y + strength * s.noise(x * 0.7 + 41.3, y * 0.7 + 29.9, z * 0.7 + 17.1);
  out.z = z + strength * s.noise(x * 0.7 + 5.9, y * 0.7 + 61.7, z * 0.7 + 37.7);
}
