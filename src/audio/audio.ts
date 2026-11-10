import type { World } from '../sim/world';
import type { FlightPhase } from '../sim/warp';
import { SceneSampler } from './scene';
import {
  DISCOVERY_ARPEGGIO,
  cabinTargets,
  chordNotes,
  cueForNotify,
  emptyScene,
  makePhrase,
  musicMood,
  padMood,
  phraseDelay,
  pickScale,
  soundscapeTargets,
  tonicOf,
  type MusicMood,
  type ScaleDef,
  type SceneState,
} from './soundscape';

/** Snapshot of the world values the soundscape depends on. */
export interface AudioState {
  phase: FlightPhase;
  density: number;
  atmosphereDepth: number;
  throttle: number;
  boosting: boolean;
  stress: number;
  landed: boolean;
  speed: number;
  speedCap: number;
  altitude: number;
  hasAtmosphere: boolean;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Layer gains and master volume. Bind these to a debug panel. */
export interface AudioTuning {
  master: number;
  engine: number;
  wind: number;
  drone: number;
  surface: number;
  cues: number;
  thunder: number;
  /** Rain, snow, dust, gas, belts and the other world soundscapes. */
  weather: number;
  /** Cabin hum and air-rush level. */
  cabin: number;
  /** Melodic phrases on top of the drone. */
  phrases: number;
}

export function defaultTuning(): AudioTuning {
  return { master: 0.6, engine: 0.5, wind: 0.6, drone: 0.55, surface: 0.5, cues: 0.6, thunder: 0.8, weather: 0.8, cabin: 0.8, phrases: 0.7 };
}

/** 0 in vacuum, 1 with air around the ship. */
export function airFactor(s: AudioState): number {
  return clamp01(finite(s.density) * 4);
}

export interface EngineTargets {
  gain: number;
  /** Base oscillator frequency, Hz. */
  freq: number;
  cutoff: number;
  boostGain: number;
}

export function engineTargets(s: AudioState): EngineTargets {
  const thr = clamp01(finite(s.throttle));
  const air = airFactor(s);
  const boost = s.boosting && !s.landed ? 1 : 0;
  if (s.landed) {
    return { gain: 0.04, freq: 52, cutoff: 260, boostGain: 0 };
  }
  // In vacuum the hum is felt through the hull: quieter and low-passed.
  const vac = lerp(0.55, 1, air);
  return {
    gain: (0.1 + 0.4 * thr) * vac,
    freq: 55 * Math.pow(1.6, thr) * (1 + 0.06 * boost),
    cutoff: lerp(160, 700, air) * (0.8 + 1.8 * thr) * (1 + 0.5 * boost),
    boostGain: 0.35 * boost * vac,
  };
}

export interface WindTargets {
  gain: number;
  bandFreq: number;
  lowpass: number;
  roar: number;
}

export function windTargets(s: AudioState): WindTargets {
  const sp = clamp01(finite(s.speed) / 200);
  const dens = clamp01(finite(s.density));
  const stress = clamp01(finite(s.stress));
  return {
    gain: dens * sp * 0.5,
    bandFreq: 250 + 1500 * sp,
    lowpass: 900 + 3500 * sp,
    roar: stress * Math.min(1, dens * 3) * 0.6,
  };
}

/** Drone pad level: strongest in space, fading as the atmosphere thickens. */
export function droneGain(s: AudioState): number {
  const depth = clamp01(finite(s.atmosphereDepth));
  const base = s.landed ? 0.15 : 1 - 0.85 * depth;
  return 0.35 * Math.max(0, base);
}

export interface SurfaceTargets {
  airGain: number;
  airCutoff: number;
  chimes: boolean;
  humGain: number;
}

export function surfaceTargets(s: AudioState): SurfaceTargets {
  const low = s.landed || finite(s.altitude) < 2000;
  const k = low ? 1 : 0;
  const quiet = 1 - 0.8 * clamp01(finite(s.speed) / 200);
  if (s.hasAtmosphere) {
    return {
      airGain: 0.12 * k * quiet * (0.4 + 0.6 * clamp01(s.density * 2)),
      airCutoff: 900 + 500 * clamp01(s.density),
      chimes: low,
      humGain: 0,
    };
  }
  return { airGain: 0, airCutoff: 400, chimes: false, humGain: 0.025 * k };
}

export interface ThunderParams {
  delay: number;
  gain: number;
  cutoff: number;
  duration: number;
}

export function thunderParams(distanceMeters: number): ThunderParams {
  const d = Math.max(0, finite(distanceMeters));
  return {
    delay: d / 343,
    gain: clamp01(1 / (1 + d / 3000)) * 0.9 + 0.05,
    cutoff: Math.max(90, 900 / (1 + d / 2500)),
    duration: Math.min(9, 3 + d / 1500),
  };
}

/** Chord voicings as MIDI notes: Dmaj9, Bm11, Gmaj7(#11). */
export const CHORDS: readonly (readonly number[])[] = [
  [38, 45, 52, 57, 61, 64],
  [35, 42, 50, 57, 62, 64],
  [31, 43, 50, 54, 59, 62],
];

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** D major pentatonic chime notes. */
const CHIME_NOTES = [74, 76, 78, 81, 83, 86];
const ENGINE_MULTS = [1, 0.5, 1.007];

export class AudioEngine {
  tuning: AudioTuning = defaultTuning();
  muted = false;
  /** Player volume multipliers from the settings screen, 0..1. */
  volume = { master: 1, music: 1, fx: 1 };

