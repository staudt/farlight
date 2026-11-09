import { Matrix4, Quaternion, Vector3 } from 'three';
import { config } from '../core/config';
import type { StarSystemDef } from '../data/types';
import { FLAT_SAMPLER, type HeightSampler, latLonToDir } from '../terrain/api';
import { SimClock } from './clock';
import {
  type Frame,
  frameToWorldPos,
  frameToWorldQuat,
  frameToWorldVel,
  transferState,
  worldToFrameDir,
} from './frames';
import { type FlightEnv, type FlightInput, Ship } from './ship';
import { Body, Universe } from './universe';
import { allowedWarp, type FlightPhase, timeToNextBoundary } from './warp';

export interface ShipPlacement {
  body: string;
  /** Degrees. */
  lat: number;
  /** Degrees. Ignored when localHour is given. */
  lon?: number;
  /** 0..24 local solar time; places the ship so the sun is where that hour expects it. */
  localHour?: number;
  /** Meters above the terrain. */
  altitude: number;
  /** Degrees from north, clockwise. */
  heading?: number;
  /** Degrees nose up. */
  pitch?: number;
  throttle?: number;
  landed?: boolean;
  /** Sim time to start at. */
  time?: number;
}

export type HeightSamplerProvider = (body: Body) => HeightSampler | null;

/**
 * Owns the simulation: universe on rails, clock, ship and its reference frame.
 * Rendering reads the world space snapshot (shipWorld*) after each step.
 */
export class World {
  readonly universe: Universe;
  readonly clock: SimClock;
  readonly ship: Ship;
  phase: FlightPhase = 'space';
  readonly env: FlightEnv = {
    up: new Vector3(0, 1, 0),
    altitude: Infinity,
    altitudeAhead: Infinity,
    climbDemand: 0,
    density: 0,
    gravity: 0,
    surfaceDistance: Infinity,
    stabilization: 0,
    solidGround: false,
    canLand: false,
  };
  /** Height above the base radius (sea level), for HUD and atmosphere. */
  radialAltitude = Infinity;
  /** 0 outside the atmosphere .. 1 at sea level, linear in height. */
  atmosphereDepth = 0;
  target: Body | null = null;
  /** Set when the auto drop lowered the warp this step. */
  warpDropped = false;
  readonly shipWorldPos = new Vector3();
  readonly shipWorldVel = new Vector3();
  readonly shipWorldQuat = new Quaternion();
  private heightProvider: HeightSamplerProvider = () => null;
  private samplers = new Map<string, HeightSampler>();

  constructor(system: StarSystemDef, startTime = 0) {
    this.universe = new Universe(system);
    this.clock = new SimClock(startTime);
    this.universe.update(startTime);
    const home = this.universe.bodies.find((b) => b.kind === 'rocky') ?? this.universe.root;
    this.ship = new Ship({ body: home, rotating: false });
    this.ship.pos.set(0, 0, home.radius * 3);
    this.updateSnapshot();
  }

  setHeightProvider(p: HeightSamplerProvider): void {
    this.heightProvider = p;
    this.samplers.clear();
  }

  sampler(body: Body): HeightSampler {
    let s = this.samplers.get(body.id);
    if (!s) {
      s = body.kind === 'rocky' ? (this.heightProvider(body) ?? FLAT_SAMPLER) : FLAT_SAMPLER;
      this.samplers.set(body.id, s);
    }
    return s;
  }

  /** Terrain height (game meters above radius) at a body fixed unit direction. */
  groundHeight(body: Body, dir: Vector3): number {
    if (body.kind === 'rocky') return this.sampler(body).heightAt(dir.x, dir.y, dir.z);
    // Gas giants: a soft pressure floor below the cloud tops.
    if (body.kind === 'gas') return -(body.def.gas?.cloudDeckDepth ?? 0.02) * body.radius;
    return 0;
  }

