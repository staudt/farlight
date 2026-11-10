import type { BufferGeometry } from 'three';
import { LANDMARK_COLOR } from '../../data/landmarks';
import type { LandmarkDef, LandmarkKind, RGB } from '../../data/types';
import { Channel, Mode, type V3, blob, box, frustum, hash01, needle } from './mesh';

/** Terrain height at tangent offset (x east, z south) in meters, relative to the landmark centre. */
export type Ground = (x: number, z: number) => number;

export interface BuildInput {
  lm: LandmarkDef;
  /** Footprint radius, game meters. */
  r: number;
  /** Vertical size, game meters. */
  h: number;
  ground: Ground;
}

export interface Built {
  solid: BufferGeometry | null;
  fx: BufferGeometry | null;
}

const tint = (c: RGB, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a: RGB, b: RGB, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const TAU = Math.PI * 2;
/** Stones and posts start this far below the sampled ground so slopes never show gaps. */
const BURY = 6;

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Builder = (s: Channel, f: Channel, i: BuildInput, color: RGB, seed: number) => void;

// ---------------------------------------------------------------------------------------------

/** Pointed arch: two legs and a lumpy elliptical span. */
const arch: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const t = r * 0.3; // span thickness
  const depth = r * 0.55;
  const gl = ground(-r, 0);
  const gr = ground(r, 0);
  const base = Math.max(gl, gr);
  const N = 12;
  const pts: { o: V3; i: V3 }[] = [];
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI;
    const jo = 1 + (hash01(seed, k, 1) - 0.5) * 0.14;
    const ji = 1 + (hash01(seed, k, 2) - 0.5) * 0.14;
    pts.push({
      o: [Math.cos(th) * (r + t * 0.5) * jo, base + Math.sin(th) * h * jo, 0],
      i: [Math.cos(th) * (r - t * 0.5) * ji, base + Math.sin(th) * (h - t) * ji, 0],
    });
  }
  const d = (k: number): number => depth * (0.8 + 0.4 * hash01(seed, k, 3));
  for (let k = 0; k < N; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const da = d(k);
    const db = d(k + 1);
    const sh = 0.85 + 0.3 * hash01(seed, k, 4);
    const col = tint(color, sh);
    // Outer, inner, front, back faces.
    s.quad([a.o[0], a.o[1], -da], [b.o[0], b.o[1], -db], [b.o[0], b.o[1], db], [a.o[0], a.o[1], da], col, 0, 1.08);
    s.quad([a.i[0], a.i[1], da], [b.i[0], b.i[1], db], [b.i[0], b.i[1], -db], [a.i[0], a.i[1], -da], col, 0, 0.7);
    s.quad([a.i[0], a.i[1], da], [a.o[0], a.o[1], da], [b.o[0], b.o[1], db], [b.i[0], b.i[1], db], col, 0, 1);
    s.quad([a.o[0], a.o[1], -da], [a.i[0], a.i[1], -da], [b.i[0], b.i[1], -db], [b.o[0], b.o[1], -db], col, 0, 0.9);
  }
  // Legs reach down to the ground under each foot.
  for (const side of [-1, 1]) {
    const g = side < 0 ? gl : gr;
    const x0 = side * r;
    const w = t * 0.62;
    frustum(s, { cx: x0, cz: 0, y0: g - BURY, y1: base + 4, rx0: w * 1.35, rz0: depth * 1.05, rx1: w, rz1: depth * 0.9, seg: 6, rot: seed % 5, jitter: 0.22, seed: seed + side }, tint(color, 0.95), 0, 1);
    blob(s, x0 + side * w * 0.9, g + t * 0.18, depth * 0.3, t * 0.55, t * 0.38, t * 0.5, seed + 5 * side, tint(color, 0.85), { jitter: 0.5 });
  }
};

