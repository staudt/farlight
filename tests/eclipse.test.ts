import { beforeEach, describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { World } from '../src/sim/world';
import { config } from '../src/core/config';
import { SCENARIOS } from '../src/scenarios';
import { findTransit } from '../src/sim/shadowSearch';
import { eclipse, eclipseLightMath, sunFraction, type Occluder } from '../src/render/eclipse';

const SUN = { x: 0, y: 0, z: 0 };

/** Luminance left in the umbra of a body with an atmosphere (the red light), plus a little slack. */
function umbraLuma(): number {
  const c = config.eclipse;
  return c.umbraStrength * (0.2126 * c.umbraTint[0] + 0.7152 * c.umbraTint[1] + 0.0722 * c.umbraTint[2]) * 1.02;
}

/** Visible sun fraction at distance `along` beyond the caster on its shadow axis, `off` from the axis. */
function onAxis(sunR: number, casterDist: number, casterR: number, along: number, off: number): number {
  // Sun at the origin, caster on +x at casterDist, point `along` further, off to the side (y).
  return sunFraction({ x: casterDist + along, y: off, z: 0 }, SUN, sunR, { x: casterDist, y: 0, z: 0 }, casterR);
}

describe('sunFraction', () => {
  test('clear sky is 1', () => {
    expect(onAxis(3e6, 1e8, 1e5, 1e6, 1e7)).toBe(1);
    // Occluder on the far side of the sun's direction: no cover.
    expect(sunFraction({ x: 0, y: 0, z: 0 }, { x: 1e8, y: 0, z: 0 }, 3e6, { x: -1e7, y: 0, z: 0 }, 1e6)).toBe(1);
  });

  test('0 at the umbra centre, between 0 and 1 in the penumbra', () => {
    const sunR = 1.5e6;
    const D = 1.5e8;
    const casterR = 1.7e5;
    const d = 1.3e7; // Moon to Earth
    const center = onAxis(sunR, D - d, casterR, d, 0);
    expect(center).toBe(0);
    let seen = false;
    for (let off = 0; off < 6e5; off += 2e3) {
      const v = onAxis(sunR, D - d, casterR, d, off);
      if (v > 0.05 && v < 0.95) seen = true;
    }
    expect(seen).toBe(true);
    expect(onAxis(sunR, D - d, casterR, d, 3e6)).toBe(1);
  });

  test('annular when the occluder looks smaller than the sun', () => {
    const v = sunFraction({ x: 1e8, y: 0, z: 0 }, SUN, 3e6, { x: 5e7, y: 0, z: 0 }, 1e6);
    // Angular radii 0.03 and about 0.02: visible = 1 - (0.02/0.03)^2.
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.7);
  });
});

describe('Earth and Moon geometry', () => {
  const w = new World(SOLAR_SYSTEM, 0);
  const sun = w.universe.root;
  const earth = w.universe.get('earth');
  const moon = w.universe.get('moon');

  /** Visible fraction at Earth's centre when the Moon sits on the sun line at its mean distance. */
  function atEarth(scale: number): number {
    const dir = earth.position.clone().sub(sun.position).normalize();
    const moonPos = earth.position.clone().addScaledVector(dir, -(moon.orbit!.a));
    return sunFraction(earth.position, sun.position, sun.radius * scale, moonPos, moon.radius);
  }

  test('with sunSizeScale the Moon umbra reaches Earth (total)', () => {
    expect(atEarth(config.eclipse.sunSizeScale)).toBe(0);
    // Analytic: umbra length from the Moon exceeds the Moon to Earth distance.
    const D = earth.position.distanceTo(sun.position) - moon.orbit!.a;
    const rs = sun.radius * config.eclipse.sunSizeScale;
    const umbraLen = (D * moon.radius) / (rs - moon.radius);
    expect(umbraLen).toBeGreaterThan(moon.orbit!.a);
  });

  test('at the true sun size the Moon gives an annular eclipse only', () => {
    const v = atEarth(1);
    expect(v).toBeGreaterThan(0.05);
    expect(v).toBeLessThan(0.95);
    const D = earth.position.distanceTo(sun.position) - moon.orbit!.a;
    expect((D * moon.radius) / (sun.radius - moon.radius)).toBeLessThan(moon.orbit!.a);
  });

  test('Io shadow reaches Jupiter, and Titan shadow reaches Saturn', () => {
    for (const [pid, mid] of [['jupiter', 'io'], ['saturn', 'titan']] as const) {
      const p = w.universe.get(pid);
      const m = w.universe.get(mid);
      const D = p.position.distanceTo(sun.position) - m.orbit!.a;
      const rs = sun.radius * config.eclipse.sunSizeScale;
      const umbraLen = (D * m.radius) / (rs - m.radius);
      expect(umbraLen).toBeGreaterThan(m.orbit!.a - p.radius);
    }
  });
});

