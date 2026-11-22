import { describe, expect, it } from 'vitest';
import { DEBRIS_CLASSES, MAX_RING_GAPS, debrisGrid, debrisRange, discFade, packGaps, ringGaps, ringSpokes } from '../src/render/bodies/rings/profile';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';

describe('ring profile data', () => {
  it('derives the same gaps for the same seed and different ones otherwise', () => {
    const a = ringGaps(undefined, 42);
    const b = ringGaps(undefined, 42);
    const c = ringGaps(undefined, 43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBeGreaterThanOrEqual(3);
    for (const g of a) {
      expect(g.at).toBeGreaterThan(0);
      expect(g.at).toBeLessThan(1);
      expect(g.depth).toBeLessThanOrEqual(1);
    }
  });

  it('uses authored gaps when present and packs them to a fixed size', () => {
    const gaps = [{ at: 0.5, width: 0.1, depth: 0.9 }];
    expect(ringGaps({ gaps }, 1)).toEqual(gaps);
    const p = packGaps(gaps);
    expect(p.length).toBe(MAX_RING_GAPS * 3);
    expect(p.slice(0, 3)).toEqual([0.5, 0.05, 0.9]);
    expect(p.slice(3).every((v) => v === 0)).toBe(true);
  });

  it('Saturn carries a Cassini like division and an Encke like gap', () => {
    const saturn = SOLAR_SYSTEM.bodies.find((b) => b.id === 'saturn')!;
    const gaps = saturn.rings!.gaps!;
    expect(gaps.some((g) => g.width > 0.06 && g.depth > 0.9)).toBe(true);
    expect(gaps.some((g) => g.width < 0.03 && g.at > 0.85)).toBe(true);
    expect(ringSpokes(saturn.rings)).toBeGreaterThan(0);
  });
});

describe('ring debris', () => {
  it('has pebble to house sized classes with growing cells', () => {
    expect(DEBRIS_CLASSES[0]!.minSize).toBeLessThan(0.3);
    expect(DEBRIS_CLASSES[DEBRIS_CLASSES.length - 1]!.maxSize).toBeGreaterThan(30);
    for (let i = 1; i < DEBRIS_CLASSES.length; i++) expect(DEBRIS_CLASSES[i]!.cell).toBeGreaterThan(DEBRIS_CLASSES[i - 1]!.cell);
  });

  it('quality levels scale the grids', () => {
    expect(debrisGrid(0, 3)).toBe(0);
    expect(debrisGrid(1, 0)).toBe(0);
    expect(debrisGrid(1, 3)).toBeGreaterThan(0);
    expect(debrisGrid(2, 0)).toBeGreaterThan(debrisGrid(1, 3));
    expect(debrisRange(22, 55)).toBeGreaterThan(debrisRange(14, 55));
  });

  it('the disc fades near the camera only when it is close to the plane', () => {
    // On the plane, close: gone. Far away: back. High above the plane: untouched.
    expect(discFade(10, 0, 300, 12, 150, 1800)).toBeCloseTo(0, 5);
    expect(discFade(5000, 0, 300, 12, 150, 1800)).toBeCloseTo(1, 5);
    expect(discFade(10, 50000, 300, 12, 150, 1800)).toBeCloseTo(1, 5);
    const mid = discFade(900, 0, 300, 12, 150, 1800);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
  });
});
