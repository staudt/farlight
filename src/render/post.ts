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
import { CloudEffect } from './clouds/cloudEffect';
import { PerfStats } from './perf';
import { quality, type QualitySettings } from './quality';
import { VolumetricComposite, VolumetricPass } from './volumetricPass';
import { SunView } from './bodies/sunView';

/**
 * HDR post stack: scene -> atmosphere scattering -> bloom -> ACES tone mapping -> vignette.
 * Also drives sky dependent things that are not part of the scene graph: star visibility
 * and sun glow strength.
 */
export class PostStack {
  readonly composer: EffectComposer;
  readonly atmosphere = new AtmosphereEffect();
  readonly clouds = new CloudEffect();
  readonly vol: VolumetricPass;
  readonly composite = new VolumetricComposite();
  readonly perf: PerfStats;
  readonly bloom: BloomEffect;
  readonly toneMapping: ToneMappingEffect;
  readonly vignette: VignetteEffect;
  /** 0 in space or at night .. 1 under a bright day sky (camera's local sky). */
  skyBrightness = 0;

  constructor(gfx: GameRenderer) {
    const r = gfx.renderer;
    r.toneMapping = NoToneMapping;
    this.composer = new EffectComposer(r, { frameBufferType: HalfFloatType, multisampling: quality.settings.msaa });
    this.perf = new PerfStats(r);
    this.composer.addPass(new RenderPass(gfx.scene, gfx.camera));
    this.vol = new VolumetricPass([this.clouds.uniforms, this.atmosphere.uniforms]);
    this.composer.addPass(this.vol);
    this.bloom = new BloomEffect({
      intensity: 0.85,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.3,
      mipmapBlur: true,
      radius: 0.75,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.vignette = new VignetteEffect({ darkness: 0.38, offset: 0.32 });
    this.passWithBloom = new EffectPass(gfx.camera, this.composite, this.bloom, this.toneMapping, this.vignette);
    this.passNoBloom = new EffectPass(gfx.camera, this.composite, this.toneMapping, this.vignette);
    this.finalPass = this.passWithBloom;
    this.composer.addPass(this.finalPass);

    const sunView = gfx.bodyViews.find((v) => v instanceof SunView) as SunView | undefined;

    gfx.renderFn = (ctx) => {
      const world = ctx.world;
      const bodies = world.universe.bodies;
      quality.update(ctx.realDt);
      this.clouds.updateFrame(ctx.camera, ctx.cameraWorld, world.universe.root, bodies, ctx.simTime);
      this.atmosphere.updateFrame(ctx.camera, ctx.cameraWorld, world.universe.root, bodies);
      // Skip the volumetric pass entirely when no cloud layer or atmosphere is in range.
      const volOn = this.clouds.body !== null || (this.atmosphere.uniforms.get('uCount')!.value as number) > 0;
      this.vol.enabled = volOn;
      this.composite.bind(this.vol, Math.log2(ctx.camera.far + 1), volOn);
      this.skyBrightness = this.estimateSky(gfx);
      gfx.starfield.brightness = 1 - 0.97 * this.skyBrightness;
      if (sunView) sunView.glowIntensity = 1 - 0.5 * this.skyBrightness;
      this.perf.begin();
      this.composer.render(ctx.realDt);
      this.perf.end();
    };
    gfx.onResize = (w, h) => this.composer.setSize(w, h);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    quality.onChange((q) => this.applyQuality(gfx, q));
  }

  private readonly passWithBloom: EffectPass;
  private readonly passNoBloom: EffectPass;
  private finalPass: EffectPass;

  /** Pushes a quality preset into the post stack, the renderer and the shaders. */
  private applyQuality(gfx: GameRenderer, q: QualitySettings): void {
    gfx.applyPixelRatio(q.pixelRatioMax); // resizes the composer too
    this.composer.multisampling = q.msaa;
    this.vol.setScale(q.volScale);
    this.clouds.animateJitter = !this.vol.blur;
    const c = this.clouds.uniforms;
    c.get('uCloudSteps')!.value = q.cloudSteps;
    c.get('uCloudLight')!.value = q.cloudLight;
    c.get('uCloudShadows')!.value = q.cloudShadows ? 1 : 0;
    const a = this.atmosphere.uniforms;
    a.get('uAtmoSteps')!.value = q.atmoSteps;
    a.get('uAtmoLight')!.value = q.atmoLight;
    this.bloom.mipmapBlurPass.levels = q.bloomLevels;
    const want = q.bloom ? this.passWithBloom : this.passNoBloom;
    if (want !== this.finalPass) {
      this.composer.removePass(this.finalPass);
      this.composer.addPass(want);
      this.finalPass = want;
    }
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
