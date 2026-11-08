import { describe, expect, it } from 'vitest';
import { weatherAmount } from '../src/render/weather/weatherMap';

describe('weatherAmount', () => {
  const rain = { kind: 'rain', intensity: 0.5, latitudeBand: [0, 0.9] } as const;
  const dir = (lat: number, lon: number) => ({ x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: -Math.cos(lat) * Math.sin(lon) });

  it('is zero outside the latitude band', () => {
    expect(weatherAmount(rain, dir(1.4, 0.3), 0)).toBe(0);
  });

  it('comes and goes over time and place, always within 0..1', () => {
    let on = 0;
    let off = 0;
    for (let t = 0; t < 4000; t += 97) {
      for (let lon = 0; lon < 6; lon += 0.7) {
        const a = weatherAmount(rain, dir(0.4, lon), t);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        if (a > 0.3) on++;
        else off++;
      }
    }
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(on);
  });
});
