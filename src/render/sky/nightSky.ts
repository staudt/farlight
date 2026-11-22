import { AdditiveBlending, BackSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { config } from '../../core/config';
import type { FrameContext } from '../context';
import { nightLight } from '../nightLight';
import { quality } from '../quality';
import type { Starfield } from './starfield';

const RADIUS = 1e10;

/**
 * The night sky extras that live behind the stars: the zodiacal light cone (a warm wedge along the
 * ecliptic, rising from the sun's place after dusk, plus a faint gegenschein) and the hooks that
 * drive star twinkle and moon glare on the starfield.
 */
export class NightSky {
  readonly object: Mesh;
  private readonly material: ShaderMaterial;
  private readonly up = new Vector3(0, 1, 0);
  private readonly sun = new Vector3(1, 0, 0);

  constructor(private readonly starfield: Starfield) {
    this.material = new ShaderMaterial({
      uniforms: { uSun: { value: this.sun }, uAmount: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uSun;
        uniform float uAmount;
        varying vec3 vDir;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 d = normalize(vDir);
          float c = clamp(dot(d, uSun), -1.0, 1.0);
          float elong = acos(c);
          // Ecliptic latitude: the plane is world XZ and the sun sits in it.
          float beta = asin(clamp(d.y, -1.0, 1.0));
          float w = 0.17 + 0.3 * exp(-elong * 1.3);
          float cone = exp(-elong / 0.75) * exp(-(beta * beta) / (w * w)) * smoothstep(0.1, 0.45, elong);
          float anti = exp(-pow(acos(clamp(-c, -1.0, 1.0)) / 0.2, 2.0)) * exp(-(beta * beta) / 0.05);
          float i = cone + 0.12 * anti;
          vec3 col = vec3(1.0, 0.86, 0.66) * i * 0.04 * uAmount;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: BackSide,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.object = new Mesh(new SphereGeometry(RADIUS, 32, 16), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -9;
    this.object.visible = false;
  }

  update(ctx: FrameContext): void {
    const world = ctx.world;
    const c = config.night;
    const focus = world.ship.frame.body;
    const dark = this.starfield.brightness;
    this.sun.copy(world.universe.root.position).sub(world.shipWorldPos).normalize();
    // Local up, and the sun's elevation for the dusk window.
    let amount = 0.4;
    let wash = 1;
    let twinkle = 0;
    if (focus.kind !== 'star') {
      this.up.copy(world.shipWorldPos).sub(focus.position).normalize();
      const s = this.up.dot(this.sun);
      // Strongest in the dark after dusk, a fainter wedge later in the night.
      const alt = Math.min(1, world.atmosphereDepth * 4);
      amount = 0.4 + alt * (0.35 + 0.65 * smooth(-0.95, -0.3, s) - 0.4);
      twinkle = c.twinkle * Math.sqrt(Math.min(1, world.atmosphereDepth * 3)) * (quality.settings.nightFx >= 1 ? 1 : 0);
      wash = 1 - c.starWash * Math.min(1, nightLight.level) * nightLight.night * nightLight.moonUp;
    }
    const on = c.enabled && c.zodiacal > 0 && quality.settings.nightFx >= 2 && config.space.enabled;
    const a = on ? amount * dark * c.zodiacal : 0;
    this.object.visible = a > 0.01;
    this.material.uniforms.uAmount!.value = a;
    this.starfield.setNight(this.up, c.enabled ? twinkle : 0, c.enabled ? wash : 1, ctx.realTime);
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
