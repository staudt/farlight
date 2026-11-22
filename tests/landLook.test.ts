import { expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { DEFAULT_LOOK, occlusion, rockAmount, rockColor, snowiness, strataBand } from '../src/terrain/biomes';
import { buildChunk } from '../src/terrain/chunkBuild';

const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;

test('rock appears only on steep faces and snow is detected by colour', () => {
  expect(rockAmount(0.2, 0.7)).toBe(0);
  expect(rockAmount(2, 0.7)).toBe(1);
  expect(snowiness(0.9, 0.92, 0.95)).toBeGreaterThan(0.9);
  expect(snowiness(0.12, 0.4, 0.06)).toBe(0);
  expect(snowiness(0.8, 0.52, 0.2)).toBe(0);
});

test('rock is darker than the ground it replaces and keeps some of its hue', () => {
  const g = rockColor(0.2, 0.5, 0.1);
  expect(g[1]).toBeLessThan(0.5);
  const red = rockColor(0.7, 0.35, 0.2);
  expect(red[0]).toBeGreaterThan(red[2]);
});

test('strata are constant inside a layer, change between layers and are deterministic', () => {
  const a = strataBand(103, 10, 0);
  const b = strataBand(108, 10, 0);
  const c = strataBand(115, 10, 0);
  expect(a).toEqual(b);
  expect(c[0]).not.toBeCloseTo(b[0], 3);
  expect(strataBand(103, 10, 0)).toEqual(a);
});

test('occlusion darkens hollows and lights crests', () => {
  expect(occlusion(1, 1, 1)).toBeLessThan(1);
  expect(occlusion(-1, 1, 1)).toBeGreaterThan(1);
  expect(occlusion(0, 1, 1)).toBe(1);
  expect(occlusion(1, 0, 0)).toBe(1);
});

test('baked mist pooling agrees across a chunk border', () => {
  const R = 637100;
  const req = { id: 1, bodyId: 'earth', def: earth, radius: R, face: 0, level: 9, grid: 16, look: DEFAULT_LOOK };
  const a = buildChunk({ ...req, x: 163, y: 243 });
  const b = buildChunk({ ...req, x: 164, y: 243 });
  const key = (c: typeof a, i: number): string => `${Math.round(c.positions[i]! + c.center[0])},${Math.round(c.positions[i + 1]! + c.center[1])},${Math.round(c.positions[i + 2]! + c.center[2])}`;
  const pool = new Map<string, number>();
  for (let t = 0; t < a.positions.length / 3; t++) if (a.water[t * 3]! < 0.5) pool.set(key(a, t * 3), a.water[t * 3 + 1]!);
  let shared = 0;
  for (let t = 0; t < b.positions.length / 3; t++) {
    if (b.water[t * 3]! > 0.5) continue;
    const p = pool.get(key(b, t * 3));
    if (p === undefined) continue;
    shared++;
    expect(b.water[t * 3 + 1]!).toBeCloseTo(p, 2);
  }
  expect(shared).toBeGreaterThan(5);
});
