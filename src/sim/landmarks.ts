import { Vector3 } from 'three';
import { config } from '../core/config';
import { landmarkKey, landmarkRadiusMeters, landmarksOf } from '../data/landmarks';
import type { LandmarkDef } from '../data/types';
import { latLonToDir } from '../terrain/api';
import type { Body } from './universe';
import type { World } from './world';

/** Anything the HUD can lock on: a body, or a landmark on the current body. */
export interface Targetable {
  readonly name: string;
  /** World position, float64. */
  readonly position: Vector3;
  /** Game meters, for the target marker size and the distance. */
  readonly radius: number;
}

/** A landmark in the world: its definition plus where it is right now. */
export class LandmarkTarget implements Targetable {
  readonly key: string;
  /** Body fixed unit direction. */
  readonly dir = new Vector3();
  /** World position (updated by the field). */
  readonly position = new Vector3();
  /** Terrain height under it, game meters above the base radius (NaN until sampled). */
  groundHeight = Number.NaN;
  discovered = false;
  readonly footprint: number;

  constructor(
    readonly body: Body,
    readonly def: LandmarkDef,
    systemId: string,
  ) {
    this.key = landmarkKey(systemId, body.id, def.id);
    latLonToDir(def.lat, def.lon, this.dir);
    this.footprint = landmarkRadiusMeters(def, body.radius);
  }

  /** The name stays hidden until the place is discovered. */
  get name(): string {
    return this.discovered ? this.def.name : 'UNKNOWN';
  }

  get radius(): number {
    return Math.max(40, this.footprint * 0.5);
  }
}

/** Horizontal distance and altitude rule for discovering a landmark. Pure, for tests. */
export function withinDiscovery(horizontal: number, altitude: number, landed: boolean): boolean {
  const c = config.landmarks;
  if (landed) return horizontal <= c.landedRadius;
  return horizontal <= c.discoverRadius && altitude <= c.discoverAltitude;
}

/** Great circle distance along the surface at the body's base radius. */
export function surfaceDistance(a: Vector3, b: Vector3, radius: number): number {
  const d = Math.min(1, Math.max(-1, a.dot(b)));
  return Math.acos(d) * radius;
}

const _w = new Vector3();

/** Every landmark of the system, with live world positions. Owned by the World. */
export class LandmarkField {
  readonly all: LandmarkTarget[] = [];
  private readonly byBody = new Map<Body, LandmarkTarget[]>();

  constructor(private readonly world: World) {
    const sys = world.universe.system;
    for (const body of world.universe.bodies) {
      const defs = body.kind === 'rocky' ? landmarksOf(body.def) : [];
      if (defs.length === 0) continue;
      const list = defs.map((d) => new LandmarkTarget(body, d, sys.id));
      this.byBody.set(body, list);
      this.all.push(...list);
    }
  }

  of(body: Body): readonly LandmarkTarget[] {
    return this.byBody.get(body) ?? [];
  }

  /** Marks which landmarks are discovered, from a set of keys. */
  setDiscovered(keys: ReadonlySet<string>): void {
    for (const l of this.all) l.discovered = keys.has(l.key);
  }

  /** Recomputes world positions. Ground heights are sampled for the body the ship is at. */
  update(): void {
    const here = this.world.ship.frame.body;
    for (const [body, list] of this.byBody) {
      const sample = body === here;
      for (const l of list) {
        if (Number.isNaN(l.groundHeight) && sample) l.groundHeight = this.world.groundHeight(body, l.dir);
        const h = Number.isNaN(l.groundHeight) ? 0 : l.groundHeight;
        _w.copy(l.dir).multiplyScalar(body.radius + h).applyQuaternion(body.rotation);
        l.position.copy(body.position).add(_w);
      }
    }
  }
}
