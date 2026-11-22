import {
  AdditiveBlending,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { config } from '../../core/config';
import { hashInts } from '../../core/rng';
import type { Body } from '../../sim/universe';
import { eclipse } from '../eclipse';
import { quality } from '../quality';
import { type BodyView, type FrameContext, apparentSizeBoost, placeRelative } from '../context';
import { Prominences } from './sun/prominences';
import { discPixelRadius, starLook, surfaceDetail } from './sun/starLook';
import { createSurfaceMaterial } from './sun/surface';

const MAX_ARCS = 6;

/**
 * Emissive star disc plus a camera facing corona glow. HDR values feed the bloom pass.
 * From far away it is a clean bright disc with a hot core; surface detail (granulation, limb
 * darkening, spots, faculae), corona streamers and prominence arcs fade in with the disc's pixel footprint.
 */
export class SunView implements BodyView {
  readonly body: Body;
  readonly object = new Group();
  private disc: Mesh;
  private glow: Mesh;
  private glowMat: ShaderMaterial;
  private discMat: ShaderMaterial;
  private spin = new Group();
  private prom: Prominences;
  private look;

  constructor(body: Body) {
    this.body = body;
    const c = body.def.star?.color ?? body.def.visual.color;
    const color = new Color(c[0], c[1], c[2]);
    this.look = starLook(body.def.star, body.def.visual.color, body.def.seed);
    this.discMat = createSurfaceMaterial();
    this.discMat.uniforms.uTint!.value = color.clone();
    this.discMat.uniforms.uSeed!.value.set(...[0, 1, 2].map((i) => (hashInts(body.def.seed, 0x51, i) % 4096) / 64) as [number, number, number]);
    this.disc = new Mesh(new IcosahedronGeometry(1, 5), this.discMat);
    const h = this.look.heat;
    const hot = Math.min(1, Math.max(0, (h - 0.7) * 3));
    const pc = new Color(1, 0.22, 0.1).lerp(new Color(0.55, 0.72, 1), hot);
    pc.multiply(color).multiplyScalar(1.5);
    this.prom = new Prominences(body.def.seed, MAX_ARCS, pc);
    this.glowMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uIntensity: { value: 1 },
        uScorch: { value: 0 },
        uStream: { value: 0 },
        uBase: { value: 1 },
        uDisc: { value: 0.16 },
        uTf: { value: 1 },
        uTime: { value: 0 },
        uSeedF: { value: ((hashInts(body.def.seed, 0x77) % 1000) / 10) },
      },
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
        uniform float uIntensity, uScorch, uBase, uStream, uDisc, uTf, uTime, uSeedF;
        varying vec2 vUv;
        float cH(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float cN(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(cH(i), cH(i + vec2(1.0, 0.0)), f.x), mix(cH(i + vec2(0.0, 1.0)), cH(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          #include <logdepthbuf_fragment>
          float rr0 = length(vUv);
          // The plane may be enlarged for the corona (totality): the base glow keeps its size.
          float rr = rr0 * uTf;
          // The plane grows with the scorch, so the core keeps its size while the halo spreads.
          float r = rr * (1.0 + 2.2 * uScorch);
          float g = exp(-r * 7.0) * 2.5 + exp(-r * 2.2) * 0.35;
          // Scorching: a white hot, blown out glow across the sky around the sun.
          g += uScorch * (exp(-r * 1.1) * 1.4 + exp(-r * 4.0) * 3.0);
          g *= smoothstep(1.0, 0.55, rr);
          // Soft rays
          float a = atan(vUv.y, vUv.x);
          g *= 0.85 + 0.15 * sin(a * 12.0) * smoothstep(0.05, 0.4, r);
          vec3 col = mix(uColor, vec3(1.0, 0.97, 0.9), 0.75 * uScorch);
          vec3 outc = col * g * uIntensity * uBase;
          if (uStream > 0.001) {
            // Corona streamers: radial noise stretched along the rays, slowly evolving.
            float x = max(rr0 / uDisc, 1.0);
            vec2 dir = vUv / max(rr0, 1e-4);
            float t = uTime * 0.02;
            float s1 = cN(dir * 2.6 + vec2(x * 0.09, t) + uSeedF);
            float s2 = cN(dir * 6.5 + vec2(x * 0.16, -t * 1.3) + uSeedF * 1.7);
            float s3 = cN(dir * 14.0 + vec2(x * 0.3, t * 0.7) + uSeedF * 2.3);
            float st = smoothstep(0.42, 0.85, s1 * 0.5 + s2 * 0.32 + s3 * 0.18);
            float fall = exp(-(x - 1.0) * 0.85) / (0.6 + 0.4 * x);
            float body = 0.12 * exp(-(x - 1.0) * 1.4);
            float c = (st * 0.55 * fall + body) * smoothstep(1.0, 0.7, rr0);
            outc += mix(uColor, vec3(1.0), 0.55) * c * uStream * uIntensity;
          }
          gl_FragColor = vec4(outc, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.glow = new Mesh(new PlaneGeometry(2, 2), this.glowMat);
    this.spin.add(this.disc, this.prom.mesh);
    this.object.add(this.spin, this.glow);
    this.prom.setCount(0);
    this.object.name = `body:${body.id}`;
  }

  /** 0..1, lowered when seen through thick air or with the sun below the horizon. */
  set glowIntensity(v: number) {
    this.glowMat.uniforms.uIntensity!.value = v;
  }

  /** 0..1, set by the scorching effect: a bigger, harsher, whiter sun. */
  set scorch(v: number) {
    this.glowMat.uniforms.uScorch!.value = v;
    this.scorchAmount = v;
  }

  private scorchAmount = 0;

  update(ctx: FrameContext): void {
    const b = this.body;
    const cfg = config.sun;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    const dist = b.position.distanceTo(ctx.cameraWorld);
    const boost = apparentSizeBoost(b.radius, dist, b.minApparentSize);
    const rTrue = b.radius * boost;
    // While a body crosses the sun the disc shrinks to the shadow sun, so a total cover hides all of it.
    const r = rTrue * eclipse.discScale;
    this.spin.quaternion.copy(b.rotation);

    // Footprint driven detail: nothing extra while the sun is a small disc in the sky.
    const px = discPixelRadius(rTrue, dist, ctx.camera.fov, ctx.viewportHeight);
    const detail = cfg.enabled ? surfaceDetail(px, cfg.detailStart, cfg.detailFull) : 0;
    const sc = config.eclipse.sunSizeScale;
    const total = cfg.enabled && sc < 1 ? Math.min(1, Math.max(0, (1 - eclipse.discScale) / (1 - sc))) : 0;
    const q = cfg.byQuality[quality.name];
    const look = this.look;
    const du = this.discMat.uniforms;
    du.uDetail!.value = detail;
    du.uGain!.value = cfg.skyGain + (cfg.closeGain - cfg.skyGain) * detail;
    if (detail > 0) {
      du.uTime!.value = ctx.realTime * cfg.churn;
      // An octave fades out when its cells would shrink to a few pixels.
      const o = du.uOct!.value as Vector3;
      const f0 = cfg.granuleScale;
      const w = (i: number): number => (i < q.octaves ? Math.min(1, Math.max(0, (px / (f0 * 2.1 ** i) - 2.5) / 3.5)) : 0);
      o.set(w(0), w(1), w(2));
      du.uGranule!.value = f0;
      du.uGranuleAmt!.value = look.granuleContrast * cfg.granulation;
      (du.uLimbU!.value as Vector3).set(look.limbU[0], look.limbU[1], look.limbU[2]).multiplyScalar(cfg.limb);
      du.uSpotThr!.value = look.spotThreshold;
      du.uSpotAmt!.value = cfg.spots;
      du.uFacula!.value = look.faculae * cfg.faculae;
    }

    const stream = Math.max(detail, total * 2.4) * cfg.streamers;
    const tf = 1 + (cfg.totalityCorona - 1) * total;
    const corona = this.body.def.star?.coronaSize ?? 5;
    const gm = this.glowMat.uniforms;
    gm.uStream!.value = stream;
    // A big disc needs less halo: the bloom pass adds its own.
    gm.uBase!.value = 1 - cfg.closeHalo * detail;
    gm.uTf!.value = tf;
    gm.uTime!.value = ctx.realTime;
    gm.uDisc!.value = 1 / (corona * (1 + 2.2 * this.scorchAmount) * tf);
    this.glow.scale.setScalar(r * corona * (1 + 2.2 * this.scorchAmount) * tf);
    this.glow.quaternion.copy(ctx.camera.quaternion);

    const arcs = cfg.enabled && detail > 0.02 ? Math.round(q.arcs * (0.5 + 0.5 * look.activity)) : 0;
    this.prom.setCount(arcs);
    if (arcs > 0) this.prom.update(ctx.realTime * cfg.churn, detail * cfg.prominences, r);
    this.spin.scale.setScalar(r);
  }

  dispose(): void {
    this.disc.geometry.dispose();
    this.discMat.dispose();
    this.prom.dispose();
    this.glow.geometry.dispose();
    this.glowMat.dispose();
  }
}
