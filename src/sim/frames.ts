import { Quaternion, Vector3 } from 'three';
import type { Body } from './universe';

/**
 * A reference frame centered on a body. Inertial frames translate with the body; rotating
 * frames also spin with it (body fixed), so terrain and parked ships stay put at any warp.
 */
export interface Frame {
  body: Body;
  rotating: boolean;
}

export interface KinematicState {
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
}

const _w = new Vector3();
const _q = new Quaternion();

export function frameToWorldPos(f: Frame, p: Vector3, out: Vector3): Vector3 {
  out.copy(p);
  if (f.rotating) out.applyQuaternion(f.body.rotation);
  return out.add(f.body.position);
}

export function frameToWorldVel(f: Frame, p: Vector3, v: Vector3, out: Vector3): Vector3 {
  out.copy(v);
  if (f.rotating) {
    _w.copy(f.body.angularVelocityLocal).cross(p);
    out.add(_w).applyQuaternion(f.body.rotation);
  }
  return out.add(f.body.velocity);
}

export function frameToWorldQuat(f: Frame, q: Quaternion, out: Quaternion): Quaternion {
  if (f.rotating) return out.copy(f.body.rotation).multiply(q);
  return out.copy(q);
}

/** Rotates a frame vector (direction) into world space. */
export function frameToWorldDir(f: Frame, d: Vector3, out: Vector3): Vector3 {
  out.copy(d);
  return f.rotating ? out.applyQuaternion(f.body.rotation) : out;
}

export function worldToFramePos(f: Frame, wp: Vector3, out: Vector3): Vector3 {
  out.copy(wp).sub(f.body.position);
  if (f.rotating) out.applyQuaternion(_q.copy(f.body.rotation).invert());
  return out;
}

/** `p` is the position already expressed in the target frame. */
export function worldToFrameVel(f: Frame, p: Vector3, wv: Vector3, out: Vector3): Vector3 {
  out.copy(wv).sub(f.body.velocity);
  if (f.rotating) {
    out.applyQuaternion(_q.copy(f.body.rotation).invert());
    _w.copy(f.body.angularVelocityLocal).cross(p);
    out.sub(_w);
  }
  return out;
}

export function worldToFrameQuat(f: Frame, wq: Quaternion, out: Quaternion): Quaternion {
  if (f.rotating) return out.copy(f.body.rotation).invert().multiply(wq);
  return out.copy(wq);
}

export function worldToFrameDir(f: Frame, d: Vector3, out: Vector3): Vector3 {
  out.copy(d);
  return f.rotating ? out.applyQuaternion(_q.copy(f.body.rotation).invert()) : out;
}

const _wp = new Vector3();
const _wv = new Vector3();
const _wq = new Quaternion();

/** Re-expresses a state from one frame in another without any jump in world space. */
export function transferState(s: KinematicState, from: Frame, to: Frame): void {
  frameToWorldPos(from, s.pos, _wp);
  frameToWorldVel(from, s.pos, s.vel, _wv);
  frameToWorldQuat(from, s.quat, _wq);
  worldToFramePos(to, _wp, s.pos);
  worldToFrameVel(to, s.pos, _wv, s.vel);
  worldToFrameQuat(to, _wq, s.quat);
}
