import { describe, expect, it } from 'vitest';
import { computeStarLight } from '../src/render/starLight';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';

const sol = SOLAR_SYSTEM.bodies[0]!.star!;

describe('starLight', () => {
  it('keeps Sol white and at unit intensity', () => {
    const v = computeStarLight(sol);
    expect(v.tint.x).toBeCloseTo(1, 5);
    expect(v.tint.y).toBeCloseTo(1, 5);
    expect(v.tint.z).toBeCloseTo(1, 5);
    expect(v.intensity).toBeCloseTo(1, 5);
  });

  it('warms and dims red dwarfs', () => {
    const v = computeStarLight({ color: [1.0, 0.45, 0.2], intensity: 0.6, coronaSize: 6 });
    expect(v.tint.x).toBeGreaterThan(v.tint.y);
    expect(v.tint.y).toBeGreaterThan(v.tint.z);
    expect(v.intensity).toBeLessThan(1);
  });

  it('cools and brightens blue stars', () => {
    const v = computeStarLight({ color: [0.62, 0.76, 1.0], intensity: 1.8, coronaSize: 6 });
    expect(v.tint.z).toBeGreaterThan(v.tint.x);
    expect(v.intensity).toBeGreaterThan(1);
  });

  it('falls back to white without star data', () => {
    const v = computeStarLight(undefined);
    expect(v.tint.toArray()).toEqual([1, 1, 1]);
  });
});
