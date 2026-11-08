import type { GameRenderer } from '../renderer';
import { Contrails } from './contrails';
import { Reentry } from './reentry';
import { SpaceDust } from './spaceDust';

export { getShake } from './reentry';

/** Adds the ship flight effects (dust, re-entry plasma, contrails) to the scene. */
export function installShipFx(gfx: GameRenderer): void {
  const dust = new SpaceDust();
  const reentry = new Reentry();
  const contrails = new Contrails();
  gfx.scene.add(dust.object, reentry.object, contrails.object);
  gfx.updaters.push(
    (ctx) => dust.update(ctx),
    (ctx) => reentry.update(ctx),
    (ctx) => contrails.update(ctx),
  );
}
