import { Group } from 'three';
import type GUI from 'lil-gui';
import { config } from '../../core/config';
import { DEFAULT_SCALE } from '../../data/scale';
import type { SkyDef } from '../../data/types';
import type { World } from '../../sim/world';
import type { FrameContext } from '../context';
import type { Starfield } from '../sky/starfield';
import { AsteroidBelts } from './asteroidBelts';
import { CometView } from './comets';
import { Nebula } from './nebula';
import { scaleBelts, scaleComets } from './spaceData';

/** A neutral backdrop for systems without a SkyDef: a soft violet band. */
const DEFAULT_SKY: SkyDef = { colors: [[0.35, 0.3, 0.8], [0.7, 0.35, 0.55], [0.25, 0.5, 0.9]], intensity: 0.4, band: 0.7, scale: 1.2, seed: 1 };

/**
 * Everything decorative between the stars: asteroid belts, comets and the nebula backdrop.
 * All of it comes from the StarSystemDef (`belts`, `comets`, `sky`), nothing is named by id.
 */
export class SpaceScenery {
  readonly object = new Group();
  readonly belts: AsteroidBelts;
  readonly comets: CometView[];
  readonly nebula: Nebula;

  constructor(
    world: World,
    private readonly starfield: Starfield,
  ) {
    const system = world.universe.system;
    this.object.name = 'space scenery';
    this.belts = new AsteroidBelts(scaleBelts(system, DEFAULT_SCALE), DEFAULT_SCALE);
    this.comets = scaleComets(system, DEFAULT_SCALE).map((c) => new CometView(c));
    this.nebula = new Nebula(system.sky ?? DEFAULT_SKY);
    this.object.add(this.nebula.object, this.belts.object, ...this.comets.map((c) => c.object));
  }

  update(ctx: FrameContext): void {
    const on = config.space.enabled;
    this.nebula.update(ctx.renderer, on ? this.starfield.brightness : 0, config.space.nebula);
    this.belts.update(ctx);
    for (const c of this.comets) c.update(ctx);
  }

  addDebug(folder: GUI): void {
    const s = config.space;
    folder.add(s, 'enabled');
    folder.add(s, 'rockDensity', 0, 3).name('rock density');
    folder.add(s, 'beltDust', 0, 4).name('belt dust');
    folder.add(s, 'cometGlow', 0, 3).name('comet glow');
    folder.add(s, 'cometTail', 0.2, 3).name('comet tail');
    folder.add(s, 'nebula', 0, 4).name('nebula');
  }
}
