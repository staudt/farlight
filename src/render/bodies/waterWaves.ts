import { Color, Quaternion, Vector3, Vector4 } from 'three';
import type { Body } from '../../sim/universe';
import { config } from '../../core/config';
import type { BodyDef, RGB } from '../../data/types';
import type { FrameContext } from '../context';
import { quality } from '../quality';

/** One directional swell: unit direction (body fixed, before the wind turn), wavelength in meters, slope. */
const WAVES: readonly { dir: [number, number, number]; length: number; slope: number }[] = [
  { dir: [1, 0.15, 0.3], length: 85, slope: 0.05 },
  { dir: [0.2, 1, -0.4], length: 40, slope: 0.055 },
  { dir: [-0.3, 0.2, 1], length: 19, slope: 0.065 },
  { dir: [0.9, -0.5, -0.3], length: 9, slope: 0.055 },
  { dir: [-0.4, 0.8, 0.6], length: 4.6, slope: 0.045 },
  { dir: [0.3, -0.4, 0.9], length: 2.4, slope: 0.03 },
];
export const WAVE_COUNT = WAVES.length;
const TWO_PI = Math.PI * 2;

export interface WaterLook {
  amplitude: number;
  speed: number;
  foam: number;
  windDir: number;
  foamColor: RGB;
  sssColor: RGB;
  /** Waves exist at all (the body has an ocean). */
  hasWater: boolean;
  /** Sky colours the sea reflects, from the atmosphere data (zero without an atmosphere). */
  sky: SkyLook;
}

export interface SkyLook {
  has: boolean;
  zenith: RGB;
  horizon: RGB;
  /** Rayleigh optical depth per channel: how the low sun reddens. */
  depth: RGB;
}

