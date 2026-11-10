import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { DEFAULT_SCALE } from '../src/data/scale';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { isBinaryStar } from '../src/data/spaceScenery';
import { Universe } from '../src/sim/universe';
import { ROCK_LEVELS, type Rock, beltDensity, cometState, cometTails, scaleBelts, scaleComets, rockInCell } from '../src/render/space/spaceData';

const galaxy = createGalaxy();
const generated = galaxy.stars.filter((s) => s.id !== 'sol');

const blank = (): Rock => ({ x: 0, y: 0, z: 0, size: 0, sx: 0, sy: 0, sz: 0, ax: 0, ay: 0, az: 0, spin: 0, phase: 0, tone: 0 });

describe('asteroid belts', () => {
  const belts = scaleBelts(SOLAR_SYSTEM, DEFAULT_SCALE);
  const main = belts[0]!;

  test('scale like orbits', () => {
    expect(main.inner).toBeCloseTo(2.2 * 1.495978707e11 * DEFAULT_SCALE.planetOrbitScale, -3);
    expect(main.outer).toBeGreaterThan(main.inner);
  });

  test('density lives inside the belt only', () => {
    expect(beltDensity(main, main.mid, 0)).toBeGreaterThan(0.9);
    expect(beltDensity(main, main.inner * 0.8, 0)).toBe(0);
    expect(beltDensity(main, main.outer * 1.2, 0)).toBe(0);
    expect(beltDensity(main, main.mid, main.halfThickness * 4)).toBeLessThan(0.001);
  });

  test('rocks are deterministic per cell and respect the belt profile', () => {
    let found = 0;
    for (let level = 0; level < ROCK_LEVELS.length; level++) {
      const cell = ROCK_LEVELS[level]!.cell;
      const b = Math.floor(main.mid / cell);
      for (let i = 0; i < 120; i++) {
        const a = blank();
        const c = blank();
        const ra = rockInCell(main, level, b + i, 0, 3, 1, a);
        const rc = rockInCell(main, level, b + i, 0, 3, 1, c);
        expect(ra).toBe(rc);
        if (ra) {
          expect(a).toEqual(c);
          found++;
        }
      }
    }
    expect(found).toBeGreaterThan(5);
    const L = ROCK_LEVELS[0]!;
    let outside = 0;
    for (let i = 0; i < 80; i++) if (rockInCell(main, 0, Math.floor((main.inner * 0.5) / L.cell) + i, 0, 0, 1, blank())) outside++;
    expect(outside).toBe(0);
  });

  test('km scale rocks exist at the large level', () => {
    const L = ROCK_LEVELS[2]!;
    const big = blank();
    let hit = false;
    const b0 = Math.floor(main.mid / L.cell);
    for (let i = -60; i < 60 && !hit; i++) for (let k = -3; k < 3 && !hit; k++) hit = rockInCell(main, 2, b0 + i, 0, k, 1, big);
    expect(hit).toBe(true);
    expect(big.size).toBeGreaterThan(900);
  });
});

describe('comets', () => {
  const comet = scaleComets(SOLAR_SYSTEM, DEFAULT_SCALE)[0]!;

  test('Sol has one comet inbound between 1 and 2 AU at the start', () => {
    const p = new Vector3();
    const v = new Vector3();
    cometState(comet, 0, p, v);
    const au = 1.495978707e11 * DEFAULT_SCALE.planetOrbitScale;
    expect(p.length() / au).toBeGreaterThan(1);
    expect(p.length() / au).toBeLessThan(2);
    expect(p.dot(v)).toBeLessThan(0); // falling toward the star
  });

  test('tails point away from the star, the dust tail lags the motion', () => {
    const p = new Vector3();
    const v = new Vector3();
    for (const day of [0, 10, 40, 70, 100]) {
      cometState(comet, day * 86400, p, v);
      const t = cometTails(p, v, new Vector3(0, 0, 0));
      const away = p.clone().normalize();
      expect(t.ion.dot(away)).toBeCloseTo(1, 6);
      expect(t.dust.dot(away)).toBeGreaterThan(0.9);
      const perp = v.clone().addScaledVector(away, -v.dot(away)).normalize();
      expect(t.dust.dot(perp)).toBeLessThan(0);
    }
  });
});

describe('binary stars', () => {
  const binaries = generated.filter((s) => isBinaryStar(s));

  test('about 15% of generated systems', () => {
    const f = binaries.length / generated.length;
    expect(f).toBeGreaterThan(0.07);
    expect(f).toBeLessThan(0.25);
    expect(isBinaryStar({ id: 'sol', seed: 1 })).toBe(false);
  });

  test('the companion orbits far outside the planets and keeps the root as the light source', () => {
    let seen = 0;
    for (const s of binaries.slice(0, 12)) {
      const sys = generateSystem(s);
      const companion = sys.bodies.find((b) => b.id === 'starb');
      if (!companion) continue; // wide systems skip it to stay inside the sky sphere
      seen++;
      expect(sys.bodies[0]!.id).toBe('star');
      expect(companion.kind).toBe('star');
      expect(companion.parentId).toBe('star');
      const u = new Universe(sys);
      expect(u.root.id).toBe('star');
      const comp = u.get('starb');
      const planets = u.bodies.filter((b) => b.parent === u.root && b.kind !== 'star');
      const outer = Math.max(...planets.map((p) => p.orbit!.a * (1 + p.orbit!.e)));
      expect(comp.orbit!.a * (1 - comp.orbit!.e)).toBeGreaterThan(outer * 1.5);
      expect(Number.isFinite(comp.soiRadius)).toBe(true);
      // Planets keep their own sphere of influence; the companion never swallows space.
      for (const p of planets) expect(u.dominantBody(p.position)).toBe(p);
      expect(u.dominantBody(new Vector3(1, 0, 0))).toBe(u.root);
    }
    expect(seen).toBeGreaterThan(3);
  });

  test('non binary systems have no companion', () => {
    for (const s of generated.filter((g) => !isBinaryStar(g)).slice(0, 20)) {
      expect(generateSystem(s).bodies.some((b) => b.kind === 'star' && b.id !== 'star')).toBe(false);
    }
  });

  test('scenery is deterministic', () => {
    for (const s of generated.slice(0, 15)) expect(generateSystem(s)).toEqual(generateSystem(s));
    for (const s of generated.slice(0, 15)) {
      const sys = generateSystem(s);
      expect(sys.sky).toBeDefined();
      expect((sys.comets?.length ?? 0) <= 2).toBe(true);
    }
  });
});
