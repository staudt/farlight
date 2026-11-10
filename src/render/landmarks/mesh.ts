import { BufferGeometry, Float32BufferAttribute, IcosahedronGeometry } from 'three';

export type V3 = [number, number, number];

/** Surface shading modes (aFx). */
export enum Mode {
  Solid = 0,
  Fall = 1,
  Steam = 2,
  Water = 3,
  Glow = 4,
}

export function hash01(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** One draw call worth of triangles: position, color, glow weight, mode, uv. */
export class Channel {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly emit: number[] = [];
  readonly mode: number[] = [];
  readonly uv: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  tri(a: V3, b: V3, c: V3, color: V3, emit = 0, shade = 1, mode = Mode.Solid, ua: [number, number] = [0, 0], ub: [number, number] = [0, 0], uc: [number, number] = [0, 0]): void {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(color[0] * shade, color[1] * shade, color[2] * shade);
    for (let i = 0; i < 3; i++) {
      this.emit.push(emit);
      this.mode.push(mode);
    }
    this.uv.push(...ua, ...ub, ...uc);
  }

  /** Quad a b c d in order around its edge. */
  quad(a: V3, b: V3, c: V3, d: V3, color: V3, emit = 0, shade = 1, mode = Mode.Solid, ua: [number, number] = [0, 0], ub: [number, number] = [1, 0], uc: [number, number] = [1, 1], ud: [number, number] = [0, 1]): void {
    this.tri(a, b, c, color, emit, shade, mode, ua, ub, uc);
    this.tri(a, c, d, color, emit, shade, mode, ua, uc, ud);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aEmit', new Float32BufferAttribute(this.emit, 1));
    g.setAttribute('aFx', new Float32BufferAttribute(this.mode, 1));
    g.setAttribute('aUv', new Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

export interface RingOpts {
  seg?: number;
  rot?: number;
  jitter?: number;
  seed?: number;
}

/** Points of an (optionally elliptical, jittered) ring at height y. */
export function ring(y: number, cx: number, cz: number, rx: number, rz: number, o: RingOpts = {}): V3[] {
  const seg = o.seg ?? 7;
  const rot = o.rot ?? 0;
  const out: V3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = rot + (i / seg) * Math.PI * 2;
    const j = 1 + ((hash01(o.seed ?? 0, i, Math.round(y * 10)) - 0.5) * (o.jitter ?? 0));
    out.push([cx + Math.cos(a) * rx * j, y, cz + Math.sin(a) * rz * j]);
  }
  return out;
}

/** Side faces between two rings of equal length, plus an optional fan cap on top. */
export function band(c: Channel, lo: V3[], hi: V3[], color: V3, emit = 0, shade = 1, mode = Mode.Solid): void {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const s = shade * (0.9 + 0.2 * hash01(i, n, Math.round(lo[0]![1] * 7)));
    c.tri(lo[i]!, hi[j]!, hi[i]!, color, emit, s, mode);
    c.tri(lo[i]!, lo[j]!, hi[j]!, color, emit, s, mode);
  }
}

export function fan(c: Channel, rg: V3[], apex: V3, color: V3, emit = 0, shade = 1, mode = Mode.Solid): void {
  const n = rg.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    c.tri(rg[i]!, apex, rg[j]!, color, emit, shade * (0.92 + 0.16 * hash01(i, n, 3)), mode);
  }
}

export interface Frustum {
  cx: number;
  cz: number;
  y0: number;
  y1: number;
  rx0: number;
  rz0: number;
  /** Top radius, 0 for a point. */
  rx1: number;
  rz1: number;
  /** Top centre offset (lean). */
  lx?: number;
  lz?: number;
  seg?: number;
  rot?: number;
  jitter?: number;
  seed?: number;
  /** Mid kink: extra ring at this fraction with this radius scale (cut crystals, broken stones). */
  emitTip?: number;
}

/** A tapered prism with a flat top (or a point when the top radius is 0). */
export function frustum(c: Channel, f: Frustum, color: V3, emit = 0, shade = 1, mode = Mode.Solid): void {
  const o = { seg: f.seg ?? 6, rot: f.rot ?? 0, jitter: f.jitter ?? 0, seed: f.seed ?? 0 };
  const lo = ring(f.y0, f.cx, f.cz, f.rx0, f.rz0, o);
  const tcx = f.cx + (f.lx ?? 0);
  const tcz = f.cz + (f.lz ?? 0);
  if (f.rx1 <= 1e-6 && f.rz1 <= 1e-6) {
    const apex: V3 = [tcx, f.y1, tcz];
    const n = lo.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      c.tri(lo[i]!, apex, lo[j]!, color, emit, shade * (0.85 + 0.3 * hash01(i, n, o.seed)), mode);
    }
    return;
  }
  const hi = ring(f.y1, tcx, tcz, f.rx1, f.rz1, { ...o, seed: o.seed + 11 });
  band(c, lo, hi, color, emit, shade, mode);
  fan(c, hi, [tcx, f.y1, tcz], color, emit, shade * 1.1, mode);
}

