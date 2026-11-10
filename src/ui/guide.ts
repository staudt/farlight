import type { World } from '../sim/world';
import { noDashes } from './format';
import { settings as store, type SettingsStore } from './settingsStore';
import './guide.css';

export type Device = 'keyboard' | 'touch' | 'gamepad';
export type TipId = 'throttle' | 'space' | 'speedup' | 'target' | 'land' | 'sunset' | 'landmark' | 'maps' | 'look' | 'glow';

/** Tunables for the guide timing. */
export const GUIDE = {
  flightDelay: 6,
  atmoDelay: 25,
  spaceTargetDelay: 20,
  spacing: 45,
  showSeconds: 7,
  mapsPlaySeconds: 360,
  lookPlaySeconds: 600,
  /** Atmosphere depth that counts as close to the ground for the night glow tip. */
  glowDepth: 0.5,
} as const;

/** Keys go in braces and get the HUD key style. */
const TEXT: Record<TipId, Record<Device, string>> = {
  throttle: {
    keyboard: '{W} {S} OR THE WHEEL SET THROTTLE',
    touch: 'DRAG THE {RIGHT SLIDER} FOR THROTTLE',
    gamepad: '{RT} FASTER · {LT} SLOWER',
  },
  space: {
    keyboard: 'HOLD {SHIFT} AND PULL UP TO REACH SPACE',
    touch: 'HOLD {BOOST} AND PULL BACK',
    gamepad: 'HOLD {A} AND PULL UP TO REACH SPACE',
  },
  speedup: {
    keyboard: 'PRESS {.} TO SPEED UP TIME',
    touch: 'TAP {»} BESIDE TIME',
    gamepad: 'PRESS {D-PAD RIGHT} TO SPEED UP TIME',
  },
  target: {
    keyboard: 'PRESS {T} TO TARGET A PLANET · HOLD {F} TO FLY TO IT',
    touch: 'TAP {TARGET} · THEN HOLD {ALIGN} IN MENU',
    gamepad: 'PRESS {Y} TO TARGET A PLANET · HOLD {X} TO FLY TO IT',
  },
  land: {
    keyboard: 'THROTTLE DOWN NEAR THE GROUND TO LAND',
    touch: 'THROTTLE DOWN NEAR THE GROUND TO LAND',
    gamepad: 'THROTTLE DOWN NEAR THE GROUND TO LAND',
  },
  sunset: {
    keyboard: 'TIME RUNS UP TO ×10000 WHILE LANDED · WATCH THE SUN SET',
    touch: 'TIME RUNS UP TO ×10000 WHILE LANDED · WATCH THE SUN SET',
    gamepad: 'TIME RUNS UP TO ×10000 WHILE LANDED · WATCH THE SUN SET',
  },
  landmark: {
    keyboard: 'FLY TO A {?} TO DISCOVER IT',
    touch: 'FLY TO A {?} TO DISCOVER IT',
    gamepad: 'FLY TO A {?} TO DISCOVER IT',
  },
  maps: {
    keyboard: 'PRESS {G} FOR THE GALAXY · {J} FOR YOUR JOURNAL',
    touch: 'TAP {GALAXY} FOR THE GALAXY · {MENU} FOR YOUR JOURNAL',
    gamepad: 'PRESS {START} FOR THE GALAXY · {BACK} FOR THE MAP',
  },
  look: {
    keyboard: 'PRESS {V} TO LOOK AROUND · {K} FOR A SNAPSHOT',
    touch: 'TAP {MENU} TO LOOK AROUND · {CAMERA} FOR A SNAPSHOT',
    gamepad: 'PRESS {L3} TO LOOK AROUND · HOLD {BACK} FOR A SNAPSHOT',
  },
  glow: {
    keyboard: 'NIGHT SIDES GLOW',
    touch: 'NIGHT SIDES GLOW',
    gamepad: 'NIGHT SIDES GLOW',
  },
};

/** Tip text for a device, with keys still in braces. */
export function tipText(id: TipId, device: Device): string {
  return noDashes(TEXT[id][device]);
}

