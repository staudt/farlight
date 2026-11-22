import { Vector4 } from 'three';
import { config } from '../../core/config';
import type { BodyDef } from '../../data/types';

/** Valley mist shared by the terrain and prop shaders (uniforms by reference). */
export const MIST_GLSL = /* glsl */ `
  uniform vec4 uMist;
  uniform float uBodyRadius;
  // Morning mist pooled in low ground: optical depth along the part of the view ray below the layer top.
  // It is a milky veil on the scene colour; the atmosphere pass then adds its own haze on top by distance.
  vec3 landMist(vec3 col, vec3 lightC, float pool, float sunR, vec3 vp, vec3 bc) {
    if (uMist.x <= 0.0 || pool <= 0.0) return col;
    float dist = length(vp);
    float alt = length(vp - bc) - uBodyRadius;
    float camAlt = length(bc) - uBodyRadius;
    float low = 1.0 - smoothstep(uMist.y, uMist.z, alt);
    float frac = clamp((uMist.z - alt) / max(camAlt - alt, 1.0), 0.0, 1.0);
    float morn = 0.35 + 0.65 * (1.0 - smoothstep(0.2, 0.65, sunR));
    float tau = uMist.x * uMist.w * 0.001 * dist * frac * low * pool * morn;
    return mix(col, lightC, (1.0 - exp(-min(tau, 8.0))) * 0.9);
  }`;

const RAIN = new Set(['rain', 'acidRain', 'methaneRain']);

/** A world with rain (water, acid or methane) has humid air near the ground. */
export function isHumid(def: BodyDef | undefined): boolean {
  const a = def?.atmosphere;
  return !!a && a.height > 0 && !!a.weather?.some((w) => RAIN.has(w.kind));
}

/** Mist layer in meters above the base radius: [fade start, top]. Sits on the sea level, thickness a fraction of the relief. */
export function mistLayer(def: BodyDef | undefined, radius: number): [number, number] {
  const t = def?.terrain;
  if (!t) return [0, 0];
  const ampM = t.amplitude * radius;
  const sea = t.water && t.seaLevel !== undefined ? t.seaLevel * ampM : 0;
  const thick = config.terrain.mistTop * ampM;
  return [sea + thick * 0.35, sea + thick];
}

/** Writes the live mist uniform (strength zero where the world is dry or the effect is off). */
export function updateMist(mist: Vector4, def: BodyDef | undefined, radius: number): void {
  const [lo, hi] = mistLayer(def, radius);
  const on = isHumid(def) && radius > 0 ? config.terrain.mist : 0;
  mist.set(on, lo, Math.max(hi, lo + 1), config.terrain.mistDensity);
}
