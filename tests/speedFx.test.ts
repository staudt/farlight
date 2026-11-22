import { describe, expect, it } from 'vitest';
import { VaporPulse, warpIntensity } from '../src/render/fx/speedFx';

describe('warpIntensity', () => {
  it('is zero without warp or motion', () => {
    expect(warpIntensity(5000, 1)).toBe(0);
    expect(warpIntensity(0, 1000)).toBe(0);
    expect(warpIntensity(10, 100)).toBe(0);
  });
  it('grows with the log of speed times warp and saturates', () => {
    const a = warpIntensity(1000, 1000);
    const b = warpIntensity(20000, 1000);
    const c = warpIntensity(1e6, 100000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBe(1);
  });
  it('fades out when the warp drops', () => {
    expect(warpIntensity(1e5, 1000)).toBeGreaterThan(warpIntensity(1e5, 40));
    expect(warpIntensity(1e5, 4)).toBe(0);
  });
});

describe('VaporPulse', () => {
  it('fires once on crossing the threshold, then fades', () => {
    const p = new VaporPulse();
    let peak = 0;
    for (let i = 0; i < 60; i++) peak = Math.max(peak, p.update(0.05, true, 0.8, 900, 1000));
    expect(peak).toBeGreaterThan(0.8);
    expect(p.value).toBe(0);
    expect(p.update(0.05, true, 0.8, 900, 1000)).toBe(0);
    p.update(0.05, true, 0.8, 100, 1000);
    expect(p.update(0.2, true, 0.8, 900, 1000)).toBeGreaterThan(0);
  });
  it('needs dense air', () => {
    const p = new VaporPulse();
    expect(p.update(0.2, true, 0.01, 900, 1000)).toBe(0);
  });
});
