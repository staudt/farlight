import { Effect, EffectAttribute, Pass } from 'postprocessing';
import { eclipse } from '../eclipse';
import type { GUI } from 'lil-gui';
import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Quaternion,
  RawShaderMaterial,
  RGBAFormat,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { config } from '../../core/config';
import type { Body } from '../../sim/universe';
import { quality } from '../quality';
import { starLight } from '../starLight';

/**
 * God rays: screen space light shafts. The sun's light that gets through cloud gaps and past
 * silhouettes is smeared radially toward the sun at low resolution, then added to the HDR colour
 * after clouds and atmosphere are composited (before bloom and tone mapping).
 *
 * The "light" mask is the volumetric pass transmittance of SKY pixels (raw log depth = sky, or
 * farther than most of the way to the sun), so clouds, terrain, the ship and moons all block it.
 * Strength comes from the air the camera sits in, so vacuum gets none and murky worlds a lot.
 */

export interface SunScreen {
  /** Screen position, 0..1, y up (may be off screen). */
  u: number;
  v: number;
  /** View space depth of the sun along the camera axis (meters). */
  z: number;
  /** Distance outside the screen in NDC units (0 = on screen). */
  outside: number;
  /** False when the sun is behind the camera. */
  front: boolean;
}

const _dir = new Vector3();
const _wq = new Quaternion();

/** Projects the sun to the screen. The camera sits at the floating origin; `cameraWorld` is its world position. */
export function projectSun(camera: PerspectiveCamera, cameraWorld: Vector3, sunPos: Vector3, out: SunScreen): SunScreen {
  _dir.copy(sunPos).sub(cameraWorld);
  const dist = _dir.length();
  camera.getWorldQuaternion(_wq).invert();
  _dir.applyQuaternion(_wq);
  out.front = _dir.z < -1e-6;
  if (!out.front) {
    out.u = 0.5;
    out.v = 0.5;
    out.z = dist;
    out.outside = 10;
    return out;
  }
  const e = camera.projectionMatrix.elements;
  const nx = (e[0]! * _dir.x) / -_dir.z;
  const ny = (e[5]! * _dir.y) / -_dir.z;
  out.u = nx * 0.5 + 0.5;
  out.v = ny * 0.5 + 0.5;
  out.z = -_dir.z;
  out.outside = Math.max(Math.abs(nx) - 1, Math.abs(ny) - 1, 0);
  return out;
}

export interface AirInfo {
  /** 0..1 density of the dominant atmosphere at the camera (0 in vacuum). */
  density: number;
  /** Mie optical depth of that atmosphere (haze). */
  haze: number;
  /** Sine of the sun elevation above the local horizon there (1 when not in air). */
  sinElev: number;
  body: Body | null;
}

const _up = new Vector3();
const _sd = new Vector3();

/** The air the camera is in: the atmosphere with the highest density at the camera. */
export function airAtCamera(cameraWorld: Vector3, sunPos: Vector3, bodies: readonly Body[], out: AirInfo = { density: 0, haze: 0, sinElev: 1, body: null }): AirInfo {
  out.density = 0;
  out.haze = 0;
  out.sinElev = 1;
  out.body = null;
  for (const b of bodies) {
    const atm = b.def.atmosphere;
    if (!atm || b.atmosphereHeight <= 0) continue;
    _up.copy(cameraWorld).sub(b.position);
    const h = _up.length() - b.radius;
    if (h >= b.atmosphereHeight) continue;
    const density = Math.exp(-Math.max(0, h) / Math.max(1, atm.scaleHeight * b.atmosphereHeight));
    if (density <= out.density) continue;
    _up.normalize();
    _sd.copy(sunPos).sub(b.position).normalize();
    out.density = density;
    out.haze = atm.mieDepth;
    out.sinElev = _up.dot(_sd);
    out.body = b;
  }
  return out;
}

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Pure: shaft strength (0..3) from the air at the camera. Strong in murky air, with a low sun, near zero in vacuum. */
export function godRayStrength(air: Pick<AirInfo, 'density' | 'haze' | 'sinElev'>): number {
  const c = config.godRays;
  if (c.force > 0) return c.force;
  if (air.density <= 0) return 0;
  const haze = Math.min(1, air.haze / 0.3);
  const lowSun = 1 - smooth(0.03, 0.45, air.sinElev);
  const aboveHorizon = smooth(-0.22, -0.02, air.sinElev);
  return Math.min(3, air.density * (c.baseStrength + c.hazeGain * haze) * (1 + c.lowSunBoost * lowSun) * aboveHorizon);
}

