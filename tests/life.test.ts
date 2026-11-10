import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { createGalaxy, generateSystem } from '../src/data/generate';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import type { LifeDef } from '../src/data/types';
import { BIRD_PARAMS, Flock } from '../src/render/life/boids';
import { lifeBudget, maxInstances } from '../src/render/life/settings';
import { CELL_SIZE, CellGrid, groupHome, siteFits, type SiteSample, type SurfaceProbe } from '../src/render/life/spawn';

/** A fake world: west of lon 0 is sea, east is forest, with a coast at the seam. */
const probe: SurfaceProbe = {
  sample(x, _y, z, out: SiteSample): SiteSample {
    const water = z > 0; // z = -cos(lat) sin(lon): positive for lon < 0
    out.water = water;
    out.depth = water ? 20 : 0;
    out.depthN = water ? 0.02 : 0;
    out.name = water ? '' : x > 0 ? 'forest' : 'grass';
    out.height = 0;
    return out;
  },
  ground: (x) => 30 * Math.sin(x * 4000),
};

const gulls: LifeDef = { kind: 'birds', color: [1, 1, 1], count: 20, minAlt: 40, maxAlt: 1500, biomes: ['coast'], day: true, size: 6, chance: 1 };
const R = 637100;

describe('spawn cells', () => {
  test('are deterministic and follow the body seed', () => {
    const grid = new CellGrid(CELL_SIZE.birds / R);
    const dir = new Vector3(1, 0, 0);
    const cells = grid.near(dir, 4000 / R);
    expect(cells.length).toBeGreaterThan(10);
    const c = new Vector3();
    const run = (seed: number): string[] =>
      cells.map((cell) => {
        grid.centre(cell.row, cell.col, c);
        const h = groupHome(gulls, seed, 0, cell, c.clone(), grid, R, probe);
        return h ? `${cell.row},${cell.col}:${h.dir.x.toFixed(6)},${h.dir.y.toFixed(6)},${h.dir.z.toFixed(6)}` : '-';
      });
    expect(run(3)).toEqual(run(3));
    const none = (a: string[]): boolean => a.every((s) => s === '-');
    expect(none(run(3))).toBe(false);
    expect(run(3)).not.toEqual(run(4));
  });

  test('cells are nearest first and inside the radius', () => {
    const grid = new CellGrid(CELL_SIZE.birds / R);
    const dir = new Vector3(1, 0.3, -0.4).normalize();
    const cells = grid.near(dir, 3000 / R);
    const c = new Vector3();
    let last = -1;
    for (const cell of cells) {
      grid.centre(cell.row, cell.col, c);
      const d = Math.acos(Math.min(1, c.dot(dir)));
      expect(d).toBeLessThanOrEqual(3000 / R + (CELL_SIZE.birds / R) * 0.7 + 1e-9);
      expect(d).toBeGreaterThanOrEqual(last - 1e-12);
      last = d;
    }
  });

  test('coast sites need both water and land, forest sites need trees', () => {
    const grid = new CellGrid(CELL_SIZE.birds / R);
    const seam = new Vector3(1, 0, 0);
    const inland = new Vector3(Math.cos(0.01), 0, -Math.sin(0.01)); // water has z > 0: this is east, land
    expect(siteFits(gulls, seam, grid.cellAngle, probe)).toBe(true);
    expect(siteFits(gulls, inland.clone().multiplyScalar(1).normalize().setZ(-0.2).normalize(), grid.cellAngle, probe)).toBe(false);
    const forest: LifeDef = { ...gulls, biomes: ['forest'] };
    expect(siteFits(forest, new Vector3(1, 0, -0.2).normalize(), grid.cellAngle, probe)).toBe(true);
    expect(siteFits(forest, new Vector3(1, 0, 0.2).normalize(), grid.cellAngle, probe)).toBe(false);
  });
});

