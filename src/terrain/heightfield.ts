import { Simplex3, billow, fbm, ridged, warp3 } from '../core/noise';
import type { BodyDef, CraterDef, FeatureDef, NoiseLayer } from '../data/types';
import { landmarkStamps } from '../data/landmarks';
import { type HeightSampler, dirToLatLon } from './api';
import { getMap, sampleMap, sampleMapSmooth } from './maps';

/** Everything a consumer may want to know about one surface point. */
export interface TerrainSample {
  /** Body fixed unit direction. */
  x: number;
  y: number;
  z: number;
  /** Raw normalized height, roughly -1..1 (below seaLevel for water). */
  n: number;
  /** Surface height in game meters above the base radius (water clamped to sea level). */
  height: number;
  water: boolean;
  /** Water depth in game meters (0 on land). */
  depth: number;
  /** Water depth in normalized height units (0 on land). */
  depthN: number;
  /** 0..1 low frequency moisture. */
  moisture: number;
  /** 0..1 ice mask from the terrain maps (0 without maps). */
  ice: number;
  /** Signed latitude, radians. */
  lat: number;
  /** -1..1 surface tint from features (bright rays, dune crests, dark cracks, strata). 0 elsewhere. */
  tint: number;
}

export function makeSample(): TerrainSample {
  return { x: 0, y: 1, z: 0, n: 0, height: 0, water: false, depth: 0, depthN: 0, moisture: 0.5, ice: 0, lat: 0, tint: 0 };
}

export interface TerrainSampler extends HeightSampler {
  readonly radius: number;
  /** Max relief in meters (amplitude * radius). */
  readonly amplitudeMeters: number;
  readonly hasWater: boolean;
  readonly seaLevel: number;
  sample(x: number, y: number, z: number, out: TerrainSample): TerrainSample;
}

interface CompiledLayer {
  def: NoiseLayer;
  lac: number;
  gain: number;
  ox: number;
  oy: number;
  oz: number;
  mx: number;
  my: number;
  mz: number;
}

interface CraterOctave {
  cell: number;
  prob: number;
  rLo: number;
  rHi: number;
  salt: number;
}

interface CompiledFeature {
  def: FeatureDef;
  cx: number;
  cy: number;
  cz: number;
  ex: number;
  ey: number;
  ez: number;
  nx: number;
  ny: number;
  nz: number;
  /** Chord radius beyond which the feature has no influence on the height. */
  reach: number;
  /** Chord radius beyond which it has no influence on the tint (ejecta rays reach further). */
  tintReach: number;
  /** Covers the whole sphere: no hemisphere cull, no edge fade. */
  global: boolean;
  seed: number;
}

/** Ejecta rays fade out within this many feature radii. */
export const RAY_REACH = 8;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x85ebca6b) ^ Math.imul(d, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}
const INV32 = 1 / 4294967296;

/**
 * Crater cells live on a 3D lattice (seamless across cube faces). A cell holds a crater with
 * some probability; the crater center is a jittered point projected onto the unit sphere.
 * A sample only looks at its own 27 cells per octave, so the cost is O(octaves * 27).
 */
function compileCraters(c: CraterDef): CraterOctave[] {
  const lo = Math.max(1e-4, c.minRadius);
  const hi = Math.max(lo * 1.01, c.maxRadius);
  const octaves = Math.max(1, Math.min(6, Math.ceil(Math.log2(hi / lo))));
  const ratio = Math.pow(hi / lo, 1 / octaves);
  const expo = 1.3;
  const weights: number[] = [];
  let total = 0;
  for (let k = 0; k < octaves; k++) {
    const mid = lo * Math.pow(ratio, k + 0.5);
    const w = Math.pow(mid, -expo);
    weights.push(w);
    total += w;
  }
  const out: CraterOctave[] = [];
  for (let k = 0; k < octaves; k++) {
    const rLo = lo * Math.pow(ratio, k);
    const rHi = rLo * ratio;
    const cell = 2.2 * rHi;
    const count = (c.count * weights[k]!) / total;
    // Accepted band is 0.5*cell thick around the unit sphere (volume 4*pi*0.5*cell).
    const prob = Math.min(1, (count * cell * cell) / (2 * Math.PI));
    out.push({ cell, prob, rLo, rHi, salt: 101 + k * 7919 });
  }
  return out;
}

