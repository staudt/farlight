import { Color, ShaderMaterial, Texture, Vector3 } from 'three';
import { starLight } from '../starLight';
import { NIGHT_LIGHT_GLSL, nightUniforms } from '../nightLight';
import { ECLIPSE_GLSL, eclipse } from '../eclipse';
import { WAVE_COUNT, createWaveUniforms, waterLook } from './waterWaves';
import type { BodyDef } from '../../data/types';

/** Flat shaded, vertex colored terrain material with sun lighting and glinting water. */
export function createTerrainMaterial(def?: BodyDef): ShaderMaterial {
  const wave = createWaveUniforms(waterLook(def ?? ({} as BodyDef)));
  return new ShaderMaterial({
    side: 2, // DoubleSide: skirts and any winding mismatch never show holes
    uniforms: {
      uSunDirView: { value: new Vector3(1, 0, 0) },
      uBodyCenterView: { value: new Vector3(0, 0, -1e6) },
      uSkyAmbient: { value: new Color(0.55, 0.7, 1.0).multiplyScalar(0.08) },
      uTime: { value: 0 },
      uSunIntensity: { value: 1.25 },
      uStarColor: starLight.uniform,
      ...nightUniforms,
      ...eclipse.uniforms,
      uEclSelf: { value: -1 },
      uGlow: { value: 1 },
      uNightAmb: { value: 0.08 },
      // Settlement lights map (night side), used by coarse chunks; uLampColor is zero without one.
      uLights: { value: null as Texture | null },
      uLampColor: { value: new Vector3(0, 0, 0) },
      ...wave,
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aColor;
      attribute vec3 aWater;
      attribute vec4 aEmit;
      attribute vec4 aDir;
      varying vec4 vEmit;
      varying vec4 vDir;
      varying vec3 vColor;
      varying vec3 vWater;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vColor = aColor;
        vWater = aWater;
        vEmit = aEmit;
        vDir = aDir;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDirView;
      uniform vec3 uBodyCenterView;
      uniform vec3 uSkyAmbient;
      uniform float uNightAmb;
      uniform float uTime;
      uniform float uSunIntensity;
      uniform vec3 uStarColor;
      uniform float uEclSelf;
      ${ECLIPSE_GLSL}
      uniform float uGlow;
      uniform sampler2D uLights;
      uniform vec3 uLampColor;
      uniform vec3 uWaveK[${WAVE_COUNT}];
      uniform float uWaveP[${WAVE_COUNT}];
      uniform float uWaveS[${WAVE_COUNT}];
      uniform float uWaveL[${WAVE_COUNT}];
      uniform float uWaveAmp;
      uniform float uWaveBands;
      uniform float uFoam;
      uniform float uFoamWidth;
      uniform vec3 uFoamColor;
      uniform vec3 uSssColor;
      uniform float uHasWater;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSkyDepth;
      uniform vec4 uWaterA;
      uniform vec4 uWaterB;
      uniform vec3 uMoonDir;
      uniform float uMoonLit;
      ${NIGHT_LIGHT_GLSL}
      varying vec4 vDir;
      varying vec4 vEmit;
      varying vec3 vColor;
      varying vec3 vWater;
      varying vec3 vViewPos;
      float h12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      // Smooth value noise over the glitter cells (two hashes per corner: strength and twinkle phase).
      vec2 gnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        vec2 a = vec2(h12(i), h12(i + 41.7));
        vec2 b = vec2(h12(i + vec2(1.0, 0.0)), h12(i + vec2(1.0, 0.0) + 41.7));
        vec2 c = vec2(h12(i + vec2(0.0, 1.0)), h12(i + vec2(0.0, 1.0) + 41.7));
        vec2 d = vec2(h12(i + 1.0), h12(i + 1.0 + 41.7));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      // One layer of glitter cells fixed to the water: twinkles over time, mean about 1.
      float glitterLayer(vec2 uv, float s, float t) {
        vec2 n = gnoise(uv * s);
        float tw = 0.5 + 0.5 * sin(t * (1.6 + 2.4 * n.y) + 40.0 * n.y);
        float a = smoothstep(0.25, 0.95, n.x);
        return a * a * (0.15 + 4.5 * tw * tw * tw);
      }
      // Glitter with cells about two pixels wide at any distance (two octaves blended): grainy, never banded.
      float glitter(vec2 uv, float fw, float t) {
        float lv = log2(max(fw * 3.0 * 2.0, 1.0));
        float l0 = floor(lv);
        float s0 = 3.0 / exp2(l0);
        float a = glitterLayer(uv, s0, t);
        float b = glitterLayer(uv + 17.3, s0 * 0.5, t);
        return mix(a, b, smoothstep(0.0, 1.0, lv - l0)) * 1.6;
      }
      // Anisotropic Beckmann lobe: sa along the plane of incidence, sc across it.
      float glintLobe(vec3 N, vec3 Hv, vec3 Lv, float sa, float sc) {
        float nh = max(dot(N, Hv), 0.02);
        vec3 hp = Hv / nh - N;
        vec3 lt = Lv - N * dot(Lv, N);
        float ll = length(lt);
        vec3 Tp = ll > 1e-4 ? lt / ll : normalize(cross(N, vec3(0.0, 1.0, 0.001)));
        vec3 Tq = cross(N, Tp);
        float x = dot(hp, Tp) / sa;
        float y = dot(hp, Tq) / sc;
        float nh2 = nh * nh;
        return exp(-(x * x + y * y)) / (3.14159 * sa * sc * nh2 * nh2);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        vec3 V = normalize(-vViewPos);
        vec3 L = normalize(uSunDirView);
        vec3 R = normalize(vViewPos - uBodyCenterView);
        // Keep the flat normal on the outward side.
        if (dot(N, R) < 0.0) N = -N;
        float skirt = step(1.5, vWater.x);
        // Skirts are shaded like the ground they hang from, not like vertical walls.
        N = normalize(mix(N, R, skirt));
        float isWater = step(0.5, mod(vWater.x, 2.0));
        // The sea surface is a sphere: start from the smooth radial normal. Flat triangle normals
        // differ by tiny amounts that the sharp sun glitter turns into a zigzag on fine chunks.
        N = normalize(mix(N, R, isWater * (1.0 - skirt)));
        // Directional swells: tilt of the facet normal, crest height and breaking foam from a few waves.
        float crest = 0.0;
        float foam = 0.0;
        float shore = vWater.z;
        float dist = length(vViewPos);
        vec3 wTilt = vec3(0.0);
        vec2 glUV = vec2(0.0);
        float glFw = 1.0;
        float fadedVar = 0.0;
        if (isWater > 0.5 && skirt < 0.5 && uHasWater > 0.5) {
          float hsum = 0.0;
          float wsum = 0.0;
          float raw[${WAVE_COUNT}];
          for (int i = 0; i < ${WAVE_COUNT}; i++) raw[i] = dot(uWaveK[i], vViewPos) + uWaveP[i];
          for (int i = 0; i < ${WAVE_COUNT}; i++) {
            if (float(i) >= uWaveBands) break;
            float L0 = uWaveL[i];
            float fade = 1.0 - smoothstep(L0 * 7.0, L0 * 55.0, dist);
            int j1 = i + 1 < ${WAVE_COUNT} ? i + 1 : 0;
            int j2 = i + 2 < ${WAVE_COUNT} ? i + 2 : i + 2 - ${WAVE_COUNT};
            // Neighbouring swells bend this one and patch its strength, so the pattern is never a regular grid.
            float ph = raw[i] + 2.4 * sin(raw[j1]);
            float swellK = 0.55 + 0.45 * sin(raw[j2] * 0.45 + float(i) * 1.7);
            // Sharpened crests: a cheap trochoid.
            float s1 = sin(ph + 0.55 * sin(ph));
            float c1 = cos(ph + 0.55 * sin(ph)) * (1.0 + 0.55 * cos(ph));
            vec3 kd = normalize(uWaveK[i]);
            wTilt += kd * c1 * uWaveS[i] * fade * swellK;
            fadedVar += (1.0 - fade) * uWaveS[i] * uWaveS[i] * 0.3;
            hsum += s1 * L0 * fade;
            wsum += L0 * fade;
          }
          fadedVar *= uWaveAmp * uWaveAmp;
          glUV = vec2(raw[4], raw[5]) * 0.15915494;
          glFw = max(sqrt(max(fwidth(glUV.x), fwidth(glUV.y)) * min(fwidth(glUV.x), fwidth(glUV.y))), 1e-5);
          wTilt = (wTilt - R * dot(wTilt, R)) * uWaveAmp;
          N = normalize(N - wTilt); // no per facet noise: finest chunks would show it as a zigzag disc
          crest = smoothstep(0.15, 0.85, hsum / max(wsum, 1.0));
          // Lapping shore bands travelling toward the coast, broken up by the swell.
          float W = max(uFoamWidth, 1e-3);
          float edge = 1.0 - smoothstep(0.0, W, shore);
          float ph2 = shore / W * 2.4 + uTime * 0.42;
          float fw = fwidth(ph2);
          float wave = 0.5 + 0.5 * sin(6.2831853 * ph2);
          float bands = smoothstep(0.6, 0.92, wave);
          bands = mix(bands, 0.3, smoothstep(0.3, 0.8, fw));
          float breakup = smoothstep(-0.35, 0.5, hsum / max(wsum, 1.0) + (vWater.y - 0.5) * 0.9);
          float line = 1.0 - smoothstep(0.0, W * 0.22, shore);
          foam = clamp((bands * 0.85 * breakup + line * (0.55 + 0.4 * breakup)) * edge, 0.0, 1.0) * uFoam;
        } else if (isWater > 0.5) {
          vec3 pert = vec3(sin(uTime * 0.9 + vWater.y * 40.0), sin(uTime * 1.3 + vWater.y * 91.0), sin(uTime * 0.7 + vWater.y * 17.0));
          N = normalize(N + pert * 0.045);
        }
        float sunR = dot(R, L);
        float term = smoothstep(-0.10, 0.22, sunR);
        float lam = clamp(dot(N, L), 0.0, 1.0);
        float diffuse = lam * term;
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.45, sunR));
        float skyTerm = 0.35 + 0.65 * clamp(dot(N, R), 0.0, 1.0);
        vec3 amb = (vec3(0.025) + uSkyAmbient * skyTerm * (0.25 + 0.75 * term)) * mix(vec3(1.0), uStarColor, 0.6);
        // Starlight and airglow floor: cool, faint, from the whole sky so silhouettes always read.
        amb += vec3(0.3, 0.42, 0.9) * uNightAmb * (1.0 - term) * (0.45 + 0.55 * clamp(dot(N, R), 0.0, 1.0));
        // Eclipses: other bodies shadow the sun here (camera relative world position).
        vec3 eclL = eclipseLight(vViewPos * mat3(viewMatrix), uEclSelf);
        // No sun means no skylight either: the shadow darkens the ambient too.
        amb *= 0.25 + 0.75 * dot(eclL, vec3(0.2126, 0.7152, 0.0722));
        vec3 lightIn = sunCol * uStarColor * eclL * uSunIntensity * diffuse + amb + nightMoon(N, R, term);
        vec3 albedo = mix(vColor, uFoamColor, foam * 0.92);
        vec3 col = nightPurkinje(albedo * lightIn, lightIn);
        if (isWater > 0.5) {
          vec3 H = normalize(L + V);
          float nvS = clamp(dot(N, V), 0.0, 1.0);
          float nvR = clamp(dot(R, V), 0.0, 1.0);
          float eps = smoothstep(150.0, 3000.0, dist);
          // Smooth sphere normal far away: facet noise at grazing angles would shimmer the reflection.
          float nvF = mix(nvS, nvR, eps);
          float fres = 0.02 + 0.98 * pow(1.0 - nvF, 5.0);
          float dayAmt = smoothstep(-0.28, 0.12, sunR);
          float dusk = 1.0 - smoothstep(0.08, 0.55, sunR);
          // Sky seen in the mirror, from the atmosphere colours: zenith to horizon, reddened toward a low sun.
          vec3 Rf = reflect(-V, N);
          float elev = clamp(dot(Rf, R), 0.0, 1.0);
          vec3 T = exp(-uSkyDepth * 0.9 / max(sunR + 0.07, 0.03));
          vec3 sunTint = T / max(max(T.r, T.g), max(T.b, 1e-3));
          vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(elev, 0.55));
          float toSunR = max(dot(Rf, L), 0.0);
          float glow = pow(toSunR, 5.0) * 0.9 + pow(toSunR, 1.6) * 0.3 * dusk;
          float hz = pow(1.0 - elev, 3.0);
          sky = sky * mix(1.0, 0.55, dusk * (1.0 - toSunR)) + sunTint * (glow * (0.4 + 0.8 * hz) + 0.35 * dusk * hz * (0.3 + 0.7 * toSunR)) * (uSkyHorizon * 1.6 + 0.12);
          sky *= dayAmt * uWaterB.z;
          // Night sky: faint cool light only.
          sky += vec3(0.28, 0.4, 0.8) * uNightAmb * 0.45 * (1.0 - dayAmt) * (uSkyZenith.b > 0.0 ? 1.0 : 0.0) * (0.4 + 0.6 * hz);
          sky *= mix(vec3(1.0), uStarColor, 0.6) * (0.25 + 0.75 * dot(eclL, vec3(0.2126, 0.7152, 0.0722)));
          vec3 body = col;
          // Turquoise shallows: lighter, more saturated water where the sea floor is near.
          float shallowT = (1.0 - smoothstep(0.0, 9.0, shore)) * uWaterA.w * (1.0 - smoothstep(4000.0, 40000.0, dist));
          body = mix(body, uSssColor * lightIn * 0.75 + body * 0.35, shallowT * 0.55 * (1.0 - foam));
          // Light through the crests: turquoise glow, stronger in shallows and looking toward the sun.
          float shallow = 1.0 - smoothstep(0.0, 3.5, shore);
          float toSun = clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0);
          // Crest light is a close range effect: far away the chevrons of the fine swells alias into a hard edged zigzag disc.
          float sssNear = 1.0 - smoothstep(120.0, 700.0, dist);
          float sssK = mix(0.32, crest, sssNear) * (0.35 + 0.65 * toSun) * (0.7 + 0.8 * shallow) * term * (1.0 - foam);
          body += uSssColor * sunCol * uStarColor * eclL * uSunIntensity * sssK * 0.2;
          float refl = fres * uWaterA.x * (1.0 - foam * 0.85);
          col = mix(body, sky, clamp(refl, 0.0, 1.0));
          // Sun glint: a smooth lobe whose width grows with the waves that are too fine to see and with distance,
          // modulated by twinkling cells so it sparkles instead of banding.
          float rough = uWaterB.x;
          float sig2 = rough * rough + fadedVar + 0.03 * smoothstep(3000.0, 4.0e5, dist);
          float sig = sqrt(sig2);
          float sa = sig * uWaterB.y;
          float sparkleMix = uWaterA.z * (1.0 - smoothstep(25000.0, 90000.0, dist));
          float tw = mix(1.0, glitter(glUV, glFw, uTime), sparkleMix);
          float vh = clamp(dot(V, H), 0.0, 1.0);
          float Fg = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
          float D = glintLobe(N, H, L, sa, sig);
          float spec = D * Fg * tw / (4.0 * (0.12 + 0.88 * max(nvF, 0.0))) * term * (1.0 - foam) * uWaterA.y;
          col += sunCol * uStarColor * eclL * spec * uSunIntensity * 2.4;
          // Moonlit sea: a dim glint path under a moon above the horizon.
          if (uMoonLit > 0.0) {
            vec3 Hm = normalize(uMoonDir + V);
            float up = smoothstep(0.0, 0.12, dot(uMoonDir, R));
            float Dm = glintLobe(N, Hm, uMoonDir, sa * 1.2, sig * 1.2);
            float vm = clamp(dot(V, Hm), 0.0, 1.0);
            float Fm = 0.02 + 0.98 * pow(1.0 - vm, 5.0);
            float sm = Dm * Fm * mix(1.0, glitter(glUV, glFw, uTime), sparkleMix) / (4.0 * (0.12 + 0.88 * nvF));
            col += vec3(0.55, 0.68, 1.0) * sm * up * uMoonLit * (1.0 - term) * 0.05 * uWaterB.w * (1.0 - foam);
          }
        }
        // Self light (settlements, lava): fades in through twilight by the local sun elevation.
        // The atmosphere pass multiplies scene colour by transmittance and adds no night inscatter.
        float night = 1.0 - smoothstep(-0.14, 0.04, sunR);
        vec3 emitC = vEmit.rgb;
        // Settlement lamps fall off across their triangle; sharpen so they read as small points.
        if (dot(uLampColor, uLampColor) > 0.0) emitC *= smoothstep(0.25, 2.2, max(max(emitC.r, emitC.g), emitC.b));
        col += emitC * (vEmit.a + (1.0 - vEmit.a) * night) * uGlow;
        if (vDir.w > 0.0 && dot(vDir.xyz, vDir.xyz) > 0.25 && isWater < 0.5 && dot(uLampColor, uLampColor) > 0.0) {
          // Coarse chunks: the settlement map straight from the body fixed direction.
          vec3 bd = normalize(vDir.xyz);
          vec2 luv = vec2(atan(-bd.z, bd.x) * 0.15915494 + 0.5, 0.5 - asin(clamp(bd.y, -1.0, 1.0)) * 0.31830989);
          float ld = smoothstep(0.08, 0.85, texture2D(uLights, luv).r);
          col += uLampColor * ld * vDir.w * night * uGlow;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