describe('boids', () => {
  const hills = (x: number, z: number): number => 60 + 45 * Math.sin(x * 0.013) * Math.cos(z * 0.017);

  test('stay above the ground, scared or not', () => {
    const f = new Flock(24, 99, 220);
    let minClear = Infinity;
    for (let i = 0; i < 4000; i++) {
      const threat = i > 1500 && i < 2200 ? { x: f.px[0]!, y: f.py[0]! - 5, z: f.pz[0]!, radius: 150 } : null;
      f.step(1 / 30, hills, threat);
      for (let k = 0; k < f.n; k++) minClear = Math.min(minClear, f.py[k]! - hills(f.px[k]!, f.pz[k]!));
    }
    expect(minClear).toBeGreaterThanOrEqual(BIRD_PARAMS.floorClear * 0.5 - 1e-6);
    // Speeds stay bounded.
    for (let k = 0; k < f.n; k++) expect(Math.hypot(f.vx[k]!, f.vy[k]!, f.vz[k]!)).toBeLessThan(BIRD_PARAMS.maxSpeed * 2);
  });

  test('flocks stay together and circle their home', () => {
    const f = new Flock(20, 7, 200);
    for (let i = 0; i < 3000; i++) f.step(1 / 30, hills);
    const c = { x: 0, y: 0, z: 0 };
    f.centre(c);
    let spread = 0;
    for (let k = 0; k < f.n; k++) spread = Math.max(spread, Math.hypot(f.px[k]! - c.x, f.pz[k]! - c.z));
    expect(spread).toBeLessThan(400);
    expect(Math.hypot(c.x, c.z)).toBeLessThan(600);
  });

  test('a threat scares the flock', () => {
    const f = new Flock(12, 5, 200);
    for (let i = 0; i < 60; i++) f.step(1 / 30, hills);
    expect(f.panic).toBe(0);
    f.step(1 / 30, hills, { x: f.px[0]!, y: f.py[0]!, z: f.pz[0]!, radius: 150 });
    expect(f.panic).toBeGreaterThan(0);
  });
});

describe('budgets', () => {
  test('stay under the quality caps', () => {
    for (const [scale, density] of [[0.35, 1], [0.65, 1], [1, 1], [1, 3], [0.35, 3]] as const) {
      const b = lifeBudget(scale, density);
      const m = maxInstances(b);
      expect(m.birds).toBeLessThanOrEqual(b.flocks * 30);
      expect(b.birdsPerFlock).toBeLessThanOrEqual(30);
      expect(m.fish).toBeLessThanOrEqual(640);
      expect(m.motes).toBeLessThanOrEqual(800);
      expect(m.whales).toBeLessThanOrEqual(24);
      expect(m.birds).toBeLessThanOrEqual(600);
    }
    const hi = maxInstances(lifeBudget(1, 1));
    expect(hi.birds).toBeLessThanOrEqual(300);
  });

  test('low quality keeps few birds and no fish or fireflies', () => {
    const low = lifeBudget(0.35, 1);
    expect(low.flocks).toBeGreaterThan(0);
    expect(low.flocks).toBeLessThan(lifeBudget(1, 1).flocks);
    expect(low.schools).toBe(0);
    expect(low.swarms).toBe(0);
    expect(lifeBudget(1, 0).flocks).toBe(0);
    expect(lifeBudget(1, 0).pods).toBe(0);
  });
});

describe('life data', () => {
  test('Earth has birds, fish and fireflies', () => {
    const earth = SOLAR_SYSTEM.bodies.find((b) => b.id === 'earth')!;
    const kinds = new Set(earth.life?.map((l) => l.kind));
    expect(kinds).toEqual(new Set(['birds', 'fish', 'fireflies']));
    for (const l of earth.life!) {
      expect(l.maxAlt).toBeGreaterThanOrEqual(l.minAlt);
      expect(l.count).toBeGreaterThan(0);
    }
  });

  test('generated living worlds get life and dead worlds do not', () => {
    const galaxy = createGalaxy();
    let whales = 0;
    let earthlike = 0;
    for (const s of galaxy.stars.slice(1, 80)) {
      const sys = generateSystem(s);
      for (const b of sys.bodies) {
        if (b.kind === 'gas' || b.kind === 'star') expect(b.life).toBeUndefined();
        if (b.life?.some((l) => l.kind === 'skyWhales')) {
          whales++;
          expect(b.life.some((l) => l.kind === 'fireflies')).toBe(true);
        }
        if (b.life?.some((l) => l.kind === 'birds')) earthlike++;
      }
      // Same star, same life.
      expect(generateSystem(s)).toEqual(sys);
    }
    expect(whales).toBeGreaterThan(0);
    expect(earthlike).toBeGreaterThan(0);
  });
});
