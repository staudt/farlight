import { describe, expect, it } from 'vitest';
import { skyLook } from '../src/render/bodies/waterWaves';
import type { BodyDef } from '../src/data/types';

describe('skyLook', () => {
  it('has no sky without an atmosphere', () => {
    expect(skyLook({} as BodyDef).has).toBe(false);
  });
  it('is bluer than red for a Rayleigh atmosphere and finite', () => {
    const s = skyLook({ atmosphere: { rayleighDepth: [0.05, 0.11, 0.27], mieDepth: 0.1 } } as unknown as BodyDef);
    expect(s.has).toBe(true);
    expect(s.zenith[2]).toBeGreaterThan(s.zenith[0]);
    for (const c of [...s.zenith, ...s.horizon]) expect(Number.isFinite(c)).toBe(true);
  });
});
