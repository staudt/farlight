import { hashInts, mulberry32 } from '../core/rng';

/**
 * Pure mappings from world state to sound. No Web Audio here: everything is a number in, a number
 * out, so it is unit tested. Nothing looks at body names, only at data derived fields.
 */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Everything the ambience reads beyond the flight state. All fields 0..1 unless noted. */
export interface SceneState {
  rain: number;
  snow: number;
  acid: number;
  methane: number;
  dust: number;
  devil: number;
  /** Inside the atmosphere of a gas body. */
  gas: number;
  /** Heavy, thick air (crushing pressure). */
  heavy: number;
  /** Searing heat on the day side. */
  heat: number;
  /** Close to volcanic plumes and geysers. */
  plume: number;
  /** Inside an asteroid belt. */
  belt: number;
  /** Near an active comet. */
  comet: number;
  /** Daylight at the ship: 0 night .. 1 day. */
  day: number;
  /** How exotic the place feels: 0 familiar .. 1 alien. */
  alien: number;
  /** Mixed system and body seed, for the music. */
  seed: number;
}

export function emptyScene(): SceneState {
  return {
    rain: 0,
    snow: 0,
    acid: 0,
    methane: 0,
    dust: 0,
    devil: 0,
    gas: 0,
    heavy: 0,
    heat: 0,
    plume: 0,
    belt: 0,
    comet: 0,
    day: 1,
    alien: 0,
    seed: 0,
  };
}

/** Inputs of the soundscape that duplicate AudioState fields (kept structural to avoid a cycle). */
export interface FlightLike {
  density: number;
  speed: number;
  landed: boolean;
  altitude: number;
  hasAtmosphere: boolean;
  atmosphereDepth: number;
}

export interface SoundscapeTargets {
  /** Rain: broadband hiss level, patter level and the hiss low-pass. */
  rainHiss: number;
  rainPatter: number;
  rainCutoff: number;
  /** Fizzy high hiss for acid rain. */
  acidFizz: number;
  /** Snow: outside low-pass multiplier (1 = clear) and a faint hush level. */
  snowMuffle: number;
  snowHush: number;
  /** Gritty gusts. */
  dustGust: number;
  dustGrit: number;
  /** Gas giant cloud sea: deep roar and rumble. */
  gasRoar: number;
  gasRumble: number;
  /** Heavy pressure drone. */
  pressure: number;
  /** Heat ticks per second and their level. */
  crackleRate: number;
  crackleGain: number;
  /** Deep volcanic rumble. */
  plumeRumble: number;
  /** Soft high shimmer of a belt. */
  beltShimmer: number;
  /** Icy chime level (0 = none). */
  cometChime: number;
}

export function soundscapeTargets(f: FlightLike, sc: SceneState): SoundscapeTargets {
  const air = clamp01(f.density * 3);
  const depth = clamp01(f.atmosphereDepth);
  const rainAmt = Math.max(sc.rain, sc.acid, sc.methane * 0.8) * air;
  // Methane drops are fat and soft: lower hiss, slower patter.
  const soft = sc.methane > Math.max(sc.rain, sc.acid) ? 1 : 0;
  const devils = sc.devil * (f.landed || f.altitude < 3000 ? 1 : 0.3);
  const dustAmt = Math.max(sc.dust * air, devils * 0.6 * air);
  const heatAir = lerp(1, 0.5, air);
  return {
    rainHiss: rainAmt * 0.22,
    rainPatter: rainAmt * (soft ? 0.12 : 0.26) * (0.5 + 0.5 * clamp01(f.density * 2)),
    rainCutoff: soft ? 2200 : 5200,
    acidFizz: sc.acid * air * 0.14,
    snowMuffle: 1 - 0.65 * sc.snow * air,
    snowHush: sc.snow * air * 0.05,
    dustGust: dustAmt * 0.3,
    dustGrit: dustAmt * 0.16,
    gasRoar: sc.gas * Math.min(1, 0.4 + 0.6 * depth) * 0.5,
    gasRumble: sc.gas * Math.min(1, depth * 2) * 0.32,
    pressure: sc.heavy * Math.min(1, depth * 2) * 0.22,
    crackleRate: sc.heat * 5,
    crackleGain: sc.heat * 0.09 * heatAir,
    plumeRumble: sc.plume * 0.45,
    beltShimmer: sc.belt * 0.05,
    cometChime: sc.comet > 0.04 ? sc.comet * 0.09 : 0,
  };
}