/** Tall dark slab with faint glowing seams. */
const monolith: Builder = (s, _f, { r, h, ground }, color) => {
  const g = Math.min(ground(-r, -r * 0.5), ground(r, r * 0.5), ground(0, 0));
  const hx = r;
  const hz = r * 0.42;
  box(s, 0, 0, g - BURY, h, hx, hz, 0, tint(color, 1), 0, 1, 0.995);
  // Faint seams: thin bright strips set a hair outside the faces.
  const glow: V3 = [0.25, 0.75, 1.0];
  const e = 0.12;
  for (const side of [-1, 1]) {
    const z = side * (hz + e);
    s.quad([-hx * 0.08, h * 0.12, z], [hx * 0.08, h * 0.12, z], [hx * 0.08, h * 0.94, z], [-hx * 0.08, h * 0.94, z], glow, 3.0, 1);
    s.quad([-hx * 0.9, h * 0.97, z], [hx * 0.9, h * 0.97, z], [hx * 0.9, h * 0.992, z], [-hx * 0.9, h * 0.992, z], glow, 4.0, 1);
  }
  // Corner seams and a ring of light on the ground.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      s.quad([sx * hx, h * 0.04, sz * (hz + e)], [sx * (hx - 0.5), h * 0.04, sz * (hz + e)], [sx * (hx - 0.5), h * 0.97, sz * (hz + e)], [sx * hx, h * 0.97, sz * (hz + e)], glow, 2.2, 1);
    }
  }
  const ringIn = r * 1.9;
  const ringOut = r * 2.3;
  for (let i = 0; i < 28; i++) {
    const a0 = (i / 28) * TAU;
    const a1 = ((i + 1) / 28) * TAU;
    const p = (rad: number, a: number): V3 => [Math.cos(a) * rad, ground(Math.cos(a) * rad, Math.sin(a) * rad) + 0.7, Math.sin(a) * rad];
    s.quad(p(ringIn, a0), p(ringOut, a0), p(ringOut, a1), p(ringIn, a1), glow, 1.1, 1);
  }
  // Small stones at the foot.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.5;
    blob(s, Math.cos(a) * r * 2.2, ground(Math.cos(a) * r * 2.2, Math.sin(a) * r * 2.2) + 0.6, Math.sin(a) * r * 2.2, r * 0.45, r * 0.3, r * 0.4, i + 9, [0.12, 0.11, 0.1], { jitter: 0.5 });
  }
};

/** Crystal clusters strewn along the floor of the stamped canyon. */
const crystalCanyon: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const x = ((i / steps) * 2 - 1) * r * 0.95;
    // The canyon wanders: find the floor across it.
    let bestZ = 0;
    let bestY = Infinity;
    for (let k = -14; k <= 14; k++) {
      const z = k * r * 0.025;
      const y = ground(x, z);
      if (y < bestY) {
        bestY = y;
        bestZ = z;
      }
    }
    const n = 1 + Math.floor(hash01(seed, i, 1) * 3);
    for (let c = 0; c < n; c++) {
      const ox = (hash01(seed, i, c + 10) - 0.5) * r * 0.06;
      const oz = (hash01(seed, i, c + 20) - 0.5) * r * 0.05;
      const big = hash01(seed, i, c + 30) < 0.14 ? 2.6 : 1;
      const ch = h * (0.16 + 0.3 * hash01(seed, i, c + 40)) * big;
      const rad = ch * (0.13 + 0.07 * hash01(seed, i, c + 50));
      const px = x + ox;
      const pz = bestZ + oz;
      const lean = ch * 0.18;
      const tone = mixc(color, [1, 1, 1], 0.05 * hash01(seed, i, c + 60));
      needle(s, px, pz, ground(px, pz) - 2, ch, rad, (hash01(seed, i, c + 70) - 0.5) * lean * 2, (hash01(seed, i, c + 80) - 0.5) * lean * 2, seed + i * 13 + c, tone, 1.1);
    }
  }
};

