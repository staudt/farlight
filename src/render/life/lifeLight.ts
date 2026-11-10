import { Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { RGB } from '../../data/types';
import { starLight } from '../starLight';

const WHITE = new Vector3(1, 1, 1);

/** Lighting shared by every creature material: one set of uniform objects, written once per frame. */
export class LifeLight {
  readonly uniforms = {
    uSunDirView: { value: new Vector3(0, 1, 0) },
    uSunElev: { value: 1 },
    uSky: { value: new Vector3(0.2, 0.3, 0.5) },
    uStarColor: starLight.uniform,
    uTime: { value: 0 },
    uNight: { value: 0 },
    uGlow: { value: 1 },
    uPx: { value: 600 },
  };
  private readonly q = new Quaternion();

  update(camera: PerspectiveCamera, sunDirWorld: Vector3, sunElev: number, night: number, sky: RGB | undefined, time: number, glow: number): void {
    const u = this.uniforms;
    this.q.copy(camera.quaternion).invert();
    u.uSunDirView.value.copy(sunDirWorld).applyQuaternion(this.q);
    u.uSunElev.value = sunElev;
    u.uNight.value = night;
    u.uTime.value = time;
    u.uGlow.value = glow;
    // Sky colour from the Rayleigh ratio (blue for Earth, whatever tint the world has).
    if (sky) {
      const m = Math.max(sky[0], sky[1], sky[2], 1e-4);
      u.uSky.value.set(sky[0] / m, sky[1] / m, sky[2] / m).lerp(WHITE, 0.45).multiplyScalar(0.55);
    } else {
      u.uSky.value.set(0.12, 0.12, 0.12);
    }
  }
}

/** GLSL uniforms and the lit colour function shared by the creature shaders. */
export const LIFE_LIGHT_GLSL = /* glsl */ `
  uniform vec3 uSunDirView;
  uniform float uSunElev;
  uniform vec3 uSky;
  uniform vec3 uStarColor;
  uniform float uTime;
  uniform float uNight;
  uniform float uGlow;
  // Soft wrapped sun light plus sky ambient. N is a view space normal; albedo is linear.
  vec3 lifeLit(vec3 albedo, vec3 N) {
    float term = smoothstep(-0.10, 0.22, uSunElev);
    float lam = clamp(dot(N, normalize(uSunDirView)) * 0.5 + 0.5, 0.0, 1.0);
    lam = 0.25 + 0.75 * lam * lam;
    vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.45, uSunElev));
    vec3 amb = (vec3(0.03) + uSky * (0.25 + 0.75 * term)) * mix(vec3(1.0), uStarColor, 0.6);
    return albedo * (sunCol * uStarColor * 1.25 * lam * term + amb);
  }
`;
