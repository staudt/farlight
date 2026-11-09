import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { emptyInput } from '../src/sim/ship';
import { World } from '../src/sim/world';
import { SCENARIOS } from '../src/scenarios';

/** Bank angle (deg) of the ship relative to the local horizon, positive = right wing down. */
function bankDeg(w: World): number {
  const up = w.env.up;
  const right = new Vector3(1, 0, 0).applyQuaternion(w.ship.quat);
  return (Math.asin(Math.max(-1, Math.min(1, -right.dot(up)))) * 180) / Math.PI;
}

function pitchDeg(w: World): number {
  const fwd = new Vector3(0, 0, -1).applyQuaternion(w.ship.quat);
  return (Math.asin(Math.max(-1, Math.min(1, fwd.dot(w.env.up)))) * 180) / Math.PI;
}

function run(w: World, seconds: number, input = emptyInput(), dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) w.step(dt, input);
}

describe('assisted glider flight', () => {
  test('level flight with no input stays level', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    run(w, 20);
    expect(Math.abs(bankDeg(w))).toBeLessThan(3);
    expect(Math.abs(pitchDeg(w))).toBeLessThan(5);
    expect(w.env.altitude).toBeGreaterThan(300);
  });

  test('a banked ship levels itself in the atmosphere', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    const roll = emptyInput();
    roll.roll = 1;
    run(w, 0.5, roll);
    expect(Math.abs(bankDeg(w))).toBeGreaterThan(15);
    run(w, 12);
    expect(Math.abs(bankDeg(w))).toBeLessThan(3);
  });

  test('yaw input banks into the turn (right yaw, right wing down)', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    const yaw = emptyInput();
    yaw.yaw = 1;
    run(w, 4, yaw);
    expect(bankDeg(w)).toBeGreaterThan(10);
  });

  test('a full boost climb reaches space in seconds, not minutes', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    const climb = emptyInput();
    climb.pitch = 1;
    run(w, 1.2, climb);
    const go = emptyInput();
    go.boost = true;
    go.throttleSet = 1;
    let t = 0;
    while (w.phase === 'atmosphere' && t < 120) {
      w.step(1 / 30, go);
      go.throttleSet = null;
      t += 1 / 30;
    }
    expect(w.phase).not.toBe('atmosphere');
    // Feel target: shooting to the sky is quick, but the colour transition is still a moment.
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(40);
  });

  test('throttle to zero near the ground lands softly', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    const down = emptyInput();
    down.throttleSet = 0;
    run(w, 1 / 60, down);
    run(w, 240);
    expect(w.ship.landed).toBe(true);
    expect(w.env.altitude).toBeGreaterThan(0);
  });

  test('landed ship stays put on the rotating planet at high warp', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-surface-day']!.apply(w);
    const p0 = w.ship.pos.clone();
    for (let i = 0; i < 8; i++) w.clock.step(1);
    run(w, 3);
    expect(w.clock.warp).toBeGreaterThan(100);
    expect(w.ship.pos.distanceTo(p0)).toBeLessThan(5);
  });
});
