import { describe, expect, it } from 'vitest';
import { PROGRESS_STORAGE_KEY } from '../src/data/galaxy';
import { createGalaxy } from '../src/data/generate';
import { buildTravelUrl, findRoute, jumpSeconds, routeLength, starDistance, travelMinutes } from '../src/ui/galaxyMath';
import { loadProgress, markSurveyed, markVisited, surveyProgress, type StorageLike } from '../src/sim/survey';

const galaxy = createGalaxy();

function mockStorage(initial?: string): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(PROGRESS_STORAGE_KEY, initial);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('route finding', () => {
  it('starts and ends at the requested stars', () => {
    const from = galaxy.stars[0]!;
    const to = galaxy.stars[100]!;
    const r = findRoute(galaxy.stars, from.id, to.id);
    expect(r[0]).toBe(from);
    expect(r[r.length - 1]).toBe(to);
    expect(new Set(r.map((s) => s.id)).size).toBe(r.length);
  });

  it('makes monotonic progress toward the target', () => {
    const from = galaxy.stars.find((s) => s.id === galaxy.homeId)!;
    for (const to of galaxy.stars.slice(5, 60)) {
      const r = findRoute(galaxy.stars, from.id, to.id);
      const total = starDistance(from, to);
      // Progress along the straight line never goes backwards.
      let prevT = -Infinity;
      for (const s of r) {
        const t = ((s.x - from.x) * (to.x - from.x) + (s.y - from.y) * (to.y - from.y) + (s.z - from.z) * (to.z - from.z)) / (total * total);
        expect(t).toBeGreaterThanOrEqual(prevT);
        prevT = t;
      }
      expect(routeLength(r)).toBeGreaterThanOrEqual(total - 1e-6);
    }
  });

  it('handles same star and unknown ids', () => {
    expect(findRoute(galaxy.stars, 'sol', 'sol').length).toBe(1);
    expect(findRoute(galaxy.stars, 'sol', 'nope')).toEqual([]);
  });
});

describe('travel time', () => {
  it('follows the feel formula', () => {
    expect(travelMinutes(1000, 1)).toBeCloseTo(4);
    expect(travelMinutes(25000, 1)).toBeCloseTo(100);
    expect(travelMinutes(25000, 10)).toBeCloseTo(10);
  });
  it('clamps the cinematic to 3..12 seconds', () => {
    expect(jumpSeconds(10, 60)).toBe(3);
    expect(jumpSeconds(50000, 1)).toBe(12);
    expect(jumpSeconds(1000, 60)).toBe(4);
  });
});

describe('survey progress', () => {
  it('counts surveyed bodies of one system', () => {
    const p = { visited: ['a'], surveyed: ['a/x', 'a/y', 'b/x'] };
    expect(surveyProgress(p, 'a', ['x', 'y', 'z', 'w'])).toEqual({ done: 2, total: 4, fraction: 0.5 });
    expect(surveyProgress(p, 'c', ['x'])).toEqual({ done: 0, total: 1, fraction: 0 });
    expect(surveyProgress(p, 'a', []).fraction).toBe(0);
  });
});

describe('progress storage', () => {
  it('round trips visits and surveys without duplicates', () => {
    const st = mockStorage();
    expect(markVisited('sol', st)).toBe(true);
    expect(markVisited('sol', st)).toBe(false);
    expect(markSurveyed('sol', 'earth', st)).toBe(true);
    expect(markSurveyed('sol', 'earth', st)).toBe(false);
    expect(loadProgress(st)).toEqual({ visited: ['sol'], surveyed: ['sol/earth'] });
  });
  it('survives broken data and missing storage', () => {
    expect(loadProgress(mockStorage('{nope'))).toEqual({ visited: [], surveyed: [] });
    expect(loadProgress(mockStorage('{"visited":5,"surveyed":[1,"a/b"]}'))).toEqual({ visited: [], surveyed: ['a/b'] });
    expect(loadProgress(null)).toEqual({ visited: [], surveyed: [] });
    expect(markVisited('x', null)).toBe(true);
  });
});

describe('travel url', () => {
  it('keeps debug, quality and touch and adds the destination', () => {
    const u = buildTravelUrl('?debug&quality=low&scenario=atmo-entry&system=old', 's1abc', '/farlight/');
    const q = new URLSearchParams(u.split('?')[1]);
    expect(u.startsWith('/farlight/?')).toBe(true);
    expect(q.has('debug')).toBe(true);
    expect(q.get('quality')).toBe('low');
    expect(q.get('system')).toBe('s1abc');
    expect(q.get('arrive')).toBe('1');
    expect(q.has('scenario')).toBe(false);
  });
  it('works with no params', () => {
    expect(buildTravelUrl('', 'sol')).toBe('/?system=sol&arrive=1');
  });
});
