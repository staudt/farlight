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
import {
  cabinTargets,
  chordNotes,
  cueForNotify,
  emptyScene,
  makePhrase,
  musicMood,
  padMood,
  phraseDelay,
  pickScale,
  scaleNote,
  soundscapeTargets,
  tonicOf,
} from '../src/audio/soundscape';

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

describe('soundscape targets', () => {
  const sc = emptyScene();
  const air = { density: 1, speed: 100, landed: false, altitude: 500, hasAtmosphere: true, atmosphereDepth: 1 };
  const vac = { density: 0, speed: 100, landed: false, altitude: 1e6, hasAtmosphere: true, atmosphereDepth: 0 };

  test('quiet by default', () => {
    const t = soundscapeTargets(air, sc);
    expect(t.rainHiss + t.dustGust + t.gasRoar + t.pressure + t.plumeRumble + t.beltShimmer + t.cometChime).toBe(0);
    expect(t.snowMuffle).toBe(1);
  });
  test('rain needs air; acid adds fizz; methane is softer', () => {
    expect(soundscapeTargets(air, { ...sc, rain: 1 }).rainHiss).toBeGreaterThan(0);
    expect(soundscapeTargets(vac, { ...sc, rain: 1 }).rainHiss).toBe(0);
    expect(soundscapeTargets(air, { ...sc, acid: 1 }).acidFizz).toBeGreaterThan(soundscapeTargets(air, { ...sc, rain: 1 }).acidFizz);
    const soft = soundscapeTargets(air, { ...sc, methane: 1 });
    const rain = soundscapeTargets(air, { ...sc, rain: 1 });
    expect(soft.rainCutoff).toBeLessThan(rain.rainCutoff);
    expect(soft.rainPatter).toBeLessThan(rain.rainPatter);
  });
  test('snow muffles', () => {
    expect(soundscapeTargets(air, { ...sc, snow: 1 }).snowMuffle).toBeLessThan(0.5);
  });
  test('gas, heavy air and dust scale with depth and amount', () => {
    expect(soundscapeTargets(air, { ...sc, gas: 1 }).gasRoar).toBeGreaterThan(0.3);
    const shallow = soundscapeTargets({ ...air, atmosphereDepth: 0.1 }, { ...sc, heavy: 1 });
    expect(shallow.pressure).toBeLessThan(soundscapeTargets(air, { ...sc, heavy: 1 }).pressure);
    expect(soundscapeTargets(air, { ...sc, dust: 1 }).dustGrit).toBeGreaterThan(0);
  });
  test('heat crackle is louder in vacuum, belts and comets switch on', () => {
    const a = soundscapeTargets(air, { ...sc, heat: 1 });
    const v = soundscapeTargets(vac, { ...sc, heat: 1 });
    expect(v.crackleGain).toBeGreaterThan(a.crackleGain);
    expect(v.crackleRate).toBeGreaterThan(0);
    expect(soundscapeTargets(vac, { ...sc, belt: 1 }).beltShimmer).toBeGreaterThan(0);
    expect(soundscapeTargets(vac, { ...sc, comet: 0.02 }).cometChime).toBe(0);
    expect(soundscapeTargets(vac, { ...sc, comet: 0.8 }).cometChime).toBeGreaterThan(0);
  });
});

describe('cockpit versus chase', () => {
  test('cockpit muffles outside, boosts engine, adds hum and rush', () => {
    const c = cabinTargets(true, 150, 200, 1);
    const o = cabinTargets(false, 150, 200, 1);
    expect(c.outsideCutoff).toBeLessThan(o.outsideCutoff);
    expect(c.outsideGain).toBeLessThan(o.outsideGain);
    expect(c.engineBoost).toBeGreaterThan(o.engineBoost);
    expect(c.humGain).toBeGreaterThan(0);
    expect(o.humGain).toBe(0);
    expect(cabinTargets(true, 190, 200, 1).rushGain).toBeGreaterThan(cabinTargets(true, 10, 200, 1).rushGain);
  });
});

describe('music', () => {
  const sc = emptyScene();
  const f = { density: 1, speed: 50, landed: false, altitude: 500, hasAtmosphere: true, atmosphereDepth: 1 };

  test('mood follows context', () => {
    expect(musicMood({ ...f, density: 0, atmosphereDepth: 0, altitude: 1e6 }, sc)).toBe('space');
    expect(musicMood(f, { ...sc, day: 1 })).toBe('day');
    expect(musicMood(f, { ...sc, day: 0 })).toBe('night');
    expect(musicMood(f, { ...sc, alien: 1 })).toBe('alien');
  });
  test('scale choice is deterministic and varies with the seed', () => {
    for (const mood of ['space', 'day', 'night', 'alien'] as const) {
      expect(pickScale(1234, mood)).toBe(pickScale(1234, mood));
    }
    const names = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => pickScale(s, 'alien').name));
    expect(names.size).toBeGreaterThan(2);
    expect(tonicOf(77)).toBe(tonicOf(77));
    expect(tonicOf(77)).toBeLessThan(12);
  });
  test('chords have six voices in range, mood changes the register', () => {
    for (const mood of ['space', 'day', 'night', 'alien'] as const) {
      const scale = pickScale(5, mood);
      const ch = chordNotes(tonicOf(5), scale, 2, mood);
      expect(ch).toHaveLength(6);
      for (const n of ch) {
        expect(n).toBeGreaterThan(20);
        expect(n).toBeLessThan(110);
      }
    }
    const sp = pickScale(5, 'space');
    expect(chordNotes(0, sp, 0, 'day')[0]).toBeGreaterThan(chordNotes(0, sp, 0, 'space')[0]!);
    expect(padMood('night').levels.filter((l) => l === 0).length).toBeGreaterThan(0);
  });
  test('phrases are short, in scale and deterministic', () => {
    const scale = pickScale(9, 'night');
    const a = makePhrase(9, 3, scale, tonicOf(9), 'night');
    expect(a).toEqual(makePhrase(9, 3, scale, tonicOf(9), 'night'));
    expect(a.notes.length).toBeGreaterThanOrEqual(3);
    expect(a.notes.length).toBeLessThanOrEqual(5);
    const pcs = scale.steps.map((s) => (s + tonicOf(9)) % 12);
    for (const n of a.notes) expect(pcs).toContain(n % 12);
    for (const g of a.gaps) expect(g).toBeGreaterThan(0.5);
  });
  test('phrase delay is one to three minutes', () => {
    expect(phraseDelay(0)).toBe(60);
    expect(phraseDelay(1)).toBe(180);
    expect(phraseDelay(5)).toBe(180);
  });
  test('scaleNote wraps octaves', () => {
    const s = pickScale(1, 'day');
    const n = s.steps.length;
    expect(scaleNote(60, s, n)).toBe(72);
    expect(scaleNote(60, s, -1)).toBe(60 - 12 + s.steps[n - 1]!);
  });
});

describe('notify cues', () => {
  test('survey and landmarks chime, snapshots do not', () => {
    expect(cueForNotify('Earth', 'SURVEYED')).toBe('discovery');
    expect(cueForNotify('Old Tower', 'LANDMARK DISCOVERED')).toBe('discovery');
    expect(cueForNotify('SNAPSHOT SAVED', '')).toBe('none');
    expect(cueForNotify('GAMEPAD', 'CONNECTED')).toBe('tick');
  });
});