/** Pure: how much of the effect survives with the sun this far off screen (NDC units outside). */
export function sunEdgeFade(outside: number): number {
  return 1 - smooth(0.05, 1.1, outside);
}

const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const MAX_SAMPLES = 48;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 oRays;
uniform sampler2D uGrT;      // volumetric pass: rgb transmittance, a = raw log depth
uniform vec2 uGrSun;
uniform float uGrSunZ;
uniform float uGrLogFar;
uniform float uGrAspect;
uniform float uGrDecay;
uniform float uGrLength;
uniform float uGrRadius;
uniform int uGrSamples;

float grLight(vec2 p) {
  vec4 t = texture(uGrT, clamp(p, vec2(0.002), vec2(0.998)));
  float z = exp2(t.a * uGrLogFar) - 1.0;
  bool sky = t.a >= 0.99999 || z >= 0.85 * uGrSunZ;
  return sky ? smoothstep(0.06, 0.7, t.g) : 0.0;
}

void main() {
  vec2 toSun = uGrSun - vUv;
  float dist = length(toSun * vec2(uGrAspect, 1.0));
  vec2 delta = toSun * uGrLength / float(uGrSamples);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 p = vUv + delta * jitter;
  float illum = 1.0, acc = 0.0, wsum = 0.0;
  for (int i = 0; i < ${MAX_SAMPLES}; i++) {
    if (i >= uGrSamples) break;
    float ds = length((p - uGrSun) * vec2(uGrAspect, 1.0));
    float w = illum * exp(-ds / uGrRadius);
    acc += grLight(p) * w;
    wsum += w;
    illum *= uGrDecay;
    p += delta;
  }
  float lit = acc / max(wsum, 1e-4);
  // Shafts need both light and something blocking it along the path: a clear sky stays clear.
  float contrast = smoothstep(0.03, 0.4, 1.0 - lit);
  float rays = lit * contrast * exp(-dist / (uGrRadius * 1.4));
  // Blocked beams darken the air a little, so the lit ones read: shade peaks on partly blocked paths.
  float prox = exp(-dist / (uGrRadius * 1.4));
  float shade = (1.0 - lit) * smoothstep(0.05, 0.4, lit) * prox;
  oRays = vec4(rays, shade, 0.0, 1.0);
}
`;

/** Radial blur toward the sun at reduced resolution. Runs after the volumetric pass. */
export class GodRayPass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly material: RawShaderMaterial;
  private scale = 0.25;
  private fullW = 1;
  private fullH = 1;

  constructor() {
    super('GodRayPass');
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uGrT: new Uniform(null),
        uGrSun: new Uniform(new Vector2(0.5, 0.5)),
        uGrSunZ: new Uniform(1),
        uGrLogFar: new Uniform(1),
        uGrAspect: new Uniform(1.7),
        uGrDecay: new Uniform(0.96),
        uGrLength: new Uniform(0.9),
        uGrRadius: new Uniform(0.5),
        uGrSamples: new Uniform(24),
      },
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.material;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  setScale(s: number): void {
    this.scale = s;
    this.setSize(this.fullW, this.fullH);
  }

  override setSize(width: number, height: number): void {
    this.fullW = width;
    this.fullH = height;
    this.target.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  bind(t: Texture, sun: SunScreen, logFar: number, aspect: number, samples: number): void {
    const u = this.material.uniforms;
    const c = config.godRays;
    u.uGrT!.value = t;
    (u.uGrSun!.value as Vector2).set(sun.u, sun.v);
    u.uGrSunZ!.value = sun.z;
    u.uGrLogFar!.value = logFar;
    u.uGrAspect!.value = aspect;
    u.uGrDecay!.value = Math.pow(c.decay, 32 / Math.max(8, samples));
    u.uGrLength!.value = c.length;
    u.uGrRadius!.value = Math.max(0.05, c.sunRadius);
    u.uGrSamples!.value = Math.min(MAX_SAMPLES, Math.max(4, Math.round(samples)));
  }

  override render(renderer: WebGLRenderer): void {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    super.dispose();
  }
}

/** Adds the shafts to the HDR colour. Goes after the volumetric composite, before bloom. */
export class GodRaysComposite extends Effect {
  constructor() {
    super(
      'GodRaysComposite',
      /* glsl */ `
