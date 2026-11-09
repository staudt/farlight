import {
  Color,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import { mulberry32 } from '../../core/rng';
import type { Body } from '../../sim/universe';
import { type BodyView, type FrameContext, apparentSizeBoost, placeRelative } from '../context';
import { quality } from '../quality';
import { starLight } from '../starLight';
import { RING_GLSL, RingMesh, makeRingUniforms } from './ringView';

const MAX_BANDS = 8;
const MAX_STORMS = 4;
/** Period of the flow cross-fade (sim seconds). Bounds how far the zonal jets can shear the noise. */
const FLOW_PERIOD = 43200;
/** Cloud-deck shell depths as fractions of the full deck depth. */
const SHELL_DEPTHS = [0.3, 0.6, 1.0];
const SHELL_ALPHA = [0.55, 0.75, 1.0];
const PUFFS_PER_LAYER = 300;
const PUFF_CUBE = 36000;
const PUFF_RANGE = 22000;

const GAS_GLSL = /* glsl */ `
uniform vec3 uBands[${MAX_BANDS}];
uniform float uBandCount, uBandFreq, uTurb, uSeed, uPhase, uStormN, uHasRing;
uniform int uGasOct; // quality: noise octaves, <= 4
uniform vec4 uStorm[${MAX_STORMS}];
uniform vec3 uStormCol[${MAX_STORMS}];
${RING_GLSL}

float gHash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
float gH31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float gNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gH31(i), gH31(i + vec3(1, 0, 0)), f.x), mix(gH31(i + vec3(0, 1, 0)), gH31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(gH31(i + vec3(0, 0, 1)), gH31(i + vec3(1, 0, 1)), f.x), mix(gH31(i + vec3(0, 1, 1)), gH31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float gFbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { if (i >= uGasOct) break; s += a * gNoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s / (1.0 - a * 2.0); // a has halved once per octave: normalizes any octave count
}
vec3 palette(float i) {
  int n = int(uBandCount);
  int idx = int(floor(gHash(i + uSeed) * float(n)));
  // Never repeat the previous band's color.
  int prev = int(floor(gHash(i - 1.0 + uSeed) * float(n)));
  if (idx == prev) idx = (idx + 1) % n;
  return uBands[idx];
}
/** Zonal wind (rad/s): alternating jets at band centers, strong equatorial flow. */
float zonalJet(float lat) {
  float b = lat / 3.14159265 * uBandFreq;
  return (sin(b * 3.14159265) * 0.6 + 0.5 * exp(-lat * lat * 10.0)) * 2.4e-5;
}
vec2 flowSample(vec3 d, float off) {
  float cs = cos(off), sn = sin(off);
  vec3 q = vec3(cs * d.x + sn * d.z, d.y, -sn * d.x + cs * d.z);
  float w = gFbm(q * vec3(2.2, 4.5, 2.2) + uSeed);
  float v = gFbm(q * vec3(5.5, 24.0, 5.5) + vec3(w * 1.7, 0.0, w * 1.7) * (0.4 + uTurb) + 7.0);
  return vec2(w, v);
}

/** Albedo of the cloud deck seen in direction d (unit, body fixed). depth: 0 tops .. 1 floor. */
vec3 deckColor(vec3 d, float depth) {
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(-d.z, d.x);
  float jt = zonalJet(lat);
  float ph0 = uPhase;
  float ph1 = fract(uPhase + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 s0 = flowSample(d, jt * ${FLOW_PERIOD.toFixed(1)} * (ph0 - 0.5));
  vec2 s1 = flowSample(d, jt * ${FLOW_PERIOD.toFixed(1)} * (ph1 - 0.5));
  vec2 s = mix(s1, s0, w0);

  float b0 = lat / 3.14159265 * uBandFreq + 0.37;
  float f0 = fract(b0);
  float edgeW = exp(-pow(min(f0, 1.0 - f0) * 4.0, 2.0));
  float b = b0 + (s.x - 0.5) * uTurb * (0.3 + 1.1 * edgeW) * 1.9 + (s.y - 0.5) * 0.1 * uTurb;

  // Storm geometry first so the bands can bend around the ovals.
  vec3 q3[${MAX_STORMS}];
  for (int i = 0; i < ${MAX_STORMS}; i++) {
    if (float(i) >= uStormN) break;
    vec4 S = uStorm[i];
    float dl = lon - S.y;
    dl = atan(sin(dl), cos(dl));
    vec2 q = vec2(dl * cos(S.x) / S.z, (lat - S.x) / S.w);
    q3[i] = vec3(q, length(q));
    b += 0.5 * exp(-q3[i].z * q3[i].z * 0.45) * clamp(q.y, -1.2, 1.2) * smoothstep(3.0, 0.5, q3[i].z);
  }

  float i0 = floor(b);
  float f = fract(b);
  vec3 col = mix(palette(i0 - 1.0), palette(i0), smoothstep(0.0, 0.32 + 0.12 * uTurb, f));
  col *= (0.72 + 0.5 * gHash(i0 * 1.7 + uSeed)) * (1.0 + 0.12 * (1.0 - 2.0 * mod(i0, 2.0)));
  col = pow(max(col, vec3(0.0)), vec3(1.7)) * 1.5;
  col = mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, 1.35);
  col *= 0.8 + 0.4 * s.y;
  col = mix(col, vec3(1.0, 0.95, 0.86) * dot(col, vec3(0.33)) * 1.6, smoothstep(0.66, 0.92, s.y) * 0.22 * (0.4 + uTurb));

  for (int i = 0; i < ${MAX_STORMS}; i++) {
    if (float(i) >= uStormN) break;
    vec3 q = q3[i];
    float r = q.z;
    float ang = atan(q.y, q.x);
    float spiral = sin(ang * 2.0 + log(r + 0.06) * 5.0 - uPhase * 12.566 + (s.x - 0.5) * 2.0);
    float mask = 1.0 - smoothstep(0.74, 1.0, r + (s.y - 0.5) * 0.28);
    vec3 inner = pow(uStormCol[i], vec3(1.5)) * 1.3 * (0.8 + 0.35 * spiral) * (0.8 + 0.35 * r);
    col = mix(col, inner, mask * 0.93);
    float collar = smoothstep(0.92, 1.1, r) * (1.0 - smoothstep(1.1, 1.5, r));
    col = mix(col, vec3(1.0, 0.92, 0.8) * (dot(col, vec3(0.33)) + 0.25), collar * 0.28);
  }

  // Polar haze: cooler, flatter and a little darker.
  float pole = smoothstep(0.62, 1.0, abs(d.y));
  vec3 avg = vec3(0.0);
  for (int i = 0; i < ${MAX_BANDS}; i++) { if (float(i) >= uBandCount) break; avg += uBands[i]; }
  avg /= uBandCount;
  col = mix(col, avg * vec3(0.72, 0.82, 0.98) * 0.8, pole * 0.55);

  // Deeper decks are darker, warmer and moodier.
  col = mix(col, col * vec3(1.05, 0.62, 0.4) * 0.5 + vec3(1.1, 0.42, 0.14) * (0.5 + 0.5 * s.y), depth);
  return col;
}
`;

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * Analytic sphere (per pixel ray vs sphere), so the limb is exact at any range and the camera
 * can sit just below the cloud tops without being cut by mesh facets. Draws as a screen quad
 * and writes its own log depth.
 */
const SHELL_FRAG = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
#endif
uniform mat4 uProjInv;
uniform mat3 uViewToLocal;
uniform vec3 uCamLocal, uSunLocal, uFogColor, uStarColor;
uniform float uScale, uShellR, uDepth, uAlpha, uPixAng, uInside, uFogLen, uSunI, uCamDepth, uCeil;
varying vec2 vNdc;
${GAS_GLSL}
void main() {
  vec4 v = uProjInv * vec4(vNdc, -1.0, 1.0);
  vec3 vd = normalize(v.xyz / v.w);
  vec3 rd = normalize(uViewToLocal * vd);
  vec3 ro = uCamLocal;
  float b = dot(ro, rd);
  float c = dot(ro, ro) - uShellR * uShellR;
  float disc = b * b - c;
  float coverage = 1.0;
  float t;
  if (c > 0.0) {
    // Outside: soft one pixel limb.
    float rho = sqrt(max(dot(ro, ro) - b * b, 0.0));
    float pix = max(abs(b), 1e-4) * uPixAng;
    coverage = clamp((uShellR - rho) / pix + 0.5, 0.0, 1.0);
    if (coverage <= 0.0 || b >= 0.0) discard;
    float sq = sqrt(max(disc, 0.0));
    t = c / (-b + sq);
  } else {
    t = -b + sqrt(max(disc, 0.0));
    // The cloud-top ceiling thins out as you approach the tops from below.
    coverage = mix(1.0, smoothstep(0.0, 9000.0, uCamDepth), uCeil);
    if (coverage <= 0.003) discard;
  }
  vec3 p = ro + rd * t;
  vec3 N = p / uShellR;

  float lam = dot(N, uSunLocal);
  float term = smoothstep(-0.14, 0.4, lam);
  float diff = mix(term * term, max(lam, 0.0), 0.55);
  float rs = uHasRing > 0.5 ? ringShadowAt(N * uShellR, uSunLocal) : 0.0;
  diff *= 1.0 - 0.92 * rs;
  vec3 sunCol = mix(vec3(1.0, 0.5, 0.28), vec3(1.0, 0.95, 0.86), smoothstep(0.0, 0.5, lam));
  vec3 alb = deckColor(N, uDepth);
  float mu = abs(dot(N, rd));
  float limb = mix(0.55, 1.0, pow(mu, 0.3));
  vec3 night = vec3(0.012, 0.014, 0.022) + vec3(0.02, 0.016, 0.014) * smoothstep(-0.5, 0.0, lam);
  vec3 col = alb * (sunCol * uStarColor * uSunI * diff * limb + night);

  float dist = t * uScale;
  float fog = uInside * (1.0 - exp(-dist / uFogLen));
  col = mix(col, uFogColor, fog);

  float wView = -vd.z * dist;
  gl_FragDepth = log2(1.0 + wView) * logDepthBufFC * 0.5;
  gl_FragColor = vec4(col, uAlpha * coverage);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const PUFF_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aP;
attribute vec4 aQ;
uniform vec2 uTan;
uniform vec3 uE1, uE2, uUp;
uniform float uCube, uCamR, uPlanetR, uRange;
uniform float uLayerAlt[4];
varying vec3 vViewPos;
varying vec3 vN;
varying float vDepth;
varying float vShade;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec2 p = mod(aP.xy * uCube - uTan, uCube) - 0.5 * uCube;
  float edge = max(abs(p.x), abs(p.y)) / (0.5 * uCube);
  int layer = int(aP.z + 0.5);
  float alt = uLayerAlt[layer] + aQ.y;
  float dy = (uPlanetR + alt) - uCamR - 0.5 * dot(p, p) / uPlanetR;
  float vis = (1.0 - smoothstep(0.72, 1.0, edge)) * (1.0 - smoothstep(0.55 * uRange, uRange, abs(dy)));
  vec3 v = position;
  v *= 0.72 + 0.55 * h13(position * 7.0 + aP.w * 13.0);
  v.y *= 0.42;
  float cs = cos(aQ.z), sn = sin(aQ.z);
  v = vec3(cs * v.x + sn * v.z, v.y, -sn * v.x + cs * v.z);
  float dpiv = length(vec3(p, dy)) / (aQ.x * 1.3 + 300.0);
  vis *= smoothstep(1.0, 2.2, dpiv);
  vec3 wp = uE1 * p.x + uE2 * p.y + uUp * dy + (uE1 * v.x + uUp * v.y + uE2 * v.z) * aQ.x * vis;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewPos = mv.xyz;
  vec3 nv = normalize(position);
  vN = normalize(mat3(viewMatrix) * (uE1 * nv.x + uUp * nv.y * 1.6 + uE2 * nv.z));
  vDepth = aP.z / 3.0;
  vShade = 0.85 + 0.3 * h13(position * 3.0 + aP.w * 5.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const PUFF_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunView, uPuffColor, uFogColor, uStarColor;
uniform float uSunTerm, uSunI, uFogLen;
varying vec3 vViewPos;
varying vec3 vN;
varying float vDepth;
varying float vShade;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  float lam = max(dot(N, uSunView) * 0.8 + 0.2, 0.0);
  float facing = abs(dot(N, normalize(vViewPos)));
  vec3 base = uPuffColor * vShade * mix(vec3(1.0), vec3(1.05, 0.62, 0.4) * 0.5, vDepth);
  vec3 col = base * (uStarColor * uSunI * uSunTerm * (0.1 + 0.9 * lam * lam) * 0.8 + 0.03 + 0.05 * uSunTerm);
  col *= mix(vec3(0.8, 0.62, 0.55), vec3(1.0), N.y * 0.5 + 0.5);
  float fog = 1.0 - exp(-length(vViewPos) / (uFogLen * 0.12));
  col = mix(col, uFogColor, fog * 0.85);
  gl_FragColor = vec4(mix(col, uFogColor, 0.35 * (1.0 - smoothstep(0.0, 0.5, facing))), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface U<T> {
  value: T;
}
type SharedUniforms = {
  uProjInv: U<Matrix4>;
  uViewToLocal: U<Matrix3>;
  uCamLocal: U<Vector3>;
  uSunLocal: U<Vector3>;
  uFogColor: U<Vector3>;
  uScale: U<number>;
  uPixAng: U<number>;
  uInside: U<number>;
  uFogLen: U<number>;
  uCamDepth: U<number>;
  uSunI: U<number>;
  uStarColor: U<Vector3>;
  uPhase: U<number>;
  uBands: U<Vector3[]>;
  uBandCount: U<number>;
  uBandFreq: U<number>;
  uTurb: U<number>;
  uSeed: U<number>;
  uGasOct: U<number>;
  uStormN: U<number>;
  uStorm: U<Vector4[]>;
  uStormCol: U<Vector3[]>;
  uHasRing: U<number>;
} & ReturnType<typeof makeRingUniforms>;

const _q = new Quaternion();
const _inv = new Quaternion();
const _camRel = new Vector3();
const _camM = new Vector3();
const _up = new Vector3();
const _sunW = new Vector3();
const _sunL = new Vector3();
const _m4 = new Matrix4();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _w = new Vector3();
const Y = new Vector3(0, 1, 0);

/**
 * Procedural banded gas giant with a cloud sea you can dive into. The planet and its cloud
 * decks are analytic spheres drawn as screen quads (exact limb, no facets, valid from
 * inside); rings, if the body has them, are part of the same group and cast shadows both ways.
 */
export class GasGiantView implements BodyView {
  readonly body: Body;
  readonly object = new Group();
  private readonly shells: { mesh: Mesh; material: ShaderMaterial; depth: number }[] = [];
  private readonly puffs: Mesh;
  private readonly puffMat: ShaderMaterial;
  private readonly rings: RingMesh | null;
  private readonly shared: SharedUniforms;
  private readonly deckDepth: number;
  private readonly avgColor = new Color();
  // Puff chart (a flat tangent patch under the camera, re-anchored when it drifts).
  private readonly chartUp = new Vector3();
  private readonly chartE1 = new Vector3();
  private readonly chartE2 = new Vector3();
  private chartValid = false;

  constructor(body: Body) {
    this.body = body;
    this.object.name = `body:${body.id}`;
    const gas = body.def.gas!;
    this.deckDepth = gas.cloudDeckDepth;

    const bands = Array.from({ length: MAX_BANDS }, (_, i) => {
      const c = gas.bands[Math.min(i, gas.bands.length - 1)] ?? [0.7, 0.6, 0.5];
      return new Vector3(c[0], c[1], c[2]);
    });
    for (const c of gas.bands) {
      this.avgColor.r += c[0] / gas.bands.length;
      this.avgColor.g += c[1] / gas.bands.length;
      this.avgColor.b += c[2] / gas.bands.length;
    }
    const stormVec = Array.from({ length: MAX_STORMS }, () => new Vector4());
    const stormCol = Array.from({ length: MAX_STORMS }, () => new Vector3());
    const storms = (gas.storms ?? []).slice(0, MAX_STORMS);
    storms.forEach((s, i) => {
      stormVec[i]!.set(s.lat, s.lon, s.size * 1.7, s.size * 1.05);
      stormCol[i]!.set(s.color[0], s.color[1], s.color[2]);
    });

    const ringUniforms = makeRingUniforms(body.def.rings, body.def.seed);
    this.shared = {
      uProjInv: { value: new Matrix4() },
      uViewToLocal: { value: new Matrix3() },
      uCamLocal: { value: new Vector3() },
      uSunLocal: { value: new Vector3(1, 0, 0) },
      uFogColor: { value: new Vector3() },
      uScale: { value: 1 },
      uPixAng: { value: 0.001 },
      uInside: { value: 0 },
      uFogLen: { value: body.radius * 0.03 },
      uCamDepth: { value: 0 },
      uSunI: { value: 1.25 },
      uStarColor: starLight.uniform,
      uPhase: { value: 0 },
      uBands: { value: bands },
      uBandCount: { value: Math.min(gas.bands.length, MAX_BANDS) },
      uBandFreq: { value: gas.bandFrequency },
      uTurb: { value: gas.turbulence },
      uSeed: { value: (body.def.seed % 53) * 1.37 },
      uGasOct: { value: 4 },
      uStormN: { value: storms.length },
      uStorm: { value: stormVec },
      uStormCol: { value: stormCol },
      uHasRing: { value: body.def.rings ? 1 : 0 },
      ...ringUniforms,
    };

    const quad = new PlaneGeometry(2, 2);
    const make = (depth: number, alpha: number, shellR: number, transparent: boolean, order: number) => {
      const material = new ShaderMaterial({
        uniforms: { ...this.shared, uShellR: { value: shellR }, uDepth: { value: depth }, uAlpha: { value: alpha }, uCeil: { value: order === 0 ? 1 : 0 } },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: SHELL_FRAG,
        transparent,
        depthWrite: !transparent || order === 0,
      });
      const mesh = new Mesh(quad, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.object.add(mesh);
      return { mesh, material, depth };
    };
    // Cloud tops (soft one pixel limb, so blended, but writes depth).
    const top = make(0, 1, 1, true, 0);
    this.shells.push(top);
    SHELL_DEPTHS.forEach((d, i) => {
      // The deepest deck is opaque and writes depth, so the scattering pass sees a floor
      // under the ship instead of the far side of the planet.
      const last = i === SHELL_DEPTHS.length - 1;
      this.shells.push(make(d, SHELL_ALPHA[i]!, 1 - d * gas.cloudDeckDepth, !last, SHELL_DEPTHS.length - i));
    });

    // Cloud puffs.
    const ico = new IcosahedronGeometry(1, 2);
    const geo = new InstancedBufferGeometry();
    geo.index = ico.index;
    geo.setAttribute('position', ico.getAttribute('position'));
    const n = PUFFS_PER_LAYER * 4;
    const aP = new Float32Array(n * 4);
    const aQ = new Float32Array(n * 4);
    const rnd = mulberry32(body.def.seed * 7 + 5);
    for (let i = 0; i < n; i++) {
      const layer = Math.floor(i / PUFFS_PER_LAYER);
      const k = 1 + layer * 2.2;
      aP.set([rnd(), rnd(), layer, rnd()], i * 4);
      aQ.set([(350 + rnd() * rnd() * 2200) * k, (-7000 + rnd() * 6500) * k, rnd() * Math.PI * 2, 0], i * 4);
    }
    geo.setAttribute('aP', new InstancedBufferAttribute(aP, 4));
    geo.setAttribute('aQ', new InstancedBufferAttribute(aQ, 4));
    geo.instanceCount = n;
    this.puffMat = new ShaderMaterial({
      uniforms: {
        uTan: { value: [0, 0] },
        uE1: { value: new Vector3() },
        uE2: { value: new Vector3() },
        uUp: { value: new Vector3() },
        uCube: { value: PUFF_CUBE },
        uCamR: { value: 0 },
        uPlanetR: { value: body.radius },
        uRange: { value: PUFF_RANGE },
        uLayerAlt: { value: [0, 0, 0, 0] },
        uSunView: { value: new Vector3() },
        uPuffColor: { value: new Vector3() },
        uFogColor: this.shared.uFogColor,
        uSunTerm: { value: 1 },
        uSunI: this.shared.uSunI,
        uStarColor: starLight.uniform,
        uFogLen: this.shared.uFogLen,
      },
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
    });
    this.puffs = new Mesh(geo, this.puffMat);
    this.puffs.frustumCulled = false;
    this.puffs.visible = false;
    this.puffs.renderOrder = 10;
    this.object.add(this.puffs);

    this.rings = body.def.rings ? new RingMesh(body.def.rings, ringUniforms) : null;
    if (this.rings) this.object.add(this.rings.mesh);
  }

  update(ctx: FrameContext): void {
    const b = this.body;
    const R = b.radius;
    const cam = ctx.camera;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    const dist = b.position.distanceTo(ctx.cameraWorld);
    const boost = apparentSizeBoost(R, dist, b.minApparentSize);
    const scale = R * boost;
    this.object.quaternion.copy(b.rotation);
    this.object.scale.setScalar(scale);
    this.object.updateMatrix();

    _inv.copy(b.rotation).invert();
    _camRel.copy(ctx.cameraWorld).sub(b.position);
    _camM.copy(_camRel).applyQuaternion(_inv); // body fixed, meters
    const camR = _camM.length();
    const alt = camR - R; // meters above the cloud tops
    const sh = this.shared;

    sh.uProjInv.value.copy(cam.projectionMatrixInverse);
    _q.copy(_inv).multiply(cam.quaternion);
    sh.uViewToLocal.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q));
    sh.uCamLocal.value.copy(_camM).divideScalar(scale);
    sh.uScale.value = scale;
    const fov = (cam.fov * Math.PI) / 180;
    sh.uPixAng.value = (2 * Math.tan(fov / 2)) / (ctx.viewportHeight * ctx.renderer.getPixelRatio());
    sh.uPhase.value = (ctx.simTime / FLOW_PERIOD) % 1;
    sh.uGasOct.value = quality.settings.gasOctaves;

    const sun = ctx.world.universe.root;
    _sunW.copy(sun.position).sub(b.position).normalize();
    _sunL.copy(_sunW).applyQuaternion(_inv);
    sh.uSunLocal.value.copy(_sunL);

    // Visibility: skip the screen quads when the planet is outside the view cone.
    _w.copy(_camRel).negate().normalize();
    _e1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const angRad = Math.asin(Math.min(1, (R * boost) / Math.max(dist, R * boost * 1.0001)));
    const halfDiag = Math.atan(Math.tan(fov / 2) * Math.hypot(1, cam.aspect));
    const seen = dist <= scale * 1.02 || Math.acos(Math.min(1, _w.dot(_e1))) < halfDiag + angRad + 0.05;

    // Fog while below the cloud tops.
    const D = this.deckDepth * R;
    const inside = Math.min(1, Math.max(0, (1000 - alt) / 4000));
    const df = Math.min(1, Math.max(0, -alt / D));
    _up.copy(_camM).divideScalar(camR);
    const sunTerm = smoothstep(-0.1, 0.35, _up.dot(_sunL));
    const warm = 1 - df;
    const fc = sh.uFogColor.value;
    fc.set(
      this.avgColor.r * (1.0 + 0.1 * warm) * (1 - 0.6 * df),
      this.avgColor.g * (0.62 + 0.1 * warm) * (1 - 0.72 * df),
      this.avgColor.b * (0.4 + 0.1 * warm) * (1 - 0.82 * df),
    ).multiplyScalar(0.9 * (0.08 + 0.92 * sunTerm));
    sh.uInside.value = inside;
    sh.uCamDepth.value = Math.max(0, -alt);

    for (const s of this.shells) s.mesh.visible = seen && (s.depth === 0 || alt < 2000);

    // Puffs hug the cloud tops (and the deeper decks when diving).
    const nearDeck = alt < PUFF_RANGE;
    this.puffs.visible = nearDeck;
    if (nearDeck) this.updatePuffs(_camM, camR, _up, sunTerm, D, R, b.rotation, cam.matrixWorldInverse);

    if (this.rings) {
      this.rings.sunLocal.value.copy(_sunL);
      this.rings.camLocal.value.copy(_camM).divideScalar(scale);
      this.rings.sunView.value.copy(_sunW).transformDirection(cam.matrixWorldInverse);
    }
  }

  private updatePuffs(camM: Vector3, camR: number, up: Vector3, sunTerm: number, D: number, R: number, rot: Quaternion, viewInv: Matrix4): void {
    if (!this.chartValid || up.dot(this.chartUp) < 0.9992) {
      this.chartUp.copy(up);
      this.chartE1.crossVectors(Y, up);
      if (this.chartE1.lengthSq() < 1e-6) this.chartE1.set(1, 0, 0);
      this.chartE1.normalize();
      this.chartE2.crossVectors(up, this.chartE1);
      this.chartValid = true;
    }
    const u = this.puffMat.uniforms;
    const tan = u.uTan!.value as number[];
    tan[0] = camM.dot(this.chartE1);
    tan[1] = camM.dot(this.chartE2);
    // Orthonormal basis at the current up, in world axes.
    _e1.copy(this.chartE1).addScaledVector(up, -up.dot(this.chartE1)).normalize();
    _e2.crossVectors(up, _e1);
    (u.uE1!.value as Vector3).copy(_e1).applyQuaternion(rot);
    (u.uE2!.value as Vector3).copy(_e2).applyQuaternion(rot);
    (u.uUp!.value as Vector3).copy(up).applyQuaternion(rot);
    u.uCamR!.value = camR;
    u.uPlanetR!.value = R;
    const layers = u.uLayerAlt!.value as number[];
    for (let i = 0; i < 4; i++) layers[i] = i === 0 ? 0 : -SHELL_DEPTHS[i - 1]! * D;
    (u.uSunView!.value as Vector3).copy(_sunW).transformDirection(viewInv);
    u.uSunTerm!.value = sunTerm;
    const c = this.avgColor;
    (u.uPuffColor!.value as Vector3).set(c.r * 0.78, c.g * 0.5, c.b * 0.3);
  }

  dispose(): void {
    for (const s of this.shells) s.material.dispose();
    this.shells[0]?.mesh.geometry.dispose();
    this.puffs.geometry.dispose();
    this.puffMat.dispose();
    this.rings?.dispose();
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createGasGiantViewFor(body: Body): BodyView {
  return new GasGiantView(body);
}