/** Falling water ribbon, a river lip and mist at the foot. */
const waterfall: Builder = (_s, f, { r, ground }, color, seed) => {
  const w = r * 0.02;
  const hw = r * 0.28;
  const cols = 22;
  const white: V3 = [0.95, 1, 1];
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const x = ((i / cols) * 2 - 1) * hw;
    let t = -Infinity;
    for (const z of [0.3 * w, 0.7 * w, 1.2 * w]) t = Math.max(t, ground(x, z));
    let b = Infinity;
    for (const z of [-1.2 * w, -1.8 * w, -2.4 * w]) b = Math.min(b, ground(x, z));
    top.push(t);
    bot.push(b);
  }
  const zTop = 0.35 * w;
  const zBot = -1.5 * w;
  for (let i = 0; i < cols; i++) {
    const x0 = ((i / cols) * 2 - 1) * hw;
    const x1 = (((i + 1) / cols) * 2 - 1) * hw;
    const edge0 = 1 - Math.pow(Math.abs((i / cols) * 2 - 1), 4) * 0.35;
    const edge1 = 1 - Math.pow(Math.abs(((i + 1) / cols) * 2 - 1), 4) * 0.35;
    const y0t = top[i]! + 1.5;
    const y1t = top[i + 1]! + 1.5;
    const y0b = bot[i]! + 2;
    const y1b = bot[i + 1]! + 2;
    f.quad([x0, y0t, zTop], [x1, y1t, zTop], [x1, y1b, zBot * edge1], [x0, y0b, zBot * edge0], white, 0.1, 1, Mode.Fall, [i / cols, 0], [(i + 1) / cols, 0], [(i + 1) / cols, 1], [i / cols, 1]);
  }
  // River above the lip, flat strips of white water.
  const rivW = r * 0.12;
  for (let i = 0; i < cols; i += 2) {
    const x0 = ((i / cols) * 2 - 1) * hw;
    const x1 = (((i + 2) / cols) * 2 - 1) * hw;
    const y = Math.max(top[i]!, top[i + 1]!, top[Math.min(cols, i + 2)]!) + 1.2;
    f.quad([x0, y, zTop], [x1, y, zTop], [x1, y, zTop + rivW], [x0, y, zTop + rivW], mixc(color, white, 0.5), 0, 1, Mode.Fall, [i / cols, 0.9], [(i + 2) / cols, 0.9], [(i + 2) / cols, 1], [i / cols, 1]);
  }
  // Mist rolling at the base.
  for (let i = 0; i < 9; i++) {
    const x = ((i / 8) * 2 - 1) * hw * 0.85;
    const z = zBot - w * (1.2 + hash01(seed, i, 1) * 1.6);
    const y = ground(x, z) + w * 0.5;
    const rad = w * (0.9 + hash01(seed, i, 2) * 0.9);
    blob(f, x, y + rad * 0.5, z, rad * 1.4, rad * 0.9, rad * 1.4, seed + i, white, { mode: Mode.Steam, jitter: 0.4, detail: 1 });
  }
};

/** Flat water (or glowing liquid) filling the lowest ground, fitted to the shore by ray marching. */
function lake(s: Channel, r: number, level: number, ground: Ground, color: V3, mode: Mode, emit: number): void {
  const rays = 36;
  const rim: V3[] = [];
  const maxR = r * 1.25;
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * TAU;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let d = maxR;
    const steps = 48;
    for (let i = 1; i <= steps; i++) {
      const dd = (i / steps) * maxR;
      if (ground(dx * dd, dz * dd) > level) {
        d = dd - (maxR / steps) * 0.4;
        break;
      }
    }
    rim.push([dx * d, level, dz * d]);
  }
  const centre: V3 = [0, level, 0];
  for (let k = 0; k < rays; k++) {
    const a = rim[k]!;
    const b = rim[(k + 1) % rays]!;
    s.tri(centre, b, a, color, emit, 1, mode, [0.5, 0.5], [0.5 + b[0] / (2 * maxR), 0.5 + b[2] / (2 * maxR)], [0.5 + a[0] / (2 * maxR), 0.5 + a[2] / (2 * maxR)]);
  }
}

