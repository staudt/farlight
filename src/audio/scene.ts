import { Vector3 } from 'three';
import { DEFAULT_SCALE } from '../data/scale';
import { effectsOf, findEffect, type WeatherDef } from '../data/types';
import { hashInts } from '../core/rng';
import { scaleBelts, scaleComets, beltDensity, cometActivity, cometState, type ScaledBelt, type ScaledComet } from '../render/space/spaceData';
import { smooth, weatherAmount } from '../render/weather/weatherMap';
import { acidRainSettings, methaneRainSettings, rainSettings, snowSettings } from '../render/weather/settings';
import type { World } from '../sim/world';
import { emptyScene, type SceneState } from './soundscape';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

/**
 * Reads the world into a SceneState: weather where the ship is, hazards, belts and comets.
 * Created once per world (belts and comets are scaled once). Everything comes from body data.
 */
export class SceneSampler {
  readonly state: SceneState = emptyScene();
  private readonly belts: ScaledBelt[];
  private readonly comets: ScaledComet[];
  private readonly up = new Vector3();
  private readonly dir = new Vector3();
  private readonly sun = new Vector3();
  private readonly rel = new Vector3();
  private readonly cPos = new Vector3();
  private readonly cVel = new Vector3();

  constructor(private readonly world: World) {
    this.belts = scaleBelts(world.universe.system, DEFAULT_SCALE);
    this.comets = scaleComets(world.universe.system, DEFAULT_SCALE);
  }

  sample(): SceneState {
    const w = this.world;
    const out = this.state;
    const ship = w.ship;
    const body = ship.frame.body;
    const def = body.def;
    const atm = def.atmosphere;
    const root = w.universe.root;
    const time = w.clock.time;
    out.seed = hashInts(w.universe.system.seed, def.seed);

    // Daylight at the ship, relative to the body it is over.
    this.up.copy(ship.pos).normalize();
    this.sun.copy(root.position).sub(body.position).normalize();
    // `ship.pos` is body fixed in the rotating frame and inertial otherwise; both are fine for a
    // sun test once the body's own rotation is accounted for.
    const upWorld = ship.frame.rotating ? this.dir.copy(this.up).applyQuaternion(body.rotation) : this.up;
    const sunUp = body.kind === 'star' ? 1 : upWorld.dot(this.sun);
    out.day = smooth(-0.12, 0.3, sunUp);

    // Alienness: hazards, gas, exotic effects and airless worlds read as strange.
    const hazards = def.info?.hazards?.length ?? 0;
    const exotic = effectsOf(def).some((e) => e.kind === 'volcanicPlume' || e.kind === 'geyser' || e.kind === 'acidRain' || e.kind === 'methaneRain');
    out.alien = clamp01(
      (hazards > 0 ? 1 : 0) + (body.kind === 'gas' ? 1 : 0) + (exotic ? 0.8 : 0) + (atm && def.terrain?.seaLevel === undefined ? 0.7 : 0) + (!atm ? 0.6 : 0),
    );

    out.rain = out.snow = out.acid = out.methane = out.dust = out.devil = out.gas = out.heavy = out.heat = out.plume = 0;

    // Weather under the clouds, like the precipitation layers.
    if (atm && body.kind !== 'star') {
      const dirLocal = ship.frame.rotating ? this.up : body.worldToLocalDir(this.up, this.dir);
      const clouds = atm.clouds;
      const base = (clouds?.altitude ?? 0.3) * body.atmosphereHeight;
      const alt = Math.max(0, w.radialAltitude);
      const fade = 1 - smooth(base * 0.75, base, alt);
      const amount = (kind: WeatherDef['kind'], s: { enabled: boolean; intensity: number; force?: boolean }): number => {
        const d = atm.weather?.find((x) => x.kind === kind);
        if (!d || !s.enabled) return 0;
        const a = s.force ? 1 : weatherAmount(d, dirLocal, time, body);
        return clamp01(a * s.intensity) * fade;
      };
      out.rain = amount('rain', rainSettings);
      out.snow = amount('snow', snowSettings);
      out.acid = amount('acidRain', acidRainSettings);
      out.methane = amount('methaneRain', methaneRainSettings);
      const dust = atm.weather?.find((x) => x.kind === 'dust');
      if (dust) out.dust = clamp01(weatherAmount(dust, dirLocal, time, body)) * (0.4 + 0.6 * fade);
      const devil = atm.weather?.find((x) => x.kind === 'dustDevil');
      if (devil) out.devil = devil.intensity * (1 - smooth(base * 0.5, base, alt));
      if (body.kind === 'gas') out.gas = clamp01(w.atmosphereDepth * 2);
      const crush = def.info?.hazards?.some((h) => /crush|pressure/i.test(h)) ? 1 : 0;
      const thick = clamp01(((atm.scaleHeight ?? 0.12) - 0.15) / 0.1) * 0.6;
      out.heavy = Math.max(crush, thick) * clamp01(w.atmosphereDepth * 2);
    }

    // Heat: searing worlds on their day side.
    const scorch = findEffect(def, 'scorching');
    const shimmer = findEffect(def, 'heatShimmer');
    const heatI = Math.max(scorch ? scorch.intensity : 0, shimmer ? shimmer.intensity * 0.45 : 0);
    const low = ship.frame.rotating && (ship.landed || w.env.altitude < body.radius * 0.3);
    out.heat = low ? heatI * out.day : 0;

    // Plumes and geysers: close to the ground.
    const plume = findEffect(def, 'volcanicPlume');
    const geyser = findEffect(def, 'geyser');
    const pd = plume ?? geyser;
    if (pd && ship.frame.rotating) {
      const h = Math.max(1, (pd.size ?? 0.1) * body.radius);
      const near = 1 - smooth(h * 0.4, h * 3.5, Math.max(0, w.env.altitude));
      out.plume = pd.intensity * near * (plume ? 1 : 0.4);
    }

    // Belts and comets live in the star's frame.
    out.belt = 0;
    out.comet = 0;
    if (!ship.frame.rotating) {
      this.rel.copy(w.shipWorldPos).sub(root.position);
      const r = Math.hypot(this.rel.x, this.rel.z);
      for (const b of this.belts) out.belt = Math.max(out.belt, clamp01(beltDensity(b, r, this.rel.y) * 1.5));
      for (const c of this.comets) {
        cometState(c, time, this.cPos, this.cVel);
        const dist = this.cPos.distanceTo(this.rel);
        const activity = cometActivity(c, this.cPos.length());
        const near = 1 - smooth(c.tailLength * 0.1, c.tailLength * 0.6, dist);
        out.comet = Math.max(out.comet, near * (0.4 + 0.6 * activity));
      }
    }
    return out;
  }
}
