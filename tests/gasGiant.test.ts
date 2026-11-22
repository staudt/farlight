import { describe, expect, test } from 'vitest';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';

describe('gas giant data', () => {
  const gases = SOLAR_SYSTEM.bodies.filter((b) => b.gas);

  test('solar system gas giants carry a polar strength in 0..1', () => {
    expect(gases.length).toBeGreaterThanOrEqual(4);
    for (const b of gases) {
      expect(b.gas!.polar).toBeGreaterThanOrEqual(0);
      expect(b.gas!.polar).toBeLessThanOrEqual(1);
    }
  });

  test('polar shape comes from data: Saturn has a hexagon, Jupiter does not', () => {
    expect(SOLAR_SYSTEM.bodies.find((b) => b.id === 'saturn')!.gas!.polarSides).toBe(6);
    expect(SOLAR_SYSTEM.bodies.find((b) => b.id === 'jupiter')!.gas!.polarSides).toBeUndefined();
  });

  test('generated gas giants have a valid polar strength', () => {
    const stars = createGalaxy().stars.filter((s) => s.id !== 'sol').slice(0, 40);
    let found = 0;
    for (const star of stars) {
      for (const b of generateSystem(star).bodies) {
        if (!b.gas) continue;
        found++;
        expect(b.gas.polar).toBeGreaterThanOrEqual(0);
        expect(b.gas.polar).toBeLessThanOrEqual(1);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