/** Splits `{KEY}` markers into plain and key segments. */
export function tipSegments(text: string): { text: string; key: boolean }[] {
  const out: { text: string; key: boolean }[] = [];
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (!part) continue;
    if (part.startsWith('{')) out.push({ text: part.slice(1, -1), key: true });
    else out.push({ text: part, key: false });
  }
  return out;
}

/** What the guide looks at each frame. Plain data so the state machine is easy to test. */
export interface GuideSnapshot {
  /** Real seconds since the last update. */
  dt: number;
  /** A map, settings, photo mode or other overlay is open. */
  blocked: boolean;
  phase: 'space' | 'near' | 'atmosphere' | 'landed';
  atmosphereDepth: number;
  warp: number;
  throttle: number;
  hasTarget: boolean;
  /** An undiscovered landmark marker is on screen. */
  undiscoveredMarker: boolean;
  /** Landmarks discovered so far. */
  discovered: number;
  /** Night side of a body with city or bio lights, near the ground. */
  nightLights: boolean;
}

const ORDER: TipId[] = ['throttle', 'space', 'speedup', 'target', 'land', 'sunset', 'landmark', 'maps', 'look', 'glow'];

/** Pure state machine: which tip to show, and when the suggested action has happened. */
export class GuideLogic {
  enabled = true;
  readonly seen = new Set<TipId>();
  /** Tip currently on screen. */
  current: TipId | null = null;
  shownFor = 0;
  private sinceShown = Infinity;
  private flight = 0;
  private atmo = 0;
  private spaceNoTarget = 0;
  private play = 0;
  private inSpace = 0;
  private spaceSeen = false;
  private landedSeen = false;
  private markerSeen = false;
  private discoveredAtStart = -1;
  private throttleAtShow = 0;
  private discoveredAtShow = 0;

  /** Returns the tip to start showing, if any. `current` is cleared when the tip is done or has run its time. */
  update(s: GuideSnapshot): TipId | null {
    if (s.blocked) {
      this.current = null; // overlays hide the tip; it counts as seen
      return null;
    }
    this.sinceShown += s.dt;
    this.flight += s.dt;
    this.play += s.dt;
    if (this.discoveredAtStart < 0) this.discoveredAtStart = s.discovered;
    if (s.phase === 'atmosphere') this.atmo += s.dt;
    if (s.phase === 'space') {
      this.inSpace += s.dt;
      this.spaceSeen = true;
      if (!s.hasTarget) this.spaceNoTarget += s.dt;
    }
    if (s.phase === 'landed') this.landedSeen = true;
    if (s.undiscoveredMarker) this.markerSeen = true;

    if (this.current) {
      this.shownFor += s.dt;
      if (this.shownFor >= GUIDE.showSeconds || this.done(this.current, s)) this.current = null;
      return null;
    }
    if (!this.enabled || this.sinceShown < GUIDE.spacing) return null;
    for (const id of ORDER) {
      if (this.seen.has(id) || !this.ready(id, s)) continue;
      this.seen.add(id);
      this.current = id;
      this.shownFor = 0;
      this.sinceShown = 0;
      this.throttleAtShow = s.throttle;
      this.discoveredAtShow = s.discovered;
      return id;
    }
    return null;
  }

  private ready(id: TipId, s: GuideSnapshot): boolean {
    switch (id) {
      case 'throttle':
        return this.flight >= GUIDE.flightDelay && s.phase !== 'landed';
      case 'space':
        return this.atmo >= GUIDE.atmoDelay && s.phase === 'atmosphere';
      case 'speedup':
        return s.phase === 'space' && this.inSpace > 1 && s.warp <= 1;
      case 'target':
        return s.phase === 'space' && this.spaceNoTarget >= GUIDE.spaceTargetDelay && !s.hasTarget;
      case 'land':
        return this.spaceSeen && s.phase === 'atmosphere';
      case 'sunset':
        return s.phase === 'landed' && this.landedSeen;
      case 'landmark':
        return this.markerSeen && s.undiscoveredMarker;
      case 'maps':
        return s.discovered > this.discoveredAtStart || this.play >= GUIDE.mapsPlaySeconds;
      case 'look':
        return this.play >= GUIDE.lookPlaySeconds;
      case 'glow':
        return s.nightLights && s.atmosphereDepth > GUIDE.glowDepth;
    }
  }

