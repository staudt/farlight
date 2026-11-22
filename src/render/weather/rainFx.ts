import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Points,
  DoubleSide,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/rng';
import type { RGB, WeatherDef } from '../../data/types';
import type { Body } from '../../sim/universe';
import type { FrameContext } from '../context';
import type { PostStack } from '../post';
import { quality } from '../quality';
import { precipFxSettings } from './settings';
import { smooth, weatherAmount } from './weatherMap';

const MAX_SHAFTS = 9;
const SPLASHES = 1400;
const SPLASH_RADIUS = 45;
const SPLASH_ALT = 110;

/** How each weather kind hangs from the cloud base: colour, how far down it reaches (fraction of the base height), strength. */
const SHAFT_KINDS: { kind: WeatherDef['kind']; color: RGB; reach: number; gain: number }[] = [
  { kind: 'rain', color: [0.42, 0.47, 0.55], reach: 1, gain: 1 },
  { kind: 'snow', color: [0.85, 0.88, 0.95], reach: 0.75, gain: 0.8 },
  { kind: 'acidRain', color: [0.72, 0.8, 0.25], reach: 0.3, gain: 1.2 },
  { kind: 'methaneRain', color: [0.9, 0.55, 0.2], reach: 0.85, gain: 0.9 },
];

interface Shaft {
  /** Body fixed unit direction of the shaft foot. */
  dir: Vector3;
  amount: number;
  target: number;
  seed: number;
  kind: number;
}

const shaftVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 iPos;
  attribute vec3 iUp;
  attribute vec4 iSize;
  attribute vec4 iColor;
  varying vec2 vUv;
  varying vec4 vSize;
  varying vec4 vColor;
  varying float vDist;
  void main() {
    // Cylinder billboard: always faces the camera, stands along the local up.
    vec3 toCam = normalize(iPos);
    vec3 right = normalize(cross(iUp, toCam) + 1.0e-6);
    float w = iSize.x;
    vec3 p = iPos + right * position.x * w * 0.5 + iUp * position.y * iSize.y;
    vUv = vec2(position.x, position.y);
    vSize = iSize;
    vColor = iColor;
    vDist = length(iPos);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const shaftFrag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime;
  uniform float uFlash;
  varying vec2 vUv;
  varying vec4 vSize;
  varying vec4 vColor;
  varying float vDist;
  float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = h11(i.x + i.y * 57.0), b = h11(i.x + 1.0 + i.y * 57.0);
    float c = h11(i.x + (i.y + 1.0) * 57.0), d = h11(i.x + 1.0 + (i.y + 1.0) * 57.0);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  void main() {
    #include <logdepthbuf_fragment>
    float amount = vColor.a;
    if (amount <= 0.003) discard;
    float x = vUv.x;
    float y = vUv.y;
    float seed = vSize.w;
    float h = vSize.y;
    // Soft sides, dense core.
    float side = pow(max(0.0, 1.0 - abs(x)), 1.8);
    // Veils: vertical streaks sliding down, thicker near the cloud, thinning toward the ground.
    float s1 = vn(vec2(x * 9.0 + seed * 31.0, y * 2.0 * (h / 3000.0) + uTime * 0.35));
    float s2 = vn(vec2(x * 24.0 - seed * 7.0, y * 6.0 * (h / 3000.0) + uTime * 0.7));
    float streak = 0.45 + 0.9 * s1 * (0.6 + 0.8 * s2);
    // Hangs from the cloud base (y = 1) and frays away toward the foot (y = 0).
    float fray = smoothstep(0.0, 0.85, y) * (0.55 + 0.45 * smoothstep(0.0, 0.5, y));
    float top = 1.0 - 0.7 * smoothstep(0.9, 1.0, y);
    float near = smoothstep(vSize.x * 0.35, vSize.x * 1.4, vDist);
    float a = amount * side * streak * fray * top * near * 0.5;
    // Screen door: pixels are either veil or untouched, so the sky behind keeps its colour at the edges.
    float n = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy * 0.5), vec2(0.06711056, 0.00583715))) + uTime * 0.37);
    if (n > a * 2.4) discard;
    vec3 col = vColor.rgb * (0.75 + 0.5 * s1) * (1.0 + uFlash * 5.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const splashVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aSeed;
  uniform vec3 uE, uN, uUp;
  uniform float uAlt, uTime, uPx, uAmount, uRing, uRadius;
  uniform vec2 uOff;
  varying float vPhase;
  varying float vAlpha;
  varying float vElev;
  void main() {
    float rate = 1.1 + aSeed.z * 1.4;
    float ph = fract(uTime * rate + aSeed.x * 7.13);
    // Each drop lands somewhere new every cycle, so the pattern never repeats visibly.
    float cyc = floor(uTime * rate + aSeed.x * 7.13);
    vec2 sq = vec2(fract(aSeed.x * 91.7 + cyc * 0.618), fract(aSeed.y * 53.1 + cyc * 0.381)) * 2.0 * uRadius;
    // Stay put on the ground while the camera moves: wrap around the camera in the ground plane.
    sq = mod(sq - uOff + uRadius, 2.0 * uRadius) - uRadius;
    float r = length(sq);
    vec3 lp = uE * sq.x + uN * sq.y;
    vec3 p = lp - uUp * uAlt;
    float dist = length(p);
    vec3 mv0 = (modelViewMatrix * vec4(p, 0.0)).xyz;
    vec3 upV = normalize((modelViewMatrix * vec4(uUp, 0.0)).xyz);
    float vis = step(aSeed.y, uAmount) * (1.0 - smoothstep(0.6, 1.0, r / uRadius)) * smoothstep(2.0, 6.0, dist);
    vPhase = ph;
    vAlpha = vis;
    vElev = clamp(abs(dot(normalize(mv0), upV)), 0.1, 1.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float ringR = (0.12 + ph * 1.6 * uRing + 0.1);
    gl_PointSize = clamp(ringR * 2.2 * uPx / max(-mv.z, 0.5), 2.0, 70.0);
    #include <logdepthbuf_vertex>
  }
`;

const splashFrag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uRing;
  varying float vPhase;
  varying float vAlpha;
  varying float vElev;
  void main() {
    #include <logdepthbuf_fragment>
    if (vAlpha <= 0.002) discard;
    vec2 q = (gl_PointCoord - 0.5) * 2.0;
    // The point is a screen square lying flat on the water: squash it into a ripple ellipse.
    float d = length(vec2(q.x, q.y / vElev));
    float ring = smoothstep(0.09, 0.0, abs(d - (0.25 + 0.7 * vPhase))) * (1.0 - vPhase) * uRing;
    // Short lived splash crown at the start of the cycle.
    float crown = smoothstep(0.35, 0.0, d) * smoothstep(0.3, 0.0, vPhase) * 1.3;
    float a = (ring + crown) * vAlpha;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(uColor, min(a, 0.8));
  }
`;

/** Rain shafts hanging from storm cells, plus splashes and ripples around the camera. Both cost nothing when the sky is clear. */
export class RainFx {
  readonly object = new Group();
  private shafts: Shaft[] = [];
  private shaftGeo = new InstancedBufferGeometry();
  private shaftMat: ShaderMaterial;
  private shaftMesh: Mesh;
  private iPos = new Float32Array(MAX_SHAFTS * 3);
  private iUp = new Float32Array(MAX_SHAFTS * 3);
  private iSize = new Float32Array(MAX_SHAFTS * 4);
  private iColor = new Float32Array(MAX_SHAFTS * 4);
  private splashMat: ShaderMaterial;
  private splash: Points;
  private rnd = mulberry32(31);
  private sampleIn = 0;
  private splashAmount = 0;
  private up = new Vector3();
  private east = new Vector3();
  private north = new Vector3();
  private dirL = new Vector3();
  private dirW = new Vector3();
  private foot = new Vector3();
  private cand = new Vector3();
  private sunDir = new Vector3();

  constructor(private post: PostStack) {
    // Unit quad, x -1..1 across, y 0..1 up.
    this.shaftGeo.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    this.shaftGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr: Float32Array, n: number): InstancedBufferAttribute => new InstancedBufferAttribute(arr, n).setUsage(DynamicDrawUsage);
    this.shaftGeo.setAttribute('iPos', mk(this.iPos, 3));
    this.shaftGeo.setAttribute('iUp', mk(this.iUp, 3));
    this.shaftGeo.setAttribute('iSize', mk(this.iSize, 4));
    this.shaftGeo.setAttribute('iColor', mk(this.iColor, 4));
    this.shaftGeo.instanceCount = 0;
    this.shaftMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFlash: { value: 0 } },
      vertexShader: shaftVert,
      fragmentShader: shaftFrag,
      side: DoubleSide,
      transparent: true,
      // Writes depth: the atmosphere pass would otherwise treat the veil as sky at infinity and erase it.
      depthWrite: true,
    });
    this.shaftMesh = new Mesh(this.shaftGeo, this.shaftMat);
    this.shaftMesh.frustumCulled = false;
    this.shaftMesh.renderOrder = 9;
    this.shaftMesh.visible = false;

    const rnd = mulberry32(17);
    const pos = new Float32Array(SPLASHES * 3);
    const seed = new Float32Array(SPLASHES * 3);
    for (let i = 0; i < SPLASHES; i++) {
      seed[i * 3] = rnd();
      seed[i * 3 + 1] = (i + 0.5) / SPLASHES;
      seed[i * 3 + 2] = rnd();
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new Float32BufferAttribute(seed, 3));
    this.splashMat = new ShaderMaterial({
      uniforms: {
        uE: { value: new Vector3() },
        uN: { value: new Vector3() },
        uUp: { value: new Vector3() },
        uAlt: { value: 0 },
        uTime: { value: 0 },
        uPx: { value: 600 },
        uAmount: { value: 0 },
        uRing: { value: 1 },
        uRadius: { value: SPLASH_RADIUS },
        uOff: { value: new Vector2() },
        uColor: { value: new Vector3(0.6, 0.66, 0.74) },
      },
      vertexShader: splashVert,
      fragmentShader: splashFrag,
      transparent: true,
      depthWrite: false,
    });
    this.splash = new Points(g, this.splashMat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 10;
    this.splash.visible = false;
    this.object.add(this.shaftMesh, this.splash);
  }

  /** `rainAmount`: strength of rain at the camera 0..1 (from the precipitation layer). */
  update(ctx: FrameContext, rainAmount: number): void {
    const cam = ctx.cameraWorld;
    let body: Body | null = null;
    for (const b of ctx.world.universe.bodies) {
      const atm = b.def.atmosphere;
      if (!atm?.weather?.length || !atm.clouds) continue;
      if (b.position.distanceTo(cam) < b.radius + b.atmosphereHeight * 0.7) {
        body = b;
        break;
      }
    }
    if (!body || !precipFxSettings.enabled) {
      this.shaftMesh.visible = false;
      this.splash.visible = false;
      this.shafts.length = 0;
      this.splashAmount = 0;
      return;
    }
    const atm = body.def.atmosphere!;
    const clouds = atm.clouds!;
    const R = body.radius;
    const H = body.atmosphereHeight;
    const base = clouds.altitude * H;
    this.up.copy(cam).sub(body.position);
    const camAlt = this.up.length() - R;
    this.up.normalize();
    const dt = ctx.realDt;

    // Resample storm cells a couple of times a second.
    this.sampleIn -= dt;
    if (this.sampleIn <= 0) {
      this.sampleIn = 0.6;
      this.resample(ctx, body);
    }
    // Fade shafts in and out smoothly.
    const k = 1 - Math.exp(-dt * 1.2);
    for (let i = this.shafts.length - 1; i >= 0; i--) {
      const s = this.shafts[i]!;
      s.amount += (s.target - s.amount) * k;
      if (s.target === 0 && s.amount < 0.01) this.shafts.splice(i, 1);
    }

    // Light: dim at night, picks up the flash.
    this.sunDir.copy(ctx.world.universe.root.position).sub(body.position).normalize();
    const light = 0.12 + 0.88 * smooth(-0.15, 0.35, this.up.dot(this.sunDir));
    const flash = this.post.clouds.flash;
    const shown = this.shafts.length > 0 && camAlt < H * 0.9;
    this.shaftMesh.visible = shown;
    if (shown) {
      const n = Math.min(this.shafts.length, this.lowQuality() ? 4 : MAX_SHAFTS);
      for (let i = 0; i < n; i++) {
        const s = this.shafts[i]!;
        const kind = SHAFT_KINDS[s.kind]!;
        const def = atm.weather!.find((w) => w.kind === kind.kind);
        const c = def?.color ?? kind.color;
        // Foot at the sea level shell, world axes, relative to the camera in float64.
        this.dirW.copy(s.dir).applyQuaternion(body.rotation);
        this.foot.copy(this.dirW).multiplyScalar(R).add(body.position).sub(cam);
        const h = base * kind.reach * precipFxSettings.reach + 400;
        const width = R * 0.009 * (0.7 + 0.7 * s.seed) * precipFxSettings.width;
        const o3 = i * 3;
        const o4 = i * 4;
        this.iPos[o3] = this.foot.x;
        this.iPos[o3 + 1] = this.foot.y;
        this.iPos[o3 + 2] = this.foot.z;
        this.iUp[o3] = this.dirW.x;
        this.iUp[o3 + 1] = this.dirW.y;
        this.iUp[o3 + 2] = this.dirW.z;
        this.iSize[o4] = width;
        this.iSize[o4 + 1] = h;
        this.iSize[o4 + 2] = 0;
        this.iSize[o4 + 3] = s.seed * 10;
        const l = Math.min(1.5, light + flash * 1.5);
        this.iColor[o4] = c[0] * l;
        this.iColor[o4 + 1] = c[1] * l;
        this.iColor[o4 + 2] = c[2] * l;
        this.iColor[o4 + 3] = Math.min(1, s.amount * kind.gain * precipFxSettings.intensity);
      }
      this.shaftGeo.instanceCount = n;
      for (const name of ['iPos', 'iUp', 'iSize', 'iColor']) (this.shaftGeo.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true;
      this.shaftMat.uniforms.uTime!.value = ctx.realTime % 3600;
      this.shaftMat.uniforms.uFlash!.value = flash;
    }

    // Splashes and ripples on the ground under the camera, only when low and raining.
    const groundAlt = ctx.world.env.altitude;
    const lowFade = 1 - smooth(SPLASH_ALT * 0.5, SPLASH_ALT, groundAlt);
    const target = this.lowQuality() ? 0 : rainAmount * lowFade * precipFxSettings.splashes;
    this.splashAmount += (target - this.splashAmount) * (1 - Math.exp(-dt * 2));
    this.splash.visible = this.splashAmount > 0.01;
    if (!this.splash.visible) this.havePrev = false;
    if (this.splash.visible) {
      body.worldToLocalDir(this.up, this.dirL);
      const ground = ctx.world.groundHeight(body, this.dirL);
      const sea = (body.def.terrain?.seaLevel ?? -2) * (body.def.terrain?.amplitude ?? 0) * R;
      const water = body.def.terrain?.water && Math.abs(ground - sea) < 1 ? 1 : 0;
      const east = this.east.set(0, 1, 0).cross(this.up);
      if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      this.north.crossVectors(this.up, east);
      const u = this.splashMat.uniforms;
      (u.uE!.value as Vector3).copy(east);
      (u.uN!.value as Vector3).copy(this.north);
      (u.uUp!.value as Vector3).copy(this.up);
      // Ground fixed pattern: accumulate the camera's motion over the ground plane.
      if (this.havePrev) {
        this.delta.copy(cam).sub(this.prevCam);
        const off = u.uOff!.value as Vector2;
        off.x += this.delta.dot(east);
        off.y += this.delta.dot(this.north);
        off.x %= 1e5;
        off.y %= 1e5;
      }
      this.prevCam.copy(cam);
      this.havePrev = true;
      u.uAlt!.value = Math.max(0.5, groundAlt);
      u.uTime!.value = ctx.realTime % 3600;
      u.uPx!.value = (ctx.viewportHeight * ctx.renderer.getPixelRatio()) / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
      u.uAmount!.value = this.splashAmount * 0.55;
      u.uRing!.value = water ? 1 : 0.35;
      const l = Math.min(1.2, light + flash);
      (u.uColor!.value as Vector3).set(0.6 * l, 0.66 * l, 0.74 * l);
    }
    void camAlt;
  }

  private resample(ctx: FrameContext, body: Body): void {
    const atm = body.def.atmosphere!;
    const R = body.radius;
    const time = ctx.simTime;
    // Refresh the targets of the shafts we have.
    for (const s of this.shafts) {
      const def = atm.weather!.find((w) => w.kind === SHAFT_KINDS[s.kind]!.kind);
      s.target = def && weatherAmount(def, s.dir, time, body) > 0.35 ? 1 : 0;
    }
    const east = this.east.set(0, 1, 0).cross(this.up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    this.north.crossVectors(this.up, east);
    const rnd = this.rnd;
    const reach = Math.min(70_000, R * 0.1) * precipFxSettings.range;
    for (let i = 0; i < 28; i++) {
      const a = rnd() * Math.PI * 2;
      // Mostly mid distance: close cells would swallow the camera.
      const d = reach * (0.2 + 0.8 * Math.sqrt(rnd()));
      this.cand
        .copy(this.up)
        .addScaledVector(east, (Math.cos(a) * d) / R)
        .addScaledVector(this.north, (Math.sin(a) * d) / R)
        .normalize();
      body.worldToLocalDir(this.cand, this.dirL);
      for (let ki = 0; ki < SHAFT_KINDS.length; ki++) {
        const def = atm.weather!.find((w) => w.kind === SHAFT_KINDS[ki]!.kind);
        if (!def) continue;
        if (weatherAmount(def, this.dirL, time, body) < 0.5) continue;
        // Skip if a shaft already stands within a couple of kilometres.
        let close = false;
        for (const s of this.shafts) {
          if (s.dir.dot(this.dirL) > 1 - (2500 / R) * (2500 / R) * 0.5) {
            close = true;
            break;
          }
        }
        if (close) continue;
        if (this.shafts.length >= MAX_SHAFTS) {
          // Replace the farthest one.
          let far = 0;
          let farDot = 2;
          for (let j = 0; j < this.shafts.length; j++) {
            const dj = this.shafts[j]!.dir.dot(this.dirLocalOfCamera(body));
            if (dj < farDot) {
              farDot = dj;
              far = j;
            }
          }
          if (this.dirL.dot(this.dirLocalOfCamera(body)) <= farDot) continue;
          this.shafts.splice(far, 1);
        }
        this.shafts.push({ dir: this.dirL.clone(), amount: 0, target: 1, seed: rnd(), kind: ki });
        break;
      }
    }
  }

  /** The low preset (no bloom) keeps a few veils and drops the splashes. */
  private lowQuality(): boolean {
    return !quality.settings.bloom;
  }

  private camLocal = new Vector3();
  private prevCam = new Vector3();
  private delta = new Vector3();
  private havePrev = false;
  private dirLocalOfCamera(body: Body): Vector3 {
    return body.worldToLocalDir(this.up, this.camLocal);
  }
}
