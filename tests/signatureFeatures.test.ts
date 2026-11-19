import { expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { RAY_REACH, createHeightSampler, makeSample } from '../src/terrain/heightfield';
import type { BodyDef, FeatureDef } from '../src/data/types';

const body = (id: string): BodyDef => SOLAR_SYSTEM.bodies.find((b) => b.id === id)!;
const R = 173740;

function randDir(i: number): [number, number, number] {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const z = (a - Math.floor(a)) * 2 - 1;
  const t = (b - Math.floor(b)) * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), z, r * Math.sin(t)];
}

function only(base: BodyDef, f: FeatureDef): BodyDef {
  return { ...base, terrain: { ...base.terrain!, craters: undefined, features: [f], layers: [] } };
}

test('basin: deterministic, bounded, a central peak above the floor and a raised rim', () => {
  const f: FeatureDef = { kind: 'basin', lat: 0, lon: 0, radius: 0.1, height: 1, rays: 1, bands: 3 };
  const def = only(body('moon'), f);
  const a = createHeightSampler(def, R);
  const b = createHeightSampler(def, R);
  const amp = def.terrain!.amplitude * R;
  const at = (t: number): [number, number, number] => [Math.cos(t * 0.1), 0, -Math.sin(t * 0.1)];
  expect(a.heightAt(...at(0)) / amp).toBeGreaterThan(a.heightAt(...at(0.4)) / amp);
  expect(a.heightAt(...at(1.0)) / amp).toBeGreaterThan(0.1);
  for (let i = 0; i < 400; i++) {
    const [x, y, z] = randDir(i);
    expect(a.heightAt(x, y, z)).toBe(b.heightAt(x, y, z));
    expect(Math.abs(a.heightAt(x, y, z) / amp)).toBeLessThan(1.5);
  }
});

test('basin rays tint the ground beyond the rim and stay in range', () => {
  const f: FeatureDef = { kind: 'basin', lat: 0, lon: 0, radius: 0.05, height: 0.8, rays: 1 };
  const s = createHeightSampler(only(body('moon'), f), R);
  const out = makeSample();
  let bright = 0;
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    const d = 0.05 * 3;
    const y = Math.sin(a) * d;
    const z = -Math.cos(a) * d;
    const l = Math.hypot(1, y, z);
    s.sample(1 / l, y / l, z / l, out);
    expect(out.tint).toBeGreaterThanOrEqual(-1);
    expect(out.tint).toBeLessThanOrEqual(1);
    if (out.tint > 0.15) bright++;
  }
  expect(bright).toBeGreaterThan(20);
  // Far beyond the ray reach there is no tint.
  const far = 0.05 * RAY_REACH * 1.5;
  const l = Math.hypot(1, far, 0);
  s.sample(1 / l, far / l, 0, out);
  expect(out.tint).toBe(0);
});

test('lineae: global, deterministic, bounded relief, tint only darkens', () => {
  const f: FeatureDef = { kind: 'lineae', lat: 0, lon: 0, radius: 1.5, height: 0.35, bands: 6 };
  const def = only(body('europa'), f);
  const a = createHeightSampler(def, 156000);
  const b = createHeightSampler(def, 156000);
  const out = makeSample();
  let dark = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 3000; i++) {
    const [x, y, z] = randDir(i);
    const h = a.heightAt(x, y, z);
    expect(h).toBe(b.heightAt(x, y, z));
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
    a.sample(x, y, z, out);
    expect(out.tint).toBeLessThanOrEqual(0);
    if (out.tint < -0.3) dark++;
  }
  const amp = def.terrain!.amplitude * 156000;
  expect(dark).toBeGreaterThan(20);
  expect(dark).toBeLessThan(2000);
  expect(lo).toBeGreaterThan(-amp * 0.6);
  expect(hi).toBeLessThan(amp * 0.6);
});

test('dunes: height stays within the feature height and varies', () => {
  const f: FeatureDef = { kind: 'dunes', lat: 0, lon: 0, radius: 0.2, height: 0.01, bands: 60 };
  const def = only(body('mars'), f);
  const s = createHeightSampler(def, 339000);
  const amp = def.terrain!.amplitude * 339000;
  let max = 0;
  let min = Infinity;
  for (let i = 0; i < 2000; i++) {
    const a = ((i / 2000) * 2 - 1) * 0.18;
    const h = s.heightAt(Math.cos(a), 0, -Math.sin(a)) / amp;
    max = Math.max(max, h);
    min = Math.min(min, h);
  }
  expect(min).toBeGreaterThanOrEqual(0);
  expect(max).toBeLessThanOrEqual(0.0101);
  expect(max).toBeGreaterThan(0.004);
});

test('canyon strata: layered walls keep the canyon within its depth', () => {
  const f: FeatureDef = { kind: 'canyon', lat: 0, lon: 0, radius: 0.25, height: -0.6, bands: 7 };
  const def = only(body('mars'), f);
  const s = createHeightSampler(def, 339000);
  const amp = def.terrain!.amplitude * 339000;
  let lo = 0;
  const out = makeSample();
  let tinted = 0;
  for (let i = 0; i < 4000; i++) {
    const a = ((i % 100) / 100 - 0.5) * 0.5;
    const b = (Math.floor(i / 100) / 40 - 0.5) * 0.2;
    const l = Math.hypot(1, b, a);
    s.sample(1 / l, b / l, -a / l, out);
    lo = Math.min(lo, out.height / amp);
    if (Math.abs(out.tint) > 0.05) tinted++;
  }
  expect(lo).toBeGreaterThanOrEqual(-0.601);
  expect(tinted).toBeGreaterThan(10);
});

test('generated worlds get signature features deterministically', () => {
  const kinds = new Set<string>();
  const stars = createGalaxy().stars.filter((st) => st.id !== 'sol').slice(0, 40);
  for (const star of stars) {
    const a = generateSystem(star);
    const b = generateSystem(star);
    for (const d of a.bodies) for (const f of d.terrain?.features ?? []) kinds.add(f.kind);
    expect(JSON.stringify(a.bodies.map((d) => d.terrain?.features))).toBe(JSON.stringify(b.bodies.map((d) => d.terrain?.features)));
  }
  expect(kinds.has('basin') || kinds.has('lineae') || kinds.has('dunes')).toBe(true);
});

test('sample cost with the new features stays small', () => {
  const s = createHeightSampler(body('europa'), 156000);
  const out = makeSample();
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) {
    const [x, y, z] = randDir(i);
    s.sample(x, y, z, out);
  }
  const per = (performance.now() - t0) / 20000;
  expect(per).toBeLessThan(0.05);
});
