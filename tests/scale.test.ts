import { describe, expect, test } from 'vitest';
import { DEFAULT_SCALE, compressMoonRatio, scaledOrbitDistance, scaledRadius } from '../src/data/scale';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { Universe } from '../src/sim/universe';
import type { BodyDef } from '../src/data/types';

const S = DEFAULT_SCALE;

function body(over: Partial<BodyDef> & Pick<BodyDef, 'id' | 'kind'>): BodyDef {
  return {
    name: over.id,
    seed: 1,
    physical: { radius: 1e6, surfaceGravity: 1, rotationPeriod: 1000, axialTilt: 0 },
    visual: { color: [1, 1, 1] },
    info: { type: '', atmosphere: '', temperature: '', features: [], summary: '' },
    ...over,
  };
}

const sun = body({ id: 'sun', kind: 'star', physical: { radius: 7e8, surfaceGravity: 28, rotationPeriod: 1, axialTilt: 0 } });
const planet = body({
  id: 'planet',
  kind: 'rocky',
  parentId: 'sun',
  physical: { radius: 6e6, surfaceGravity: 1, rotationPeriod: 1, axialTilt: 0 },
  orbit: {
    semiMajorAxis: 1.5e11,
    eccentricity: 0,
    inclination: 0,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 0,
    period: 3e7,
  },
});
const moon = body({
  id: 'moon',
  kind: 'rocky',
  parentId: 'planet',
  physical: { radius: 1e6, surfaceGravity: 1, rotationPeriod: 1, axialTilt: 0 },
  orbit: {
    semiMajorAxis: 3.8e8,
    eccentricity: 0,
    inclination: 0,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 0,
    period: 2e6,
  },
});

describe('scaledRadius', () => {
  test('stars use starRadiusScale', () => {
    expect(scaledRadius(sun, S) / sun.physical.radius).toBeCloseTo(S.starRadiusScale, 12);
  });

  test('planets and moons use radiusScale', () => {
    expect(scaledRadius(planet, S) / planet.physical.radius).toBeCloseTo(S.radiusScale, 12);
  });

  test('visual.radius overrides the scaled radius', () => {
    const def = body({ id: 'x', kind: 'rocky', visual: { color: [0, 0, 0], radius: 123 } });
    expect(scaledRadius(def, S)).toBe(123);
  });
});

describe('scaledOrbitDistance', () => {
  test('planets orbiting a star use planetOrbitScale', () => {
    const d = scaledOrbitDistance(planet, sun, S);
    expect(d / planet.orbit!.semiMajorAxis).toBeCloseTo(S.planetOrbitScale, 12);
  });

  test('moons use the compressed ratio in parent radii', () => {
    const d = scaledOrbitDistance(moon, planet, S);
    const ratio = moon.orbit!.semiMajorAxis / planet.physical.radius;
    const expected = compressMoonRatio(ratio, S) * scaledRadius(planet, S);
    expect(d / expected).toBeCloseTo(1, 10);
  });

  test('visual.orbitDistance overrides the scaled semi major axis', () => {
    const def = body({
      id: 'p2',
      kind: 'rocky',
      parentId: 'sun',
      visual: { color: [0, 0, 0], orbitDistance: 4242 },
      orbit: { ...planet.orbit! },
    });
    expect(scaledOrbitDistance(def, sun, S)).toBe(4242);
  });
});

describe('compressMoonRatio', () => {
  test('is the identity up to moonLinearUntil', () => {
    for (const r of [0, 0.5, 1, 2, 3.5, S.moonLinearUntil]) {
      expect(compressMoonRatio(r, S)).toBeCloseTo(r, 12);
    }
  });

  test('grows sublinearly past moonLinearUntil', () => {
    const f = (r: number) => compressMoonRatio(r, S);
    const knee = S.moonLinearUntil;
    let prev = f(knee);
    for (let r = knee + 1; r <= 200; r += 1) {
      const cur = f(r);
      // Strictly increasing.
      expect(cur).toBeGreaterThan(prev);
      // Slope at most 1 (sublinear). The slope is exactly 1 on the first step past the knee.
      expect(cur - prev).toBeLessThanOrEqual(1 + 1e-12);
      prev = cur;
    }
    // Value well below the linear extension.
    expect(f(100)).toBeLessThan(100);
    expect(f(100)).toBeCloseTo(knee + Math.pow(100 - knee, S.moonExponent), 10);
  });
});

describe('size dependent minimum apparent size', () => {
  const u = new Universe(SOLAR_SYSTEM);
  const floor = (id: string): number => u.get(id).minApparentSize;

  test('a gas giant keeps a bigger dot than its moons', () => {
    expect(floor('saturn')).toBeGreaterThan(floor('titan') * 2);
    expect(floor('jupiter')).toBeGreaterThan(floor('ganymede') * 2);
    expect(floor('titan')).toBeGreaterThan(floor('phobos'));
  });

  test('bigger planets keep bigger floors, within the clamp', () => {
    expect(floor('jupiter')).toBeGreaterThan(floor('earth'));
    expect(floor('earth')).toBeGreaterThan(floor('mercury'));
    expect(floor('earth')).toBeCloseTo(DEFAULT_SCALE.minApparentSize, 4);
    for (const b of u.bodies) {
      if (b.def.visual.minApparentSize !== undefined) continue;
      expect(b.minApparentSize).toBeGreaterThanOrEqual(DEFAULT_SCALE.minApparentMin);
      expect(b.minApparentSize).toBeLessThanOrEqual(DEFAULT_SCALE.minApparentMax);
    }
  });
});
