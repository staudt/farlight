import { describe, expect, it } from 'vitest';
import { activityOf, discPixelRadius, prominenceArcs, starLook, surfaceDetail } from '../src/render/bodies/sun/starLook';

describe('starLook', () => {
  it('derives heat from the colour: red dwarf cool, blue star hot', () => {
    const red = starLook({ color: [1, 0.45, 0.2] }, [1, 1, 1], 1);
    const sun = starLook({ color: [1, 0.93, 0.8] }, [1, 1, 1], 1);
    const blue = starLook({ color: [0.62, 0.76, 1] }, [1, 1, 1], 1);
    expect(red.heat).toBeLessThan(sun.heat);
    expect(sun.heat).toBeLessThan(blue.heat);
    expect(red.granuleContrast).toBeLessThan(blue.granuleContrast);
    // Blue light darkens most toward the limb, so the rim reddens.
    expect(sun.limbU[2]).toBeGreaterThan(sun.limbU[0]);
  });

  it('more activity means a lower spot threshold and more faculae', () => {
    const lo = starLook({ color: [1, 0.9, 0.8], activity: 0.1 }, [1, 1, 1], 1);
    const hi = starLook({ color: [1, 0.9, 0.8], activity: 0.9 }, [1, 1, 1], 1);
    expect(hi.spotThreshold).toBeLessThan(lo.spotThreshold);
    expect(hi.faculae).toBeGreaterThan(lo.faculae);
  });

  it('falls back to a stable activity from the seed', () => {
    expect(activityOf(undefined, 42)).toBe(activityOf(undefined, 42));
    expect(activityOf({ activity: 2 }, 1)).toBe(1);
  });
});

describe('prominenceArcs', () => {
  it('is deterministic and a prefix of a longer list', () => {
    const a = prominenceArcs(7, 3);
    const b = prominenceArcs(7, 6);
    expect(b.slice(0, 3)).toEqual(a);
  });

  it('has unit centres with tangents across them', () => {
    for (const arc of prominenceArcs(3, 6)) {
      const [x, y, z] = arc.centre;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      const dot = x * arc.tangent[0] + y * arc.tangent[1] + z * arc.tangent[2];
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    }
  });
});

describe('surfaceDetail', () => {
  it('stays off for a small sky disc and is full when big', () => {
    expect(surfaceDetail(6, 40, 200)).toBe(0);
    expect(surfaceDetail(300, 40, 200)).toBe(1);
    expect(surfaceDetail(120, 40, 200)).toBeGreaterThan(0);
    expect(surfaceDetail(120, 40, 200)).toBeLessThan(1);
  });

  it('pixel radius of the Sun from Earth is tiny', () => {
    const r = 6.957e8 * 0.005;
    const px = discPixelRadius(r, 1.496e11 * 0.001, 62, 1080);
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThan(40);
  });
});
