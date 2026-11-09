import { Vector3 } from 'three';
import { weatherAmount } from './render/weather/weatherMap';
import type { World, ShipPlacement } from './sim/world';
import { latLonToDir } from './terrain/api';
import { pickFocusBody } from './data/generate';
import type { BodyDef } from './data/types';

export interface Scenario {
  description: string;
  /** Works in any system (names no Sol body ids). */
  generic?: boolean;
  apply(world: World): void;
}

/** Sim time (half a year in) when the north pole leans away from the sun. */
const POLAR_NIGHT = 182.6 * 86400;

const surface = (description: string, p: ShipPlacement): Scenario => ({
  description,
  apply: (w) => w.place(p),
});

/** Longitude (degrees) on the day side at `lat` where the weather `kind` is strongest right now. */
/** Finds a daytime spot inside a storm cell: scans latitudes (within the band) and longitudes. */
function stormSpot(w: World, bodyId: string, kind: 'rain' | 'lightning' | 'snow', lats: [number, number]): { lat: number; lon: number } {
  w.universe.update(w.clock.time);
  const body = w.universe.get(bodyId);
  const def = body.def.atmosphere!.weather!.find((d) => d.kind === kind)!;
  const sun = body.worldToLocalDir(w.universe.root.position.clone().sub(body.position).normalize(), new Vector3());
  const d = new Vector3();
  let best = { lat: lats[0], lon: 0 };
  let bestScore = -1;
  for (let lat = lats[0]; lat <= lats[1]; lat += 1.5) {
    for (let lon = -180; lon < 180; lon += 1.5) {
      latLonToDir((lat * Math.PI) / 180, (lon * Math.PI) / 180, d);
      if (d.dot(sun) < 0.3) continue;
      const score = weatherAmount(def, d, w.clock.time, body);
      if (score > bestScore) {
        bestScore = score;
        best = { lat, lon };
      }
    }
  }
  return best;
}

/**
 * Named starting situations. Used by `?scenario=name`, the debug panel and the smoke test.
 * Keep them stable: the smoke test asserts on them.
 */
