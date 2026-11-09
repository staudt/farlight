/**
 * Surface prop scattering (trees, rocks, spires, crystals, mesas). Pure code, shared by the chunk
 * worker and tests. Props are keyed to a FIXED world grid (not to the chunk), so a parent chunk and
 * its children place the identical props and LOD swaps never pop.
 */
import { hashInts } from '../core/rng';
import { Simplex3 } from '../core/noise';
import type { BodyDef, PropDef, PropKind } from '../data/types';
import { biomeNameAt } from './biomes';
import { type TerrainSampler, makeSample } from './heightfield';
import { chunkEdgeLength, faceToDir } from './quadtree';

export interface PropBatch {
  kind: PropKind;
  /** Mesh variant of the kind (tree: 0 conifer, 1 broadleaf). */
  variant: number;
  count: number;
  /** 16 floats per instance (column major), chunk local. */
  matrices: Float32Array;
  /** 3 floats per instance, linear RGB. */
  colors: Float32Array;
}

export interface PropScatterParams {
  face: number;
  level: number;
  x: number;
  y: number;
  radius: number;
  /** Fixed grid level: cells are about 12 to 25 m across. */
  gridLevel: number;
  /** Chunk center in body fixed meters. */
  center: readonly [number, number, number];
  maxInstances?: number;
}

export const PROP_GRID_EXTRA = 4;
export const MAX_PROPS_PER_CHUNK = 1400;
export const TREE_CONIFER = 0;
export const TREE_BROADLEAF = 1;

/** Wavelength in meters of the low frequency noise that gathers props into groves and fields. */
const CLUMP_SCALE: Record<PropKind, number> = { tree: 240, rock: 160, spire: 320, crystal: 220, mesa: 700 };
/** Fraction of its size a prop sinks into the ground. */
const SINK: Record<PropKind, number> = { tree: 0.03, rock: 0.14, spire: 0.04, crystal: 0.05, mesa: 0.02 };
/** Tilt (radians) of the up axis away from the surface normal. */
const TILT: Record<PropKind, number> = { tree: 0.04, rock: 0.35, spire: 0.08, crystal: 0.2, mesa: 0 };

const clumpNoise = new Map<number, Simplex3>();

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Tan of the slope angle at `dir`, from two small height probes. */
export function propSlope(sampler: TerrainSampler, dir: readonly [number, number, number], h0: number): number {
  const R = sampler.radius;
  const d = 6 / R;
  // Two tangents of the sphere at dir.
  let rx = 0;
  let ry = 1;
  const rz = 0;
  if (Math.abs(dir[1]) > 0.95) {
    rx = 1;
    ry = 0;
  }
  let t1x = dir[1] * rz - dir[2] * ry;
  let t1y = dir[2] * rx - dir[0] * rz;
  let t1z = dir[0] * ry - dir[1] * rx;
  const l1 = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= l1;
  t1y /= l1;
  t1z /= l1;
  const t2x = dir[1] * t1z - dir[2] * t1y;
  const t2y = dir[2] * t1x - dir[0] * t1z;
  const t2z = dir[0] * t1y - dir[1] * t1x;
  const probe = (tx: number, ty: number, tz: number): number => {
    const x = dir[0] + tx * d;
    const y = dir[1] + ty * d;
    const z = dir[2] + tz * d;
    const l = Math.hypot(x, y, z);
    return sampler.heightAt(x / l, y / l, z / l) - h0;
  };
  return Math.hypot(probe(t1x, t1y, t1z), probe(t2x, t2y, t2z)) / 6;
}

function treeVariant(biome: string): number {
  return biome === 'forest' || biome.includes('taiga') || biome.includes('conifer') ? TREE_CONIFER : TREE_BROADLEAF;
}

interface Accum {
  kind: PropKind;
  variant: number;
  m: number[];
  c: number[];
}

