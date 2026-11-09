import type { GalaxyDef, GalaxyStar, PlayerProgress } from '../data/galaxy';
import { generateSystem, pickFocusBody } from '../data/generate';
import type { BodyDef, StarSystemDef } from '../data/types';
import { loadProgress, surveyProgress } from '../sim/survey';
import { escapeHtml, noDashes } from './format';
import {
  DEFAULT_TRAVEL_FACTOR,
  findRoute,
  formatLightYears,
  formatMinutes,
  jumpSeconds,
  routeLength,
  travelMinutes,
  TRAVEL_FACTORS,
} from './galaxyMath';
import { paintBackdrop, paintGalaxyTexture, makeGlowSprite, STAR_COLORS, STAR_SIZE, TEXTURE_MARGIN } from './galaxyPaint';
import { drawPlanetPreview } from './planetPreview';
import './galaxyMap.css';

const LINE = '#5ff2ff';
const CLASS_NAMES: Record<string, string> = { M: 'RED DWARF', K: 'ORANGE', G: 'YELLOW', F: 'PALE', A: 'WHITE', B: 'BLUE' };

interface P2 {
  x: number;
  y: number;
}

export interface SystemInfo {
  system: StarSystemDef;
  focus: BodyDef;
  /** Every body id except the star. */
  bodyIds: string[];
}

export interface GalaxyMapOptions {
  currentId: string;
  /** Called by BEGIN TRAVEL with the jump length in real seconds. */
  onTravel: (star: GalaxyStar, factor: number, seconds: number) => void;
}

/** Canvas view of the galaxy with a route planner. */
export class GalaxyMap {
  private open = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly card: HTMLElement;
  private readonly est: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly preview: HTMLCanvasElement;
  private readonly beginBtn: HTMLButtonElement;
  private readonly texture: HTMLCanvasElement;
  private readonly glows = new Map<string, HTMLCanvasElement>();
  private backdrop: HTMLCanvasElement | null = null;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private scale = 0.005;
  private fitScale = 0.005;
  private pan: P2 = { x: 0, y: 0 };
  private readonly pointers = new Map<number, P2>();
  private dragMoved = 0;
  private mouse: P2 = { x: -999, y: -999 };
  private hover: GalaxyStar | null = null;
  private readonly screen = new Map<string, P2>();
  private sel: GalaxyStar | null = null;
  private route: GalaxyStar[] = [];
  private factor: number = DEFAULT_TRAVEL_FACTOR;
  private progress: PlayerProgress = { visited: [], surveyed: [] };
  private readonly cache = new Map<string, SystemInfo>();
  private fitted = false;
  private readonly current: GalaxyStar;

