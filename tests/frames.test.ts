import { describe, expect, test } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { Universe } from '../src/sim/universe';
import {
  type Frame,
  type KinematicState,
  frameToWorldPos,
  frameToWorldQuat,
  frameToWorldVel,
  transferState,
} from '../src/sim/frames';

const T = 12345;
const REL = 1e-6;

const u = new Universe(SOLAR_SYSTEM);
u.update(T);
const earth = u.get('earth');
const moon = u.get('moon');
const sun = u.get('sun');

function sampleState(): KinematicState {
  return {
    pos: new Vector3(1.2e6, -3.4e5, 7.7e5),
    vel: new Vector3(120, -45.5, 9.25),
    quat: new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.1),
  };
}

function cloneState(s: KinematicState): KinematicState {
  return { pos: s.pos.clone(), vel: s.vel.clone(), quat: s.quat.clone() };
}

/** World-space pos, vel and quat of a state expressed in `f`. */
function toWorld(s: KinematicState, f: Frame): KinematicState {
  return {
    pos: frameToWorldPos(f, s.pos, new Vector3()),
    vel: frameToWorldVel(f, s.pos, s.vel, new Vector3()),
    quat: frameToWorldQuat(f, s.quat, new Quaternion()),
  };
}

function expectVecClose(actual: Vector3, expected: Vector3): void {
  const scale = Math.max(1, expected.length());
  expect(actual.distanceTo(expected) / scale).toBeLessThan(REL);
}

function expectQuatClose(actual: Quaternion, expected: Quaternion): void {
  // q and -q are the same rotation, so compare with |dot|.
  expect(1 - Math.abs(actual.dot(expected))).toBeLessThan(REL);
}

const pairs: Array<[string, Frame, Frame]> = [
  ['{earth, inertial} <-> {earth, rotating}', { body: earth, rotating: false }, { body: earth, rotating: true }],
  ['{earth, inertial} <-> {sun, inertial}', { body: earth, rotating: false }, { body: sun, rotating: false }],
  ['{moon, rotating} <-> {earth, rotating}', { body: moon, rotating: true }, { body: earth, rotating: true }],
];

describe('transferState', () => {
  test.each(pairs)('%s keeps the same world-space state', (_name, a, b) => {
    const start = sampleState();
    const before = toWorld(start, a);

    const s = cloneState(start);
    transferState(s, a, b);
    const after = toWorld(s, b);

    expectVecClose(after.pos, before.pos);
    expectVecClose(after.vel, before.vel);
    expectQuatClose(after.quat, before.quat);
  });

  test.each(pairs)('%s round trip returns the original state', (_name, a, b) => {
    const start = sampleState();
    const s = cloneState(start);
    transferState(s, a, b);
    transferState(s, b, a);

    expectVecClose(s.pos, start.pos);
    expectVecClose(s.vel, start.vel);
    expectQuatClose(s.quat, start.quat);
  });

  test('a point fixed in the rotating frame has world velocity = body velocity + ω × r', () => {
    const frame: Frame = { body: earth, rotating: true };
    const p = new Vector3(4.2e6, -1.1e6, 2.5e6);
    const v = frameToWorldVel(frame, p, new Vector3(), new Vector3());

    // Angular velocity and position in world space.
    const omegaWorld = earth.angularVelocityLocal.clone().applyQuaternion(earth.rotation);
    const rWorld = p.clone().applyQuaternion(earth.rotation);
    const expected = earth.velocity.clone().add(omegaWorld.cross(rWorld));

    expect(v.length()).toBeGreaterThan(0);
    expectVecClose(v, expected);
  });
});
