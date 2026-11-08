import type { GameRenderer } from '../renderer';
import type { PostStack } from '../post';
import { Aurora } from './aurora';
import { Lightning } from './lightning';
import { Precipitation } from './precipitation';

export { auroraSettings, lightningSettings, rainSettings, snowSettings } from './settings';

export interface WeatherSystem {
  lightning: Lightning;
  precipitation: Precipitation;
  auroras: Aurora[];
}

/** Adds rain, snow, lightning and auroras to the scene and hooks them into the frame loop. */
export function installWeather(gfx: GameRenderer, post: PostStack): WeatherSystem {
  const precipitation = new Precipitation(post);
  const lightning = new Lightning(post);
  const auroras: Aurora[] = [];
  for (const body of gfx.ctx.world.universe.bodies) {
    if (body.def.atmosphere?.aurora) auroras.push(new Aurora(body, post));
  }
  gfx.scene.add(precipitation.rain.object, precipitation.snow.object, lightning.object);
  for (const a of auroras) gfx.scene.add(a.object);
  gfx.updaters.push(
    (ctx) => precipitation.update(ctx),
    (ctx) => lightning.update(ctx),
    ...auroras.map((a) => (ctx: Parameters<Aurora['update']>[0]) => a.update(ctx)),
  );
  const system = { lightning, precipitation, auroras };
  (window as unknown as { __weather?: WeatherSystem }).__weather = system;
  return system;
}
