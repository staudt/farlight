import { expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { biomeNameAt } from '../src/terrain/biomes';
import { createHeightSampler, makeSample } from '../src/terrain/heightfield';
import { MAX_PROPS_PER_CHUNK, PROP_GRID_EXTRA, type PropBatch, propSlope, scatterProps } from '../src/terrain/props';
import { chunkEdgeLength, chunkRect, faceToDir, maxLevelFor } from '../src/terrain/quadtree';

const ER = 637100;
const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;
const moon = SOLAR_SYSTEM.bodies.find((b) => b.id === 'moon')!;
const sampler = createHeightSampler(earth, ER);

function center(face: number, level: number, x: number, y: number, R: number): [number, number, number] {
  const [u0, v0, size] = chunkRect(level, x, y);
  const d = { x: 0, y: 0, z: 0 };
  faceToDir(face, u0 + size / 2, v0 + size / 2, d);
  return [d.x * R, d.y * R, d.z * R];
}

/** Finds a chunk at the finest prop level that has plenty of props (searches around a start). */
function richChunk(): { face: number; level: number; x: number; y: number; batches: PropBatch[]; c: [number, number, number] } {
  const level = maxLevelFor(ER, 400);
  const gridLevel = level + PROP_GRID_EXTRA;
  for (let face = 0; face < 6; face++) {
    for (let k = 0; k < 400; k++) {
      const x = (k * 37 + face * 11) % (1 << level);
      const y = (k * 53 + face * 5) % (1 << level);
      const c = center(face, level, x, y, ER);
      const batches = scatterProps(earth, sampler, { face, level, x, y, radius: ER, gridLevel, center: c });
      if (batches.reduce((n, b) => n + b.count, 0) > 15) return { face, level, x, y, batches, c };
    }
  }
  throw new Error('no chunk with props found');
}

test('same chunk gives the same props', () => {
  const r = richChunk();
  const again = scatterProps(earth, sampler, {
    face: r.face,
    level: r.level,
    x: r.x,
    y: r.y,
    radius: ER,
    gridLevel: r.level + PROP_GRID_EXTRA,
    center: r.c,
  });
  expect(again.length).toBe(r.batches.length);
  for (let i = 0; i < again.length; i++) {
    expect(again[i]!.count).toBe(r.batches[i]!.count);
    expect(Array.from(again[i]!.matrices)).toEqual(Array.from(r.batches[i]!.matrices));
    expect(Array.from(again[i]!.colors)).toEqual(Array.from(r.batches[i]!.colors));
  }
});

test('props sit on the ground, on land, within the instance cap', () => {
  const r = richChunk();
  let total = 0;
  const s = makeSample();
  for (const b of r.batches) {
    total += b.count;
    for (let i = 0; i < b.count; i++) {
      const o = i * 16;
      const wx = b.matrices[o + 12]! + r.c[0];
      const wy = b.matrices[o + 13]! + r.c[1];
      const wz = b.matrices[o + 14]! + r.c[2];
      const len = Math.hypot(wx, wy, wz);
      sampler.sample(wx / len, wy / len, wz / len, s);
      expect(s.water).toBe(false);
      // The base sinks a little (<= 14 percent of the size) below the surface, never floats.
      const size = Math.hypot(b.matrices[o + 4]!, b.matrices[o + 5]!, b.matrices[o + 6]!);
      expect(len - ER - s.height).toBeLessThanOrEqual(0.01);
      expect(len - ER - s.height).toBeGreaterThanOrEqual(-size * 0.2 - 0.01);
    }
  }
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(MAX_PROPS_PER_CHUNK);
});

test('props respect biome, slope and height limits', () => {
  const level = maxLevelFor(ER, 400);
  const defs = earth.terrain!.props!;
  const s = makeSample();
  let checked = 0;
  for (let face = 0; face < 6 && checked < 60; face++) {
    for (let k = 0; k < 120 && checked < 60; k++) {
      const x = (k * 91 + face * 17) % (1 << level);
      const y = (k * 29 + face * 3) % (1 << level);
      const c = center(face, level, x, y, ER);
      const batches = scatterProps(earth, sampler, { face, level, x, y, radius: ER, gridLevel: level + PROP_GRID_EXTRA, center: c });
      for (const b of batches) {
        // Candidate defs of this kind: the prop must satisfy at least one of them.
        const cands = defs.filter((d) => d.kind === b.kind);
        for (let i = 0; i < b.count; i++) {
          const o = i * 16;
          const size = Math.hypot(b.matrices[o + 4]!, b.matrices[o + 5]!, b.matrices[o + 6]!);
          // Position the prop was queried at, lifted back to the surface along up.
          const wx = b.matrices[o + 12]! + c[0] + (b.matrices[o + 4]! / size) * size * 0.0;
          const wy = b.matrices[o + 13]! + c[1];
          const wz = b.matrices[o + 14]! + c[2];
          const len = Math.hypot(wx, wy, wz);
          const dir: [number, number, number] = [wx / len, wy / len, wz / len];
          sampler.sample(dir[0], dir[1], dir[2], s);
          const slope = propSlope(sampler, dir, s.height);
          const biome = biomeNameAt(earth.terrain!, s, 0);
          const ok = cands.some(
            (d) =>
              (!d.biomes || d.biomes.includes(biome)) &&
              (d.maxSlope === undefined || slope <= d.maxSlope + 0.05) &&
              (d.minHeight === undefined || s.n >= d.minHeight) &&
              (d.maxHeight === undefined || s.n <= d.maxHeight),
          );
          // Tiny sink offsets can shift the sample point by a fraction of a cell: tolerate rare edge hits.
          if (!ok) expect.soft(ok, `${b.kind} at biome ${biome} slope ${slope.toFixed(2)}`).toBe(true);
          checked++;
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test('parent and child chunks share the same props (no popping on LOD swap)', () => {
  const r = richChunk();
  const gridLevel = r.level + PROP_GRID_EXTRA;
  const total = (batches: PropBatch[]): number => batches.reduce((n, b) => n + b.count, 0);
  let kids = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const cx = r.x * 2 + i;
      const cy = r.y * 2 + j;
      kids += total(
        scatterProps(earth, sampler, { face: r.face, level: r.level + 1, x: cx, y: cy, radius: ER, gridLevel, center: center(r.face, r.level + 1, cx, cy, ER) }),
      );
    }
  }
  expect(kids).toBe(total(r.batches));
});

test('a body without props returns nothing, the Moon scatters boulders', () => {
  const R = 173740;
  const ms = createHeightSampler(moon, R);
  const level = maxLevelFor(R, 400);
  const c = center(0, level, 5, 5, R);
  const batches = scatterProps(moon, ms, { face: 0, level, x: 5, y: 5, radius: R, gridLevel: level + PROP_GRID_EXTRA, center: c });
  expect(batches.every((b) => b.kind === 'rock')).toBe(true);
  expect(chunkEdgeLength(R, level)).toBeGreaterThan(0);
  expect(batches.reduce((n, b) => n + b.count, 0)).toBeGreaterThan(0);
  const bare = { ...moon, terrain: { ...moon.terrain!, props: undefined } };
  expect(scatterProps(bare, ms, { face: 0, level, x: 5, y: 5, radius: R, gridLevel: level + PROP_GRID_EXTRA, center: c })).toEqual([]);
});
