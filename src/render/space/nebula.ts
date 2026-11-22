import {
  AdditiveBlending,
  BackSide,
  Color,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { SkyDef } from '../../data/types';
import { skyFocusDir } from './spaceData';

const CUBE_SIZE = 768;
const RADIUS = 1e10;
/** Normal of the galactic band plane: the starfield tilts its band by 1.05 rad around X. */
const BAND_TILT = 1.05;

const BAKE_FRAG = /* glsl */ `
  uniform vec3 uC0, uC1, uC2, uBandN, uFocus;
  uniform float uIntensity, uBand, uScale, uSeed;
  varying vec3 vDir;
  float pow2(float x) { return x * x; }
  float h3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vn(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 6; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return s;
  }
  void main() {
    vec3 d = normalize(vDir);
    vec3 sd = vec3(uSeed, uSeed * 0.7, uSeed * 1.3);
    vec3 p = d * 1.7 * uScale + sd;
    vec3 q = vec3(fbm(p + 1.7), fbm(p + 4.2), fbm(p + 8.3));
    vec3 w = p + (q - 0.5) * 1.8;
    float c1 = fbm(w);
    float c2 = fbm(w * 1.9 + 11.0);
    float c3 = fbm(w * 3.1 + 23.0);
    // Where nebulae live: a few big regions of the sky.
    float region = smoothstep(0.46, 0.68, fbm(d * 0.95 * uScale + sd * 0.37 + 3.0));
    // One hero nebula in a seeded direction, so every sky has something worth turning toward.
    float hero = exp(-pow2(acos(clamp(dot(d, uFocus), -1.0, 1.0)) / 0.62));
    region = max(region, hero * smoothstep(0.25, 0.5, fbm(d * 2.2 + sd)));
    // Dust lanes eat the light.
    float lane = 1.0 - 0.85 * smoothstep(0.5, 0.72, fbm(w * 2.6 + 5.0));
    vec3 neb = uC0 * smoothstep(0.34, 0.85, c1) + uC1 * smoothstep(0.42, 0.9, c2) * 0.75 + uC2 * smoothstep(0.5, 0.95, c3) * 0.5;
    neb *= region * (0.4 + 0.6 * smoothstep(0.35, 0.8, c1)) * uIntensity;
    // Galactic band: a bright core, a wide halo, clumpy and cut by dust lanes.
    float t = dot(d, uBandN);
    float core = exp(-pow2(t / 0.11));
    float halo = exp(-pow2(t / 0.38));
    float clump = 0.3 + 1.2 * fbm(d * 5.0 * uScale + sd + 40.0);
    // Star clouds: fine grain along the band, so it reads as unresolved stars.
    float grain = 0.55 + 0.9 * fbm(d * 26.0 + sd);
    // The great rift: a dark lane splitting the core, with wispy side lanes.
    float rift = smoothstep(0.35, 0.7, fbm(vec3(d.x * 7.0, d.y * 7.0 + t * 20.0, d.z * 7.0) + sd + 9.0));
    float riftMask = exp(-pow2((t - 0.012) / 0.05)) * (0.55 + 0.45 * rift);
    float side = smoothstep(0.52, 0.74, fbm(d * vec3(9.0, 3.0, 9.0) + sd + 19.0)) * halo;
    float dust = clamp(riftMask * 0.9 + side * 0.65, 0.0, 0.92);
    vec3 bandCol = mix(vec3(0.5, 0.6, 0.95), vec3(1.0, 0.8, 0.58), core) * (core * 1.0 + halo * 0.3) * clump * grain;
    bandCol = mix(bandCol, bandCol * (uC0 * 1.4 + 0.3), 0.3);
    bandCol *= 1.0 - dust;
    // A few colourful emission glows scattered along the band (hydrogen red, oxygen teal, reflection blue).
    float ang0 = uSeed * 2.1;
    vec3 glow = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      float a = ang0 + float(k) * 1.57 + sin(float(k) * 2.3 + uSeed) * 0.5;
      vec3 e1 = normalize(cross(uBandN, vec3(0.0, 0.0, 1.0) + vec3(1e-3, 0.0, 0.0)));
      vec3 e2 = cross(uBandN, e1);
      vec3 centre = normalize(e1 * cos(a) + e2 * sin(a) + uBandN * (0.05 * sin(float(k) * 5.0 + uSeed)));
      float da = acos(clamp(dot(d, centre), -1.0, 1.0));
      float sz = 0.16 + 0.07 * float(k);
      float blob = exp(-pow2(da / sz)) * (0.35 + 0.9 * fbm(d * 9.0 + float(k) * 3.7 + sd));
      vec3 gc = k == 0 ? vec3(1.0, 0.22, 0.3) : (k == 1 ? vec3(0.2, 0.75, 0.8) : (k == 2 ? vec3(0.3, 0.45, 1.0) : vec3(0.9, 0.35, 0.6)));
      glow += gc * blob;
    }
    glow *= 0.5 * (0.35 + 0.65 * halo) * (1.0 - dust * 0.6);
    vec3 col = neb * 0.65 + bandCol * uBand * 0.42 + glow * uBand * 0.32;
    col *= lane * 0.5 + 0.5;
    gl_FragColor = vec4(col, 1.0);
  }`;

const BAKE_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * The sky backdrop: colorful nebula clouds, dust lanes and a galactic band, painted procedurally
 * from the system's SkyDef. Baked once into a cube map, then drawn on a camera centered sphere
 * behind the stars. Dims with the sky brightness like the stars do.
 */
export class Nebula {
  readonly object: Mesh;
  private readonly material: ShaderMaterial;
  private target: WebGLCubeRenderTarget | null = null;
  private baked = false;

  constructor(private readonly sky: SkyDef) {
    this.material = new ShaderMaterial({
      uniforms: { uMap: { value: null }, uBrightness: { value: 1 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform samplerCube uMap;
        uniform float uBrightness;
        varying vec3 vDir;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(texture(uMap, normalize(vDir)).rgb * uBrightness, 1.0);
        }`,
      side: BackSide,
      blending: AdditiveBlending,
      depthWrite: false,
      // Transparent objects draw after the opaque scene, so without a depth test the nebula
      // would paint over terrain and planets. The sphere sits inside the far plane, like stars.
      depthTest: true,
      transparent: true,
    });
    this.object = new Mesh(new SphereGeometry(RADIUS, 48, 24), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -11;
    this.object.visible = false;
  }

  /** Paint the cube map. Called lazily with the real renderer. */
  private bake(renderer: WebGLRenderer): void {
    this.baked = true;
    const s = this.sky;
    const c = (i: number): Color => new Color(...(s.colors[i % s.colors.length] ?? [0.3, 0.3, 0.6]));
    const mat = new ShaderMaterial({
      uniforms: {
        uC0: { value: c(0) },
        uC1: { value: c(1) },
        uC2: { value: c(2) },
        uFocus: { value: skyFocusDir(s) },
        uBandN: { value: new Vector3(0, Math.cos(BAND_TILT), Math.sin(BAND_TILT)) },
        uIntensity: { value: s.intensity },
        uBand: { value: s.band },
        uScale: { value: s.scale },
        uSeed: { value: (s.seed % 997) * 0.37 },
      },
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      side: BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new Scene();
    scene.add(new Mesh(new SphereGeometry(10, 32, 16), mat));
    const rt = new WebGLCubeRenderTarget(CUBE_SIZE, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
    const cam = new CubeCamera(0.1, 100, rt);
    cam.update(renderer, scene);
    this.target = rt;
    this.material.uniforms.uMap!.value = rt.texture;
    mat.dispose();
    scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
  }

  /** `brightness` 0..1 from the sky (the starfield value). */
  update(renderer: WebGLRenderer, brightness: number, strength: number): void {
    const b = brightness * strength;
    const show = b > 0.004;
    this.object.visible = show;
    if (!show) return;
    if (!this.baked) this.bake(renderer);
    this.material.uniforms.uBrightness!.value = b;
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
    this.object.geometry.dispose();
  }
}
