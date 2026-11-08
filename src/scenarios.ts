import { Vector3 } from 'three';
import type { World, ShipPlacement } from './sim/world';

export interface Scenario {
  description: string;
  apply(world: World): void;
}

const surface = (description: string, p: ShipPlacement): Scenario => ({
  description,
  apply: (w) => w.place(p),
});

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
  'deep-space-warp': {
    description: 'Between Earth and Moon',
    apply: (w) => {
      const moon = w.universe.get('moon');
      w.placeInSpace('earth', moon.orbit!.a * 0.5);
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
