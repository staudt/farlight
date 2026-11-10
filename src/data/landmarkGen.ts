import { mulberry32 } from '../core/rng';
import { createHeightSampler, makeSample } from '../terrain/heightfield';
import { DESCRIPTIONS, LANDMARK_NOUN } from './landmarks';
import { makeName } from './names';
import type { BodyDef, LandmarkDef, LandmarkKind, RGB } from './types';

// ---------------------------------------------------------------------------------------------
// Generated worlds

export type LandmarkWorld = 'living' | 'desert' | 'lava' | 'ice' | 'toxic' | 'cratered' | 'moonIce' | 'moonVolcanic';

const KINDS: Record<LandmarkWorld, Partial<Record<LandmarkKind, number>>> = {
  living: { arch: 2, waterfall: 3, giantTree: 3, craterLake: 2, ruins: 2, monolith: 1, glowingPool: 1, crystalCanyon: 1 },
  desert: { arch: 3, monolith: 2, canyon: 2, ruins: 2, mesa: 3, geyserField: 1, crystalCanyon: 1 },
  lava: { glowingPool: 3, monolith: 2, crater: 2, geyserField: 2, arch: 1 },
  ice: { iceSpire: 3, geyserField: 2, craterLake: 2, arch: 1, monolith: 1, crystalCanyon: 1 },
  toxic: { glowingPool: 3, monolith: 2, ruins: 2, arch: 2, geyserField: 1 },
  cratered: { crater: 3, monolith: 2, ruins: 1, arch: 1, craterLake: 1 },
  moonIce: { iceSpire: 3, geyserField: 2, monolith: 1 },
  moonVolcanic: { glowingPool: 3, geyserField: 2, monolith: 1 },
};

/** [footprint radius m, height m] ranges per kind. */
const SIZES: Record<LandmarkKind, { r: [number, number]; h: [number, number] }> = {
  arch: { r: [120, 220], h: [90, 170] },
  monolith: { r: [28, 44], h: [240, 420] },
  crystalCanyon: { r: [2500, 4000], h: [150, 300] },
  waterfall: { r: [2000, 3000], h: [160, 320] },
  craterLake: { r: [800, 1600], h: [60, 140] },
  ruins: { r: [160, 260], h: [40, 90] },
  giantTree: { r: [150, 260], h: [350, 600] },
  iceSpire: { r: [600, 1100], h: [200, 450] },
  geyserField: { r: [400, 800], h: [150, 300] },
  glowingPool: { r: [600, 1500], h: [30, 80] },
  canyon: { r: [6000, 10000], h: [300, 700] },
  summit: { r: [60, 60], h: [40, 40] },
  mesa: { r: [600, 1200], h: [200, 400] },
  crater: { r: [1500, 3000], h: [150, 300] },
  lander: { r: [10, 10], h: [8, 8] },
};

const POOL_COLORS: RGB[] = [
  [0.2, 0.95, 0.7],
  [1.0, 0.45, 0.1],
  [0.5, 0.4, 1.0],
  [0.95, 0.25, 0.6],
];
const CRYSTAL_COLORS: RGB[] = [
  [0.35, 0.8, 1.0],
  [0.8, 0.4, 1.0],
  [0.5, 1.0, 0.6],
  [1.0, 0.6, 0.35],
];

function round(x: number, d: number): number {
  const k = Math.pow(10, d);
  return Math.round(x * k) / k;
}

/**
 * 1 to 4 landmarks for a rocky body. Uses its own PRNG stream (from the body seed), so adding
 * landmarks never shifts the draws that shape the rest of the system.
 * `gameRadius` is the body's game radius in meters.
 */