  step(realDt: number, input: FlightInput): void {
    // 1. Warp limit from situation and time to the next boundary.
    const eta = Math.min(
      timeToNextBoundary(this.universe, this.shipWorldPos, this.shipWorldVel),
      this.groundEta(),
    );
    const maxWarp = allowedWarp(this.phase, eta);
    this.warpDropped = this.clock.clampTo(maxWarp);

    // 2. Advance time and bodies.
    const simDt = this.clock.advance(realDt);
    this.universe.update(this.clock.time);

    // 3. Fly.
    this.computeEnv();
    this.ship.update(realDt, simDt, input, this.env);

    // 4. Frame management.
    this.updateFrame();
    this.computeEnv();
    this.updatePhase();
    this.updateSnapshot();
  }

  /**
   * Re-evaluates bodies at the current clock time without moving the ship. The ship keeps its
   * frame coordinates, so in a rotating frame it turns with the planet. Photo mode time scrub.
   */
  refresh(): void {
    this.universe.update(this.clock.time);
    this.computeEnv();
    this.updatePhase();
    this.updateSnapshot();
  }

  private groundEta(): number {
    if (!this.env.solidGround) return Infinity;
    const vr = this.ship.vel.dot(this.env.up);
    return vr < 0 ? Math.max(0, this.env.altitude) / -vr : Infinity;
  }

  private computeEnv(): void {
    const ship = this.ship;
    const body = ship.frame.body;
    const env = this.env;
    const r = ship.pos.length();
    env.up.copy(ship.pos).divideScalar(r || 1);

    const dirLocal = ship.frame.rotating ? _d.copy(env.up) : body.worldToLocalDir(env.up, _d);
    const ground = this.groundHeight(body, dirLocal);
    env.solidGround = body.kind !== 'star';
    env.canLand = body.kind === 'rocky';
    env.altitude = r - body.radius - ground;
    this.radialAltitude = r - body.radius;

    env.altitudeAhead = env.altitude;
    env.climbDemand = 0;
    if (env.solidGround && env.altitude < config.flight.cushionHeight * 10) {
      // Horizontal velocity only: a vertical descent is not "terrain rising ahead".
      _vh.copy(ship.vel).addScaledVector(env.up, -ship.vel.dot(env.up));
      const f = config.flight;
      const clearance = (f.cushionHeight + _vh.length() * f.cushionLead) * 0.5;
      const warp = Math.max(1, this.clock.warp);
      for (const t of f.lookAheadTimes) {
        _p.copy(ship.pos).addScaledVector(_vh, t * warp);
        const rr = _p.length();
        _p.divideScalar(rr);
        const dl = ship.frame.rotating ? _p : body.worldToLocalDir(_p, _d2);
        const alt = rr - body.radius - this.groundHeight(body, dl);
        env.altitudeAhead = Math.min(env.altitudeAhead, alt);
        // Climb rate that clears this sample with room to spare by the time we reach it.
        env.climbDemand = Math.max(env.climbDemand, (clearance - alt) / t);
      }
    }

    const atm = body.def.atmosphere;
    const h = Math.max(0, this.radialAltitude);
    if (atm && h < body.atmosphereHeight) {
      env.density = Math.exp(-h / (atm.scaleHeight * body.atmosphereHeight));
      this.atmosphereDepth = 1 - h / body.atmosphereHeight;
      const s = atm.stabilization ?? 1;
      env.stabilization = s * smoothstep(0, 0.6, this.atmosphereDepth);
    } else {
      env.density = 0;
      this.atmosphereDepth = 0;
      env.stabilization = 0;
    }
    env.gravity = body.surfaceGravity * (body.radius / Math.max(r, body.radius)) ** 2;

    frameToWorldPos(ship.frame, ship.pos, _wp);
    const nearest = this.universe.nearestSurface(_wp);
    env.surfaceDistance = Math.min(nearest.distance, Math.max(0, env.altitude));
  }

  private updateFrame(): void {
    const ship = this.ship;
    frameToWorldPos(ship.frame, ship.pos, _wp);
    const dominant = this.universe.dominantBody(_wp);
    const dist = _wp.distanceTo(dominant.position);
    const sameBody = dominant === ship.frame.body;
    const nearZone = dominant.nearZoneRadius * (sameBody && ship.frame.rotating ? 1.05 : 1.0);
    const rotating = dominant.kind !== 'star' && dist < nearZone;
    if (!sameBody || rotating !== ship.frame.rotating) {
      const to: Frame = { body: dominant, rotating };
      transferState(ship, ship.frame, to);
      ship.frame = to;
    }
  }

