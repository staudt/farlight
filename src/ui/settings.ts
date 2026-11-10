import type { AudioEngine } from '../audio/audio';
import type { Input } from '../input/input';
import { quality, type QualityPreset } from '../render/quality';
import {
  applyConfigSettings,
  applyDomSettings,
  FOV_RANGE,
  type HudScale,
  type QualitySetting,
  SENS_RANGE,
  type Settings,
  settings as store,
  type SettingsStore,
} from './settingsStore';
import './settings.css';

interface Deps {
  input: Input;
  audio: AudioEngine;
  touchOn: boolean;
  /** Wipes journal, visited and surveyed. */
  onResetProgress: () => void;
}

type Row =
  | { kind: 'seg'; key: 'quality' | 'hudScale'; label: string; options: { value: string; label: string }[] }
  | { kind: 'range'; key: keyof Settings; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
  | { kind: 'toggle'; key: keyof Settings; label: string };

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const mult = (v: number): string => `${v.toFixed(2)}x`;

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'DISPLAY',
    rows: [
      {
        kind: 'seg',
        key: 'quality',
        label: 'Quality',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      { kind: 'range', key: 'fov', label: 'Field of view', min: FOV_RANGE.min, max: FOV_RANGE.max, step: 1, fmt: (v) => `${Math.round(v)}°` },
      { kind: 'toggle', key: 'showFps', label: 'Show FPS' },
      {
        kind: 'seg',
        key: 'hudScale',
        label: 'HUD size',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'normal', label: 'Normal' },
          { value: 'large', label: 'Large' },
        ],
      },
    ],
  },
  {
    title: 'CONTROLS',
    rows: [
      { kind: 'range', key: 'mouseSens', label: 'Mouse sensitivity', min: SENS_RANGE.min, max: SENS_RANGE.max, step: 0.05, fmt: mult },
      { kind: 'toggle', key: 'invertMouseY', label: 'Invert mouse Y' },
      { kind: 'range', key: 'lookSens', label: 'Look sensitivity', min: SENS_RANGE.min, max: SENS_RANGE.max, step: 0.05, fmt: mult },
      { kind: 'toggle', key: 'invertStick', label: 'Invert touch stick' },
      { kind: 'toggle', key: 'invertPad', label: 'Invert gamepad' },
    ],
  },
  {
    title: 'AUDIO',
    rows: [
      { kind: 'range', key: 'volMaster', label: 'Master volume', min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', key: 'volMusic', label: 'Music and drone', min: 0, max: 1, step: 0.05, fmt: pct },
      { kind: 'range', key: 'volFx', label: 'Effects', min: 0, max: 1, step: 0.05, fmt: pct },
    ],
  },
];

/** Applies the settings that need live objects (input, audio, quality). */
export function applyRuntimeSettings(s: Settings, deps: Pick<Deps, 'input' | 'audio' | 'touchOn'>, key?: keyof Settings): void {
  if (key === undefined || key === 'mouseSens') deps.input.sensitivity = 0.0022 * s.mouseSens;
  if (key === undefined || key === 'invertMouseY') deps.input.invertY = s.invertMouseY;
  if (key === undefined || key === 'lookSens') deps.input.lookScale = s.lookSens;
  if (key === undefined || key === 'volMaster' || key === 'volMusic' || key === 'volFx') {
    deps.audio.volume.master = s.volMaster;
    deps.audio.volume.music = s.volMusic;
    deps.audio.volume.fx = s.volFx;
  }
  if (key === 'quality') quality.setPreset(s.quality as QualityPreset, deps.touchOn);
}

/** Full screen settings panel in the HUD style. Opened with O or from the touch menu. */
export class SettingsScreen {
  private readonly root: HTMLElement;
  private readonly controls = new Map<string, (s: Settings) => void>();
  private open_ = false;
  private resetTimer = 0;
  private readonly resetBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;