export function generateLandmarks(def: BodyDef, world: LandmarkWorld, gameRadius: number): LandmarkDef[] {
  const terrain = def.terrain;
  if (!terrain) return [];
  const rng = mulberry32((def.seed ^ 0x1a2d3c4b) >>> 0);
  const range = (a: number, b: number): number => a + (b - a) * rng();
  const moon = world === 'moonIce' || world === 'moonVolcanic';
  const count = moon ? 1 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 4);
  const table = { ...KINDS[world] };
  const sampler = createHeightSampler(def, gameRadius);
  const probe = makeSample();
  const out: LandmarkDef[] = [];
  const dirs: [number, number, number][] = [];
  const taken = new Set<string>();

  for (let n = 0; n < count; n++) {
    // Weighted kind pick without repeats.
    let total = 0;
    for (const [k, w] of Object.entries(table)) if (!taken.has(k)) total += w ?? 0;
    if (total <= 0) break;
    let x = rng() * total;
    let kind: LandmarkKind = 'monolith';
    for (const [k, w] of Object.entries(table) as [LandmarkKind, number][]) {
      if (taken.has(k)) continue;
      x -= w;
      if (x <= 0) {
        kind = k;
        break;
      }
    }
    taken.add(kind);

    const size = SIZES[kind];
    const rM = Math.min(range(size.r[0], size.r[1]), gameRadius * 0.05);
    const hM = Math.min(range(size.h[0], size.h[1]), terrain.amplitude * gameRadius * 0.9 + 80);

    // Dry, gentle ground at least a quarter radian from the others.
    let best: { lat: number; lon: number; score: number } | null = null;
    for (let tries = 0; tries < 24; tries++) {
      const lat = Math.asin(range(-0.9, 0.9));
      const lon = range(-Math.PI, Math.PI);
      const c = Math.cos(lat);
      const dx = c * Math.cos(lon);
      const dy = Math.sin(lat);
      const dz = -c * Math.sin(lon);
      if (dirs.some((d) => d[0] * dx + d[1] * dy + d[2] * dz > 0.97)) continue;
      const span = rM / gameRadius;
      let wet = false;
      let lo = Infinity;
      let hi = -Infinity;
      const ex = -Math.sin(lon);
      const ez = -Math.cos(lon);
      const nx = -Math.sin(lat) * Math.cos(lon);
      const ny = Math.cos(lat);
      const nz = Math.sin(lat) * Math.sin(lon);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const k = i === 0 ? 0 : span * 1.5;
        const ce = Math.cos(a) * k;
        const cn = Math.sin(a) * k;
        const lx = dx + ce * ex + cn * nx;
        const ly = dy + cn * ny;
        const lz = dz + ce * ez + cn * nz;
        const l = Math.hypot(lx, ly, lz);
        sampler.sample(lx / l, ly / l, lz / l, probe);
        if (probe.water) wet = true;
        lo = Math.min(lo, probe.height);
        hi = Math.max(hi, probe.height);
      }
      if (wet) continue;
      const score = -(hi - lo) / Math.max(30, rM) + rng() * 0.05;
      if (!best || score > best.score) best = { lat, lon, score };
      if ((hi - lo) / Math.max(30, rM) < 0.25) break;
    }
    if (!best) continue;
    dirs.push([Math.cos(best.lat) * Math.cos(best.lon), Math.sin(best.lat), -Math.cos(best.lat) * Math.sin(best.lon)]);

    const lm: LandmarkDef = {
      id: `${kind.toLowerCase()}${n + 1}`,
      name: `The ${makeName(rng)} ${LANDMARK_NOUN[kind]}`,
      kind,
      lat: round(best.lat, 4),
      lon: round(best.lon, 4),
      radius: round(rM / gameRadius, 5),
      height: round(hM / gameRadius, 5),
      description: DESCRIPTIONS[kind][Math.floor(rng() * DESCRIPTIONS[kind].length)]!,
    };
    if (kind === 'glowingPool') lm.color = POOL_COLORS[Math.floor(rng() * POOL_COLORS.length)]!;
    if (kind === 'crystalCanyon') lm.color = CRYSTAL_COLORS[Math.floor(rng() * CRYSTAL_COLORS.length)]!;
    if (kind === 'craterLake' && (world === 'ice' || world === 'cratered')) lm.color = [0.55, 0.75, 0.9];
    out.push(lm);
  }
  return out;
}
