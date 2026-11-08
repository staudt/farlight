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
  const jitterFreq = Math.min(55, Math.max(4, 0.6 / facetAng));

  const cells = G * G;
  const tris = cells * 2 + 4 * G * 2;
  const positions = new Float32Array(tris * 9);
  const colors = new Float32Array(tris * 9);
  const water = new Float32Array(tris * 6);
  const triColor = new Float32Array(cells * 6); // two triangles per cell, rgb
  const triWater = new Float32Array(cells * 2);
  const triRnd = new Float32Array(cells * 2);

  let maxDist2 = 0;
  const tmp = makeSample();
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
      colors[o + q * 3] = triColor[(cell * 2 + which) * 3]!;
      colors[o + q * 3 + 1] = triColor[(cell * 2 + which) * 3 + 1]!;
      colors[o + q * 3 + 2] = triColor[(cell * 2 + which) * 3 + 2]!;
      water[t * 6 + q * 2] = triWater[cell * 2 + which]!;
      water[t * 6 + q * 2 + 1] = triRnd[cell * 2 + which]!;
    }
  };

  // Pass 1: colors per triangle.
  const classify = (a: number, b: number, c: number, cell: number, which: number): void => {
    const ex = px[b]! - px[a]!;
    const ey = py[b]! - py[a]!;
    const ez = pz[b]! - pz[a]!;
    const fx = px[c]! - px[a]!;
    const fy = py[c]! - py[a]!;
    const fz = pz[c]! - pz[a]!;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const rx = dx[a]! + dx[b]! + dx[c]!;
    const ry = dy[a]! + dy[b]! + dy[c]!;
    const rz = dz[a]! + dz[b]! + dz[c]!;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const cosT = Math.min(1, Math.abs(nx * rx + ny * ry + nz * rz) / rl);
    const slope = Math.min(1, Math.sqrt(1 - cosT * cosT) / Math.max(cosT, 1e-4));
    const sa = samples[a]!;
    const sb = samples[b]!;
    const sc = samples[c]!;
    const wn = (sa.water ? 1 : 0) + (sb.water ? 1 : 0) + (sc.water ? 1 : 0);
    tmp.x = rx / rl;
    tmp.y = ry / rl;
    tmp.z = rz / rl;
    tmp.lat = Math.asin(Math.max(-1, Math.min(1, tmp.y)));
    tmp.water = wn >= 2;
    if (tmp.water) {
      tmp.n = (sa.n + sb.n + sc.n) / 3;
      tmp.depthN = ((sa.water ? sa.depthN : 0) + (sb.water ? sb.depthN : 0) + (sc.water ? sc.depthN : 0)) / wn;
    } else {
      // Average only land vertices so shores are not dragged underwater.
      let n = 0;
      let cnt = 0;
      for (const s of [sa, sb, sc]) {
        if (!s.water) {
          n += s.n;
          cnt++;
        }
      }
      tmp.n = cnt ? n / cnt : sa.n;
      tmp.depthN = 0;
    }
    tmp.moisture = (sa.moisture + sb.moisture + sc.moisture) / 3;
    const col = biomeColor(terrain, tmp, tmp.water ? 0 : slope, jitterFreq);
    const rnd = (hashInts(baseSeed, cell, which) & 0xffff) / 65535;
    const k = 1 + (rnd - 0.5) * 0.08;
    const o = (cell * 2 + which) * 3;
    triColor[o] = col[0] * k;
    triColor[o + 1] = col[1] * k;
    triColor[o + 2] = col[2] * k;
    triWater[cell * 2 + which] = tmp.water ? 1 : 0;
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
        colors[tri * 9 + q * 3] = triColor[(cell * 2 + which) * 3]!;
        colors[tri * 9 + q * 3 + 1] = triColor[(cell * 2 + which) * 3 + 1]!;
        colors[tri * 9 + q * 3 + 2] = triColor[(cell * 2 + which) * 3 + 2]!;
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
