import { expect } from 'vitest';
import { DEFAULT_SCALE, scaledOrbitDistance, scaledRadius, soiFactor } from '../src/data/scale';
import type { StarSystemDef } from '../src/data/types';

const S = DEFAULT_SCALE;

/** Layout constraints every system, hand authored or generated, must satisfy. */
export function expectValidLayout(system: StarSystemDef): void {
  const bodies = system.bodies;
  const star = bodies[0]!;
  const get = (id: string) => {
    const b = bodies.find((x) => x.id === id);
    if (!b) throw new Error(`missing body ${id}`);
    return b;
  };
  const planets = bodies.filter((b) => b.parentId === star.id && b.kind !== 'star');
  const moons = bodies.filter((b) => b.parentId !== undefined && b.parentId !== star.id);

  for (const moon of moons) {
    const parent = get(moon.parentId!);
    const atmosphereTop = scaledRadius(parent, S) * (1 + (parent.atmosphere?.height ?? 0));
    const orbit = scaledOrbitDistance(moon, parent, S);
    expect(orbit, `${system.id}/${moon.id} outside atmosphere`).toBeGreaterThan(atmosphereTop + scaledRadius(moon, S));
  }

  for (const p of planets) {
    const soi = soiFactor(p, star, S) * scaledRadius(p, S);
    const a = scaledOrbitDistance(p, star, S);
    let nearest = Infinity;
    for (const q of planets) {
      if (q === p) continue;
      nearest = Math.min(nearest, Math.abs(scaledOrbitDistance(q, star, S) - a));
    }
    expect(soi, `${system.id}/${p.id} soi`).toBeLessThan(nearest / 2);
  }
}
