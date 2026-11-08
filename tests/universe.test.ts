import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { Universe } from '../src/sim/universe';
import { orbitState } from '../src/sim/ephemeris';
import { DEFAULT_SCALE } from '../src/data/scale';

describe('Universe with SOLAR_SYSTEM', () => {
  test('builds without throwing and exposes all bodies', () => {
    const u = new Universe(SOLAR_SYSTEM);
    const ids = u.bodies.map((b) => b.id);
    expect(ids[0]).toBe('sun');
    expect(ids).toEqual(expect.arrayContaining(['sun', 'earth', 'moon']));
    // Parents always come before their children.
    for (const b of u.bodies) if (b.parent) expect(ids.indexOf(b.parent.id)).toBeLessThan(ids.indexOf(b.id));
    expect(u.root.id).toBe('sun');
    expect(u.get('moon').parent?.id).toBe('earth');
  });

  test('the Moon position is its parent position plus its orbit offset', () => {
    const u = new Universe(SOLAR_SYSTEM);
    for (const t of [0, 12345, 1e6]) {
      u.update(t);
      const moon = u.get('moon');
      const earth = u.get('earth');
      const offset = new Vector3();
      orbitState(moon.orbit!, t, offset);
      expect(moon.position.x).toBeCloseTo(earth.position.x + offset.x, 3);
      expect(moon.position.y).toBeCloseTo(earth.position.y + offset.y, 3);
      expect(moon.position.z).toBeCloseTo(earth.position.z + offset.z, 3);
      expect(moon.localPosition.distanceTo(offset)).toBeCloseTo(0, 6);
    }
  });

  test('the tidally locked Moon local +X axis points at Earth within 1 degree', () => {
    const u = new Universe(SOLAR_SYSTEM);
    for (const t of [0, 12345, 1e6, 5e6]) {
      u.update(t);
      const moon = u.get('moon');
      const dir = u.get('earth').position.clone().sub(moon.position).normalize();
      const x = new Vector3(1, 0, 0).applyQuaternion(moon.rotation);
      const angleDeg = (Math.acos(Math.min(1, x.dot(dir))) * 180) / Math.PI;
      expect(angleDeg).toBeLessThan(1);
    }
  });

  test('dominantBody returns the moon near the moon, earth near earth, and the sun far away', () => {
    const u = new Universe(SOLAR_SYSTEM);
    u.update(0);
    const moon = u.get('moon');
    const earth = u.get('earth');
    const nearMoon = moon.position.clone().add(new Vector3(moon.radius * 2, 0, 0));
    const nearEarth = earth.position.clone().add(new Vector3(0, earth.radius * 3, 0));
    const farAway = new Vector3(1e13, 0, 0);
    expect(u.dominantBody(nearMoon).id).toBe('moon');
    expect(u.dominantBody(nearEarth).id).toBe('earth');
    expect(u.dominantBody(farAway).id).toBe('sun');
  });

  test("the Moon's orbit distance exceeds Earth's atmosphere top plus the Moon's radius", () => {
    const u = new Universe(SOLAR_SYSTEM);
    const moon = u.get('moon');
    const earth = u.get('earth');
    const orbitDistance = moon.orbit!.a;
    expect(orbitDistance).toBeGreaterThan(earth.atmosphereTop + moon.radius);
    // Sanity: the scaled orbit distance should come from the scale profile.
    expect(orbitDistance).toBeGreaterThan(earth.radius * DEFAULT_SCALE.moonLinearUntil);
  });
});
