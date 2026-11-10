import { describe, expect, test } from 'vitest';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { Universe } from '../src/sim/universe';
import type { BodyDef, StarSystemDef } from '../src/data/types';
import { expectValidLayout } from './layoutCheck';

const galaxy = createGalaxy();
const sample = galaxy.stars.slice(0, 61); // sol plus 60 generated seeds
const generated = sample.filter((s) => s.id !== 'sol');

const DASH = /[-‐-―−]/;

function strings(sys: StarSystemDef): string[] {
  const out: string[] = [sys.name];
  for (const b of sys.bodies) out.push(b.name, b.info.type, b.info.atmosphere, b.info.temperature, b.info.summary, ...b.info.features);
  return out;
}

describe('galaxy', () => {
  test('is deterministic', () => {
    expect(createGalaxy(1977)).toEqual(galaxy);
    expect(createGalaxy(5).stars[3]).not.toEqual(galaxy.stars[3]);
  });

  test('has about 240 stars, unique ids and names, and Sol at home', () => {
    expect(galaxy.stars.length).toBe(240);
    expect(new Set(galaxy.stars.map((s) => s.id)).size).toBe(240);
    expect(new Set(galaxy.stars.map((s) => s.name)).size).toBe(240);
    const sol = galaxy.stars.find((s) => s.id === 'sol')!;
    expect(sol.name).toBe('Sol');
    expect(sol.starClass).toBe('G');
    expect(galaxy.homeId).toBe('sol');
    for (const s of galaxy.stars) {
      if (s.id !== 'sol') expect(s.id).toBe('s' + s.seed.toString(36));
      expect(Math.hypot(s.x, s.y)).toBeLessThan(galaxy.radius * 1.05);
      expect(DASH.test(s.name)).toBe(false);
    }
  });

  test('class mix leans to K, G and M', () => {
    const count = (c: string) => galaxy.stars.filter((s) => s.starClass === c).length;
    expect(count('M') + count('K') + count('G')).toBeGreaterThan(galaxy.stars.length * 0.7);
    expect(count('F') + count('A') + count('B')).toBeGreaterThan(5);
  });
});

describe('generateSystem', () => {
  test('sol returns the hand authored system', () => {
    expect(generateSystem(galaxy.stars.find((s) => s.id === 'sol')!)).toBe(SOLAR_SYSTEM);
  });

  test.each(generated.map((s) => [s.id, s] as const))('system %s', (_id, star) => {
    const sys = generateSystem(star);
    expect(generateSystem(star)).toEqual(sys); // deterministic
    expect(sys.id).toBe(star.id);

    // Builds a universe.
    const u = new Universe(sys);
    u.update(12345);

    // Planet count matches the map hint.
    const planets = sys.bodies.filter((b) => b.parentId === sys.bodies[0]!.id && b.kind !== 'star');
    expect(planets.length).toBe(star.planetCount);
    expect(star.planetCount).toBeGreaterThanOrEqual(2);
    expect(star.planetCount).toBeLessThanOrEqual(9);

    expectValidLayout(sys);

    // Ids are unique, parents come first.
    const ids = sys.bodies.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sys.bodies[0]!.kind).toBe('star');

    for (const s of strings(sys)) expect(DASH.test(s), s).toBe(false);

    for (const b of sys.bodies) {
      expect(['star', 'rocky', 'gas']).toContain(b.kind);
      if (b.kind === 'rocky') expect(b.terrain, b.id).toBeDefined();
      if (b.kind === 'gas') expect(b.gas, b.id).toBeDefined();
      if (b.kind === 'star') expect(b.star, b.id).toBeDefined();
      const a = b.atmosphere;
      if (a) {
        expect(a.height).toBeGreaterThanOrEqual(0.03);
        expect(a.height).toBeLessThanOrEqual(0.26);
        expect(a.scaleHeight).toBeGreaterThanOrEqual(0.1);
        expect(a.scaleHeight).toBeLessThanOrEqual(0.3);
        const peak = Math.max(...a.rayleighDepth);
        expect(peak, b.id).toBeGreaterThanOrEqual(0.03);
        expect(peak, b.id).toBeLessThanOrEqual(0.4);
        for (const c of a.rayleighDepth) expect(c).toBeGreaterThanOrEqual(0);
        expect(a.mieDepth).toBeGreaterThanOrEqual(0);
        expect(a.mieDepth).toBeLessThanOrEqual(0.4);
        expect(a.sunIntensity).toBeGreaterThanOrEqual(10);
        expect(a.sunIntensity).toBeLessThanOrEqual(26);
      }
      for (const c of b.visual.color) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

const tempOf = (t: string): number => (t.startsWith('minus ') ? -parseInt(t.slice(6), 10) : parseInt(t, 10));
const hasBiome = (b: BodyDef, name: string): boolean => b.terrain?.biomes.some((x) => x.name === name) ?? false;

describe('worlds', () => {
  const systems = galaxy.stars.filter((s) => s.id !== 'sol').slice(0, 40).map((s) => generateSystem(s));
  const planets = systems.flatMap((s) => s.bodies.filter((b) => b.kind === 'rocky' && b.parentId === s.bodies[0]!.id));

  test('at least half of 40 systems have a living world', () => {
    const living = systems.filter((s) => s.bodies.some((b) => b.parentId === s.bodies[0]!.id && b.terrain?.water !== undefined && b.atmosphere?.clouds !== undefined && b.terrain.props?.some((p) => p.kind === 'tree')));
    expect(living.length).toBeGreaterThanOrEqual(20);
  });

  test('temperatures are plausible by archetype', () => {
    for (const p of planets) {
      const t = tempOf(p.info.temperature);
      if (hasBiome(p, 'lava channel')) {
        expect(t).toBeGreaterThanOrEqual(300);
        expect(t).toBeLessThanOrEqual(1200);
      } else if (hasBiome(p, 'blue ice')) {
        expect(t).toBeGreaterThanOrEqual(-150);
        expect(t).toBeLessThanOrEqual(-20);
      } else if (hasBiome(p, 'beach')) {
        expect(t).toBeGreaterThanOrEqual(-15);
        expect(t).toBeLessThanOrEqual(40);
      } else if (hasBiome(p, 'sand')) {
        expect(t).toBeGreaterThanOrEqual(-80);
        expect(t).toBeLessThanOrEqual(60);
      }
    }
  });

  test('alien worlds have their own palette: black beaches and glowing props', () => {
    const aliens = planets.filter((p) => hasBiome(p, 'crystal field'));
    expect(aliens.length).toBeGreaterThan(3);
    for (const a of aliens) {
      const beach = a.terrain!.biomes.find((x) => x.name === 'beach')!;
      expect(Math.max(...beach.color)).toBeLessThan(0.15);
      expect(a.terrain!.props!.some((p) => p.kind === 'crystal')).toBe(true);
    }
  });

  test('lava worlds are dark crust with glow only in a narrow band', () => {
    const lavas = planets.filter((p) => hasBiome(p, 'lava channel'));
    expect(lavas.length).toBeGreaterThan(0);
    for (const l of lavas) {
      const biomes = l.terrain!.biomes;
      expect(biomes[0]!.name).toBe('lava channel');
      expect(biomes[0]!.maxHeight!).toBeLessThan(-0.05);
      expect(Math.max(...biomes[biomes.length - 1]!.color)).toBeLessThan(0.15);
    }
  });
});
