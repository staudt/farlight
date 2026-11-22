import { config } from '../../core/config';
import type { GameRenderer } from '../renderer';
import { BoostFx } from './boostFx';
import { Contrails } from './contrails';
import { Reentry } from './reentry';
import { SpaceDust } from './spaceDust';
import { warpIntensity } from './speedFx';
import { OceanWake } from './wake';
import { FxScreen, WarpStreaks } from './warpFx';

export { getShake } from './reentry';

/** Adds the ship flight effects (dust, warp streaks, re-entry plasma, boost fx, contrails, wake) to the scene. */
export function installShipFx(gfx: GameRenderer): void {
  const dust = new SpaceDust();
  const warp = new WarpStreaks();
  const reentry = new Reentry();
  const boost = new BoostFx();
  const contrails = new Contrails();
  const wake = new OceanWake();
  const screen = new FxScreen();
  gfx.scene.add(dust.object, warp.object, reentry.object, reentry.lightHolder, boost.object, contrails.object, wake.object);
  gfx.updaters.push(
    (ctx) => {
      const ship = ctx.world.ship;
      const target = ship.landed ? 0 : warpIntensity(ship.speed, ctx.world.clock.warp);
      warp.update(ctx, target);
      dust.update(ctx, warp.k);
      const cockpit = gfx.shipCamera.mode === 'cockpit';
      const plasma = reentry.update(ctx, cockpit);
      screen.set(warp.k * config.speedFx.warpTunnel, plasma);
    },
    (ctx) => boost.update(ctx, gfx.shipCamera.mode === 'cockpit'),
    (ctx) => contrails.update(ctx),
    (ctx) => wake.update(ctx),
  );
}