  /** The suggested action happened. */
  private done(id: TipId, s: GuideSnapshot): boolean {
    switch (id) {
      case 'throttle':
        return Math.abs(s.throttle - this.throttleAtShow) > 0.08;
      case 'space':
        return s.phase === 'space';
      case 'speedup':
        return s.warp > 1;
      case 'target':
        return s.hasTarget;
      case 'land':
        return s.phase === 'landed';
      case 'landmark':
        return s.discovered > this.discoveredAtShow;
      default:
        return false;
    }
  }
}

/** Shows tips near the bottom centre. Reads the world each frame. */
export class Guide {
  readonly logic = new GuideLogic();
  private readonly el: HTMLElement;
  private readonly text: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly ctx: {
      blocked: () => boolean;
      device: () => Device;
      undiscoveredMarker: () => boolean;
    },
    private readonly st: SettingsStore = store,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'guide-tip';
    this.el.setAttribute('aria-live', 'polite');
    this.text = document.createElement('div');
    this.text.className = 'guide-text';
    this.el.appendChild(this.text);
    (root.querySelector('.hud-layer') ?? root).appendChild(this.el);
    this.sync();
  }

  /** Reloads seen ids and the toggle from settings (they can change in the settings screen). */
  private sync(): void {
    this.logic.enabled = this.st.get('showTips');
    const saved = new Set(this.st.get('tipsSeen'));
    for (const id of [...this.logic.seen]) if (!saved.has(id)) this.logic.seen.delete(id);
    for (const id of saved) if (ORDER.includes(id as TipId)) this.logic.seen.add(id as TipId);
  }

  update(realDt: number): void {
    this.sync();
    const w = this.world;
    const next = this.logic.update({
      dt: realDt,
      blocked: this.ctx.blocked(),
      phase: w.phase,
      atmosphereDepth: w.atmosphereDepth,
      warp: w.clock.warp,
      throttle: w.ship.throttle,
      hasTarget: w.target !== null,
      undiscoveredMarker: this.ctx.undiscoveredMarker(),
      discovered: w.landmarks.all.filter((l) => l.discovered).length,
      nightLights: w.phase !== 'landed' && this.nightLights(),
    });
    if (next) {
      this.st.set('tipsSeen', [...this.logic.seen]);
      this.show(next);
    }
    if (!this.logic.current) this.el.classList.remove('on');
  }

  private nightLights(): boolean {
    const w = this.world;
    const body = w.ship.frame.body;
    const t = body.def.terrain;
    const glows = !!t && (t.nightLights || t.water?.emissive !== undefined || t.biomes.some((b) => b.emissive !== undefined));
    if (!glows || w.atmosphereDepth <= GUIDE.glowDepth) return false;
    const ship = w.ship;
    const up = ship.pos.clone().normalize();
    if (ship.frame.rotating) up.applyQuaternion(body.rotation);
    const sun = w.universe.root.position.clone().sub(body.position).normalize();
    return up.dot(sun) < -0.15;
  }

  private show(id: TipId): void {
    this.text.replaceChildren();
    for (const seg of tipSegments(tipText(id, this.ctx.device()))) {
      if (seg.key) {
        const b = document.createElement('b');
        b.textContent = seg.text;
        this.text.appendChild(b);
      } else this.text.appendChild(document.createTextNode(seg.text));
    }
    this.el.dataset.tip = id;
    this.el.classList.add('on');
  }

  /** Test hook: the tip on screen. */
  get current(): TipId | null {
    return this.logic.current;
  }

  /** Test hook: shows a tip now, skipping triggers and spacing. */
  force(id: TipId): void {
    this.logic.seen.add(id);
    this.st.set('tipsSeen', [...this.logic.seen]);
    this.logic.current = id;
    this.logic.shownFor = 0;
    this.show(id);
  }
}
