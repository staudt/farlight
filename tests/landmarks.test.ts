import { describe, expect, test } from 'vitest';
import { config } from '../src/core/config';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { landmarkKey, landmarkStamps, landmarksOf } from '../src/data/landmarks';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import type { BodyDef, LandmarkKind, StarSystemDef } from '../src/data/types';
import { type StorageLike, DiscoveryTracker, bodyExploration, clearProgress, discoveredKeys, loadProgress, markDiscovered, systemExploration } from '../src/sim/survey';
import { LandmarkTarget, surfaceDistance, withinDiscovery } from '../src/sim/landmarks';
import { World } from '../src/sim/world';
import { createHeightSampler } from '../src/terrain/heightfield';
import { Vector3 } from 'three';

const KINDS: LandmarkKind[] = ['arch', 'monolith', 'crystalCanyon', 'waterfall', 'craterLake', 'ruins', 'giantTree', 'iceSpire', 'geyserField', 'glowingPool', 'canyon', 'summit', 'mesa', 'crater', 'lander'];
const DASH = /[-‐-―−]/;
const galaxy = createGalaxy();
const systems: StarSystemDef[] = galaxy.stars.slice(0, 41).map((s) => generateSystem(s));

function mockStorage(initial: string | null = null): StorageLike & { raw: string | null } {
  const st = {
    raw: initial,
    getItem: () => st.raw,
    setItem: (_k: string, v: string) => {
      st.raw = v;
    },
  };
  return st;
}

describe('landmark data', () => {
  test('Sol has about a dozen named, valid landmarks on bodies with terrain', () => {
    const all = SOLAR_SYSTEM.bodies.flatMap((b) => landmarksOf(b).map((l) => ({ b, l })));
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const { b, l } of all) {
      expect(b.terrain, b.id).toBeDefined();
      expect(KINDS).toContain(l.kind);
      expect(l.name.length).toBeGreaterThan(2);
      expect(Math.abs(l.lat)).toBeLessThanOrEqual(Math.PI / 2);
      expect(Math.abs(l.lon)).toBeLessThanOrEqual(Math.PI);
      expect(l.radius).toBeGreaterThan(0);
      expect(l.radius).toBeLessThan(0.2);
      expect(DASH.test(l.name + l.description)).toBe(false);
    }
    for (const want of ['victoria_falls', 'olympus_caldera', 'tranquility', 'valles_floor', 'grand_canyon', 'uluru', 'everest', 'shackleton', 'loki_patera', 'conamara', 'kraken_mare', 'caloris']) {
      expect(all.some((e) => e.l.id === want), want).toBe(true);
    }
  });

  test('every system keeps ids unique per body, valid fields and no dashes', () => {
    let rocky = 0;
    for (const sys of systems) {
      for (const b of sys.bodies) {
        const lms = landmarksOf(b);
        if (b.kind !== 'rocky' || !b.terrain) {
          expect(lms.length, `${sys.id}/${b.id}`).toBe(0);
          continue;
        }
        rocky++;
        expect(lms.length, `${sys.id}/${b.id}`).toBeGreaterThanOrEqual(0);
        if (sys.id !== 'sol') expect(lms.length).toBeLessThanOrEqual(4);
        expect(new Set(lms.map((l) => l.id)).size).toBe(lms.length);
        for (const l of lms) {
          expect(KINDS).toContain(l.kind);
          if (sys.id !== 'sol') expect(l.name.startsWith('The ')).toBe(true);
          expect(DASH.test(l.name + l.description)).toBe(false);
          expect(l.radius).toBeGreaterThan(0);
          expect(l.radius).toBeLessThanOrEqual(0.06);
        }
      }
    }
    expect(rocky).toBeGreaterThan(40);
    // Most rocky worlds got at least one.
    const withLm = systems.flatMap((s) => s.bodies).filter((b) => landmarksOf(b).length > 0).length;
    expect(withLm).toBeGreaterThan(rocky * 0.7);
  });

  test('generated landmarks stand on dry land', () => {
    for (const sys of systems.slice(1, 12)) {
      for (const b of sys.bodies) {
        const lms = landmarksOf(b);
        if (lms.length === 0) continue;
        const R = b.physical.radius * 0.1;
        const bare: BodyDef = { ...b, landmarks: undefined };
        const sampler = createHeightSampler(bare, R);
        for (const l of lms) {
          const c = Math.cos(l.lat);
          const s = { x: 0, y: 0, z: 0, n: 0, height: 0, water: false, depth: 0, depthN: 0, moisture: 0, ice: 0, lat: 0 };
          sampler.sample(c * Math.cos(l.lon), Math.sin(l.lat), -c * Math.sin(l.lon), s);
          expect(s.water, `${sys.id}/${b.id}/${l.id}`).toBe(false);
        }
      }
    }
  });

  test('generation is deterministic', () => {
    const star = galaxy.stars[5]!;
    expect(JSON.stringify(generateSystem(star))).toBe(JSON.stringify(generateSystem(star)));
  });

  test('keys join system, body and landmark', () => {
    expect(landmarkKey('sol', 'earth', 'uluru')).toBe('sol/earth/uluru');
  });
});