const craterLake: Builder = (s, _f, { r, h, ground }, color, seed) => {
  lake(s, r, h * 0.5, ground, color as unknown as V3, Mode.Water, 0);
  // Boulders on the rim.
  for (let i = 0; i < 10; i++) {
    const a = hash01(seed, i, 1) * TAU;
    const d = r * (0.95 + 0.25 * hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const rad = 4 + 14 * hash01(seed, i, 3);
    blob(s, x, ground(x, z) + rad * 0.2, z, rad, rad * 0.65, rad * 0.9, seed + i, [0.32, 0.3, 0.28], { jitter: 0.5 });
  }
};

const glowingPool: Builder = (s, _f, { r, h, ground }, color, seed) => {
  lake(s, r, h * 0.4, ground, color as unknown as V3, Mode.Glow, 1.7);
  // Dark crust stones around the edge.
  for (let i = 0; i < 12; i++) {
    const a = hash01(seed, i, 1) * TAU;
    const d = r * (0.9 + 0.3 * hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const rad = 3 + 10 * hash01(seed, i, 3);
    blob(s, x, ground(x, z) + rad * 0.2, z, rad, rad * 0.6, rad * 0.9, seed + i, [0.05, 0.045, 0.045], { jitter: 0.5 });
  }
};

/** Ring of standing stones, a few with lintels, and a low altar. */
const ruins: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const n = 12;
  const rr = r * 0.82;
  const stones: { x: number; z: number; top: number; g: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const g = ground(x, z);
    const broken = hash01(seed, i, 1) < 0.4;
    const hh = h * (broken ? 0.35 + 0.35 * hash01(seed, i, 2) : 0.85 + 0.15 * hash01(seed, i, 3));
    const w = r * (0.055 + 0.02 * hash01(seed, i, 4));
    const lean = (hash01(seed, i, 5) - 0.5) * hh * 0.12;
    const col = tint(color, 0.85 + 0.3 * hash01(seed, i, 6));
    if (broken) {
      frustum(s, { cx: x, cz: z, y0: g - BURY, y1: g + hh, rx0: w * 1.1, rz0: w * 0.9, rx1: w * 0.85, rz1: w * 0.7, lx: lean, lz: lean * 0.5, seg: 5, rot: a, jitter: 0.25, seed: seed + i }, col, 0, 1);
    } else {
      frustum(s, { cx: x, cz: z, y0: g - BURY, y1: g + hh, rx0: w * 1.1, rz0: w * 0.9, rx1: w * 0.95, rz1: w * 0.8, lx: lean, lz: lean * 0.4, seg: 4, rot: a + Math.PI / 4, jitter: 0.08, seed: seed + i }, col, 0, 1);
    }
    stones.push({ x, z, top: g + hh, g, w });
    if (broken && hash01(seed, i, 7) < 0.7) {
      const fx = x + Math.cos(a + 1.2) * w * 3;
      const fz = z + Math.sin(a + 1.2) * w * 3;
      blob(s, fx, ground(fx, fz) + w * 0.4, fz, w * 1.3, w * 0.7, w * 1.0, seed + i * 3, col, { jitter: 0.4 });
    }
  }
  // Lintels across neighbouring tall stones.
  for (let i = 0; i < n; i += 4) {
    const a = stones[i]!;
    const b = stones[(i + 1) % n]!;
    if (a.top - a.g < h * 0.8 || b.top - b.g < h * 0.8) continue;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const len = Math.hypot(a.x - b.x, a.z - b.z);
    const y = Math.min(a.top, b.top);
    box(s, mx, mz, y - 1, y + h * 0.1, len * 0.58, a.w * 0.9, Math.atan2(b.z - a.z, b.x - a.x) * -1, tint(color, 0.95), 0, 1);
  }
  // Altar.
  const g0 = ground(0, 0);
  box(s, 0, 0, g0 - BURY, g0 + h * 0.12, r * 0.12, r * 0.08, 0.3, tint(color, 0.8), 0, 1);
  box(s, 0, 0, g0 + h * 0.12, g0 + h * 0.18, r * 0.16, r * 0.11, 0.3, tint(color, 1), 0.25, 1);
};

/** A single enormous tree: buttressed trunk, branches and a canopy of lobes. */
const giantTree: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const bark: V3 = [0.2, 0.13, 0.09];
  const g = ground(0, 0);
  const trunkR = r * 0.17;
  const trunkH = h * 0.62;
  // Roots.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + hash01(seed, i) * 0.4;
    const len = trunkR * (2.2 + hash01(seed, i, 2));
    const x = Math.cos(a) * len;
    const z = Math.sin(a) * len;
    const gg = ground(x, z);
    const w = trunkR * 0.32;
    const nx = -Math.sin(a) * w;
    const nz = Math.cos(a) * w;
    s.tri([Math.cos(a) * trunkR * 0.7 + nx, g + trunkH * 0.22, Math.sin(a) * trunkR * 0.7 + nz], [x, gg - 1, z], [Math.cos(a) * trunkR * 0.7 - nx, g + trunkH * 0.22, Math.sin(a) * trunkR * 0.7 - nz], bark, 0, 0.9);
    s.tri([Math.cos(a) * trunkR * 0.7 + nx, g + trunkH * 0.22, Math.sin(a) * trunkR * 0.7 + nz], [Math.cos(a) * trunkR * 0.7 - nx, g + trunkH * 0.22, Math.sin(a) * trunkR * 0.7 - nz], [Math.cos(a) * trunkR * 0.5, g + trunkH * 0.5, Math.sin(a) * trunkR * 0.5], bark, 0, 1.05);
  }
  // Trunk in three tapered stacks with a slight sway.
  let y = g - BURY;
  let rad = trunkR * 1.15;
  let sx = 0;
  for (let k = 0; k < 3; k++) {
    const y1 = g + trunkH * ((k + 1) / 3);
    const rad1 = rad * (k === 2 ? 0.7 : 0.82);
    const lx = (hash01(seed, k, 9) - 0.5) * trunkR * 0.5;
    frustum(s, { cx: sx, cz: 0, y0: y, y1, rx0: rad, rz0: rad, rx1: rad1, rz1: rad1, lx, lz: 0, seg: 8, rot: k * 0.4, jitter: 0.1, seed: seed + k }, bark, 0, 1);
    sx += lx;
    y = y1;
    rad = rad1;
  }
  // Branches reaching out under the canopy.
  const topY = y;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    const lenB = r * (0.38 + 0.15 * hash01(seed, i, 3));
    frustum(s, { cx: sx, cz: 0, y0: topY - h * 0.1, y1: topY + h * 0.1, rx0: trunkR * 0.28, rz0: trunkR * 0.28, rx1: trunkR * 0.1, rz1: trunkR * 0.1, lx: Math.cos(a) * lenB, lz: Math.sin(a) * lenB, seg: 5, seed: seed + 40 + i }, bark, 0, 0.95);
  }
  // Canopy lobes.
  const lobes = 9;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU + hash01(seed, i, 4);
    const d = i === 0 ? 0 : r * (0.35 + 0.35 * hash01(seed, i, 5));
    const ly = topY + h * (0.08 + 0.2 * hash01(seed, i, 6)) + (i === 0 ? h * 0.12 : 0);
    const lr = r * (0.38 + 0.18 * hash01(seed, i, 7)) * (i === 0 ? 1.2 : 1);
    const c = mixc(color, [0.5, 0.7, 0.2], 0.3 * hash01(seed, i, 8));
    blob(s, sx + Math.cos(a) * d, ly, Math.sin(a) * d, lr, lr * 0.62, lr, seed + i * 7, c, { jitter: 0.32, detail: 1, shade: 1.05 });
  }
};

