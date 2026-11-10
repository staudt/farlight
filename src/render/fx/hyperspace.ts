import type { Input } from '../../input/input';
import type { GalaxyStar } from '../../data/galaxy';
import { buildTravelUrl } from '../../ui/galaxyMath';
import { noDashes } from '../../ui/format';
import type { GameRenderer } from '../renderer';
import './hyperspace.css';

const PENDING_KEY = 'farlight.pendingJump';
/** A pending jump older than this is forgotten. */
const PENDING_MAX_AGE_MS = 90_000;
const FOV_KICK = 20;

interface PendingJump {
  to: string;
  at: number;
}

export function savePendingJump(systemId: string): void {
  try {
    const v: PendingJump = { to: systemId, at: Date.now() };
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function clearPendingJump(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** The destination of a jump that was interrupted by a reload, if still fresh. */
export function readPendingJump(now = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingJump>;
    if (typeof v.to !== 'string' || typeof v.at !== 'number' || now - v.at > PENDING_MAX_AGE_MS) return null;
    return v.to;
  } catch {
    return null;
  }
}

/** White veil that fades out gently after arriving by hyperspace. Returns the release function. */
export function playArrival(): () => void {
  const veil = document.createElement('div');
  veil.id = 'arrive-veil';
  document.body.appendChild(veil);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    requestAnimationFrame(() => {
      veil.style.opacity = '0';
      setTimeout(() => veil.remove(), 3000);
    });
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Streak {
  a: number;
  r: number;
  speed: number;
  len: number;
  hue: number;
}

/**
 * The jump cinematic: radial star streaks, an FOV kick, engines at max, a blue tunnel tint,
 * the destination name and a white flash. Then `navigate` loads the new system.
 */
export class Hyperspace {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tint: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly name: HTMLElement;
  private readonly nameText: HTMLElement;
  private readonly streaks: Streak[] = [];
  private elapsed = 0;
  private duration = 0;
  private running = false;
  private navigated = false;
  private dest: GalaxyStar | null = null;
  /** Called when a jump starts, with its length in seconds (audio spool-up). */
  onStart: ((seconds: number) => void) | null = null;
  /** Replaceable for tests. */
  navigate: (url: string) => void = (url) => location.assign(url);

  constructor(
    private readonly gfx: GameRenderer,
    private readonly input: Input,
  ) {
    const root = document.createElement('div');
    root.id = 'hyper';
    root.innerHTML = `<canvas></canvas><div class="hy-tint"></div><div class="hy-name"><b></b><span>DESTINATION</span></div><div class="hy-flash"></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.tint = root.querySelector('.hy-tint') as HTMLElement;
    this.flash = root.querySelector('.hy-flash') as HTMLElement;
    this.name = root.querySelector('.hy-name') as HTMLElement;
    this.nameText = root.querySelector('.hy-name b') as HTMLElement;
    for (let i = 0; i < 170; i++) this.streaks.push(this.makeStreak(true));
  }

  get active(): boolean {
    return this.running;
  }

  private makeStreak(initial: boolean): Streak {
    return {
      a: Math.random() * Math.PI * 2,
      r: initial ? Math.random() : Math.random() * 0.1,
      speed: 0.5 + Math.random() * 1.6,
      len: 0.08 + Math.random() * 0.35,
      hue: Math.random(),
    };
  }

  start(dest: GalaxyStar, seconds: number): void {
    if (this.running) return;
    this.dest = dest;
    this.duration = seconds;
    this.elapsed = 0;
    this.running = true;
    this.navigated = false;
    this.nameText.textContent = noDashes(dest.name).toUpperCase();
    this.root.classList.add('on');
    document.getElementById('hud')?.classList.add('hidden');
    savePendingJump(dest.id);
    this.onStart?.(seconds);
    // Engines to the maximum for the duration.
    this.input.external.boost = true;
    this.input.external.throttleSet = 1;
    this.resize();
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  update(realDt: number): void {
    if (!this.running) return;
    this.elapsed += realDt;
    const p = Math.min(1, this.elapsed / this.duration);
    const ramp = smooth(0, 0.3, p);
    this.gfx.shipCamera.fovExtra = FOV_KICK * ramp;
    this.gfx.starfield.stretch = ramp;
    this.tint.style.opacity = (0.9 * ramp).toFixed(3);
    this.name.style.opacity = (smooth(0.15, 0.35, p) * (1 - smooth(0.78, 0.9, p))).toFixed(3);
    this.flash.style.opacity = smooth(0.8, 0.97, p).toFixed(3);
    this.drawStreaks(realDt, ramp);

    if (p >= 1 && !this.navigated && this.dest) {
      this.navigated = true;
      this.navigate(buildTravelUrl(location.search, this.dest.id, location.pathname));
    }
  }

  private drawStreaks(dt: number, ramp: number): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (ramp <= 0.001) return;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(cx, cy);
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.streaks) {
      s.r += dt * s.speed * (0.15 + 1.8 * ramp * ramp) * (0.3 + s.r);
      if (s.r > 1.05) Object.assign(s, this.makeStreak(false));
      const r0 = s.r * maxR;
      const r1 = r0 + s.len * ramp * maxR * (0.2 + s.r);
      const cos = Math.cos(s.a);
      const sin = Math.sin(s.a);
      const x0 = cx + cos * r0;
      const y0 = cy + sin * r0;
      const x1 = cx + cos * r1;
      const y1 = cy + sin * r1;
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      const col = s.hue < 0.5 ? '180,230,255' : s.hue < 0.8 ? '255,255,255' : '190,170,255';
      g.addColorStop(0, `rgba(${col},0)`);
      g.addColorStop(1, `rgba(${col},${(0.75 * ramp).toFixed(2)})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = (1 + 1.6 * s.r) * (w / window.innerWidth);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
