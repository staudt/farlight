import { type Object3D, Vector3 } from 'three';
import type { Body } from '../../sim/universe';
import type { FrameContext } from '../context';
import type { GameRenderer } from '../renderer';
import { quality } from '../quality';
import { Birds } from './birds';
import { makeProbe, smoothstep, type LifeEnv } from './env';
import { Fireflies } from './fireflies';
import { FishSchools } from './fish';
import { LifeLight } from './lifeLight';
import { lifeBudget, lifeSettings } from './settings';
import { SkyWhales } from './skyWhales';
import type { SurfaceProbe } from './spawn';

export { lifeBudget, lifeSettings } from './settings';

/** Counts of live groups, for the debug panel and the smoke test. */
export interface LifeStats {
  body: string;
  flocks: number;
  pods: number;
  schools: number;
  swarms: number;
}

const _cam = new Vector3();
const _up = new Vector3();
const _ship = new Vector3();
const _sun = new Vector3();

/** Creatures: birds, sky whales, fish and fireflies, drawn around the camera when a body has `life`. */
export class LifeSystem {
  readonly light = new LifeLight();
  readonly birds = new Birds(this.light);
  readonly skyWhales = new SkyWhales(this.light);
  readonly fish = new FishSchools(this.light);
  readonly fireflies = new Fireflies(this.light);
  private probes = new Map<string, SurfaceProbe>();
  private camGround = 0;
  private frame = 0;
  private env: LifeEnv | null = null;
  private bodyId = '';

  get objects(): Object3D[] {
    return [this.fish.object, this.birds.object, this.skyWhales.object, this.fireflies.object];
  }

  stats(): LifeStats {
    return { body: this.bodyId, flocks: this.birds.flocks, pods: this.skyWhales.pods, schools: this.fish.schools, swarms: this.fireflies.swarms };
  }

  /** The nearest body with life that the camera is inside the sky of, or null. */
  private pick(ctx: FrameContext): Body | null {
    let best: Body | null = null;
    let bestAlt = Infinity;
    for (const b of ctx.world.universe.bodies) {
      if (!b.def.life?.length || b.kind !== 'rocky') continue;
      const alt = b.position.distanceTo(ctx.cameraWorld) - b.radius;
      if (alt < Math.max(b.atmosphereHeight, 12000) + 4000 && alt < bestAlt) {
        best = b;
        bestAlt = alt;
      }
    }
    return best;
  }

  update(ctx: FrameContext): void {
    this.frame++;
    const body = lifeSettings.enabled ? this.pick(ctx) : null;
    if (!body) {
      this.bodyId = '';
      this.env = null;
      this.birds.update(null);
      this.skyWhales.update(null);
      this.fish.update(null);
      this.fireflies.update(null);
      return;
    }
    const w = ctx.world;
    this.bodyId = body.id;
    let probe = this.probes.get(body.id);
    if (!probe) {
      probe = makeProbe(w, body);
      this.probes.set(body.id, probe);
    }
    // Camera and ship in body fixed axes.
    _cam.copy(ctx.cameraWorld).sub(body.position);
    const camLen = _cam.length();
    _up.copy(_cam).divideScalar(camLen);
    const sunDir = _sun.copy(w.universe.root.position).sub(body.position).normalize();
    const sunElev = _up.dot(sunDir);
    body.worldToLocalDir(_cam, _cam);
    const env: LifeEnv = this.env ?? ({} as LifeEnv);
    const camDir = (env.camDir ?? new Vector3()).copy(_cam).divideScalar(camLen);
    if (this.frame % 4 === 1) this.camGround = w.groundHeight(body, camDir);
    _ship.copy(w.shipWorldPos).sub(body.position);
    body.worldToLocalDir(_ship, _ship);

    env.body = body;
    env.defs = body.def.life!;
    env.probe = probe;
    env.dt = Math.min(0.1, ctx.realDt);
    env.time = ctx.realTime;
    env.camDir = camDir;
    env.camAgl = camLen - body.radius - this.camGround;
    env.origin = (env.origin ?? new Vector3()).copy(body.position).sub(ctx.cameraWorld);
    env.rot = body.rotation;
    env.shipLocal = (env.shipLocal ?? new Vector3()).copy(_ship);
    env.sunDirWorld = (env.sunDirWorld ?? new Vector3()).copy(sunDir);
    env.sunElev = sunElev;
    env.daylight = smoothstep(-0.06, 0.25, sunElev);
    env.night = 1 - smoothstep(-0.28, -0.02, sunElev);
    env.budget = lifeBudget(quality.settings.fxScale, lifeSettings.density);
    this.env = env;

    this.light.update(ctx.camera, env.sunDirWorld, sunElev, env.night, body.def.atmosphere?.rayleighDepth, env.time, lifeSettings.glow);
    this.light.uniforms.uPx.value = (ctx.viewportHeight * ctx.renderer.getPixelRatio()) / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));

    this.birds.update(env);
    this.skyWhales.update(env);
    this.fish.update(env);
    this.fireflies.update(env);
  }
}

/** Adds the creature layers to the scene and hooks them into the frame loop. */
export function installLife(gfx: GameRenderer): LifeSystem {
  const life = new LifeSystem();
  gfx.scene.add(...life.objects);
  gfx.updaters.push((ctx) => life.update(ctx));
  (window as unknown as { __life?: LifeSystem }).__life = life;
  return life;
}
