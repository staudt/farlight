import { Color, ShaderMaterial, Vector3 } from 'three';
import { starLight } from '../starLight';

/**
 * Flat shaded landmark material. `fx` builds the transparent variant (waterfalls, steam, mist).
 * aFx selects the surface: 0 stone, 1 falling water, 2 steam, 3 water, 4 glowing liquid.
 */
export function createLandmarkMaterial(fx: boolean): ShaderMaterial {
  return new ShaderMaterial({
    side: 2,
    transparent: fx,
    depthWrite: !fx,
    defines: fx ? { FX: 1 } : {},
    uniforms: {
      uSunDirView: { value: new Vector3(1, 0, 0) },
      uBodyCenterView: { value: new Vector3(0, 0, -1e6) },
      uSkyAmbient: { value: new Color(0.55, 0.7, 1.0).multiplyScalar(0.08) },
      uTime: { value: 0 },
      uSunIntensity: { value: 1.25 },
      uStarColor: starLight.uniform,
      uGlow: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aColor;
      attribute float aEmit;
      attribute float aFx;
      attribute vec2 aUv;
      uniform float uTime;
      varying vec3 vColor;
      varying float vEmit;
      varying float vFx;
      varying vec2 vUv;
      varying vec3 vViewPos;
      void main() {
        vec3 p = position;
        #ifdef FX
        if (aFx > 1.5 && aFx < 2.5) {
          // Steam drifts and breathes as it rises.
          float ph = aUv.x * 6.2831;
          p.x += sin(uTime * 0.6 + ph) * aUv.y * 9.0;
          p.z += cos(uTime * 0.5 + ph * 1.3) * aUv.y * 9.0;
        }
        #endif
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vViewPos = mv.xyz;
        vColor = aColor;
        vEmit = aEmit;
        vFx = aFx;
        vUv = aUv;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDirView;
      uniform vec3 uBodyCenterView;
      uniform vec3 uSkyAmbient;
      uniform float uSunIntensity;
      uniform vec3 uStarColor;
      uniform float uTime;
      uniform float uGlow;
      varying vec3 vColor;
      varying float vEmit;
      varying float vFx;
      varying vec2 vUv;
      varying vec3 vViewPos;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        vec3 V = normalize(-vViewPos);
        vec3 L = normalize(uSunDirView);
        vec3 R = normalize(vViewPos - uBodyCenterView);
        float sunR = dot(R, L);
        float term = smoothstep(-0.10, 0.22, sunR);
        float night = 1.0 - smoothstep(-0.14, 0.04, sunR);
        bool water = vFx > 2.5 && vFx < 3.5;
        if (water) {
          // The surface is flat: use the radial up and ripple it.
          N = normalize(R + 0.012 * vec3(sin(uTime * 0.9 + vViewPos.x * 0.01), sin(uTime * 1.3 + vViewPos.z * 0.013), sin(uTime * 0.7 + vViewPos.y * 0.008)));
        }
        float lam = clamp(dot(N, L), 0.0, 1.0);
        float diffuse = lam * term;
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.45, sunR));
        float skyTerm = 0.35 + 0.65 * clamp(dot(N, R), 0.0, 1.0);
        vec3 amb = (vec3(0.04) + uSkyAmbient * skyTerm * (0.25 + 0.75 * term)) * mix(vec3(1.0), uStarColor, 0.6);
        vec3 lit = sunCol * uStarColor * uSunIntensity * diffuse + amb;
        vec3 col = vColor * lit;
        float alpha = 1.0;
        if (water) {
          vec3 H = normalize(L + V);
          float nh = max(dot(N, H), 0.0);
          float spark = 0.6 + 0.4 * sin(uTime * 2.1 + vViewPos.x * 0.03 + vViewPos.z * 0.02);
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
          col += sunCol * uStarColor * (pow(nh, 140.0) * 1.6 * spark + pow(nh, 14.0) * 0.08) * term * uSunIntensity * 0.6;
          col += vec3(0.30, 0.45, 0.70) * fres * 0.4 * (0.15 + 0.85 * term);
        }
        float day = 0.35 + 0.65 * term;
        #ifdef FX
        if (vFx > 0.5 && vFx < 1.5) {
          // Falling water: bright streaks of different speeds sliding down the ribbon.
          float colId = floor(vUv.x * 22.0);
          float hh = fract(sin(colId * 91.7) * 437.5);
          float n = fract(vUv.y * (2.0 + 3.0 * hh) - uTime * (0.7 + 1.1 * hh) + hh * 7.0);
          float streak = smoothstep(0.05, 0.45, n) * smoothstep(1.0, 0.6, n);
          float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
          alpha = mix(0.16, 0.78, streak) * edge * (0.55 + 0.45 * smoothstep(0.0, 0.12, vUv.y)) * (1.0 - 0.35 * smoothstep(0.7, 1.0, vUv.y));
          col = vColor * (0.32 + 0.5 * day) * vec3(0.82, 0.93, 1.0) + uStarColor * 0.05;
        } else if (vFx > 1.5 && vFx < 2.5) {
          float pulse = 0.75 + 0.25 * sin(uTime * 1.4 - vUv.y * 7.0 + vUv.x * 12.0);
          alpha = 0.2 * pulse * (1.0 - 0.8 * vUv.y);
          col = vColor * (0.45 + 0.75 * day) + uStarColor * 0.05;
        }
        #endif
        // Self light: crystals and seams glow, brighter at night.
        float glowAmt = vEmit * uGlow * (0.4 + 0.6 * night);
        if (vFx > 3.5) {
          // Glowing liquid: slow drifting cracks of brighter and darker crust.
          float flow = sin(vUv.x * 21.0 + sin(vUv.y * 17.0 + uTime * 0.35) * 2.2) * sin(vUv.y * 19.0 - sin(vUv.x * 13.0 - uTime * 0.28) * 2.0);
          float breathe = 0.78 + 0.3 * flow + 0.1 * sin(uTime * 1.1);
          glowAmt = vEmit * uGlow * max(0.35, breathe) * (0.75 + 0.25 * night);
          col *= 0.15;
        }
        col += vColor * glowAmt;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
