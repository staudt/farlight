import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { pickMoon } from '../src/render/nightLight';
import type { Body } from '../src/sim/universe';

function body(kind: string, radius: number, pos: [number, number, number]): Body {
  return { kind, radius, position: new Vector3(...pos), children: [], parent: null } as unknown as Body;
}

describe('pickMoon', () => {
  const sun = new Vector3(1e9, 0, 0);
  const dir = new Vector3();

  it('is brightest for a full moon (opposite the sun) and dark for a new moon', () => {
    const earth = body('rocky', 6.4e5, [0, 0, 0]);
    const full = body('rocky', 1.7e5, [-1.2e7, 0, 0]);
    earth.children.push(full);
    const f = pickMoon(earth, sun, new Vector3(6.4e5, 0, 0), dir);
    expect(f?.body).toBe(full);
    expect(f!.level).toBeGreaterThan(0.9);
    expect(dir.x).toBeLessThan(0);

    earth.children.length = 0;
    earth.children.push(body('rocky', 1.7e5, [1.2e7, 0, 0]));
    expect(pickMoon(earth, sun, new Vector3(6.4e5, 0, 0), dir)!.level).toBeLessThan(0.01);
  });

  it('uses the parent planet as the light for a moon, never a star', () => {
    const star = body('star', 7e8, [1e9, 0, 0]);
    const planet = body('rocky', 6.4e5, [0, 0, 0]);
    const moon = body('rocky', 1.7e5, [1.2e7, 0, 0]);
    moon.parent = planet;
    planet.parent = star;
    planet.children.push(moon);
    const p = pickMoon(moon, new Vector3(1e9, 0, 0), new Vector3(1.2e7, 0, 0), dir);
    expect(p?.body).toBe(planet);
    expect(pickMoon(star, sun, sun, dir)).toBeNull();
  });
});
