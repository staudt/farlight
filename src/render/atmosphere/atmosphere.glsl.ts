/**
 * Single scattering atmosphere (Rayleigh + Mie) applied as a post pass against the
 * logarithmic depth buffer. Output = scene * transmittance + inscatter. Up to MAX_ATMOS
 * atmospheres are composited back to front.
 *
 * Coordinates are camera relative world axes ("scene space"); the camera sits at the origin.
 * Precision: the camera altitude above each sphere is passed from float64 on the CPU, so the
 * ray / sphere tests near the surface do not suffer from float32 cancellation.
 */
export const MAX_ATMOS = 2;

export const atmosphereLib = /* glsl */ `
#define MAX_ATMOS ${MAX_ATMOS}
#define ATMO_STEPS 14
#define ATMO_LIGHT_STEPS 5
uniform int uAtmoSteps;         // quality: <= ATMO_STEPS
uniform int uAtmoLight;         // quality: <= ATMO_LIGHT_STEPS

uniform vec3 uSunDir;           // unit, scene space (sun is far: same for every pixel)
uniform int uCount;

uniform vec3 uCenter[MAX_ATMOS];     // planet center relative to camera
uniform float uRadius[MAX_ATMOS];    // sea level radius
uniform float uTop[MAX_ATMOS];       // atmosphere thickness
uniform float uCamAlt[MAX_ATMOS];    // camera altitude above sea level (float64 on CPU)
uniform float uHr[MAX_ATMOS];        // Rayleigh scale height (m)
uniform float uHm[MAX_ATMOS];        // Mie scale height (m)
uniform vec3 uBetaR[MAX_ATMOS];      // per meter at sea level
uniform vec3 uBetaM[MAX_ATMOS];      // per meter (tinted)
uniform vec3 uBetaA[MAX_ATMOS];      // absorption per meter (Rayleigh profile)
uniform float uMieG[MAX_ATMOS];
uniform float uSunI[MAX_ATMOS];

const float PI_ = 3.14159265359;

// Ray vs sphere centered at c with the ray origin at the camera (origin).
// k = |o - c|^2 - r^2, passed precisely as h * (2r + h) with h = altitude above r.
vec2 hitSphere(vec3 d, vec3 c, float k) {
  float b = -dot(c, d);
  float disc = b * b - k;
  if (disc < 0.0) return vec2(1e30, -1e30);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Generic ray / sphere for points other than the camera (light rays).
vec2 hitSphereFrom(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float k = dot(o, o) - r * r;
  float disc = b * b - k;
  if (disc < 0.0) return vec2(1e30, -1e30);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

float phaseR(float mu) { return 3.0 / (16.0 * PI_) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI_) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// Atmosphere i along direction d up to distance tScene, as out = scene * trans + inscatter.
void applyAtmosphere(int i, vec3 d, float tScene, out vec3 outTrans, out vec3 outInscatter) {
  outTrans = vec3(1.0);
  outInscatter = vec3(0.0);
  vec3 c = uCenter[i];
  float R = uRadius[i];
  float H = uTop[i];
  float RA = R + H;
  float h = uCamAlt[i];

  vec2 ta = hitSphere(d, c, (h - H) * (2.0 * RA + (h - H)));
  if (ta.x > ta.y || ta.y < 0.0) return;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  // Ground: the depth buffer when present, otherwise the sea level sphere.
  vec2 tg = hitSphere(d, c, h * (2.0 * R + h));
  if (tg.x < tg.y && tg.x > 0.0) t1 = min(t1, tg.x);
  t1 = min(t1, tScene);
  if (t1 <= t0) return;

  float seg = (t1 - t0) / float(uAtmoSteps);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float mu = dot(d, uSunDir);

  for (int s = 0; s < ATMO_STEPS; s++) {
    if (s >= uAtmoSteps) break;
    float t = t0 + (float(s) + 0.5) * seg;
    vec3 p = d * t - c;                 // relative to the planet center
    float r = length(p);
    float alt = max(r - R, 0.0);
    float dR = exp(-alt / uHr[i]) * seg;
    float dM = exp(-alt / uHm[i]) * seg;
    odR += dR;
    odM += dM;

    // Light ray toward the sun. Soft planet shadow: fade as the ray grazes the ground.
    vec3 up = p / r;
    float cosSun = dot(up, uSunDir);
    vec2 tl = hitSphereFrom(p, uSunDir, RA);
    float lseg = max(tl.y, 0.0) / float(uAtmoLight);
    float lR = 0.0;
    float lM = 0.0;
    for (int j = 0; j < ATMO_LIGHT_STEPS; j++) {
      if (j >= uAtmoLight) break;
      vec3 q = p + uSunDir * ((float(j) + 0.5) * lseg);
      float la = max(length(q) - R, 0.0);
      lR += exp(-la / uHr[i]) * lseg;
      lM += exp(-la / uHm[i]) * lseg;
    }
    // Horizon angle at this altitude: below it the sun is blocked by the planet.
    float horizon = -sqrt(max(0.0, 1.0 - (R * R) / (r * r)));
    float lit = smoothstep(horizon - 0.02, horizon + 0.02, cosSun);
    vec3 tau = uBetaR[i] * (odR + lR) + uBetaM[i] * 1.1 * (odM + lM) + uBetaA[i] * (odR + lR);
    vec3 att = exp(-tau) * lit;
    sumR += att * dR;
    sumM += att * dM;
  }

  vec3 inscatter = uSunI[i] * (sumR * uBetaR[i] * phaseR(mu) + sumM * uBetaM[i] * phaseM(mu, uMieG[i]));
  outTrans = exp(-(uBetaR[i] * odR + uBetaM[i] * 1.1 * odM + uBetaA[i] * odR));
  outInscatter = inscatter;
}

// Composes every atmosphere far to near onto the running affine transform: out = scene * T + L.
void atmoCompute(vec3 d, float tScene, inout vec3 T, inout vec3 L) {
  for (int i = 0; i < MAX_ATMOS; i++) {
    if (i >= uCount) break;
    vec3 tr, ins;
    applyAtmosphere(i, d, tScene, tr, ins);
    L = L * tr + ins;
    T *= tr;
  }
}
`;