  private updatePhase(): void {
    const body = this.ship.frame.body;
    if (this.ship.landed) this.phase = 'landed';
    else if (this.env.density > 0) this.phase = 'atmosphere';
    else if (this.ship.frame.rotating && body.kind !== 'star') this.phase = 'near';
    else this.phase = 'space';
  }

  private updateSnapshot(): void {
    const s = this.ship;
    frameToWorldPos(s.frame, s.pos, this.shipWorldPos);
    frameToWorldVel(s.frame, s.pos, s.vel, this.shipWorldVel);
    frameToWorldQuat(s.frame, s.quat, this.shipWorldQuat);
  }

  /** World direction -> ship frame direction (for align to target). */
  toFrameDir(worldDir: Vector3, out: Vector3): Vector3 {
    return worldToFrameDir(this.ship.frame, worldDir, out);
  }

  /** Puts the ship over a body's surface in its rotating frame. */
  place(p: ShipPlacement): void {
    if (p.time !== undefined) this.clock.time = p.time;
    this.universe.update(this.clock.time);
    const body = this.universe.get(p.body);
    const lat = (p.lat * Math.PI) / 180;
    let lon = ((p.lon ?? 0) * Math.PI) / 180;
    if (p.localHour !== undefined) {
      const sun = this.universe.root;
      const s = body.worldToLocalDir(_d.copy(sun.position).sub(body.position).normalize(), _d2);
      const subSolarLon = Math.atan2(-s.z, s.x);
      lon = subSolarLon + ((p.localHour - 12) / 24) * Math.PI * 2;
    }
    const dir = new Vector3();
    latLonToDir(lat, lon, dir);
    const ground = this.groundHeight(body, dir);
    const r = body.radius + ground + p.altitude;

    const ship = this.ship;
    ship.frame = { body, rotating: true };
    ship.pos.copy(dir).multiplyScalar(r);
    const up = dir;
    const east = new Vector3(-Math.sin(lon), 0, -Math.cos(lon));
    const north = new Vector3().crossVectors(up, east).normalize();
    const heading = ((p.heading ?? 0) * Math.PI) / 180;
    const pitch = ((p.pitch ?? 0) * Math.PI) / 180;
    const flat = north.multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading));
    const fwd = flat.multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();
    _m.lookAt(_zero, fwd, up);
    ship.quat.setFromRotationMatrix(_m);
    ship.throttle = p.throttle ?? (p.landed ? 0 : 0.5);
    ship.landed = p.landed ?? false;
    ship.vel.copy(fwd).multiplyScalar(ship.landed ? 0 : ship.throttle * 100);
    ship.angVel.set(0, 0, 0);
    this.updateFrame();
    this.computeEnv();
    this.updatePhase();
    this.updateSnapshot();
  }

  /** Puts the ship in space at `distance` from a body's center, looking at it. */
  placeInSpace(bodyId: string, distance: number, fromDir = new Vector3(0.3, 0.2, 1)): void {
    this.universe.update(this.clock.time);
    const body = this.universe.get(bodyId);
    const ship = this.ship;
    const dir = fromDir.clone().normalize();
    ship.frame = { body, rotating: false };
    ship.pos.copy(dir).multiplyScalar(distance);
    _m.lookAt(_zero, dir.clone().negate(), new Vector3(0, 1, 0));
    ship.quat.setFromRotationMatrix(_m);
    ship.vel.set(0, 0, 0);
    ship.throttle = 0;
    ship.landed = false;
    this.updateFrame();
    this.computeEnv();
    this.updatePhase();
    this.updateSnapshot();
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const _d = new Vector3();
const _d2 = new Vector3();
const _p = new Vector3();
const _vh = new Vector3();
const _wp = new Vector3();
const _m = new Matrix4();
const _zero = new Vector3();