/** Reflected sky colours from atmosphere data: Rayleigh tint at the zenith, paler and hazier at the horizon. */
export function skyLook(def: BodyDef): SkyLook {
  const a = def.atmosphere;
  if (!a) return { has: false, zenith: [0, 0, 0], horizon: [0, 0, 0], depth: [0, 0, 0] };
  const d = a.rayleighDepth;
  const z: RGB = [1 - Math.exp(-d[0] * 5), 1 - Math.exp(-d[1] * 5), 1 - Math.exp(-d[2] * 5)];
  const lum = (z[0] + z[1] + z[2]) / 3;
  const mie = a.mieColor ?? [1, 1, 1];
  const haze = Math.min(0.7, 0.35 + a.mieDepth * 1.2);
  const base = mixRgb(z, [lum, lum, lum], 0.3);
  const horizon = mixRgb(mixRgb(base, [lum + 0.2, lum + 0.2, lum + 0.2], 0.3), mie, haze * 0.5);
  // A thin atmosphere reflects little: scale by the total optical depth.
  const thick = Math.min(1, (d[0] + d[1] + d[2]) * 3);
  return {
    has: true,
    zenith: [z[0] * thick, z[1] * thick, z[2] * thick],
    horizon: [horizon[0] * thick, horizon[1] * thick, horizon[2] * thick],
    depth: d,
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Data to look: defaults for any ocean world, foam and subsurface tinted from the sea colour. */
export function waterLook(def: BodyDef): WaterLook {
  const w = def.terrain?.water;
  if (!w || def.terrain?.seaLevel === undefined) {
    return { amplitude: 0, speed: 1, foam: 0, windDir: 0, foamColor: [1, 1, 1], sssColor: [0, 0, 0], hasWater: false, sky: skyLook(def) };
  }
  const k = w.waves ?? {};
  const foamColor = k.foamColor ?? mixRgb(mixRgb(w.color, [1, 1, 1], 0.82), [0.95, 0.97, 1], 0.25);
  // Turquoise for blue seas, a lighter, more saturated cousin of the water colour for alien ones.
  const lum = (w.color[0] + w.color[1] + w.color[2]) / 3;
  const sat = mixRgb(w.color, [w.color[0] / (lum || 1), w.color[1] / (lum || 1), w.color[2] / (lum || 1)], 0.5);
  const sssColor = mixRgb(sat, [0.12, 1.0, 0.85], w.color[2] > w.color[0] * 1.4 ? 0.45 : 0.1);
  return {
    amplitude: k.amplitude ?? 1,
    speed: k.speed ?? 1,
    foam: k.foam ?? 1,
    windDir: k.windDir ?? hashString(def.id) * TWO_PI,
    foamColor,
    sssColor,
    hasWater: true,
    sky: skyLook(def),
  };
}

export interface WaveUniforms {
  uWaveK: { value: Vector3[] };
  uWaveP: { value: number[] };
  uWaveS: { value: number[] };
  uWaveL: { value: number[] };
  uWaveAmp: { value: number };
  uWaveBands: { value: number };
  uFoam: { value: number };
  uFoamWidth: { value: number };
  uFoamColor: { value: Color };
  uSssColor: { value: Color };
  uHasWater: { value: number };
  uSkyZenith: { value: Color };
  uSkyHorizon: { value: Color };
  uSkyDepth: { value: Vector3 };
  /** Reflection, glint gain, sparkle, shallows. */
  uWaterA: { value: Vector4 };
  /** Glint roughness, stretch, sky gain, moon glint. */
  uWaterB: { value: Vector4 };
  /** Moon direction in view space and how lit and large it is (zero: no moon). */
  uMoonDir: { value: Vector3 };
  uMoonLit: { value: number };
}

export function createWaveUniforms(look: WaterLook): WaveUniforms {
  return {
    uWaveK: { value: WAVES.map(() => new Vector3()) },
    uWaveP: { value: WAVES.map(() => 0) },
    uWaveS: { value: WAVES.map((w) => w.slope) },
    uWaveL: { value: WAVES.map((w) => w.length) },
    uWaveAmp: { value: look.amplitude },
    uWaveBands: { value: WAVES.length },
    uFoam: { value: look.foam },
    uFoamWidth: { value: 0.03 },
    uFoamColor: { value: new Color(look.foamColor[0], look.foamColor[1], look.foamColor[2]) },
    uSssColor: { value: new Color(look.sssColor[0], look.sssColor[1], look.sssColor[2]) },
    uHasWater: { value: look.hasWater ? 1 : 0 },
    uSkyZenith: { value: new Color(look.sky.zenith[0], look.sky.zenith[1], look.sky.zenith[2]) },
    uSkyHorizon: { value: new Color(look.sky.horizon[0], look.sky.horizon[1], look.sky.horizon[2]) },
    uSkyDepth: { value: new Vector3(look.sky.depth[0], look.sky.depth[1], look.sky.depth[2]) },
    uWaterA: { value: new Vector4(1, 1, 1, 1) },
    uWaterB: { value: new Vector4(0.08, 1.7, 1, 1) },
    uMoonDir: { value: new Vector3(0, 1, 0) },
    uMoonLit: { value: 0 },
  };
}

const _k = new Vector3();
const _qi = new Quaternion();
const _qc = new Quaternion();
const _camBody = new Vector3();
const _wq = new Quaternion();

/**
 * Per frame: wave vectors in view space and phases referenced to the camera, so the shader only
 * adds small numbers (float64 here, float32 there). `camBody` is the camera in body fixed meters.
 */
export function updateWaveUniforms(u: WaveUniforms, look: WaterLook, ctx: FrameContext, bodyRot: Quaternion, camBody: Vector3, body?: Body): void {
  const c = config.water;
  u.uHasWater.value = look.hasWater && c.enabled ? 1 : 0;
  u.uWaveAmp.value = look.amplitude * c.waveAmplitude;
  u.uFoam.value = look.foam * c.foam;
  u.uFoamWidth.value = c.foamWidth;
  u.uWaveBands.value = quality.settings.fxScale < 0.5 ? 3 : WAVES.length;
  if (!look.hasWater) return;
  const lowQ = quality.settings.fxScale < 0.5;
  u.uWaterA.value.set(look.sky.has ? c.reflection : 0, c.glint, lowQ ? 0 : c.sparkle, c.shallows);
  u.uWaterB.value.set(c.glintRoughness * (lowQ ? c.glintSoft : 1), c.glintStretch, c.skyGain, c.moonGlint);
  updateMoon(u, ctx, body);
  _camBody.copy(camBody);
  ctx.camera.getWorldQuaternion(_qc);
  _qi.copy(_qc).invert();
  _wq.copy(_qi).multiply(bodyRot); // body fixed to view
  const sp = look.speed * c.waveSpeed;
  const t = ctx.realTime;
  const ks = u.uWaveK.value;
  const ps = u.uWaveP.value;
  const cw = Math.cos(look.windDir);
  const sw = Math.sin(look.windDir);
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i]!;
    // Turn the set about the body y axis by the wind heading.
    _k.set(w.dir[0] * cw + w.dir[2] * sw, w.dir[1], -w.dir[0] * sw + w.dir[2] * cw).normalize();
    const kn = TWO_PI / w.length;
    _k.multiplyScalar(kn);
    const omega = Math.sqrt(9.81 * kn) * sp;
    const ph = _k.dot(_camBody) - omega * t;
    ps[i] = ((ph % TWO_PI) + TWO_PI) % TWO_PI;
    ks[i]!.copy(_k).applyQuaternion(_wq);
  }
}

const _mv = new Vector3();

/** The biggest satellite as a glint source at night: view space direction and lit fraction by its phase and size. */
function updateMoon(u: WaveUniforms, ctx: FrameContext, body?: Body): void {
  u.uMoonLit.value = 0;
  if (!body || body.children.length === 0) return;
  let moon = body.children[0]!;
  for (const c of body.children) if (c.radius > moon.radius && c.kind === 'rocky') moon = c;
  if (moon.kind !== 'rocky') return;
  _mv.copy(moon.position).sub(body.position);
  const dist = _mv.length();
  if (dist < 1) return;
  _mv.divideScalar(dist);
  const sun = ctx.world.universe.root.position;
  _k.copy(sun).sub(body.position).normalize();
  const lit = 0.5 - 0.5 * _mv.dot(_k); // 1 when opposite the sun (full)
  const size = Math.min(1.5, (moon.radius / dist / 0.0045) ** 2);
  u.uMoonLit.value = lit * lit * size;
  u.uMoonDir.value.copy(_mv).transformDirection(ctx.camera.matrixWorldInverse);
}
