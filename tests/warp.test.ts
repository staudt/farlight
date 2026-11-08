import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { config } from '../src/core/config';
import { allowedWarp, phaseMaxWarp, raySphere } from '../src/sim/warp';
import { SimClock } from '../src/sim/clock';

describe('raySphere', () => {
  test('hits a sphere ahead and returns the entry distance', () => {
    const t = raySphere(new Vector3(0, 0, -10), new Vector3(0, 0, 1), new Vector3(), 1);
    expect(t).toBeCloseTo(9, 9);
  });

  test('hit distance scales with a non unit direction', () => {
    // Direction length 2: the hit happens at half the parameter.
    const t = raySphere(new Vector3(0, 0, -10), new Vector3(0, 0, 2), new Vector3(), 1);
    expect(t).toBeCloseTo(4.5, 9);
  });

  test('misses a sphere off to the side', () => {
    const t = raySphere(new Vector3(0, 5, -10), new Vector3(0, 0, 1), new Vector3(), 1);
    expect(t).toBe(Infinity);
  });

  test('returns Infinity for a sphere behind the ray', () => {
    const t = raySphere(new Vector3(0, 0, -10), new Vector3(0, 0, -1), new Vector3(), 1);
    expect(t).toBe(Infinity);
  });

  test('returns Infinity when the origin is inside the sphere', () => {
    const t = raySphere(new Vector3(0.5, 0, 0), new Vector3(1, 0, 0), new Vector3(), 1);
    expect(t).toBe(Infinity);
  });

  test('returns Infinity for a zero direction', () => {
    const t = raySphere(new Vector3(0, 0, -10), new Vector3(0, 0, 0), new Vector3(), 1);
    expect(t).toBe(Infinity);
  });

  test('respects the sphere centre', () => {
    const t = raySphere(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(100, 0, 0), 10);
    expect(t).toBeCloseTo(90, 9);
  });
});

describe('allowedWarp', () => {
  const { atmosphereMax, landedMax, minRealEta } = config.warp;

  test('phaseMaxWarp reads the config limits', () => {
    expect(phaseMaxWarp('atmosphere')).toBe(atmosphereMax);
    expect(phaseMaxWarp('landed')).toBe(landedMax);
    expect(phaseMaxWarp('space')).toBe(Infinity);
    expect(phaseMaxWarp('near')).toBe(Infinity);
  });

  test('atmosphere phase is capped at atmosphereMax even with a far boundary', () => {
    expect(allowedWarp('atmosphere', 1e12)).toBeCloseTo(atmosphereMax, 12);
  });

  test('landed phase is capped at landedMax even with a far boundary', () => {
    expect(allowedWarp('landed', 1e12)).toBeCloseTo(landedMax, 12);
  });

  test('space phase is limited only by the ETA rule', () => {
    const eta = 4000;
    expect(allowedWarp('space', eta)).toBeCloseTo(eta / minRealEta, 9);
  });

  test('ETA rule: real time to the boundary never drops below minRealEta', () => {
    for (const eta of [50, 400, 4000]) {
      const w = allowedWarp('space', eta);
      expect(eta / w).toBeGreaterThanOrEqual(minRealEta - 1e-9);
    }
  });

  test('warp never drops below 1 when the boundary is close', () => {
    expect(allowedWarp('space', 0.5)).toBe(1);
    expect(allowedWarp('atmosphere', 0)).toBe(1);
  });

  test('the ETA limit wins over the phase limit when it is smaller', () => {
    // Atmosphere cap is 4. An ETA of 8 sim seconds gives 8 / minRealEta = 2 < 4.
    expect(allowedWarp('atmosphere', 8)).toBeCloseTo(8 / minRealEta, 12);
  });
});

describe('SimClock', () => {
  const levels = config.warp.levels;

  test('step clamps to the level range', () => {
    const clock = new SimClock();
    clock.step(-5);
    expect(clock.warpIndex).toBe(0);
    clock.step(1000);
    expect(clock.warpIndex).toBe(levels.length - 1);
    expect(clock.warp).toBe(levels[levels.length - 1]);
    clock.step(1);
    expect(clock.warpIndex).toBe(levels.length - 1);
  });

  test('step moves one level at a time', () => {
    const clock = new SimClock();
    clock.step(1);
    expect(clock.warp).toBe(levels[1]);
    clock.step(2);
    expect(clock.warp).toBe(levels[3]);
  });

  test('clampTo lowers the warp and reports true', () => {
    const clock = new SimClock();
    clock.warpIndex = levels.length - 1;
    const changed = clock.clampTo(4);
    expect(changed).toBe(true);
    expect(clock.warp).toBe(4);
  });

  test('clampTo leaves a lower warp alone and reports false', () => {
    const clock = new SimClock();
    clock.warpIndex = 1; // level 2
    expect(clock.clampTo(100)).toBe(false);
    expect(clock.warpIndex).toBe(1);
  });

  test('clampTo below the lowest level settles at level 1', () => {
    const clock = new SimClock();
    clock.warpIndex = 3;
    expect(clock.clampTo(0.25)).toBe(true);
    expect(clock.warpIndex).toBe(0);
    expect(clock.warp).toBe(1);
  });

  test('advance returns realDt times warp and moves sim time by the same amount', () => {
    const clock = new SimClock(100);
    clock.warpIndex = 3; // level 10
    const dt = clock.advance(0.5);
    expect(dt).toBeCloseTo(5, 12);
    expect(clock.time).toBeCloseTo(105, 12);
  });

  test('advance returns zero while paused', () => {
    const clock = new SimClock();
    clock.paused = true;
    expect(clock.advance(1)).toBe(0);
    expect(clock.time).toBe(0);
  });
});
