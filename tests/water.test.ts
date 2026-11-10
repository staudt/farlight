import { describe, expect, it } from 'vitest';
import type { BodyDef } from '../src/data/types';
import { waterLook } from '../src/render/bodies/waterWaves';

type Water = NonNullable<NonNullable<BodyDef['terrain']>['water']>;
const def = (water: Water | undefined, seaLevel: number | undefined): BodyDef =>
  ({ id: 'testworld', terrain: { seaLevel, water } }) as unknown as BodyDef;

describe('waterLook', () => {
  it('is inert on dry worlds', () => {
    expect(waterLook(def(undefined, undefined)).hasWater).toBe(false);
    expect(waterLook({ id: 'rock' } as unknown as BodyDef).foam).toBe(0);
  });

  it('defaults sensibly and is deterministic per body id', () => {
    const a = waterLook(def({ color: [0.1, 0.3, 0.6], deepColor: [0, 0.1, 0.3] }, 0));
    const b = waterLook(def({ color: [0.1, 0.3, 0.6], deepColor: [0, 0.1, 0.3] }, 0));
    expect(a.hasWater).toBe(true);
    expect(a.amplitude).toBe(1);
    expect(a.foam).toBe(1);
    expect(a.windDir).toBe(b.windDir);
  });

  it('tints foam lighter than the sea for alien colours', () => {
    const orange = waterLook(def({ color: [0.8, 0.35, 0.05], deepColor: [0.3, 0.1, 0] }, 0));
    expect(orange.foamColor[0]).toBeGreaterThan(0.8);
    expect(orange.foamColor[2]).toBeGreaterThan(0.05);
  });

  it('honours authored wave settings', () => {
    const l = waterLook(def({ color: [0.1, 0.3, 0.6], deepColor: [0, 0, 0], waves: { amplitude: 2, speed: 0.5, foam: 0, windDir: 1.25 } }, 0));
    expect([l.amplitude, l.speed, l.foam, l.windDir]).toEqual([2, 0.5, 0, 1.25]);
  });
});
