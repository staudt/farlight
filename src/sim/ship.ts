import { Matrix4, Quaternion, Vector3 } from 'three';
import { config } from '../core/config';
import type { Frame } from './frames';

/** Player intent for one frame. Axes are -1..1. */
export interface FlightInput {
  pitch: number;
  yaw: number;
  roll: number;
  /** -1..1 change of the throttle setting per second (scaled by throttleRate). */
  throttleDelta: number;
  /** Absolute throttle set this frame (number keys), or null. */
  throttleSet: number | null;
  boost: boolean;
  brake: boolean;
  /** Direction to align the nose to, in FRAME coordinates, or null. */
  alignDir: Vector3 | null;
}

export function emptyInput(): FlightInput {
  return { pitch: 0, yaw: 0, roll: 0, throttleDelta: 0, throttleSet: null, boost: false, brake: false, alignDir: null };
}

/** Everything the flight model needs to know about the surroundings, in frame coordinates. */
export interface FlightEnv {
  /** Unit radial up from the frame body's center. */
  up: Vector3;
  /** Height above the terrain under the ship. */
  altitude: number;
  /** Height above the terrain a little ahead of the ship (min of samples). */
  altitudeAhead: number;
  /** 0..1 air density relative to sea level. */
  density: number;
  /** m/s^2 */
  gravity: number;
  /** Distance to the nearest surface of any body, drives the speed cap. */
  surfaceDistance: number;
  /** Per body leveling strength 0..1. */
  stabilization: number;
  /** True when a solid surface exists below (false for gas giants and stars). */
  solidGround: boolean;
}

const FORWARD = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);

/** Ship convention: forward is -Z, up is +Y, right is +X (same as a Three camera). */
export class Ship {
  frame: Frame;
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly quat = new Quaternion();
  /** Smoothed angular velocity in ship local axes (pitch about X, yaw about Y, roll about Z). */
  readonly angVel = new Vector3();
  throttle = 0.4;
  boosting = false;
  landed = false;
  /** Speed cap used this step (for HUD and effects). */
  speedCap = 0;
  /** 0..1 how hard the air is fighting the ship (entry heat, buffeting). */
  stress = 0;

  constructor(frame: Frame) {
    this.frame = frame;
  }

  forward(out: Vector3): Vector3 {
    return out.copy(FORWARD).applyQuaternion(this.quat);
  }

  upDir(out: Vector3): Vector3 {
    return out.copy(UP).applyQuaternion(this.quat);
  }

  rightDir(out: Vector3): Vector3 {
    return out.copy(RIGHT).applyQuaternion(this.quat);
  }

  get speed(): number {
    return this.vel.length();
  }

  computeSpeedCap(env: FlightEnv): number {
    const f = config.flight;
    const base = Math.min(f.maxSpeedCap, Math.max(f.minSpeedCap, env.surfaceDistance / f.impactTime));
    return base * (this.boosting ? f.boostMultiplier : 1);
  }

  /**
   * Advances the ship. Rotation uses real time (steering feels the same at any warp);
   * translation uses sim time.
   */
  update(realDt: number, simDt: number, input: FlightInput, env: FlightEnv): void {
    const f = config.flight;
    if (!(realDt > 0)) return;
    this.boosting = input.boost;

    // Throttle
    if (input.throttleSet !== null) this.throttle = input.throttleSet;
    this.throttle += input.throttleDelta * f.throttleRate * realDt;
    if (input.brake) this.throttle -= 2 * realDt;
    this.throttle = Math.min(1, Math.max(0, this.throttle));

    if (this.landed) {
      this.updateLanded(realDt, env);
      return;
    }

    this.updateRotation(realDt, input, env);

    // Translation, substepped when inside air so the cushion and drag stay stable.
    const steps = env.density > 0.001 || env.altitude < f.cushionHeight * 4 ? Math.min(16, Math.ceil(simDt / 0.05)) : 1;
    const dt = simDt / Math.max(1, steps);
    for (let i = 0; i < steps; i++) this.integrate(dt, env);
  }

