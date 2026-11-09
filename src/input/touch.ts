import { config } from '../core/config';
import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';
import type { Action, Input } from './input';
import { clampKnob, sliderValue, stickToAxes, tiltFromOrientation, tiltToAxes, type Tilt } from './touchMath';
import './touch.css';

/** Touch devices, or forced with ?touch. Touch laptops with a mouse keep desktop controls. */
export function detectTouch(params: URLSearchParams): boolean {
  if (params.has('touch')) return true;
  if (typeof window === 'undefined') return false;
  const mm = (q: string): boolean => window.matchMedia?.(q).matches ?? false;
  return mm('(pointer: coarse)') || ('ontouchstart' in window && !mm('(any-pointer: fine)'));
}

const I = (d: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICONS = {
  camera: I('<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3.2"/><path d="M8 7l1.5-2h5L16 7"/>'),
  map: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  galaxy: I('<ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-25 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M5 18c4-1 6-4 7-6"/>'),
  journal: I('<path d="M6 4h11a1 1 0 0 1 1 1v15H7a1 1 0 0 1-1-1V4z"/><path d="M9 8h6M9 12h6"/>'),
  target: I('<circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  align: I('<path d="M5 4h14M12 20V9M7 13l5-5 5 5"/>'),
  hud: I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  full: I('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  tilt: I('<rect x="8" y="3" width="8" height="14" rx="2" transform="rotate(28 12 12)"/><path d="M4 19c3 2.5 8 2.5 11 0"/>'),
  photo: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 17l5-4 4 3 3-2 6 4"/>'),
  view: I('<path d="M12 4l4 8-4-1.6L8 12z" fill="currentColor"/><path d="M5 16a8 8 0 0 0 13 1M19 13.5V17h-3.5M19 16a8 8 0 0 0-13-1M5 18.5V15h3.5" transform="translate(0 2)"/>'),
  menu: I('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.8" r=".7" fill="currentColor"/>'),
  look: I('<circle cx="12" cy="12" r="3.2"/><path d="M12 3a9 9 0 0 1 9 9M12 21a9 9 0 0 1-9-9"/><path d="M19 4l2 2-3 .5zM5 20l-2-2 3-.5z" fill="currentColor"/>'),
  invert: I('<path d="M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3"/>'),
};

interface Btn {
  key: keyof typeof ICONS;
  label: string;
  tap?: Action;
}

/** The icon row, in order. Everything else lives in the menu. */
const BUTTONS: Btn[] = [
  { key: 'target', label: 'Next target', tap: 'target' },
  { key: 'view', label: 'Camera view', tap: 'camera' },
  { key: 'camera', label: 'Snapshot', tap: 'snapshot' },
  { key: 'galaxy', label: 'Galaxy map', tap: 'galaxy' },
  { key: 'full', label: 'Fullscreen' },
  { key: 'menu', label: 'Menu' },
];

interface MenuRow {
  key: keyof typeof ICONS;
  label: string;
  tap?: Action;
  /** Toggle rows keep the menu open so the new state shows. */
  stay?: boolean;
}

const MENU: MenuRow[] = [
  { key: 'map', label: 'System map', tap: 'map' },
  { key: 'journal', label: 'Journal', tap: 'journal' },
  { key: 'look', label: 'Look mode', tap: 'look' },
  { key: 'photo', label: 'Photo mode', tap: 'photo' },
  { key: 'align', label: 'Hold to align' },
  { key: 'hud', label: 'Hide HUD', tap: 'hud' },
  { key: 'tilt', label: 'Tilt steering', stay: true },
  { key: 'invert', label: 'Invert stick', stay: true },
  { key: 'info', label: 'Planet info', tap: 'info' },
];

const INVERT_KEY = 'farlight.invertStick'; // new meaning: default is push up = nose up

function isIos(): boolean {
  const n = navigator;
  return /iPad|iPhone|iPod/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
}

type Role = 'stick' | 'look' | 'slider' | 'boost' | 'pinch';

declare global {
  interface DeviceOrientationEventConstructor {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  }
}

/**
 * Touch controls for phones in landscape. Left half: floating flight stick. Right edge:
 * throttle slider, big boost button, drag on empty right space to look around. Button row on
 * top. Feeds `Input.external`, so the sim sees the same FlightInput as mouse and keyboard.
 */
export class TouchControls {
  /** Latest stick output, for tests. */
  readonly axes = { pitch: 0, yaw: 0, roll: 0 };
  private readonly layer: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly slider: HTMLElement;
  private readonly sliderTrack: HTMLElement;
  private readonly boostBtn: HTMLElement;
  private readonly buttons = new Map<string, HTMLElement>();
  private readonly menu: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();
  private menuOpen = false;
  private alignLatched = false;
  private readonly roles = new Map<number, Role>();
  private readonly origin = { x: 0, y: 0 };
  private readonly cur = { x: 0, y: 0 };
  private readonly lookLast = { x: 0, y: 0 };
  private readonly pinchPts = new Map<number, { x: number; y: number }>();
  private pinchLast = 0;
  private stickId = -1;
  private tiltOn = false;
  private tiltNeutral: Tilt | null = null;
  private tiltRaw: { beta: number; gamma: number } | null = null;
  private tiltAngle = 0;
  private sliderShown = -1;

  constructor(
    root: HTMLElement,
    private readonly input: Input,
    private readonly world: World,
    _gfx: GameRenderer,
  ) {
    this.layer = root;
    root.innerHTML = `
      <div class="t-surface" data-k="surface"></div>
      <div class="t-ghost"></div>
      <div class="t-base" data-k="base"><i data-k="knob"></i></div>
      <div class="t-slider" data-k="slider"><div class="t-track" data-k="track"><div class="t-fill"></div><div class="t-knob"></div></div></div>
      <div class="t-boost" data-k="boost"><span>BOOST</span></div>
      <div class="t-row">${BUTTONS.map((b) => `<button type="button" class="t-btn" data-b="${b.key}" aria-label="${b.label}">${ICONS[b.key]}</button>`).join('')}</div>
      <div class="t-rotate"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="15" y="6" width="18" height="30" rx="3" transform="rotate(-90 24 24) translate(0 0)"/><path d="M10 38c8 6 20 6 28 0M34 36l4 2-1-5"/></svg><div>ROTATE FOR LANDSCAPE</div></div>`;
    const q = (k: string): HTMLElement => root.querySelector(`[data-k="${k}"]`) as HTMLElement;
    this.surface = q('surface');
    this.base = q('base');
    this.knob = q('knob');
    this.slider = q('slider');
    this.sliderTrack = q('track');
    this.boostBtn = q('boost');
    for (const el of root.querySelectorAll<HTMLElement>('[data-b]')) this.buttons.set(el.dataset.b as string, el);

    // The menu lives on body, above the HUD, so taps on it never reach the stick.
    this.menu = document.createElement('div');
    this.menu.className = 't-menu-layer';
    const tip = isIos() ? '<div class="t-tip">TIP: SHARE · ADD TO HOME SCREEN FOR FULLSCREEN</div>' : '';
    this.menu.innerHTML = `<div class="t-menu-back"></div><div class="t-menu" role="menu"><div class="t-menu-grid">${MENU.map((m) => `<button type="button" class="t-row-btn" role="menuitem" data-r="${m.key}">${ICONS[m.key]}<span>${m.label}</span></button>`).join('')}</div>${tip}</div>`;
    document.body.appendChild(this.menu);
    for (const el of this.menu.querySelectorAll<HTMLElement>('[data-r]')) this.rows.set(el.dataset.r as string, el);

    // Stop the browser fighting us: scroll, zoom, long press menus.
    const stop = (e: Event): void => e.preventDefault();
    root.addEventListener('contextmenu', stop);
    root.addEventListener('gesturestart', stop);
    root.addEventListener('touchmove', stop, { passive: false });
    document.addEventListener('gesturestart', stop);
    document.addEventListener('dblclick', stop);

    this.bindSurface();
    this.bindSlider();
    this.bindHold(this.boostBtn, 'boost');
    this.bindButtons();

    input.external.active = true;
    screen.orientation?.addEventListener?.('change', () => (this.tiltNeutral = null));
    this.syncButtons();
  }

  // Pointer plumbing

  private track(e: PointerEvent, el: HTMLElement, role: Role): void {
    this.roles.set(e.pointerId, role);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers can fail to capture */
    }
    this.layer.classList.add(`on-${role}`);
  }

  private release(e: PointerEvent): void {
    const role = this.roles.get(e.pointerId);
    if (!role) return;
    this.roles.delete(e.pointerId);
    this.pinchPts.delete(e.pointerId);
    this.layer.classList.remove(`on-${role}`);
    if (role === 'stick') this.endStick();
    else if (role === 'look') this.input.rightMouse = false;
    else if (role === 'pinch') this.pinchLast = 0;
    else if (role === 'boost') this.input.external.boost = false;
  }

  private bindEnd(el: HTMLElement): void {
    el.addEventListener('pointerup', (e) => this.release(e));
    el.addEventListener('pointercancel', (e) => this.release(e));
    el.addEventListener('lostpointercapture', (e) => this.release(e));
  }

  private bindSurface(): void {
    const s = this.surface;
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const left = e.clientX < window.innerWidth / 2;
      if (left && this.stickId < 0) {
        this.track(e, s, 'stick');
        this.stickId = e.pointerId;
        this.origin.x = this.cur.x = e.clientX;
        this.origin.y = this.cur.y = e.clientY;
        this.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        this.knob.style.transform = 'translate(0px, 0px)';
      } else if (!left && ![...this.roles.values()].includes('look')) {
        this.track(e, s, 'look');
        this.input.rightMouse = true;
        this.lookLast.x = e.clientX;
        this.lookLast.y = e.clientY;
        this.pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      } else if (!left && this.input.lookMode && this.pinchPts.size === 1) {
        // Second finger on the right side in look mode: pinch zoom.
        this.track(e, s, 'pinch');
        this.pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.pinchLast = this.pinchSpan();
      }
    });
    s.addEventListener('pointermove', (e) => {
      const role = this.roles.get(e.pointerId);
      if (role === 'stick') {
        this.cur.x = e.clientX;
        this.cur.y = e.clientY;
      } else if (role === 'pinch') {
        this.pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const d = this.pinchSpan();
        if (this.pinchLast > 0 && d > 0) this.input.addZoom(Math.log(this.pinchLast / d));
        this.pinchLast = d;
      } else if (role === 'look') {
        if (this.pinchPts.has(e.pointerId)) this.pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const k = config.touch.lookScale;
        if (![...this.roles.values()].includes('pinch')) {
          this.input.look.x += (e.clientX - this.lookLast.x) * k;
          this.input.look.y += (e.clientY - this.lookLast.y) * k;
        }
        this.lookLast.x = e.clientX;
        this.lookLast.y = e.clientY;
      }
    });
    this.bindEnd(s);
  }

  private pinchSpan(): number {
    if (this.pinchPts.size < 2) return 0;
    const [a, b] = [...this.pinchPts.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  }

  private bindSlider(): void {
    const set = (e: PointerEvent): void => {
      const r = this.sliderTrack.getBoundingClientRect();
      const pad = 14;
      this.input.external.throttleSet = sliderValue(e.clientY, r.top + pad, r.height - pad * 2);
    };
    this.slider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.track(e, this.slider, 'slider');
      set(e);
    });
    this.slider.addEventListener('pointermove', (e) => {
      if (this.roles.get(e.pointerId) === 'slider') set(e);
    });
    this.bindEnd(this.slider);
  }

  private bindHold(el: HTMLElement, role: 'boost'): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.track(e, el, role);
      this.input.external.boost = true;
    });
    this.bindEnd(el);
  }

  private bindButtons(): void {
    for (const b of BUTTONS) {
      const el = this.buttons.get(b.key)!;
      if (b.tap) {
        const action = b.tap;
        el.addEventListener('click', () => this.input.emit(action));
      }
    }
    this.buttons.get('menu')!.addEventListener('click', () => this.setMenu(!this.menuOpen));
    (this.menu.querySelector('.t-menu-back') as HTMLElement).addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.setMenu(false);
    });
    for (const m of MENU) {
      const el = this.rows.get(m.key)!;
      el.addEventListener('click', () => {
        if (m.tap) this.input.emit(m.tap);
        if (!m.stay) this.setMenu(false);
      });
    }
    this.rows.get('align')!.addEventListener('click', () => {
      this.alignLatched = !this.alignLatched;
      this.input.external.align = this.alignLatched;
      this.syncButtons();
    });
    this.rows.get('invert')!.addEventListener('click', () => {
      config.touch.invertPitch = !config.touch.invertPitch;
      try {
        localStorage.setItem(INVERT_KEY, config.touch.invertPitch ? '1' : '0');
      } catch {
        /* storage may be blocked */
      }
      this.syncButtons();
    });
    this.rows.get('tilt')!.addEventListener('click', () => void this.toggleTilt());
    const full = this.buttons.get('full')!;
    if (!document.documentElement.requestFullscreen) full.style.display = 'none';
    full.addEventListener('click', () => void this.toggleFullscreen());
    try {
      if (localStorage.getItem(INVERT_KEY) === '1') config.touch.invertPitch = true;
    } catch {
      /* ignore */
    }
    this.armFullscreen();
  }

  private setMenu(open: boolean): void {
    this.menuOpen = open;
    this.menu.classList.toggle('open', open);
    this.syncButtons();
  }

  private syncButtons(): void {
    this.rows.get('invert')!.classList.toggle('active', config.touch.invertPitch);
    this.rows.get('look')!.classList.toggle('active', this.input.lookMode);
    this.rows.get('tilt')!.classList.toggle('active', this.tiltOn);
    this.rows.get('align')!.classList.toggle('active', this.alignLatched);
    this.buttons.get('menu')!.classList.toggle('active', this.menuOpen || this.alignLatched || this.input.lookMode);
  }

  // Fullscreen and tilt

  /**
   * Browsers want a user gesture. While in landscape and not fullscreen, the next pointer
   * press anywhere asks for fullscreen once. Leaving fullscreen by hand does not re-arm it;
   * rotating the phone does.
   */
  private armFullscreen(): void {
    const root = document.documentElement;
    if (!root.requestFullscreen) return;
    const mq = window.matchMedia('(orientation: landscape)');
    let armed = false;
    const go = (e: Event): void => {
      if (!armed) return;
      if (e.type === 'pointerup') disarm(); // the press is over: one more try at most
      if (!mq.matches || document.fullscreenElement) return;
      void this.enterFullscreen().then((ok) => ok && disarm());
    };
    const disarm = (): void => {
      armed = false;
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('pointerup', go, true);
    };
    const arm = (): void => {
      if (armed || !mq.matches || document.fullscreenElement) return;
      armed = true;
      window.addEventListener('pointerdown', go, true);
      window.addEventListener('pointerup', go, true);
    };
    arm();
    const rotated = (): void => {
      disarm();
      arm();
    };
    mq.addEventListener?.('change', rotated);
    screen.orientation?.addEventListener?.('change', rotated);
  }

  private async enterFullscreen(): Promise<boolean> {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return false;
    }
    try {
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } catch {
      /* not supported outside installed apps: fine */
    }
    return true;
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.enterFullscreen();
    } catch {
      /* unsupported or denied: fine */
    }
  }

  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    this.tiltRaw = { beta: e.beta, gamma: e.gamma };
  };

  private async toggleTilt(): Promise<void> {
    if (this.tiltOn) {
      this.tiltOn = false;
      window.removeEventListener('deviceorientation', this.onOrientation);
      this.syncButtons();
      return;
    }
    const DOE = (window as unknown as { DeviceOrientationEvent?: DeviceOrientationEventConstructor }).DeviceOrientationEvent;
    try {
      // iOS 13+ needs a permission prompt from a user gesture.
      if (DOE?.requestPermission && (await DOE.requestPermission()) !== 'granted') return;
    } catch {
      return;
    }
    if (!DOE) return;
    this.tiltOn = true;
    this.tiltNeutral = null;
    window.addEventListener('deviceorientation', this.onOrientation);
    this.syncButtons();
  }

  // Frame

  private endStick(): void {
    this.stickId = -1;
    this.axes.pitch = this.axes.yaw = this.axes.roll = 0;
  }

  update(_realDt: number): void {
    const ext = this.input.external;
    const mapOpen = document.getElementById('map')?.style.display === 'block';
    this.layer.style.display = mapOpen ? 'none' : '';
    if (mapOpen && this.menuOpen) this.setMenu(false);
    if (mapOpen && this.roles.size) {
      for (const id of [...this.roles.keys()]) this.release({ pointerId: id } as PointerEvent);
    }

    const c = config.touch;
    let pitch = 0;
    let yaw = 0;
    let roll = 0;
    if (this.stickId >= 0) {
      const rollFactor = this.world.env.stabilization < 0.2 ? c.spaceRoll : 0;
      const a = stickToAxes(this.cur.x - this.origin.x, this.cur.y - this.origin.y, c.stickRadius, c.deadzone, c.invertPitch, rollFactor);
      pitch = a.pitch;
      yaw = a.yaw;
      roll = a.roll;
      const k = clampKnob(this.cur.x - this.origin.x, this.cur.y - this.origin.y, c.stickRadius);
      this.knob.style.transform = `translate(${k.x.toFixed(1)}px, ${k.y.toFixed(1)}px)`;
    } else if (this.tiltOn && this.tiltRaw) {
      const angle = screen.orientation?.angle ?? 0;
      const t = tiltFromOrientation(this.tiltRaw.beta, this.tiltRaw.gamma, angle);
      if (!this.tiltNeutral || angle !== this.tiltAngle) {
        this.tiltNeutral = t;
        this.tiltAngle = angle;
      }
      const a = tiltToAxes(t, this.tiltNeutral, c.tiltRange, c.tiltDeadzone, c.invertPitch);
      pitch = a.pitch;
      yaw = a.yaw;
      const rollFactor = this.world.env.stabilization < 0.2 ? c.spaceRoll : 0;
      roll = a.yaw * rollFactor;
    }
    this.axes.pitch = pitch;
    this.axes.yaw = yaw;
    this.axes.roll = roll;
    ext.pitch = pitch;
    ext.yaw = yaw;
    ext.roll = roll;

    // Slider shows the real throttle, so W/S and the slider stay in sync.
    const t = this.world.ship.throttle;
    if (Math.abs(t - this.sliderShown) > 0.002) {
      this.sliderShown = t;
      this.slider.style.setProperty('--t', t.toFixed(3));
    }
    this.boostBtn.classList.toggle('lit', this.world.ship.boosting);
    if (this.alignLatched && !this.world.target) {
      this.alignLatched = false;
      ext.align = false;
    }
    this.syncButtons();
  }
}
