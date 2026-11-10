import {
  CustomBlending,
  OneFactor,
  ZeroFactor,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { config } from '../../core/config';
import type { FrameContext } from '../context';
import { placeRelative } from '../context';
import { starLight } from '../starLight';

/**
 * First person cockpit: thin canopy struts, the ship's nose, a slim dash with HDR instrument
 * lights and a faint fresnel glass shell. Everything is modelled in eye space (origin at the
 * pilot's eye, forward -Z) and stays beyond 1 m of the eye so the 0.5 m near plane never
 * clips it. Lit by the scene lights like the ship, so only the instruments glow at night.
 */

const SEGMENTS = 10;
const DASH_TILT = 0.178;

const GLASS_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const GLASS_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uLit, uHeat, uTime, uStrength;
  uniform vec3 uTint;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 v = normalize(-vV);
    float face = clamp(abs(dot(normalize(vN), v)), 0.0, 1.0); // face can round above 1: pow of a negative is NaN, and one NaN pixel blacks out the frame through bloom
    float fres = pow(1.0 - face, 2.2);
    // A thin, soft diagonal glint stripe (only near the stripe centre), in daylight only.
    float d = abs(fract(vV.x * 0.35 - vV.y * 0.55 + 0.3) - 0.5);
    float band = smoothstep(0.035, 0.0, d);
    // Glass only shows at grazing angles: no tint across the open view, so space stays black.
    vec3 col = uTint * 1.6 * fres * fres * uLit + vec3(0.55, 0.75, 1.0) * band * 0.025 * uLit;
    col *= uStrength;
    // Re-entry plasma licks the edges of the glass.
    float edge = pow(1.0 - face, 1.4);
    float flick = 0.8 + 0.2 * sin(uTime * 23.0 + vV.x * 3.0) * sin(uTime * 17.0 + vV.y * 4.0);
    vec3 plasma = mix(vec3(2.4, 0.7, 0.12), vec3(2.6, 1.4, 1.2), smoothstep(0.5, 1.0, edge));
    col += plasma * edge * uHeat * flick * 0.9;
    gl_FragColor = vec4(col, 1.0);
  }`;

function strut(a: Vector3, b: Vector3, r: number, mat: MeshStandardMaterial): Mesh {
  const len = a.distanceTo(b);
  const m = new Mesh(new CylinderGeometry(r * 0.8, r, len, 5, 1), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

function noseGeometry(): BufferGeometry {
  type P = [number, number, number];
  const A: P = [0, -0.8, -1.6];
  const Al: P = [-0.07, -0.83, -1.6];
  const Ar: P = [0.07, -0.83, -1.6];
  const L: P = [-0.3, -0.95, -1.6];
  const R: P = [0.3, -0.95, -1.6];
  const B: P = [0, -1.2, -1.6];
  const T: P = [0, -1.05, -8.5];
  const WHITE = [0.92, 0.93, 0.95];
  const GREY = [0.55, 0.58, 0.64];
  const RED = [0.78, 0.08, 0.07];
  const tris: [P, P, P, number[]][] = [
    [L, Al, T, WHITE],
    [Ar, R, T, WHITE],
    [Al, A, T, RED],
    [A, Ar, T, RED],
    [L, B, T, GREY],
    [B, R, T, GREY],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  for (const [p, q, r, c] of tris) {
    for (const v of [p, q, r]) {
      pos.push(v[0], v[1], v[2]);
      col.push(c[0]!, c[1]!, c[2]!);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export class Cockpit {
  readonly object = new Group();
  private readonly eye = new Group();
  private readonly glassMat: ShaderMaterial;
  private readonly dash: Group;
  private readonly bar: MeshBasicMaterial[] = [];
  private readonly boostLights: MeshBasicMaterial[] = [];
  private readonly dots: MeshBasicMaterial[] = [];
  private readonly lip: MeshBasicMaterial;
  private readonly warn: MeshBasicMaterial;
  private thr = 0;
  private boost = 0;
  private heat = 0;
  private readonly sunDir = new Vector3();
  private readonly up = new Vector3();

  constructor() {
    this.object.add(this.eye);
    // Light grey metal so the frame reads as structure in daylight, not as a black cut out.
    const dark = new MeshStandardMaterial({ color: 0x5a6472, flatShading: true, metalness: 0.3, roughness: 0.55 });

    // Canopy frame: two pillars and a bow across the top.
    const frame = new Group();
    const zf = -1.45;
    for (const s of [-1, 1]) {
      frame.add(strut(new Vector3(s * 1.5, -0.7, zf + 0.05), new Vector3(s * 0.95, 0.76, zf), 0.0075, dark));
    }
    const bow: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const x = -0.95 + 1.9 * t;
      bow.push(new Vector3(x, 0.76 + 0.05 * (1 - Math.pow(2 * t - 1, 2)), zf));
    }
    for (let i = 0; i < bow.length - 1; i++) frame.add(strut(bow[i]!, bow[i + 1]!, 0.007, dark));
    this.eye.add(frame);

    // Nose of the ship, ahead and below the horizon.
    const nose = new Mesh(
      noseGeometry(),
      new MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.15, roughness: 0.55, side: DoubleSide }),
    );
    this.eye.add(nose);

    // Dash: a slim tilted slab with instrument strips on its top face.
    this.dash = new Group();
    this.dash.position.set(0, -0.82, -1.15);
    this.dash.rotation.x = DASH_TILT;
    const slab = new Mesh(new BoxGeometry(6, 0.1, 0.7), dark);
    this.dash.add(slab);
    const top = 0.052;
    const strip = new BoxGeometry(1, 0.006, 1);
    const addLight = (x: number, z: number, w: number, d: number, mat: MeshBasicMaterial): void => {
      const m = new Mesh(strip, mat);
      m.position.set(x, top, z);
      m.scale.set(w, 1, d);
      this.dash.add(m);
    };
    this.lip = new MeshBasicMaterial({ color: 0x000000 });
    addLight(0, -0.335, 3.2, 0.012, this.lip);
    // Throttle bar left of centre.
    for (let i = 0; i < SEGMENTS; i++) {
      const mat = new MeshBasicMaterial({ color: 0x000000 });
      this.bar.push(mat);
      addLight(-0.95 + i * 0.075, -0.2, 0.05, 0.1, mat);
    }
    // Boost lights right of centre.
    for (let i = 0; i < 4; i++) {
      const mat = new MeshBasicMaterial({ color: 0x000000 });
      this.boostLights.push(mat);
      addLight(0.35 + i * 0.075, -0.2, 0.05, 0.1, mat);
    }
    // Tiny blinkers.
    for (let i = 0; i < 5; i++) {
      const mat = new MeshBasicMaterial({ color: 0x000000 });
      this.dots.push(mat);
      addLight(-0.2 + i * 0.1, -0.08, 0.02, 0.02, mat);
    }
    this.warn = new MeshBasicMaterial({ color: 0x000000 });
    addLight(0.8, -0.2, 0.06, 0.1, this.warn);
    this.eye.add(this.dash);

    // Glass: an inside-out sphere offset behind the eye so the fresnel varies across the view.
    this.glassMat = new ShaderMaterial({
      uniforms: {
        uLit: { value: 1 },
        uHeat: { value: 0 },
        uTime: { value: 0 },
        uStrength: { value: 1 },
        uTint: { value: new Vector3(0.025, 0.06, 0.09) },
      },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      side: BackSide,
    });
    const glass = new Mesh(new SphereGeometry(2.4, 28, 18), this.glassMat);
    glass.position.set(0, -0.2, 1.0);
    glass.renderOrder = 5;
    this.eye.add(glass);
    this.eye.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  update(ctx: FrameContext, aspect: number): void {
    const w = ctx.world;
    const ship = w.ship;
    const c = config.camera.cockpit;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);
    const o = config.camera.cockpitOffset;
    this.eye.position.set(o[0], o[1], o[2]);
    // Slimmer dash on wide screens (phones in landscape).
    this.dash.position.y = -0.82 - Math.min(0.08, Math.max(0, aspect - 1.78) * 0.2);

    const t = ctx.realTime;
    const k = 1 - Math.exp(-ctx.realDt / 0.2);
    this.thr += ((ship.landed ? 0 : ship.throttle) - this.thr) * k;
    this.boost += ((ship.boosting && !ship.landed ? 1 : 0) - this.boost) * k;
    const heatTarget = Math.min(1, ship.stress * 1.6);
    this.heat += (heatTarget - this.heat) * (1 - Math.exp(-ctx.realDt / 0.4));

    const g = c.instrumentGlow;
    for (let i = 0; i < SEGMENTS; i++) {
      const lit = Math.min(1, Math.max(0, this.thr * SEGMENTS - i));
      const on = 0.06 + 1.1 * lit;
      this.bar[i]!.color.setRGB(0.12 * on * g, 0.7 * on * g, 1.3 * on * g);
    }
    for (let i = 0; i < this.boostLights.length; i++) {
      const lit = Math.min(1, Math.max(0, this.boost * 4 - i));
      const pulse = 0.8 + 0.2 * Math.sin(t * 14 + i);
      const on = 0.04 + 1.3 * lit * pulse;
      this.boostLights[i]!.color.setRGB(1.5 * on * g, 0.75 * on * g, 0.18 * on * g);
    }
    for (let i = 0; i < this.dots.length; i++) {
      const ph = (t * (0.45 + 0.13 * i) + i * 0.37) % 1;
      const on = ph < 0.12 ? 1 : 0.12;
      this.dots[i]!.color.setRGB(0.1 * on * g, 0.9 * on * g, 1.0 * on * g);
    }
    const beat = 0.75 + 0.25 * Math.sin(t * 1.2);
    this.lip.color.setRGB(0.05 * beat * g, 0.32 * beat * g, 0.6 * beat * g);
    const alarm = this.heat > 0.15 ? (Math.sin(t * 9) > 0 ? 1 : 0.2) * this.heat : 0.03;
    this.warn.color.setRGB(2.2 * alarm * g, 0.3 * alarm * g, 0.05 * alarm * g);

    // Daylight factor: sun above the local horizon (always lit in space).
    const body = ship.frame.body;
    let lit = 1;
    if (body.kind !== 'star') {
      this.up.copy(w.shipWorldPos).sub(body.position).normalize();
      this.sunDir.copy(w.universe.root.position).sub(w.shipWorldPos).normalize();
      const day = Math.min(1, Math.max(0, this.up.dot(this.sunDir) * 3 + 0.5));
      lit = 0.15 + 0.85 * day;
    }
    const u = this.glassMat.uniforms;
    u.uLit!.value = lit * Math.min(1.6, starLight.intensity);
    u.uHeat!.value = this.heat;
    u.uTime!.value = t;
    u.uStrength!.value = c.glass;
  }
}
