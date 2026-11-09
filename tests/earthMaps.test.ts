import { readFileSync } from 'node:fs';
import { beforeAll, expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { latLonToDir } from '../src/terrain/api';
import { createHeightSampler, makeSample } from '../src/terrain/heightfield';
import { registerMap } from '../src/terrain/maps';

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

function at(lat: number, lon: number) {
  const s = createHeightSampler(earth, ER);
  const d = { x: 0, y: 0, z: 0 };
  latLonToDir(lat * D, lon * D, d);
  return s.sample(d.x, d.y, d.z, makeSample());
}

test('known land and sea points (orientation not mirrored)', () => {
  expect(at(23, 13).water).toBe(false); // Sahara
  expect(at(23, 13).moisture).toBeLessThan(0.2);
  expect(at(-10, -55).water).toBe(false); // Brazil
  expect(at(-25, 134).water).toBe(false); // Australia
  expect(at(0, -150).water).toBe(true); // mid Pacific
  expect(at(-30, -30).water).toBe(true); // south Atlantic
  expect(at(35, 138).water).toBe(false); // Japan, east of China
  expect(at(34, 112).water).toBe(false); // China
  expect(at(0, 20).water).toBe(false); // Africa
  expect(at(0, -20).water).toBe(true); // Atlantic between
  expect(at(72, -40).ice).toBeGreaterThan(0.5); // Greenland
  expect(at(-80, 0).ice).toBeGreaterThan(0.5); // Antarctica
  expect(at(28, 85).n).toBeGreaterThan(at(20, 78).n + 0.2); // Himalaya well above the Deccan
});

test('two samplers give identical heights (worker equals main)', () => {
  const a = createHeightSampler(earth, ER);
  const b = createHeightSampler(earth, ER);
  for (let i = 0; i < 100; i++) {
    const d = { x: 0, y: 0, z: 0 };
    latLonToDir(((i * 7.3) % 150) * D - 75 * D, i * 0.37, d);
    expect(a.heightAt(d.x, d.y, d.z)).toBe(b.heightAt(d.x, d.y, d.z));
  }
});
