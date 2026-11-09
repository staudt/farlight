import { Color, DoubleSide, Mesh, RingGeometry, ShaderMaterial, Vector3 } from 'three';
import type { RingDef } from '../../data/types';
import { starLight } from '../starLight';

/**
 * Shared GLSL: radial ring density at a body-fixed radius `r` (planet radii). Used by the
 * ring shader itself and by the planet shader (ring shadow on the cloud tops), so the two
 * always agree. Declares its own uniforms; both materials must provide them.
 */
export const RING_GLSL = /* glsl */ `
uniform float uRingIn, uRingOut, uRingBands, uRingSeed, uRingOpacity;
float rgHash(float n) { return fract(sin(n * 127.1 + uRingSeed * 311.7) * 43758.5453); }
float rgNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(rgHash(i), rgHash(i + 1.0), f);
}
/** 0..1 optical density across the annulus (before the opacity multiplier). */
float ringDensity(float r) {
  float u = (r - uRingIn) / (uRingOut - uRingIn);
  if (u < 0.0 || u > 1.0) return 0.0;
  float n = rgNoise(u * uRingBands) * 0.55 + rgNoise(u * uRingBands * 2.7 + 17.0) * 0.3 + rgNoise(u * uRingBands * 9.0 + 5.0) * 0.15;
  float d = smoothstep(0.12, 0.85, n) * 0.85 + 0.15;
  // Faint inner ring, bright dense middle, a wide Cassini-like gap, a thin outer gap.
  float zone = mix(0.32, 1.0, smoothstep(0.24, 0.30, u));
  zone *= mix(1.0, 0.82, smoothstep(0.30, 0.66, u));
  float gap = 1.0 - 0.94 * smoothstep(0.665, 0.685, u) * (1.0 - smoothstep(0.735, 0.75, u));
  gap *= 1.0 - 0.8 * (1.0 - smoothstep(0.0, 0.012, abs(u - 0.915)));
  float edge = smoothstep(0.0, 0.03, u) * smoothstep(1.0, 0.965, u);
  return clamp(d * zone * gap * edge, 0.0, 1.0);
}
/** Fraction of sunlight blocked by the ring on its way to body-fixed point p (unit planet radius). */
float ringShadowAt(vec3 p, vec3 sunL) {
  if (abs(sunL.y) < 1e-3) return 0.0;
  float t = -p.y / sunL.y;
  if (t <= 0.0) return 0.0;
  vec3 h = p + sunL * t;
  return ringDensity(length(h.xz)) * uRingOpacity;
}
`;

export interface RingUniforms {
  uRingIn: { value: number };
  uRingOut: { value: number };
  uRingBands: { value: number };
  uRingSeed: { value: number };
  uRingOpacity: { value: number };
}

export function makeRingUniforms(def: RingDef | undefined, seed: number): RingUniforms {
  return {
    uRingIn: { value: def?.innerRadius ?? 1 },
    uRingOut: { value: def?.outerRadius ?? 1 },
    uRingBands: { value: def?.bands ?? 20 },
    uRingSeed: { value: (seed % 97) + 0.37 },
    uRingOpacity: { value: def?.opacity ?? 0 },
  };
}

/** Annulus in the body-fixed X/Z plane, unit planet radius. A child of the body group. */
export class RingMesh {
  readonly mesh: Mesh;
  /** Sun direction in body-fixed axes. */
  readonly sunLocal = { value: new Vector3(1, 0, 0) };
  /** Camera position in body-fixed axes (planet radii). */
  readonly camLocal = { value: new Vector3(0, 0, 1) };
  /** Sun direction in view space. */
  readonly sunView = { value: new Vector3(1, 0, 0) };
  private readonly material: ShaderMaterial;
  private readonly depthMaterial: ShaderMaterial;

  constructor(def: RingDef, shared: RingUniforms) {
    this.material = new ShaderMaterial({
      uniforms: {
        ...shared,
        uColor: { value: new Color(def.color[0], def.color[1], def.color[2]) },
        uSunLocal: this.sunLocal,
        uCamLocal: this.camLocal,
        uSunView: this.sunView,
        uStarColor: starLight.uniform,
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vLocal;
        varying vec3 vViewPos;
        void main() {
          vLocal = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = mv.xyz;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${RING_GLSL}
        uniform vec3 uColor, uSunLocal, uCamLocal, uSunView, uStarColor;
        varying vec3 vLocal;
        varying vec3 vViewPos;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 p = vec3(vLocal.x, 0.0, vLocal.z);
          float r = length(p.xz);
          float dens = ringDensity(r);
          if (dens < 0.004) discard;
          float u = (r - uRingIn) / (uRingOut - uRingIn);
          float tint = 0.86 + 0.28 * rgNoise(u * uRingBands * 0.7 + 3.0);
          vec3 base = uColor * tint * mix(vec3(1.0, 0.94, 0.86), vec3(0.94, 0.98, 1.0), rgNoise(u * 9.0));

          // Planet shadow: ray from this point toward the sun against the unit sphere.
          float b = dot(p, uSunLocal);
          float dist2 = dot(p, p) - b * b;
          float shadow = b < 0.0 ? 1.0 - smoothstep(0.93, 1.03, sqrt(max(dist2, 0.0))) : 0.0;

          bool litSide = uSunLocal.y * uCamLocal.y >= 0.0;
          float inc = max(abs(uSunLocal.y), 0.08);
          vec3 viewDir = normalize(vViewPos);
          float fwd = pow(max(dot(viewDir, uSunView), 0.0), 6.0);
          float alpha = dens * uRingOpacity;
          vec3 col;
          if (litSide) {
            float opp = pow(max(-dot(viewDir, uSunView), 0.0), 3.0);
            col = base * (2.4 * (0.35 + 0.65 * inc) + 0.8 * opp);
          } else {
            // Camera under the unlit face: only light scattered through the ring reaches us.
            col = base * (0.2 + (1.0 - alpha) * 1.2 * dens) * (1.0 + 8.0 * fwd);
            alpha *= 0.9;
          }
          col *= (1.0 - 0.97 * shadow) * uStarColor;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    // RingGeometry is built in XY; rotate it into X/Z (Y is the pole).
    const geo = new RingGeometry(def.innerRadius, def.outerRadius, 192, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rings';
    this.mesh.renderOrder = 2;

    // Depth only twin: the blended ring writes no depth, so the volumetric pass would treat ring
    // pixels as background. Where the ring is opaque enough, write its depth (after the colour
    // pass, so the blend itself is not affected) and the atmosphere then stops at the ring.
    this.depthMaterial = new ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vLocal;
        void main() {
          vLocal = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${RING_GLSL}
        varying vec3 vLocal;
        void main() {
          if (ringDensity(length(vLocal.xz)) * uRingOpacity < 0.35) discard;
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(0.0);
        }`,
      transparent: true,
      colorWrite: false,
      depthWrite: true,
      side: DoubleSide,
    });
    const depthMesh = new Mesh(geo, this.depthMaterial);
    depthMesh.frustumCulled = false;
    depthMesh.name = 'rings-depth';
    depthMesh.renderOrder = 3;
    this.mesh.add(depthMesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