describe('umbra tint', () => {
  const sun = { x: 0, y: 0, z: 0 };
  const prm = { sunSizeScale: 0.45, umbra: [0.07, 0.0245, 0.0084] as const, soft: 1 };
  const out = new Vector3();
  const mk = (atmo: boolean): Occluder[] => [{ x: 1e8, y: 0, z: 0, r: 1e6, atmo, id: 3 }];
  const p = { x: 1.2e8, y: 0, z: 0 };

  test('an atmosphere leaves a dim coloured light, a bare rock leaves none', () => {
    const bare = eclipseLightMath(p, sun, 3e6, mk(false), 1, -1, prm, out).clone();
    expect(bare.length()).toBeLessThan(1e-6);
    const air = eclipseLightMath(p, sun, 3e6, mk(true), 1, -1, prm, out).clone();
    expect(air.x).toBeGreaterThan(air.y);
    expect(air.y).toBeGreaterThan(air.z);
    expect(air.x).toBeCloseTo(0.07, 3);
  });

  test('the occluder itself is skipped', () => {
    eclipseLightMath(p, sun, 3e6, mk(false), 1, 3, prm, out);
    expect(out.toArray()).toEqual([1, 1, 1]);
  });
});

describe('scenarios', () => {
  const w = new World(SOLAR_SYSTEM, 0);
  beforeEach(() => {
    config.eclipse.enabled = true;
  });

  test('earth-solar-eclipse places the ship inside the umbra', () => {
    SCENARIOS['earth-solar-eclipse']!.apply(w);
    w.universe.update(w.clock.time);
    eclipse.update(w, w.shipWorldPos);
    const earth = w.universe.get('earth');
    expect(eclipse.sunVisibilityAt(w.shipWorldPos, earth)).toBeLessThan(0.05);
  });

  test('moon-lunar-eclipse puts the Moon centre in the umbra of Earth', () => {
    SCENARIOS['moon-lunar-eclipse']!.apply(w);
    w.universe.update(w.clock.time);
    const moon = w.universe.get('moon');
    // Observer far from the Moon on the Earth line: stand at the Moon centre for the check.
    eclipse.update(w, moon.position);
    expect(eclipse.sunVisibilityAt(moon.position, moon)).toBeLessThan(umbraLuma()); // Earth has an atmosphere: red light, not black
  });

  test('earth-eclipse-orbit sees the Moon shadow on the sunlit side', () => {
    SCENARIOS['earth-eclipse-orbit']!.apply(w);
    w.universe.update(w.clock.time);
    const earth = w.universe.get('earth');
    eclipse.update(w, w.shipWorldPos);
    // Somewhere on the day side the sun is covered: walk the sphere.
    let dark = 0;
    const p = new Vector3();
    for (let i = 0; i < 4000; i++) {
      p.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(earth.radius * 1.001).add(earth.position);
      if (eclipse.sunVisibilityAt(p, earth) < 0.05) dark++;
    }
    expect(dark).toBeGreaterThan(0);
  });

  test('jupiter-io-shadow and saturn-moon-shadow find a cloud top shadow', () => {
    const cases = [
      ['jupiter-io-shadow', 'jupiter', 'io', 4 * 86400, 600],
      ['saturn-moon-shadow', 'saturn', 'titan', 12 * 86400 * 365.25, 4 * 3600],
    ] as const;
    for (const [name, pid, mid, span, step] of cases) {
      SCENARIOS[name]!.apply(w);
      w.universe.update(w.clock.time);
      const planet = w.universe.get(pid);
      eclipse.update(w, w.shipWorldPos);
      // The scenario time is the transit time: the shadow axis meets the cloud tops somewhere.
      const hit = findTransit(w.universe, pid, mid, 0, span, step, 0.3);
      expect(hit.time).toBeCloseTo(w.clock.time, 0);
      w.universe.update(hit.time);
      eclipse.update(w, w.shipWorldPos);
      // Io has no atmosphere (black); Titan has one (its umbra keeps the dim tint).
      expect(eclipse.sunVisibilityAt(hit.point, planet), name).toBeLessThan(umbraLuma());
    }
  });
});
