import { Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { config } from '../../core/config';
import type { World } from '../../sim/world';

/** Replaces the ship camera (photo mode). Sets camera orientation and `worldPos` through `out`. */
export interface CameraOverride {
  shipVisible: boolean;
  fov: number;
  update(world: World, camera: PerspectiveCamera, out: Vector3, realDt: number): void;
}

export type CameraMode = 'chase' | 'cockpit';

/**
 * Third person chase camera (default) and first person cockpit view. Produces a float64
 * camera world position; the Three camera itself stays at the origin (floating origin).
 */
export class ShipCamera {
  mode: CameraMode = 'chase';
  /** Extra field of view in degrees (hyperspace kick). */
  fovExtra = 0;
  readonly worldPos = new Vector3();
  private smoothQuat = new Quaternion();
  private initialized = false;
  /** Free look offsets (radians) while holding the right mouse button. */
  lookYaw = 0;
  lookPitch = 0;
  freeLook = false;
  override: CameraOverride | null = null;

  toggle(): void {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
  }

  update(world: World, camera: PerspectiveCamera, realDt: number): void {
    const c = config.camera;
    if (this.override) {
      this.override.update(world, camera, this.worldPos, realDt);
      camera.position.set(0, 0, 0);
      if (Math.abs(camera.fov - this.override.fov) > 0.01) {
        camera.fov = this.override.fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld(true);
      return;
    }
    const shipQ = world.shipWorldQuat;

    // Radial up in world space, for leveling the view inside an atmosphere.
    const body = world.ship.frame.body;
    _up.copy(world.shipWorldPos).sub(body.position).normalize();

    if (!this.initialized) {
      this.smoothQuat.copy(shipQ);
      this.initialized = true;
    }

    // Target orientation: ship orientation with its up blended toward the horizon up.
    _fwd.set(0, 0, -1).applyQuaternion(shipQ);
    _shipUp.set(0, 1, 0).applyQuaternion(shipQ);
    const blend = c.horizonUpBlend * Math.min(1, world.atmosphereDepth * 3) * (this.mode === 'chase' ? 1 : 0.0);
    _targetUp.copy(_shipUp).lerp(_up, blend).normalize();
    _m.lookAt(_zero, _fwd, _targetUp);
    _targetQ.setFromRotationMatrix(_m);

    if (this.mode === 'chase') {
      const k = 1 - Math.exp(-realDt / c.rotationLag);
      this.smoothQuat.slerp(_targetQ, k);
    } else {
      this.smoothQuat.copy(shipQ);
    }

    // Free look decays back to center when released.
    if (!this.freeLook) {
      const k = 1 - Math.exp(-realDt / 0.35);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    }
    _look.setFromAxisAngle(_Y, this.lookYaw);
    _look2.setFromAxisAngle(_X, this.lookPitch);
    _viewQ.copy(this.smoothQuat).multiply(_look).multiply(_look2);

    const speedFrac = world.ship.speedCap > 0 ? Math.min(1, world.ship.speed / world.ship.speedCap) : 0;
    if (this.mode === 'chase') {
      const dist = c.chaseDistance * (1 + 0.15 * speedFrac);
      _off.set(0, c.chaseHeight, dist).applyQuaternion(_viewQ);
      this.worldPos.copy(world.shipWorldPos).add(_off);
      // Aim slightly above the ship so it sits in the lower part of the frame.
      _aim.set(0, c.lookAheadHeight, 0).applyQuaternion(_viewQ).add(world.shipWorldPos).sub(this.worldPos);
      _viewUp.set(0, 1, 0).applyQuaternion(_viewQ);
      _m.lookAt(_zero, _aim, _viewUp);
      camera.quaternion.setFromRotationMatrix(_m);
    } else {
      const o = c.cockpitOffset;
      _off.set(o[0], o[1], o[2]).applyQuaternion(shipQ);
      this.worldPos.copy(world.shipWorldPos).add(_off);
      camera.quaternion.copy(_viewQ);
    }
    camera.position.set(0, 0, 0);

    const boost = world.ship.boosting ? 1 : 0;
    const fov = c.fov + c.fovBoost * (0.4 * speedFrac + 0.6 * boost * speedFrac) + this.fovExtra;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-realDt / 0.5));
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }
}

const _up = new Vector3();
const _fwd = new Vector3();
const _shipUp = new Vector3();
const _targetUp = new Vector3();
const _targetQ = new Quaternion();
const _viewQ = new Quaternion();
const _look = new Quaternion();
const _look2 = new Quaternion();
const _off = new Vector3();
const _aim = new Vector3();
const _viewUp = new Vector3();
const _m = new Matrix4();
const _zero = new Vector3();
const _X = new Vector3(1, 0, 0);
const _Y = new Vector3(0, 1, 0);
