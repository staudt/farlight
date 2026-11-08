import { expect, test } from 'vitest';
import { chunkEdgeLength, faceToDir, isBeyondHorizon, maxLevelFor, shouldMerge, shouldSplit } from '../src/terrain/quadtree';

test('split below factor * edge, never past max level', () => {
  expect(shouldSplit(100, 100, 3, 10)).toBe(true);
  expect(shouldSplit(300, 100, 3, 10)).toBe(false);
  expect(shouldSplit(1, 100, 10, 10)).toBe(false);
});

test('merge has hysteresis', () => {
  const edge = 100;
  const d = edge * 2.2 * 1.1;
  expect(shouldSplit(d, edge, 3, 10)).toBe(false);
  expect(shouldMerge(d, edge)).toBe(false);
  expect(shouldMerge(edge * 2.2 * 1.5, edge)).toBe(true);
});

test('max level gives a finest edge under 400 m', () => {
  for (const r of [173740, 637100, 1e6]) {
    const l = maxLevelFor(r);
    expect(chunkEdgeLength(r, l)).toBeLessThanOrEqual(400);
    expect(chunkEdgeLength(r, l - 1)).toBeGreaterThan(400);
  }
});

test('face mapping gives unit vectors', () => {
  const a = { x: 0, y: 0, z: 0 };
  for (let f = 0; f < 6; f++) {
    faceToDir(f, 0.3, -0.7, a);
    expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 6);
  }
});

test('shared face edges agree', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  // +X face (a=Y, b=Z) at u=1 is y=1 -> the +Y face edge; +Y face (a=Z, b=X) at u=-1... check vs x=1 side: v=1.
  faceToDir(0, 1, 0.4, a);
  faceToDir(2, 0.4, 1, b);
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
});

test('horizon culling', () => {
  const cam = { x: 0, y: 0, z: 1 };
  expect(isBeyondHorizon(cam, 1.01e6, { x: 0, y: 0, z: -1 }, 0.01, 1e6, 1e6)).toBe(true);
  expect(isBeyondHorizon(cam, 1.01e6, { x: 0, y: 0, z: 1 }, 0.01, 1e6, 1e6)).toBe(false);
});
