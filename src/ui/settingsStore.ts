import { config } from '../core/config';

export const SETTINGS_KEY = 'farlight.settings.v1';
const LEGACY_STICK_KEY = 'farlight.invertStick';
const LEGACY_PAD_KEY = 'farlight.padInvertPitch';

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';
export type HudScale = 'small' | 'normal' | 'large';

export interface Settings {
  quality: QualitySetting;
  /** Multipliers, 1 is the built in feel. */
  mouseSens: number;
  lookSens: number;
  invertMouseY: boolean;
  invertStick: boolean;
  invertPad: boolean;
  /** 0..1 */
  volMaster: number;
  volMusic: number;
  volFx: number;
  /** Degrees. */
  fov: number;
  showFps: boolean;
  hudScale: HudScale;
  resume: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  mouseSens: 1,
  lookSens: 1,
  invertMouseY: false,
  invertStick: false,
  invertPad: false,
  volMaster: 1,
  volMusic: 1,
  volFx: 1,
  fov: 62,
  showFps: true,
  hudScale: 'normal',
  resume: true,
};

export const HUD_SCALES: Record<HudScale, number> = { small: 0.85, normal: 1, large: 1.2 };
export const SENS_RANGE = { min: 0.25, max: 3 } as const;
export const FOV_RANGE = { min: 50, max: 100 } as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Validates untrusted data into a full Settings object. */
export function sanitize(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    quality: r.quality === 'low' || r.quality === 'medium' || r.quality === 'high' || r.quality === 'auto' ? r.quality : d.quality,
    mouseSens: num(r.mouseSens, SENS_RANGE.min, SENS_RANGE.max, d.mouseSens),
    lookSens: num(r.lookSens, SENS_RANGE.min, SENS_RANGE.max, d.lookSens),
    invertMouseY: bool(r.invertMouseY, d.invertMouseY),
    invertStick: bool(r.invertStick, d.invertStick),
    invertPad: bool(r.invertPad, d.invertPad),
    volMaster: num(r.volMaster, 0, 1, d.volMaster),
    volMusic: num(r.volMusic, 0, 1, d.volMusic),
    volFx: num(r.volFx, 0, 1, d.volFx),
    fov: num(r.fov, FOV_RANGE.min, FOV_RANGE.max, d.fov),
    showFps: bool(r.showFps, d.showFps),
    hudScale: r.hudScale === 'small' || r.hudScale === 'normal' || r.hudScale === 'large' ? r.hudScale : d.hudScale,
    resume: bool(r.resume, d.resume),
  };
}

/** One persisted settings object, with change listeners. Reads the old per feature keys once. */
export class SettingsStore {
  value: Settings = { ...DEFAULT_SETTINGS };
  private readonly listeners: ((s: Settings, key: keyof Settings) => void)[] = [];

  constructor(private readonly storage: StorageLike | null = defaultStorage()) {
    this.load();
  }

  private load(): void {
    const raw = ((): string | null => {
      try {
        return this.storage?.getItem(SETTINGS_KEY) ?? null;
      } catch {
        return null;
      }
    })();
    if (raw) {
      try {
        this.value = sanitize(JSON.parse(raw));
        return;
      } catch {
        /* fall through to defaults */
      }
    }
    // Migrate the older single purpose keys.
    const legacy = (k: string): boolean => {
      try {
        return this.storage?.getItem(k) === '1';
      } catch {
        return false;
      }
    };
    this.value = { ...DEFAULT_SETTINGS, invertStick: legacy(LEGACY_STICK_KEY), invertPad: legacy(LEGACY_PAD_KEY) };
  }

  private save(): void {
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.value));
    } catch {
      /* storage unavailable: settings last for the session */
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.value[key];
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    const next = sanitize({ ...this.value, [key]: v });
    if (next[key] === this.value[key]) return;
    this.value = next;
    this.save();
    for (const cb of this.listeners) cb(this.value, key);
  }

  /** Calls back on every change. */
  onChange(cb: (s: Settings, key: keyof Settings) => void): void {
    this.listeners.push(cb);
  }
}

export const settings = new SettingsStore();

/** Applies the settings that live in `config`. Safe to call early and again on change. */
export function applyConfigSettings(s: Settings): void {
  config.touch.invertPitch = s.invertStick;
  config.gamepad.invertPitch = s.invertPad;
  config.camera.fov = s.fov;
}

/** HUD scale and the FPS toggle are CSS only. */
export function applyDomSettings(s: Settings): void {
  const root = document.documentElement;
  root.style.setProperty('--hud-scale', String(HUD_SCALES[s.hudScale]));
  document.body.classList.toggle('no-fps', !s.showFps);
}