/** A forest of leaning ice needles. */
const iceSpire: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = hash01(seed, i, 1) * TAU;
    const d = r * 0.7 * Math.sqrt(hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const hh = h * (i === 0 ? 1 : 0.28 + 0.6 * hash01(seed, i, 3));
    const rad = r * (i === 0 ? 0.075 : 0.035 + 0.035 * hash01(seed, i, 4));
    const lean = hh * 0.16;
    const px = i === 0 ? 0 : x;
    const pz = i === 0 ? 0 : z;
    needle(s, px, pz, ground(px, pz) - 3, hh, rad, (hash01(seed, i, 5) - 0.5) * lean * 2, (hash01(seed, i, 6) - 0.5) * lean * 2, seed + i * 5, mixc(color, [1, 1, 1], 0.2 * hash01(seed, i, 7)), 0.55, 6);
  }
};

/** Mounds with plumes of steam. */
const geyserField: Builder = (s, f, { r, h, ground }, color, seed) => {
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = hash01(seed, i, 1) * TAU;
    const d = i === 0 ? 0 : r * (0.35 + 0.6 * hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const g = ground(x, z);
    const big = i === 0 ? 1.4 : 0.55 + 0.7 * hash01(seed, i, 3);
    const mr = r * 0.06 * big;
    frustum(s, { cx: x, cz: z, y0: g - BURY, y1: g + mr * 0.45, rx0: mr * 1.5, rz0: mr * 1.5, rx1: mr * 0.5, rz1: mr * 0.5, seg: 8, jitter: 0.25, seed: seed + i }, [0.55, 0.5, 0.42], 0, 1);
    // Vent glow ring.
    const ph = hash01(seed, i, 4);
    const ph2 = hash01(seed, i, 5);
    const steamH = h * (0.4 + 0.45 * big * 0.7);
    const puffs = 12;
    for (let k = 0; k < puffs; k++) {
      const v = k / (puffs - 1);
      const pr = mr * (0.4 + v * 1.5);
      const py = g + mr * 0.5 + v * steamH;
      // The plume leans downwind a little.
      blob(f, x + v * v * steamH * 0.12 * (ph - 0.5) * 2, py, z + v * v * steamH * 0.1 * (ph2 - 0.5) * 2, pr, pr * 0.9, pr, seed + i * 31 + k, mixc(color, [1, 1, 1], 0.3), { mode: Mode.Steam, jitter: 0.3, detail: 1 });
    }
  }
};

