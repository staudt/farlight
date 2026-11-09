import { acidRainSettings } from './settings';
import type { GameRenderer } from '../renderer';
import type { PostStack } from '../post';
import { Aurora } from './aurora';
import { Lightning } from './lightning';
import { LensDrops } from './lens';
import { SurfacePlumes } from './plumes';
import { Precipitation } from './precipitation';

export { auroraSettings, lightningSettings, rainSettings, snowSettings, weatherSettings } from './settings';

export interface WeatherSystem {
  lightning: Lightning;
  precipitation: Precipitation;
  auroras: Aurora[];
  plumes: SurfacePlumes;
  lens: LensDrops;
}

/** Adds rain, snow, lightning and auroras to the scene and hooks them into the frame loop. */
export function installWeather(gfx: GameRenderer, post: PostStack): WeatherSystem {
  const precipitation = new Precipitation(post);
  const lightning = new Lightning(post);
  const plumes = new SurfacePlumes(gfx.ctx.world.universe.bodies);
  const lens = new LensDrops();
  const auroras: Aurora[] = [];
  for (const body of gfx.ctx.world.universe.bodies) {
    if (body.def.atmosphere?.aurora) auroras.push(new Aurora(body, post));
  }
  gfx.scene.add(precipitation.rain.object, precipitation.snow.object, precipitation.acid.object, precipitation.methane.object, lightning.object, plumes.object);
  for (const a of auroras) gfx.scene.add(a.object);
  gfx.updaters.push(
    (ctx) => precipitation.update(ctx),
    (ctx) => lightning.update(ctx),
    (ctx) => plumes.update(ctx),
    (ctx) => {
      const speed = ctx.world.ship.vel.length();
      const light = Math.min(1, 0.25 + post.skyBrightness);
      lens.update(ctx.realDt, acidRainSettings.lensDrops ? precipitation.acidAmount : 0, [0.72, 0.82, 0.25], light, speed);
    },
    ...auroras.map((a) => (ctx: Parameters<Aurora['update']>[0]) => a.update(ctx)),
  );
  const system = { lightning, precipitation, auroras, plumes, lens };
  (window as unknown as { __weather?: WeatherSystem }).__weather = system;
  return system;
}