uniform sampler2D uGrTex;
uniform vec3 uGrColor;
uniform float uGrShade;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uGrColor.r + uGrColor.g + uGrColor.b <= 0.0 && uGrShade <= 0.0) { outputColor = inputColor; return; }
  vec2 rs = texture2D(uGrTex, uv).rg;
  float r = rs.r;
  // Shafts read against darker air and ground; bright cloud already says it.
  float lum = dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float vis = 1.0 - 0.85 * smoothstep(0.35, 1.4, lum);
  // Surfaces take less of it than the air in front of them.
  vis *= texture2D(depthBuffer, uv).r >= 0.99999 ? 1.0 : 0.4;
  outputColor = vec4(inputColor.rgb * (1.0 - uGrShade * rs.g) + uGrColor * (r * vis), inputColor.a);
}
`,
      {
        attributes: EffectAttribute.DEPTH,
        uniforms: new Map<string, Uniform>([
          ['uGrTex', new Uniform(null)],
          ['uGrColor', new Uniform(new Vector3())],
          ['uGrShade', new Uniform(0)],
        ]),
      },
    );
  }
}

/** Owns the god ray pass and effect and their per frame state. */
export class GodRays {
  readonly pass = new GodRayPass();
  readonly effect = new GodRaysComposite();
  /** Smoothed strength actually applied. */
  strength = 0;
  readonly sun: SunScreen = { u: 0.5, v: 0.5, z: 1, outside: 0, front: true };
  readonly air: AirInfo = { density: 0, haze: 0, sinElev: 1, body: null };

  constructor() {
    this.pass.enabled = false;
  }

  applyQuality(): void {
    this.pass.setScale(quality.settings.godRayScale);
  }

  /** Per frame, before the composer renders. `volTex` is the volumetric pass transmittance texture. */
  update(dt: number, camera: PerspectiveCamera, cameraWorld: Vector3, sunPos: Vector3, bodies: readonly Body[], volTex: Texture, volOn: boolean, logFar: number): void {
    const c = config.godRays;
    const samples = quality.settings.godRaySamples;
    projectSun(camera, cameraWorld, sunPos, this.sun);
    airAtCamera(cameraWorld, sunPos, bodies, this.air);
    const allowed = c.enabled && c.user && samples > 0 && volOn && this.sun.front;
    // No shafts from an eclipsed sun.
    const visible = eclipse.sunVisibilityAt(cameraWorld);
    const target = allowed ? godRayStrength(this.air) * sunEdgeFade(this.sun.outside) * c.intensity * visible : 0;
    this.strength += (target - this.strength) * (1 - Math.exp(-dt * 4));
    if (target === 0 && this.strength < c.minStrength) this.strength = 0;
    const on = allowed && this.strength > c.minStrength;
    this.pass.enabled = on;
    const u = this.effect.uniforms;
    u.get('uGrTex')!.value = this.pass.texture;
    const col = u.get('uGrColor')!.value as Vector3;
    if (on) {
      this.pass.bind(volTex, this.sun, logFar, camera.aspect, samples);
      // Tinted by the star.
      u.get('uGrShade')!.value = Math.min(0.6, c.shade * this.strength);
      col.copy(starLight.tint).multiplyScalar(c.gain * this.strength * starLight.intensity);
    } else {
      col.set(0, 0, 0);
      u.get('uGrShade')!.value = 0;
    }
  }

  addDebug(f: GUI): void {
    const c = config.godRays;
    f.add(c, 'enabled');
    f.add(c, 'intensity', 0, 4);
    f.add(c, 'gain', 0, 3);
    f.add(c, 'shade', 0, 1);
    f.add(c, 'decay', 0.85, 1);
    f.add(c, 'length', 0.2, 1);
    f.add(c, 'sunRadius', 0.1, 1.5);
    f.add(c, 'baseStrength', 0, 2);
    f.add(c, 'hazeGain', 0, 6);
    f.add(c, 'lowSunBoost', 0, 4);
    f.add(c, 'force', 0, 3).name('force strength');
    f.add(this, 'strength').listen().disable();
  }
}