export const SCENARIOS: Record<string, Scenario> = {
  'earth-low-morning': {
    description: 'Low along the green coast of Portugal in the morning',
    apply: (w) => w.place({ body: 'earth', lat: 39.4, lon: -8.6, altitude: 1500, heading: 330, pitch: 2, throttle: 0.6, time: findLocalHourTime(w, 'earth', -8.6, 8.5) }),
  },
  'earth-surface-day': {
    description: 'Landed in the Kenyan highlands at noon',
    apply: (w) => w.place({ body: 'earth', lat: -0.5, lon: 36.5, altitude: 0, heading: 0, landed: true, time: findLocalHourTime(w, 'earth', 36.5, 13) }),
  },
  'earth-surface-night': {
    description: 'Landed in the Colorado plains at night',
    apply: (w) => w.place({ body: 'earth', lat: 39.5, lon: -104, altitude: 0, heading: 180, landed: true, time: findLocalHourTime(w, 'earth', -104, 23) }),
  },
  'earth-sunset': surface('Gliding over the sea at sunset', {
    body: 'earth', lat: 10, localHour: 18.2, altitude: 900, heading: 270, pitch: 0, throttle: 0.5,
  }),
  'atmo-entry': surface('Diving into Earth from the edge of space', {
    body: 'earth', lat: 5, localHour: 10, altitude: 58000, heading: 90, pitch: -25, throttle: 0.8,
  }),
  'earth-orbit': {
    description: 'High above Earth',
    apply: (w) => {
      const earth = w.universe.get('earth');
      w.placeInSpace('earth', earth.radius * 2.6);
    },
  },
  'earth-orbit-africa': {
    description: 'Orbit over Africa in full daylight, Europe and Arabia in view',
    apply: (w) => faceLatLon(w, 'earth', 5, 20, 2.4),
  },
  'earth-himalaya': surface('Above the foothills, looking north at the Himalaya', {
    body: 'earth', lat: 24, lon: 87, localHour: 10, altitude: 11000, heading: 0, pitch: -12, throttle: 0.4,
  }),
  'earth-orbit-italy': {
    description: 'High over Italy and the Mediterranean',
    apply: (w) => faceLatLon(w, 'earth', 42, 12.5, 1.25),
  },
  'earth-forest-low': {
    description: 'Gliding 300 metres over the boreal forests of Sweden in the morning',
    apply: (w) => w.place({ body: 'earth', lat: 58, lon: 15.5, altitude: 300, heading: 200, pitch: -2, throttle: 0.3, time: findLocalHourTime(w, 'earth', 15.5, 8) }),
  },
  'mars-mesas-low': {
    description: 'Skimming red mesas and boulders over the Martian plains in the morning',
    apply: (w) => w.place({ body: 'mars', lat: -5, lon: 100, altitude: 250, heading: 90, pitch: -1, throttle: 0.3, time: findLocalHourTime(w, 'mars', 100, 9) }),
  },
  'io-crystals-low': {
    description: 'Low over Io among sulfur crystals, Jupiter on the horizon',
    apply: (w) => w.place({ body: 'io', lat: 5, lon: 68, altitude: 200, heading: 270, pitch: 0, throttle: 0.25, time: findLockedMorning(w, 'io', 68, 9) }),
  },
  'mars-canyon': surface('Over the rim of Valles Marineris in the Martian morning', {
    body: 'mars', lat: -8, localHour: 9, altitude: 2500, heading: 270, pitch: -4, throttle: 0.4,
  }),
  'mars-sunset': surface('Blue sunset over the dusty Martian plains', {
    body: 'mars', lat: 20, localHour: 18.3, altitude: 1200, heading: 270, pitch: 0, throttle: 0.4,
  }),
  'venus-clouds': surface('Under the endless yellow clouds of Venus', {
    body: 'venus', lat: 10, localHour: 11, altitude: 3000, heading: 45, pitch: 0, throttle: 0.4,
  }),
  'titan-haze': surface('Gliding through the orange haze of Titan', {
    body: 'titan', lat: 30, localHour: 10, altitude: 2000, heading: 90, pitch: -3, throttle: 0.4,
  }),
  'io-volcanoes': {
    description: 'Low over Io in daylight, Jupiter looming over the horizon',
    apply: (w) => {
      // Jupiter hangs over lon 0 (tidal lock); at lon 68 it sits about 22 degrees up, to the west.
      w.place({ body: 'io', lat: 5, lon: 68, altitude: 3000, heading: 270, pitch: 8, throttle: 0.3, time: findLockedMorning(w, 'io', 68, 9) });
    },
  },
  'moon-surface-earthrise': {
    description: 'Morning on the Moon near the limb, Earth on the horizon',
    apply: (w) => {
      // Earth hangs over lon 0 (tidal lock). Find a time in the month when lon 82 has a
      // low morning sun, so the ground is lit and Earth sits near the horizon.
      w.place({ body: 'moon', lat: 0, lon: 82, altitude: 0, heading: 270, landed: true, time: findLockedMorning(w, 'moon', 82, 8.5) });
    },
  },
  'moon-low-day': surface('Two kilometres over the Moon, low sun, craters in relief', {
    body: 'moon', lat: 5, localHour: 8, altitude: 2000, heading: 0, pitch: -14, throttle: 0.3,
  }),
  'deep-space-warp': {
    description: 'Between Earth and Moon',
    apply: (w) => {
      const moon = w.universe.get('moon');
      w.placeInSpace('earth', moon.orbit!.a * 0.5);
    },
  },
  'earth-aurora-night': surface('Landed under the northern lights', {
    body: 'earth', lat: 58, localHour: 0, altitude: 0, heading: 0, pitch: 24, landed: true, time: POLAR_NIGHT,
  }),
  'earth-aurora-orbit': {
    description: 'Over the north pole on the night side, aurora ring below',
    apply: (w) => {
      w.clock.time = POLAR_NIGHT;
      w.universe.update(w.clock.time);
      const earth = w.universe.get('earth');
      const pole = new Vector3(0, 1, 0).applyQuaternion(earth.rotation);
      const sun = w.universe.root.position.clone().sub(earth.position).normalize();
      const night = sun.clone().negate().addScaledVector(pole, sun.dot(pole)).normalize();
      w.placeInSpace('earth', earth.radius + 1.5e6, pole.multiplyScalar(0.8).addScaledVector(night, 0.6));
    },
  },
  'earth-storm': {
    description: 'Low under the storm clouds, rain and lightning',
    apply: (w) => {
      const spot = stormSpot(w, 'earth', 'lightning', [-30, 30]);
      w.place({ body: 'earth', ...spot, altitude: 1200, heading: 20, pitch: 3, throttle: 0.15 });
    },
  },
  'earth-snow': {
    description: 'Low over the arctic in falling snow',
    apply: (w) => {
      const spot = stormSpot(w, 'earth', 'snow', [62, 76]);
      w.place({ body: 'earth', ...spot, altitude: 700, heading: 90, pitch: 2, throttle: 0.15 });
    },
  },
  'jupiter-orbit': {
    description: 'Day side of Jupiter from 2.5 radii, Great Red Spot in view',
    apply: (w) => faceSpot(w, 'jupiter', 2.5),
  },
  'jupiter-skim': {
    description: 'Three kilometres below the Jupiter cloud tops, flying level through the cloud sea',
    apply: (w) => {
      w.place({
        body: 'jupiter', lat: -12, localHour: 11, altitude: gasAltitude(w, 'jupiter', -3000), heading: 90, pitch: 0, throttle: 0.35,
      });
    },
  },
  'saturn-rings': {
    description: 'Saturn and its rings from 3 radii, just above the ring plane, sun behind',
    apply: (w) => {
      w.universe.update(w.clock.time);
      const saturn = w.universe.get('saturn');
      const pole = new Vector3(0, 1, 0).applyQuaternion(saturn.rotation);
      const sun = w.universe.root.position.clone().sub(saturn.position).normalize();
      const flat = sun.clone().addScaledVector(pole, -sun.dot(pole)).normalize();
      const side = new Vector3().crossVectors(pole, flat);
      // Sun behind the camera: the camera sits on the sun side, a little above the ring plane.
      w.placeInSpace('saturn', saturn.radius * 3, flat.clone().addScaledVector(pole, 0.2).addScaledVector(side, 0.35));
    },
  },
  'saturn-ring-shadow': {
    description: 'Saturn seen from the ring plane side, ring shadow draped across the cloud tops',
    apply: (w) => {
      w.clock.time = sunElevationTime(w, 'saturn', 14);
      w.universe.update(w.clock.time);
      const saturn = w.universe.get('saturn');
      const pole = new Vector3(0, 1, 0).applyQuaternion(saturn.rotation);
      const sun = w.universe.root.position.clone().sub(saturn.position).normalize();
      const flat = sun.clone().addScaledVector(pole, -sun.dot(pole)).normalize();
      const side = new Vector3().crossVectors(pole, flat);
      // The shadow lands on the hemisphere opposite the sun; look at it from a little over that side.
      const sign = sun.dot(pole) >= 0 ? 1 : -1;
      w.placeInSpace('saturn', saturn.radius * 3.2, flat.clone().multiplyScalar(0.85).addScaledVector(side, 0.25).addScaledVector(pole, -0.4 * sign));
    },
  },
  arrival: {
    description: 'Arriving in a system: the most interesting planet from 6 radii, day side, star off to the side',
    generic: true,
    apply: (w) => arrive(w),
  },
  'arrival-low': {
    description: 'Gliding 1.5 km over the most interesting planet, day side',
    generic: true,
    apply: (w) => {
      const focus = focusBody(w);
      const alt = focus.kind === 'gas' ? gasAltitude(w, focus.id, -3000) : 1500;
      w.place({ body: focus.id, lat: 18, localHour: 9.5, altitude: alt, heading: 70, pitch: 2, throttle: 0.35 });
    },
  },
};

