import { describe, expect, it } from 'vitest';
import { cloudRayOpticalDepth } from '../src/render/clouds/coverage';
import { cloudSunVisibility, flareEdgeFade, horizonDimming, sunOcclusion } from '../src/render/fx/lensFlare';
import { godRayStrength, sunEdgeFade } from '../src/render/fx/godRays';

const cam = { x: 0, y: 0, z: 0 };
const sun = { x: 1e6, y: 0, z: 0 };

describe('sun occlusion by bodies', () => {
  it('is 1 with nothing in the way', () => {
    expect(sunOcclusion(cam, sun, 0.005, [])).toBe(1);
    expect(sunOcclusion(cam, sun, 0.005, [{ position: { x: 1000, y: 5000, z: 0 }, radius: 100 }])).toBe(1);
  });
  it('is 0 when a sphere covers the sun, 1 behind the sun, and smooth across the limb', () => {
    const planet = { position: { x: 1000, y: 0, z: 0 }, radius: 100 };
    expect(sunOcclusion(cam, sun, 0.005, [planet])).toBe(0);
    expect(sunOcclusion(cam, sun, 0.005, [{ position: { x: 2e6, y: 0, z: 0 }, radius: 1e5 }])).toBe(1);
    const limb = Math.asin(100 / 1000);
    const mid = sunOcclusion(cam, { x: Math.cos(limb) * 1e6, y: Math.sin(limb) * 1e6, z: 0 }, 0.01, [planet]);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    const out = sunOcclusion(cam, { x: Math.cos(limb + 0.05) * 1e6, y: Math.sin(limb + 0.05) * 1e6, z: 0 }, 0.01, [planet]);
    expect(out).toBe(1);
  });
  it('ignores a sphere the camera is inside', () => {
    expect(sunOcclusion(cam, sun, 0.005, [{ position: { x: 10, y: 0, z: 0 }, radius: 100 }])).toBe(1);
  });
});

describe('flare dimming', () => {
  it('fades toward the horizon only inside air', () => {
    expect(horizonDimming(0.8, 1, 0.25)).toBeCloseTo(1, 3);
    expect(horizonDimming(0, 1, 0.25)).toBeLessThan(0.5);
    expect(horizonDimming(0, 0, 0.25)).toBe(1);
  });
  it('clouds block and edge fade works', () => {
    expect(cloudSunVisibility(0)).toBe(1);
    expect(cloudSunVisibility(3)).toBeLessThan(0.05);
    expect(flareEdgeFade(0, 0.12)).toBe(1);
    expect(flareEdgeFade(1, 0.12)).toBe(0);
    expect(sunEdgeFade(0)).toBe(1);
    expect(sunEdgeFade(5)).toBe(0);
  });
});

describe('god ray strength', () => {
  it('is zero in vacuum and stronger in murky air', () => {
    expect(godRayStrength({ density: 0, haze: 0, sinElev: 0.5 })).toBe(0);
    const earth = godRayStrength({ density: 0.8, haze: 0.012, sinElev: 0.5 });
    const titan = godRayStrength({ density: 0.8, haze: 0.35, sinElev: 0.5 });
    expect(titan).toBeGreaterThan(earth * 2);
    const sunrise = godRayStrength({ density: 0.8, haze: 0.012, sinElev: 0.02 });
    expect(sunrise).toBeGreaterThan(earth);
    expect(godRayStrength({ density: 0.8, haze: 0.012, sinElev: -0.5 })).toBe(0);
  });
});

describe('cloud ray optical depth', () => {
  const cl = { altitude: 0.08, thickness: 0.07, coverage: 1, color: [1, 1, 1] as [number, number, number], scale: 0.02, speed: 8 };
  const R = 637000;
  const H = 60000;
  it('is zero above the layer and positive through a full cover under it', () => {
    const up = { x: 0, y: 1, z: 0 };
    expect(cloudRayOpticalDepth(cl, R, H, { x: 0, y: R + 30000, z: 0 }, up, 0)).toBe(0);
    const under = cloudRayOpticalDepth(cl, R, H, { x: 0, y: R + 500, z: 0 }, up, 0);
    expect(under).toBeGreaterThan(0.5);
    const clear = cloudRayOpticalDepth({ ...cl, coverage: 0 }, R, H, { x: 0, y: R + 500, z: 0 }, up, 0, -1);
    expect(clear).toBeLessThan(under * 0.2);
  });
});