/** Dry canyon: a river on the floor when a colour is given, otherwise a few buttes. */
const canyon: Builder = (s, _f, { lm, r, h, ground }, color, seed) => {
  const river = lm.color !== undefined;
  const steps = 40;
  let prev: { x: number; z: number; y: number } | null = null;
  for (let i = 0; i <= steps; i++) {
    const x = ((i / steps) * 2 - 1) * r * 0.95;
    let bestZ = 0;
    let bestY = Infinity;
    for (let k = -16; k <= 16; k++) {
      const z = k * r * 0.02;
      const y = ground(x, z);
      if (y < bestY) {
        bestY = y;
        bestZ = z;
      }
    }
    const cur = { x, z: bestZ, y: bestY + 1.5 };
    if (river && prev && Math.abs(cur.z - prev.z) < r * 0.2) {
      const w = r * 0.0035;
      s.quad([prev.x, prev.y, prev.z - w], [cur.x, cur.y, cur.z - w], [cur.x, cur.y, cur.z + w], [prev.x, prev.y, prev.z + w], color as unknown as V3, 0, 1, Mode.Water);
    }
    prev = cur;
    if (!river && i % 5 === 2) {
      const bx = x + (hash01(seed, i, 1) - 0.5) * r * 0.05;
      const bz = bestZ + (hash01(seed, i, 2) - 0.5) * r * 0.04;
      needle(s, bx, bz, ground(bx, bz) - 4, h * (0.15 + 0.2 * hash01(seed, i, 3)), r * 0.005, 0, 0, seed + i, [0.45, 0.25, 0.16], 0, 5);
    }
  }
};

