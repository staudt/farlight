import { MAX_RING_GAPS } from './profile';

/**
 * Shared GLSL: radial ring density at a body-fixed radius `r` (planet radii). Used by the
 * ring disc, the ring rocks and the planet shader (ring shadow on the cloud tops), so they
 * always agree. Declares its own uniforms; every material using it must provide them
 * (`makeRingUniforms` has the full set).
 *
 * `ringDensityLod(r, fw)` takes the footprint `fw` (pixel size across the ring width, as a
 * fraction of it). Octaves finer than the footprint fade to their mean, so a distant ring is
 * smooth (no aliasing) and detail appears as the camera approaches.
 */
export const RING_GLSL = /* glsl */ `
uniform float uRingIn, uRingOut, uRingBands, uRingSeed, uRingOpacity, uRingDetail, uRingOct, uRingSpokes;
uniform vec3 uRingGaps[${MAX_RING_GAPS}];
float rgHash(float p) {
  p = fract((p + uRingSeed) * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float rgNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(rgHash(i), rgHash(i + 1.0), f);
}
/** Noise that repeats every n steps (for angles). */
float rgNoiseP(float x, float n) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(rgHash(mod(i, n)), rgHash(mod(i + 1.0, n)), f);
}
/** One octave, faded to its mean 0.5 when the footprint reaches its wavelength. */
float rgOct(float u, float freq, float off, float fw) {
  return mix(0.5, rgNoise(u * freq + off), 1.0 - smoothstep(0.35, 1.3, freq * fw));
}
/** Fine ringlet structure, about -1..1, zero where unresolved (octaves finer than the footprint are skipped). */
float ringFine(float u, float fw) {
  float f = uRingBands * 5.0;
  float s = 0.0;
  float a = 0.4;
  for (int i = 0; i < 9; i++) {
    if (float(i) >= uRingOct || f * fw > 1.3) break;
    s += a * (rgOct(u, f, 31.0 + float(i) * 13.7, fw) - 0.5) * 2.0;
    f *= 2.35;
    a *= 0.84;
  }
  return s;
}
/** 0..1 optical density across the annulus (before the opacity multiplier). */
float ringDensityLod(float r, float fw) {
  float u = (r - uRingIn) / (uRingOut - uRingIn);
  if (u < 0.0 || u > 1.0) return 0.0;
  float n = rgOct(u, uRingBands, 0.0, fw) * 0.55 + rgOct(u, uRingBands * 2.7, 17.0, fw) * 0.3 + rgOct(u, uRingBands * 9.0, 5.0, fw) * 0.15;
  float d = smoothstep(0.12, 0.85, n) * 0.85 + 0.15;
  d *= clamp(1.0 + uRingDetail * 1.1 * ringFine(u, fw), 0.05, 1.5);
  // Faint inner ring, bright dense middle, thinner towards the outside.
  float zone = mix(0.32, 1.0, smoothstep(0.24, 0.30, u));
  zone *= mix(1.0, 0.82, smoothstep(0.30, 0.66, u));
  float gap = 1.0;
  for (int i = 0; i < ${MAX_RING_GAPS}; i++) {
    vec3 g = uRingGaps[i];
    if (g.z <= 0.0 || abs(u - g.x) > g.y * 3.0 + fw * 2.0) continue;
    float soft = max(g.y * 0.2, fw * 0.7);
    float inside = 1.0 - smoothstep(g.y - soft, g.y + soft, abs(u - g.x));
    // A gap narrower than the footprint only dims the ring.
    float seen = clamp(2.0 * g.y / max(2.0 * g.y, fw * 1.5), 0.0, 1.0);
    gap *= 1.0 - g.z * inside * seen;
  }
  float edge = smoothstep(0.0, 0.02, u) * smoothstep(1.0, 0.985, u);
  return clamp(d * zone * gap * edge, 0.0, 1.0);
}
/** Coarse density, for shadows on the planet. */
float ringDensity(float r) {
  return ringDensityLod(r, 0.004);
}
/** Fraction of sunlight blocked by the ring on its way to body-fixed point p (unit planet radius). */
float ringShadowAt(vec3 p, vec3 sunL) {
  if (abs(sunL.y) < 1e-3) return 0.0;
  float t = -p.y / sunL.y;
  if (t <= 0.0) return 0.0;
  vec3 h = p + sunL * t;
  return ringDensity(length(h.xz)) * uRingOpacity;
}
/** Faint radial wedges across the middle of the ring: 0..1. */
float ringSpoke(float u, float ang) {
  float zone = smoothstep(0.3, 0.4, u) * (1.0 - smoothstep(0.62, 0.7, u));
  if (zone <= 0.0) return 0.0;
  float a = (ang / 6.2831853 + 0.5);
  float w = rgNoiseP(a * 36.0 + u * 2.5, 36.0) * rgNoiseP(a * 11.0 - u * 1.2 + 4.0, 11.0);
  return smoothstep(0.32, 0.6, w) * zone * (0.6 + 0.4 * rgNoise(u * 60.0 + 9.0));
}
`;
