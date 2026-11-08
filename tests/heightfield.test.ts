import { expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { createHeightSampler, makeSample } from '../src/terrain/heightfield';

const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;
const moon = SOLAR_SYSTEM.bodies.find((b) => b.id === 'moon')!;
const ER = 637100;
const MR = 173740;

function randDir(i: number): [number, number, number] {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const z = (a - Math.floor(a)) * 2 - 1;
  const t = (b - Math.floor(b)) * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), z, r * Math.sin(t)];
}

test('deterministic per seed', () => {
  const a = createHeightSampler(earth, ER);
  const b = createHeightSampler(earth, ER);
  for (let i = 0; i < 200; i++) {
    const [x, y, z] = randDir(i);
    expect(a.heightAt(x, y, z)).toBe(b.heightAt(x, y, z));
  }
});

test('heights are bounded and water clamps at sea level', () => {
  const s = createHeightSampler(earth, ER);
  const amp = earth.terrain!.amplitude * ER;
  const out = makeSample();
  let water = 0;
  for (let i = 0; i < 2000; i++) {
    const [x, y, z] = randDir(i);
    const h = s.heightAt(x, y, z);
    expect(Math.abs(h)).toBeLessThan(amp * 2.5);
    s.sample(x, y, z, out);
    if (out.water) {
      water++;
      expect(h).toBeCloseTo(earth.terrain!.seaLevel! * amp, 6);
      expect(out.depth).toBeGreaterThan(0);
    }
  }
  expect(water).toBeGreaterThan(300);
});

test('moon crater cost is bounded', () => {
  const s = createHeightSampler(moon, MR);
  for (let i = 0; i < 2000; i++) s.heightAt(...randDir(i + 50000)); // JIT warmup
  const t0 = performance.now();
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const [x, y, z] = randDir(i);
    sum += s.heightAt(x, y, z);
  }
  const dt = performance.now() - t0;
  expect(Number.isFinite(sum)).toBe(true);
  expect(dt).toBeLessThan(200);
});
