import { hashInts } from '../core/rng';
import type { BodyDef } from '../data/types';
import { biomeColor } from './biomes';
import { type TerrainSample, type TerrainSampler, createHeightSampler, makeSample } from './heightfield';
import { chunkEdgeLength, chunkRect, faceToDir } from './quadtree';

export interface ChunkRequest {
  id: number;
  bodyId: string;
  def: BodyDef;
  radius: number;
  face: number;
  level: number;
  x: number;
  y: number;
  grid: number;
  /** Absolute base url that terrain map urls resolve against (workers have no document). */
  mapBase?: string;
}

export interface ChunkResult {
  id: number;
  /** Non indexed triangles, relative to `center`. */
  positions: Float32Array;
  colors: Float32Array;
  /** Per vertex (isWater, facetRandom). */
  water: Float32Array;
  /** Chunk center in body fixed meters (float64 values). */
  center: [number, number, number];
  minR: number;
  maxR: number;
  /** Bounding sphere radius around `center`. */
  boundRadius: number;
}

const samplers = new Map<string, TerrainSampler>();

function samplerFor(req: ChunkRequest): TerrainSampler {
  let s = samplers.get(req.bodyId);
  if (!s) {
    s = createHeightSampler(req.def, req.radius);
    samplers.set(req.bodyId, s);
  }
  return s;
}

