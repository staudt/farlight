import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { orbitState, solveKepler, type ScaledOrbit } from '../src/sim/ephemeris';

const TWO_PI = Math.PI * 2;

function circular(period: number, a = 1000): ScaledOrbit {
  return { a, e: 0, i: 0, node: 0, argPeri: 0, m0: 0, period };
}

describe('solveKepler', () => {
  test.each([0, 0.1, 0.3, 0.6, 0.9])('satisfies Kepler equation for e=%s', (e) => {
    for (const M of [0, 0.5, 1.5, 3.0, 4.2, 6.0, -1.0, 13.0]) {
      const E = solveKepler(M, e);
      const Mn = ((M % TWO_PI) + TWO_PI) % TWO_PI;
      // Residual must be a multiple of 2π (M is wrapped internally).
      const residual = E - e * Math.sin(E) - Mn;
      expect(Math.sin(residual / 2)).toBeCloseTo(0, 9);
      expect(Math.cos(residual)).toBeCloseTo(1, 9);
    }
  });
});

describe('orbitState', () => {
  test('circular orbit keeps radius a', () => {
    const o = circular(1000, 250);
    const p = new Vector3();
    for (const t of [0, 100, 333, 777]) {
      orbitState(o, t, p);
      expect(p.length()).toBeCloseTo(250, 9);
    }
  });

  test('circular prograde orbit rotates 90° counterclockwise seen from +Y after a quarter period', () => {
    const o = circular(1000, 1);
    const p0 = new Vector3();
    const pq = new Vector3();
    orbitState(o, 0, p0);
    orbitState(o, 250, pq);
    // Angle in the XZ plane, measured counterclockwise seen from +Y: atan2(-z, x).
    const a0 = Math.atan2(-p0.z, p0.x);
    const aq = Math.atan2(-pq.z, pq.x);
    expect(p0.y).toBeCloseTo(0, 12);
    expect(pq.y).toBeCloseTo(0, 12);
    expect(aq - a0).toBeCloseTo(Math.PI / 2, 9);
    expect(pq.x).toBeCloseTo(0, 9);
    expect(pq.z).toBeCloseTo(-1, 9);
  });

  test('negative period orbits the opposite way', () => {
    const pos = new Vector3();
    const neg = new Vector3();
    orbitState(circular(1000, 1), 250, pos);
    orbitState(circular(-1000, 1), 250, neg);
    expect(neg.x).toBeCloseTo(0, 9);
    expect(neg.z).toBeCloseTo(1, 9);
    expect(pos.z).toBeCloseTo(-1, 9);
  });

  test('velocity matches central finite difference of positions (dt = 1 s)', () => {
    const orbits: ScaledOrbit[] = [
      { a: 1e5, e: 0, i: 0.2, node: 1.1, argPeri: 0.7, m0: 0.3, period: 5e4 },
      { a: 2e5, e: 0.3, i: 0.5, node: 2.0, argPeri: 4.0, m0: 2.0, period: 1e5 },
      { a: 3e5, e: 0.7, i: 1.0, node: 5.0, argPeri: 1.0, m0: 5.5, period: -8e4 },
    ];
    for (const o of orbits) {
      for (const t of [0, 1234, 9999, 40000]) {
        const v = new Vector3();
        const pos = new Vector3();
        orbitState(o, t, pos, v);
        const before = new Vector3();
        const after = new Vector3();
        orbitState(o, t - 1, before);
        orbitState(o, t + 1, after);
        const fd = after.sub(before).multiplyScalar(0.5);
        expect(fd.distanceTo(v) / v.length()).toBeLessThan(1e-3);
      }
    }
  });
});