  private world: World;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverbIn!: GainNode;
  private noiseBuf!: AudioBuffer;
  private t = 0;

  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private engOscs: OscillatorNode[] = [];
  private engBright!: GainNode;
  private engPan!: StereoPannerNode;
  private windGain!: GainNode;
  private windBand!: BiquadFilterNode;
  private windLow!: BiquadFilterNode;
  private roarGain!: GainNode;
  private gustLfo!: GainNode;
  private droneGainNode!: GainNode;
  private droneVoices: { sine: OscillatorNode; tri: OscillatorNode }[] = [];
  private airGain!: GainNode;
  private airFilter!: BiquadFilterNode;
  private humGain!: GainNode;

  // Outside sounds go through one low-pass that the cockpit and snow close.
  private outside!: GainNode;
  private outsideLp!: BiquadFilterNode;
  private cabinHum!: GainNode;
  private cabinRush!: GainNode;
  private droneFilter!: BiquadFilterNode;
  private droneLevels: GainNode[] = [];
  private droneTri: GainNode[] = [];
  private patterBuf!: AudioBuffer;
  private clickBuf!: AudioBuffer;
  private rainHiss!: GainNode;
  private rainHissLp!: BiquadFilterNode;
  private rainPatter!: GainNode;
  private fizz!: GainNode;
  private snowHush!: GainNode;
  private dustGust!: GainNode;
  private dustGrit!: GainNode;
  private gasRoar!: GainNode;
  private gasRumble!: GainNode;
  private pressure!: GainNode;
  private plumeRumble!: GainNode;
  private shimmer!: GainNode;

  /** True when the camera is inside the cockpit. Set from main. */
  cockpit = true;
  private uiWasOpen = false;
  private pendingArrival = false;
  private readonly sampler: SceneSampler;
  private scene: SceneState = emptyScene();
  private sceneTimer = 0;
  private mood: MusicMood = 'space';
  private moodSince = 0;
  private scale: ScaleDef = pickScale(0, 'space');
  private degree = 0;
  private nextChord = 25;
  private nextPhrase = 70;
  private phraseCount = 0;
  private nextCrackle = 0;
  private nextCometChime = 4;
  private nextChime = 6;
  private prevPhase: FlightPhase;
  private prevWarp: number;