const SKIRT = 0.06;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Builds one chunk: samples heights on a (grid+1)^2 lattice, colors per triangle, adds skirts. */
export function buildChunk(req: ChunkRequest): ChunkResult {
  const sampler = samplerFor(req);
  const terrain = req.def.terrain;
  if (!terrain) throw new Error(`Body ${req.bodyId} has no terrain`);
  const G = req.grid;
  const V = G + 1;
  const R = req.radius;
  const [u0, v0, size] = chunkRect(req.level, req.x, req.y);

  const dir = { x: 0, y: 0, z: 0 };
  const px = new Float64Array(V * V);
  const py = new Float64Array(V * V);
  const pz = new Float64Array(V * V);
  const dx = new Float64Array(V * V);
  const dy = new Float64Array(V * V);
  const dz = new Float64Array(V * V);
  const samples: TerrainSample[] = [];
  let minR = Infinity;
  let maxR = -Infinity;
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = i + j * V;
      faceToDir(req.face, u0 + (i / G) * size, v0 + (j / G) * size, dir);
      const s = sampler.sample(dir.x, dir.y, dir.z, makeSample());
      samples.push(s);
      const r = R + s.height;
      px[k] = dir.x * r;
      py[k] = dir.y * r;
      pz[k] = dir.z * r;
      dx[k] = dir.x;
      dy[k] = dir.y;
      dz[k] = dir.z;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  const mid = V >> 1;
  const ck = mid + mid * V;
  // Chunk center: the sea level point under the middle of the chunk.
  const cx = dx[ck]! * R;
  const cy = dy[ck]! * R;
  const cz = dz[ck]! * R;

  const edge = chunkEdgeLength(R, req.level);
  const skirt = edge * SKIRT;
  const facetAng = Math.PI / 2 / (1 << req.level) / G;
  const cell = edge / G;
  void facetAng;
  // LOD factors. `detail` drives biome jitter and sharp transitions, `smooth` blends flat facet
  // colors into per vertex gradients on coarse chunks, `facetVar` is the per facet brightness noise.
  const detail = 1 - smoothstep(3000, 40000, cell);
  const smooth = smoothstep(4000, 18000, cell);
  const facetVar = 1 - smoothstep(3000, 16000, cell);
  // Slopes measured over a coarse triangle are meaningless at body scale: fade them out with size.
  const slopeScale = 1 / (1 + cell / 8000);

  // Per vertex colors from the analytic sample (continuous across triangles and chunks).
  const vcol = new Float32Array(V * V * 3);
  const rad = new Float64Array(V * V);
  for (let k = 0; k < V * V; k++) rad[k] = Math.hypot(px[k]!, py[k]!, pz[k]!);
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = i + j * V;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(G, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(G, j + 1);
      const ka = i0 + j * V;
      const kb = i1 + j * V;
      const kc = i + j0 * V;
      const kd = i + j1 * V;
      const d1 = Math.hypot(px[kb]! - px[ka]!, py[kb]! - py[ka]!, pz[kb]! - pz[ka]!) || 1;
      const d2 = Math.hypot(px[kd]! - px[kc]!, py[kd]! - py[kc]!, pz[kd]! - pz[kc]!) || 1;
      const gx = (rad[kb]! - rad[ka]!) / d1;
      const gy = (rad[kd]! - rad[kc]!) / d2;
      const sample = samples[k]!;
      const slope = sample.water ? 0 : Math.min(1, Math.hypot(gx, gy) * slopeScale);
      const col = biomeColor(terrain, sample, slope, detail);
      vcol[k * 3] = col[0];
      vcol[k * 3 + 1] = col[1];
      vcol[k * 3 + 2] = col[2];
    }
  }

  const cells = G * G;
  const tris = cells * 2 + 4 * G * 2;
  const positions = new Float32Array(tris * 9);
  const colors = new Float32Array(tris * 9);
  const water = new Float32Array(tris * 6);
  const triColor = new Float32Array(cells * 18); // two triangles per cell, 3 vertices, rgb
  const triWater = new Float32Array(cells * 2);
  const triRnd = new Float32Array(cells * 2);

  let maxDist2 = 0;
  const baseSeed = hashInts(req.face, req.level, req.x, req.y);

  const writeTri = (t: number, a: number, b: number, c: number, cell: number, which: number): void => {
    const o = t * 9;
    const va = [a, b, c];
    for (let q = 0; q < 3; q++) {
      const k = va[q]!;
      const X = px[k]! - cx;
      const Y = py[k]! - cy;
      const Z = pz[k]! - cz;
      positions[o + q * 3] = X;
      positions[o + q * 3 + 1] = Y;
      positions[o + q * 3 + 2] = Z;
      const d2 = X * X + Y * Y + Z * Z;
      if (d2 > maxDist2) maxDist2 = d2;
      const co = (cell * 2 + which) * 9 + q * 3;
      colors[o + q * 3] = triColor[co]!;
      colors[o + q * 3 + 1] = triColor[co + 1]!;
      colors[o + q * 3 + 2] = triColor[co + 2]!;
      water[t * 6 + q * 2] = triWater[cell * 2 + which]!;
      water[t * 6 + q * 2 + 1] = triRnd[cell * 2 + which]!;
    }
  };

  // Pass 1: colors per triangle.
  const classify = (a: number, b: number, c: number, cell: number, which: number): void => {
    const sa = samples[a]!;
    const sb = samples[b]!;
    const sc = samples[c]!;
    const wn = (sa.water ? 1 : 0) + (sb.water ? 1 : 0) + (sc.water ? 1 : 0);
    const isWater = wn >= 2;
    // Flat color: mean of the vertices that share the triangle's water/land class, so shores
    // are not dragged across the coastline.
    let fr = 0;
    let fg = 0;
    let fb = 0;
    let cnt = 0;
    const vs = [a, b, c];
    for (let q = 0; q < 3; q++) {
      const k = vs[q]!;
      if (samples[k]!.water !== isWater) continue;
      fr += vcol[k * 3]!;
      fg += vcol[k * 3 + 1]!;
      fb += vcol[k * 3 + 2]!;
      cnt++;
    }
    if (cnt === 0) cnt = 1;
    fr /= cnt;
    fg /= cnt;
    fb /= cnt;
    const rnd = (hashInts(baseSeed, cell, which) & 0xffff) / 65535;
    const kv = 1 + (rnd - 0.5) * 0.14 * facetVar;
    // A subtle warm/cool shift per facet makes the low poly look read on land.
    const tint = isWater ? 0 : (((hashInts(baseSeed, cell, which + 7) & 0xff) / 255) - 0.5) * 0.05 * facetVar;
    for (let q = 0; q < 3; q++) {
      const k = vs[q]!;
      const o = (cell * 2 + which) * 9 + q * 3;
      const m = smooth;
      const rr = fr + (vcol[k * 3]! - fr) * m;
      const gg = fg + (vcol[k * 3 + 1]! - fg) * m;
      const bb = fb + (vcol[k * 3 + 2]! - fb) * m;
      triColor[o] = rr * kv * (1 + tint);
      triColor[o + 1] = gg * kv;
      triColor[o + 2] = bb * kv * (1 - tint);
    }
    triWater[cell * 2 + which] = isWater ? 1 : 0;
    triRnd[cell * 2 + which] = rnd;
  };

  let t = 0;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const a = i + j * V;
      const b = a + 1;
      const c = a + V;
      const d = c + 1;
      const cell = i + j * G;
      classify(a, b, c, cell, 0);
      classify(b, d, c, cell, 1);
      writeTri(t++, a, b, c, cell, 0);
      writeTri(t++, b, d, c, cell, 1);
    }
  }

  // Skirts: drop each border edge radially.
  const skirtQuad = (a: number, b: number, cell: number, which: number): void => {
    const o = t * 9;
    const write = (slot: number, k: number, drop: number): void => {
      const rr = Math.hypot(px[k]!, py[k]!, pz[k]!);
      const s = (rr - drop) / rr;
      const X = px[k]! * s - cx;
      const Y = py[k]! * s - cy;
      const Z = pz[k]! * s - cz;
      positions[o + slot * 3] = X;
      positions[o + slot * 3 + 1] = Y;
      positions[o + slot * 3 + 2] = Z;
      const d2 = X * X + Y * Y + Z * Z;
      if (d2 > maxDist2) maxDist2 = d2;
    };
    const color = (tri: number): void => {
      for (let q = 0; q < 3; q++) {
        colors[tri * 9 + q * 3] = triColor[(cell * 2 + which) * 9]!;
        colors[tri * 9 + q * 3 + 1] = triColor[(cell * 2 + which) * 9 + 1]!;
        colors[tri * 9 + q * 3 + 2] = triColor[(cell * 2 + which) * 9 + 2]!;
        water[tri * 6 + q * 2] = triWater[cell * 2 + which]! + 2;
        water[tri * 6 + q * 2 + 1] = triRnd[cell * 2 + which]!;
      }
    };
    // tri 1: a, b, b-down. tri 2: a, b-down, a-down. Reuse `write` per slot.
    write(0, a, 0);
    write(1, b, 0);
    write(2, b, skirt);
    color(t);
    t++;
    const o2 = t * 9;
    const w2 = (slot: number, k: number, drop: number): void => {
      const rr = Math.hypot(px[k]!, py[k]!, pz[k]!);
      const s = (rr - drop) / rr;
      positions[o2 + slot * 3] = px[k]! * s - cx;
      positions[o2 + slot * 3 + 1] = py[k]! * s - cy;
      positions[o2 + slot * 3 + 2] = pz[k]! * s - cz;
    };
    w2(0, a, 0);
    w2(1, b, skirt);
    w2(2, a, skirt);
    color(t);
    t++;
  };
  for (let i = 0; i < G; i++) {
    skirtQuad(i, i + 1, i, 0); // bottom edge (j = 0)
    skirtQuad(G * V + i, G * V + i + 1, i + (G - 1) * G, 1); // top edge (j = G)
  }
  for (let j = 0; j < G; j++) {
    skirtQuad(j * V, (j + 1) * V, j * G, 0); // left edge (i = 0)
    skirtQuad(j * V + G, (j + 1) * V + G, G - 1 + j * G, 1); // right edge (i = G)
  }

  return {
    id: req.id,
    positions,
    colors,
    water,
    center: [cx, cy, cz],
    minR,
    maxR,
    boundRadius: Math.sqrt(maxDist2),
  };
}