export interface CabinTargets {
  /** Low-pass on the outside sounds, Hz. */
  outsideCutoff: number;
  outsideGain: number;
  engineBoost: number;
  humGain: number;
  rushGain: number;
}

/** Cockpit muffles the outside, lets the engine through and adds a cabin hum and air-rush. */
export function cabinTargets(cockpit: boolean, speed: number, speedCap: number, density: number): CabinTargets {
  if (!cockpit) return { outsideCutoff: 16000, outsideGain: 1, engineBoost: 1, humGain: 0, rushGain: 0 };
  const sp = clamp01(speed / Math.max(40, Math.min(speedCap, 3000)));
  const air = clamp01(density * 3);
  return {
    outsideCutoff: 1500 + 1800 * sp * air,
    outsideGain: 0.6,
    engineBoost: 1.3,
    humGain: 0.03,
    // Air rushes past only when there is air: vacuum flight is quiet.
    rushGain: 0.07 * Math.sqrt(sp) * air,
  };
}

// ---------------------------------------------------------------------------------------------
// Music

export type MusicMood = 'space' | 'day' | 'night' | 'alien';

export function musicMood(f: FlightLike, sc: SceneState): MusicMood {
  const inAir = f.hasAtmosphere && clamp01(f.atmosphereDepth) > 0.04;
  const onSurface = f.landed || f.altitude < 4000;
  if (!inAir && !(onSurface && sc.alien > 0.5)) return 'space';
  if (sc.alien > 0.5) return 'alien';
  return sc.day < 0.25 ? 'night' : 'day';
}

export interface ScaleDef {
  name: string;
  steps: readonly number[];
}

