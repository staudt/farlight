import { Quaternion, Vector3 } from 'three';
import type { BodyDef, StarSystemDef } from '../data/types';
import {
  DEFAULT_SCALE,
  type ScaleProfile,
  scaledOrbitDistance,
  scaledRadius,
  soiFactor,
} from '../data/scale';
import { orbitState, type ScaledOrbit } from './ephemeris';

const G0 = 9.81;
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

/** A body in game units with its state at the current sim time (world space, float64). */
export class Body {
  readonly def: BodyDef;
  readonly id: string;
  readonly name: string;
  readonly kind: BodyDef['kind'];
  parent: Body | null = null;
  readonly children: Body[] = [];

  /** Game radius in meters. */
  readonly radius: number;
  /** Atmosphere thickness in game meters (0 when airless). */
  readonly atmosphereHeight: number;
  /** Max terrain relief in game meters. */
  readonly terrainAmplitude: number;
  readonly soiRadius: number;
  readonly minApparentSize: number;
  /** m/s^2 at the surface. */
  readonly surfaceGravity: number;
  readonly orbit: ScaledOrbit | null;
  /** Spin rate in rad/s around the body's local +Y. */
  spinRate: number;
  readonly tilt: Quaternion;

  readonly localPosition = new Vector3();
  readonly localVelocity = new Vector3();
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  /** Body fixed -> world rotation. */
  readonly rotation = new Quaternion();
  /** Angular velocity vector in body fixed coordinates. */
  readonly angularVelocityLocal = new Vector3();

  constructor(def: BodyDef, parentDef: BodyDef | undefined, scale: ScaleProfile) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.kind = def.kind;
    this.radius = scaledRadius(def, scale);
    this.atmosphereHeight = def.atmosphere ? def.atmosphere.height * this.radius : 0;
    this.terrainAmplitude = def.terrain ? def.terrain.amplitude * this.radius : 0;
    this.soiRadius = soiFactor(def, parentDef, scale) * this.radius;
    this.minApparentSize = def.visual.minApparentSize ?? scale.minApparentSize;
    this.surfaceGravity = def.physical.surfaceGravity * G0;
    this.tilt = new Quaternion().setFromAxisAngle(X_AXIS, def.physical.axialTilt);
    if (def.orbit && parentDef) {
      const o = def.orbit;
      this.orbit = {
        a: scaledOrbitDistance(def, parentDef, scale),
        e: o.eccentricity,
        i: o.inclination,
        node: o.ascendingNode,
        argPeri: o.argPeriapsis,
        m0: o.meanAnomalyAtEpoch,
        period: o.period,
      };
    } else {
      this.orbit = null;
    }
    const lockedPeriod = def.physical.tidallyLocked && def.orbit ? def.orbit.period : 0;
    const period = lockedPeriod || def.physical.rotationPeriod;
    this.spinRate = period ? (Math.PI * 2) / period : 0;
    this.angularVelocityLocal.set(0, this.spinRate, 0);
  }

  get atmosphereTop(): number {
    return this.radius + this.atmosphereHeight;
  }

  /** The zone where the ship switches to the body fixed rotating frame. */
  get nearZoneRadius(): number {
    return this.radius + Math.max(this.atmosphereHeight, this.radius * 0.1);
  }

  /** World -> body fixed direction or vector (rotation only). */
  worldToLocalDir(v: Vector3, out: Vector3): Vector3 {
    return out.copy(v).applyQuaternion(_qInv.copy(this.rotation).invert());
  }
}

const _qInv = new Quaternion();
const _spin = new Quaternion();
const _tmp = new Vector3();

export class Universe {
  readonly system: StarSystemDef;
  readonly bodies: Body[] = [];
  readonly byId = new Map<string, Body>();
  readonly root: Body;
  time = 0;

  constructor(system: StarSystemDef, scale: ScaleProfile = DEFAULT_SCALE) {
    this.system = system;
    const defs = new Map(system.bodies.map((b) => [b.id, b]));
    for (const def of system.bodies) {
      const parentDef = def.parentId ? defs.get(def.parentId) : undefined;
      if (def.parentId && !parentDef) throw new Error(`Body ${def.id}: unknown parent ${def.parentId}`);
      const body = new Body(def, parentDef, scale);
      if (parentDef) {
        const parent = this.byId.get(parentDef.id);
        if (!parent) throw new Error(`Body ${def.id}: parent ${parentDef.id} must come first`);
        body.parent = parent;
        parent.children.push(body);
      }
      this.bodies.push(body);
      this.byId.set(body.id, body);
    }
    const root = this.bodies[0];
    if (!root || root.parent) throw new Error('First body must be the root star');
    this.root = root;
    this.update(0);
  }

  get(id: string): Body {
    const b = this.byId.get(id);
    if (!b) throw new Error(`Unknown body ${id}`);
    return b;
  }

  update(t: number): void {
    this.time = t;
    for (const b of this.bodies) {
      if (b.orbit && b.parent) {
        orbitState(b.orbit, t, b.localPosition, b.localVelocity);
        b.position.copy(b.parent.position).add(b.localPosition);
        b.velocity.copy(b.parent.velocity).add(b.localVelocity);
      } else {
        b.localPosition.set(0, 0, 0);
        b.localVelocity.set(0, 0, 0);
        b.position.set(0, 0, 0);
        b.velocity.set(0, 0, 0);
      }
      this.updateRotation(b, t);
    }
  }

  private updateRotation(b: Body, t: number): void {
    let angle = b.spinRate * t + b.def.seed * 0.618;
    if (b.def.physical.tidallyLocked && b.parent) {
      // Local +X faces the parent.
      _tmp.copy(b.parent.position).sub(b.position).applyQuaternion(_qInv.copy(b.tilt).invert());
      angle = Math.atan2(-_tmp.z, _tmp.x);
    }
    _spin.setFromAxisAngle(Y_AXIS, angle);
    b.rotation.copy(b.tilt).multiply(_spin);
  }

  /** The deepest body whose sphere of influence contains the world position. */
  dominantBody(worldPos: Vector3): Body {
    let best = this.root;
    const visit = (b: Body): void => {
      for (const c of b.children) {
        if (c.position.distanceToSquared(worldPos) < c.soiRadius * c.soiRadius) {
          best = c;
          visit(c);
          return;
        }
      }
    };
    visit(this.root);
    return best;
  }

  /** Smallest distance from the world position to any body's sphere (radius only). */
  nearestSurface(worldPos: Vector3): { body: Body; distance: number } {
    let body = this.root;
    let distance = Infinity;
    for (const b of this.bodies) {
      const d = b.position.distanceTo(worldPos) - b.radius;
      if (d < distance) {
        distance = d;
        body = b;
      }
    }
    return { body, distance };
  }
}
