import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { HalfFloatType, NoToneMapping, Vector3 } from 'three';
import type { GameRenderer } from './renderer';
import { AtmosphereEffect } from './atmosphere/atmosphereEffect';
import { SunView } from './bodies/sunView';

/**
 * HDR post stack: scene -> atmosphere scattering -> bloom -> ACES tone mapping -> vignette.
 * Also drives sky dependent things that are not part of the scene graph: star visibility
 * and sun glow strength.
 */
export class PostStack {
  readonly composer: EffectComposer;
  readonly atmosphere = new AtmosphereEffect();
  readonly bloom: BloomEffect;
  readonly toneMapping: ToneMappingEffect;
  readonly vignette: VignetteEffect;
  /** 0 in space or at night .. 1 under a bright day sky (camera's local sky). */
  skyBrightness = 0;

  constructor(gfx: GameRenderer) {
    const r = gfx.renderer;
    r.toneMapping = NoToneMapping;
    this.composer = new EffectComposer(r, { frameBufferType: HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(gfx.scene, gfx.camera));
    this.composer.addPass(new EffectPass(gfx.camera, this.atmosphere));
    this.bloom = new BloomEffect({
      intensity: 0.85,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.3,
      mipmapBlur: true,
      radius: 0.75,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.vignette = new VignetteEffect({ darkness: 0.38, offset: 0.32 });
    this.composer.addPass(new EffectPass(gfx.camera, this.bloom, this.toneMapping, this.vignette));

    const sunView = gfx.bodyViews.find((v) => v instanceof SunView) as SunView | undefined;

    gfx.renderFn = (ctx) => {
      const world = ctx.world;
      this.atmosphere.updateFrame(ctx.camera, ctx.cameraWorld, world.universe.root, world.universe.bodies);
      this.skyBrightness = this.estimateSky(gfx);
      gfx.starfield.brightness = 1 - 0.97 * this.skyBrightness;
      if (sunView) sunView.glowIntensity = 1 - 0.5 * this.skyBrightness;
      this.composer.render(ctx.realDt);
    };
    gfx.onResize = (w, h) => this.composer.setSize(w, h);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Cheap CPU estimate of how bright the sky around the camera is. */
  private estimateSky(gfx: GameRenderer): number {
    const world = gfx.ctx.world;
    const cam = gfx.ctx.cameraWorld;
    let best = 0;
    for (const b of world.universe.bodies) {
      if (!b.def.atmosphere || b.atmosphereHeight <= 0) continue;
      const dist = b.position.distanceTo(cam);
      const h = dist - b.radius;
      if (h > b.atmosphereHeight) continue;
      const depth = 1 - Math.max(0, h) / b.atmosphereHeight;
      _up.copy(cam).sub(b.position).normalize();
      _sun.copy(world.universe.root.position).sub(b.position).normalize();
      const elev = _up.dot(_sun);
      const day = smoothstep(-0.18, 0.12, elev);
      best = Math.max(best, day * Math.pow(depth, 0.6));
    }
    return best;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const _up = new Vector3();
const _sun = new Vector3();
