import { Color, CylinderGeometry, DoubleSide, Mesh, RingGeometry, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { Camera, WebGLRenderer } from 'three';
import type { RingDef } from '../../data/types';
import { config } from '../../core/config';
import { quality } from '../quality';
import { starLight } from '../starLight';
import { ECLIPSE_GLSL, eclipse } from '../eclipse';
import { RING_GLSL } from './rings/glsl';
import { RingDebris } from './rings/debris';
import { MAX_RING_GAPS, packGaps, ringGaps, ringSpokes } from './rings/profile';

export { RING_GLSL };

export interface RingUniforms {
  uRingIn: { value: number };
  uRingOut: { value: number };
  uRingBands: { value: number };
  uRingSeed: { value: number };
  uRingOpacity: { value: number };
  uRingDetail: { value: number };
  uRingOct: { value: number };
  uRingSpokes: { value: number };
  uRingGaps: { value: Vector3[] };
}

export function makeRingUniforms(def: RingDef | undefined, seed: number): RingUniforms {
  const packed = packGaps(def ? ringGaps(def, seed) : []);
  const gaps: Vector3[] = [];
  for (let i = 0; i < MAX_RING_GAPS; i++) gaps.push(new Vector3(packed[i * 3], packed[i * 3 + 1], packed[i * 3 + 2]));
  return {
    uRingIn: { value: def?.innerRadius ?? 1 },
    uRingOut: { value: def?.outerRadius ?? 1 },
    uRingBands: { value: def?.bands ?? 20 },
    uRingSeed: { value: (seed % 97) + 0.37 },
    uRingOpacity: { value: def?.opacity ?? 0 },
    uRingDetail: { value: 1 },
    uRingOct: { value: 9 },
    uRingSpokes: { value: ringSpokes(def) },
    uRingGaps: { value: gaps },
  };
}

const VERT = /* glsl */ `
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
  }`;

/**
 * Edge on, a flat disc has no area. A vertical band along the outer rim, a constant couple of pixels
 * tall at any distance (so it needs no real thickness), carries the thin bright line. It fades out
 * as the camera rises above the plane and the disc takes over.
 */
const WALL_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uEdgeAng, uWorldScale;
  varying vec3 vLocal;
  varying vec3 vViewPos;
  void main() {
    vec3 pos = position;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    pos.y = sign(position.y) * uEdgeAng * length(mv.xyz) / uWorldScale;
    vLocal = pos;
    mv = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const WALL_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${RING_GLSL}
  uniform vec3 uColor, uSunLocal, uCamLocal, uSunView, uStarColor;
  uniform float uEclSelf, uSlab;
  ${ECLIPSE_GLSL}
  varying vec3 vLocal;
  varying vec3 vViewPos;
  void main() {
    #include <logdepthbuf_fragment>
    if (uSlab < 0.01) discard;
    vec3 p = vec3(vLocal.x, 0.0, vLocal.z);
    vec3 viewDir = normalize(vViewPos);
    float muS = max(abs(uSunLocal.y), 0.05);
    float b = dot(p, uSunLocal);
    float dist2 = dot(p, p) - b * b;
    float shadow = b < 0.0 ? 1.0 - smoothstep(0.93, 1.03, sqrt(max(dist2, 0.0))) : 0.0;
    float g = dot(viewDir, uSunView);
    // The sheet is edge on: a lit particle layer seen along its plane, brightest toward the sun.
    vec3 c = uColor * 1.6 * (0.45 + 0.55 * muS) * (1.0 + 3.0 * pow(max(g, 0.0), 4.0));
    c *= (1.0 - 0.97 * shadow) * uStarColor * eclipseLight(vViewPos * mat3(viewMatrix), uEclSelf);
    gl_FragColor = vec4(c, 0.92 * uSlab);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${RING_GLSL}
  uniform vec3 uColor, uSunLocal, uCamLocal, uSunView, uStarColor;
  uniform float uEclSelf, uSlab, uForward, uOpp, uUnlit, uSpokeGain, uFadeProx, uFadeNear, uFadeFar, uFadeDepth;
  ${ECLIPSE_GLSL}
  varying vec3 vLocal;
  varying vec3 vViewPos;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 p = vec3(vLocal.x, 0.0, vLocal.z);
    float r = length(p.xz);
    float u = (r - uRingIn) / (uRingOut - uRingIn);
    float fw = max(fwidth(u), 1e-7);
    float dens = ringDensityLod(r, fw);
    if (dens < 0.004) discard;
    float tint = 0.86 + 0.28 * rgNoise(u * uRingBands * 0.7 + 3.0);
    vec3 base = uColor * tint * mix(vec3(1.0, 0.94, 0.86), vec3(0.94, 0.98, 1.0), rgNoise(u * 9.0));

    // Planet shadow: ray from this point toward the sun against the unit sphere.
    float b = dot(p, uSunLocal);
    float dist2 = dot(p, p) - b * b;
    float shadow = b < 0.0 ? 1.0 - smoothstep(0.93, 1.03, sqrt(max(dist2, 0.0))) : 0.0;

    vec3 viewDir = normalize(vViewPos);
    vec3 dirL = normalize(p - uCamLocal);
    float muV = max(abs(dirL.y), 0.03);
    float muS = max(abs(uSunLocal.y), 0.05);
    bool litSide = uSunLocal.y * uCamLocal.y >= 0.0;
    float g = dot(viewDir, uSunView);
    float fwd = pow(max(g, 0.0), 6.0);

    // Optical depth along the normal from the old opacity, longer along a slanted path.
    float a0 = clamp(dens * uRingOpacity, 0.0, 0.995);
    float tau = -log(1.0 - a0);
    float alpha = 1.0 - exp(-tau / muV);
    vec3 L; // radiance, premultiplied by coverage
    if (litSide) {
      float back = max(-g, 0.0);
      float surge = 1.0 + uOpp * (1.2 * pow(back, 40.0) + 0.4 * pow(back, 6.0));
      vec3 c = base * 2.1 * (0.35 + 0.65 * muS) * surge * (0.4 + 0.75 * a0);
      // Spokes: darker in back scatter, brighter in forward scatter.
      float sp = ringSpoke(u, atan(p.z, p.x)) * uRingSpokes * uSpokeGain;
      c *= 1.0 - 0.45 * sp * mix(1.0, -0.8, fwd);
      L = c * alpha;
    } else {
      // Camera under the unlit face: only light transmitted through the ring reaches us. Thin
      // regions glow (single scattering), dense ones are dark, and the glow peaks looking at the sun.
      float trans = exp(-tau / muS);
      L = base * pow(alpha, 0.45) * (0.05 + 0.8 * trans) * uUnlit * (1.0 + 12.0 * fwd * uForward);
    }
    // Moons shadow the rings (camera relative world position of this ring point).
    L *= (1.0 - 0.97 * shadow) * uStarColor * eclipseLight(vViewPos * mat3(viewMatrix), uEclSelf);
    // Near the ring plane the rocks take over: the flat disc fades out around the camera.
    float fade = 1.0 - uFadeProx * uFadeDepth * (1.0 - smoothstep(uFadeNear, uFadeFar, length(vViewPos)));
    float aOut = clamp(alpha * fade, 0.0, 1.0);
    L *= fade;
    gl_FragColor = vec4(min(L / max(alpha, 1e-3), vec3(6.0)), aOut);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const _sz = new Vector2();

/** Annulus in the body-fixed X/Z plane, unit planet radius. A child of the body group. */
export class RingMesh {
  readonly mesh: Mesh;
  /** Sun direction in body-fixed axes. */
  readonly sunLocal = { value: new Vector3(1, 0, 0) };
  /** Camera position in body-fixed axes (planet radii). */
  readonly camLocal = { value: new Vector3(0, 0, 1) };
  /** Sun direction in view space. */
  readonly sunView = { value: new Vector3(1, 0, 0) };
  /** Body index of the planet the ring belongs to (its own shadow is handled above). */
  readonly eclSelf = { value: -1 };
  private readonly materials: ShaderMaterial[] = [];
  private readonly under: Mesh;
  private readonly depthMaterial: ShaderMaterial;
  private readonly debris: RingDebris;
  private readonly dyn = {
    uSlab: { value: 0 },
    uEdgeAng: { value: 0 },
    uWorldScale: { value: 1 },
    uForward: { value: 1 },
    uOpp: { value: 1 },
    uUnlit: { value: 1 },
    uSpokeGain: { value: 1 },
    uFadeProx: { value: 0 },
    uFadeNear: { value: 150 },
    uFadeFar: { value: 1800 },
    uFadeDepth: { value: 0.7 },
  };

  private readonly sharedRef: RingUniforms;

  constructor(def: RingDef, shared: RingUniforms) {
    this.sharedRef = shared;
    const make = (wall: boolean): ShaderMaterial => {
      const m = new ShaderMaterial({
        uniforms: {
          ...shared,
          ...this.dyn,
          uColor: { value: new Color(def.color[0], def.color[1], def.color[2]) },
          uSunLocal: this.sunLocal,
          uCamLocal: this.camLocal,
          uSunView: this.sunView,
          uStarColor: starLight.uniform,
          ...eclipse.uniforms,
          uEclSelf: this.eclSelf,
        },
        vertexShader: wall ? WALL_VERT : VERT,
        fragmentShader: wall ? WALL_FRAG : FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      this.materials.push(m);
      return m;
    };
    const material = make(false);
    const wallMaterial = make(true);
    // RingGeometry is built in XY; rotate it into X/Z (Y is the pole).
    const geo = new RingGeometry(def.innerRadius, def.outerRadius, 240, 24);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rings';
    this.mesh.renderOrder = 2;
    this.under = new Mesh(new CylinderGeometry(def.outerRadius, def.outerRadius, 2, 256, 1, true), wallMaterial);
    this.under.frustumCulled = false;
    this.under.name = 'rings-edge';
    this.under.renderOrder = 2;
    this.mesh.add(this.under);
    this.mesh.onBeforeRender = (renderer, _scene, camera) => this.beforeRender(renderer, camera);

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
          if (ringDensityLod(length(vLocal.xz), 0.004) * uRingOpacity < 0.35) discard;
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

    this.debris = new RingDebris(
      {
        uniforms: shared as never,
        color: new Color(def.color[0], def.color[1], def.color[2]),
        sunLocal: this.sunLocal,
        camLocal: this.camLocal,
        sunView: this.sunView,
        eclSelf: this.eclSelf,
      },
      this.mesh,
    );
  }

  /** Per frame, from the ring disc's own draw: pushes the live tuning and the camera dependent bits. */
  private beforeRender(renderer: WebGLRenderer, camera: Camera): void {
    const rc = config.rings;
    const sh = this.sharedRef;
    sh.uRingDetail.value = rc.detail;
    sh.uRingOct.value = Math.min(rc.octaves, quality.settings.ringOctaves);
    const S = this.mesh.matrixWorld.getMaxScaleOnAxis();
    const d = this.dyn;
    d.uWorldScale.value = S;
    d.uForward.value = rc.forward;
    d.uOpp.value = rc.opposition;
    d.uUnlit.value = rc.unlit;
    d.uSpokeGain.value = rc.spokes;
    const fov = ((camera as { fov?: number }).fov ?? 60) * (Math.PI / 180);
    renderer.getDrawingBufferSize(_sz);
    d.uEdgeAng.value = (rc.edgePx * 2 * Math.tan(fov / 2)) / Math.max(1, _sz.y);
    const cam = this.camLocal.value;
    const height = Math.abs(cam.y) * S;
    const elev = Math.abs(cam.y) / Math.max(cam.length(), 1e-6);
    const slab = rc.edgePx > 0 ? 1 - smooth(0.004, 0.02, elev) : 0;
    d.uSlab.value = slab;
    this.under.visible = slab > 0.01;
    const prox = rc.debris && quality.settings.ringDebris > 0 ? 1 - smooth(rc.fadeHeight * 0.5, rc.fadeHeight, height / Math.max(rc.thickness, 1)) : 0;
    d.uFadeProx.value = prox;
    d.uFadeDepth.value = rc.fadeDepth;
    d.uFadeNear.value = rc.fadeNear;
    d.uFadeFar.value = Math.max(rc.fadeFar, rc.fadeNear + 1);
  }

  dispose(): void {
    this.debris.dispose();
    this.mesh.geometry.dispose();
    this.under.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.depthMaterial.dispose();
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
