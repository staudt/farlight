import type { RingDef, RingGap } from '../../../data/types';

/** Gap slots in the shader uniform array (vec3 each: centre, half width, depth). */
export const MAX_RING_GAPS = 8;

function mulberry(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The gaps of a ring: the authored list, or a derived Cassini-like division plus a few thin
 * gaps, a pure function of the body seed (its own PRNG, so no generator stream shifts).
 */
export function ringGaps(def: Pick<RingDef, 'gaps'> | undefined, seed: number): RingGap[] {
  if (def?.gaps) return def.gaps.slice(0, MAX_RING_GAPS);
  const r = mulberry(seed * 7919 + 13);
  const gaps: RingGap[] = [{ at: 0.55 + r() * 0.25, width: 0.045 + r() * 0.05, depth: 0.85 + r() * 0.1 }];
  const thin = 2 + Math.floor(r() * 3);
  for (let i = 0; i < thin; i++) gaps.push({ at: 0.12 + r() * 0.86, width: 0.005 + r() * 0.012, depth: 0.5 + r() * 0.4 });
  return gaps;
}

/** Packs gaps into flat [at, halfWidth, depth] triples, zero padded to MAX_RING_GAPS. */
export function packGaps(gaps: RingGap[]): number[] {
  const out = new Array<number>(MAX_RING_GAPS * 3).fill(0);
  gaps.slice(0, MAX_RING_GAPS).forEach((g, i) => {
    out[i * 3] = g.at;
    out[i * 3 + 1] = Math.max(1e-4, g.width * 0.5);
    out[i * 3 + 2] = Math.min(1, Math.max(0, g.depth));
  });
  return out;
}

/** Spoke strength: authored, else a faint default for dense bright rings only. */
export function ringSpokes(def: Pick<RingDef, 'spokes' | 'opacity'> | undefined): number {
  if (!def) return 0;
  return def.spokes ?? (def.opacity > 0.6 ? 0.25 : 0);
}

/** One size class of ring rocks: a grid cell holds at most one rock of this class. */
export interface DebrisClass {
  /** Grid cell size in metres. */
  cell: number;
  /** Rock radius range in metres (before the size scale). */
  minSize: number;
  maxSize: number;
  /** Fill probability multiplier at ring density 1. */
  fill: number;
  /** Stacked cell layers (each layer is its own grid of rocks, at its own random heights). */
  layers: number;
}

/** Pebble to house scale. Instances per class are `grid * grid`; draw range is about `grid * cell / 2`. */
export const DEBRIS_CLASSES: readonly DebrisClass[] = [
  { cell: 5, minSize: 0.15, maxSize: 0.6, fill: 0.9, layers: 3 },
  { cell: 16, minSize: 0.7, maxSize: 2.6, fill: 0.9, layers: 3 },
  { cell: 55, minSize: 3, maxSize: 11, fill: 0.85, layers: 4 },
  { cell: 190, minSize: 12, maxSize: 42, fill: 0.6, layers: 4 },
];

/** Grid width per class for a quality level (0 = off, 1 = sparse, 2 = full). */
export function debrisGrid(level: number, classIndex: number): number {
  if (level <= 0) return 0;
  if (level === 1) return classIndex === 0 ? 0 : 14;
  return 22;
}

/** Distance (m) beyond which a class is fully faded out. */
export function debrisRange(grid: number, cell: number, rangeScale = 1): number {
  return (grid * cell * 0.5 - cell) * rangeScale;
}

/**
 * Flat disc opacity multiplier near the camera: 1 far away, falling to 0 inside the rock field
 * when the camera is within `fadeHeight` layer thicknesses of the plane, so rocks replace the disc.
 * `horiz` and `height` in metres.
 */
export function discFade(horiz: number, height: number, thickness: number, fadeHeight: number, near: number, far: number): number {
  const h = Math.abs(height) / Math.max(thickness, 1);
  const prox = 1 - smooth(fadeHeight * 0.5, fadeHeight, h);
  const d = Math.hypot(horiz, height);
  const away = smooth(near, Math.max(far, near + 1), d);
  return 1 - prox * (1 - away);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
