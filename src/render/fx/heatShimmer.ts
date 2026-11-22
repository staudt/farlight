import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector3, Vector4 } from 'three';
import { findEffect } from '../../data/types';
import type { Body } from '../../sim/universe';
import { quality } from '../quality';
import { heatShimmerSettings } from '../weather/settings';
import { smooth } from '../weather/weatherMap';
import { plasmaShimmer } from './reentry';

/**
 * Screen space heat refraction. Pixels whose depth is terrain within a few km wobble sideways
 * in rising bands, strongest at mid distance (toward the horizon) and fading far away. Driven by
 * the `heatShimmer` effect of the body below the camera, so any hot world gets it from data.
 *
 * Uses `mainUv`, so it must come first in its EffectPass. Reads the raw log depth like the
 * atmosphere pass does.
 */
export class HeatShimmer extends Effect {
  /** Smoothed 0..1 strength actually applied. */
  amount = 0;
  private time = 0;
  private up = new Vector3();
  private sun = new Vector3();

  constructor() {
    super(
      'HeatShimmer',
      /* glsl */ `
uniform float uShimAmount;
uniform float uShimTime;
uniform float uShimLogFar;
uniform float uShimHaze;
uniform float uShimAspect;
uniform vec4 uPlasma;
uniform float uPlasmaEdge;

void mainUv(inout vec2 uv) {
  if (uPlasma.w > 0.001 || uPlasmaEdge > 0.001) {
    // Re-entry: hot air wobble behind the ship (chase) or along the frame edges (cockpit).
    vec2 d = (uv - uPlasma.xy) * vec2(uShimAspect, 1.0);
    float m = uPlasma.w * (1.0 - smoothstep(0.0, uPlasma.z, length(d)));
    vec2 c = (uv - 0.5) * vec2(1.0, 0.8);
    m += uPlasmaEdge * smoothstep(0.25, 0.62, length(c));
    float t = uShimTime;
    uv.x += sin(uv.y * 60.0 - t * 17.0 + sin(uv.x * 9.0 + t * 3.0) * 2.0) * 0.007 * m;
    uv.y += sin(uv.x * 48.0 - t * 13.0 + 1.3) * 0.0045 * m;
  }
  if (uShimAmount <= 0.001) return;
  float raw = texture2D(depthBuffer, uv).r;
  if (raw >= 0.99999) return;
  float dist = exp2(raw * uShimLogFar) - 1.0;
  float s = smoothstep(30.0, 350.0, dist) * (1.0 - smoothstep(3500.0, 15000.0, dist));
  // Hotter, wobblier air toward the horizon, where the line of sight skims the ground.
  s *= 0.55 + 0.45 * uShimHaze * smoothstep(300.0, 2500.0, dist);
  s *= uShimAmount;
  vec2 q = vec2(uv.x * uShimAspect, uv.y);
  float w1 = sin(q.y * 70.0 - uShimTime * 2.6 + sin(q.x * 11.0 + uShimTime * 0.6) * 2.2);
  float w2 = sin(q.y * 190.0 - uShimTime * 5.1 + q.x * 37.0);
  float w3 = sin(q.x * 23.0 + q.y * 40.0 - uShimTime * 1.7);
  uv.x += (w1 * 0.55 + w2 * 0.3 + w3 * 0.15) * 0.006 * s;
  uv.y += (w1 * 0.6 + w3 * 0.4) * 0.002 * s;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
}
`,
      {
        attributes: EffectAttribute.DEPTH,
        uniforms: new Map<string, Uniform>([
          ['uShimAmount', new Uniform(0)],
          ['uShimTime', new Uniform(0)],
          ['uShimLogFar', new Uniform(1)],
          ['uShimHaze', new Uniform(1)],
          ['uShimAspect', new Uniform(1.7)],
          ['uPlasma', new Uniform(new Vector4())],
          ['uPlasmaEdge', new Uniform(0)],
        ]),
      },
    );
  }

  /** Per frame: finds the hot ground under the camera and sets the strength. */
  updateFrame(dt: number, logFar: number, aspect: number, cameraWorld: Vector3, sunPos: Vector3, bodies: readonly Body[]): void {
    let target = 0;
    const s = heatShimmerSettings;
    if (s.enabled && quality.settings.shimmer) {
      for (const b of bodies) {
        const def = findEffect(b.def, 'heatShimmer');
        if (!def) continue;
        this.up.copy(cameraWorld).sub(b.position);
        const alt = this.up.length() - b.radius;
        if (alt > 9000) continue;
        this.up.normalize();
        this.sun.copy(sunPos).sub(b.position).normalize();
        const sunDot = this.up.dot(this.sun);
        // Thick greenhouse air bakes day and night alike; thin air only shimmers in sunlight.
        const thick = b.def.atmosphere && b.def.atmosphere.mieDepth > 0.15 ? 1 : 0;
        const day = thick ? 0.85 + 0.15 * smooth(-0.2, 0.3, sunDot) : smooth(0.02, 0.4, sunDot);
        const near = 1 - smooth(1500, 9000, Math.max(0, alt));
        target = Math.max(target, def.intensity * s.intensity * (s.force ? 1 : day * near));
      }
    }
    this.amount += (Math.min(1.5, target) - this.amount) * (1 - Math.exp(-dt * 1.5));
    this.time += dt;
    const u = this.uniforms;
    u.get('uShimAmount')!.value = this.amount;
    u.get('uShimTime')!.value = this.time;
    u.get('uShimLogFar')!.value = logFar;
    u.get('uShimHaze')!.value = s.haze;
    u.get('uShimAspect')!.value = aspect;
    (u.get('uPlasma')!.value as Vector4).set(plasmaShimmer.x, plasmaShimmer.y, plasmaShimmer.radius, plasmaShimmer.amount);
    u.get('uPlasmaEdge')!.value = plasmaShimmer.edge;
  }
}
