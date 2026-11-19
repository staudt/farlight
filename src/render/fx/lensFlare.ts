import { Effect, Pass } from 'postprocessing';
import type { GUI } from 'lil-gui';
import {
  CustomBlending,
  GLSL3,
  HalfFloatType,
  NearestFilter,
  OneMinusSrcAlphaFactor,
  RawShaderMaterial,
  RGBAFormat,
  SrcAlphaFactor,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { config } from '../../core/config';
import type { Body } from '../../sim/universe';
import { cloudRayOpticalDepth } from '../clouds/coverage';
import { quality } from '../quality';
import { starLight } from '../starLight';
import { type AirInfo, type SunScreen, airAtCamera, projectSun, smooth } from './godRays';

/**
 * Lens flare: a restrained cinematic flare (soft halo with a chromatic fringe, ghosts along the
 * line through the screen centre, a faint starburst and a thin pale cyan anamorphic streak).
 *
 * Visibility is the product of
 *  - a GPU depth probe: 16 depth taps around the sun count sky pixels, so mountains, the ship and
 *    moons occlude it exactly (smoothed on the GPU into a 1x1 texture, no readback);
 *  - CPU occlusion of the sun by body spheres (also covers eclipses);
 *  - CPU cloud optical depth along the sun ray when the camera is under or inside a cloud layer;
 *  - atmospheric dimming with the sun near the horizon.
 */

type V3 = { x: number; y: number; z: number };
export interface Sphere {
  position: V3;
  radius: number;
}

/**
 * Pure: 0 when a sphere covers the sun as seen from `cam`, 1 when nothing does, smooth over the
 * sun's own angular size (`sunAngRadius`, radians) so an eclipse fades in and out.
 */
export function sunOcclusion(cam: V3, sunPos: V3, sunAngRadius: number, spheres: readonly Sphere[]): number {
  const sx = sunPos.x - cam.x, sy = sunPos.y - cam.y, sz = sunPos.z - cam.z;
  const sd = Math.hypot(sx, sy, sz);
  if (sd <= 0) return 1;
  let vis = 1;
  for (const b of spheres) {
    const bx = b.position.x - cam.x, by = b.position.y - cam.y, bz = b.position.z - cam.z;
    const bd = Math.hypot(bx, by, bz);
    if (bd <= b.radius || bd >= sd) continue; // inside it, or behind the sun
    const cos = (sx * bx + sy * by + sz * bz) / (sd * bd);
    const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
    const limb = Math.asin(Math.min(1, b.radius / bd));
    const r = Math.max(sunAngRadius, 1e-4);
    vis = Math.min(vis, smooth(-r, r, angle - limb));
  }
  return vis;
}

/** Pure: 1 with the sun well above the horizon, `floor` with it on the horizon (thick air in the way). */
export function horizonDimming(sinElev: number, density: number, floor: number): number {
  const w = smooth(0, 0.2, density);
  const dim = floor + (1 - floor) * smooth(-0.02, 0.22, sinElev);
  return 1 - w * (1 - dim);
}

/** Pure: transmittance of the sun through cloud with this optical depth. */
export function cloudSunVisibility(opticalDepth: number): number {
  return Math.exp(-Math.max(0, opticalDepth) * 1.6);
}

/** Pure: fade as the sun leaves the screen (`outside` is NDC units past the edge). */
export function flareEdgeFade(outside: number, marginScreens: number): number {
  return 1 - smooth(0, Math.max(0.01, marginScreens * 2), outside);
}

const VERT = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const PROBE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 oProbe;
uniform sampler2D uFpDepth;
uniform vec2 uFpSun;
uniform float uFpSunZ;
uniform float uFpLogFar;
uniform float uFpAspect;
uniform float uFpRadius;
uniform float uFpK;

void main() {
  float sky = 0.0;
  for (int i = 0; i < 16; i++) {
    float r = sqrt((float(i) + 0.5) / 16.0) * uFpRadius;
    float a = float(i) * 2.39996323;
    vec2 p = uFpSun + vec2(cos(a) / uFpAspect, sin(a)) * r;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { sky += 1.0; continue; }
    float raw = texture(uFpDepth, p).r;
    // The sun disc itself writes depth at the sun's distance, so "sky" is anything near or beyond it.
    float z = exp2(raw * uFpLogFar) - 1.0;
    if (raw >= 0.99999 || z >= 0.85 * uFpSunZ) sky += 1.0;
  }
  oProbe = vec4(vec3(sky / 16.0), uFpK);
}
`;

/** Counts the sky around the sun in the depth buffer into a 1x1 texture, blended over time. */
export class FlareProbePass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly material: RawShaderMaterial;

  constructor() {
    super('FlareProbePass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: PROBE_FRAG,
      uniforms: {
        uFpDepth: new Uniform(null),
        uFpSun: new Uniform(new Vector2(0.5, 0.5)),
        uFpSunZ: new Uniform(1),
        uFpLogFar: new Uniform(1),
        uFpAspect: new Uniform(1.7),
        uFpRadius: new Uniform(0.02),
        uFpK: new Uniform(1),
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.fullscreenMaterial = this.material;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  override setDepthTexture(depthTexture: Texture, depthPacking?: Parameters<Pass['setDepthTexture']>[1]): void {
    super.setDepthTexture(depthTexture, depthPacking);
    this.material.uniforms.uFpDepth!.value = depthTexture;
  }

  bind(sun: SunScreen, logFar: number, aspect: number, k: number): void {
    const u = this.material.uniforms;
    (u.uFpSun!.value as Vector2).set(sun.u, sun.v);
    u.uFpSunZ!.value = sun.z;
    u.uFpLogFar!.value = logFar;
    u.uFpAspect!.value = aspect;
    u.uFpRadius!.value = config.lensFlare.sampleRadius;
    u.uFpK!.value = k;
  }

  override render(renderer: WebGLRenderer): void {
    const clear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = clear;
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    super.dispose();
  }
}

/** The flare itself, drawn procedurally around the sun's screen position. */
export class LensFlareEffect extends Effect {
  constructor() {
    super(
      'LensFlareEffect',
      /* glsl */ `
uniform sampler2D uFlProbe;
uniform vec2 uFlSun;
uniform float uFlAspect;
uniform float uFlVis;
uniform vec3 uFlTint;
uniform vec4 uFlAmt; // halo, ghosts, streak, starburst

float flHex(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.8660254, 0.5)), p.y);
}

