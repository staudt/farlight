import { describe, expect, test } from 'vitest';
import {
  CHORDS,
  droneGain,
  engineTargets,
  midiToHz,
  surfaceTargets,
  thunderParams,
  windTargets,
  type AudioState,
} from '../src/audio/audio';

const base: AudioState = {
  phase: 'atmosphere',
  density: 1,
  atmosphereDepth: 1,
  throttle: 0.4,
  boosting: false,
  stress: 0,
  landed: false,
  speed: 100,
  speedCap: 200,
  altitude: 500,
  hasAtmosphere: true,
};
const space: AudioState = { ...base, phase: 'space', density: 0, atmosphereDepth: 0, altitude: 1e6 };

describe('engine mapping', () => {
  test('pitch and cutoff rise with throttle', () => {
    const lo = engineTargets({ ...base, throttle: 0.1 });
    const hi = engineTargets({ ...base, throttle: 0.9 });
    expect(hi.freq).toBeGreaterThan(lo.freq);
    expect(hi.cutoff).toBeGreaterThan(lo.cutoff);
    expect(hi.gain).toBeGreaterThan(lo.gain);
  });
  test('boost adds brightness and pitch', () => {
    const a = engineTargets(base);
    const b = engineTargets({ ...base, boosting: true });
    expect(b.boostGain).toBeGreaterThan(a.boostGain);
    expect(b.freq).toBeGreaterThan(a.freq);
  });
  test('quieter in vacuum and when landed', () => {
    expect(engineTargets(space).gain).toBeLessThan(engineTargets(base).gain);
    expect(engineTargets({ ...base, landed: true }).gain).toBeLessThan(0.1);
  });
});

describe('wind mapping', () => {
  test('silent in space, louder when faster', () => {
    expect(windTargets(space).gain).toBe(0);
    expect(windTargets({ ...base, speed: 150 }).gain).toBeGreaterThan(windTargets({ ...base, speed: 30 }).gain);
    expect(windTargets({ ...base, speed: 150 }).bandFreq).toBeGreaterThan(windTargets({ ...base, speed: 30 }).bandFreq);
  });
  test('stress drives the roar only in air', () => {
    expect(windTargets({ ...base, stress: 1 }).roar).toBeGreaterThan(0);
    expect(windTargets({ ...space, stress: 1 }).roar).toBe(0);
  });
  test('survives non finite input', () => {
    expect(windTargets({ ...base, speed: NaN, density: NaN }).gain).toBe(0);
  });
});

describe('drone and surface', () => {
  test('drone fades as the atmosphere thickens', () => {
    expect(droneGain(space)).toBeGreaterThan(droneGain(base));
  });
  test('chimes only low in an atmosphere', () => {
    expect(surfaceTargets(base).chimes).toBe(true);
    expect(surfaceTargets({ ...base, altitude: 5000 }).chimes).toBe(false);
    const airless = surfaceTargets({ ...base, hasAtmosphere: false, density: 0, landed: true });
    expect(airless.chimes).toBe(false);
    expect(airless.humGain).toBeGreaterThan(0);
    expect(airless.airGain).toBe(0);
  });
});

describe('thunder and music', () => {
  test('delay follows the speed of sound, far is quieter and duller', () => {
    const near = thunderParams(343);
    const far = thunderParams(6860);
    expect(near.delay).toBeCloseTo(1, 6);
    expect(far.delay).toBeCloseTo(20, 6);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.cutoff).toBeLessThan(near.cutoff);
  });
  test('chords are six voices at audible pitches', () => {
    for (const c of CHORDS) expect(c).toHaveLength(6);
    expect(midiToHz(69)).toBeCloseTo(440, 9);
  });
});
