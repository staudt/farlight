import { describe, expect, test } from 'vitest';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { type BodyDef, type WeatherKind, effectsOf, findEffect } from '../src/data/types';
import { geyserSites } from '../src/render/weather/plumes';

const DASH = /[-‐-―−]/;
const body = (id: string): BodyDef => SOLAR_SYSTEM.bodies.find((b) => b.id === id)!;
const kinds = (def: BodyDef): WeatherKind[] => effectsOf(def).map((e) => e.kind);

describe('Sol effects', () => {
  test('each world gets its signature effects from data', () => {
    expect(kinds(body('venus'))).toEqual(expect.arrayContaining(['acidRain', 'heatShimmer']));
    expect(kinds(body('mercury'))).toEqual(expect.arrayContaining(['heatShimmer', 'scorching']));
    expect(kinds(body('io'))).toContain('volcanicPlume');
    expect(kinds(body('europa'))).toContain('geyser');
    expect(kinds(body('mars'))).toContain('dustDevil');
    expect(kinds(body('titan'))).toContain('methaneRain');
  });

  test('airless worlds keep effects outside the atmosphere', () => {
    for (const id of ['mercury', 'io', 'europa']) {
      expect(body(id).atmosphere).toBeUndefined();
      expect(effectsOf(body(id)).length).toBeGreaterThan(0);
    }
  });

  test('plumes stand on real volcano features', () => {
    const feats = body('io').terrain!.features!.filter((f) => f.kind === 'volcano');
    expect(feats.length).toBeGreaterThan(0);
    expect(findEffect(body('io'), 'volcanicPlume')!.size).toBeGreaterThan(0.1);
  });

  test('hazard lines have no dashes', () => {
    for (const b of SOLAR_SYSTEM.bodies) for (const h of b.info.hazards ?? []) expect(h).not.toMatch(DASH);
    expect(body('venus').info.hazards).toContain('Acid rain');
    expect(body('mercury').info.hazards?.length).toBeGreaterThan(0);
  });
});

describe('generated effects', () => {
  const galaxy = createGalaxy();
  const stars = galaxy.stars.slice(1, 81);

  test('deterministic', () => {
    for (const s of stars.slice(0, 12)) expect(generateSystem(s)).toEqual(generateSystem(s));
  });

  test('archetypes carry their effects, and each effect shows up somewhere', () => {
    const seen = new Set<WeatherKind>();
    for (const s of stars) {
      for (const b of generateSystem(s).bodies) {
        const k = kinds(b);
        for (const x of k) seen.add(x);
        if (b.info.features.includes('Lava seas')) expect(k).toContain('volcanicPlume');
        if (k.includes('acidRain')) expect(k).toContain('heatShimmer');
        for (const h of b.info.hazards ?? []) expect(h).not.toMatch(DASH);
      }
    }
    for (const k of ['acidRain', 'heatShimmer', 'scorching', 'volcanicPlume', 'geyser', 'dustDevil'] as const) expect(seen.has(k)).toBe(true);
  });
});

describe('geyser sites', () => {
  test('are seeded and stay off the poles', () => {
    const a = geyserSites(29, 6);
    const b = geyserSites(29, 6);
    expect(a.map((g) => g.dir.toArray())).toEqual(b.map((g) => g.dir.toArray()));
    for (const g of a) {
      expect(g.dir.length()).toBeCloseTo(1, 5);
      expect(Math.abs(g.dir.y)).toBeLessThan(0.86);
    }
  });
});