describe('landmark terrain stamps', () => {
  test('a crater lake digs a bowl and a cliff raises ground, only where asked', () => {
    const moon = SOLAR_SYSTEM.bodies.find((b) => b.id === 'moon')!;
    const lm = landmarksOf(moon).find((l) => l.id === 'shackleton')!;
    const R = moon.physical.radius * 0.1;
    const with_ = createHeightSampler(moon, R);
    const without = createHeightSampler({ ...moon, landmarks: undefined }, R);
    const c = Math.cos(lm.lat);
    const d = [c * Math.cos(lm.lon), Math.sin(lm.lat), -c * Math.sin(lm.lon)] as const;
    expect(with_.heightAt(...d)).toBeLessThan(without.heightAt(...d) - 50);
    // Far away both agree.
    expect(with_.heightAt(1, 0, 0)).toBe(without.heightAt(1, 0, 0));

    const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;
    const falls = landmarksOf(earth).find((l) => l.id === 'victoria_falls')!;
    const stamps = landmarkStamps(falls, earth.terrain!);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.kind).toBe('cliff');
    expect(landmarkStamps({ ...falls, noStamp: true }, earth.terrain!)).toHaveLength(0);
  });

  test('a body without landmarks is untouched', () => {
    const mars = SOLAR_SYSTEM.bodies.find((b) => b.id === 'mars')!;
    const a = createHeightSampler({ ...mars, landmarks: undefined }, 338950);
    const b = createHeightSampler({ ...mars, landmarks: [] }, 338950);
    expect(a.heightAt(0, 1, 0)).toBe(b.heightAt(0, 1, 0));
  });
});

