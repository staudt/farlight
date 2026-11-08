import { Color, ShaderMaterial, Vector3 } from 'three';

/** Flat shaded, vertex colored terrain material with sun lighting and glinting water. */
export function createTerrainMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: 2, // DoubleSide: skirts and any winding mismatch never show holes
    uniforms: {
      uSunDirView: { value: new Vector3(1, 0, 0) },
      uBodyCenterView: { value: new Vector3(0, 0, -1e6) },
      uSkyAmbient: { value: new Color(0.55, 0.7, 1.0).multiplyScalar(0.08) },
      uTime: { value: 0 },
      uSunIntensity: { value: 1.25 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aColor;
      attribute vec2 aWater;
      varying vec3 vColor;
      varying vec2 vWater;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vColor = aColor;
        vWater = aWater;
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
      varying vec3 vColor;
      varying vec2 vWater;
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
        if (isWater > 0.5) {
          float t = uTime;
          float h = vWater.y;
          vec3 pert = vec3(sin(t * 0.9 + h * 40.0), sin(t * 1.3 + h * 91.0), sin(t * 0.7 + h * 17.0));
          N = normalize(N + pert * 0.045);
        }
        float sunR = dot(R, L);
        float term = smoothstep(-0.10, 0.22, sunR);
        float lam = clamp(dot(N, L), 0.0, 1.0);
        float diffuse = lam * term;
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.45, sunR));
        float skyTerm = 0.35 + 0.65 * clamp(dot(N, R), 0.0, 1.0);
        vec3 amb = vec3(0.025) + uSkyAmbient * skyTerm * (0.25 + 0.75 * term);
        vec3 col = vColor * (sunCol * uSunIntensity * diffuse + amb);
        if (isWater > 0.5) {
          vec3 H = normalize(L + V);
          float nh = max(dot(N, H), 0.0);
          float sparkle = 0.55 + 0.45 * sin(uTime * 2.3 + vWater.y * 300.0);
          float spec = (pow(nh, 140.0) * 1.6 * sparkle + pow(nh, 14.0) * 0.08) * term;
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
          col += sunCol * spec * uSunIntensity * 0.6;
          col += vec3(0.30, 0.45, 0.70) * fres * 0.35 * (0.15 + 0.85 * term);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