  constructor(world: World) {
    this.world = world;
    this.sampler = new SceneSampler(world);
    this.prevPhase = world.phase;
    this.prevWarp = world.clock.warp;
    const start = (): void => this.start();
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyN' && !e.repeat) this.setMuted(!this.muted);
    });
    // After a jump the page is new but the player already interacted: try to start right away.
    if (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive) this.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  private snapshot(): AudioState {
    const w = this.world;
    const s = w.ship;
    return {
      phase: w.phase,
      density: w.env.density,
      atmosphereDepth: w.atmosphereDepth,
      throttle: s.throttle,
      boosting: s.boosting,
      stress: s.stress,
      landed: s.landed,
      speed: s.speed,
      speedCap: s.speedCap,
      altitude: w.env.altitude,
      hasAtmosphere: s.frame.body.atmosphereHeight > 0,
    };
  }

  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    void ctx.resume();
    this.build(ctx);
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = ctx.sampleRate * 5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    // Crossfade the loop seam.
    const f = 2000;
    for (let i = 0; i < f; i++) {
      const k = i / f;
      d[len - f + i] = d[len - f + i]! * (1 - k) + d[i]! * k;
    }
    return buf;
  }

  /** Two seconds of sparse soft impulses: drops, grit and crackle when looped and filtered. */
  private makePatter(ctx: AudioContext): AudioBuffer {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let tail = 0;
    for (let i = 0; i < len; i++) {
      if (Math.random() < 0.004) tail = (0.4 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1);
      d[i] = tail;
      tail *= 0.82;
    }
    // Wrap smoothly so the loop point does not click.
    for (let i = 0; i < 64; i++) d[len - 1 - i] = d[len - 1 - i]! * (i / 64);
    return buf;
  }

  private makeClick(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12));
    return buf;
  }

  private patterSource(ctx: AudioContext, rate: number): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.patterBuf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(0, Math.random());
    return src;
  }

  private tone(ctx: AudioContext, type: OscillatorType, hz: number, gain: number, dest: AudioNode): GainNode {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(dest);
    o.start();
    return g;
  }

  /** A slow oscillator that wobbles an AudioParam by +-depth. */
  private lfo(ctx: AudioContext, hz: number, depth: number, target: AudioParam): void {
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start();
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  private build(ctx: AudioContext): void {
    this.noiseBuf = this.makeNoise(ctx);
    this.patterBuf = this.makePatter(ctx);
    this.clickBuf = this.makeClick(ctx);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.02;
    comp.release.value = 0.4;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp).connect(ctx.destination);

    // Feedback delay reverb.
    this.reverbIn = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    for (const [time, fb] of [[0.37, 0.5], [0.53, 0.45]] as const) {
      const dl = ctx.createDelay(2);
      dl.delayTime.value = time;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      const g = ctx.createGain();
      g.gain.value = fb;
      this.reverbIn.connect(dl);
      dl.connect(lp).connect(g).connect(dl);
      lp.connect(wet);
    }
    wet.connect(this.master);

    // Outside sounds share one low-pass: the cockpit and snow close it.
    this.outside = ctx.createGain();
    this.outsideLp = ctx.createBiquadFilter();
    this.outsideLp.type = 'lowpass';
    this.outsideLp.frequency.value = 16000;
    this.outsideLp.Q.value = 0.5;
    this.outside.connect(this.outsideLp).connect(this.master);

    // Engine.
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 0.7;
    this.engPan = ctx.createStereoPanner();
    this.engBright = ctx.createGain();
    this.engBright.gain.value = 0;
    const types: OscillatorType[] = ['sawtooth', 'sine', 'sawtooth'];
    types.forEach((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 55 * ENGINE_MULTS[i]!;
      const g = ctx.createGain();
      g.gain.value = type === 'sine' ? 0.6 : 0.25;
      o.connect(g).connect(this.engFilter);
      if (i === 2) g.connect(this.engBright);
      o.start();
      this.engOscs.push(o);
    });
    const brightFilter = ctx.createBiquadFilter();
    brightFilter.type = 'highpass';
    brightFilter.frequency.value = 500;
    this.engBright.connect(brightFilter).connect(this.engGain);
    this.engFilter.connect(this.engGain).connect(this.engPan).connect(this.master);
    const panLfo = ctx.createOscillator();
    panLfo.frequency.value = 0.11;
    const panDepth = ctx.createGain();
    panDepth.gain.value = 0.35;
    panLfo.connect(panDepth).connect(this.engPan.pan);
    panLfo.start();

    // Wind.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.Q.value = 0.6;
    this.windLow = ctx.createBiquadFilter();
    this.windLow.type = 'lowpass';
    this.noiseSource(ctx).connect(this.windBand).connect(this.windLow).connect(this.windGain).connect(this.outside);
    this.gustLfo = ctx.createGain();
    this.gustLfo.gain.value = 0;
    const gust = ctx.createOscillator();
    gust.frequency.value = 0.17;
    gust.connect(this.gustLfo).connect(this.windGain.gain);
    gust.start();
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    const roarLp = ctx.createBiquadFilter();
    roarLp.type = 'lowpass';
    roarLp.frequency.value = 700;
    this.noiseSource(ctx).connect(roarLp).connect(this.roarGain).connect(this.outside);

    // Drone pad.
    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = 0;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 3200;
    this.droneFilter.Q.value = 0.4;
    this.droneFilter.connect(this.droneGainNode);
    this.droneGainNode.connect(this.master);
    this.droneGainNode.connect(this.reverbIn);
    const chord = chordNotes(tonicOf(this.scene.seed), this.scale, 0, 'space');
    for (let i = 0; i < 6; i++) {
      const hz = midiToHz(chord[i]!);
      const sine = ctx.createOscillator();
      const tri = ctx.createOscillator();
      sine.frequency.value = hz;
      tri.frequency.value = hz;
      tri.type = 'triangle';
      tri.detune.value = (i % 2 ? 1 : -1) * 6;
      const gs = ctx.createGain();
      gs.gain.value = 0.16 / (1 + i * 0.25);
      const gt = ctx.createGain();
      gt.gain.value = 0.04 / (1 + i * 0.25);
      const lv = ctx.createGain();
      lv.gain.value = 1;
      const tm = ctx.createGain();
      tm.gain.value = 1;
      sine.connect(gs).connect(lv);
      tri.connect(gt).connect(tm).connect(lv);
      lv.connect(this.droneFilter);
      this.droneLevels.push(lv);
      this.droneTri.push(tm);
      sine.start();
      tri.start();
      this.droneVoices.push({ sine, tri });
    }

    // Surface ambience.
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.Q.value = 0.4;
    this.noiseSource(ctx).connect(this.airFilter).connect(this.airGain).connect(this.outside);
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const hum = ctx.createOscillator();
    hum.frequency.value = 41;
    hum.connect(this.humGain).connect(this.master);
    hum.start();

    this.buildWorldLayers(ctx);
    this.buildCabin(ctx);
    if (this.pendingArrival) {
      this.pendingArrival = false;
      this.arrival();
    }
  }

  private buildWorldLayers(ctx: AudioContext): void {
    const out = this.outside;
    const filt = (type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain0 = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };

    // Rain: broadband hiss, patter of drops, and a fizzy top for acid.
    this.rainHiss = gain0();
    this.rainHissLp = filt('lowpass', 5200, 0.5);
    this.noiseSource(ctx).connect(filt('highpass', 1800)).connect(this.rainHissLp).connect(this.rainHiss).connect(out);
    this.rainPatter = gain0();
    this.patterSource(ctx, 1).connect(filt('bandpass', 3800, 0.8)).connect(this.rainPatter).connect(out);
    this.fizz = gain0();
    this.patterSource(ctx, 3.1).connect(filt('highpass', 6000)).connect(this.fizz).connect(out);

    // Snow: a faint breathy hush (the muffle is the outside low-pass).
    this.snowHush = gain0();
    this.noiseSource(ctx).connect(filt('bandpass', 700, 0.5)).connect(this.snowHush).connect(out);

    // Dust: gritty gusts.
    this.dustGust = gain0();
    this.noiseSource(ctx).connect(filt('bandpass', 1300, 0.9)).connect(this.dustGust).connect(out);
    this.lfo(ctx, 0.23, 0.45, this.dustGust.gain);
    this.dustGrit = gain0();
    this.patterSource(ctx, 1.7).connect(filt('bandpass', 2600, 1.2)).connect(this.dustGrit).connect(out);

    // Gas giant: deep roar and low rumbles.
    this.gasRoar = gain0();
    this.noiseSource(ctx).connect(filt('lowpass', 240, 0.8)).connect(this.gasRoar).connect(out);
    this.lfo(ctx, 0.06, 0.25, this.gasRoar.gain);
    this.gasRumble = gain0();
    this.tone(ctx, 'sine', 31, 0.7, this.gasRumble);
    this.tone(ctx, 'sine', 47.5, 0.4, this.gasRumble);
    this.gasRumble.connect(out);
    this.lfo(ctx, 0.09, 0.3, this.gasRumble.gain);

    // Heavy air: a pressure drone, two close sines beating slowly plus a dark noise bed.
    this.pressure = gain0();
    this.tone(ctx, 'sine', 43.6, 0.6, this.pressure);
    this.tone(ctx, 'sine', 44.4, 0.6, this.pressure);
    this.tone(ctx, 'sine', 65.4, 0.25, this.pressure);
    this.noiseSource(ctx).connect(filt('lowpass', 110)).connect(this.pressure);
    this.pressure.connect(this.master);

    // Volcanic plumes: a deep rumble.
    this.plumeRumble = gain0();
    this.noiseSource(ctx).connect(filt('lowpass', 85, 1)).connect(this.plumeRumble);
    this.tone(ctx, 'sine', 29, 0.6, this.plumeRumble);
    this.lfo(ctx, 0.37, 0.3, this.plumeRumble.gain);
    this.plumeRumble.connect(this.master);

    // Asteroid belt: a soft high shimmer of four slowly breathing partials.
    this.shimmer = gain0();
    [2349, 3136, 3951, 5274].forEach((hz, i) => {
      const g = ctx.createGain();
      g.gain.value = 0.5;
      this.tone(ctx, 'sine', hz, 0.25, g);
      this.lfo(ctx, 0.11 + 0.07 * i, 0.5, g.gain);
      g.connect(this.shimmer);
    });
    this.shimmer.connect(this.master);
    this.shimmer.connect(this.reverbIn);
  }

  private buildCabin(ctx: AudioContext): void {
    this.cabinHum = ctx.createGain();
    this.cabinHum.gain.value = 0;
    this.tone(ctx, 'sine', 118, 0.5, this.cabinHum);
    this.tone(ctx, 'sine', 177.3, 0.15, this.cabinHum);
    const hl = ctx.createBiquadFilter();
    hl.type = 'lowpass';
    hl.frequency.value = 320;
    this.noiseSource(ctx).connect(hl).connect(this.cabinHum);
    this.cabinHum.connect(this.master);
    this.cabinRush = ctx.createGain();
    this.cabinRush.gain.value = 0;
    const rb = ctx.createBiquadFilter();
    rb.type = 'bandpass';
    rb.frequency.value = 2400;
    rb.Q.value = 0.5;
    this.noiseSource(ctx).connect(rb).connect(this.cabinRush).connect(this.master);
  }

  update(realDt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const dt = Math.max(0, Math.min(0.25, finite(realDt)));
    this.t += dt;
    const now = ctx.currentTime;
    const tu = this.tuning;
    const fx = this.volume.fx;
    const s = this.snapshot();
    const ramp = (p: AudioParam, v: number, tc: number): void => {
      p.setTargetAtTime(v, now, tc);
    };

    this.sceneTimer -= dt;
    if (this.sceneTimer <= 0) {
      this.sceneTimer = 0.1;
      this.scene = this.sampler.sample();
    }
    const sc = this.scene;
    const cab = cabinTargets(this.cockpit, s.speed, s.speedCap, s.density);
    const sd = soundscapeTargets(s, sc);
    const wl = tu.weather * fx;

    ramp(this.master.gain, this.muted ? 0 : tu.master * this.volume.master, 0.3);

    const e = engineTargets(s);
    ramp(this.engGain.gain, e.gain * tu.engine * fx * cab.engineBoost, 0.4);
    ramp(this.engFilter.frequency, e.cutoff, 0.4);
    ramp(this.engBright.gain, e.boostGain, 0.3);
    this.engOscs.forEach((o, i) => ramp(o.frequency, e.freq * ENGINE_MULTS[i]!, 0.35));

    // Cockpit: the outside is muffled, the cabin hums, air rushes by with speed.
    ramp(this.outside.gain, cab.outsideGain, 0.5);
    ramp(this.outsideLp.frequency, cab.outsideCutoff * sd.snowMuffle, 0.6);
    ramp(this.cabinHum.gain, cab.humGain * tu.cabin * fx, 0.8);
    ramp(this.cabinRush.gain, cab.rushGain * tu.cabin * fx, 0.6);

    const w = windTargets(s);
    ramp(this.windGain.gain, w.gain * tu.wind * fx, 0.5);
    ramp(this.windBand.frequency, w.bandFreq, 0.5);
    ramp(this.windLow.frequency, w.lowpass, 0.5);
    ramp(this.gustLfo.gain, 0.25 * w.gain * tu.wind * fx, 1);
    ramp(this.roarGain.gain, w.roar * tu.wind * fx, 0.6);

    // Per world soundscapes.
    ramp(this.rainHiss.gain, sd.rainHiss * wl, 0.8);
    ramp(this.rainHissLp.frequency, sd.rainCutoff, 1);
    ramp(this.rainPatter.gain, sd.rainPatter * wl, 0.8);
    ramp(this.fizz.gain, sd.acidFizz * wl, 0.8);
    ramp(this.snowHush.gain, sd.snowHush * wl, 1.2);
    ramp(this.dustGust.gain, sd.dustGust * wl, 1);
    ramp(this.dustGrit.gain, sd.dustGrit * wl, 1);
    ramp(this.gasRoar.gain, sd.gasRoar * wl, 1.5);
    ramp(this.gasRumble.gain, sd.gasRumble * wl, 1.5);
    ramp(this.pressure.gain, sd.pressure * wl, 2);
    ramp(this.plumeRumble.gain, sd.plumeRumble * wl, 1.2);
    ramp(this.shimmer.gain, sd.beltShimmer * wl, 2);

    if (sd.crackleRate > 0.05 && this.t > this.nextCrackle) {
      this.nextCrackle = this.t + (0.4 + Math.random() * 0.8) / sd.crackleRate;
      this.crackle(ctx, sd.crackleGain * wl);
    }
    if (sd.cometChime > 0 && this.t > this.nextCometChime) {
      this.nextCometChime = this.t + 3 + Math.random() * 4;
      const icy = [88, 91, 95, 98, 100];
      this.bell(ctx, icy[Math.floor(Math.random() * icy.length)]!, sd.cometChime * wl, 3.5, 3.5, 0.5);
    }

    this.updateMusic(ctx, s, sc, now, ramp);

    const sf = surfaceTargets(s);
    ramp(this.airGain.gain, sf.airGain * tu.surface * fx, 1.5);
    ramp(this.airFilter.frequency, sf.airCutoff, 1.5);
    ramp(this.humGain.gain, sf.humGain * tu.surface * fx, 1.5);

    if (this.t > this.nextChime) {
      this.nextChime = this.t + 8 + Math.random() * 12;
      if (sf.chimes) this.chime(ctx, tu.surface * fx);
    }

    if (s.phase !== this.prevPhase) {
      this.phaseCue(ctx, this.prevPhase, s.phase);
      this.prevPhase = s.phase;
    }
    const warp = this.world.clock.warp;
    if (warp !== this.prevWarp) {
      this.prevWarp = warp;
      this.tick(ctx);
    }
  }

  /** Pad mood, chord changes, and an occasional gentle phrase. */
  private updateMusic(ctx: AudioContext, s: AudioState, sc: SceneState, now: number, ramp: (p: AudioParam, v: number, tc: number) => void): void {
    const tu = this.tuning;
    const music = this.volume.music;
    const mood = musicMood(s, sc);
    let retune = false;
    if (mood !== this.mood && this.t - this.moodSince > 10) {
      this.mood = mood;
      this.moodSince = this.t;
      retune = true;
    }
    if (this.t > this.nextChord) {
      this.nextChord = this.t + 20 + Math.random() * 20;
      this.degree = (this.degree + [2, 3, 4, 1][Math.floor(Math.random() * 4)]!) % 7;
      retune = true;
    }
    const pm = padMood(this.mood);
    if (retune) {
      this.scale = pickScale(sc.seed, this.mood);
      const chord = chordNotes(tonicOf(sc.seed), this.scale, this.degree, this.mood);
      this.droneVoices.forEach((v, i) => {
        const hz = midiToHz(chord[i]!);
        v.sine.frequency.setTargetAtTime(hz, now, 4);
        v.tri.frequency.setTargetAtTime(hz, now, 4);
      });
    }
    this.droneLevels.forEach((g, i) => ramp(g.gain, pm.levels[i]!, 3));
    this.droneTri.forEach((g) => ramp(g.gain, pm.warmth, 3));
    ramp(this.droneFilter.frequency, pm.cutoff, 3);
    ramp(this.droneGainNode.gain, droneGain(s) * pm.gain * tu.drone * music, 2.5);

    if (this.t > this.nextPhrase) {
      this.nextPhrase = this.t + phraseDelay(Math.random());
      // Only when the pad is audible: not buried in dense atmosphere.
      if (droneGain(s) > 0.04 && music > 0.01) this.playPhrase(ctx, sc.seed, tu.phrases * music * tu.drone);
    }
  }

  private playPhrase(ctx: AudioContext, seed: number, level: number): void {
    const ph = makePhrase(seed, this.phraseCount++, this.scale, tonicOf(seed), this.mood);
    let at = ctx.currentTime + 0.1;
    ph.notes.forEach((n, i) => {
      this.bell(ctx, n, 0.09 * level, 3.2, 2, 0.35, at);
      at += ph.gaps[i]!;
    });
  }

  /**
   * Soft FM bell. `level` is already volume scaled; `decay` is the amplitude time constant;
   * `ratio` and `index` set the metallic color.
   */
  private bell(ctx: AudioContext, midi: number, level: number, decay: number, ratio: number, index: number, when = ctx.currentTime): void {
    if (level <= 0.0005) return;
    const hz = midiToHz(midi);
    const car = ctx.createOscillator();
    car.frequency.value = hz;
    const mod = ctx.createOscillator();
    mod.frequency.value = hz * ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(hz * index, when);
    mg.gain.setTargetAtTime(0, when, decay * 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.015);
    g.gain.setTargetAtTime(0, when + 0.02, decay * 0.5);
    mod.connect(mg).connect(car.frequency);
    car.connect(g);
    g.connect(this.master);
    g.connect(this.reverbIn);
    const end = when + decay * 3 + 0.5;
    car.start(when);
    mod.start(when);
    car.stop(end);
    mod.stop(end);
    this.retire(car, g, mg, mod);
  }

  /** Disconnects a one shot's nodes when its source ends so nothing lingers in the graph. */
  private retire(src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    src.addEventListener('ended', () => {
      src.disconnect();
      for (const n of nodes) n.disconnect();
    });
  }

  private crackle(ctx: AudioContext, level: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.clickBuf;
    src.playbackRate.value = 0.7 + Math.random() * 1.6;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800 + Math.random() * 3000;
    f.Q.value = 2;
    const g = ctx.createGain();
    g.gain.value = level * (0.4 + Math.random() * 0.6);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.random() * 1.6 - 0.8;
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start();
    this.retire(src, f, g, p);
  }

  private chime(ctx: AudioContext, level: number): void {
    const note = CHIME_NOTES[Math.floor(Math.random() * CHIME_NOTES.length)]!;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.value = midiToHz(note);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.06 * level, t0 + 0.02);
    g.gain.setTargetAtTime(0, t0 + 0.03, 0.7);
    o.connect(g);
    g.connect(this.master);
    g.connect(this.reverbIn);
    o.start(t0);
    o.stop(t0 + 5);
    this.retire(o, g);
  }

  private shaped(ctx: AudioContext, type: BiquadFilterType, f0: number, f1: number, peak: number, attack: number, dur: number): void {
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak * this.tuning.cues * this.volume.fx, t0 + attack);
    g.gain.setTargetAtTime(0, t0 + attack, (dur - attack) / 3);
    src.connect(f).connect(g);
    g.connect(this.master);
    g.connect(this.reverbIn);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + dur + 0.5);
    this.retire(src, f, g);
  }

  private phaseCue(ctx: AudioContext, from: FlightPhase, to: FlightPhase): void {
    if (to === 'landed') {
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(90, t0);
      o.frequency.exponentialRampToValueAtTime(40, t0 + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * this.tuning.cues * this.volume.fx, t0);
      g.gain.setTargetAtTime(0, t0 + 0.02, 0.12);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 1.2);
      this.retire(o, g);
    } else if (to === 'atmosphere' && from !== 'landed') {
      this.shaped(ctx, 'bandpass', 300, 2400, 0.25, 1.8, 3.5);
    } else if (from === 'atmosphere') {
      this.shaped(ctx, 'bandpass', 2200, 400, 0.18, 0.6, 3.5);
    }
  }

  private tick(ctx: AudioContext): void {
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08 * this.tuning.cues * this.volume.fx, t0);
    g.gain.setTargetAtTime(0, t0, 0.015);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.2);
    this.retire(o, g);
  }

  // -------------------------------------------------------------------------------------------
  // Cues driven by other systems

  /** HUD toast hook: a warm arpeggio for discoveries, a tiny tick for the rest. */
  onNotify(big: string, small: string): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const cue = cueForNotify(big, small);
    if (cue === 'discovery') this.discovery(ctx);
    else if (cue === 'tick') this.uiTick(ctx);
  }

  /** Small warm arpeggio: survey complete, landmark discovered. */
  private discovery(ctx: AudioContext): void {
    const lvl = 0.1 * this.tuning.cues * this.volume.fx;
    let at = ctx.currentTime + 0.02;
    DISCOVERY_ARPEGGIO.forEach((n, i) => {
      this.bell(ctx, n, lvl * (1 - i * 0.08), 2.2, 1, 0.12, at);
      at += 0.11;
    });
  }

  /** Call every frame with whether a menu or overlay is open; ticks softly when it opens. */
  setUiOpen(open: boolean): void {
    if (open && !this.uiWasOpen && this.ctx && this.master) this.uiTick(this.ctx);
    this.uiWasOpen = open;
  }

  private uiTick(ctx: AudioContext): void {
    const t0 = ctx.currentTime;
    const lvl = 0.05 * this.tuning.cues * this.volume.fx;
    for (const [hz, k] of [[740, 1], [1480, 0.3]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(lvl * k, t0);
      g.gain.setTargetAtTime(0, t0, 0.025);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.3);
      this.retire(o, g);
    }
  }

  /** Camera shutter: a dry two part click. */
  shutter(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime;
    const lvl = this.tuning.cues * this.volume.fx;
    for (const [dt, hz, k] of [[0, 3200, 0.5], [0.055, 1500, 0.4]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.clickBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz;
      f.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.value = k * lvl;
      src.connect(f).connect(g).connect(this.master);
      src.start(t0 + dt);
      this.retire(src, f, g);
    }
  }

  /** Hyperspace spool-up for `seconds`: rising tone, whoosh and a swell that ends in the flash. */
  hyperspaceStart(seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const dur = Math.max(1, finite(seconds));
    const t0 = ctx.currentTime;
    const lvl = this.tuning.cues * this.volume.fx;
    const env = (peak: number): GainNode => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak * lvl, t0 + dur * 0.7);
      g.gain.linearRampToValueAtTime(peak * 1.3 * lvl, t0 + dur * 0.92);
      g.gain.linearRampToValueAtTime(0, t0 + dur * 0.99);
      return g;
    };
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t0);
    lp.frequency.exponentialRampToValueAtTime(5200, t0 + dur * 0.9);
    const eg = env(0.22);
    lp.connect(eg);
    eg.connect(this.master);
    eg.connect(this.reverbIn);
    for (const [type, f0, f1, k] of [['sawtooth', 55, 880, 0.5], ['sine', 40, 160, 1]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.9);
      const g = ctx.createGain();
      g.gain.value = k;
      o.connect(g).connect(lp);
      o.start(t0);
      o.stop(t0 + dur + 0.2);
      this.retire(o, g);
    }
    // Whoosh.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(3500, t0 + dur * 0.9);
    const wg = env(0.3);
    src.connect(bp).connect(wg).connect(this.master);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + dur + 0.2);
    this.retire(src, bp, wg);
  }

  /** Arrival shimmer: high partials sliding down into a long tail. Waits for the context if needed. */
  arrival(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) {
      this.pendingArrival = true;
      return;
    }
    const t0 = ctx.currentTime;
    const lvl = this.tuning.cues * this.volume.fx;
    [1568, 2093, 2637, 3136, 4186].forEach((hz, i) => {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(hz * 1.5, t0);
      o.frequency.exponentialRampToValueAtTime(hz, t0 + 1.6 + i * 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0 + i * 0.08);
      g.gain.linearRampToValueAtTime(0.035 * lvl, t0 + 0.4 + i * 0.08);
      g.gain.setTargetAtTime(0, t0 + 0.9 + i * 0.08, 0.9);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.reverbIn);
      o.start(t0);
      o.stop(t0 + 7);
      this.retire(o, g);
    });
    this.shaped(ctx, 'bandpass', 5000, 500, 0.16, 0.3, 4);
  }

  /** Rolling thunder from a strike `distanceMeters` away. */
  thunder(distanceMeters: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const p = thunderParams(distanceMeters);
    // Too far to hear (and it would sit in the graph for minutes): skip.
    if (p.delay > 20) return;
    const t0 = ctx.currentTime + p.delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(p.cutoff, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(50, p.cutoff * 0.3), t0 + p.duration);
    const g = ctx.createGain();
    const peak = p.gain * this.tuning.thunder * this.volume.fx;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.15);
    // Rolling: a few decaying swells.
    for (let i = 1; i < 4; i++) {
      const ti = t0 + 0.4 + i * p.duration * 0.12 + Math.random() * 0.3;
      g.gain.setTargetAtTime(peak * (0.7 - i * 0.15), ti, 0.25);
    }
    g.gain.setTargetAtTime(0, t0 + p.duration * 0.6, p.duration * 0.2);
    src.connect(f).connect(g);
    g.connect(this.master);
    g.connect(this.reverbIn);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + p.duration * 1.6);
    this.retire(src, f, g);
  }

  /** Debug and test hook. */
  get contextState(): string {
    return this.ctx?.state ?? 'none';
  }
}
