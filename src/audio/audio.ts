import type { World } from '../sim/world';
import type { FlightPhase } from '../sim/warp';

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
}

export function defaultTuning(): AudioTuning {
  return { master: 0.6, engine: 0.5, wind: 0.6, drone: 0.55, surface: 0.5, cues: 0.6, thunder: 0.8 };
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

  private chordIdx = 0;
  private nextChord = 25;
  private nextChime = 6;
  private prevPhase: FlightPhase;
  private prevWarp: number;

  constructor(world: World) {
    this.world = world;
    this.prevPhase = world.phase;
    this.prevWarp = world.clock.warp;
    const start = (): void => this.start();
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyN' && !e.repeat) this.setMuted(!this.muted);
    });
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

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  private build(ctx: AudioContext): void {
    this.noiseBuf = this.makeNoise(ctx);

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
    this.noiseSource(ctx).connect(this.windBand).connect(this.windLow).connect(this.windGain).connect(this.master);
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
    this.noiseSource(ctx).connect(roarLp).connect(this.roarGain).connect(this.master);

    // Drone pad.
    this.droneGainNode = ctx.createGain();
    this.droneGainNode.gain.value = 0;
    this.droneGainNode.connect(this.master);
    this.droneGainNode.connect(this.reverbIn);
    const chord = CHORDS[0]!;
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
      sine.connect(gs).connect(this.droneGainNode);
      tri.connect(gt).connect(this.droneGainNode);
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
    this.noiseSource(ctx).connect(this.airFilter).connect(this.airGain).connect(this.master);
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const hum = ctx.createOscillator();
    hum.frequency.value = 41;
    hum.connect(this.humGain).connect(this.master);
    hum.start();
  }

  update(realDt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const dt = Math.max(0, Math.min(0.25, finite(realDt)));
    this.t += dt;
    const now = ctx.currentTime;
    const tu = this.tuning;
    const s = this.snapshot();
    const ramp = (p: AudioParam, v: number, tc: number): void => {
      p.setTargetAtTime(v, now, tc);
    };

    ramp(this.master.gain, this.muted ? 0 : tu.master, 0.3);

    const e = engineTargets(s);
    ramp(this.engGain.gain, e.gain * tu.engine, 0.4);
    ramp(this.engFilter.frequency, e.cutoff, 0.4);
    ramp(this.engBright.gain, e.boostGain, 0.3);
    this.engOscs.forEach((o, i) => ramp(o.frequency, e.freq * ENGINE_MULTS[i]!, 0.35));

    const w = windTargets(s);
    ramp(this.windGain.gain, w.gain * tu.wind, 0.5);
    ramp(this.windBand.frequency, w.bandFreq, 0.5);
    ramp(this.windLow.frequency, w.lowpass, 0.5);
    ramp(this.gustLfo.gain, 0.25 * w.gain * tu.wind, 1);
    ramp(this.roarGain.gain, w.roar * tu.wind, 0.6);

    ramp(this.droneGainNode.gain, droneGain(s) * tu.drone, 2.5);

    const sf = surfaceTargets(s);
    ramp(this.airGain.gain, sf.airGain * tu.surface, 1.5);
    ramp(this.airFilter.frequency, sf.airCutoff, 1.5);
    ramp(this.humGain.gain, sf.humGain * tu.surface, 1.5);

    if (this.t > this.nextChord) {
      this.nextChord = this.t + 20 + Math.random() * 20;
      this.chordIdx = (this.chordIdx + 1) % CHORDS.length;
      const chord = CHORDS[this.chordIdx]!;
      this.droneVoices.forEach((v, i) => {
        const hz = midiToHz(chord[i]!);
        v.sine.frequency.setTargetAtTime(hz, now, 4);
        v.tri.frequency.setTargetAtTime(hz, now, 4);
      });
    }
    if (this.t > this.nextChime) {
      this.nextChime = this.t + 8 + Math.random() * 12;
      if (sf.chimes) this.chime(ctx, tu.surface);
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
    g.gain.linearRampToValueAtTime(peak * this.tuning.cues, t0 + attack);
    g.gain.setTargetAtTime(0, t0 + attack, (dur - attack) / 3);
    src.connect(f).connect(g);
    g.connect(this.master);
    g.connect(this.reverbIn);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + dur + 0.5);
  }

  private phaseCue(ctx: AudioContext, from: FlightPhase, to: FlightPhase): void {
    if (to === 'landed') {
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(90, t0);
      o.frequency.exponentialRampToValueAtTime(40, t0 + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * this.tuning.cues, t0);
      g.gain.setTargetAtTime(0, t0 + 0.02, 0.12);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 1.2);
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
    g.gain.setValueAtTime(0.08 * this.tuning.cues, t0);
    g.gain.setTargetAtTime(0, t0, 0.015);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + 0.2);
  }

  /** Rolling thunder from a strike `distanceMeters` away. */
  thunder(distanceMeters: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const p = thunderParams(distanceMeters);
    const t0 = ctx.currentTime + p.delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(p.cutoff, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(50, p.cutoff * 0.3), t0 + p.duration);
    const g = ctx.createGain();
    const peak = p.gain * this.tuning.thunder;
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
  }

  /** Debug and test hook. */
  get contextState(): string {
    return this.ctx?.state ?? 'none';
  }
}
