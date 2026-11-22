/**
 * Raymarched cloud layer: a spherical shell around the nearest cloudy body. Noise is sampled
 * in body fixed coordinates so clouds turn with the planet and drift with (warped) time.
 * Runs before the atmosphere effect so distant clouds get aerial perspective for free.
 */
export const cloudLib = /* glsl */ `
precision highp sampler3D;
#define CLOUD_STEPS 30
#define CLOUD_LIGHT_STEPS 3
#define CLOUD_MIN_STEPS 7
// Quality (live): uCloudSteps <= CLOUD_STEPS, uCloudLight <= CLOUD_LIGHT_STEPS, uCloudShadows 0/1.
uniform int uCloudSteps;
uniform int uCloudLight;
uniform int uCloudShadows;

uniform sampler3D uNoise;
uniform int uActive;
uniform vec3 uCCenter;        // planet center relative to camera
uniform mat3 uToLocal;       // world -> body fixed rotation
uniform float uR;            // sea level radius
uniform float uCCamAlt;       // camera altitude (float64 on CPU)
uniform float uBase;         // cloud base altitude (m)
uniform float uCTop;          // cloud top altitude (m)
uniform float uScale;        // feature size (m)
uniform float uCoverage;
uniform vec3 uDrift;         // body fixed noise offset (m)
uniform vec3 uCSunDir;
uniform float uCloudSelf;     // body index for eclipse shadows (skips the body itself)
uniform vec3 uCloudColor;
uniform float uCSunI;
uniform float uFlash;        // lightning flash 0..1
uniform vec3 uFlashPos;      // body fixed flash position (m)
uniform float uFrame;
uniform float uCStruct;       // weather structure strength (latitude bands, fronts, cyclones), 0 = plain noise
uniform vec4 uCyc[4];         // cyclones: body fixed direction xyz, cos of the angular radius w (2 = off)
uniform vec3 uCMoonDir;       // world axes, toward the moon
uniform vec3 uNLCol;          // moonlight colour (0 without a moon)
uniform vec4 uCLit;           // lighting: x powder, y silver, z underside, w sunset warmth

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

float remap01(float v, float a, float b) { return clamp((v - a) / (abs(b - a) < 1e-4 ? 1e-4 : b - a), 0.0, 1.0); }

// Weather scale coverage 0..1 at a body fixed position. CPU twin: weatherCover in coverage.ts, keep in sync.
float cloudCover(vec3 pl) {
  float w1 = texture(uNoise, (pl + uDrift) / (uScale * 28.0)).r;
  float w2 = texture(uNoise, pl / (uScale * 9.0) + 0.37).r;
  float s = uCStruct;
  float cov = uCoverage + (w1 - 0.5) * (1.3 - 0.75 * s) + (w2 - 0.5) * (0.4 - 0.1 * s);
  if (s > 0.0) {
    vec3 dir = pl / max(length(pl), 1.0);
    float lat = asin(clamp(dir.y, -1.0, 1.0));
    float lon = atan(-dir.z, dir.x + 1e-6);
    float al = abs(lat + s * (0.1 * sin(lon * 4.0 + w1 * 9.0) + (w2 - 0.5) * 0.25));
    float a0 = al / 0.13, a1 = (al - 0.45) / 0.14, a2 = (al - 0.95) / 0.2;
    cov += s * (0.4 * exp(-a0 * a0) * (0.4 + 1.2 * w1) - 0.4 * exp(-a1 * a1) + 0.22 * exp(-a2 * a2) * (0.4 + 1.1 * w1) - 0.1 * smoothstep(1.2, 1.5, al));
    for (int i = 0; i < 4; i++) {
      vec4 cy = uCyc[i];
      float cd = dot(dir, cy.xyz);
      if (cd <= cy.w) continue;
      float r = sqrt((1.0 - cd) / (1.0 - cy.w));
      vec3 u = vec3(-cy.z, 0.0, cy.x) / max(length(vec2(cy.z, cy.x)), 1e-5);
      vec3 v = cross(cy.xyz, u);
      float th = atan(dot(dir, v), dot(dir, u) + 1e-6) * (cy.y >= 0.0 ? 1.0 : -1.0);
      float arm = 0.5 + 0.5 * sin(2.0 * th + 7.0 * log(r + 0.08) + (w2 - 0.5) * 2.5);
      float env = smoothstep(1.0, 0.25, r);
      float wall = smoothstep(0.04, 0.12, r) * (1.0 - smoothstep(0.25, 0.5, r));
      float spiral = max(0.2 + 0.8 * arm, wall) * smoothstep(0.02, 0.1, r);
      cov += (spiral - cov) * env * min(1.0, s) * 0.9;
    }
    // Heavy weather closes up into overcast.
    cov += 0.2 * s * smoothstep(0.55, 0.9, cov);
  }
  // Soft ceiling: fully saturated coverage is a flat grey sheet with no relief.
  // Storm decks bypass the ceiling and close to full overcast.
  float storm = smoothstep(0.7, 0.88, cov) * min(1.0, s * 2.0);
  if (cov > 0.86) cov = 0.86 + (cov - 0.86) * 0.4;
  return clamp(mix(cov, 1.0, storm), 0.0, 1.0);
}

// Density at a body fixed position for a known coverage (the light march reuses the sample's own
// coverage: it barely changes over a few hundred meters). h01 = height inside the layer 0..1.
float cloudDensityC(vec3 pl, float h01, float detail, float cov) {
  // Height profile: flat bottoms, rounded tops.
  float shape = remap01(h01, 0.0, 0.12) * remap01(h01, 1.0, 0.55);
  if (shape <= 0.0) return 0.0;
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

float cloudDensity(vec3 pl, float h01, float detail) {
  if (h01 < 0.0 || h01 > 1.0) return 0.0;
  return cloudDensityC(pl, h01, detail, cloudCover(pl));
}

// Exit distance from point p (inside the sphere) along d through a sphere of radius r.
float exitSphere(vec3 p, vec3 d, float r) {
  float b = dot(p, d);
  float k = dot(p, p) - r * r;
  return -b + sqrt(max(b * b - k, 0.0));
}

// Fraction of sunlight reaching a surface point under the cloud layer (0 = deep shadow).
float cloudShadow(vec3 pw, float rIn, float rOut, float thickness) {
  if (dot(normalize(pw), uCSunDir) < -0.05) return 1.0;
  float tIn = exitSphere(pw, uCSunDir, rIn);
  float tOut = exitSphere(pw, uCSunDir, rOut);
  float seg = (tOut - tIn) / 4.0;
  float od = 0.0;
  for (int j = 0; j < 4; j++) {
    vec3 q = pw + uCSunDir * (tIn + (float(j) + 0.5) * seg);
    float qh = (length(q) - rIn) / thickness;
    od += cloudDensity(uToLocal * q, qh, 0.0) * seg;
  }
  return exp(-od * (1.0 / 180.0) * 0.35);
}

float hgPhase(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

// Far mode: one smooth coverage sample on the mid shell. Cheap and grain free from orbit.
// Features are stretched along the latitude circles (zonal streaks) and lit with a one tap self shadow
// toward the sun, so bands, fronts and cyclones read as weather instead of cotton balls.
vec4 farClouds(vec3 d, float tScene, float rIn, float thickness, out float tHit) {
  tHit = 0.0;
  float rMid = rIn + thickness * 0.5;
  float hMid = uCCamAlt - (rMid - uR);
  vec2 tm = hitShell(d, uCCenter, hMid * (2.0 * rMid + hMid));
  if (tm.x > tm.y || tm.x < 0.0 || tm.x > tScene) return vec4(0.0);
  vec3 pw = d * tm.x - uCCenter;
  vec3 pl = uToLocal * pw;
  float cov = cloudCover(pl);
  vec3 dirL = pl / max(length(pl), 1.0);
  vec3 east = normalize(vec3(dirL.z, 1e-4, -dirL.x));
  vec3 north = cross(dirL, east);
  float stretch = 1.0 - 0.7 * uCStruct;
  // Swirl: a slow low frequency warp bends the streaks into fronts and curls.
  vec2 wn = texture(uNoise, pl / (uScale * 11.0) + 0.71).rg - 0.5;
  vec3 q = pl - east * dot(pl, east) * (1.0 - stretch) + (east * wn.x + north * wn.y) * (uScale * 7.0 * uCStruct);
  float fp = tm.x * 0.0018 / uScale;                    // pixel footprint in noise cells
  float fine = 1.0 - smoothstep(0.05, 0.2, fp);
  // Lower octave than the volume: from orbit the full frequency aliases (no 3D mips).
  float base = texture(uNoise, (q + uDrift) / (uScale * 4.0)).r;
  float w2 = texture(uNoise, pl / (uScale * 9.0) + 0.37).r;
  float erode = texture(uNoise, (q + uDrift) / (uScale * 1.1) + 0.21).g;
  base = base * 0.85 + 0.15 * w2;
  base -= (0.5 - erode) * 0.18 * fine;
  float dens = smoothstep(1.0 - cov, 1.0 - cov + 0.22, base);
  // Self shadow: density a little toward the sun along the surface.
  vec3 sunL = uToLocal * uCSunDir;
  vec3 sunT = sunL - dirL * dot(sunL, dirL);
  vec3 qs = q + sunT * (uScale * 1.6);
  float baseS = texture(uNoise, (qs + uDrift) / (uScale * 4.0)).r * 0.85 + 0.15 * w2;
  float densS = smoothstep(1.0 - cov, 1.0 - cov + 0.22, baseS);
  float shadowed = clamp((densS - dens) * 1.6 + 0.0, 0.0, 1.0);
  float edgeLit = clamp((dens - densS) * 1.6, 0.0, 1.0);
  vec3 up = pw / length(pw);
  float cosSun = dot(up, uCSunDir);
  float day = smoothstep(-0.12, 0.06, cosSun);
  vec3 sunCol = mix(vec3(1.0, 0.45, 0.2), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.35, cosSun)) * day;
  float lambert = 0.35 + 0.65 * max(cosSun, 0.0);
  vec3 eclL = uEclCfg.x > 0.5 ? eclipseLight(d * tm.x, uCloudSelf) : vec3(1.0);
  // Thick cloud is brighter on top; the lee side falls into bluish grey.
  float shade = (1.0 - 0.55 * shadowed * dens) * (0.88 + 0.2 * edgeLit);
  vec3 grey = mix(vec3(1.0), vec3(0.62, 0.7, 0.86), uCLit.z * dens * shadowed);
  vec3 col = uCloudColor * (sunCol * uStarColor * eclL * uCSunI * 1.15 * lambert * (0.72 + 0.3 * dens) * shade * grey + vec3(0.03, 0.04, 0.06) * day * mix(vec3(1.0), uStarColor, 0.6));
  // Grazing angles near the limb thicken the layer visually.
  float graze = 1.0 - abs(dot(d, up));
  float a = clamp(dens * (0.85 + 0.6 * graze), 0.0, 0.97);
  tHit = tm.x;
  return vec4(col * a, a);
}

// Writes the cloud layer as an affine function of the scene color: out = scene * T + L.
// tHit is the opacity weighted distance of the cloud along the ray (0 = none), for temporal reprojection.
void cloudCompute(vec3 d, vec3 dView, float tScene, out float T, out vec3 L, out float tHit) {
  T = 1.0;
  L = vec3(0.0);
  tHit = 0.0;
  if (uActive == 0) return;

  float rIn = uR + uBase;
  float rOut = uR + uCTop;
  float sceneMul = 1.0;
  // Cloud shadows on terrain (and anything else) below the cloud base.
  if (uCloudShadows != 0 && tScene < 1e29) {
    float fade = 1.0 - smoothstep(uScale * 6.0, uScale * 20.0, tScene);
    if (fade > 0.0) {
      vec3 pg = d * tScene - uCCenter;
      float rg = length(pg);
      if (rg < rIn) {
        float sh = cloudShadow(pg, rIn, rOut, uCTop - uBase);
        sceneMul = mix(1.0, 0.18 + 0.82 * sh, fade);
      }
    }
  }
  float farMix = smoothstep(uCTop + 15000.0, uCTop + 120000.0, uCCamAlt);
  vec4 far = vec4(0.0);
  float farT = 0.0;
  if (farMix > 0.0) {
    far = farClouds(d, tScene, rIn, uCTop - uBase, farT);
    if (farMix >= 1.0) { T = sceneMul * (1.0 - far.a); L = far.rgb; tHit = farT; return; }
  }
  float hIn = uCCamAlt - uBase;   // camera altitude above the inner shell
  float hOut = uCCamAlt - uCTop;
  vec2 tOut = hitShell(d, uCCenter, hOut * (2.0 * rOut + hOut));
  bool march = !(tOut.x > tOut.y || tOut.y < 0.0);
  vec2 tInn = hitShell(d, uCCenter, hIn * (2.0 * rIn + hIn));
  vec2 tGround = hitShell(d, uCCenter, uCCamAlt * (2.0 * uR + uCCamAlt));

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
    T = sceneMul * (1.0 - far.a * farMix);
    L = far.rgb * farMix;
    tHit = farT;
    return;
  }

  float len = t1 - t0;
  // Adaptive step count: short paths (looking up through the layer) need few samples.
  float thicknessM = uCTop - uBase;
  int steps = int(clamp(len / (thicknessM * 0.12), min(float(CLOUD_MIN_STEPS), float(uCloudSteps)), float(uCloudSteps)));
  float stepLen = len / float(steps);
  // Interleaved gradient noise, shifted every frame (golden ratio): the temporal resolve averages it away.
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + fract(uFrame * 0.61803398875));
  float sigma = 1.0 / 180.0;               // extinction per meter at density 1
  float thickness = uCTop - uBase;

  float trans = 1.0;
  vec3 light = vec3(0.0);
  float tw = 0.0, tws = 0.0;
  float mu = dot(d, uCSunDir);
  // Forward scattering lobes per multiple scattering octave, plus a narrow silver peak.
  float p0 = mix(hgPhase(mu, 0.4), hgPhase(mu, -0.25), 0.35) * 4.0 * 3.14159265;
  float p1 = mix(hgPhase(mu, 0.3), hgPhase(mu, -0.12), 0.3) * 4.0 * 3.14159265;
  float pSilver = min(hgPhase(mu, 0.93) * 4.0 * 3.14159265, 30.0);
  float powderK = uCLit.x * (1.0 - 0.75 * smoothstep(0.2, 0.9, mu)); // backlit: powder edges wash out
  float silverK = uCLit.y * smoothstep(-0.2, 0.7, mu);
  float coverageHere = 0.0;

  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (i >= steps) break;
    float t = t0 + (float(i) + jitter) * stepLen;
    vec3 pw = d * t - uCCenter;             // world axes, planet centered
    float r = length(pw);
    float h01 = (r - rIn) / thickness;
    if (h01 < 0.0 || h01 > 1.0) continue;
    vec3 pl = uToLocal * pw;
    float detail = 1.0 - smoothstep(uScale * 2.0, uScale * 8.0, t);
    float cov = cloudCover(pl);
    float dens = cloudDensityC(pl, h01, detail, cov);
    if (dens > 0.003) {
      vec3 eclL = uEclCfg.x > 0.5 ? eclipseLight(d * t, uCloudSelf) : vec3(1.0);
      vec3 up = pw / r;
      float cosSun = dot(up, uCSunDir);
      float day = smoothstep(-0.12, 0.06, cosSun);
      // Light march toward the sun. Far samples get fewer steps (their detail is gone anyway).
      float od = 0.0;
      float ls = thickness * 0.4;
      int nl = detail > 0.01 ? uCloudLight : min(uCloudLight, 2);
      for (int j = 1; j <= CLOUD_LIGHT_STEPS; j++) {
        if (j > nl) break;
        vec3 q = pw + uCSunDir * (ls * float(j));
        float qh = (length(q) - rIn) / thickness;
        od += (qh < 0.0 || qh > 1.0) ? 0.0 : cloudDensityC(uToLocal * q, qh, 0.0, cov) * ls;
      }
      od *= 3.0 / float(max(nl, 1)); // keep the optical depth of the full 3 step march
      // Multiple scattering: three octaves, each attenuated less and scattered more evenly.
      float e0 = exp(-od * sigma * 2.4);
      float e1 = exp(-od * sigma * 0.8);
      float e2 = exp(-od * sigma * 0.15);
      float powder = mix(1.0, 1.0 - exp(-dens * 3.0), powderK);
      float direct = e0 * p0 * powder + 0.1 * e1 * p1 + 0.03 * e2;
      // The base sits under the whole cloud: darker toward the bottom.
      float baseDark = uCLit.z * (1.0 - smoothstep(0.0, 0.65, h01)) * (0.45 + 0.55 * (1.0 - e1));
      float deck = smoothstep(0.93, 1.0, cov);   // storm deck: dark grey all through
      direct *= (1.0 - 0.95 * baseDark) * (1.0 - 0.85 * deck);
      // Silver lining: thin edges lit from behind glow with the narrow forward lobe.
      direct += silverK * pSilver * e1 * exp(-dens * 2.5) * 0.05;
      // Sunlight gets warm when the sun is low.
      vec3 sunCol = mix(vec3(1.0, 0.42, 0.18), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.35, cosSun)) * day;
      // Sky light: tops see the sky, the underside is a darker bluish grey, deep cores are occluded.
      float warm = (1.0 - smoothstep(0.0, 0.4, cosSun)) * day * uCLit.w;
      vec3 skyAmb = mix(vec3(0.015, 0.02, 0.035), vec3(0.42, 0.55, 0.78), day);
      skyAmb = mix(skyAmb, vec3(0.6, 0.34, 0.3) * day + skyAmb * 0.4, warm * h01);
      float under = mix(1.0, 0.22 + 0.78 * pow(h01, 0.8), uCLit.z);
      vec3 ambient = skyAmb * 0.55 * (1.0 - 0.7 * baseDark) * (1.0 - 0.72 * deck) * under * (0.55 + 0.45 * e2) * mix(vec3(0.78, 0.86, 1.0), vec3(1.0), h01 * 0.6 + 0.4 * (1.0 - uCLit.z));
      vec3 col = uCloudColor * (sunCol * uStarColor * eclL * uCSunI * direct + ambient * mix(vec3(1.0), uStarColor, 0.6));
      // Moonlight on the tops at night.
      col += uCloudColor * uNLCol * (0.6 + 0.4 * smoothstep(0.3, 1.0, h01)) * (0.5 + 0.5 * max(dot(up, uCMoonDir), 0.0)) * 2.0 * (1.0 - day) * (1.0 - 0.7 * baseDark);
      // Lightning lights the cloud from inside.
      if (uFlash > 0.0) {
        float fd = length(pl - uFlashPos);
        col += vec3(0.75, 0.8, 1.0) * uFlash * 6.0 * exp(-fd / (thickness * 1.5));
      }
      float a = 1.0 - exp(-dens * sigma * stepLen);
      light += trans * a * col;
      tw += trans * a * t;
      tws += trans * a;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
  }
  T = sceneMul * mix(trans, 1.0 - far.a, farMix);
  L = mix(light, far.rgb, farMix);
  tHit = tws > 0.004 ? tw / tws : farT;
}
`;