function compileFeature(def: FeatureDef, seed: number): CompiledFeature {
  const c = Math.cos(def.lat);
  const cx = c * Math.cos(def.lon);
  const cy = Math.sin(def.lat);
  const cz = -c * Math.sin(def.lon);
  // East = Y x c, north = c x east.
  let ex = cz;
  let ey = 0;
  let ez = -cx;
  const el = Math.hypot(ex, ey, ez) || 1;
  ex /= el;
  ey /= el;
  ez /= el;
  const nx = cy * ez - cz * ey;
  const ny = cz * ex - cx * ez;
  const nz = cx * ey - cy * ex;
  const global = def.kind === 'lineae' && def.radius >= 1.4;
  const reach = global ? Infinity : def.radius * 1.3;
  const tintReach = (def.kind === 'crater' || def.kind === 'basin') && (def.rays ?? 0) > 0 ? def.radius * RAY_REACH : reach;
  return { def, cx, cy, cz, ex, ey, ez, nx, ny, nz, reach, tintReach, global, seed };
}

export function createHeightSampler(def: BodyDef, radius: number): TerrainSampler {
  const t = def.terrain;
  const noise = new Simplex3(def.seed * 7919 + 17);
  const detail = new Simplex3(def.seed * 104729 + 3);
  const amplitude = t?.amplitude ?? 0;
  const ampM = amplitude * radius;
  const substellar = t?.biomeAxis === 'substellar';
  const hasWater = !!t && t.seaLevel !== undefined && !!t.water;
  const seaLevel = hasWater ? (t?.seaLevel ?? 0) : -Infinity;
  const seaMeters = hasWater ? seaLevel * ampM : 0;

  const layers: CompiledLayer[] = (t?.layers ?? []).map((l, i) => ({
    def: l,
    lac: l.lacunarity ?? 2,
    gain: l.gain ?? 0.5,
    ox: 11.3 * (i + 1),
    oy: 23.7 * (i + 1),
    oz: 5.1 * (i + 1),
    mx: 91.7 + 3.1 * i,
    my: 47.3 + 5.3 * i,
    mz: 13.9 + 1.7 * i,
  }));
  const craterOcts = t?.craters ? compileCraters(t.craters) : [];
  const craterDef = t?.craters;
  // Landmark stamps come after the authored features, so those keep their seeds.
  const featureDefs: FeatureDef[] = [...(t?.features ?? [])];
  if (t) for (const lm of def.landmarks ?? []) featureDefs.push(...landmarkStamps(lm, t));
  const features = featureDefs.map((f, i) => compileFeature(f, def.seed * 31 + i));
  const w = { x: 0, y: 0, z: 0 };
  const seedMix = def.seed | 0;

  // High frequency layers are faded out over open ocean so the sea does not speckle with tiny
  // islands; they come back on and near land. Only worlds with water do this.
  const hfFrom = 7;

  // Data maps (already loaded when the sampler is created). Missing maps fall back to pure noise.
  const mapDef = t?.maps;
  const landMap = getMap(mapDef?.land);
  const mtnMap = getMap(mapDef?.mountains);
  const desertMap = getMap(mapDef?.deserts);
  const iceMap = getMap(mapDef?.ice);
  const rangeKm = mapDef?.landRangeKm ?? 600;
  const influence = mapDef?.influence ?? 1;

  /** Continent shape from the signed coast distance (km, positive inland). Normalized height. */
  function coastBase(sd: number): number {
    if (sd >= 0) {
      return seaLevel + 0.2 * (1 - Math.exp(-sd / 70)) + 0.12 * smoothstep(0, 900, sd);
    }
    const d = -sd;
    const depth = 0.045 * (1 - Math.exp(-d / 30)) + 0.55 * smoothstep(25, 170, d);
    return seaLevel - depth;
  }

  /** Heightfield when a land map is present: the map gives continents, noise gives local relief. */
  function mapsHeight(x: number, y: number, z: number): number {
    const ll = dirToLatLon(x, y, z);
    let sd = (sampleMapSmooth(landMap!, ll.lat, ll.lon) * 2 - 1) * rangeKm;
    // A small wiggle so coasts are not pixelated close up, a few km only.
    if (sd > -90 && sd < 90) {
      sd += detail.noise(x * 60 + 5, y * 60, z * 60 + 9) * 12 + detail.noise(x * 230, y * 230 + 3, z * 230) * 4;
    }
    const base = coastBase(sd);
    // Local relief only inland; it fades out to the coast so the SDF decides where the shore is.
    const lf = smoothstep(-20, 70, sd);
    const mtn = mtnMap ? sampleMapSmooth(mtnMap, ll.lat, ll.lon) : 0;
    let sum = 0;
    if (lf > 0) {
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i]!;
        let v = layerValue(L, x, y, z);
        if (mtnMap && L.def.type === 'ridged') v *= 0.12 + 1.0 * mtn;
        sum += v;
      }
      sum *= lf;
    }
    return base + sum + mtn * lf * 0.34;
  }

  function layerValue(L: CompiledLayer, x: number, y: number, z: number): number {
    const d = L.def;
    let px = x * d.frequency + L.ox;
    let py = y * d.frequency + L.oy;
    let pz = z * d.frequency + L.oz;
    let m = 1;
    if (d.mask) {
      const mv = noise.noise(x * d.mask.frequency + L.mx, y * d.mask.frequency + L.my, z * d.mask.frequency + L.mz);
      m = smoothstep(d.mask.threshold, d.mask.threshold + 0.3, mv);
      if (m <= 0) return 0;
    }
    if (d.warp) {
      warp3(noise, px, py, pz, d.warp, w);
      px = w.x;
      py = w.y;
      pz = w.z;
    }
    let v =
      d.type === 'fbm'
        ? fbm(noise, px, py, pz, d.octaves, L.lac, L.gain)
        : d.type === 'ridged'
          ? ridged(noise, px, py, pz, d.octaves, L.lac, L.gain)
          : billow(noise, px, py, pz, d.octaves, L.lac, L.gain);
    if (d.terraces) {
      // Flat treads with steep risers: the layer value is quantised, each step eased near its top.
      const sv = v * d.terraces;
      const fl = Math.floor(sv);
      v = (fl + smoothstep(0.8, 1, sv - fl)) / d.terraces;
    }
    return v * d.amplitude * m;
  }

  function layersHeight(x: number, y: number, z: number): number {
    let sum = 0;
    if (!hasWater) {
      for (let i = 0; i < layers.length; i++) sum += layerValue(layers[i]!, x, y, z);
      return sum;
    }
    for (let i = 0; i < layers.length; i++) {
      if (layers[i]!.def.frequency < hfFrom) sum += layerValue(layers[i]!, x, y, z);
    }
    const land = smoothstep(seaLevel - 0.12, seaLevel + 0.12, sum);
    if (land <= 0) return sum;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i]!.def.frequency >= hfFrom) sum += layerValue(layers[i]!, x, y, z) * land;
    }
    return sum;
  }

  function cratersHeight(x: number, y: number, z: number): number {
    if (!craterDef) return 0;
    let sum = 0;
    for (let o = 0; o < craterOcts.length; o++) {
      const oc = craterOcts[o]!;
      const s = oc.cell;
      const ix = Math.floor(x / s);
      const iy = Math.floor(y / s);
      const iz = Math.floor(z / s);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const cx = ix + dx;
            const cy = iy + dy;
            const cz = iz + dz;
            const h0 = hash4(cx, cy, cz, oc.salt + seedMix);
            if (h0 * INV32 >= oc.prob) continue;
            const h1 = hash4(cx, cy, cz, oc.salt + 1);
            const h2 = hash4(cx, cy, cz, oc.salt + 2);
            const h3 = hash4(cx, cy, cz, oc.salt + 3);
            const px = (cx + h1 * INV32) * s;
            const py = (cy + h2 * INV32) * s;
            const pz = (cz + h3 * INV32) * s;
            const len = Math.hypot(px, py, pz);
            if (Math.abs(len - 1) > 0.25 * s) continue;
            const qx = px / len - x;
            const qy = py / len - y;
            const qz = pz / len - z;
            const h4 = hash4(cx, cy, cz, oc.salt + 4);
            const r = oc.rLo * Math.pow(oc.rHi / oc.rLo, h4 * INV32);
            const d2 = qx * qx + qy * qy + qz * qz;
            const reach = r * 1.5;
            if (d2 > reach * reach) continue;
            const tt = Math.sqrt(d2) / r;
            const h5 = hash4(cx, cy, cz, oc.salt + 5) * INV32;
            const depthN = (craterDef.depth * r * (0.6 + 0.4 * h5)) / amplitude;
            const rimN = (craterDef.rimHeight * r * (0.6 + 0.4 * h5)) / amplitude;
            const bowl = -depthN * (1 - smoothstep(0.35, 1.0, tt));
            const rd = (tt - 1) / 0.22;
            sum += bowl + rimN * Math.exp(-rd * rd);
          }
        }
      }
    }
    return sum;
  }

  /** Tint accumulated by the last featuresHeight call (read by sample()). */
  let tintAcc = 0;

  /** Bright rays thrown out from a crater or basin: radial streaks that fade with distance. */
  function rayTint(f: CompiledFeature, x: number, y: number, z: number, tt: number): number {
    const rays = f.def.rays ?? 0;
    if (rays <= 0) return 0;
    const a = x * f.ex + y * f.ey + z * f.ez;
    const b = x * f.nx + y * f.ny + z * f.nz;
    const len = Math.hypot(a, b) || 1;
    const ca = a / len;
    const sa = b / len;
    const k = f.seed * 0.37;
    const n1 = detail.noise(ca * 2.6 + k, sa * 2.6, k * 0.5);
    const n2 = detail.noise(ca * 7.5 + k, sa * 7.5 + 3, 1.7);
    const streak = Math.min(1, Math.max(0, (n1 * 0.7 + n2 * 0.55) * 1.7));
    const fall = tt < 1 ? 0.5 * smoothstep(0.2, 1, tt) : Math.exp(-(tt - 1) * 0.45);
    // The bright ejecta apron hugs the rim, the rays carry on beyond it.
    const apron = tt > 0.85 ? Math.exp(-Math.pow((tt - 1.0) / 0.45, 2)) * 0.45 : 0;
    const inner = tt < 0.9 ? 0.4 * (1 - smoothstep(0.5, 0.9, tt)) : 0;
    return rays * Math.min(1, apron + inner + streak * streak * fall);
  }

  function featuresHeight(x: number, y: number, z: number): number {
    let sum = 0;
    tintAcc = 0;
    for (let i = 0; i < features.length; i++) {
      const f = features[i]!;
      const dot = x * f.cx + y * f.cy + z * f.cz;
      if (dot <= 0 && !f.global) continue;
      const dx = x - f.cx;
      const dy = y - f.cy;
      const dz = z - f.cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > f.reach) {
        if (dist <= f.tintReach) tintAcc += rayTint(f, x, y, z, dist / f.def.radius);
        continue;
      }
      const rad = f.def.radius;
      const tt = dist / rad;
      const ht = f.def.height;
      switch (f.def.kind) {
        case 'volcano': {
          if (tt >= 1) break;
          const rimT = 0.12;
          const cone = ht * Math.pow(1 - Math.max(tt, rimT), 1.5);
          sum += tt < rimT ? cone - ht * 0.35 * (1 - smoothstep(0, rimT, tt)) : cone;
          break;
        }
        case 'mesa': {
          sum += ht * smoothstep(1.0, 0.78, tt);
          break;
        }
        case 'spires': {
          if (tt >= 1) break;
          const fade = smoothstep(1, 0.5, tt);
          const k = 0.45 / rad;
          const r = ridged(detail, x * k + f.seed, y * k, z * k, 2);
          sum += ht * fade * Math.pow(Math.max(0, r - 0.45) * 1.8, 1.6);
          break;
        }
        case 'crater': {
          const depth = Math.abs(ht);
          const bowl = -depth * (1 - smoothstep(0.35, 1.0, tt));
          const rd = (tt - 1) / 0.22;
          sum += bowl + depth * 0.22 * Math.exp(-rd * rd);
          tintAcc += rayTint(f, x, y, z, tt);
          break;
        }
        case 'basin': {
          // Flat floor, a terraced wall, a raised rim and a central peak; rays carry on outside.
          const d = Math.abs(ht);
          const steps = f.def.bands ?? 3;
          const u = smoothstep(0.35, 1.0, tt);
          let uq = u;
          if (steps > 0) {
            const sv = u * steps;
            const fl = Math.floor(sv);
            uq = u * 0.3 + 0.7 * ((fl + smoothstep(0.55, 1, sv - fl)) / steps);
          }
          const rd = (tt - 1) / 0.1;
          const pk = Math.max(0, 1 - tt / 0.16);
          let hh = -d * (1 - uq) + d * 0.3 * Math.exp(-rd * rd) + d * 0.75 * pk * pk;
          if (steps >= 4) {
            // Multi ring basin: low concentric ridges on the floor.
            const r1 = (tt - 0.52) / 0.035;
            const r2 = (tt - 0.74) / 0.035;
            hh += d * 0.16 * (Math.exp(-r1 * r1) + Math.exp(-r2 * r2));
          }
          if (tt > 1) hh += d * 0.06 * (1 - smoothstep(1, 1.35, tt));
          sum += hh;
          tintAcc += rayTint(f, x, y, z, tt);
          break;
        }
        case 'lineae': {
          const fade = f.global ? 1 : smoothstep(1, 0.7, tt);
          if (fade <= 0) break;
          const d = Math.abs(ht);
          const dens = f.def.bands ?? 6;
          const scale = f.global ? 1 : 0.8 / rad;
          const k1 = dens * 2 * scale;
          const k2 = dens * 6 * scale;
          const sd = f.seed * 0.113;
          const bend = detail.noise(x * k1 * 0.5 + sd, y * k1 * 0.5, z * k1 * 0.5) * 0.18;
          const m1 = Math.abs(detail.noise(x * k1 + sd + bend, y * k1 + bend, z * k1 + 7.7)) ;
          const m2 = Math.abs(detail.noise(x * k2 + sd, y * k2 + 3.1, z * k2 + bend * 3));
          const g1 = 1 - smoothstep(0, 0.05, m1);
          const f1 = smoothstep(0.05, 0.1, m1) * (1 - smoothstep(0.1, 0.22, m1));
          const g2 = 1 - smoothstep(0, 0.08, m2);
          const f2 = smoothstep(0.08, 0.14, m2) * (1 - smoothstep(0.14, 0.3, m2));
          sum += d * fade * (f1 * 0.45 - g1 + (f2 * 0.45 - g2) * 0.4);
          tintAcc -= fade * Math.min(1, g1 * 0.9 + g2 * 0.5 + f1 * 0.2);
          break;
        }
        case 'dunes': {
          if (tt >= 1) break;
          const fade = smoothstep(1, 0.6, tt);
          const a = x * f.ex + y * f.ey + z * f.ez;
          const b = x * f.nx + y * f.ny + z * f.nz;
          const wind = f.seed * 0.7;
          const crests = f.def.bands ?? 40;
          const kk = 3 / rad;
          const sw = detail.noise(x * kk + f.seed, y * kk, z * kk) * 1.6 + detail.noise(x * kk * 4, y * kk * 4 + f.seed, z * kk * 4) * 0.35;
          const patch = smoothstep(-0.25, 0.35, detail.noise(x * kk * 0.6 + 9, y * kk * 0.6 + f.seed, z * kk * 0.6));
          const sv = ((a * Math.cos(wind) + b * Math.sin(wind)) / rad) * crests * 0.5 + sw;
          const fr = sv - Math.floor(sv);
          // Long gentle windward slope, short slip face, a sharpened crest.
          let prof = fr < 0.78 ? fr / 0.78 : (1 - fr) / 0.22;
          prof = prof * prof * (3 - 2 * prof);
          sum += Math.abs(ht) * fade * patch * prof;
          tintAcc += (prof - 0.45) * 0.45 * fade * patch;
          break;
        }
        case 'plain': {
          // A broad smooth basin with a steep rim; overlapping plains merge into one shape.
          sum -= Math.abs(ht) * smoothstep(1.0, 0.6, tt);
          break;
        }
        case 'cliff': {
          // A step along the east axis: raised ground to the south, a sheer face at b = 0.
          const a = x * f.ex + y * f.ey + z * f.ez;
          const b = x * f.nx + y * f.ny + z * f.nz;
          const along = Math.abs(a / rad);
          if (along > 1) break;
          const w = rad * 0.02;
          const step = smoothstep(w, -w, b);
          const fadeB = b < 0 ? smoothstep(1.0, 0.45, -b / rad) : 1;
          sum += ht * step * fadeB * smoothstep(1.0, 0.6, along);
          break;
        }
        case 'canyon': {
          const a = x * f.ex + y * f.ey + z * f.ez;
          const b = x * f.nx + y * f.ny + z * f.nz;
          const along = a / rad;
          if (along < -1 || along > 1) break;
          const wob = Math.sin(along * 4.2 + f.seed) * 0.22 * rad + Math.sin(along * 9.7 + f.seed * 2) * 0.06 * rad;
          const across = Math.abs(b - wob);
          const width = rad * (0.07 + 0.03 * Math.sin(along * 6 + f.seed));
          const wall = smoothstep(width * 2.2, width * 0.6, across);
          const end = smoothstep(1, 0.7, Math.abs(along));
          const bands = f.def.bands ?? 0;
          if (bands > 0) {
            // Layered walls: the depth profile steps, and each layer gets its own shade.
            const sv = wall * bands;
            const fl = Math.floor(sv);
            const wq = (fl + smoothstep(0.7, 1, sv - fl)) / bands;
            sum -= Math.abs(ht) * (wall * 0.4 + wq * 0.6) * end;
            const tone = (hash4(fl, Math.floor(f.seed), 5, 77) * INV32 - 0.5) * 0.7;
            tintAcc += tone * smoothstep(0.04, 0.2, wall) * smoothstep(1, 0.85, wall) * end;
          } else sum -= Math.abs(ht) * wall * end;
          break;
        }
      }
    }
    return sum;
  }

  const rawN = (x: number, y: number, z: number): number => {
    const extra = cratersHeight(x, y, z) + featuresHeight(x, y, z);
    if (!landMap) return layersHeight(x, y, z) + extra;
    const m = mapsHeight(x, y, z);
    return (influence < 1 ? layersHeight(x, y, z) * (1 - influence) + m * influence : m) + extra;
  };

  return {
    radius,
    amplitudeMeters: ampM,
    hasWater,
    seaLevel: hasWater ? seaLevel : 0,
    heightAt(x, y, z) {
      if (!t) return 0;
      const n = rawN(x, y, z);
      if (hasWater && n < seaLevel) return seaMeters;
      return n * ampM;
    },
    sample(x, y, z, out) {
      out.x = x;
      out.y = y;
      out.z = z;
      // Eyeball worlds measure "latitude" from the sub-stellar point (+X): 0 there, pi/4 at the
      // terminator, pi/2 on the anti-stellar side. Linear in x, so the bands stay evenly wide.
      out.lat = substellar ? (Math.PI / 4) * (1 - Math.max(-1, Math.min(1, x))) : Math.asin(Math.max(-1, Math.min(1, y)));
      if (!t) {
        out.n = out.height = out.depth = out.depthN = 0;
        out.water = false;
        out.moisture = 0.5;
        out.ice = 0;
        out.tint = 0;
        return out;
      }
      const n = rawN(x, y, z);
      out.n = n;
      if (hasWater && n < seaLevel) {
        out.water = true;
        out.height = seaMeters;
        out.depthN = seaLevel - n;
        out.depth = out.depthN * ampM;
      } else {
        out.water = false;
        out.height = n * ampM;
        out.depthN = 0;
        out.depth = 0;
      }
      let moist = 0.5 + 0.5 * fbm(detail, x * 2.6 + 40, y * 2.6 + 40, z * 2.6 + 40, 3);
      out.ice = 0;
      if (desertMap || iceMap) {
        const ll = dirToLatLon(x, y, z);
        if (desertMap) {
          const d = Math.min(1, sampleMap(desertMap, ll.lat, ll.lon) * 1.3);
          moist = moist * (1 - d) + 0.04 * d;
        }
        if (iceMap) out.ice = sampleMap(iceMap, ll.lat, ll.lon);
      }
      out.moisture = moist;
      out.tint = Math.max(-1, Math.min(1, tintAcc));
      return out;
    },
  };
}