const SCALES: Record<string, ScaleDef> = {
  majorPent: { name: 'majorPent', steps: [0, 2, 4, 7, 9] },
  ionian: { name: 'ionian', steps: [0, 2, 4, 5, 7, 9, 11] },
  lydian: { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  dorian: { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  yo: { name: 'yo', steps: [0, 2, 5, 7, 9] },
  hirajoshi: { name: 'hirajoshi', steps: [0, 2, 3, 7, 8] },
  phrygian: { name: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  wholeTone: { name: 'wholeTone', steps: [0, 2, 4, 6, 8, 10] },
  doubleHarmonic: { name: 'doubleHarmonic', steps: [0, 1, 4, 5, 7, 8, 11] },
  pelog: { name: 'pelog', steps: [0, 1, 3, 7, 8] },
};

const SCALE_POOL: Record<MusicMood, readonly string[]> = {
  space: ['majorPent', 'lydian', 'yo', 'dorian'],
  day: ['majorPent', 'ionian', 'lydian'],
  night: ['yo', 'dorian', 'hirajoshi'],
  alien: ['hirajoshi', 'phrygian', 'wholeTone', 'doubleHarmonic', 'pelog', 'lydian', 'dorian'],
};

/** Deterministic scale for a seed and mood. */
export function pickScale(seed: number, mood: MusicMood): ScaleDef {
  const pool = SCALE_POOL[mood];
  const h = hashInts(seed, mood.length * 7 + mood.charCodeAt(0));
  return SCALES[pool[(h >>> 0) % pool.length]!]!;
}

/** Pitch class 0..11 of the tonic, from the seed. */
export function tonicOf(seed: number): number {
  return (hashInts(seed, 91) >>> 0) % 12;
}

/** MIDI note of scale degree `i` (any integer, wraps up by octaves) above `base`. */
export function scaleNote(base: number, scale: ScaleDef, i: number): number {
  const n = scale.steps.length;
  const oct = Math.floor(i / n);
  const k = ((i % n) + n) % n;
  return base + 12 * oct + scale.steps[k]!;
}

const CHORD_SHAPE: Record<MusicMood, readonly number[]> = {
  space: [0, 4, 7, 9, 11, 14],
  day: [0, 2, 4, 6, 7, 9],
  night: [0, 4, 7, 9, 11, 13],
  alien: [0, 3, 4, 7, 8, 11],
};
const CHORD_BASE: Record<MusicMood, number> = { space: 36, day: 48, night: 40, alien: 42 };

/** Six pad voices as MIDI notes: a stack of scale degrees over a tonic, placed per mood. */
export function chordNotes(pc: number, scale: ScaleDef, degree: number, mood: MusicMood): number[] {
  const base = CHORD_BASE[mood] + (pc % 12);
  return CHORD_SHAPE[mood].map((o, v) => {
    const note = scaleNote(base, scale, o + degree);
    return mood === 'night' && v >= 3 ? note + 12 : note;
  });
}

export interface PadMood {
  /** Level of each of the six voices. */
  levels: readonly number[];
  /** Triangle (warmth) mix multiplier. */
  warmth: number;
  /** Pad low-pass, Hz. */
  cutoff: number;
  /** Overall pad level multiplier. */
  gain: number;
}

export function padMood(mood: MusicMood): PadMood {
  switch (mood) {
    case 'space':
      return { levels: [1, 0.8, 0.8, 0.7, 0.6, 0.5], warmth: 0.8, cutoff: 3200, gain: 1 };
    case 'day':
      return { levels: [1, 0.9, 0.9, 0.7, 0.5, 0.4], warmth: 2.6, cutoff: 1500, gain: 0.9 };
    case 'night':
      return { levels: [0.5, 0, 0.25, 0.7, 1, 1], warmth: 0.3, cutoff: 5200, gain: 0.7 };
    case 'alien':
      return { levels: [1, 0.6, 0.9, 0.5, 0.8, 0.4], warmth: 1.2, cutoff: 2300, gain: 0.85 };
  }
}

export interface Phrase {
  notes: number[];
  /** Seconds between note starts. */
  gaps: number[];
}

/** A few gentle notes walking the scale in a high register. Deterministic for (seed, count). */
export function makePhrase(seed: number, count: number, scale: ScaleDef, pc: number, mood: MusicMood): Phrase {
  const rnd = mulberry32(hashInts(seed, count, 33));
  const n = 3 + Math.floor(rnd() * 3);
  const base = (mood === 'night' ? 72 : mood === 'day' ? 62 : 67) + (pc % 12);
  let deg = Math.floor(rnd() * scale.steps.length);
  const notes: number[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < n; i++) {
    notes.push(scaleNote(base, scale, deg));
    gaps.push(0.7 + rnd() * 0.9);
    const step = Math.floor(rnd() * 5) - 2;
    deg += step === 0 ? 1 : step;
  }
  return { notes, gaps };
}

/** Seconds until the next phrase: 1 to 3 minutes. */
export function phraseDelay(r: number): number {
  return 60 + 120 * clamp01(r);
}

// ---------------------------------------------------------------------------------------------
// Cues

export type NotifyCue = 'discovery' | 'tick' | 'none';

/** Which sound a HUD toast gets. Survey and landmark toasts chime; the snapshot has its own shutter. */
export function cueForNotify(big: string, small: string): NotifyCue {
  const text = `${big} ${small}`.toUpperCase();
  if (text.includes('SNAPSHOT')) return 'none';
  if (/SURVEY|DISCOVER|LANDMARK|FOUND|NEW WORLD/.test(text)) return 'discovery';
  return 'tick';
}

/** Warm rising arpeggio for a discovery, as MIDI notes. */
export const DISCOVERY_ARPEGGIO: readonly number[] = [74, 78, 81, 85, 86];