/** The most interesting body, or the one named by `?focus=<bodyId>` (handy for looking at a specific world). */
function focusBody(w: World): BodyDef {
  const system = w.universe.system;
  const wanted = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('focus') : null;
  return system.bodies.find((b) => b.id === wanted && b.kind !== 'star') ?? pickFocusBody(system);
}

/** Parks the ship in space on the day side of the best planet, looking at it with the star off to one side. */
function arrive(w: World): void {
  const focus = w.universe.get(focusBody(w).id);
  w.clock.time = 0;
  w.universe.update(0);
  const sun = w.universe.root.position.clone().sub(focus.position).normalize();
  const side = new Vector3().crossVectors(sun, new Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const from = sun.multiplyScalar(Math.cos(0.95)).addScaledVector(side, Math.sin(0.95)).add(new Vector3(0, 0.18, 0));
  w.placeInSpace(focus.id, focus.radius * (focus.def.rings ? 7.5 : 6), from);
}

/** A sim time within the body's year when the sun stands about `deg` degrees off its equatorial plane. */
function sunElevationTime(w: World, bodyId: string, deg: number): number {
  const body = w.universe.get(bodyId);
  const target = (deg * Math.PI) / 180;
  const year = body.orbit?.period ?? 86400 * 365;
  let best = w.clock.time;
  let bestErr = Infinity;
  for (let k = 0; k < 120; k++) {
    const t = (k / 120) * year;
    w.universe.update(t);
    const pole = new Vector3(0, 1, 0).applyQuaternion(body.rotation);
    const el = Math.asin(w.universe.root.position.clone().sub(body.position).normalize().dot(pole));
    const err = Math.abs(Math.abs(el) - target);
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return best;
}

/** Ground-relative (pressure floor relative) altitude of a point `depth` meters from the cloud tops. */
function gasAltitude(w: World, bodyId: string, depthFromTops: number): number {
  const b = w.universe.get(bodyId);
  return depthFromTops + (b.def.gas?.cloudDeckDepth ?? 0.02) * b.radius;
}

/** Puts the camera `radii` out, over the first storm, at the time of day when it faces the sun. */
function faceSpot(w: World, bodyId: string, radii: number): void {
  const body = w.universe.get(bodyId);
  const storm = body.def.gas?.storms?.[0];
  const period = body.def.physical.rotationPeriod;
  const local = new Vector3();
  latLonToDir(storm?.lat ?? 0, storm?.lon ?? 0, local);
  let best = 0;
  let bestScore = -2;
  for (let t = 0; t < period; t += period / 120) {
    w.universe.update(t);
    const dir = local.clone().applyQuaternion(body.rotation);
    const score = dir.dot(w.universe.root.position.clone().sub(body.position).normalize());
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  w.clock.time = best;
  w.universe.update(best);
  const dir = local.clone().applyQuaternion(body.rotation);
  const sun = w.universe.root.position.clone().sub(body.position).normalize();
  const side = new Vector3().crossVectors(dir, sun);
  w.placeInSpace(bodyId, body.radius * radii, dir.addScaledVector(sun, 0.15).addScaledVector(side, 0.5));
}

/** Camera `radii` out above lat/lon (degrees), at the time of day when that spot faces the sun. */
function faceLatLon(w: World, bodyId: string, latDeg: number, lonDeg: number, radii: number): void {
  const body = w.universe.get(bodyId);
  const local = new Vector3();
  latLonToDir((latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180, local);
  const period = body.def.physical.rotationPeriod;
  let best = 0;
  let bestScore = -2;
  for (let t = 0; t < period; t += period / 240) {
    w.universe.update(t);
    const score = local.clone().applyQuaternion(body.rotation).dot(w.universe.root.position.clone().sub(body.position).normalize());
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  w.clock.time = best;
  w.universe.update(best);
  const dir = local.clone().applyQuaternion(body.rotation);
  const sun = w.universe.root.position.clone().sub(body.position).normalize();
  w.placeInSpace(bodyId, body.radius * radii, dir.addScaledVector(sun, 0.25));
}

/** Sim time when a tidally locked moon's longitude has the given local solar hour. */
function findLockedMorning(w: World, bodyId: string, lonDeg: number, hour: number): number {
  return findLocalHourTime(w, bodyId, lonDeg, hour);
}

/**
 * Sim time when a longitude has the given local solar hour. Searches one rotation for spinning
 * bodies, one orbit for tidally locked moons. Lets scenarios name real places on real maps.
 */
function findLocalHourTime(w: World, bodyId: string, lonDeg: number, hour: number): number {
  const moon = w.universe.get(bodyId);
  const locked = moon.def.physical.tidallyLocked && moon.orbit;
  const span = locked ? Math.abs(moon.orbit!.period) : Math.abs(moon.def.physical.rotationPeriod);
  const step = span / 2000;
  const target = ((lonDeg - (hour - 12) * 15) * Math.PI) / 180;
  let best = 0;
  let bestErr = Infinity;
  for (let t = 0; t < span; t += step) {
    w.universe.update(t);
    const s = moon.worldToLocalDir(_dir.copy(w.universe.root.position).sub(moon.position).normalize(), _dir);
    const sub = Math.atan2(-s.z, s.x);
    const err = Math.abs(Math.atan2(Math.sin(sub - target), Math.cos(sub - target)));
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return best;
}

const _dir = new Vector3();

export const DEFAULT_SCENARIO = 'earth-low-morning';
