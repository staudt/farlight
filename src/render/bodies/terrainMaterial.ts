import { Color, ShaderMaterial, Texture, Vector3 } from 'three';
import { starLight } from '../starLight';
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
      uGlow: { value: 1 },
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
      uniform float uTime;
      uniform float uSunIntensity;
      uniform vec3 uStarColor;
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
      varying vec4 vDir;
      varying vec4 vEmit;
      varying vec3 vColor;
      varying vec3 vWater;
      varying vec3 vViewPos;
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
            hsum += s1 * L0 * fade;
            wsum += L0 * fade;
          }
          wTilt = (wTilt - R * dot(wTilt, R)) * uWaveAmp;
          N = normalize(N - wTilt * 1.0 + vec3(sin(uTime * 1.3 + vWater.y * 91.0), sin(uTime * 0.9 + vWater.y * 40.0), sin(uTime * 0.7 + vWater.y * 17.0)) * 0.012);
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
        vec3 lightIn = sunCol * uStarColor * uSunIntensity * diffuse + amb;
        vec3 albedo = mix(vColor, uFoamColor, foam * 0.92);
        vec3 col = albedo * lightIn;
        if (isWater > 0.5) {
          vec3 H = normalize(L + V);
          float nh = max(dot(N, H), 0.0);
          float sparkle = 0.55 + 0.45 * sin(uTime * 2.3 + vWater.y * 300.0 + crest * 5.0);
          float sparkleFar = 1.0 - 0.55 * smoothstep(3000.0, 60000.0, dist);
          // The glitter path: tight highlights where wave facets mirror the sun, a soft sheen around them.
          float spec = (pow(nh, 220.0) * 3.2 * sparkle * sparkleFar + pow(nh, 40.0) * 0.18 + pow(nh, 8.0) * 0.05) * term * (1.0 - foam);
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
          col += sunCol * uStarColor * spec * uSunIntensity * 0.6;
          col += vec3(0.30, 0.45, 0.70) * fres * 0.35 * (0.15 + 0.85 * term) * (1.0 - foam);
          // Light through the crests: turquoise glow, stronger in shallows and looking toward the sun.
          float shallow = 1.0 - smoothstep(0.0, 3.5, shore);
          float toSun = clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0);
          float sssK = crest * (0.35 + 0.65 * toSun) * (0.7 + 0.8 * shallow) * term * (1.0 - foam);
          col += uSssColor * sunCol * uStarColor * uSunIntensity * sssK * 0.2;
        }
        // Self light (settlements, lava): fades in through twilight by the local sun elevation.
        // The atmosphere pass multiplies scene colour by transmittance and adds no night inscatter.
        float night = 1.0 - smoothstep(-0.14, 0.04, sunR);
        col += vEmit.rgb * (vEmit.a + (1.0 - vEmit.a) * night) * uGlow;
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
