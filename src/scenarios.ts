import { Vector3 } from 'three';
import { weatherAmount } from './render/weather/weatherMap';
import type { World, ShipPlacement } from './sim/world';
import { latLonToDir } from './terrain/api';

export interface Scenario {
  description: string;
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
  'earth-low-morning': surface('Low over Earth in the morning, Moon up', {
    body: 'earth', lat: 22, localHour: 8.5, altitude: 1500, heading: 70, pitch: 2, throttle: 0.6,
  }),
  'earth-surface-day': surface('Landed on Earth at noon', {
    body: 'earth', lat: 35, localHour: 13, altitude: 0, heading: 0, landed: true,
  }),
  'earth-surface-night': surface('Landed on Earth at night', {
    body: 'earth', lat: 40, localHour: 23, altitude: 0, heading: 180, landed: true,
  }),
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
  'moon-surface-earthrise': {
    description: 'Morning on the Moon near the limb, Earth on the horizon',
    apply: (w) => {
      // Earth hangs over lon 0 (tidal lock). Find a time in the month when lon 82 has a
      // low morning sun, so the ground is lit and Earth sits near the horizon.
      w.place({ body: 'moon', lat: 0, lon: 82, altitude: 0, heading: 270, landed: true, time: findMoonMorning(w, 82, 8.5) });
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
};

/** Sim time when the given Moon longitude has the given local solar hour. */
function findMoonMorning(w: World, lonDeg: number, hour: number): number {
  const moon = w.universe.get('moon');
  const target = ((lonDeg - (hour - 12) * 15) * Math.PI) / 180;
  let best = 0;
  let bestErr = Infinity;
  for (let t = 0; t < moon.orbit!.period; t += 1800) {
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
