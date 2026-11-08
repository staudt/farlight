import { describe, expect, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { DEFAULT_SCALE, scaledOrbitDistance, scaledRadius, soiFactor } from '../src/data/scale';
import type { BodyDef } from '../src/data/types';

const S = DEFAULT_SCALE;
const bodies = SOLAR_SYSTEM.bodies;

function get(id: string): BodyDef {
  const b = bodies.find((x) => x.id === id);
  if (!b) throw new Error(`missing body ${id}`);
  return b;
}

const sun = get('sun');
const planets = bodies.filter((b) => b.parentId === 'sun' && b.kind !== 'star');
const moons = bodies.filter((b) => b.parentId !== undefined && b.parentId !== 'sun');

describe('system layout', () => {
  test('no moon orbit reaches inside its parent atmosphere plus the moon radius', () => {
    for (const moon of moons) {
      const parent = get(moon.parentId!);
      const atmosphereTop = scaledRadius(parent, S) * (1 + (parent.atmosphere?.height ?? 0));
      const orbit = scaledOrbitDistance(moon, parent, S);
      expect(orbit, moon.id).toBeGreaterThan(atmosphereTop + scaledRadius(moon, S));
    }
  });

  test('each planet sphere of influence is under half the gap to its nearest neighbour orbit', () => {
    for (const p of planets) {
      const soi = soiFactor(p, sun, S) * scaledRadius(p, S);
      const a = scaledOrbitDistance(p, sun, S);
      let nearest = Infinity;
      for (const q of planets) {
        if (q === p) continue;
        nearest = Math.min(nearest, Math.abs(scaledOrbitDistance(q, sun, S) - a));
      }
      expect(soi, p.id).toBeLessThan(nearest / 2);
    }
  });
});
