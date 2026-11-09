import { describe, expect, test } from 'vitest';
import { mapPad, BTN, type PadLike } from '../src/input/gamepad';
import { stepNotch } from '../src/input/input';

describe('throttle lever notches', () => {
  test('a tap moves exactly one notch on the 10 percent grid', () => {
    expect(stepNotch(0.4, 1)).toBeCloseTo(0.5, 6);
    expect(stepNotch(0.4, -1)).toBeCloseTo(0.3, 6);
    expect(stepNotch(0, -1)).toBe(0);
    expect(stepNotch(1, 1)).toBe(1);
  });

  test('off grid values snap to the next grid line in the tap direction', () => {
    expect(stepNotch(0.43, 1)).toBeCloseTo(0.5, 6);
    expect(stepNotch(0.43, -1)).toBeCloseTo(0.4, 6);
    expect(stepNotch(0.9999, 1)).toBe(1);
  });

  test('repeated notches walk the whole range', () => {
    let t = 0;
    for (let i = 0; i < 10; i++) t = stepNotch(t, 1);
    expect(t).toBeCloseTo(1, 6);
    for (let i = 0; i < 4; i++) t = stepNotch(t, -1);
    expect(t).toBeCloseTo(0.6, 6);
  });
});

describe('gamepad does not touch the lever at rest', () => {
  const pad = (rt: number, lt: number): PadLike => ({
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: false, value: i === BTN.RT ? rt : i === BTN.LT ? lt : 0 })),
  });
  test('resting and noisy triggers give zero change', () => {
    expect(mapPad(pad(0, 0), false).throttleDelta).toBe(0);
    expect(mapPad(pad(0.03, 0.02), false).throttleDelta).toBe(0);
    expect(mapPad(pad(1, 0), false).throttleDelta).toBe(1);
  });
});
