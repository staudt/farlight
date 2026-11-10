import {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
} from 'three';
import { config } from '../core/config';
import type { World } from '../sim/world';
import type { Body } from '../sim/universe';
import { SimpleBodyView } from './bodies/simpleBodyView';
import { SunView } from './bodies/sunView';
import type { BodyView, FrameContext } from './context';
import { ShipCamera } from './camera/shipCamera';
import { quality } from './quality';
import { starLight } from './starLight';
import { Starfield } from './sky/starfield';
import { SpaceScenery } from './space';
import { ShipView } from './ship/shipView';
import { Cockpit } from './ship/cockpit';

const BASE_SUN_LIGHT = 3;

export type BodyViewFactory = (body: Body) => BodyView | null;

/**
 * Owns the Three renderer, scene and camera. Floating origin: the camera sits at the origin
 * and every view places itself relative to `shipCamera.worldPos`.
 */
export class GameRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly shipCamera = new ShipCamera();
  readonly starfield = new Starfield();
  /** Asteroid belts, comets and the nebula backdrop (all from the system data). */
  readonly space: SpaceScenery;
  readonly shipView = new ShipView();
  readonly cockpit = new Cockpit();
  readonly bodyViews: BodyView[] = [];
  readonly sunLight = new DirectionalLight(0xffffff, BASE_SUN_LIGHT);
  readonly ambient = new AmbientLight(0x223344, 0.18);
  /** Planetshine: sky color above, the nearby planet's lit color below. */
  readonly hemi = new HemisphereLight(0x88aaff, 0x332211, 0);
  /** Soft fill from the camera so the ship always reads, even against the sun. */
  readonly fill = new DirectionalLight(0xbfd4ff, 0.55);
  /** Extra per frame hooks (effects, weather, ...). */
  readonly updaters: ((ctx: FrameContext) => void)[] = [];
  /** Replaces the final render call (the post processing stack installs itself here). */
  renderFn: (ctx: FrameContext) => void;
  readonly ctx: FrameContext;
  private realTime = 0;

  constructor(canvas: HTMLCanvasElement, world: World, factories: BodyViewFactory[] = []) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // smoke test screenshots
    });
    this.watchContextLoss(canvas);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.render.pixelRatioMax, quality.settings.pixelRatioMax));

    this.camera = new PerspectiveCamera(config.camera.fov, 1, config.render.near, config.render.far);
    this.scene.add(this.camera, this.starfield.object, this.shipView.object, this.cockpit.object, this.sunLight, this.sunLight.target);
    this.scene.add(this.ambient, this.hemi, this.fill, this.fill.target);
    this.space = new SpaceScenery(world, this.starfield);
    this.scene.add(this.space.object);
    this.updaters.push((ctx) => this.space.update(ctx));

    for (const body of world.universe.bodies) {
      let view: BodyView | null = null;
      for (const f of factories) {
        view = f(body);
        if (view) break;
      }
      view ??= body.kind === 'star' ? new SunView(body) : new SimpleBodyView(body);
      this.bodyViews.push(view);
      this.scene.add(view.object);
    }

    this.ctx = {
      world,
      renderer: this.renderer,
      camera: this.camera,
      cameraWorld: this.shipCamera.worldPos,
      realDt: 0,
      realTime: 0,
      simTime: 0,
      viewportHeight: 1,
    };
    this.renderFn = () => this.renderer.render(this.scene, this.camera);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.ctx.viewportHeight = h;
    this.starfield.pixelRatio = this.renderer.getPixelRatio();
    this.onResize?.(w, h);
  }

  onResize?: (w: number, h: number) => void;

  /** True while the WebGL context is lost (GPU memory pressure, phone app switch). */
  contextLost = false;

  /**
   * A lost context leaves a black canvas while the loop keeps running. Show a short note and,
   * when the browser restores the context, reload in place (custom shaders and render targets
   * are simpler to rebuild than to restore piecemeal).
   */
  private watchContextLoss(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      let note = document.getElementById('context-lost');
      if (!note) {
        note = document.createElement('div');
        note.id = 'context-lost';
        note.textContent = 'GRAPHICS RESET · RELOADING';
        Object.assign(note.style, {
          position: 'fixed',
          inset: '0',
          display: 'grid',
          placeItems: 'center',
          font: '500 14px Rajdhani, sans-serif',
          letterSpacing: '0.4em',
          color: 'rgba(150, 230, 255, 0.8)',
          background: '#05070d',
          zIndex: '50',
        });
        document.body.appendChild(note);
      }
      // If the browser never restores it, reload anyway after a moment.
      window.setTimeout(() => location.reload(), 4000);
    });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  /** Quality hook: new pixel ratio cap, then resize everything. */
  applyPixelRatio(cap: number): void {
    const pr = Math.min(window.devicePixelRatio, config.render.pixelRatioMax, cap);
    if (pr === this.renderer.getPixelRatio()) return;
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  private updateFillLights(world: World): void {
    // Camera fill: from slightly above and behind the camera.
    _fillDir.set(0.2, 0.6, 1).applyQuaternion(this.camera.quaternion);
    this.fill.position.copy(_fillDir).multiplyScalar(100);
    this.fill.target.position.set(0, 0, 0);

    // Planetshine from the dominant body.
    const body = world.ship.frame.body;
    if (body.kind === 'star') {
      this.fill.intensity = FILL_BASE;
      this.hemi.intensity = 0;
      return;
    }
    _up2.copy(world.shipWorldPos).sub(body.position);
    const dist = _up2.length();
    _up2.divideScalar(dist);
    this.hemi.position.copy(_up2);
    const sunDir = _sunDir2.copy(world.universe.root.position).sub(body.position).normalize();
    const day = Math.max(0, _up2.dot(sunDir) * 0.7 + 0.3);
    const c = body.def.visual.color;
    // Fades with distance: strong when the planet fills the sky.
    const near = Math.min(1, (body.radius * 3) / dist);
    this.hemi.groundColor.setRGB(c[0] * day, c[1] * day, c[2] * day);
    const a = body.def.atmosphere ? world.atmosphereDepth : 0;
    // Under a night sky the camera fill would light the ship like a lamp: fade it with the day factor.
    const dayF = Math.min(1, Math.max(0, (_up2.dot(sunDir) + 0.15) / 0.4));
    this.fill.intensity = FILL_BASE * (1 - a * 0.92 * (1 - dayF * dayF * (3 - 2 * dayF)));
    this.hemi.color.setRGB(0.08 + 0.45 * a * day, 0.1 + 0.55 * a * day, 0.16 + 0.75 * a * day);
    this.hemi.intensity = 1.6 * near;
  }
  /** Camera shake in meters along the view right and up axes (re-entry buffeting). */
  cameraShake?: () => { x: number; y: number };

  render(world: World, realDt: number): void {
    this.realTime += realDt;
    const ctx = this.ctx;
    ctx.realDt = realDt;
    ctx.realTime = this.realTime;
    ctx.simTime = world.clock.time;

    this.shipCamera.update(world, this.camera, realDt);
    if (this.cameraShake && !this.shipCamera.override) {
      const s = this.cameraShake();
      _shake.set(s.x, s.y, 0).applyQuaternion(this.camera.quaternion);
      this.shipCamera.worldPos.add(_shake);
    }

    // Sun light shines on the ship from the sun's direction.
    const sun = world.universe.root;
    starLight.update(sun.def.star);
    starLight.applyTint(this.sunLight.color);
    this.sunLight.intensity = BASE_SUN_LIGHT * starLight.intensity;
    _sunDir.copy(sun.position).sub(world.shipWorldPos).normalize();
    this.sunLight.position.copy(_sunDir).multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);
    this.updateFillLights(world);

    for (const v of this.bodyViews) v.update(ctx);
    this.shipView.update(ctx);
    this.shipView.object.visible = this.shipCamera.override ? this.shipCamera.override.shipVisible : this.shipCamera.showsShip;
    const inside = !this.shipCamera.override && !this.shipCamera.showsShip;
    this.cockpit.object.visible = inside;
    if (inside) this.cockpit.update(ctx, this.camera.aspect);
    for (const u of this.updaters) u(ctx);

    this.renderFn(ctx);
  }
}

const _sunDir = new Vector3();
const _shake = new Vector3();
const FILL_BASE = 0.55;
const _fillDir = new Vector3();
const _up2 = new Vector3();
const _sunDir2 = new Vector3();
