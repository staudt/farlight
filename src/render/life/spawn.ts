import { Vector3 } from 'three';
import { hashInts, mulberry32 } from '../../core/rng';
import type { LifeDef } from '../../data/types';
import { dirToLatLon, latLonToDir } from '../../terrain/api';

/** Surface facts about one point, as the creature rules need them. */
export interface SiteSample {
  water: boolean;
  /** Water depth in game meters. */
  depth: number;
  /** Water depth in normalized height units. */
  depthN: number;
  /** Biome name on land, '' on water. */
  name: string;
  /** Surface height in game meters above the radius (sea level on water). */
  height: number;
}

/** Read-only view of the terrain for spawning (wraps the shared height sampler). */
export interface SurfaceProbe {
  sample(x: number, y: number, z: number, out: SiteSample): SiteSample;
  ground(x: number, y: number, z: number): number;
}

export function makeSite(): SiteSample {
  return { water: false, depth: 0, depthN: 0, name: '', height: 0 };
}

export interface Cell {
  row: number;
  col: number;
}

/** Cells of roughly equal angular size on the sphere: rows of latitude, fewer columns toward the poles. */
export class CellGrid {
  readonly rows: number;
  private readonly step: number;

  constructor(readonly cellAngle: number) {
    this.rows = Math.max(2, Math.round(Math.PI / cellAngle));
    this.step = Math.PI / this.rows;
  }

  lat(row: number): number {
    return -Math.PI / 2 + (row + 0.5) * this.step;
  }

  cols(row: number): number {
    return Math.max(1, Math.round((2 * Math.PI * Math.cos(this.lat(row))) / this.step));
  }

  centre(row: number, col: number, out: Vector3): Vector3 {
    const n = this.cols(row);
    latLonToDir(this.lat(row), ((col + 0.5) / n) * 2 * Math.PI - Math.PI, out);
    return out;
  }

  rowOf(lat: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((lat + Math.PI / 2) / this.step)));
  }

  colOf(row: number, lon: number): number {
    const n = this.cols(row);
    return Math.min(n - 1, Math.max(0, Math.floor(((lon + Math.PI) / (2 * Math.PI)) * n)));
  }

  /** Unique number for a cell. */
  key(row: number, col: number): number {
    return row * 100003 + col;
  }

  /** Cells whose centre is within `angle` radians of `dir`, nearest first. */
  near(dir: { x: number; y: number; z: number }, angle: number): Cell[] {
    const ll = dirToLatLon(dir.x, dir.y, dir.z);
    const out: { row: number; col: number; d: number }[] = [];
    const r0 = this.rowOf(ll.lat - angle);
    const r1 = this.rowOf(ll.lat + angle);
    const lim = angle + this.cellAngle * 0.7;
    const c = new Vector3();
    for (let row = r0; row <= r1; row++) {
      const n = this.cols(row);
      const polar = ll.lat + angle >= Math.PI / 2 || ll.lat - angle <= -Math.PI / 2;
      const worst = Math.min(Math.abs(ll.lat) + angle, Math.PI / 2 - 0.01);
      const lonHalf = polar ? Math.PI : Math.min(Math.PI, (lim + this.step) / Math.max(Math.cos(worst), 0.02));
      const colSpan = Math.ceil((lonHalf / (2 * Math.PI)) * n) + 1;
      const c0 = this.colOf(row, ll.lon);
      const all = 2 * colSpan + 1 >= n;
      const from = all ? 0 : c0 - colSpan;
      const to = all ? n - 1 : c0 + colSpan;
      for (let k = from; k <= to; k++) {
        const col = ((k % n) + n) % n;
        this.centre(row, col, c);
        const d = Math.acos(Math.min(1, c.x * dir.x + c.y * dir.y + c.z * dir.z));
        if (d <= lim) out.push({ row, col, d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
}

/** Deterministic random stream for one cell and one life entry of one body. */
export function cellRng(bodySeed: number, lifeIdx: number, row: number, col: number): () => number {
  return mulberry32(hashInts(bodySeed, 7001 + lifeIdx, row, col));
}

/** East and south tangent axes at `dir` (east x up = south, so east, up, south is right handed). */
export function tangentFrame(dir: Vector3, east: Vector3, south: Vector3): void {
  if (Math.abs(dir.y) > 0.9995) east.set(0, 0, -1);
  else east.set(0, 1, 0).cross(dir).normalize();
  south.crossVectors(east, dir).normalize();
}

/** Default per cell chance for a kind. */
export function defaultChance(kind: LifeDef['kind']): number {
  return kind === 'birds' ? 0.4 : kind === 'skyWhales' ? 0.3 : kind === 'fish' ? 0.45 : 0.5;
}

const _t = new Vector3();
const _e = new Vector3();
const _s = new Vector3();
const _site = makeSite();
const _centre = makeSite();

/**
 * Does the site around a cell centre fit this life entry? Looks at the centre and four points
 * 0.8 cells away: 'coast' needs water and land among them, 'land' / 'water' / 'shallows' look at
 * the centre, any other token is a biome name found on land nearby. Any token matching is enough.
 */
export function siteFits(def: LifeDef, centre: Vector3, cellAngle: number, probe: SurfaceProbe): boolean {
  if (def.latitude) {
    const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, centre.y))));
    if (lat < def.latitude[0] || lat > def.latitude[1]) return false;
  }
  const tokens = def.biomes;
  if (!tokens || tokens.length === 0) return true;
  tangentFrame(centre, _e, _s);
  const c = probe.sample(centre.x, centre.y, centre.z, _centre);
  const names = new Set<string>();
  let water = c.water ? 1 : 0;
  let land = c.water ? 0 : 1;
  if (!c.water && c.name) names.add(c.name);
  const d = cellAngle * 0.8;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.6;
    _t.copy(centre).addScaledVector(_e, Math.cos(a) * d).addScaledVector(_s, Math.sin(a) * d).normalize();
    const s = probe.sample(_t.x, _t.y, _t.z, _site);
    if (s.water) water++;
    else {
      land++;
      if (s.name) names.add(s.name);
    }
  }
  for (const t of tokens) {
    const hit = t === 'coast' ? water > 0 && land > 0 : t === 'land' ? !c.water : t === 'water' ? c.water : t === 'shallows' ? c.water && c.depthN < 0.05 : names.has(t);
    if (hit) return true;
  }
  return false;
}

