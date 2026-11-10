import { readFileSync } from 'node:fs';
import { beforeAll, expect, test } from 'vitest';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { latLonToDir } from '../src/terrain/api';
import { buildChunk } from '../src/terrain/chunkBuild';
import { registerMap } from '../src/terrain/maps';
import { chunkRect, faceToDir } from '../src/terrain/quadtree';

const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;
const ER = 637100;
const D = Math.PI / 180;

beforeAll(() => {
  for (const url of Object.values(earth.terrain!.maps!)) {
    if (typeof url !== 'string') continue;
    const b = readFileSync(new URL(`../public/${url}`, import.meta.url));
    registerMap(url, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
});

/** Chunk address at `level` whose centre is nearest the direction (descends the quadtree). */
function chunkAt(lat: number, lon: number, level: number): { face: number; x: number; y: number } {
  const d = { x: 0, y: 0, z: 0 };
  latLonToDir(lat * D, lon * D, d);
  const c = { x: 0, y: 0, z: 0 };
  const dist = (face: number, lv: number, x: number, y: number): number => {
    const [u0, v0, s] = chunkRect(lv, x, y);
    faceToDir(face, u0 + s / 2, v0 + s / 2, c);
    return Math.hypot(c.x - d.x, c.y - d.y, c.z - d.z);
  };
  let best = { face: 0, x: 0, y: 0, d: Infinity };
  for (let f = 0; f < 6; f++) {
    const dd = dist(f, 0, 0, 0);
    if (dd < best.d) best = { face: f, x: 0, y: 0, d: dd };
  }
  for (let lv = 1; lv <= level; lv++) {
    let next = { ...best, d: Infinity };
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const x = best.x * 2 + i;
        const y = best.y * 2 + j;
        const dd = dist(best.face, lv, x, y);
        if (dd < next.d) next = { face: best.face, x, y, d: dd };
      }
    }
    best = next;
  }
  return best;
}

function emitSum(lat: number, lon: number): number {
  const a = chunkAt(lat, lon, 9);
  const r = buildChunk({ id: 1, bodyId: 'earth', def: earth, radius: ER, face: a.face, level: 9, x: a.x, y: a.y, grid: 16 });
  let s = 0;
  for (let i = 0; i < r.emit!.length; i += 4) s += r.emit![i]! + r.emit![i + 1]! + r.emit![i + 2]!;
  return s;
}

test('Earth chunks carry lamp light over cities and none over empty ocean', () => {
  expect(emitSum(51.5, -0.12)).toBeGreaterThan(5); // London
  expect(emitSum(0, -150)).toBe(0); // mid Pacific
});

test('generated worlds are deterministic, lava worlds glow, some alien worlds are bioluminescent', () => {
  const galaxy = createGalaxy();
  let lava = 0;
  let glowing = 0;
  for (const star of galaxy.stars.slice(0, 120)) {
    const a = generateSystem(star);
    const b = generateSystem(star);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const body of a.bodies) {
      const t = body.terrain;
      if (!t) continue;
      if (t.biomes.some((x) => x.name === 'lava channel')) {
        lava++;
        expect(t.biomes.find((x) => x.name === 'lava channel')!.emissive).toBeDefined();
      }
      if (t.props?.some((p) => (p.glow ?? 0) > 0)) glowing++;
    }
  }
  expect(lava).toBeGreaterThan(0);
  expect(glowing).toBeGreaterThan(0);
});