describe('discovery', () => {
  test('radius and altitude rule', () => {
    const c = config.landmarks;
    expect(withinDiscovery(c.discoverRadius - 1, c.discoverAltitude - 1, false)).toBe(true);
    expect(withinDiscovery(c.discoverRadius + 1, 100, false)).toBe(false);
    expect(withinDiscovery(100, c.discoverAltitude + 1, false)).toBe(false);
    // Landing a bit further out still counts.
    expect(withinDiscovery(c.discoverRadius + 1000, 0, true)).toBe(true);
    expect(withinDiscovery(c.landedRadius + 1, 0, true)).toBe(false);
  });

  test('surface distance is the great circle at the base radius', () => {
    const a = new Vector3(1, 0, 0);
    const b = new Vector3(0, 1, 0);
    expect(surfaceDistance(a, b, 1000)).toBeCloseTo((Math.PI / 2) * 1000, 6);
    expect(surfaceDistance(a, a, 1000)).toBe(0);
  });

  test('the tracker discovers a landmark once, from close by, and stores it', () => {
    const w = new World(SOLAR_SYSTEM);
    const moon = w.universe.get('moon');
    const lm = w.landmarks.of(moon).find((l) => l.def.id === 'tranquility')!;
    expect(lm).toBeInstanceOf(LandmarkTarget);
    const st = mockStorage();
    const tracker = new DiscoveryTracker(w, st);
    const found: string[] = [];
    tracker.onDiscovered = (l) => found.push(l.key);

    // 15 km away at low altitude: nothing.
    w.place({ body: 'moon', lat: 0.67 + 5, lon: 23.47, altitude: 300 });
    tracker.update();
    expect(found).toEqual([]);

    // 900 m away, low: discovered.
    w.place({ body: 'moon', lat: 0.67 + 0.3, lon: 23.47, altitude: 300 });
    tracker.update();
    expect(found).toEqual(['sol/moon/tranquility']);
    expect(lm.discovered).toBe(true);
    expect(lm.name).toBe('Tranquility Base');
    expect(loadProgress(st).landmarks).toEqual(['sol/moon/tranquility']);

    // Again: no second event.
    tracker.update();
    expect(found).toHaveLength(1);

    // High above: other landmarks of the Moon stay hidden.
    expect(w.landmarks.of(moon).filter((l) => l.discovered)).toHaveLength(1);
  });

  test('too high does not discover', () => {
    const w = new World(SOLAR_SYSTEM);
    const tracker = new DiscoveryTracker(w, mockStorage());
    w.place({ body: 'moon', lat: 0.67, lon: 23.47, altitude: config.landmarks.discoverAltitude + 3000 });
    tracker.update();
    expect(w.landmarks.all.some((l) => l.discovered)).toBe(false);
  });

  test('an undiscovered landmark hides its name', () => {
    const w = new World(SOLAR_SYSTEM);
    const l = w.landmarks.all[0]!;
    expect(l.name).toBe('UNKNOWN');
    l.discovered = true;
    expect(l.name).toBe(l.def.name);
  });
});

describe('survey math', () => {
  const moon = SOLAR_SYSTEM.bodies.find((b) => b.id === 'moon')!;
  const n = landmarksOf(moon).length;

  test('a body counts itself plus its landmarks', () => {
    const none = bodyExploration({ visited: [], surveyed: [] }, 'sol', moon);
    expect(none).toEqual({ done: 0, total: 1 + n, fraction: 0 });
    const surveyed = bodyExploration({ visited: [], surveyed: ['sol/moon'] }, 'sol', moon);
    expect(surveyed.done).toBe(1);
    expect(surveyed.fraction).toBeCloseTo(1 / (1 + n), 10);
    const all = bodyExploration(
      { visited: [], surveyed: ['sol/moon'], landmarks: landmarksOf(moon).map((l) => landmarkKey('sol', 'moon', l.id)) },
      'sol',
      moon,
    );
    expect(all.fraction).toBe(1);
  });

  test('a body without landmarks still counts as one', () => {
    const e = bodyExploration({ visited: [], surveyed: ['x/a'] }, 'x', { id: 'a' });
    expect(e).toEqual({ done: 1, total: 1, fraction: 1 });
  });

  test('a system sums its bodies', () => {
    const defs = [moon, { id: 'plain' }];
    const p = { visited: [], surveyed: ['sol/moon', 'sol/plain'], landmarks: [landmarkKey('sol', 'moon', landmarksOf(moon)[0]!.id)] };
    const s = systemExploration(p, 'sol', defs);
    expect(s.done).toBe(3);
    expect(s.total).toBe(1 + n + 1);
    expect(systemExploration(p, 'sol', []).fraction).toBe(0);
  });

  test('progress storage round trips discoveries and clearProgress forgets them', () => {
    const st = mockStorage();
    expect(markDiscovered('sol/moon/tranquility', st)).toBe(true);
    expect(markDiscovered('sol/moon/tranquility', st)).toBe(false);
    expect([...discoveredKeys(loadProgress(st))]).toEqual(['sol/moon/tranquility']);
    clearProgress(st);
    expect(loadProgress(st).landmarks ?? []).toEqual([]);
  });

  test('old saves without landmarks load fine', () => {
    expect(loadProgress(mockStorage('{"visited":["sol"],"surveyed":["sol/earth"]}'))).toEqual({ visited: ['sol'], surveyed: ['sol/earth'] });
    expect(loadProgress(mockStorage('{"visited":[],"surveyed":[],"landmarks":[1,"a/b/c"]}')).landmarks).toEqual(['a/b/c']);
  });
});
