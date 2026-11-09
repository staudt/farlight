import { describe, expect, it } from 'vitest';
import { actionFor, BTN, mapPad, risingEdges, shapeStick, type PadLike } from '../src/input/gamepad';

function pad(axes: number[] = [0, 0, 0, 0], pressed: Record<number, number> = {}): PadLike {
  return {
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: (pressed[i] ?? 0) > 0.5, value: pressed[i] ?? 0 })),
  };
}

describe('gamepad mapping', () => {
  it('ignores stick noise inside the deadzone', () => {
    const f = mapPad(pad([0.1, -0.08, 0.05, 0.1]), false);
    expect(f.pitch).toBe(0);
    expect(f.yaw).toBe(0);
    expect(f.lookX).toBe(0);
  });

  it('left stick up is nose down, with an invert option', () => {
    const up = pad([0, -1, 0, 0]);
    expect(mapPad(up, false).pitch).toBeLessThan(-0.9);
    expect(mapPad(up, true).pitch).toBeGreaterThan(0.9);
  });

  it('left stick x yaws, shaped and bounded', () => {
    const f = mapPad(pad([1, 0, 0, 0]), false);
    expect(f.yaw).toBeCloseTo(1, 5);
    const half = mapPad(pad([0.5, 0, 0, 0]), false).yaw;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.5);
  });

  it('diagonals stay inside the unit circle', () => {
    const s = shapeStick(1, 1, 0.16);
    expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(1.0001);
  });

  it('triggers set the throttle rate', () => {
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.RT]: 1 }), false).throttleDelta).toBe(1);
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.LT]: 0.5 }), false).throttleDelta).toBe(-0.5);
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.LT]: 1, [BTN.RT]: 1 }), false).throttleDelta).toBe(0);
  });

  it('bumpers roll, A boosts, B brakes, X aligns', () => {
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.LB]: 1 }), false).roll).toBe(-1);
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.RB]: 1 }), false).roll).toBe(1);
    expect(mapPad(pad([0, 0, 0, 0], { [BTN.LB]: 1, [BTN.RB]: 1 }), false).roll).toBe(0);
    const f = mapPad(pad([0, 0, 0, 0], { [BTN.A]: 1, [BTN.B]: 1, [BTN.X]: 1 }), false);
    expect(f.boost && f.brake && f.align).toBe(true);
  });

  it('survives missing axes and NaN', () => {
    const f = mapPad({ axes: [NaN], buttons: [] }, false);
    expect(f.pitch).toBe(0);
    expect(f.throttleDelta).toBe(0);
  });

  it('maps one shot buttons to actions per mode', () => {
    expect(actionFor(BTN.Y, 'flight')).toBe('target');
    expect(actionFor(BTN.LEFT, 'flight')).toBe('warpDown');
    expect(actionFor(BTN.RIGHT, 'flight')).toBe('warpUp');
    expect(actionFor(BTN.UP, 'flight')).toBe('camera');
    expect(actionFor(BTN.DOWN, 'flight')).toBe('hud');
    expect(actionFor(BTN.START, 'flight')).toBe('galaxy');
    expect(actionFor(BTN.BACK, 'flight')).toBe('map');
    expect(actionFor(BTN.A, 'flight')).toBeNull();
    expect(actionFor(BTN.B, 'overlay')).toBe('back');
    expect(actionFor(BTN.Y, 'overlay')).toBeNull();
    expect(actionFor(BTN.A, 'photo')).toBe('capture');
    expect(actionFor(BTN.B, 'photo')).toBe('photo');
    expect(actionFor(BTN.LEFT, 'photo')).toBeNull();
  });

  it('reports rising edges only', () => {
    const p = pad([0, 0, 0, 0], { [BTN.Y]: 1, [BTN.A]: 1 });
    expect(risingEdges([], p)).toEqual([BTN.A, BTN.Y]);
    const held = Array.from({ length: 17 }, (_, i) => i === BTN.A);
    expect(risingEdges(held, p)).toEqual([BTN.Y]);
  });
});
