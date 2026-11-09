import { config } from '../core/config';

export type QualityName = 'low' | 'medium' | 'high';
export type QualityPreset = 'auto' | QualityName;
export const QUALITY_LEVELS: readonly QualityName[] = ['low', 'medium', 'high'];

export type QualitySettings = (typeof config.quality.presets)['low'];

export function parseQuality(v: string | null | undefined): QualityPreset {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'auto' ? v : config.quality.preset;
}

/** First guess for 'auto' from the device: phones and tablets start lower. */
export function initialLevel(preset: QualityPreset, coarsePointer: boolean): QualityName {
  if (preset !== 'auto') return preset;
  return coarsePointer ? 'medium' : 'high';
}

/**
 * Auto adapt state machine (pure, fed with frame times). Averages fps over 0.5 s blocks.
 * Steps down after `downSecs` of low fps, up after `upSecs` of full speed fps. After a step
 * down it waits `upCooldown` before stepping up, and the wait doubles when the step up bounced.
 */
export class AutoAdapter {
  private blockT = 0;
  private blockN = 0;
  private lowFor = 0;
  private highFor = 0;
  private t = 0;
  private upBlockedUntil = 0;
  private cooldown = 0;
  private lastUpAt = -Infinity;

  /** Returns the level change wanted (-1, 0, +1) for this frame. */
  update(dt: number, level: QualityName): -1 | 0 | 1 {
    const q = config.quality;
    this.t += dt;
    if (this.t < q.warmup) return 0;
    this.blockT += dt;
    this.blockN++;
    if (this.blockT < 0.5) return 0;
    const fps = this.blockN / this.blockT;
    this.blockT = 0;
    this.blockN = 0;
    const idx = QUALITY_LEVELS.indexOf(level);

    this.lowFor = fps < q.downFps ? this.lowFor + 0.5 : 0;
    this.highFor = fps >= q.upFps ? this.highFor + 0.5 : 0;

    if (this.lowFor >= q.downSecs && idx > 0) {
      // Bounce: we stepped up recently and it was too much.
      this.cooldown = this.t - this.lastUpAt < q.upCooldown ? Math.max(this.cooldown * 2, q.upCooldown * 2) : q.upCooldown;
      this.upBlockedUntil = this.t + this.cooldown;
      this.reset();
      return -1;
    }
    if (this.highFor >= q.upSecs && idx < QUALITY_LEVELS.length - 1 && this.t >= this.upBlockedUntil) {
      this.lastUpAt = this.t;
      this.reset();
      return 1;
    }
    return 0;
  }

  private reset(): void {
    this.lowFor = 0;
    this.highFor = 0;
  }
}

/** Active quality: preset choice, current level and live listeners. */
export class QualityManager {
  preset: QualityPreset = 'auto';
  private level: QualityName = 'high';
  private readonly adapter = new AutoAdapter();
  private readonly listeners: ((s: QualitySettings, name: QualityName) => void)[] = [];

  init(urlParam: string | null, coarsePointer: boolean): void {
    this.preset = parseQuality(urlParam);
    this.level = initialLevel(this.preset, coarsePointer);
  }

  get name(): QualityName {
    return this.level;
  }

  get settings(): QualitySettings {
    return config.quality.presets[this.level];
  }

  /** Short label for the FPS counter, e.g. "AUTO HIGH" or "LOW". */
  get label(): string {
    return (this.preset === 'auto' ? 'AUTO ' : '') + this.level.toUpperCase();
  }

  /** Subscribes and calls back immediately with the current settings. */
  onChange(cb: (s: QualitySettings, name: QualityName) => void): void {
    this.listeners.push(cb);
    cb(this.settings, this.level);
  }

  setPreset(p: QualityPreset, coarsePointer = false): void {
    this.preset = p;
    this.setLevel(initialLevel(p, coarsePointer));
  }

  setLevel(l: QualityName): void {
    this.level = l;
    this.notify();
  }

  /** Re-applies the current settings (after editing a preset live in the debug panel). */
  notify(): void {
    for (const cb of this.listeners) cb(this.settings, this.level);
  }

  /** Per frame: runs the auto adapter. */
  update(realDt: number): void {
    if (this.preset !== 'auto') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const step = this.adapter.update(realDt, this.level);
    if (step !== 0) this.setLevel(QUALITY_LEVELS[QUALITY_LEVELS.indexOf(this.level) + step]!);
  }
}

export const quality = new QualityManager();