  private updateRotation(realDt: number, input: FlightInput, env: FlightEnv): void {
    const f = config.flight;
    const air = env.stabilization;

    const target = _v1.set(input.pitch * f.pitchRate, -input.yaw * f.yawRate, -input.roll * f.rollRate);

    if (air > 0) {
      const fwd = this.forward(_v2);
      const right = this.rightDir(_v3);
      // Roll toward the horizon, banking into yaw turns like a glider.
      const levelRight = _v4.copy(fwd).cross(env.up);
      if (levelRight.lengthSq() > 1e-6) {
        levelRight.normalize();
        let rollErr = Math.atan2(-right.dot(env.up), right.dot(levelRight));
        rollErr += -input.yaw * f.bankAngle;
        const rollAssist = (1 - Math.min(1, Math.abs(input.roll))) * air;
        target.z += clamp(rollErr * 1.5, -f.levelRollRate, f.levelRollRate) * rollAssist;
      }
      // Pitch: only near level flight drifts to level.
      const pitchAngle = Math.asin(clamp(fwd.dot(env.up), -1, 1));
      if (Math.abs(pitchAngle) < f.levelPitchWindow) {
        const pitchAssist = (1 - Math.min(1, Math.abs(input.pitch))) * air;
        target.x += clamp(-pitchAngle * 0.8, -f.levelPitchRate, f.levelPitchRate) * pitchAssist;
      }
    }

    if (input.alignDir) {
      const fwd = this.forward(_v2);
      const axisWorld = _v4.copy(fwd).cross(input.alignDir);
      const angle = Math.atan2(axisWorld.length(), fwd.dot(input.alignDir));
      if (axisWorld.lengthSq() > 1e-10) {
        const axisLocal = axisWorld.normalize().applyQuaternion(_q1.copy(this.quat).invert());
        const rate = Math.min(f.alignRate, angle * 2);
        target.addScaledVector(axisLocal, rate);
      }
    }

    const k = 1 - Math.exp(-realDt / f.angularTau);
    this.angVel.lerp(target, k);
    const w = this.angVel.length();
    if (w > 1e-9) {
      _q1.setFromAxisAngle(_v2.copy(this.angVel).divideScalar(w), w * realDt);
      this.quat.multiply(_q1).normalize();
    }
  }

  private integrate(dt: number, env: FlightEnv): void {
    const f = config.flight;
    this.speedCap = this.computeSpeedCap(env);
    const targetSpeed = this.throttle * this.speedCap;
    const fwd = this.forward(_v2);

    // Velocity eases toward the nose direction at the target speed (assisted glider).
    const k = 1 - Math.exp(-dt / f.accelTau);
    _v1.copy(fwd).multiplyScalar(targetSpeed);
    this.vel.lerp(_v1, k);

    // Soft gravity: wings support the ship once fast enough.
    if (env.density > 0.001 && env.solidGround) {
      const speed = this.vel.length();
      const unsupported = Math.pow(Math.max(0, 1 - speed / f.liftSpeed), 2);
      this.vel.addScaledVector(env.up, -env.gravity * unsupported * Math.min(1, env.density * 4) * dt);
    }

    // Air stress for effects: fast ships in dense air glow and shake.
    const dyn = env.density * this.vel.lengthSq();
    this.stress = clamp(dyn / 4.0e6, 0, 1);

    // Ground cushion: descent rate shrinks with height so the ship never hits the ground.
    if (env.solidGround) {
      const alt = Math.min(env.altitude, env.altitudeAhead);
      if (alt < f.cushionHeight) {
        const vr = this.vel.dot(env.up);
        const maxDescent = Math.max(0, alt - f.gearHeight) * 0.9 + 1.5;
        if (vr < -maxDescent) this.vel.addScaledVector(env.up, -vr - maxDescent);
        // Terrain rising ahead: lift the ship over it.
        if (env.altitudeAhead < env.altitude && env.altitudeAhead < f.cushionHeight * 0.5) {
          const lift = (f.cushionHeight * 0.5 - env.altitudeAhead) * 0.5;
          if (vr < lift) this.vel.addScaledVector(env.up, (lift - Math.max(vr, 0)) * Math.min(1, dt * 4));
        }
      }
    }

    this.pos.addScaledVector(this.vel, dt);

    if (env.solidGround) {
      // Hard floor: the env altitude is from before the move, so correct by the radial change.
      const climbed = this.vel.dot(env.up) * dt;
      const altNow = env.altitude + climbed;
      if (altNow < f.gearHeight) {
        this.pos.addScaledVector(env.up, f.gearHeight - altNow);
        const vr = this.vel.dot(env.up);
        if (vr < 0) this.vel.addScaledVector(env.up, -vr);
      }
      if (altNow < f.gearHeight + 2 && this.vel.length() < f.landSpeed && this.throttle < 0.05) {
        this.landed = true;
        this.vel.set(0, 0, 0);
        this.angVel.set(0, 0, 0);
      }
    }
  }

  private updateLanded(realDt: number, env: FlightEnv): void {
    // Settle: align ship up with the local up, keeping heading.
    const fwd = this.forward(_v2);
    const flatFwd = fwd.addScaledVector(env.up, -fwd.dot(env.up));
    if (flatFwd.lengthSq() > 1e-8) {
      flatFwd.normalize();
      _m4.lookAt(_ZERO, flatFwd, env.up);
      _q1.setFromRotationMatrix(_m4);
      const k = 1 - Math.exp(-realDt / 0.8);
      this.quat.slerp(_q1, k);
    }
    // Rest on the gear.
    const err = config.flight.gearHeight - env.altitude;
    if (Math.abs(err) > 0.01) this.pos.addScaledVector(env.up, err * Math.min(1, realDt * 5));
    if (this.throttle > 0.06) {
      this.landed = false;
      this.vel.copy(env.up).multiplyScalar(8);
    }
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _m4 = new Matrix4();
const _ZERO = new Vector3();
