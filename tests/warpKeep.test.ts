import { describe, expect, test } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { emptyInput } from '../src/sim/ship';
import { World } from '../src/sim/world';

function bankDeg(w: World): number {
  const right = new Vector3(1, 0, 0).applyQuaternion(w.ship.quat);
  return (Math.asin(Math.max(-1, Math.min(1, -right.dot(w.env.up)))) * 180) / Math.PI;
}

describe('warp is kept across situations', () => {
  test('a situation cap only holds the warp back; the chosen level returns', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    const earth = w.universe.get('earth');
    w.placeInSpace('earth', earth.radius * 3, new Vector3(1, 0, 0));
    w.clock.warpIndex = w.clock.indexFor(1000);
    w.clock.limitTo(4); // as in an atmosphere
    expect(w.clock.warp).toBe(4);
    w.step(1 / 60, emptyInput());
    expect(w.clock.warpIndex).toBe(w.clock.indexFor(1000));
  });

  test('entering a moon sphere of influence resets the warp to 1x', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    const moon = w.universe.get('moon');
    const earth = w.universe.get('earth');
    const toMoon = moon.position.clone().sub(earth.position).normalize();
    w.placeInSpace('earth', earth.radius * 1.4, toMoon);
    const go = emptyInput();
    go.throttleSet = 1;
    go.boost = true;
    const dir = new Vector3();
    let resetSeen = false;
    for (let t = 0; t < 120 && !resetSeen; t += 1 / 30) {
      if (w.ship.frame.body.id === 'earth') w.clock.warpIndex = w.clock.indexFor(4);
      const before = w.ship.frame.body;
      dir.copy(moon.position).sub(w.shipWorldPos).normalize();
      go.alignDir = w.toFrameDir(dir, new Vector3());
      w.step(1 / 30, go);
      if (before.id === 'earth' && w.ship.frame.body.id === 'moon') {
        expect(w.clock.warpIndex).toBe(0);
        resetSeen = true;
      }
    }
    expect(resetSeen).toBe(true);
  });
});

describe('orbit leveling', () => {
  test('yawing in orbit keeps the wings level when the setting is on', () => {
    const fly = (level: boolean): number => {
      const w = new World(SOLAR_SYSTEM, 0);
      const earth = w.universe.get('earth');
      w.placeInSpace('earth', earth.radius * 2, new Vector3(0, 0, 1));
      w.step(1 / 60, emptyInput());
      // Wings level, nose 40 degrees above the horizon: a plain body axis yaw tilts the horizon.
      const up = w.env.up.clone();
      const side = new Vector3(1, 0, 0).cross(up).normalize();
      const fwd = side.clone().multiplyScalar(Math.cos(0.7)).addScaledVector(up, Math.sin(0.7));
      w.ship.quat.setFromRotationMatrix(new Matrix4().lookAt(new Vector3(), fwd, up));
      w.ship.angVel.set(0, 0, 0);
      expect(Math.abs(bankDeg(w))).toBeLessThan(0.5);
      const yaw = emptyInput();
      yaw.yaw = 1;
      yaw.throttleSet = 0;
      yaw.levelOrbit = level;
      let worst = 0;
      for (let t = 0; t < 3; t += 1 / 60) {
        w.step(1 / 60, yaw);
        worst = Math.max(worst, Math.abs(bankDeg(w)));
      }
      return worst;
    };
    const free = fly(false);
    const level = fly(true);
    expect(free).toBeGreaterThan(20);
    expect(level).toBeLessThan(5);
  });
});
