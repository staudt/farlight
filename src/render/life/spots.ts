import { Vector3 } from 'three';
import type { LifeDef, LifeKind } from '../../data/types';
import type { Body } from '../../sim/universe';
import type { World } from '../../sim/world';
import { dirToLatLon, latLonToDir } from '../../terrain/api';
import { makeProbe } from './env';
import { CELL_SIZE, CellGrid, groupHome, tangentFrame, type Home } from './spawn';

export interface LifeSpot {
  /** Degrees, where to put the ship. */
  lat: number;
  lon: number;
  /** Degrees from north, clockwise, facing the group. */
  heading: number;
  /** Where the group lives, body fixed. */
  home: Vector3;
  /** Groups of this kind within the cluster radius of the home. */
  neighbours: number;
  /** Result of `opts.altitude` for the chosen group. */
  altitude?: number;
}

export interface SpotOptions {
  /** Places to look around, [lat, lon] degrees. Omit to search the whole body from lat 0, lon 0. */
  centres?: readonly (readonly [number, number])[];
  /** Search radius around each centre, game meters. */
  radius?: number;
  /** Stop at the first centre with a home that has at least this many neighbours. */
  wantNeighbours?: number;
  /** Distance to stand off from the group, game meters. */
  standoff: number;
  /** Compass bearing the ship faces, degrees. */
  bearing?: number;
  /** Cluster radius for counting neighbours (default 3 cells). */
  cluster?: number;
  /** Picks a flying height for the ship from the chosen group's def and its random stream. */
  altitude?: (def: LifeDef, home: Home) => number;
  /** Moves the aim point from the group's home by [east, south] meters (e.g. to where a flock circles). */
  aim?: (def: LifeDef, home: Home) => readonly [number, number];
  /** Only consider life entries that pass. */
  only?: (def: LifeDef) => boolean;
}

/**
 * Finds a place where the creatures of `kind` live (the same rule the game uses), and a ship
 * position `standoff` meters before it. Returns null when the body has none.
 */
export function findLifeSpot(world: World, body: Body, kind: LifeKind, opts: SpotOptions): LifeSpot | null {
  const defs = body.def.life ?? [];
  const idxs = defs.map((d, i) => (d.kind === kind && (opts.only?.(d) ?? true) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return null;
  const probe = makeProbe(world, body);
  const R = body.radius;
  const grid = new CellGrid(CELL_SIZE[kind] / R);
  const cluster = opts.cluster ?? CELL_SIZE[kind] * 3;
  const centres = opts.centres ?? [[0, 0] as const];
  const radiusAngle = opts.centres ? (opts.radius ?? CELL_SIZE[kind] * 25) / R : Math.PI;
  const want = opts.wantNeighbours ?? 1;
  const c = new Vector3();
  const d0 = new Vector3();
  let best: { dir: Vector3; n: number; home: Home; idx: number } | null = null;

  for (const [lat, lon] of centres) {
    latLonToDir((lat * Math.PI) / 180, (lon * Math.PI) / 180, d0);
    const homes: { home: Home; idx: number }[] = [];
    for (const cell of grid.near(d0, radiusAngle)) {
      grid.centre(cell.row, cell.col, c);
      for (const idx of idxs) {
        const h = groupHome(defs[idx] as LifeDef, body.def.seed, idx, cell, c, grid, R, probe);
        if (h) homes.push({ home: h, idx });
      }
      // A global search only needs the nearest hit.
      if (!opts.centres && homes.length >= want) break;
    }
    for (const h of homes) {
      const n = homes.filter((o) => Math.acos(Math.min(1, h.home.dir.dot(o.home.dir))) * R < cluster).length;
      if (!best || n > best.n) best = { dir: h.home.dir, n, home: h.home, idx: h.idx };
    }
    if (best && best.n >= want) break;
  }
  if (!best) return null;

  // Aim at the group, or a point offset from its home.
  const aimDir = best.dir.clone();
  if (opts.aim) {
    const [dx, dz] = opts.aim(defs[best.idx] as LifeDef, best.home);
    const e0 = new Vector3();
    const s0 = new Vector3();
    tangentFrame(best.dir, e0, s0);
    aimDir.multiplyScalar(R).addScaledVector(e0, dx).addScaledVector(s0, dz).normalize();
  }
  // Stand off against the bearing, facing the group.
  const bearing = ((opts.bearing ?? 40) * Math.PI) / 180;
  const east = new Vector3();
  const south = new Vector3();
  tangentFrame(aimDir, east, south);
  const fwd = east.clone().multiplyScalar(Math.sin(bearing)).addScaledVector(south, -Math.cos(bearing));
  const pos = aimDir.clone().multiplyScalar(R).addScaledVector(fwd, -opts.standoff).normalize();
  const ll = dirToLatLon(pos.x, pos.y, pos.z);
  return { lat: (ll.lat * 180) / Math.PI, lon: (ll.lon * 180) / Math.PI, heading: (bearing * 180) / Math.PI, home: best.dir, neighbours: best.n, ...(opts.altitude ? { altitude: opts.altitude(defs[best.idx] as LifeDef, best.home) } : {}) };
}
