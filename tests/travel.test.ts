import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { emptyInput } from '../src/sim/ship';
import { World } from '../src/sim/world';
import { SCENARIOS } from '../src/scenarios';

/**
 * Travel time feel targets at 1x time, with full throttle and boost:
 *  - Earth orbit to the Moon in about half a minute.
 *  - Flying across Earth fast enough to reach the night side in a couple of minutes.
 */
function flyTo(w: World, targetId: string, boost: boolean, maxSeconds: number): { seconds: number; minAlt: number } {
  const target = w.universe.get(targetId);
  const go = emptyInput();
  go.throttleSet = 1;
  go.boost = boost;
  const dir = new Vector3();
  const dt = 1 / 30;
  let t = 0;
  let minAlt = Infinity;
  while (t < maxSeconds) {
    dir.copy(target.position).sub(w.shipWorldPos).normalize();
    go.alignDir = w.toFrameDir(dir, new Vector3());
    w.step(dt, go);
    go.throttleSet = null;
    t += dt;
    if (w.ship.frame.body === target) minAlt = Math.min(minAlt, w.env.altitude);
    if (w.ship.frame.body === target && w.ship.frame.rotating) break;
  }
  return { seconds: t, minAlt };
}

describe('travel times', () => {
  test('Earth orbit to the Moon takes about 30 s with boost', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    const moon = w.universe.get('moon');
    const earth = w.universe.get('earth');
    // Start above Earth on the side facing the Moon, pointed at it.
    const toMoon = moon.position.clone().sub(earth.position).normalize();
    w.placeInSpace('earth', earth.radius * 1.4, toMoon.clone().negate().negate());
    const r = flyTo(w, 'moon', true, 120);
    console.log(`moon trip with boost: ${r.seconds.toFixed(1)} s`);
    expect(r.seconds).toBeGreaterThan(15);
    expect(r.seconds).toBeLessThan(45);
    // Arrives without hitting the surface.
    expect(r.minAlt).toBeGreaterThan(0);
  });

  test('without boost the Moon trip is still reasonable', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    const moon = w.universe.get('moon');
    const earth = w.universe.get('earth');
    const toMoon = moon.position.clone().sub(earth.position).normalize();
    w.placeInSpace('earth', earth.radius * 1.4, toMoon);
    const r = flyTo(w, 'moon', false, 300);
    console.log(`moon trip without boost: ${r.seconds.toFixed(1)} s`);
    expect(r.seconds).toBeLessThan(120);
  });

  test('cruising high in the atmosphere with boost reaches the night side in about a minute', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    // Level at 25 km, heading east, no input: the leveling assist follows the curvature.
    w.place({ body: 'earth', lat: 10, localHour: 15, altitude: 25000, heading: 90, pitch: 0, throttle: 1 });
    const start = w.ship.pos.clone().normalize();
    const go = emptyInput();
    go.boost = true;
    const dt = 1 / 30;
    let t = 0;
    let angle = 0;
    let maxAlt = 0;
    // A quarter of the planet: from mid afternoon to dusk and beyond.
    while (t < 240 && angle < Math.PI / 2) {
      w.step(dt, go);
      t += dt;
      angle = start.angleTo(w.ship.pos.clone().normalize());
      maxAlt = Math.max(maxAlt, w.env.altitude);
    }
    console.log(`quarter of Earth at 25 km: ${t.toFixed(1)} s, max altitude ${(maxAlt / 1000).toFixed(1)} km`);
    expect(angle).toBeGreaterThanOrEqual(Math.PI / 2);
    expect(t).toBeLessThan(120);
    expect(w.phase).toBe('atmosphere');
  });

  test('low flight stays scenic: under 1 km/s near the hills even with boost', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    SCENARIOS['earth-low-morning']!.apply(w);
    const go = emptyInput();
    go.boost = true;
    go.throttleSet = 1;
    for (let t = 0; t < 10; t += 1 / 30) {
      w.step(1 / 30, go);
      go.throttleSet = null;
    }
    expect(w.ship.speed).toBeLessThan(1000);
    expect(w.ship.speed).toBeGreaterThan(300);
  });

  test('re-entry heat shows when diving in from space, not when cruising at the cap', () => {
    const cruise = new World(SOLAR_SYSTEM, 0);
    cruise.place({ body: 'earth', lat: 10, localHour: 15, altitude: 25000, heading: 90, pitch: 0, throttle: 1 });
    const go = emptyInput();
    go.boost = true;
    for (let t = 0; t < 20; t += 1 / 30) cruise.step(1 / 30, go);
    expect(cruise.ship.stress).toBeLessThan(0.05);

    const dive = new World(SOLAR_SYSTEM, 0);
    const earth = dive.universe.get('earth');
    dive.placeInSpace('earth', earth.radius * 1.6);
    const down = emptyInput();
    down.throttleSet = 1;
    down.boost = true;
    let peak = 0;
    for (let t = 0; t < 60 && dive.env.altitude > 3000; t += 1 / 30) {
      // Point at the planet centre the whole way down.
      const toCenter = earth.position.clone().sub(dive.shipWorldPos).normalize();
      down.alignDir = dive.toFrameDir(toCenter, toCenter.clone());
      dive.step(1 / 30, down);
      down.throttleSet = null;
      peak = Math.max(peak, dive.ship.stress);
    }
    expect(peak).toBeGreaterThan(0.25);
  });
});