/** Ground cell edge per kind, game meters. */
export const CELL_SIZE: Record<LifeDef['kind'], number> = { birds: 900, skyWhales: 20000, fish: 240, fireflies: 150 };
/** How far from the cell centre a group may be placed, as a fraction of the cell. */
const JITTER: Record<LifeDef['kind'], number> = { birds: 0.6, skyWhales: 0.4, fish: 0, fireflies: 0.6 };

export interface Home {
  /** Body fixed unit direction of the group's home. */
  dir: Vector3;
  /** Random stream, positioned after the draws used here. */
  rnd: () => number;
}

const _he = new Vector3();
const _hs = new Vector3();
const _hsite = makeSite();

/**
 * The whole spawn rule for one cell and one life entry: the chance roll, the site, and the home
 * jitter. Deterministic from the body seed and the cell. Layers and scenarios share it.
 */
export function groupHome(
  def: LifeDef,
  bodySeed: number,
  idx: number,
  cell: Cell,
  centre: Vector3,
  grid: CellGrid,
  bodyRadius: number,
  probe: SurfaceProbe,
  density = 1,
): Home | null {
  const rnd = cellRng(bodySeed, idx, cell.row, cell.col);
  if (rnd() >= (def.chance ?? defaultChance(def.kind)) * Math.min(1.5, density)) return null;
  if (!siteFits(def, centre, grid.cellAngle, probe)) return null;
  if (def.kind === 'fish' && !probe.sample(centre.x, centre.y, centre.z, _hsite).water) return null;
  const size = CELL_SIZE[def.kind] * JITTER[def.kind];
  const jx = (rnd() - 0.5) * size;
  const jz = (rnd() - 0.5) * size;
  tangentFrame(centre, _he, _hs);
  const dir = new Vector3().copy(centre).multiplyScalar(bodyRadius).addScaledVector(_he, jx).addScaledVector(_hs, jz).normalize();
  return { dir, rnd };
}

/**
 * Keeps the set of live groups around a moving point. Cells near the camera are rolled once
 * (deterministic from body seed and cell), the ones that win become groups, groups far away go.
 */
export class Spawner<G extends { dir: Vector3 }> {
  readonly groups = new Map<number, G>();
  private decided = new Set<number>();
  private readonly centre = new Vector3();

  constructor(
    readonly grid: CellGrid,
    private readonly bodyRadius: number,
    private readonly spawnRadius: number,
    private readonly despawnRadius: number,
    private readonly make: (cell: Cell, lifeIdx: number, centre: Vector3) => G | null,
  ) {}

  clear(): void {
    this.groups.clear();
    this.decided.clear();
  }

  /** Forget that a cell was rolled (a group that faded out can come back later). */
  forget(key: number): void {
    this.groups.delete(key);
    this.decided.delete(key);
  }

  /**
   * One scan. `entries` are the life entries allowed right now (index into the body's own list),
   * `cap` the most groups alive, `evals` the most new cells rolled this call.
   */
  scan(camDir: Vector3, entries: readonly number[], cap: number, evals: number): void {
    for (const [k, g] of this.groups) {
      const ang = Math.acos(Math.min(1, g.dir.dot(camDir)));
      if (ang * this.bodyRadius > this.despawnRadius) this.groups.delete(k);
    }
    const near = this.grid.near(camDir, this.spawnRadius / this.bodyRadius);
    const nearKeys = new Set<number>();
    let n = 0;
    for (const cell of near) {
      for (const idx of entries) {
        const key = this.grid.key(cell.row, cell.col) * 8 + idx;
        nearKeys.add(key);
        if (this.groups.has(key) || this.decided.has(key)) continue;
        if (n >= evals || this.groups.size >= cap) continue;
        n++;
        this.decided.add(key);
        this.grid.centre(cell.row, cell.col, this.centre);
        const g = this.make(cell, idx, this.centre);
        if (g) this.groups.set(key, g);
      }
    }
    for (const k of this.decided) if (!nearKeys.has(k)) this.decided.delete(k);
  }
}

/** Key of a cell and life entry, matching what `Spawner` uses. */
export function groupKey(grid: CellGrid, cell: Cell, idx: number): number {
  return grid.key(cell.row, cell.col) * 8 + idx;
}
