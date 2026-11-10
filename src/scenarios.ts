import { Matrix4, Quaternion, Vector3 } from 'three';
import { weatherAmount } from './render/weather/weatherMap';
import { cloudCoverage } from './render/clouds/coverage';
import { biomeNameAt } from './terrain/biomes';
import { makeSample, type TerrainSampler } from './terrain/heightfield';
import type { World, ShipPlacement } from './sim/world';
import type { Body } from './sim/universe';
import { dirToLatLon, latLonToDir } from './terrain/api';
import { devilSites, geyserSites } from './render/weather/plumes';
import { pickFocusBody } from './data/generate';
import { DEFAULT_SCALE } from './data/scale';
import {
  ROCK_LEVELS,
  type Rock,
  cometActivity,
  cometState,
  cometTails,
  rockInCell,
  scaleBelts,
  scaleComets,
  skyFocusDir,
} from './render/space/spaceData';
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
function stormSpot(w: World, bodyId: string, kind: 'rain' | 'lightning' | 'snow' | 'acidRain' | 'methaneRain', lats: [number, number]): { lat: number; lon: number } {
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
  'cockpit-earth': {
    description: 'Cockpit view low over the Portuguese coast in the morning',
    apply: (w) => w.place({ body: 'earth', lat: 38.7, lon: -9.4, altitude: 700, heading: 20, pitch: 0, throttle: 0.55, time: findLocalHourTime(w, 'earth', -9.4, 8.5) }),
  },
  'cockpit-night': {
    description: 'Cockpit view low over dark land at night',
    apply: (w) => w.place({ body: 'earth', lat: 39.5, lon: -104, altitude: 800, heading: 90, pitch: 0, throttle: 0.5, time: findLocalHourTime(w, 'earth', -104, 23.5) }),
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
  'mars-orbit': {
    description: 'Day side of red Mars from orbit, Valles Marineris in view',
    apply: (w) => faceLatLon(w, 'mars', -8, -70, 2.6),
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
  'venus-acid-rain': {
    description: 'Under the Venusian clouds in sulphur rain that dries up before the ground',
    apply: (w) => {
      const spot = stormSpot(w, 'venus', 'acidRain', [-30, 30]);
      w.place({ body: 'venus', ...spot, altitude: 4200, heading: 20, pitch: 2, throttle: 0.1 });
    },
  },
  'mercury-dayside': surface('Low over the baking grey surface of Mercury, the huge white sun ahead', {
    body: 'mercury', lat: 5, localHour: 16.8, altitude: 450, heading: 270, pitch: 5, throttle: 0.15,
  }),
  'io-plumes-orbit': {
    description: 'Low orbit over Io with a volcanic plume rising on the limb',
    apply: (w) => limbView(w, 'io', 18.7, -105, 2.1, 62, 0.22),
  },
  'europa-geysers': {
    description: 'Low over Europa as water vapour geysers jet from the ice',
    apply: (w) => {
      const body = w.universe.get('europa');
      const site = geyserSites(body.def.seed, 6)[0]!;
      const { lat, lon } = dirToLatLon(site.dir.x, site.dir.y, site.dir.z);
      limbView(w, 'europa', (lat * 180) / Math.PI, (lon * 180) / Math.PI, 1.3, 32, 0.08);
    },
  },
  'mars-dust-devils': {
    description: 'Low over the Martian plains as dust devils twist across the ground',
    apply: (w) => {
      w.place({ body: 'mars', lat: -5, localHour: 13.5, altitude: 260, heading: 90, pitch: 1, throttle: 0.05 });
      aimAt(w, (body, local, t) => devilSites(body.radius, local, t).find((c) => c.d > 900)?.dir ?? null, null);
    },
  },
  'titan-rain': {
    description: 'Fat slow drops of methane rain falling through the orange haze of Titan',
    apply: (w) => {
      const spot = stormSpot(w, 'titan', 'methaneRain', [-40, 40]);
      w.place({ body: 'titan', ...spot, altitude: 700, heading: 60, pitch: 0, throttle: 0.05 });
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
    description: 'Gliding low over a scenic spot on the most interesting planet: day side, below the clouds, with relief ahead',
    generic: true,
    apply: (w) => {
      const focus = focusBody(w);
      if (focus.kind === 'gas') {
        w.place({ body: focus.id, lat: 18, localHour: 9.5, altitude: gasAltitude(w, focus.id, -3000), heading: 70, pitch: 2, throttle: 0.35 });
        return;
      }
      const spot = scenicSpot(w, focus.id);
      w.place({ body: focus.id, lat: spot.lat, lon: spot.lon, altitude: spot.altitude, heading: spot.heading, pitch: 1, throttle: 0.3, time: 0 });
    },
  },
  'asteroid-belt': {
    description: 'Inside the main belt: rocks tumbling by, a big one ahead, the sun behind',
    generic: true,
    apply: (w) => amongRocks(w),
  },
  'comet-flyby': {
    description: 'Beside a comet near the star: glowing coma, a straight blue ion tail and a curved dust tail',
    generic: true,
    apply: (w) => cometFlyby(w),
  },
  'earth-comet-sky': {
    description: 'High over Earth at night, a bright comet with its tails among the stars',
    apply: (w) => earthCometSky(w),
  },
  'binary-sunset': {
    description: 'Low over the focus world at sunset, a second sun close to the first',
    generic: true,
    apply: (w) => binarySunset(w),
  },
  'nebula-space': {
    description: 'Deep in space, far from the star, looking into the hero nebula',
    generic: true,
    apply: (w) => nebulaSpace(w),
  },
};

/** The most interesting body, or the one named by `?focus=<bodyId>` (handy for looking at a specific world). */
function focusBody(w: World): BodyDef {
  const system = w.universe.system;
  const wanted = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('focus') : null;
  return system.bodies.find((b) => b.id === wanted && b.kind !== 'star') ?? pickFocusBody(system);
}

/** Biomes that make a dull backdrop unless the planet has nothing else. */
const DULL_BIOME = /^(lava|caldera|ice|snow|rock|crevasse|cooled|highlands|rim|dust|basalt|dark|maria|floor|shadowed|cracks|volcanic|white|tundra)/;

/** Biomes worth flying over: molten channels, cracks and calderas, crystal fields, lush ground. */
const FEATURE_BIOME = /lava|caldera|crack|crystal|forest|meadow|beach/;

const DEG2RAD = Math.PI / 180;

/**
 * Parks the ship in space on the day side of the best planet. The planet sits up and to one side
 * (rule of thirds), the star is in frame near the other edge, and a moon is framed if there is one.
 */
function arrive(w: World): void {
  const focus = w.universe.get(focusBody(w).id);
  w.clock.time = 0;
  w.universe.update(0);
  const sun = w.universe.root.position.clone().sub(focus.position).normalize();
  const side = new Vector3().crossVectors(sun, new Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const up = new Vector3().crossVectors(side, sun).normalize();
  const dist = focus.radius * (focus.def.rings ? 7.5 : focus.kind === 'gas' ? 6 : 5);
  const moons = w.universe.system.bodies.filter((b) => b.parentId === focus.id).map((b) => w.universe.get(b.id).position.clone().sub(focus.position));

  const view = new Matrix4();
  const best = { score: -Infinity, from: new Vector3(), quat: new Quaternion() };
  const from = new Vector3();
  const q = new Quaternion();
  const rot = new Quaternion();
  const planetAng = Math.asin(Math.min(1, focus.radius / dist));
  for (const A of [58, 66, 74]) {
    for (let phi = 0; phi < 360; phi += 15) {
      from.copy(sun).multiplyScalar(-Math.cos(A * DEG2RAD)).addScaledVector(side, Math.sin(A * DEG2RAD) * Math.cos(phi * DEG2RAD)).addScaledVector(up, Math.sin(A * DEG2RAD) * Math.sin(phi * DEG2RAD)).normalize();
      for (const yaw of [22, -22]) {
        view.lookAt(new Vector3(), from.clone().negate(), new Vector3(0, 1, 0));
        q.setFromRotationMatrix(view);
        q.multiply(rot.setFromAxisAngle(new Vector3(0, 1, 0), yaw * DEG2RAD));
        q.multiply(rot.setFromAxisAngle(new Vector3(1, 0, 0), -8 * DEG2RAD));
        const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
        let score = 0;
        const starAng = Math.acos(Math.min(1, Math.max(-1, fwd.dot(sun))));
        score += starAng < 46 * DEG2RAD ? 3 : -(starAng - 46 * DEG2RAD) * 4;
        // Star left of centre when the planet is right, and the other way round.
        const right = new Vector3(1, 0, 0).applyQuaternion(q);
        if (Math.sign(sun.dot(right)) === Math.sign(yaw)) score -= 3;
        score += Math.min(0.4, Math.max(-0.4, from.y)) * 2;
        const cam = from.clone().multiplyScalar(dist);
        for (const m of moons) {
          const md = m.clone().sub(cam).normalize();
          const toPlanet = from.clone().negate();
          const sep = Math.acos(Math.min(1, md.dot(toPlanet)));
          const off = Math.acos(Math.min(1, md.dot(fwd)));
          if (off < 36 * DEG2RAD && sep > planetAng * 1.3) score += 2.5;
        }
        if (score > best.score) {
          best.score = score;
          best.from.copy(from);
          best.quat.copy(q);
        }
      }
    }
  }
  w.placeInSpace(focus.id, dist, best.from);
  w.ship.quat.copy(best.quat);
}

interface Scenic {
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
}

/**
 * Looks for a good low flight start on the day side: sun well up but low enough for shadows,
 * below the cloud base, on land in an interesting biome (or at a coast), with relief ahead.
 * Falls back to anything lit when the planet is dull everywhere.
 */
function scenicSpot(w: World, bodyId: string): Scenic {
  w.clock.time = 0;
  w.universe.update(0);
  const body = w.universe.get(bodyId);
  const sampler = w.sampler(body) as Partial<TerrainSampler>;
  const terrain = body.def.terrain;
  const clouds = body.def.atmosphere?.clouds;
  const sun = body.worldToLocalDir(w.universe.root.position.clone().sub(body.position).normalize(), new Vector3());
  const dir = new Vector3();
  const smp = makeSample();
  const hasSample = typeof sampler.sample === 'function' && terrain !== undefined;
  const biomeAt = (d: { x: number; y: number; z: number }): { name: string; water: boolean; h: number; n: number } => {
    if (!hasSample) return { name: '', water: false, n: 0, h: w.groundHeight(body, _dir.set(d.x, d.y, d.z)) };
    sampler.sample!(d.x, d.y, d.z, smp);
    return { name: biomeNameAt(terrain!, smp, 0.1), water: smp.water, n: smp.n, h: smp.height };
  };
  const cover = (d: Vector3): number => (clouds ? cloudCoverage(clouds, body.radius, body.atmosphereHeight, d, 0) : 0);

  interface Cand {
    lat: number;
    lon: number;
    score: number;
    dull: boolean;
  }
  const coarse: Cand[] = [];
  const nbr = new Vector3();
  const nrth = new Vector3();
  const est = new Vector3();
  // Stay out of the rock and snow zone of the highest ground unless the planet has nothing else.
  for (const maxN of [0.4, 0.7, 9]) {
    coarse.length = 0;
    for (let lat = -48; lat <= 48; lat += 4) {
      for (let lon = -180; lon < 180; lon += 4) {
        latLonToDir(lat * DEG2RAD, lon * DEG2RAD, dir);
        const elev = Math.asin(Math.min(1, Math.max(-1, dir.dot(sun)))) / DEG2RAD;
        if (elev < 14 || elev > 55) continue;
        const b = biomeAt(dir);
        if (b.water || b.n > maxN) continue;
        const c = cover(dir);
        if (c > 0.75) continue;
        let score = 3 - Math.abs(elev - 30) / 15 - c * 2;
        score += DULL_BIOME.test(b.name) ? 0 : 2;
        // Glowing or lush ground a few kilometres out counts too (thin lava channels, coasts).
        for (let k = 0; k < 4; k++) {
          const az = k * (Math.PI / 2) + 0.4;
          const t = 4000 / body.radius;
          const nb = biomeAt(
            nbr.copy(dir).addScaledVector(nrth.set(0, 1, 0).addScaledVector(dir, -dir.y).normalize(), Math.cos(az) * t).addScaledVector(est.crossVectors(nrth, dir), Math.sin(az) * t).normalize(),
          );
          if (nb.water) score += 0.3;
          else if (FEATURE_BIOME.test(nb.name)) score += 1.2;
        }
        coarse.push({ lat, lon, score, dull: DULL_BIOME.test(b.name) });
      }
    }
    if (coarse.length >= 3) break;
  }
  // Only fall back to dull ground when the planet has little else.
  const lush = coarse.filter((c) => !c.dull);
  if (lush.length >= 3) coarse.splice(0, coarse.length, ...lush);
  coarse.sort((a, b) => b.score - a.score);
  // Keep the best few, spread out so one patch does not take every slot.
  const picks: Cand[] = [];
  for (const c of coarse) {
    if (picks.every((p) => Math.hypot(p.lat - c.lat, (p.lon - c.lon) * Math.cos(c.lat * DEG2RAD)) > 10)) picks.push(c);
    if (picks.length >= 30) break;
  }
  if (picks.length === 0) return { lat: 18, lon: -20, altitude: 1500, heading: 70 };

  const east = new Vector3();
  const north = new Vector3();
  const ring = new Vector3();
  let best: Scenic = { lat: picks[0]!.lat, lon: picks[0]!.lon, altitude: 1500, heading: 70 };
  let bestScore = -Infinity;
  const cloudBase = clouds ? clouds.altitude * body.atmosphereHeight : Infinity;
  for (const c of picks) {
    latLonToDir(c.lat * DEG2RAD, c.lon * DEG2RAD, dir);
    east.set(-Math.sin(c.lon * DEG2RAD), 0, -Math.cos(c.lon * DEG2RAD));
    north.crossVectors(dir, east).normalize();
    let hMin = Infinity;
    let hMax = -Infinity;
    let water = 0;
    let featNear = 0;
    const names = new Set<string>();
    let bestHeading = 70;
    let bestH = -Infinity;
    for (const km of [2500, 6000, 12000]) {
      for (let k = 0; k < 8; k++) {
        const az = (k / 8) * Math.PI * 2;
        const t = km / body.radius;
        ring.copy(dir).addScaledVector(north, Math.cos(az) * t).addScaledVector(east, Math.sin(az) * t).normalize();
        const b = biomeAt(ring);
        hMin = Math.min(hMin, b.h);
        hMax = Math.max(hMax, b.h);
        if (b.water) water++;
        else {
          names.add(b.name);
          if (km <= 6000 && FEATURE_BIOME.test(b.name)) featNear++;
        }
        const view = b.h / Math.max(1, sampler.amplitudeMeters ?? 1000) + (FEATURE_BIOME.test(b.name) ? 1.5 : 0) + (b.water ? 0.8 : 0);
        if (km === 6000 && view > bestH) {
          bestH = view;
          bestHeading = (Math.atan2(Math.sin(az), Math.cos(az)) / DEG2RAD + 360) % 360;
        }
      }
    }
    const here = biomeAt(dir);
    const relief = hMax - hMin;
    let score = c.score;
    score += Math.min(1, relief / Math.max(1, (sampler.amplitudeMeters ?? relief) * 0.6)) * 2;
    score += Math.min(3, names.size) * 0.5;
    for (const n of names) if (FEATURE_BIOME.test(n)) score += 1;
    score += Math.min(4, featNear * 0.5);
    if (FEATURE_BIOME.test(here.name) && !DULL_BIOME.test(here.name)) score += 1;
    if (water > 0 && water < 12) score += 1.5;
    if (relief > (sampler.amplitudeMeters ?? 1e9) * 0.9) score -= 1;
    if (DULL_BIOME.test(here.name)) score -= 2;
    // Never start inside a molten sea: it floods the view with one flat colour.
    if (/^(lava|caldera)/.test(here.name)) score -= 8;
    if (score > bestScore) {
      bestScore = score;
      // Fly low enough to stay under the cloud base, and well above the local ridge tops.
      const altitude = Math.min(1500, Math.max(250, cloudBase * 0.5, 0.35 * relief + 250));
      best = { lat: c.lat, lon: c.lon, altitude: Math.min(altitude, Math.max(300, cloudBase * 0.6)), heading: bestHeading };
    }
  }
  return best;
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

/**
 * Turns the ship toward a surface point of the body it is near (body fixed unit direction from
 * `pick`), looking `lift` meters above the ground there. Does nothing if `pick` finds none.
 */
function aimAt(w: World, pick: (body: Body, local: Vector3, t: number) => Vector3 | null, lift: number | null): void {
  const ship = w.ship;
  const body = ship.frame.body;
  const rot = ship.frame.rotating;
  const here = ship.pos.clone().normalize();
  const local = rot ? here : body.worldToLocalDir(here, new Vector3());
  const dir = pick(body, local, w.clock.time);
  if (!dir) return;
  // `null`: look level, at the ship's own height (ground height varies a lot on rough worlds).
  const target = dir.clone().multiplyScalar(lift === null ? ship.pos.length() - 120 : body.radius + lift);
  if (!rot) target.applyQuaternion(body.rotation);
  const fwd = target.sub(ship.pos).normalize();
  const m = new Matrix4().lookAt(new Vector3(), fwd, ship.pos.clone().normalize());
  ship.quat.setFromRotationMatrix(m);
}

/**
 * Camera `radii` out, `offsetDeg` away from lat/lon toward the sun side, so the spot sits near the
 * limb and tall things on it stand against the sky. Picks the time when the spot faces the sun.
 */
function limbView(w: World, bodyId: string, latDeg: number, lonDeg: number, radii: number, offsetDeg: number, lift = 0.1): void {
  const body = w.universe.get(bodyId);
  const local = new Vector3();
  latLonToDir((latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180, local);
  const locked = body.def.physical.tidallyLocked && body.orbit;
  const period = Math.abs(locked ? body.orbit!.period : body.def.physical.rotationPeriod);
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
  // Sideways from the spot, perpendicular to it, leaning away from the sun's direction a little.
  const side = new Vector3().crossVectors(dir, sun);
  if (side.lengthSq() < 1e-6) side.set(0, 1, 0).cross(dir);
  side.normalize();
  const a = (offsetDeg * Math.PI) / 180;
  const view = dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).addScaledVector(sun, 0.25).normalize();
  w.placeInSpace(bodyId, body.radius * radii, view);
  aimAt(w, () => local, body.radius * lift);
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

// ---------------------------------------------------------------------------------------------
// Space scenery scenarios

const _up = new Vector3(0, 1, 0);

/** Orientation that looks along `fwd` (ship convention: forward is -Z). */
function lookQuat(fwd: Vector3): Quaternion {
  const m = new Matrix4().lookAt(new Vector3(), fwd, _up);
  return new Quaternion().setFromRotationMatrix(m);
}

/** Puts the ship at a world position in the root star's inertial frame, looking along `fwd`. */
function placeWorld(w: World, pos: Vector3, fwd: Vector3, throttle = 0): void {
  w.placeInSpace(w.universe.root.id, pos.length(), pos.clone().normalize());
  w.ship.quat.copy(lookQuat(fwd));
  w.ship.throttle = throttle;
  w.refresh();
}

function blankRock(): Rock {
  return { x: 0, y: 0, z: 0, size: 0, sx: 1, sy: 1, sz: 1, ax: 0, ay: 1, az: 0, spin: 0, phase: 0, tone: 1 };
}

/** In the middle of the first belt, a few hundred metres from a mid sized rock lit from the side. */
function amongRocks(w: World): void {
  const belt = scaleBelts(w.universe.system, DEFAULT_SCALE)[0];
  if (!belt) return arrive(w);
  w.clock.time = 0;
  w.universe.update(0);
  const L = ROCK_LEVELS[1]!;
  const best = blankRock();
  const r = blankRock();
  const base = Math.floor(belt.mid / L.cell);
  for (let ix = base - 10; ix <= base + 10; ix++) {
    for (let iz = -6; iz <= 6; iz++) {
      for (let iy = -1; iy <= 0; iy++) {
        if (rockInCell(belt, 1, ix, iy, iz, 1, r) && r.size > best.size && r.size < 650) Object.assign(best, r);
      }
    }
  }
  const rock = new Vector3(best.x, best.y, best.z);
  const toStar = rock.clone().negate().normalize();
  const side = new Vector3().crossVectors(toStar, _up).normalize();
  const dir = toStar.clone().multiplyScalar(Math.cos(1.1)).addScaledVector(side, Math.sin(1.1)).addScaledVector(_up, 0.12).normalize();
  const cam = rock.clone().addScaledVector(dir, Math.max(900, best.size * 5.5));
  const fwd = rock.clone().sub(cam).normalize();
  // Rock a little right of centre, so the near rocks fill the left.
  fwd.applyAxisAngle(_up, 0.12);
  placeWorld(w, cam, fwd, 0);
}

/** Time (sim seconds) when the comet has grown its tails: scans the inbound leg until the activity is high. */
function cometTailsTime(comet: ReturnType<typeof scaleComets>[number]): number {
  const p = new Vector3();
  const v = new Vector3();
  const span = Math.abs(comet.orbit.period) / 6;
  for (let t = 0; t < span; t += span / 800) {
    cometState(comet, t, p, v);
    if (cometActivity(comet, p.length()) > 0.78) return t;
  }
  return 0;
}

function cometFlyby(w: World): void {
  const comet = scaleComets(w.universe.system, DEFAULT_SCALE)[0];
  if (!comet) return arrive(w);
  const t = cometTailsTime(comet);
  w.clock.time = t;
  w.universe.update(t);
  const p = new Vector3();
  const v = new Vector3();
  cometState(comet, t, p, v);
  const tails = cometTails(p, v, w.universe.root.position);
  const L = comet.tailLength * (0.04 + 0.96 * Math.pow(cometActivity(comet, p.length()), 1.2));
  const normal = new Vector3().crossVectors(p, v).normalize();
  if (normal.y < 0) normal.negate();
  const across = new Vector3().crossVectors(normal, tails.ion).normalize();
  const cam = p.clone().addScaledVector(normal, L * 0.75).addScaledVector(across, L * 0.55).addScaledVector(tails.ion, L * 0.15);
  const target = p.clone().addScaledVector(tails.ion, L * 0.42);
  placeWorld(w, cam, target.sub(cam).normalize());
}

/** High over Earth on a night when the comet stands well above the horizon, looking at it. */
function earthCometSky(w: World): void {
  const comet = scaleComets(w.universe.system, DEFAULT_SCALE)[0];
  if (!comet) return w.place({ body: 'earth', lat: 45, localHour: 0, altitude: 0, landed: true, pitch: 40, heading: 0 });
  const earth = w.universe.get('earth');
  const t0 = cometTailsTime(comet) * 0.55;
  const p = new Vector3();
  const v = new Vector3();
  const d = new Vector3();
  const sun = new Vector3();
  const c = new Vector3();
  let best = { score: -Infinity, t: t0, lat: 40, lon: 0 };
  for (const lat of [30, 38, 46, 54]) {
    for (let t = t0; t < t0 + 86164; t += 400) {
      w.universe.update(t);
      cometState(comet, t, p, v);
      sun.copy(w.universe.root.position).sub(earth.position).normalize();
      c.copy(p).sub(earth.position).normalize();
      const lon = 0;
      latLonToDir((lat * Math.PI) / 180, lon, d);
      const sunElev = Math.asin(earth.worldToLocalDir(sun, _dir).dot(d));
      const cometElev = Math.asin(earth.worldToLocalDir(c, _dir).dot(d));
      if (sunElev > -0.3) continue;
      const score = -Math.abs(cometElev - 0.62);
      if (score > best.score) best = { score, t, lat, lon };
    }
  }
  w.universe.update(best.t);
  cometState(comet, best.t, p, v);
  c.copy(p).sub(earth.position).normalize();
  const local = earth.worldToLocalDir(c, new Vector3());
  const up = new Vector3();
  latLonToDir((best.lat * Math.PI) / 180, 0, up);
  const east = new Vector3(0, 0, -1);
  const north = new Vector3().crossVectors(up, east).normalize();
  const heading = (Math.atan2(local.dot(east), local.dot(north)) * 180) / Math.PI;
  const elev = (Math.asin(local.dot(up)) * 180) / Math.PI;
  // High enough that the glider assist does not level the nose back to the horizon.
  w.place({ body: 'earth', lat: best.lat, lon: 0, altitude: 32000, heading, pitch: Math.min(60, Math.max(8, elev + 3)), throttle: 0, time: best.t });
}

/** Sunset low over the focus world, looking between the star and its companion. */
function binarySunset(w: World): void {
  const focus = w.universe.get(focusBody(w).id);
  if (focus.kind === 'gas') return arrive(w);
  w.clock.time = 0;
  w.universe.update(0);
  const root = w.universe.root;
  const companion = w.universe.bodies.find((b) => b.kind === 'star' && b !== root);
  const sun = focus.worldToLocalDir(root.position.clone().sub(focus.position).normalize(), new Vector3());
  const other = companion ? focus.worldToLocalDir(companion.position.clone().sub(focus.position).normalize(), new Vector3()) : sun;
  const subSolarLon = Math.atan2(-sun.z, sun.x);
  const up = new Vector3();
  // Sunset (sun just on the horizon) at the latitude where the second sun stands about 20 degrees up.
  let best = { score: Infinity, lat: 12, hour: 17.6 };
  for (let lat = -50; lat <= 50; lat += 5) {
    const latR = (lat * Math.PI) / 180;
    for (let h = 16.4; h <= 19; h += 0.02) {
      latLonToDir(latR, subSolarLon + ((h - 12) / 24) * Math.PI * 2, up);
      const sunErr = Math.abs(Math.asin(sun.dot(up)) + 0.012);
      if (sunErr > 0.01) continue;
      const score = Math.abs(Math.asin(other.dot(up)) - 0.36) + Math.abs(lat - 12) * 0.001;
      if (score < best.score) best = { score, lat, hour: h };
    }
  }
  const { lat, hour: bestHour } = best;
  const lon = subSolarLon + ((bestHour - 12) / 24) * Math.PI * 2;
  latLonToDir((lat * Math.PI) / 180, lon, up);
  const east = new Vector3(-Math.sin(lon), 0, -Math.cos(lon));
  const north = new Vector3().crossVectors(up, east).normalize();
  const mid = sun.clone().add(other).normalize();
  const heading = (Math.atan2(mid.dot(east), mid.dot(north)) * 180) / Math.PI;
  const pitch = (Math.asin(mid.dot(up)) * 180) / Math.PI;
  w.place({ body: focus.id, lat, localHour: bestHour, altitude: 700, heading, pitch: Math.max(4, pitch), throttle: 0.2, time: 0 });
}

/** Far out from the star, looking into the sky's hero nebula with the star behind. */
function nebulaSpace(w: World): void {
  const sky = w.universe.system.sky ?? { seed: 1 };
  const focus = skyFocusDir(sky);
  w.clock.time = 0;
  w.universe.update(0);
  const outer = Math.max(...w.universe.root.children.filter((b) => b.kind !== 'star').map((b) => b.orbit?.a ?? 0), 1e8);
  placeWorld(w, focus.clone().multiplyScalar(outer * 1.25), focus);
}
