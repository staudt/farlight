import { Color, Quaternion, Vector3 } from 'three';
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
    return { amplitude: 0, speed: 1, foam: 0, windDir: 0, foamColor: [1, 1, 1], sssColor: [0, 0, 0], hasWater: false };
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
export function updateWaveUniforms(u: WaveUniforms, look: WaterLook, ctx: FrameContext, bodyRot: Quaternion, camBody: Vector3): void {
  const c = config.water;
  u.uHasWater.value = look.hasWater && c.enabled ? 1 : 0;
  u.uWaveAmp.value = look.amplitude * c.waveAmplitude;
  u.uFoam.value = look.foam * c.foam;
  u.uFoamWidth.value = c.foamWidth;
  u.uWaveBands.value = quality.settings.fxScale < 0.5 ? 3 : WAVES.length;
  if (!look.hasWater) return;
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
