import {
  AdditiveBlending,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { Body } from '../../sim/universe';
import { type BodyView, type FrameContext, apparentSizeBoost, placeRelative } from '../context';

/** Emissive sun disc plus a camera facing corona glow. HDR values feed the bloom pass. */
export class SunView implements BodyView {
  readonly body: Body;
  readonly object = new Group();
  private disc: Mesh;
  private glow: Mesh;
  private glowMat: ShaderMaterial;

  constructor(body: Body) {
    this.body = body;
    const c = body.def.star?.color ?? body.def.visual.color;
    const color = new Color(c[0], c[1], c[2]);
    this.disc = new Mesh(
      new IcosahedronGeometry(1, 4),
      new MeshBasicMaterial({ color: color.clone().multiplyScalar(6) }),
    );
    this.glowMat = new ShaderMaterial({
      uniforms: { uColor: { value: color }, uIntensity: { value: 1 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv * 2.0 - 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv);
          float g = exp(-r * 7.0) * 2.5 + exp(-r * 2.2) * 0.35;
          g *= smoothstep(1.0, 0.6, r);
          // Soft rays
          float a = atan(vUv.y, vUv.x);
          g *= 0.85 + 0.15 * sin(a * 12.0) * smoothstep(0.05, 0.4, r);
          gl_FragColor = vec4(uColor * g * uIntensity, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.glow = new Mesh(new PlaneGeometry(2, 2), this.glowMat);
    this.object.add(this.disc, this.glow);
    this.object.name = `body:${body.id}`;
  }

  /** 0..1, lowered when seen through thick air or with the sun below the horizon. */
  set glowIntensity(v: number) {
    this.glowMat.uniforms.uIntensity!.value = v;
  }

  update(ctx: FrameContext): void {
    const b = this.body;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    const dist = b.position.distanceTo(ctx.cameraWorld);
    const r = b.radius * apparentSizeBoost(b.radius, dist, b.minApparentSize);
    this.disc.scale.setScalar(r);
    const corona = this.body.def.star?.coronaSize ?? 5;
    this.glow.scale.setScalar(r * corona);
    this.glow.quaternion.copy(ctx.camera.quaternion);
  }

  dispose(): void {
    this.disc.geometry.dispose();
    this.glow.geometry.dispose();
    this.glowMat.dispose();
  }
}
