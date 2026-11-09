import { describe, test } from 'vitest';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { expectValidLayout } from './layoutCheck';

describe('system layout', () => {
  test('Sol: moons clear their parent atmosphere and planet spheres of influence do not overlap', () => {
    expectValidLayout(SOLAR_SYSTEM);
  });
});
