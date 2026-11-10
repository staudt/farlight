import { Simplex3 } from '../core/noise';
import { hashInts } from '../core/rng';
import type { BodyDef } from '../data/types';
import { biomeColor } from './biomes';
import { getMap, sampleMap } from './maps';
import { type TerrainSample, type TerrainSampler, createHeightSampler, makeSample } from './heightfield';
import { chunkEdgeLength, chunkRect, faceToDir } from './quadtree';
import { type PropBatch, scatterProps } from './props';

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
  /** Prop scattering, only for chunks at `minLevel` or finer (props matter within a few km). */
  props?: { minLevel: number; gridLevel: number };
}

export interface ChunkResult {
  id: number;
  /** Non indexed triangles, relative to `center`. */
  positions: Float32Array;
  colors: Float32Array;
  /** Per vertex (isWater, facetRandom, shore): shore is the signed distance to the coast in foam band widths, negative on land. */
  water: Float32Array;
  /** Per vertex (r, g, b, dayShare) HDR self light. Absent when the body has none. */
  emit?: Float32Array;
  /** Per vertex (body fixed unit direction, share of the shader lights map) for bodies with a lights map. */
  dir?: Float32Array;
  /** Chunk center in body fixed meters (float64 values). */
  center: [number, number, number];
  minR: number;
  maxR: number;
  /** Bounding sphere radius around `center`. */
  boundRadius: number;
  /** Surface props, chunk local transforms (empty on coarse chunks). */
  props: PropBatch[];
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

/** Foam band width in meters (the shader scales it with `uFoamWidth`). */
const SHORE_BAND = 110;

/** Share of lamps that are whitened (the rest keep the warm lamp colour). */
const WHITE_LAMP_SHARE = 0.3;
const WHITE_LAMP: readonly [number, number, number] = [1.0, 0.82, 0.55];
let lampNoise: Simplex3 | null = null;

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
  const nl = terrain.nightLights;
  const lightMap = nl ? getMap(terrain.maps?.lights) : undefined;
  const hasBiomeGlow = terrain.biomes.some((b) => b.emissive) || !!terrain.water?.emissive;
  const hasEmit = hasBiomeGlow || !!nl;
  // Per vertex biome glow (r, g, b, dayWeighted, weight) and shaped settlement density, clump noise.
  const vglow = hasBiomeGlow ? new Float32Array(V * V * 5) : null;
  const vlamp = nl ? new Float32Array(V * V) : null;
  const vclump = nl ? new Float32Array(V * V) : null;
  const emitTmp = [0, 0, 0, 0, 0];
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
      if (vglow) emitTmp.fill(0);
      const col = biomeColor(terrain, sample, slope, detail, vglow ? emitTmp : undefined);
      if (vglow) for (let q = 0; q < 5; q++) vglow[k * 5 + q] = emitTmp[q]!;
      if (vlamp && vclump && !sample.water) {
        const raw = lightMap ? sampleMap(lightMap, sample.lat, Math.atan2(-sample.z, sample.x)) * (nl!.density ?? 1) : (nl!.density ?? 0);
        const d = smoothstep(0.08, 0.85, raw);
        vlamp[k] = d;
        if (d > 0.01) {
          lampNoise ??= new Simplex3(9137);
          const n = 0.6 * lampNoise.noise(sample.x * (R / 700), sample.y * (R / 700), sample.z * (R / 700)) + 0.4 * lampNoise.noise(sample.x * (R / 3000) + 5, sample.y * (R / 3000), sample.z * (R / 3000));
          vclump[k] = smoothstep(-0.35, 0.35, n);
        }
      }
      vcol[k * 3] = col[0];
      vcol[k * 3 + 1] = col[1];
      vcol[k * 3 + 2] = col[2];
    }
  }

  const cells = G * G;
  const tris = cells * 2 + 4 * G * 2;
  const positions = new Float32Array(tris * 9);
  const colors = new Float32Array(tris * 9);
  const water = new Float32Array(tris * 9);
  // Signed distance to the coast in foam band widths (water positive), from the vertex lattice: the foam
  // shader needs it, and depth alone says nothing about where the shore is. Far from any coast it
  // is a large number. Coasts across a chunk border are not seen (the lattice stops at the edge).
  const shoreN = new Float32Array(V * V);
  {
    // The foam band is SHORE_BAND meters wide, or two facets on coarse chunks; stored in band widths.
    const cellM = Math.hypot(px[V + 1]! - px[0]!, py[V + 1]! - py[0]!, pz[V + 1]! - pz[0]!) / Math.SQRT2 || cell;
    const band = Math.max(SHORE_BAND, 3 * cellM);
    const reach = Math.min(9, Math.ceil(band / Math.max(cellM, 1)) + 1);
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = i + j * V;
        const w = samples[k]!.water;
        let best = Infinity;
        for (let dj = -reach; dj <= reach; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= V) continue;
          for (let di = -reach; di <= reach; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= V) continue;
            const k2 = ii + jj * V;
            if (samples[k2]!.water === w) continue;
            const d = Math.hypot(px[k2]! - px[k]!, py[k2]! - py[k]!, pz[k2]! - pz[k]!);
            if (d < best) best = d;
          }
        }
        const sign = w ? 1 : -1;
        // Nothing within reach: well past the band.
        // Fine chunks only look 9 facets around, which is far less than a band: without a floor they would read as
        // "near the coast" everywhere and show foam and shallows as a disc of the finest chunks.
        const far = Math.max((reach + 0.5) * cellM, 4 * band);
        const dist = best === Infinity ? far : Math.min(best, far);
        shoreN[k] = (sign * Math.max(0, dist - 0.5 * cellM)) / band;
      }
    }
  }
  const triColor = new Float32Array(cells * 18); // two triangles per cell, 3 vertices, rgb
  const triWater = new Float32Array(cells * 2);
  const triRnd = new Float32Array(cells * 2);
  const triEmit = hasEmit ? new Float32Array(cells * 2 * 12) : null; // per triangle vertex rgb + dayShare
  const emit = hasEmit ? new Float32Array(tris * 12) : undefined;
  const dirAttr = lightMap ? new Float32Array(tris * 12) : undefined;
  // Facet sparkle fades into the smooth density as facets outgrow a single lamp post.
  const sparkle = 1 - smoothstep(500, 2500, cell);

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
      water[t * 9 + q * 3] = triWater[cell * 2 + which]!;
      water[t * 9 + q * 3 + 1] = triRnd[cell * 2 + which]!;
      water[t * 9 + q * 3 + 2] = shoreN[k]!;
      if (dirAttr) {
        dirAttr[t * 12 + q * 4] = dx[k]!;
        dirAttr[t * 12 + q * 4 + 1] = dy[k]!;
        dirAttr[t * 12 + q * 4 + 2] = dz[k]!;
        dirAttr[t * 12 + q * 4 + 3] = 1 - sparkle;
      }
      if (emit && triEmit) {
        const eo = (cell * 2 + which) * 12 + q * 4;
        for (let c = 0; c < 4; c++) emit[t * 12 + q * 4 + c] = triEmit[eo + c]!;
      }
    }
  };

  // Water depth colour is smoothed over a few facets: fine relief in shallows would otherwise tint every
  // facet differently, which only the finest chunks resolve (a disc of zigzag around the ship).
  {
    const src = vcol.slice();
    const R = 3;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const k = i + j * V;
        if (!samples[k]!.water) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dj = -R; dj <= R; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= V) continue;
          for (let di = -R; di <= R; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= V) continue;
            const k2 = ii + jj * V;
            if (!samples[k2]!.water) continue;
            r += src[k2 * 3]!;
            g += src[k2 * 3 + 1]!;
            b += src[k2 * 3 + 2]!;
            n++;
          }
        }
        vcol[k * 3] = r / n;
        vcol[k * 3 + 1] = g / n;
        vcol[k * 3 + 2] = b / n;
      }
    }
  }

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
    // Water stays calm: brightness jitter per facet reads as a zigzag on still seas.
    const kv = isWater ? 1 : 1 + (rnd - 0.5) * 0.14 * facetVar;
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
    if (triEmit) {
      // Biome glow: flat mean over the triangle blended to per vertex on coarse chunks, like colour.
      let fe0 = 0;
      let fe1 = 0;
      let fe2 = 0;
      let fd = 0;
      let fw = 0;
      let lampSum = 0;
      let clumpSum = 0;
      for (let q = 0; q < 3; q++) {
        const k = vs[q]!;
        if (vglow && samples[k]!.water === isWater) {
          fe0 += vglow[k * 5]! / cnt;
          fe1 += vglow[k * 5 + 1]! / cnt;
          fe2 += vglow[k * 5 + 2]! / cnt;
          fd += vglow[k * 5 + 3]! / cnt;
          fw += vglow[k * 5 + 4]! / cnt;
        }
        if (vlamp && vclump) {
          lampSum += vlamp[k]!;
          clumpSum += vclump[k]!;
        }
      }
      // Lamps: a facet is lit with probability equal to the settlement density (and its clump).
      let lit = 0;
      let lampR = 0;
      let lampG = 0;
      let lampB = 0;
      let lampK = 0;
      if (nl && !isWater && lampSum > 0.001) {
        const dTri = lampSum / 3;
        const clumpF = 1 - sparkle + sparkle * (0.03 + 1.7 * (clumpSum / 3));
        const rnd2 = (hashInts(baseSeed, cell, which + 31) & 0xffff) / 65535;
        const white = ((hashInts(baseSeed, cell, which + 53) & 0xff) / 255) < WHITE_LAMP_SHARE;
        const warm = white ? WHITE_LAMP : nl.color;
        const bright = 0.55 + 0.45 * (((hashInts(baseSeed, cell, which + 71) & 0xff) / 255));
        lit = rnd2 < dTri * clumpF * 0.26 ? bright : 0;
        lampR = warm[0];
        lampG = warm[1];
        lampB = warm[2];
        lampK = nl.intensity * 0.55;
      }
      for (let q = 0; q < 3; q++) {
        const k = vs[q]!;
        const m = smooth;
        // Biome glow breaks up per facet on fine chunks (veins and patches, not a flat fill).
        const gm = 1 + sparkle * (0.25 + 1.5 * rnd * rnd - 1);
        let e0 = fe0 * gm;
        let e1 = fe1 * gm;
        let e2 = fe2 * gm;
        let ed = fd;
        let ew = fw;
        if (vglow) {
          e0 += (vglow[k * 5]! - fe0) * m * gm;
          e1 += (vglow[k * 5 + 1]! - fe1) * m * gm;
          e2 += (vglow[k * 5 + 2]! - fe2) * m * gm;
          ed += (vglow[k * 5 + 3]! - fd) * m;
          ew += (vglow[k * 5 + 4]! - fw) * m;
        }
        let cityK = 0;
        if (lampK > 0) {
          // Coarse chunks use the smooth density at half brightness (the average of lit and dark facets).
          // Coarse chunks show the lights map in the shader instead (see `dir`).
          cityK = lit * sparkle * lampK;
          e0 += lampR * cityK;
          e1 += lampG * cityK;
          e2 += lampB * cityK;
        }
        const eo = (cell * 2 + which) * 12 + q * 4;
        triEmit[eo] = e0;
        triEmit[eo + 1] = e1;
        triEmit[eo + 2] = e2;
        // Day share of the total glow: lamps contribute none, biome glow its own share.
        triEmit[eo + 3] = ew + cityK > 1e-6 ? ed / (ew + cityK) : 0;
      }
    }
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

  const setDir = (tri: number, slot: number, k: number): void => {
    dirAttr![tri * 12 + slot * 4] = dx[k]!;
    dirAttr![tri * 12 + slot * 4 + 1] = dy[k]!;
    dirAttr![tri * 12 + slot * 4 + 2] = dz[k]!;
    dirAttr![tri * 12 + slot * 4 + 3] = 1 - sparkle;
  };

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
      if (dirAttr) setDir(t, slot, k);
    };
    const color = (tri: number): void => {
      for (let q = 0; q < 3; q++) {
        colors[tri * 9 + q * 3] = triColor[(cell * 2 + which) * 9]!;
        colors[tri * 9 + q * 3 + 1] = triColor[(cell * 2 + which) * 9 + 1]!;
        colors[tri * 9 + q * 3 + 2] = triColor[(cell * 2 + which) * 9 + 2]!;
        water[tri * 9 + q * 3] = triWater[cell * 2 + which]! + 2;
        water[tri * 9 + q * 3 + 1] = triRnd[cell * 2 + which]!;
        water[tri * 9 + q * 3 + 2] = 100; // skirts: far from any coast
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
    if (dirAttr) {
      setDir(t, 0, a);
      setDir(t, 1, b);
      setDir(t, 2, a);
    }
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

  const props =
    req.props && req.level >= req.props.minLevel
      ? scatterProps(req.def, sampler, {
          face: req.face,
          level: req.level,
          x: req.x,
          y: req.y,
          radius: R,
          gridLevel: req.props.gridLevel,
          center: [cx, cy, cz],
        })
      : [];

  return {
    id: req.id,
    positions,
    colors,
    water,
    emit,
    dir: dirAttr,
    center: [cx, cy, cz],
    minR,
    maxR,
    boundRadius: Math.sqrt(maxDist2),
    props,
  };
}