  constructor(
    private readonly root: HTMLElement,
    private readonly galaxy: GalaxyDef,
    private readonly opts: GalaxyMapOptions,
  ) {
    this.current = galaxy.stars.find((s) => s.id === opts.currentId) ?? galaxy.stars[0]!;
    root.innerHTML = `
      <canvas></canvas>
      <div class="gm-hint">DRAG TO PAN · WHEEL TO ZOOM · CLICK A STAR</div>
      <div class="gm-hint touch">DRAG TO PAN · PINCH TO ZOOM · TAP A STAR</div>
      <button type="button" class="gm-home" aria-label="Centre on current system"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
      <div class="gm-side">
        <div class="gm-card">
          <div class="gm-name"></div>
          <div class="gm-sub"></div>
          <div class="gm-state"></div>
          <canvas class="gm-preview" width="276" height="132"></canvas>
          <div class="gm-focus"></div>
          <div class="gm-rows"></div>
          <div class="gm-survey"><div class="gm-survey-head"><span>SURVEY PROGRESS</span><b></b></div><div class="gm-bar"><i></i></div></div>
        </div>
        <div class="gm-est"></div>
      </div>
      <div class="gm-bar-row">
        <div class="gm-cell gm-route"><span class="k">ROUTE</span><b></b></div>
        <div class="gm-cell gm-len"><span class="k">LENGTH</span><b></b></div>
        <div class="gm-cell gm-accel">
          <span class="k">TIME ACCELERATION</span>
          <div class="gm-factors">${TRAVEL_FACTORS.map((f) => `<button type="button" data-f="${f}">×${f}</button>`).join('')}</div>
        </div>
        <div class="gm-cell gm-time"><span class="k">EST. TRAVEL TIME</span><b></b></div>
        <button type="button" class="gm-begin">BEGIN TRAVEL</button>
      </div>`;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.card = root.querySelector('.gm-card') as HTMLElement;
    this.est = root.querySelector('.gm-est') as HTMLElement;
    this.bar = root.querySelector('.gm-bar-row') as HTMLElement;
    this.preview = root.querySelector('.gm-preview') as HTMLCanvasElement;
    this.beginBtn = root.querySelector('.gm-begin') as HTMLButtonElement;
    this.texture = paintGalaxyTexture(galaxy);
    for (const [cls, color] of Object.entries(STAR_COLORS)) {
      const hex = color.slice(1);
      const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
      this.glows.set(cls, makeGlowSprite(rgb, 48));
    }

    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-f]')) {
      b.addEventListener('click', () => {
        this.factor = Number(b.dataset.f);
        this.refreshBar();
      });
    }
    this.beginBtn.addEventListener('click', () => this.begin());
    (root.querySelector('.gm-home') as HTMLElement).addEventListener('click', () => this.centerOn(this.current, 6));
    this.bindPointer();
    this.refreshBar();
  }

  // Public API

  get selected(): GalaxyStar | null {
    return this.sel;
  }

  get travelFactor(): number {
    return this.factor;
  }

  setActive(v: boolean): void {
    this.open = v;
    if (v) {
      this.progress = loadProgress();
      this.resize();
      this.hover = null;
      this.refreshCard();
      this.refreshBar();
    }
  }

  select(id: string | null): void {
    this.sel = id ? (this.galaxy.stars.find((s) => s.id === id) ?? null) : null;
    this.route = this.sel ? findRoute(this.galaxy.stars, this.current.id, this.sel.id) : [];
    this.progress = loadProgress();
    this.refreshCard();
    this.refreshBar();
  }

  setFactor(f: number): void {
    this.factor = f;
    this.refreshBar();
  }

  /** Smoothly irrelevant, but handy: bring a star to the middle of the free area. */
  centerOn(star: GalaxyStar, minZoom = 1): void {
    if (!this.w) this.resize();
    this.scale = Math.max(this.scale, this.fitScale * minZoom);
    const c = this.areaCenter();
    this.pan.x = c.x - this.w / 2 - star.x * this.scale;
    this.pan.y = c.y - this.h / 2 - star.y * this.scale;
  }

  /** Screen position of a star (CSS pixels), for tests. */
  starScreenPos(id: string): P2 | null {
    const s = this.galaxy.stars.find((st) => st.id === id);
    if (!s) return null;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + this.w / 2 + this.pan.x + s.x * this.scale, y: rect.top + this.h / 2 + this.pan.y + s.y * this.scale };
  }

  systemInfo(star: GalaxyStar): SystemInfo {
    let info = this.cache.get(star.id);
    if (!info) {
      const system = generateSystem(star);
      info = { system, focus: pickFocusBody(system), bodyIds: system.bodies.filter((b) => b.kind !== 'star').map((b) => b.id) };
      this.cache.set(star.id, info);
    }
    return info;
  }

  // Input

  private bindPointer(): void {
    const cv = this.canvas;
    this.root.addEventListener(
      'wheel',
      (e) => {
        e.stopPropagation(); // keep the throttle wheel handler out of it
        if (e.target !== cv) return;
        e.preventDefault();
        this.zoomAbout(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0012));
      },
      { passive: false },
    );
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.dragMoved = this.pointers.size === 1 ? 0 : 1e3; // a pinch is never a tap
      this.root.classList.add('dragging');
    });
    const up = (e: PointerEvent): void => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pointers.size > 0) return;
      this.root.classList.remove('dragging');
      const touch = e.pointerType !== 'mouse';
      if (e.type === 'pointerup' && this.dragMoved < (touch ? 10 : 5) && this.open) {
        const rect = cv.getBoundingClientRect();
        const hit = this.nearest(e.clientX - rect.left, e.clientY - rect.top, touch ? 34 : 20);
        if (hit) this.select(hit.id);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.mouse = { x: e.clientX, y: e.clientY };
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const nx = e.clientX;
      const ny = e.clientY;
      if (this.pointers.size >= 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(nx - other.x, ny - other.y);
        this.pan.x += (nx + other.x) / 2 - (prev.x + other.x) / 2;
        this.pan.y += (ny + other.y) / 2 - (prev.y + other.y) / 2;
        if (d0 > 1) this.zoomAbout((nx + other.x) / 2, (ny + other.y) / 2, d1 / d0);
      } else {
        this.pan.x += nx - prev.x;
        this.pan.y += ny - prev.y;
        this.dragMoved += Math.abs(nx - prev.x) + Math.abs(ny - prev.y);
      }
      prev.x = nx;
      prev.y = ny;
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private zoomAbout(cx0: number, cy0: number, f: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const nz = Math.min(this.fitScale * 80, Math.max(this.fitScale * 0.8, this.scale * f));
    const k = nz / this.scale;
    const cx = cx0 - rect.left - this.w / 2;
    const cy = cy0 - rect.top - this.h / 2;
    this.pan.x = cx - (cx - this.pan.x) * k;
    this.pan.y = cy - (cy - this.pan.y) * k;
    this.scale = nz;
  }

  private nearest(x: number, y: number, radius: number): GalaxyStar | null {
    let best: GalaxyStar | null = null;
    let bestD = radius;
    for (const s of this.galaxy.stars) {
      const p = this.screen.get(s.id);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // Layout

  /** Middle of the part of the canvas not covered by the side column and bottom bar. */
  private areaCenter(): P2 {
    const phone = this.h < 500;
    const rightW = this.w < 700 ? 0 : phone ? 232 : 340;
    const top = phone ? 44 : 56;
    const bottom = phone ? 70 : 110;
    return { x: (this.w - rightW) / 2, y: top + (this.h - top - bottom) / 2 };
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    const sizeChanged = w !== this.w || h !== this.h;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    if (sizeChanged || !this.backdrop) this.backdrop = paintBackdrop(this.canvas.width, this.canvas.height);
    const c = this.areaCenter();
    const span = Math.max(100, Math.min(c.x * 2, (c.y - (h < 500 ? 44 : 56)) * 2)) * 1.15;
    this.fitScale = span / (2 * this.galaxy.radius * 1.05);
    if (!this.fitted) {
      this.fitted = true;
      this.scale = this.fitScale;
      this.pan.x = c.x - w / 2;
      this.pan.y = c.y - h / 2;
    }
  }

  private toScreen(x: number, y: number, out: P2): P2 {
    out.x = this.w / 2 + this.pan.x + x * this.scale;
    out.y = this.h / 2 + this.pan.y + y * this.scale;
    return out;
  }

  // Cards

  private row(k: string, v: string): string {
    return `<div class="gm-row"><span class="k">${k}</span><span class="v">${escapeHtml(noDashes(v))}</span></div>`;
  }

  private refreshCard(): void {
    const sel = this.sel;
    this.card.classList.toggle('on', !!sel);
    this.est.classList.toggle('on', !!sel && sel.id !== this.current.id);
    if (!sel) return;
    const info = this.systemInfo(sel);
    const visited = this.progress.visited.includes(sel.id) || sel.id === this.current.id;
    const prog = visited ? surveyProgress(this.progress, sel.id, info.bodyIds) : { done: 0, total: info.bodyIds.length, fraction: 0 };
    const q = (s: string): HTMLElement => this.card.querySelector(s) as HTMLElement;
    q('.gm-name').textContent = noDashes(sel.name).toUpperCase();
    q('.gm-sub').textContent = `${CLASS_NAMES[sel.starClass] ?? ''} · CLASS ${sel.starClass} · ${sel.planetCount} PLANETS`;
    q('.gm-state').textContent = visited ? '✓ VISITED' : 'UNEXPLORED';
    q('.gm-state').classList.toggle('ok', visited);
    q('.gm-focus').textContent = noDashes(info.focus.name).toUpperCase();
    q('.gm-rows').innerHTML =
      this.row('TYPE', info.focus.info.type) + this.row('ATMOSPHERE', info.focus.info.atmosphere) + this.row('GRAVITY', `${info.focus.physical.surfaceGravity.toFixed(2)} g`);
    const pct = Math.round(prog.fraction * 100);
    q('.gm-survey b').textContent = `${pct}%`;
    (q('.gm-bar i') as HTMLElement).style.width = `${pct}%`;
    drawPlanetPreview(this.preview, info.focus);
    this.refreshEstimate();
  }

  private refreshEstimate(): void {
    const ly = routeLength(this.route);
    this.est.innerHTML =
      `<div class="gm-est-head">TRAVEL ESTIMATE</div>` +
      this.row('ROUTE LENGTH', formatLightYears(ly)) +
      this.row('EST. TRAVEL TIME', formatMinutes(travelMinutes(ly, 1)));
  }

  private refreshBar(): void {
    const sel = this.sel;
    const canGo = !!sel && sel.id !== this.current.id;
    const ly = routeLength(this.route);
    const q = (s: string): HTMLElement => this.bar.querySelector(s) as HTMLElement;
    q('.gm-route b').textContent = canGo ? `${noDashes(this.current.name).toUpperCase()} → ${noDashes(sel.name).toUpperCase()}` : 'SELECT A STAR';
    q('.gm-len b').textContent = canGo ? formatLightYears(ly) : '·';
    q('.gm-time b').textContent = canGo ? formatMinutes(travelMinutes(ly, this.factor)) : '·';
    for (const b of this.bar.querySelectorAll<HTMLElement>('[data-f]')) b.classList.toggle('on', Number(b.dataset.f) === this.factor);
    this.beginBtn.disabled = !canGo;
    if (canGo) this.refreshEstimate();
  }

  private begin(): void {
    const sel = this.sel;
    if (!sel || sel.id === this.current.id) return;
    const seconds = jumpSeconds(routeLength(this.route), this.factor);
    this.opts.onTravel(sel, this.factor, seconds);
  }

  // Frame

  update(): void {
    if (!this.open) return;
    if (this.canvas.width !== Math.round(this.root.clientWidth * this.dpr) || this.canvas.height !== Math.round(this.root.clientHeight * this.dpr)) this.resize();
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = 'middle';

    // Galaxy texture.
    const E = this.galaxy.radius * TEXTURE_MARGIN;
    const tl = this.toScreen(-E, -E, { x: 0, y: 0 });
    ctx.drawImage(this.texture, tl.x, tl.y, 2 * E * this.scale, 2 * E * this.scale);

    // Screen positions.
    this.screen.clear();
    const rect = this.canvas.getBoundingClientRect();
    for (const s of this.galaxy.stars) this.screen.set(s.id, this.toScreen(s.x, s.y, { x: 0, y: 0 }));
    this.hover = this.nearest(this.mouse.x - rect.left, this.mouse.y - rect.top, 16);
    const zoomRel = this.scale / this.fitScale;
    const zk = 0.9 + 0.22 * Math.log2(Math.max(1, zoomRel));

    this.drawRoute(t);

    ctx.font = '600 11px Rajdhani, sans-serif';
    ctx.letterSpacing = '2.5px';
    const visited = new Set(this.progress.visited);
    visited.add(this.current.id);
    for (const s of this.galaxy.stars) {
      const p = this.screen.get(s.id)!;
      if (p.x < -40 || p.y < -40 || p.x > this.w + 40 || p.y > this.h + 40) continue;
      const r = STAR_SIZE[s.starClass] * zk;
      const glow = this.glows.get(s.starClass)!;
      const gr = r * 6;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(glow, p.x - gr, p.y - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = STAR_COLORS[s.starClass];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Orbit ring halo.
      ctx.strokeStyle = 'rgba(160,200,255,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      const seen = visited.has(s.id);
      if (seen) {
        ctx.strokeStyle = 'rgba(95,242,255,0.85)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
        ctx.stroke();
        this.drawCheck(p.x + r + 9, p.y - r - 9, 4);
      }
      const hot = s === this.hover || s === this.sel;
      if (hot) this.drawBrackets(p.x, p.y, r + 13);
      const showName = hot || s === this.current || (seen && zoomRel > 1.5) || zoomRel > 7;
      if (showName && s !== this.current) {
        ctx.fillStyle = hot ? '#ffffff' : 'rgba(217,251,255,0.7)';
        ctx.textAlign = 'left';
        ctx.fillText(noDashes(s.name).toUpperCase(), p.x + r + 14, p.y + r + 10);
      }
    }

    this.drawCurrentLabel(t, zk);
    this.drawShip();
  }

  private drawCheck(x: number, y: number, s: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x - s * 0.3, y + s * 0.8);
    ctx.lineTo(x + s, y - s * 0.7);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  private drawBrackets(x: number, y: number, s: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ctx.moveTo(x + sx * s, y + sy * (s - 6));
      ctx.lineTo(x + sx * s, y + sy * s);
      ctx.lineTo(x + sx * (s - 6), y + sy * s);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  private drawCurrentLabel(t: number, zk: number): void {
    const ctx = this.ctx;
    const p = this.screen.get(this.current.id);
    if (!p) return;
    const r = STAR_SIZE[this.current.starClass] * zk;
    const pulse = (t % 2.4) / 2.4;
    ctx.strokeStyle = `rgba(95,242,255,${(0.6 * (1 - pulse)).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 8 + pulse * 16, 0, Math.PI * 2);
    ctx.stroke();
    const text = noDashes(this.current.name).toUpperCase();
    ctx.font = '600 12px Rajdhani, sans-serif';
    ctx.letterSpacing = '3px';
    const tw = ctx.measureText(text).width;
    const bw = tw + 38;
    const bx = p.x - bw / 2;
    const by = p.y - r - 44;
    ctx.fillStyle = 'rgba(6,14,28,0.7)';
    ctx.strokeStyle = 'rgba(95,242,255,0.7)';
    ctx.beginPath();
    ctx.rect(bx, by, bw, 22);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, by + 22);
    ctx.lineTo(p.x, p.y - r - 12);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + 10, by + 11.5);
    this.drawCheck(bx + bw - 13, by + 11, 4);
  }

  private routeScreen(): P2[] {
    return this.route.map((s) => this.screen.get(s.id)!).filter(Boolean);
  }

  private drawRoute(t: number): void {
    const pts = this.routeScreen();
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = LINE;
    ctx.shadowColor = LINE;
    ctx.shadowBlur = 8;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -t * 18;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!;
      ctx.fillStyle = '#04101e';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawShip(): void {
    const pts = this.routeScreen();
    const cur = this.screen.get(this.current.id);
    if (!cur) return;
    let ang = -0.6;
    let x = cur.x;
    let y = cur.y;
    if (pts.length >= 2) {
      const n = pts[1]!;
      const d = Math.hypot(n.x - cur.x, n.y - cur.y) || 1;
      ang = Math.atan2(n.y - cur.y, n.x - cur.x);
      const off = Math.min(d * 0.5, 26);
      x = cur.x + ((n.x - cur.x) / d) * off;
      y = cur.y + ((n.y - cur.y) / d) * off;
    } else {
      x += 20;
      y += 14;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.strokeStyle = LINE;
    ctx.fillStyle = 'rgba(95,242,255,0.55)';
    ctx.shadowColor = LINE;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, 6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
