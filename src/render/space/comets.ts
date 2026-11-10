import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { config } from '../../core/config';
import { Simplex3, fbm } from '../../core/noise';
import { type FrameContext, placeRelative } from '../context';
import { type ScaledComet, type TailGeometry, cometActivity, cometState, cometTails } from './spaceData';

const SEGMENTS = 28;

const RIBBON_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const RIBBON_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor, uCore;
  uniform float uIntensity, uTime, uSharp, uFall, uStreak, uStreakAmt, uSpeed, uLen;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    #include <logdepthbuf_fragment>
    float u = vUv.x;
    float s = vUv.y;
    float across = exp(-u * u * uSharp);
    float along = pow(max(0.0, 1.0 - s), uFall) * smoothstep(0.0, 0.05, s);
    float n = vnoise(vec2(u * uStreak + 3.0, s * uLen - uTime * uSpeed));
    n = 0.6 * n + 0.4 * vnoise(vec2(u * uStreak * 2.3, s * uLen * 2.1 - uTime * uSpeed * 1.4));
    float streak = mix(1.0, 0.25 + 1.5 * n, uStreakAmt);
    vec3 col = mix(uCore, uColor, smoothstep(0.0, 0.5, s));
    gl_FragColor = vec4(col * across * along * streak * uIntensity, 1.0);
  }`;

function ribbonMaterial(o: { color: Color; core: Color; sharp: number; fall: number; streak: number; amount: number; speed: number; len: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: o.color },
      uCore: { value: o.core },
      uIntensity: { value: 1 },
      uTime: { value: 0 },
      uSharp: { value: o.sharp },
      uFall: { value: o.fall },
      uStreak: { value: o.streak },
      uStreakAmt: { value: o.amount },
      uSpeed: { value: o.speed },
      uLen: { value: o.len },
    },
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: DoubleSide,
  });
}

class Ribbon {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly attr: BufferAttribute;

  constructor(material: ShaderMaterial) {
    this.material = material;
    const n = (SEGMENTS + 1) * 2;
    this.pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      uv.set([-1, s, 1, s], i * 4);
      if (i < SEGMENTS) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new BufferGeometry();
    this.attr = new BufferAttribute(this.pos, 3);
    geo.setAttribute('position', this.attr);
    geo.setAttribute('uv', new BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -6;
  }

  /**
   * Centerline at fraction s: direction * s * length plus a quadratic bend. `cometRel` is the
   * comet position relative to the camera (so ribbons face the viewer).
   */
  update(cometRel: Vector3, dir: Vector3, bend: Vector3, length: number, bendAmount: number, w0: number, w1: number, minAngle: number): void {
    const c = _c;
    const prev = _prev;
    const tan = _tan;
    const view = _view;
    const side = _side;
    prev.set(0, 0, 0);
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      c.copy(dir).multiplyScalar(s * length).addScaledVector(bend, s * s * length * bendAmount);
      tan.copy(c).sub(prev);
      if (i === 0) tan.copy(dir);
      tan.normalize();
      prev.copy(c);
      view.copy(cometRel).add(c); // from the camera to the point
      const d = view.length();
      side.crossVectors(tan, view).normalize();
      const w = Math.max(w0 + (w1 - w0) * s, d * minAngle);
      this.pos.set([c.x - side.x * w, c.y - side.y * w, c.z - side.z * w, c.x + side.x * w, c.y + side.y * w, c.z + side.z * w], i * 6);
    }
    this.attr.needsUpdate = true;
  }
}

const _c = new Vector3();
const _prev = new Vector3();
const _tan = new Vector3();
const _view = new Vector3();
const _side = new Vector3();

/** One comet: nucleus, glowing coma and two tails (a straight blue ion tail, a curved pale dust tail). */
export class CometView {
  readonly object = new Group();
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  private readonly nucleus: Mesh;
  private readonly coma: Mesh;
  private readonly comaMat: ShaderMaterial;
  private readonly ion: Ribbon;
  private readonly dust: Ribbon;
  private readonly tails: TailGeometry = { ion: new Vector3(), dust: new Vector3(), bend: new Vector3() };
  private readonly rel = new Vector3();

  constructor(readonly comet: ScaledComet) {
    const d = comet.def;
    this.object.name = `comet:${d.id}`;
    const noise = new Simplex3(d.seed);
    const g = new IcosahedronGeometry(1, 2);
    const p = g.getAttribute('position');
    const v = new Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      v.multiplyScalar(1 + 0.32 * fbm(noise, v.x * 1.4, v.y * 1.4, v.z * 1.4, 3));
      v.x *= 1.25;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    this.nucleus = new Mesh(g, new MeshLambertMaterial({ color: new Color(0.16, 0.14, 0.13), flatShading: true }));
    this.nucleus.scale.setScalar(d.nucleusRadius);

    this.comaMat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color(...d.dustColor).lerp(new Color(...d.ionColor), 0.35) }, uIntensity: { value: 1 } },
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
          float g = exp(-r * 10.0) * 2.8 + exp(-r * 3.4) * 0.6 + exp(-r * 1.6) * 0.12;
          g *= smoothstep(1.0, 0.6, r);
          gl_FragColor = vec4(mix(uColor, vec3(1.0), exp(-r * 12.0)) * g * uIntensity, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.coma = new Mesh(new PlaneGeometry(2, 2), this.comaMat);
    this.coma.renderOrder = -5;

    const ionColor = new Color(...d.ionColor);
    const dustColor = new Color(...d.dustColor);
    this.ion = new Ribbon(
      ribbonMaterial({ color: ionColor.clone().multiplyScalar(2.2), core: new Color(0.85, 0.95, 1).multiplyScalar(2.6), sharp: 5.5, fall: 1.35, streak: 5, amount: 0.85, speed: 0.9, len: 14 }),
    );
    this.dust = new Ribbon(
      ribbonMaterial({ color: dustColor.clone().multiplyScalar(0.9).lerp(new Color(0.8, 0.6, 0.5), 0.35), core: dustColor.clone().multiplyScalar(2.0), sharp: 2.3, fall: 1.7, streak: 3, amount: 0.45, speed: 0.12, len: 5 }),
    );
    this.object.add(this.nucleus, this.coma, this.ion.mesh, this.dust.mesh);
  }

  /** Activity 0..1 at the current position, for the map and the toast. */
  activity = 0;

  update(ctx: FrameContext): void {
    const w = ctx.world;
    const c = this.comet;
    this.object.visible = config.space.enabled;
    if (!config.space.enabled) return;
    cometState(c, ctx.simTime, this.position, this.velocity);
    const star = w.universe.root.position;
    const r = this.position.distanceTo(star);
    this.activity = cometActivity(c, r);
    placeRelative(this.object, this.position, ctx.cameraWorld);
    this.rel.copy(this.object.position);
    const dist = this.rel.length();
    const a = this.activity;

    cometTails(this.position, this.velocity, star, this.tails);

    // Nucleus tumbles; the coma billboard keeps a minimum apparent size so the comet reads from far away.
    this.nucleus.rotation.set(ctx.realTime * 0.05, ctx.realTime * 0.08, 0);
    const comaTrue = c.tailLength * (0.012 + 0.05 * a);
    const comaR = Math.max(comaTrue, dist * 0.011) * (1 + 0.0 * a);
    this.coma.scale.setScalar(comaR);
    this.coma.quaternion.copy(ctx.camera.quaternion);
    this.comaMat.uniforms.uIntensity!.value = (0.35 + 1.5 * a) * config.space.cometGlow;

    // Tails grow with activity.
    const grow = config.space.cometTail;
    const ionLen = c.tailLength * (0.04 + 0.96 * Math.pow(a, 1.2)) * grow;
    const dustLen = ionLen * 0.62;
    const minAngle = 0.0016;
    const t = ctx.realTime;
    const visible = a > 0.01;
    this.ion.mesh.visible = this.dust.mesh.visible = visible;
    if (visible) {
      this.ion.update(this.rel, this.tails.ion, this.tails.bend, ionLen, 0.0, comaTrue * 0.5, ionLen * 0.02 + comaTrue * 0.3, minAngle);
      this.dust.update(this.rel, this.tails.dust, this.tails.bend, dustLen, 0.42, comaTrue * 0.9, dustLen * 0.16 + comaTrue, minAngle * 1.4);
      const gl = config.space.cometGlow;
      this.ion.material.uniforms.uIntensity!.value = (0.25 + 1.35 * a) * gl;
      this.dust.material.uniforms.uIntensity!.value = (0.2 + 1.0 * a) * gl;
      this.ion.material.uniforms.uTime!.value = t;
      this.dust.material.uniforms.uTime!.value = t;
    }
  }
}