// One ghost: soft body with a slightly brighter rim. Hexagon (hex = 1) or round.
vec3 flGhost(vec2 p, vec2 c, float r, float hex, vec3 col) {
  vec2 d = (p - c) / r;
  float q = mix(length(d), flHex(d) * 1.08, hex);
  float body = 1.0 - smoothstep(0.35, 1.0, q);
  float rim = smoothstep(0.55, 0.9, q) * (1.0 - smoothstep(0.9, 1.05, q));
  return col * (body * 0.55 + rim * 0.6);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float vis = uFlVis;
  if (vis <= 0.002) { outputColor = inputColor; return; }
  vis *= texture2D(uFlProbe, vec2(0.5)).r;
  if (vis <= 0.002) { outputColor = inputColor; return; }

  vec2 asp = vec2(uFlAspect, 1.0);
  vec2 p = (uv - 0.5) * asp;
  vec2 s = (uFlSun - 0.5) * asp;
  float sl = length(s);
  vec2 d = p - s;
  float q = length(d);
  vec3 sun = uFlTint;
  vec3 cyan = vec3(0.55, 0.92, 1.0);
  vec3 col = vec3(0.0);

  // Halo ring around the sun with a small chromatic split.
  float rr = 0.2;
  float w = 0.014;
  vec3 ring = vec3(
    exp(-pow((q - rr * 0.96) / w, 2.0)),
    exp(-pow((q - rr) / w, 2.0)),
    exp(-pow((q - rr * 1.04) / w, 2.0))
  );
  col += ring * sun * 0.03 * uFlAmt.x;

  // Ghosts along the line through the centre. Strongest with the sun away from the middle.
  float gf = smoothstep(0.04, 0.4, sl) * (1.0 - smoothstep(0.9, 1.7, sl));
  vec3 g = vec3(0.0);
  g += flGhost(p, s * 0.62, 0.032, 1.0, vec3(1.0, 0.72, 0.45) * 0.22);
  g += flGhost(p, s * -0.35, 0.07, 0.0, vec3(0.45, 0.78, 1.0) * 0.14);
  g += flGhost(p, s * -0.78, 0.045, 1.0, vec3(0.55, 1.0, 0.8) * 0.2);
  g += flGhost(p, s * -1.18, 0.11, 0.0, vec3(0.75, 0.55, 1.0) * 0.1);
  g += flGhost(p, s * -1.7, 0.058, 1.0, vec3(1.0, 0.85, 0.55) * 0.14);
  g += flGhost(p, s * 0.28, 0.15, 0.0, vec3(0.5, 0.72, 1.0) * 0.06);
  col += g * sun * gf * uFlAmt.y * 0.7;

  // Faint starburst.
  float a = atan(d.y, d.x);
  float spikes = pow(abs(cos(a * 3.0 + 0.35)), 28.0) * 0.7 + pow(abs(cos(a * 5.0 + sl * 1.3)), 44.0) * 0.3;
  col += sun * spikes * exp(-q * 6.0) / (1.0 + q * 9.0) * 0.32 * uFlAmt.w;

  // Thin anamorphic streak in pale cyan.
  float streak = exp(-abs(d.y) * 240.0) * exp(-abs(d.x) * 2.6) * 0.22;
  streak += exp(-abs(d.y) * 900.0) * exp(-abs(d.x) * 4.0) * 0.3;
  col += cyan * streak * uFlAmt.z;

  outputColor = vec4(inputColor.rgb + col * vis, inputColor.a);
}
`,
      {
        uniforms: new Map<string, Uniform>([
          ['uFlProbe', new Uniform(null)],
          ['uFlSun', new Uniform(new Vector2(0.5, 0.5))],
          ['uFlAspect', new Uniform(1.7)],
          ['uFlVis', new Uniform(0)],
          ['uFlTint', new Uniform(new Vector3(1, 1, 1))],
          ['uFlAmt', new Uniform(new Vector4(1, 1, 1, 1))],
        ]),
      },
    );
  }
}

const _rel = new Vector3();
const _local = new Vector3();
const _sunDir = new Vector3();
const _localDir = new Vector3();

/** Owns the flare probe pass and effect and the CPU side of the visibility. */
export class LensFlare {
  readonly pass = new FlareProbePass();
  readonly effect = new LensFlareEffect();
  readonly sun: SunScreen = { u: 0.5, v: 0.5, z: 1, outside: 0, front: true };
  private readonly air: AirInfo = { density: 0, haze: 0, sinElev: 1, body: null };
  /** Smoothed CPU visibility 0..1 (bodies, clouds, horizon, screen edge). */
  visibility = 0;
  /** Parts of the target, for the debug panel. */
  readonly parts = { bodies: 1, cloud: 1, horizon: 1, edge: 1 };
  /** Set by photo mode (or anything else that wants a clean frame). */
  suppressed = false;
  private spheres: Sphere[] = [];

  constructor() {
    this.pass.enabled = false;
  }

  /** Per frame, before the composer renders. */
  update(dt: number, camera: PerspectiveCamera, cameraWorld: Vector3, root: Body, bodies: readonly Body[], simTime: number, cloudBias: number, logFar: number): void {
    const c = config.lensFlare;
    projectSun(camera, cameraWorld, root.position, this.sun);
    const edge = flareEdgeFade(this.sun.outside, c.edgeMargin);
    const allowed = c.enabled && c.user && quality.settings.lensFlare && !this.suppressed && this.sun.front && edge > 0;

    let target = 0;
    if (allowed) {
      this.spheres.length = 0;
      for (const b of bodies) if (b !== root) this.spheres.push(b);
      const sunDist = root.position.distanceTo(cameraWorld);
      const sunAng = Math.max(Math.asin(Math.min(1, root.radius / Math.max(sunDist, 1))), root.minApparentSize * 0.5);
      airAtCamera(cameraWorld, root.position, bodies, this.air);
      this.parts.bodies = sunOcclusion(cameraWorld, root.position, sunAng, this.spheres);
      this.parts.horizon = horizonDimming(this.air.sinElev, this.air.density, c.horizonDim);
      this.parts.cloud = this.cloudVisibility(root, simTime, cloudBias, cameraWorld);
      this.parts.edge = edge;
      target = this.parts.bodies * this.parts.horizon * this.parts.cloud * edge;
    }
    const k = 1 - Math.exp(-dt / Math.max(0.01, c.smoothing));
    this.visibility += (target - this.visibility) * k;
    if (target === 0 && this.visibility < 0.002) this.visibility = 0;

    const on = allowed && this.visibility > 0.002;
    this.pass.enabled = on;
    const u = this.effect.uniforms;
    u.get('uFlVis')!.value = on ? this.visibility * c.intensity : 0;
    if (!on) return;
    this.pass.bind(this.sun, logFar, camera.aspect, k);
    u.get('uFlProbe')!.value = this.pass.texture;
    (u.get('uFlSun')!.value as Vector2).set(this.sun.u, this.sun.v);
    u.get('uFlAspect')!.value = camera.aspect;
    (u.get('uFlTint')!.value as Vector3).copy(starLight.tint).multiplyScalar(starLight.intensity);
    (u.get('uFlAmt')!.value as Vector4).set(c.haloIntensity, c.ghostIntensity, c.streakIntensity, c.starburstIntensity);
  }

  /** Cloud transmittance of the sun when the camera is under or inside a cloud layer of the air it is in. */
  private cloudVisibility(root: Body, simTime: number, bias: number, cameraWorld: Vector3): number {
    const b = this.air.body;
    const cl = b?.def.atmosphere?.clouds;
    if (!b || !cl) return 1;
    _rel.copy(cameraWorld).sub(b.position);
    b.worldToLocalDir(_rel, _local);
    _sunDir.copy(root.position).sub(cameraWorld).normalize();
    b.worldToLocalDir(_sunDir, _localDir);
    return cloudSunVisibility(cloudRayOpticalDepth(cl, b.radius, b.atmosphereHeight, _local, _localDir, simTime, bias));
  }

  addDebug(f: GUI): void {
    const c = config.lensFlare;
    f.add(c, 'enabled');
    f.add(c, 'intensity', 0, 3);
    f.add(c, 'haloIntensity', 0, 3);
    f.add(c, 'ghostIntensity', 0, 3);
    f.add(c, 'streakIntensity', 0, 3);
    f.add(c, 'starburstIntensity', 0, 3);
    f.add(c, 'smoothing', 0.01, 1);
    f.add(c, 'sampleRadius', 0.005, 0.06);
    f.add(c, 'edgeMargin', 0, 0.5);
    f.add(c, 'horizonDim', 0, 1);
    f.add(this, 'visibility').listen().disable();
    for (const k of Object.keys(this.parts) as (keyof typeof this.parts)[]) f.add(this.parts, k).listen().disable().name(`vis ${k}`);
  }
}