  constructor(
    deps: Deps,
    private readonly st: SettingsStore = store,
  ) {
    const root = document.createElement('div');
    root.className = 'settings-layer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Settings');
    root.innerHTML = `
      <div class="st-back"></div>
      <div class="st-panel">
        <div class="st-head"><div class="st-title">SETTINGS</div>
          <button type="button" class="st-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="st-body"></div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    const body = root.querySelector('.st-body') as HTMLElement;

    for (const sec of SECTIONS) {
      const box = document.createElement('section');
      box.className = 'st-sec';
      box.innerHTML = `<h3>${sec.title}</h3>`;
      for (const row of sec.rows) box.appendChild(this.buildRow(row));
      body.appendChild(box);
    }

    const flight = document.createElement('section');
    flight.className = 'st-sec';
    flight.innerHTML = '<h3>FLIGHT</h3>';
    flight.appendChild(this.buildRow({ kind: 'toggle', key: 'resume', label: 'Resume last flight' }));
    const reset = document.createElement('div');
    reset.className = 'st-row st-reset';
    reset.innerHTML = '<span class="st-label">Progress</span><span class="st-ctl"><button type="button" class="st-btn danger" data-k="reset">Reset progress</button><button type="button" class="st-btn" data-k="cancel" hidden>Cancel</button></span>';
    flight.appendChild(reset);
    body.appendChild(flight);
    this.resetBtn = reset.querySelector('[data-k="reset"]') as HTMLButtonElement;
    this.cancelBtn = reset.querySelector('[data-k="cancel"]') as HTMLButtonElement;
    this.resetBtn.addEventListener('click', () => {
      if (this.resetBtn.dataset.armed === '1') {
        this.disarm();
        deps.onResetProgress();
        this.resetBtn.textContent = 'Progress cleared';
        window.setTimeout(() => (this.resetBtn.textContent = 'Reset progress'), 2000);
      } else {
        this.resetBtn.dataset.armed = '1';
        this.resetBtn.textContent = 'Confirm reset';
        this.cancelBtn.hidden = false;
        this.resetTimer = window.setTimeout(() => this.disarm(), 6000);
      }
    });
    this.cancelBtn.addEventListener('click', () => this.disarm());

    (root.querySelector('.st-close') as HTMLElement).addEventListener('click', () => this.close());
    (root.querySelector('.st-back') as HTMLElement).addEventListener('pointerdown', () => this.close());
    // While open, the flight keys do nothing. Keyup still passes so no key sticks.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.open_) return;
        if (e.code === 'Escape' || e.code === 'KeyO') {
          e.preventDefault();
          this.close();
        }
        e.stopImmediatePropagation();
      },
      true,
    );
    deps.input.on('settings', () => this.toggle());
    deps.input.on('back', () => this.close());

    this.st.onChange((s, key) => {
      applyConfigSettings(s);
      applyDomSettings(s);
      applyRuntimeSettings(s, deps, key);
      this.sync();
    });
    applyRuntimeSettings(this.st.value, deps);
    this.sync();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.add('open');
    this.sync();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.disarm();
    this.root.classList.remove('open');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  private disarm(): void {
    window.clearTimeout(this.resetTimer);
    delete this.resetBtn.dataset.armed;
    this.resetBtn.textContent = 'Reset progress';
    this.cancelBtn.hidden = true;
  }

  private sync(): void {
    const s = this.st.value;
    // The URL can override the quality preset, so show what is really active.
    for (const fn of this.controls.values()) fn({ ...s, quality: quality.preset as QualitySetting });
  }

  private buildRow(row: Row): HTMLElement {
    const el = document.createElement('div');
    el.className = 'st-row';
    const label = document.createElement('span');
    label.className = 'st-label';
    label.textContent = row.label;
    const ctl = document.createElement('span');
    ctl.className = 'st-ctl';
    el.append(label, ctl);

    if (row.kind === 'seg') {
      const buttons = row.options.map((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'st-seg';
        b.textContent = o.label;
        b.addEventListener('click', () => this.st.set(row.key, o.value as never));
        ctl.appendChild(b);
        return { b, value: o.value };
      });
      this.controls.set(row.key, (s) => {
        const cur = String(row.key === 'quality' ? s.quality : (s.hudScale as HudScale));
        for (const x of buttons) x.b.classList.toggle('on', x.value === cur);
      });
    } else if (row.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = String(row.step);
      const out = document.createElement('span');
      out.className = 'st-val';
      input.addEventListener('input', () => this.st.set(row.key, Number(input.value) as never));
      ctl.append(input, out);
      this.controls.set(row.key, (s) => {
        const v = s[row.key] as number;
        input.value = String(v);
        out.textContent = row.fmt(v);
      });
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'st-toggle';
      b.setAttribute('role', 'switch');
      b.addEventListener('click', () => this.st.set(row.key, !this.st.get(row.key) as never));
      ctl.appendChild(b);
      this.controls.set(row.key, (s) => {
        const on = s[row.key] as boolean;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.textContent = on ? 'On' : 'Off';
      });
    }
    return el;
  }
}
