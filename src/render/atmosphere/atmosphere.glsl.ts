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
uniform float uAtmoAdaptive;    // sample spacing on short paths, in scale heights (0 = off)
uniform int uAtmoSteps;         // quality: <= ATMO_STEPS
uniform int uAtmoLight;         // quality: <= ATMO_LIGHT_STEPS

uniform vec3 uSunDir;           // unit, scene space (sun is far: same for every pixel)
uniform float uNightFx;         // quality: 0 off, 1 airglow and moon sky, 2 plus the twilight band
uniform vec3 uNightK;           // x airglow, y twilight band, z unused (config)
uniform vec3 uMoonSky;          // faint blue wash of a moonlit sky, already scaled by phase, size and night
uniform vec3 uMoonDirW;         // unit direction to the moon, scene space
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
uniform float uAtmoSelf[MAX_ATMOS];   // body index (eclipse shadows skip the body itself)

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

// Length of the ray (origin at the camera) inside the sphere of altitude hs, clipped to [t0, t1].
float insideLen(vec3 d, vec3 c, float R, float h, float hs, float t0, float t1, out float ta0, out float tb0) {
  float dh = h - hs;
  vec2 q = hitSphere(d, c, dh * (2.0 * (R + hs) + dh));
  ta0 = max(q.x, t0);
  tb0 = min(q.y, t1);
  return max(0.0, tb0 - ta0);
}

// Night extras for atmosphere i: a faint moonlit sky, the airglow shell (a green line on the limb,
// a green and orange band above the horizon) and the orange and red twilight band on the terminator.
vec3 nightExtras(int i, vec3 d, vec3 c, float R, float H, float h, float t0, float t1, vec3 tr) {
  vec3 add = vec3(0.0);
  float opa = 1.0 - dot(tr, vec3(0.3333));
  float mm = max(dot(d, uMoonDirW), 0.0);
  add += uMoonSky * opa * (0.55 + 2.0 * pow(mm, 8.0) + pow(mm, 64.0));
  if (uNightK.x > 0.0) {
    float a1, b1, a2, b2, a3, b3;
    float outer = insideLen(d, c, R, h, H * 0.44, t0, t1, a2, b2);
    float inner = insideLen(d, c, R, h, H * 0.33, t0, t1, a1, b1);
    float chord = max(outer - inner, 0.0);
    if (chord > 0.0) {
      vec3 p = d * (0.5 * (a2 + b2)) - c;
      float night = 1.0 - smoothstep(-0.22, 0.08, dot(normalize(p), uSunDir));
      // Chord relative to the horizon chord of a ground observer (planets are small: the curve matters).
      float y = chord / (sqrt(2.0 * R * H * 0.44) - sqrt(2.0 * R * H * 0.33));
      float g = min(0.35 * pow(y, 6.0), 1.0);
      float o = min(0.3 * pow(y, 4.0), 1.0) * (1.0 - 0.5 * min(g, 1.0));
      // Patchy, like real bands.
      float patchy = 0.8 + 0.2 * sin(8.0 * d.x + 5.0 * d.z + 2.0 * d.y);
      g *= patchy;
      vec3 glow = vec3(0.03, 0.15, 0.06) * g + vec3(0.14, 0.055, 0.015) * o;
      // Seen from outside the air, only the rays grazing the shell make the thin bright limb line.
      float ringAlt = length(p) - R;
      float ring = exp(-pow((ringAlt - 0.385 * H) / (0.06 * H), 2.0));
      glow *= mix(1.0, ring, smoothstep(0.3, 1.0, h / H));
      add += glow * night * uNightK.x * sqrt(tr);
    }
  }
  if (uNightFx > 1.5 && uNightK.y > 0.0) {
    float up = smoothstep(0.15, 0.8, h / H);
    if (up > 0.0) {
      float a4, b4;
      float chord = insideLen(d, c, R, h, H * 0.3, t0, t1, a4, b4);
      if (chord > 0.0) {
        vec3 p = d * (0.5 * (a4 + b4)) - c;
        float s = dot(normalize(p), uSunDir);
        float w = exp(-pow((s - 0.0) / 0.12, 2.0));
        vec3 col = mix(vec3(0.75, 0.1, 0.05), vec3(1.0, 0.45, 0.1), smoothstep(-0.12, 0.12, s));
        float y2 = chord / (2.0 * sqrt(2.0 * R * H * 0.3));
        add += col * w * (0.3 + 0.7 * smoothstep(0.1, 0.9, y2)) * 0.22 * up * uNightK.y;
      }
    }
  }
  return add;
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

  // Short paths (terrain a few km away) need no more samples than keep each one under a fraction of the
  // smaller scale height: the same spacing the full count gives on a long path, so the look is unchanged.
  int ns = uAtmoSteps;
  if (uAtmoAdaptive > 0.0) ns = clamp(int(ceil((t1 - t0) / (uAtmoAdaptive * min(uHr[i], uHm[i])))), 3, uAtmoSteps);
  float seg = (t1 - t0) / float(ns);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0;
  float odM = 0.0;
  float mu = dot(d, uSunDir);

  for (int s = 0; s < ATMO_STEPS; s++) {
    if (s >= ns) break;
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
    // Eclipses: other bodies' shadows darken the sunlight reaching this sample (dark sky in totality).
    if (uEclCfg.x > 0.5) att *= eclipseLight(d * t, uAtmoSelf[i]);
    sumR += att * dR;
    sumM += att * dM;
  }

  vec3 inscatter = uSunI[i] * uStarColor * (sumR * uBetaR[i] * phaseR(mu) + sumM * uBetaM[i] * phaseM(mu, uMieG[i]));
  outTrans = exp(-(uBetaR[i] * odR + uBetaM[i] * 1.1 * odM + uBetaA[i] * odR));
  outInscatter = inscatter;
  if (uNightFx > 0.5) outInscatter += nightExtras(i, d, c, R, H, h, t0, t1, outTrans);
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
