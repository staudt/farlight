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
import { Starfield } from './sky/starfield';
import { ShipView } from './ship/shipView';

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
  readonly shipView = new ShipView();
  readonly bodyViews: BodyView[] = [];
  readonly sunLight = new DirectionalLight(0xffffff, 3);
  readonly ambient = new AmbientLight(0x223344, 0.25);
  readonly hemi = new HemisphereLight(0x88aaff, 0x332211, 0);
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
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.render.pixelRatioMax));

    this.camera = new PerspectiveCamera(config.camera.fov, 1, config.render.near, config.render.far);
    this.scene.add(this.camera, this.starfield.object, this.shipView.object, this.sunLight, this.sunLight.target);
    this.scene.add(this.ambient, this.hemi);

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
  /** Camera shake in meters along the view right and up axes (re-entry buffeting). */
  cameraShake?: () => { x: number; y: number };

  render(world: World, realDt: number): void {
    this.realTime += realDt;
    const ctx = this.ctx;
    ctx.realDt = realDt;
    ctx.realTime = this.realTime;
    ctx.simTime = world.clock.time;

    this.shipCamera.update(world, this.camera, realDt);
    if (this.cameraShake) {
      const s = this.cameraShake();
      _shake.set(s.x, s.y, 0).applyQuaternion(this.camera.quaternion);
      this.shipCamera.worldPos.add(_shake);
    }

    // Sun light shines on the ship from the sun's direction.
    const sun = world.universe.root;
    _sunDir.copy(sun.position).sub(world.shipWorldPos).normalize();
    this.sunLight.position.copy(_sunDir).multiplyScalar(1000);
    this.sunLight.target.position.set(0, 0, 0);

    for (const v of this.bodyViews) v.update(ctx);
    this.shipView.update(ctx);
    this.shipView.object.visible = this.shipCamera.mode === 'chase';
    for (const u of this.updaters) u(ctx);

    this.renderFn(ctx);
  }
}

const _sunDir = new Vector3();
const _shake = new Vector3();
