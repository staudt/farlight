import { Vector3 } from 'three';
import { config } from '../core/config';
import type { Input } from '../input/input';
import type { Body } from '../sim/universe';
import type { World } from '../sim/world';
import { escapeHtml, formatDistance, formatDuration, noDashes, rgbCss } from './format';
import './map.css';

const WARPS = [1, 10, 100, 1000, 10000];
const LINE = '#5ff2ff';

interface P2 {
  x: number;
  y: number;
}

const _rel = new Vector3();
const _fwd = new Vector3();

/**
 * Top down schematic of the system, log scaled so planets and moons fit one screen.
 * Seed of the future galaxy map: layout is computed from the body tree only.
 */
export class SystemMap {
  private open = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly card: HTMLElement;
  private zoom = 1;
  private pan: P2 = { x: 0, y: 0 };
  private hover: Body | null = null;
  private mouse: P2 = { x: -999, y: -999 };
  private dragging = false;
  private dragMoved = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private screen = new Map<Body, P2>();
  private cardBody: Body | null = null;
  private cardTimer = 0;
  private readonly planets: Body[];
  private readonly d0: number;
  private readonly dMax: number;
  private readonly m0: number;
  private readonly mMax: number;

  constructor(
    private readonly root: HTMLElement,
    private readonly world: World,
    input: Input,
  ) {
    root.innerHTML = `
      <canvas></canvas>
      <div class="map-title">SYSTEM MAP</div>
      <div class="map-sub">DRAG TO PAN · WHEEL TO ZOOM · CLICK TO TARGET · M TO CLOSE</div>
      <div class="map-card"></div>`;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.card = root.querySelector('.map-card') as HTMLElement;

    const uni = world.universe;
    this.planets = uni.root.children;
    const pd = this.planets.map((b) => hypot2(b.localPosition));
    // Use semi major axes so layout does not wobble with eccentric orbits.
    const pa = this.planets.map((b, i) => b.orbit?.a ?? pd[i] ?? 1);
    this.d0 = Math.max(1, Math.min(...pa) * 0.5);
    this.dMax = Math.max(...pa, this.d0 * 2);
    const moons = uni.bodies.filter((b) => b.parent && b.parent !== uni.root);
    const ma = moons.map((b) => b.orbit?.a ?? 1);
    this.m0 = moons.length ? Math.max(1, Math.min(...ma) * 0.5) : 1;
    this.mMax = moons.length ? Math.max(...ma, this.m0 * 2) : 2;

    input.on('map', () => this.toggle());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.open) this.setOpen(false);
    });

    root.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation(); // keep the throttle wheel handler out of it
        const f = Math.exp(-e.deltaY * 0.0012);
        const nz = Math.min(40, Math.max(0.3, this.zoom * f));
        const k = nz / this.zoom;
        // Zoom about the cursor.
        const cx = e.clientX - this.w / 2;
        const cy = e.clientY - this.h / 2;
        this.pan.x = cx - (cx - this.pan.x) * k;
        this.pan.y = cy - (cy - this.pan.y) * k;
        this.zoom = nz;
      },
      { passive: false },
    );
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragMoved = 0;
      root.classList.add('dragging');
    });
    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      root.classList.remove('dragging');
      if (this.dragMoved < 5 && this.open && this.hover) {
        this.world.target = this.hover;
      }
    });
    root.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.dragging) {
        this.pan.x += e.movementX;
        this.pan.y += e.movementY;
        this.dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
      }
    });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(v: boolean): void {
    this.open = v;
    this.root.style.display = v ? 'block' : 'none';
    if (v) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.resize();
      this.hover = null;
    }
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.root.clientWidth || window.innerWidth;
    this.h = this.root.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  // Layout

  private planetRadius(d: number): number {
    const base = 0.42 * Math.min(this.w, this.h);
    return (base / Math.log(1 + this.dMax / this.d0)) * Math.log(1 + d / this.d0);
  }

  private moonRadius(d: number): number {
    return 10 + (34 / Math.log(1 + this.mMax / this.m0)) * Math.log(1 + d / this.m0);
  }

  /** Map units (zoom 1, centered on the star) for a body. */
  private layout(b: Body, out: P2): P2 {
    const parent = b.parent;
    if (!parent) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    const lp = b.localPosition;
    const d = Math.hypot(lp.x, lp.z);
    const ang = Math.atan2(lp.z, lp.x);
    if (!parent.parent) {
      const r = this.planetRadius(d);
      out.x = Math.cos(ang) * r;
      out.y = Math.sin(ang) * r;
      return out;
    }
    const pp = this.layout(parent, { x: 0, y: 0 });
    const r = this.moonRadius(d);
    out.x = pp.x + Math.cos(ang) * r;
    out.y = pp.y + Math.sin(ang) * r;
    return out;
  }

  private toScreen(p: P2, out: P2): P2 {
    out.x = this.w / 2 + this.pan.x + p.x * this.zoom;
    out.y = this.h / 2 + this.pan.y + p.y * this.zoom;
    return out;
  }

  private shipMapPos(): P2 {
    const w = this.world;
    const fb = w.ship.frame.body;
    _rel.copy(w.shipWorldPos).sub(fb.position);
    const d = Math.hypot(_rel.x, _rel.z);
    const ang = Math.atan2(_rel.z, _rel.x);
    const c = this.layout(fb, { x: 0, y: 0 });
    const r = fb.parent ? this.moonRadius(d) * 0.6 : this.planetRadius(d);
    return { x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r };
  }

  // Frame

  update(): void {
    if (!this.open) return;
    if (this.canvas.width !== Math.round(this.root.clientWidth * this.dpr)) this.resize();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';

    const uni = this.world.universe;
    this.screen.clear();
    const tmp = { x: 0, y: 0 };
    for (const b of uni.bodies) {
      this.screen.set(b, this.toScreen(this.layout(b, tmp), { x: 0, y: 0 }));
    }

    // Orbits
    ctx.strokeStyle = 'rgba(95,242,255,0.2)';
    for (const b of uni.bodies) {
      if (!b.parent) continue;
      const pc = this.screen.get(b.parent);
      const me = this.screen.get(b);
      if (!pc || !me) continue;
      const r = Math.hypot(me.x - pc.x, me.y - pc.y);
      ctx.beginPath();
      ctx.arc(pc.x, pc.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Hover
    let best: Body | null = null;
    let bestD = 16;
    for (const [b, p] of this.screen) {
      const d = Math.hypot(p.x - this.mouse.x, p.y - this.mouse.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    this.hover = best;

    // Bodies
    ctx.font = '600 12px Rajdhani, sans-serif';
    ctx.letterSpacing = '3px';
    const target = this.world.target;
    for (const b of uni.bodies) {
      const p = this.screen.get(b);
      if (!p) continue;
      const col = rgbCss(b.def.visual.color, 0.15);
      const isStar = b.kind === 'star';
      const r = isStar ? 7 : b.parent === uni.root ? (b.kind === 'gas' ? 5 : 4) : 2.6;
      if (isStar) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34);
        g.addColorStop(0, 'rgba(255,230,170,0.55)');
        g.addColorStop(1, 'rgba(255,230,170,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - 34, p.y - 34, 68, 68);
      }
      ctx.fillStyle = isStar ? '#fff4d0' : col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (b.def.rings) {
        ctx.strokeStyle = 'rgba(230,220,190,0.45)';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 2.1, r * 0.8, -0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      const hot = b === this.hover || b === target;
      if (hot) {
        ctx.strokeStyle = LINE;
        const s = r + 7;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          ctx.moveTo(p.x + sx * s, p.y + sy * (s - 5));
          ctx.lineTo(p.x + sx * s, p.y + sy * s);
          ctx.lineTo(p.x + sx * (s - 5), p.y + sy * s);
        }
        ctx.stroke();
      }
      const showLabel = b.parent === uni.root || b === uni.root || hot || b.parent !== null;
      if (showLabel) {
        ctx.fillStyle = hot ? '#ffffff' : 'rgba(217,251,255,0.8)';
        ctx.fillText(noDashes(b.name).toUpperCase(), p.x + r + 10, p.y);
      }
    }

    this.drawShip();
    this.updateCard();
  }

  private drawShip(): void {
    const ctx = this.ctx;
    const sp = this.toScreen(this.shipMapPos(), { x: 0, y: 0 });
    this.world.ship.forward(_fwd);
    // Frame to world direction, rotating frames spin with the body.
    const f = this.world.ship.frame;
    if (f.rotating) _fwd.applyQuaternion(f.body.rotation);
    const ang = Math.atan2(_fwd.z, _fwd.x);
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(ang);
    ctx.strokeStyle = LINE;
    ctx.fillStyle = 'rgba(95,242,255,0.35)';
    ctx.shadowColor = LINE;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, 5);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private updateCard(): void {
    const body = this.hover ?? this.world.target;
    this.card.classList.toggle('on', !!body);
    if (!body) return;
    const now = performance.now();
    if (body === this.cardBody && now - this.cardTimer < 100) return;
    this.cardBody = body;
    this.cardTimer = now;

    const w = this.world;
    const info = body.def.info;
    const dist = Math.max(0, body.position.distanceTo(w.shipWorldPos) - body.radius);
    const speed = Math.max(config.flight.maxSpeedCap, w.ship.speed);
    const rows: [string, string][] = [
      ['TYPE', info.type],
      ['ATMOSPHERE', info.atmosphere],
      ['GRAVITY', `${body.def.physical.surfaceGravity.toFixed(2)} g`],
      ['TEMP', info.temperature],
      ['FEATURES', info.features.join(', ')],
      ['DISTANCE', formatDistance(dist)],
    ];
    const row = (k: string, v: string, cls = ''): string =>
      `<div class="card-row ${cls}"><span class="k">${k}</span><span class="v">${escapeHtml(noDashes(v))}</span></div>`;
    this.card.innerHTML =
      `<div class="card-name"><span class="glyph"></span><span>${escapeHtml(noDashes(body.name))}</span></div>` +
      rows.map(([k, v]) => row(k, v)).join('') +
      `<div class="eta-head">TRAVEL ESTIMATE</div>` +
      WARPS.map((x) => row(`×${x}`, formatDuration(dist / speed / x), 'eta-row')).join('');
  }
}

function hypot2(v: { x: number; z: number }): number {
  return Math.hypot(v.x, v.z);
}