/** Cairn with a pole and a pennant. */
const summit: Builder = (s, _f, { ground }, color, seed) => {
  const g = ground(0, 0);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    blob(s, Math.cos(a) * 4, g + 0.6, Math.sin(a) * 4, 2.6, 1.6, 2.4, seed + i, tint(color, 0.8 + 0.3 * hash01(seed, i)), { jitter: 0.5 });
  }
  blob(s, 0, g + 2.2, 0, 3.6, 2.6, 3.4, seed + 11, tint(color, 1.05), { jitter: 0.45 });
  blob(s, 0.4, g + 4.4, 0.2, 2.2, 1.6, 2.0, seed + 12, tint(color, 0.95), { jitter: 0.45 });
  frustum(s, { cx: 0, cz: 0, y0: g + 4, y1: g + 42, rx0: 0.35, rz0: 0.35, rx1: 0.2, rz1: 0.2, seg: 4, seed }, [0.6, 0.55, 0.5], 0, 1);
  const px = 0;
  const pz = 0;
  s.tri([px, g + 41.5, pz], [px + 14, g + 38, pz + 0.4], [px, g + 34.5, pz], [1, 0.45, 0.1], 0.9, 1);
  s.tri([px, g + 41.5, pz], [px, g + 34.5, pz], [px + 14, g + 38, pz + 0.4], [1, 0.45, 0.1], 0.9, 1);
};

/** Rounded red dome with banded stone and rubble at the foot. */
const mesa: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const g = Math.min(ground(r * 0.6, 0), ground(-r * 0.6, 0), ground(0, r * 0.6), ground(0, -r * 0.6));
  blob(s, 0, g + h * 0.3, 0, r * 0.85, h * 0.7, r * 0.4, seed, color as unknown as V3, { jitter: 0.1, detail: 2, bands: 7, shade: 1.1 });
  for (let i = 0; i < 9; i++) {
    const a = hash01(seed, i, 1) * TAU;
    const d = r * (0.8 + 0.5 * hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d * 0.7;
    const rad = r * (0.05 + 0.07 * hash01(seed, i, 3));
    blob(s, x, ground(x, z) + rad * 0.2, z, rad, rad * 0.6, rad * 0.9, seed + i, tint(color, 0.8), { jitter: 0.5 });
  }
};

/** Peak ring of a big basin: jagged hills around the centre. */
const crater: Builder = (s, _f, { r, h, ground }, color, seed) => {
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + hash01(seed, i) * 0.6;
    const d = i === 0 ? 0 : r * 0.12 * (0.5 + hash01(seed, i, 2));
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const hh = h * (i === 0 ? 0.55 : 0.18 + 0.3 * hash01(seed, i, 3));
    const rad = hh * (0.55 + 0.25 * hash01(seed, i, 4));
    frustum(s, { cx: x, cz: z, y0: ground(x, z) - 6, y1: ground(x, z) + hh, rx0: rad, rz0: rad * 0.9, rx1: 0, rz1: 0, lx: (hash01(seed, i, 5) - 0.5) * rad * 0.6, seg: 5, jitter: 0.3, seed: seed + i }, tint(color, 0.8 + 0.4 * hash01(seed, i, 6)), 0, 1);
  }
};

