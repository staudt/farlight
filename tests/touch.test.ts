import { describe, expect, test } from 'vitest';
import { clampKnob, shapeAxis, sliderValue, stickToAxes, tiltFromOrientation, tiltToAxes } from '../src/input/touchMath';

const deg = (r: number): number => (r * 180) / Math.PI;

describe('touch stick math', () => {
  test('deadzone swallows small pushes', () => {
    expect(shapeAxis(0.05, 0.08)).toBe(0);
    expect(shapeAxis(-0.05, 0.08)).toBe(0);
    expect(shapeAxis(0.2, 0.08)).toBeGreaterThan(0);
  });

  test('shape is monotonic, odd and reaches 1', () => {
    expect(shapeAxis(1, 0.08)).toBeCloseTo(1, 6);
    expect(shapeAxis(-1, 0.08)).toBeCloseTo(-1, 6);
    expect(shapeAxis(0.6, 0.08)).toBeGreaterThan(shapeAxis(0.4, 0.08));
    // Expo: mid push is below linear.
    expect(shapeAxis(0.5, 0)).toBeLessThan(0.5);
  });

  test('stick clamps to the radius', () => {
    const a = stickToAxes(600, 0, 60, 0.08, false, 0);
    expect(a.yaw).toBeCloseTo(1, 6);
    const k = clampKnob(300, 400, 60);
    expect(Math.hypot(k.x, k.y)).toBeCloseTo(60, 6);
    expect(clampKnob(10, 5, 60)).toEqual({ x: 10, y: 5 });
  });

  test('push up pitches the nose up, invert flips it', () => {
    expect(stickToAxes(0, -60, 60, 0.08, false, 0).pitch).toBeGreaterThan(0);
    expect(stickToAxes(0, -60, 60, 0.08, true, 0).pitch).toBeLessThan(0);
    expect(stickToAxes(60, 0, 60, 0.08, false, 0).yaw).toBeGreaterThan(0);
  });

  test('roll follows x only by the factor', () => {
    expect(stickToAxes(60, 0, 60, 0.08, false, 0).roll).toBe(0);
    expect(stickToAxes(60, 0, 60, 0.08, false, 0.4).roll).toBeCloseTo(0.4, 6);
  });

  test('slider maps top to 1 and bottom to 0', () => {
    expect(sliderValue(100, 100, 200)).toBe(1);
    expect(sliderValue(300, 100, 200)).toBe(0);
    expect(sliderValue(200, 100, 200)).toBeCloseTo(0.5, 6);
    expect(sliderValue(0, 100, 200)).toBe(1);
    expect(sliderValue(999, 100, 200)).toBe(0);
  });
});

describe('tilt mapping', () => {
  test('flat portrait tilt reads beta and gamma', () => {
    const t = tiltFromOrientation(30, 0, 0);
    expect(deg(t.pitch)).toBeCloseTo(30, 4);
    expect(deg(t.roll)).toBeCloseTo(0, 4);
    const r = tiltFromOrientation(0, 20, 0);
    expect(deg(r.roll)).toBeCloseTo(20, 4);
  });

  test('landscape 90: right side of the screen down is beta up', () => {
    const base = tiltFromOrientation(0, -60, 90);
    const rightDown = tiltFromOrientation(15, -60, 90);
    expect(rightDown.roll).toBeGreaterThan(base.roll);
  });

  test('landscape 90: top edge toward the sky is gamma more negative', () => {
    const base = tiltFromOrientation(0, -60, 90);
    const back = tiltFromOrientation(0, -75, 90);
    expect(back.pitch).toBeGreaterThan(base.pitch);
  });

  test('landscape 270 mirrors 90', () => {
    const base = tiltFromOrientation(0, 60, 270);
    const back = tiltFromOrientation(0, 75, 270);
    expect(back.pitch).toBeGreaterThan(base.pitch);
    const rightDown = tiltFromOrientation(-15, 60, 270);
    expect(rightDown.roll).toBeGreaterThan(base.roll);
  });

  test('neutral gives zero, deflection steers, forward tilt dives', () => {
    const n = tiltFromOrientation(0, -60, 90);
    expect(tiltToAxes(n, n, 22, 0.1, false)).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    const right = tiltFromOrientation(20, -60, 90);
    expect(tiltToAxes(right, n, 22, 0.1, false).yaw).toBeGreaterThan(0.5);
    const fwd = tiltFromOrientation(0, -45, 90); // top edge down
    expect(tiltToAxes(fwd, n, 22, 0.1, false).pitch).toBeLessThan(0);
    expect(tiltToAxes(fwd, n, 22, 0.1, true).pitch).toBeGreaterThan(0);
  });
});
