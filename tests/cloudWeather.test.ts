import { expect, test } from 'vitest';
import { config } from '../src/core/config';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { cloudCoverage, cloudStructure, cycloneData, MAX_CYCLONES } from '../src/render/clouds/coverage';
import { Universe } from '../src/sim/universe';
import { latLonToDir } from '../src/terrain/api';

const u = new Universe(SOLAR_SYSTEM);
const earth = u.get('earth');
const clouds = earth.def.atmosphere!.clouds!;

function bandMean(latDeg: number): number {
  let sum = 0;
  let n = 0;
  for (let lon = -180; lon < 180; lon += 5) {
    const d = { x: 0, y: 0, z: 0 };
    latLonToDir((latDeg * Math.PI) / 180, (lon * Math.PI) / 180, d);
    sum += cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 0);
    n++;
  }
  return sum / n;
}

test('coverage follows latitude: wet tropics and storm tracks, dry subtropics', () => {
  const itcz = bandMean(0);
  const dry = (bandMean(26) + bandMean(-26)) / 2;
  const storm = (bandMean(54) + bandMean(-54)) / 2;
  expect(itcz).toBeGreaterThan(dry + 0.2);
  expect(storm).toBeGreaterThan(dry + 0.2);
});

test('a cyclone has a clear eye inside a cloud wall', () => {
  const cy = cycloneData();
  const c = { x: cy[0]!, y: cy[1]!, z: cy[2]! };
  const eye = cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, c, 0);
  expect(eye).toBeLessThan(0.7);
  // Ring a little way out: mostly thick.
  const cosR = cy[3]!;
  const ang = Math.acos(cosR) * 0.2;
  let ring = 0;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    // Tangent basis around the centre.
    const ul = Math.hypot(c.x, c.z);
    const ux = -c.z / ul, uz = c.x / ul;
    const vx = c.y * uz, vy = c.z * ux - c.x * uz, vz = -c.y * ux;
    const d = {
      x: c.x * Math.cos(ang) + (ux * Math.cos(a) + vx * Math.sin(a)) * Math.sin(ang),
      y: c.y * Math.cos(ang) + vy * Math.sin(a) * Math.sin(ang),
      z: c.z * Math.cos(ang) + (uz * Math.cos(a) + vz * Math.sin(a)) * Math.sin(ang),
    };
    ring += cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 0);
  }
  expect(ring / 12).toBeGreaterThan(eye);
});

test('cyclone data packs unit directions and switches off past the configured count', () => {
  const was = config.clouds.cyclones;
  config.clouds.cyclones = 1;
  const d = cycloneData();
  config.clouds.cyclones = was;
  expect(d.length).toBe(MAX_CYCLONES * 4);
  for (let i = 0; i < MAX_CYCLONES; i++) expect(Math.hypot(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!)).toBeCloseTo(1, 5);
  expect(d[3]!).toBeLessThan(1);
  expect(d[7]!).toBe(2);
});

test('overcast worlds keep plain noise', () => {
  expect(cloudStructure({ ...clouds, coverage: 0.95 })).toBe(0);
  expect(cloudStructure({ ...clouds, coverage: 0.3 })).toBeCloseTo(config.clouds.structure, 5);
});