/** Tiny lander with legs, a ladder, a flag and a blinking light. */
const lander: Builder = (s, _f, { ground }, color) => {
  const g = ground(0, 0);
  const foil = tint(color, 1);
  const grey: V3 = [0.55, 0.55, 0.58];
  // Descent stage and ascent stage.
  frustum(s, { cx: 0, cz: 0, y0: g + 1.2, y1: g + 2.8, rx0: 2.2, rz0: 2.2, rx1: 2.0, rz1: 2.0, seg: 8, rot: 0.2 }, foil, 0, 1);
  frustum(s, { cx: 0, cz: 0, y0: g + 2.8, y1: g + 4.6, rx0: 1.6, rz0: 1.6, rx1: 1.2, rz1: 1.2, seg: 8, rot: 0.4 }, grey, 0, 1.05);
  frustum(s, { cx: 0, cz: 0, y0: g + 4.6, y1: g + 5.1, rx0: 1.2, rz0: 1.2, rx1: 0.2, rz1: 0.2, seg: 8 }, grey, 0, 1);
  // Legs.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const x = Math.cos(a) * 4.4;
    const z = Math.sin(a) * 4.4;
    const gy = ground(x, z);
    frustum(s, { cx: x, cz: z, y0: gy - 0.2, y1: g + 1.9, rx0: 0.12, rz0: 0.12, rx1: 0.12, rz1: 0.12, lx: -x * 0.48, lz: -z * 0.48, seg: 4, rot: a }, grey, 0, 0.9);
    frustum(s, { cx: x, cz: z, y0: gy - 0.4, y1: gy + 0.15, rx0: 0.9, rz0: 0.9, rx1: 0.8, rz1: 0.8, seg: 8 }, foil, 0, 0.9);
  }
  // Flag a little away.
  const fx = 9;
  const fz = 4;
  const gf = ground(fx, fz);
  frustum(s, { cx: fx, cz: fz, y0: gf, y1: gf + 3.2, rx0: 0.05, rz0: 0.05, rx1: 0.05, rz1: 0.05, seg: 4 }, [0.85, 0.85, 0.85], 0, 1);
  s.quad([fx, gf + 3.1, fz], [fx + 1.8, gf + 3.1, fz], [fx + 1.8, gf + 2.2, fz], [fx, gf + 2.2, fz], [0.95, 0.95, 0.95], 0.2, 1);
  s.quad([fx, gf + 3.1, fz + 0.01], [fx + 1.8, gf + 3.1, fz + 0.01], [fx + 1.8, gf + 2.2, fz + 0.01], [fx, gf + 2.2, fz + 0.01], [0.95, 0.95, 0.95], 0.2, 1);
  s.quad([fx, gf + 2.85, fz + 0.02], [fx + 1.8, gf + 2.85, fz + 0.02], [fx + 1.8, gf + 2.55, fz + 0.02], [fx, gf + 2.55, fz + 0.02], [0.8, 0.1, 0.1], 0.2, 1);
  s.quad([fx, gf + 2.85, fz - 0.02], [fx, gf + 2.55, fz - 0.02], [fx + 1.8, gf + 2.55, fz - 0.02], [fx + 1.8, gf + 2.85, fz - 0.02], [0.8, 0.1, 0.1], 0.2, 1);
  // A blinking light so the site can be spotted from a distance (mode Glow pulses).
  blob(s, 0, g + 5.4, 0, 0.5, 0.5, 0.5, 3, [1.0, 0.3, 0.2], { emit: 6, mode: Mode.Glow, jitter: 0, detail: 0 });
};

const BUILDERS: Record<LandmarkKind, Builder> = {
  arch,
  monolith,
  crystalCanyon,
  waterfall,
  craterLake,
  ruins,
  giantTree,
  iceSpire,
  geyserField,
  glowingPool,
  canyon,
  summit,
  mesa,
  crater,
  lander,
};

/** Default tint for a landmark: its own colour, or the kind's. */
export function tintFor(lm: LandmarkDef): RGB {
  return lm.color ?? LANDMARK_COLOR[lm.kind];
}

/** Builds the solid and transparent geometry of one landmark in tangent space (x east, y up, z south). */
export function buildLandmark(input: BuildInput): Built {
  const solid = new Channel();
  const fx = new Channel();
  BUILDERS[input.lm.kind](solid, fx, input, tintFor(input.lm), seedOf(input.lm.id));
  return { solid: solid.empty ? null : solid.build(), fx: fx.empty ? null : fx.build() };
}