/** An axis aligned (then rotated about Y) box standing on y0. */
export function box(c: Channel, cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, rot: number, color: V3, emit = 0, shade = 1, taper = 1): void {
  frustum(c, { cx, cz, y0, y1, rx0: hx * Math.SQRT2, rz0: hz * Math.SQRT2, rx1: hx * Math.SQRT2 * taper, rz1: hz * Math.SQRT2 * taper, seg: 4, rot: rot + Math.PI / 4 }, color, emit, shade);
}

/** Lumpy squashed icosphere. `bands` tints by height (dark at the foot to bright at the top). */
export function blob(c: Channel, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seed: number, color: V3, o: { emit?: number; jitter?: number; detail?: number; shade?: number; bands?: number; mode?: Mode } = {}): void {
  const g = new IcosahedronGeometry(1, o.detail ?? 1).toNonIndexed();
  const p = g.getAttribute('position');
  const v: V3[] = [];
  const jit = o.jitter ?? 0.3;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + (hash01(Math.round(x * 100) + seed, Math.round(y * 100), Math.round(z * 100)) - 0.5) * jit;
    v.push([cx + x * rx * k, cy + y * ry * k, cz + z * rz * k]);
  }
  const bands = o.bands ?? 0;
  for (let i = 0; i < v.length; i += 3) {
    const a = v[i]!;
    const b = v[i + 1]!;
    const d = v[i + 2]!;
    const t = ((a[1] + b[1] + d[1]) / 3 - cy) / Math.max(1e-6, ry);
    let s = (o.shade ?? 1) * (0.8 + 0.3 * Math.min(1, Math.max(0, (t + 1) / 2)));
    if (bands > 0) s *= 0.88 + 0.24 * hash01(Math.floor(((t + 1) / 2) * bands), seed, 7);
    c.tri(a, b, d, color, o.emit ?? 0, s, o.mode ?? Mode.Solid, [hash01(seed, i), t * 0.5 + 0.5], [0, t * 0.5 + 0.5], [0, t * 0.5 + 0.5]);
  }
  g.dispose();
}

/** A pointed crystal or ice needle, optionally leaning. */
export function needle(c: Channel, x: number, z: number, y0: number, height: number, radius: number, lx: number, lz: number, seed: number, color: V3, emit = 0, seg = 6): void {
  const rot = hash01(seed, 1) * 3;
  const midY = y0 + height * 0.72;
  const lo = ring(y0, x, z, radius, radius, { seg, rot, jitter: 0.25, seed });
  const mid = ring(midY, x + lx * 0.7, z + lz * 0.7, radius * 0.78, radius * 0.78, { seg, rot: rot + 0.2, jitter: 0.15, seed: seed + 3 });
  band(c, lo, mid, color, emit * 0.7, 0.85);
  const tip: V3 = [x + lx, y0 + height, z + lz];
  for (let k = 0; k < seg; k++) c.tri(mid[k]!, tip, mid[(k + 1) % seg]!, color, emit, 0.95 + 0.25 * hash01(seed, k, 5));
}