/** Scatters props for one chunk. Deterministic: depends only on body seed, def and chunk address. */
export function scatterProps(def: BodyDef, sampler: TerrainSampler, p: PropScatterParams): PropBatch[] {
  const defs = def.terrain?.props;
  if (!defs || defs.length === 0 || !def.terrain) return [];
  const terrain = def.terrain;
  const R = p.radius;
  const cap = p.maxInstances ?? MAX_PROPS_PER_CHUNK;
  const shift = p.gridLevel - p.level;
  if (shift < 0) return [];
  const n = 1 << shift;
  const cs = 2 / (1 << p.gridLevel);
  const cellEdge = chunkEdgeLength(R, p.gridLevel);
  const cellKm2 = (cellEdge / 1000) * (cellEdge / 1000);
  const gx0 = p.x * n;
  const gy0 = p.y * n;
  const seed = def.seed | 0;
  const batches = new Map<string, Accum>();
  const dir = { x: 0, y: 0, z: 0 };
  const s = makeSample();
  let total = 0;

  for (let pi = 0; pi < defs.length && total < cap; pi++) {
    const pd: PropDef = defs[pi]!;
    const prob = pd.density * cellKm2;
    if (prob <= 0) continue;
    let noise = clumpNoise.get(seed + pi * 7919);
    if (!noise) {
      noise = new Simplex3(seed * 31 + pi * 7919 + 17);
      clumpNoise.set(seed + pi * 7919, noise);
    }
    const cscale = R / CLUMP_SCALE[pd.kind];
    for (let j = 0; j < n && total < cap; j++) {
      for (let i = 0; i < n && total < cap; i++) {
        const gx = gx0 + i;
        const gy = gy0 + j;
        const h = hashInts(seed, p.face, gx, gy, pi + 101);
        const r0 = (h & 0xffff) / 65536;
        if (r0 >= prob * 1.8) continue;
        const jx = 0.1 + 0.8 * (((h >>> 16) & 0xff) / 255);
        const jy = 0.1 + 0.8 * (((h >>> 24) & 0xff) / 255);
        faceToDir(p.face, -1 + (gx + jx) * cs, -1 + (gy + jy) * cs, dir);
        const clump = 0.2 + 1.6 * smoothstep(-0.3, 0.5, noise.noise(dir.x * cscale, dir.y * cscale, dir.z * cscale));
        if (r0 >= prob * clump) continue;
        sampler.sample(dir.x, dir.y, dir.z, s);
        if (s.water) continue;
        if (pd.minHeight !== undefined && s.n < pd.minHeight) continue;
        if (pd.maxHeight !== undefined && s.n > pd.maxHeight) continue;
        let biome = '';
        if (pd.biomes) {
          biome = biomeNameAt(terrain, s, 0);
          if (!pd.biomes.includes(biome)) continue;
        } else if (pd.kind === 'tree') biome = biomeNameAt(terrain, s, 0);

        if (pd.maxSlope !== undefined) {
          const slope = propSlope(sampler, [dir.x, dir.y, dir.z], s.height);
          if (slope > pd.maxSlope) continue;
        }

        const h2 = hashInts(h, 7, pi);
        const r1 = (h2 & 0xffff) / 65535;
        const r2 = ((h2 >>> 16) & 0xff) / 255;
        const r3 = ((hashInts(h2, 3) >>> 8) & 0xffff) / 65535;
        const r4 = ((hashInts(h2, 5) >>> 8) & 0xffff) / 65535;
        const size = pd.minSize + (pd.maxSize - pd.minSize) * r1 * r1;
        const sink = size * SINK[pd.kind];
        const rr = R + s.height - sink;
        const px = dir.x * rr - p.center[0];
        const py = dir.y * rr - p.center[1];
        const pz = dir.z * rr - p.center[2];

        // Frame: Y up (surface normal, optionally tilted), X/Z around it with a random yaw.
        let ux = dir.x;
        let uy = dir.y;
        let uz = dir.z;
        let ax = 0;
        let ay = 1;
        const az = 0;
        if (Math.abs(uy) > 0.95) {
          ax = 1;
          ay = 0;
        }
        let tx = uy * az - uz * ay;
        let ty = uz * ax - ux * az;
        let tz = ux * ay - uy * ax;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const bx = uy * tz - uz * ty;
        const by = uz * tx - ux * tz;
        const bz = ux * ty - uy * tx;
        // Random tilt toward a random tangent direction.
        const tilt = TILT[pd.kind] * r3;
        if (tilt > 0) {
          const ta = r4 * Math.PI * 2;
          const dx = tx * Math.cos(ta) + bx * Math.sin(ta);
          const dy = ty * Math.cos(ta) + by * Math.sin(ta);
          const dz = tz * Math.cos(ta) + bz * Math.sin(ta);
          ux += dx * tilt;
          uy += dy * tilt;
          uz += dz * tilt;
          const ul = Math.hypot(ux, uy, uz);
          ux /= ul;
          uy /= ul;
          uz /= ul;
        }
        const yaw = ((hashInts(h2, 9) >>> 4) & 0xfff) / 4096 * Math.PI * 2;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        let xx = tx * cy + bx * sy;
        let xy = ty * cy + by * sy;
        let xz = tz * cy + bz * sy;
        const xd = xx * ux + xy * uy + xz * uz;
        xx -= ux * xd;
        xy -= uy * xd;
        xz -= uz * xd;
        const xl = Math.hypot(xx, xy, xz) || 1;
        xx /= xl;
        xy /= xl;
        xz /= xl;
        const zx = xy * uz - xz * uy;
        const zy = xz * ux - xx * uz;
        const zz = xx * uy - xy * ux;

        // Non uniform scale: height follows `size`, width gets a little variety.
        const wv = 0.85 + 0.3 * r2;
        let sxz = size * wv;
        let sh = size;
        if (pd.kind === 'rock') sh = size * (0.6 + 0.5 * r3);
        else if (pd.kind === 'mesa') sxz = size * (0.8 + 0.8 * r2);
        else if (pd.kind === 'crystal') sxz = size * (0.8 + 0.4 * r2);
        else if (pd.kind === 'spire') sxz = size * (0.8 + 0.5 * r2);

        // Color variation: brightness plus a small per channel shift, kept subtle for the faceted look.
        const br = 0.78 + 0.44 * r2;
        const cr = pd.color[0] * br * (0.94 + 0.12 * r4);
        const cg = pd.color[1] * br * (0.94 + 0.12 * r3);
        const cb = pd.color[2] * br * (0.94 + 0.12 * r1);

        const variant = pd.kind === 'tree' ? treeVariant(biome) : 0;
        const key = `${pd.kind}:${variant}`;
        let acc = batches.get(key);
        if (!acc) {
          acc = { kind: pd.kind, variant, m: [], c: [] };
          batches.set(key, acc);
        }
        acc.m.push(xx * sxz, xy * sxz, xz * sxz, 0, ux * sh, uy * sh, uz * sh, 0, zx * sxz, zy * sxz, zz * sxz, 0, px, py, pz, 1);
        acc.c.push(cr, cg, cb);
        total++;
      }
    }
  }

  const out: PropBatch[] = [];
  for (const a of batches.values()) {
    out.push({ kind: a.kind, variant: a.variant, count: a.c.length / 3, matrices: new Float32Array(a.m), colors: new Float32Array(a.c) });
  }
  return out;
}
