/**
 * Raymarched cloud layer: a spherical shell around the nearest cloudy body. Noise is sampled
 * in body fixed coordinates so clouds turn with the planet and drift with (warped) time.
 * Runs before the atmosphere effect so distant clouds get aerial perspective for free.
 */
export const cloudFragment = /* glsl */ `
precision highp sampler3D;
#define CLOUD_STEPS 30
#define CLOUD_LIGHT_STEPS 3

uniform sampler3D uNoise;
uniform int uActive;
uniform mat4 uInvProj;
uniform mat4 uCamToWorld;
uniform float uLogFar;
uniform vec3 uCenter;        // planet center relative to camera
uniform mat3 uToLocal;       // world -> body fixed rotation
uniform float uR;            // sea level radius
uniform float uCamAlt;       // camera altitude (float64 on CPU)
uniform float uBase;         // cloud base altitude (m)
uniform float uTop;          // cloud top altitude (m)
uniform float uScale;        // feature size (m)
uniform float uCoverage;
uniform vec3 uDrift;         // body fixed noise offset (m)
uniform vec3 uSunDir;
uniform vec3 uCloudColor;
uniform float uSunI;
uniform float uFlash;        // lightning flash 0..1
uniform vec3 uFlashPos;      // body fixed flash position (m)
uniform float uFrame;

vec2 hitShell(vec3 d, vec3 c, float k) {
  float b = -dot(c, d);
  float disc = b * b - k;
  if (disc < 0.0) return vec2(1e30, -1e30);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float remap01(float v, float a, float b) { return clamp((v - a) / (b - a), 0.0, 1.0); }

// Density at a body fixed position. h01 = height inside the layer 0..1.
float cloudDensity(vec3 pl, float h01, float detail) {
  // Height profile: flat bottoms, rounded tops.
  float shape = remap01(h01, 0.0, 0.12) * remap01(h01, 1.0, 0.55);
  if (shape <= 0.0) return 0.0;
  // Weather map: continent scale coverage variation.
  float weather = texture(uNoise, pl / (uScale * 28.0)).r;
  float weather2 = texture(uNoise, pl / (uScale * 9.0) + 0.37).r;
  float cov = clamp(uCoverage + (weather - 0.5) * 1.3 + (weather2 - 0.5) * 0.4, 0.0, 1.0);
  vec3 q = (pl + uDrift) / uScale;
  float base = texture(uNoise, q).r;
  float d = remap01(base * shape, 1.0 - cov, 1.0);
  if (d <= 0.0) return 0.0;
  // Erosion detail fades with distance: the 3D texture has no mips, so it would sparkle.
  if (detail > 0.01) {
    float erode = texture(uNoise, q * 3.7 + 0.13).g;
    d = remap01(d, erode * 0.35 * detail * (1.0 - h01 * 0.5), 1.0);
  }
  return d;
}

float hgPhase(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// Far mode: one smooth coverage sample on the mid shell. Cheap and grain free from orbit.
vec4 farClouds(vec3 d, float tScene, float rIn, float thickness) {
  float rMid = rIn + thickness * 0.5;
  float hMid = uCamAlt - (rMid - uR);
  vec2 tm = hitShell(d, uCenter, hMid * (2.0 * rMid + hMid));
  if (tm.x > tm.y || tm.x < 0.0 || tm.x > tScene) return vec4(0.0);
  vec3 pw = d * tm.x - uCenter;
  vec3 pl = uToLocal * pw;
  float weather = texture(uNoise, pl / (uScale * 28.0)).r;
  float weather2 = texture(uNoise, pl / (uScale * 9.0) + 0.37).r;
  float cov = clamp(uCoverage + (weather - 0.5) * 1.3 + (weather2 - 0.5) * 0.4, 0.0, 1.0);
  float base = texture(uNoise, (pl + uDrift) / uScale).r;
  float dens = smoothstep(1.0 - cov, 1.0 - cov + 0.35, base * 0.85 + 0.15 * weather2);
  vec3 up = pw / length(pw);
  float cosSun = dot(up, uSunDir);
  float day = smoothstep(-0.12, 0.06, cosSun);
  vec3 sunCol = mix(vec3(1.0, 0.45, 0.2), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.35, cosSun)) * day;
  // Thicker cloud reads brighter; a soft self shadow keeps some relief.
  float lambert = 0.35 + 0.65 * max(cosSun, 0.0);
  vec3 col = uCloudColor * (sunCol * uSunI * 0.62 * lambert * (0.7 + 0.3 * dens) + vec3(0.03, 0.04, 0.06) * day);
  // Grazing angles near the limb thicken the layer visually.
  float graze = 1.0 - abs(dot(d, up));
  float a = clamp(dens * (0.85 + 0.6 * graze), 0.0, 0.97);
  return vec4(col * a, a);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uActive == 0) return;

  vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 view = uInvProj * clip;
  vec3 dView = normalize(view.xyz / view.w);
  vec3 d = normalize(mat3(uCamToWorld) * dView);

  float raw = texture2D(depthBuffer, uv).r;
  float tScene = 1e30;
  if (raw < 0.99999) tScene = (exp2(raw * uLogFar) - 1.0) / max(-dView.z, 1e-4);

  float rIn = uR + uBase;
  float rOut = uR + uTop;
  float farMix = smoothstep(uTop + 15000.0, uTop + 120000.0, uCamAlt);
  vec4 far = vec4(0.0);
  if (farMix > 0.0) {
    far = farClouds(d, tScene, rIn, uTop - uBase);
    if (farMix >= 1.0) { outputColor = vec4(inputColor.rgb * (1.0 - far.a) + far.rgb, inputColor.a); return; }
  }
  float hIn = uCamAlt - uBase;   // camera altitude above the inner shell
  float hOut = uCamAlt - uTop;
  vec2 tOut = hitShell(d, uCenter, hOut * (2.0 * rOut + hOut));
  vec4 vol = vec4(0.0, 0.0, 0.0, 0.0); // rgb = light, a = 1 - transmittance
  bool march = !(tOut.x > tOut.y || tOut.y < 0.0);
  vec2 tInn = hitShell(d, uCenter, hIn * (2.0 * rIn + hIn));
  vec2 tGround = hitShell(d, uCenter, uCamAlt * (2.0 * uR + uCamAlt));

  float t0, t1;
  if (hOut > 0.0) {                       // above the layer
    t0 = tOut.x;
    t1 = (tInn.x < tInn.y && tInn.x > 0.0) ? tInn.x : tOut.y;
  } else if (hIn > 0.0) {                 // inside the layer
    t0 = 0.0;
    t1 = (tInn.x < tInn.y && tInn.x > 0.0) ? tInn.x : tOut.y;
  } else {                                // below the layer
    if (tGround.x < tGround.y && tGround.x > 0.0) march = false; // looking at the ground
    t0 = tInn.y;
    t1 = tOut.y;
  }
  t1 = min(t1, tScene);
  if (t1 <= t0) march = false;
  if (!march) {
    outputColor = vec4(inputColor.rgb * (1.0 - far.a * farMix) + far.rgb * farMix, inputColor.a);
    return;
  }

  float len = t1 - t0;
  float stepLen = len / float(CLOUD_STEPS);
  // Keep near steps fine when the layer is long (horizon, orbit views).
  float jitter = hash12(gl_FragCoord.xy + fract(uFrame * 0.618) * 100.0);
  float sigma = 1.0 / 180.0;               // extinction per meter at density 1
  float thickness = uTop - uBase;

  float trans = 1.0;
  vec3 light = vec3(0.0);
  float mu = dot(d, uSunDir);
  float phase = mix(hgPhase(mu, 0.65), hgPhase(mu, -0.2), 0.35) * 4.0 * 3.14159265;

  for (int i = 0; i < CLOUD_STEPS; i++) {
    float t = t0 + (float(i) + jitter) * stepLen;
    vec3 pw = d * t - uCenter;             // world axes, planet centered
    float r = length(pw);
    float h01 = (r - rIn) / thickness;
    vec3 pl = uToLocal * pw;
    float detail = 1.0 - smoothstep(uScale * 2.0, uScale * 8.0, t);
    float dens = cloudDensity(pl, h01, detail);
    if (dens > 0.003) {
      vec3 up = pw / r;
      float cosSun = dot(up, uSunDir);
      float day = smoothstep(-0.12, 0.06, cosSun);
      // Light march toward the sun.
      float od = 0.0;
      float ls = thickness * 0.28;
      for (int j = 1; j <= CLOUD_LIGHT_STEPS; j++) {
        vec3 q = pw + uSunDir * (ls * float(j));
        float qh = (length(q) - rIn) / thickness;
        od += cloudDensity(uToLocal * q, qh, 0.0) * ls;
      }
      float lightT = exp(-od * sigma * 0.6);
      float powder = 1.0 - exp(-dens * 2.0);
      // Sunlight gets warm when the sun is low.
      vec3 sunCol = mix(vec3(1.0, 0.42, 0.18), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.35, cosSun)) * day;
      vec3 ambient = mix(vec3(0.015, 0.02, 0.035), vec3(0.42, 0.55, 0.78), day) * (0.45 + 0.55 * h01);
      vec3 col = uCloudColor * (sunCol * uSunI * lightT * phase * mix(1.0, powder, 0.5) + ambient);
      // Lightning lights the cloud from inside.
      if (uFlash > 0.0) {
        float fd = length(pl - uFlashPos);
        col += vec3(0.75, 0.8, 1.0) * uFlash * 6.0 * exp(-fd / (thickness * 1.5));
      }
      float a = 1.0 - exp(-dens * sigma * stepLen);
      light += trans * a * col;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
  }
  vec3 volColor = inputColor.rgb * trans + light;
  vec3 farColor = inputColor.rgb * (1.0 - far.a) + far.rgb;
  outputColor = vec4(mix(volColor, farColor, farMix), inputColor.a);
}
`;
