import { mulberry32 } from '../core/rng';
import type { BodyDef, FeatureDef } from './types';
import type { LandmarkWorld } from './landmarkGen';

/** Terrain signature features for generated worlds: rays, lineae, strata, dunes, lava channels. */

function round(x: number, d = 3): number {
  const k = Math.pow(10, d);
  return Math.round(x * k) / k;
}

/**
 * Adds data-driven signature features to a generated rocky body. Uses its own PRNG stream (from
 * the body seed), so it never shifts the draws that shape the rest of the system. Call it before
 * landmark generation so landmarks see the final terrain.
 */
export function addWorldFeatures(def: BodyDef, world: LandmarkWorld | 'living'): void {
  const t = def.terrain;
  if (!t) return;
  const rng = mulberry32((def.seed ^ 0x5eed1e57) >>> 0);
  const range = (a: number, b: number): number => a + (b - a) * rng();
  const at = (): { lat: number; lon: number } => ({ lat: round(Math.asin(range(-0.85, 0.85))), lon: round(range(-Math.PI, Math.PI)) });
  const add: FeatureDef[] = [];

  if (world === 'cratered') {
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      add.push({ kind: 'basin', ...at(), radius: round(range(0.025, 0.09)), height: round(range(0.45, 0.9), 2), rays: round(range(0.5, 1), 2), bands: 2 + Math.floor(rng() * 4) });
    }
  } else if (world === 'ice' || world === 'moonIce') {
    add.push({ kind: 'lineae', lat: 0, lon: 0, radius: 1.5, height: round(range(0.25, 0.4), 2), bands: 4 + Math.floor(rng() * 5) });
    if (rng() < 0.6) add.push({ kind: 'basin', ...at(), radius: round(range(0.04, 0.1)), height: 0.4, rays: round(range(0.3, 0.7), 2), bands: 3 });
  } else if (world === 'desert') {
    // Layered walls on the canyons, and one or two dune fields.
    for (const f of t.features ?? []) if (f.kind === 'canyon' && f.bands === undefined) f.bands = 5 + Math.floor(rng() * 4);
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) add.push({ kind: 'dunes', ...at(), radius: round(range(0.06, 0.12)), height: round(range(0.008, 0.016), 4), bands: 30 + Math.floor(rng() * 20) });
  }

  // Worlds with glowing low ground get glowing channels that wind down into it.
  const lava = t.biomes.some((b) => b.emissive !== undefined && b.maxHeight !== undefined);
  if (lava) {
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) add.push({ kind: 'canyon', ...at(), radius: round(range(0.12, 0.2)), height: round(-range(1.0, 1.25), 2) });
  }

  if (add.length) t.features = [...(t.features ?? []), ...add];
}
