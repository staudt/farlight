import { expect, test } from 'vitest';
import { Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { cloudCoverage } from '../src/render/clouds/coverage';
import { weatherAmount } from '../src/render/weather/weatherMap';
import { Universe } from '../src/sim/universe';
import { latLonToDir } from '../src/terrain/api';

const u = new Universe(SOLAR_SYSTEM);
const earth = u.get('earth');
const clouds = earth.def.atmosphere!.clouds!;
const rain = earth.def.atmosphere!.weather!.find((w) => w.kind === 'rain')!;

function sampleDirs(n: number): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const lat = Math.asin(((i * 0.618034) % 1) * 1.6 - 0.8);
    const lon = ((i * 0.7548776) % 1) * Math.PI * 2;
    const d = new Vector3();
    latLonToDir(lat, lon, d);
    out.push(d);
  }
  return out;
}

test('cloud coverage is deterministic and within 0..1', () => {
  for (const d of sampleDirs(200)) {
    const a = cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 1234);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
    expect(cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 1234)).toBe(a);
  }
});

test('rain falls on a minority of the tropics, not everywhere and not nowhere', () => {
  const dirs = sampleDirs(2000);
  const raining = dirs.filter((d) => weatherAmount(rain, d, 5000, earth) > 0.2).length / dirs.length;
  expect(raining).toBeGreaterThan(0.02);
  expect(raining).toBeLessThan(0.35);
});

test('weather moves with time', () => {
  const dirs = sampleDirs(500);
  const t0 = dirs.map((d) => cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 0));
  const t1 = dirs.map((d) => cloudCoverage(clouds, earth.radius, earth.atmosphereHeight, d, 6 * 3600));
  const changed = t0.filter((v, i) => Math.abs(v - t1[i]!) > 0.05).length;
  expect(changed).toBeGreaterThan(dirs.length * 0.3);
});
