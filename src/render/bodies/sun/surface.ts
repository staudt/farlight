import { Color, ShaderMaterial, Vector3 } from 'three';

/** Shared 3D value noise for the star shaders. Prefix SUN_ to stay clear of other chunks. */
const NOISE3 = /* glsl */ `
float sunH(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float sunN(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sunH(i), sunH(i + vec3(1, 0, 0)), f.x), mix(sunH(i + vec3(0, 1, 0)), sunH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(sunH(i + vec3(0, 0, 1)), sunH(i + vec3(1, 0, 1)), f.x), mix(sunH(i + vec3(0, 1, 1)), sunH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

/**
 * The star disc. A flat bright disc by default (what the sky shows); with `uDetail` it gains limb
 * darkening with a colour shift, churning granulation, sunspots (umbra and penumbra) and faculae
 * near the limb. All colours come from `uTint` (the star colour) and the per star uniforms.
 */
export function createSurfaceMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTint: { value: new Color(1, 1, 1) },
      uGain: { value: 6 },
      uDetail: { value: 0 },
      uTime: { value: 0 },
      uOct: { value: new Vector3(1, 1, 1) },
      uLimbU: { value: new Vector3(0.5, 0.66, 0.86) },
      uGranule: { value: 24 },
      uGranuleAmt: { value: 0.3 },
      uSpotThr: { value: 0.65 },
      uSpotAmt: { value: 1 },
      uFacula: { value: 0.5 },
      uSeed: { value: new Vector3() },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vLocal;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      void main() {
        vLocal = normalize(position);
        vNormalV = normalize(normalMatrix * position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uTint, uOct, uLimbU, uSeed;
      uniform float uGain, uDetail, uTime, uGranule, uGranuleAmt, uSpotThr, uSpotAmt, uFacula;
      varying vec3 vLocal;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      ${NOISE3}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 plain = uTint * uGain;
        if (uDetail <= 0.001) { gl_FragColor = vec4(plain, 1.0); return; }
        vec3 n = normalize(vNormalV);
        float mu = clamp(dot(n, normalize(vViewDir)), 0.0, 1.0);
        vec3 p = normalize(vLocal);
        float t = uTime;

        // Granulation: bright cells with dark lanes that slowly churn (two drifting layers blended).
        vec3 drift = vec3(0.021, -0.013, 0.017) * t;
        float g = 0.0;
        float wsum = 0.0;
        float f = uGranule;
        for (int o = 0; o < 3; o++) {
          float w = o == 0 ? uOct.x : (o == 1 ? uOct.y : uOct.z);
          if (w > 0.0) {
            vec3 q = p * f + float(o) * 7.31;
            float a = sunN(q + drift * (1.0 + float(o)));
            float b = sunN(q * 1.07 + 13.7 - drift * 0.8);
            float c = mix(a, b, 0.5 + 0.5 * sin(t * 0.07 + float(o) * 2.0));
            float amp = w / (1.0 + float(o) * 0.35);
            g += (c - 0.5) * amp;
            wsum += amp;
          }
          f *= 2.1;
        }
        g = wsum > 0.0 ? g / wsum : 0.0;
        // Sharper cell edges: push the value toward bright cells and dark lanes.
        float cell = smoothstep(-0.3, 0.3, g) * 2.0 - 1.0;
        float lum = 1.0 + uGranuleAmt * cell;

        // Sunspots: low frequency field, confined to the active latitude bands.
        float field = sunN(p * 4.2 + uSeed) * 0.6 + sunN(p * 9.0 + uSeed.zxy) * 0.4;
        float lat = abs(p.y);
        float band = smoothstep(0.06, 0.2, lat) * (1.0 - smoothstep(0.42, 0.62, lat));
        float d = (field - uSpotThr) * band;
        float pen = smoothstep(0.0, 0.02, d);
        float umb = smoothstep(0.05, 0.085, d);
        // The penumbra is streaky (granule noise stretched along the radial direction).
        float streak = 0.75 + 0.5 * sunN(vec3(atan(p.z, p.x) * 9.0, p.y * 60.0, 3.0));
        float spot = mix(1.0, 0.62 * streak, pen);
        spot = mix(spot, 0.1, umb);
        lum *= mix(1.0, spot, uSpotAmt);

        // Faculae: bright patches that show near the limb and around active regions.
        float fl = sunN(p * 7.0 + uSeed.yzx) * 0.6 + sunN(p * 15.0 + 4.0) * 0.4;
        float limbness = pow(1.0 - mu, 1.6);
        lum += uFacula * smoothstep(0.58, 0.78, fl) * limbness * 1.4 * (1.0 - umb);

        // Limb darkening per channel: the rim cools toward orange (or deep red on a red star).
        vec3 limb = 1.0 - uLimbU * (1.0 - mu);
        vec3 col = pow(uTint, vec3(2.6)) * uGain * limb * lum;
        // Hot cell highlights lean white, dark lanes lean to the star colour.
        col += uTint * uGain * 0.1 * mu * mu;
        gl_FragColor = vec4(max(mix(plain, col, uDetail), vec3(0.0)), 1.0);
      }`,
  });
}
