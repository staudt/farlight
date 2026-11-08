import { Data3DTexture, LinearFilter, RGFormat, RepeatWrapping, UnsignedByteType } from 'three';
import { mulberry32 } from '../../core/rng';

/**
 * Tileable 3D cloud noise, built once on the CPU.
 *  R: Perlin-Worley base shape (billowy cumulus blobs)
 *  G: higher frequency Worley for edge erosion
 */
export function createCloudNoiseTexture(size = 64, seed = 7): Data3DTexture {
  const rnd = mulberry32(seed);
  const data = new Uint8Array(size * size * size * 2);

  const worley = makeWorley(size, 6, rnd);
  const worleyHi = makeWorley(size, 14, rnd);
  const value = makeValueFbm(size, 4, rnd);

  for (let i = 0; i < size * size * size; i++) {
    const w = 1 - worley[i]!;
    const v = value[i]!;
    // Perlin-Worley: remap the fbm by the inverted Worley so blobs get puffy rounded tops.
    const pw = clamp01(remap(v, w * 0.55 - 0.15, 1, 0, 1));
    data[i * 2] = Math.round(clamp01(pw * 0.75 + w * 0.35) * 255);
    data[i * 2 + 1] = Math.round(clamp01(1 - worleyHi[i]!) * 255);
  }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable Worley (F1 distance), normalized to 0..1. */
function makeWorley(size: number, cells: number, rnd: () => number): Float32Array {
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < cells ** 3; i++) {
    pts[i * 3] = rnd();
    pts[i * 3 + 1] = rnd();
    pts[i * 3 + 2] = rnd();
  }
  const out = new Float32Array(size ** 3);
  const cellSize = size / cells;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = x / cellSize, fy = y / cellSize, fz = z / cellSize;
        const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy, nz = cz + dz;
              const wx = ((nx % cells) + cells) % cells;
              const wy = ((ny % cells) + cells) % cells;
              const wz = ((nz % cells) + cells) % cells;
              const pi = (wx + wy * cells + wz * cells * cells) * 3;
              const px = nx + pts[pi]!, py = ny + pts[pi + 1]!, pz = nz + pts[pi + 2]!;
              const d = (px - fx) ** 2 + (py - fy) ** 2 + (pz - fz) ** 2;
              if (d < best) best = d;
            }
        out[x + y * size + z * size * size] = Math.min(1, Math.sqrt(best));
      }
  return out;
}

/** Tileable value noise fbm, normalized to about 0..1. */
function makeValueFbm(size: number, octaves: number, rnd: () => number): Float32Array {
  const out = new Float32Array(size ** 3);
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = 4 << o;
    const lattice = new Float32Array(period ** 3);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    const at = (x: number, y: number, z: number): number =>
      lattice[(x % period) + (y % period) * period + (z % period) * period * period]!;
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * period, fy = (y / size) * period, fz = (z / size) * period;
          const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
          const tx = smooth(fx - ix), ty = smooth(fy - iy), tz = smooth(fz - iz);
          const c000 = at(ix, iy, iz), c100 = at(ix + 1, iy, iz);
          const c010 = at(ix, iy + 1, iz), c110 = at(ix + 1, iy + 1, iz);
          const c001 = at(ix, iy, iz + 1), c101 = at(ix + 1, iy, iz + 1);
          const c011 = at(ix, iy + 1, iz + 1), c111 = at(ix + 1, iy + 1, iz + 1);
          const v =
            lerp(
              lerp(lerp(c000, c100, tx), lerp(c010, c110, tx), ty),
              lerp(lerp(c001, c101, tx), lerp(c011, c111, tx), ty),
              tz,
            );
          out[x + y * size + z * size * size]! += v * amp;
        }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const remap = (v: number, a: number, b: number, c: number, d: number): number => c + ((v - a) / (b - a)) * (d - c);
