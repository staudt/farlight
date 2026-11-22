import { Effect, EffectAttribute, Pass } from 'postprocessing';
import {
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  RGBAFormat,
  GLSL3,
  Uniform,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { atmosphereLib } from './atmosphere/atmosphere.glsl';
import { starLight } from './starLight';
import { cloudLib } from './clouds/clouds.glsl';
import { ECLIPSE_GLSL, eclipse } from './eclipse';
import { config } from '../core/config';

const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * Clouds and atmospheres at reduced resolution. Both are affine in the scene color
 * (out = scene * T + L), so one pass writes L (target 0) and T plus the raw depth it saw
 * (target 1). `VolumetricComposite` applies them at full resolution with a depth aware filter.
 */
const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 oL;
layout(location = 1) out vec4 oT;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uCamToWorld;
uniform float uLogFar;
uniform vec3 uStarColor;       // tint * intensity of the star (white for Sol)
${ECLIPSE_GLSL}
${cloudLib}
${atmosphereLib}

void main() {
  vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0); // near plane: far = 1e11 overflows float32
  vec4 view = uInvProj * clip;
  vec3 dView = normalize(view.xyz / view.w);
  vec3 d = normalize(mat3(uCamToWorld) * dView);

  float raw = texture(uDepth, vUv).r;
  float tScene = 1e30;
  if (raw < 0.99999) tScene = (exp2(raw * uLogFar) - 1.0) / max(-dView.z, 1e-4);

  float tc;
  vec3 lc;
  float tHit;
  cloudCompute(d, dView, tScene, tc, lc, tHit);
  vec3 T = vec3(tc);
  vec3 L = lc;
  // Air in front of an opaque cloud only scatters up to the cloud, so a dark storm deck is not washed out by sky light from behind it.
  float tAir = tScene;
  if (tHit > 0.0) {
    float opaque = clamp(1.0 - tc, 0.0, 1.0);
    tAir = exp(mix(log(min(tScene, 1e9)), log(max(min(tHit, tScene), 1.0)), opaque));
  }
  atmoCompute(d, tAir, T, L);
  // One NaN turns the whole frame black through bloom: never let one out.
  if (any(isnan(L)) || any(isnan(T))) { L = vec3(0.0); T = vec3(1.0); }
  // Alpha: log2(1 + distance) of what the pixel shows, for the temporal reprojection (23 = far away).
  float seen = tHit > 0.0 ? tHit : min(tScene, 8e6);
  oL = vec4(min(L, vec3(60000.0)), min(log2(1.0 + seen), 23.0));
  oT = vec4(clamp(T, 0.0, 1.0), raw);
}
`;


/**
 * Temporal resolve: reprojects last frame's result through the cloud body's own frame (so planet
 * rotation, camera motion and the floating origin are all accounted for), clips it to the
 * neighbourhood of the new samples and blends. The march jitter changes every frame, so the noise
 * averages out instead of being blurred away.
 */
const RESOLVE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
layout(location = 0) out vec4 oL;
layout(location = 1) out vec4 oT;
uniform sampler2D uCurL;
uniform sampler2D uCurT;
uniform sampler2D uHistL;
uniform sampler2D uHistT;
uniform vec2 uSize;
uniform mat4 uInvProj;
uniform mat4 uCamToWorld;
uniform float uLogFar;
uniform float uHistW;
uniform float uTaaClip;
uniform vec3 uCCenter;
uniform mat3 uToLocal;
uniform vec3 uPrevCenter;
uniform mat3 uPrevToWorld;
uniform mat3 uPrevViewInv;
uniform mat4 uPrevProj;

vec3 comp(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 decomp(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-5); }

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 cl = texelFetch(uCurL, ip, 0);
  vec4 ct = texelFetch(uCurT, ip, 0);
  oL = cl;
  oT = ct;
  if (uHistW <= 0.0) return;
  ivec2 hi = ivec2(uSize) - 1;
  vec3 mL = vec3(0.0), sL = vec3(0.0), mT = vec3(0.0), sT = vec3(0.0);
  for (int k = 0; k < 9; k++) {
    ivec2 c = clamp(ip + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), hi);
    vec3 l = comp(texelFetch(uCurL, c, 0).rgb);
    vec3 t = texelFetch(uCurT, c, 0).rgb;
    mL += l; sL += l * l; mT += t; sT += t * t;
  }
  mL /= 9.0; mT /= 9.0;
  vec3 dL = sqrt(max(sL / 9.0 - mL * mL, 0.0)) * uTaaClip + 0.004;
  vec3 dT = sqrt(max(sT / 9.0 - mT * mT, 0.0)) * uTaaClip + 0.004;

  vec2 uv = (vec2(ip) + 0.5) / uSize;
  vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 view = uInvProj * clip;
  vec3 d = normalize(mat3(uCamToWorld) * normalize(view.xyz / view.w));
  float dist = exp2(min(cl.a, 23.0)) - 1.0;
  vec3 pl = uToLocal * (d * dist - uCCenter);
  vec3 pv = uPrevViewInv * (uPrevToWorld * pl + uPrevCenter);
  vec4 pc = uPrevProj * vec4(pv, 1.0);
  if (pc.w <= 0.0) return;
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) return;
  float hd = texelFetch(uHistT, clamp(ivec2(puv * uSize), ivec2(0), hi), 0).a;
  // Disocclusion: the surface behind this pixel was at a different depth last frame.
  if (abs(hd - ct.a) * uLogFar > 0.25) return;
  float motion = length((puv - uv) * uSize);
  float w = uHistW * (1.0 - clamp(motion * 0.08, 0.0, 0.5));
  vec3 hL = clamp(comp(texture(uHistL, puv).rgb), mL - dL, mL + dL);
  vec3 hT = clamp(texture(uHistT, puv).rgb, mT - dT, mT + dT);
  oL = vec4(decomp(mix(comp(cl.rgb), hL, w)), cl.a);
  oT = vec4(mix(ct.rgb, hT, w), ct.a);
}
`;

export class VolumetricPass extends Pass {
  /** The two resolved buffers (ping pong): one is written each frame, the other is last frame's history. */
  private readonly out: [WebGLRenderTarget, WebGLRenderTarget];
  /** Raw march result of this frame, before the temporal resolve. */
  private readonly cur: WebGLRenderTarget;
  private writeIdx = 0;
  private needReset = true;
  private readonly material: RawShaderMaterial;
  private readonly resolveMaterial: RawShaderMaterial;
  private readonly resolveScene = new Scene();
  private readonly resolveCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Fraction of the full resolution. */
  private scale = 0.5;
  /** True at 0.55 scale or lower (medium, low): the composite blurs what noise is left. */
  get blur(): boolean {
    return this.scale <= 0.55;
  }
  private fullW = 1;
  private fullH = 1;
  private depth: Texture | null = null;

  constructor(uniforms: Map<string, Uniform>[]) {
    super('VolumetricPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    const make = (filter: typeof NearestFilter | typeof LinearFilter): WebGLRenderTarget =>
      new WebGLRenderTarget(1, 1, { count: 2, type: HalfFloatType, format: RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false });
    this.cur = make(NearestFilter);
    this.out = [make(LinearFilter), make(LinearFilter)];
    const u: Record<string, Uniform> = { uDepth: new Uniform(null), uStarColor: starLight.uniform as Uniform };
    for (const [k, v] of Object.entries(eclipse.uniforms)) u[k] = v as unknown as Uniform;
    for (const m of uniforms) for (const [k, v] of m) u[k] = v;
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: u,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.material;
    const ru: Record<string, Uniform> = {
      uCurL: new Uniform(null),
      uCurT: new Uniform(null),
      uHistL: new Uniform(null),
      uHistT: new Uniform(null),
      uSize: new Uniform(new Vector2(1, 1)),
      uTaaClip: new Uniform(1.3),
    };
    for (const k of ['uInvProj', 'uCamToWorld', 'uLogFar', 'uHistW', 'uCCenter', 'uToLocal', 'uPrevCenter', 'uPrevToWorld', 'uPrevViewInv', 'uPrevProj'])
      for (const m of uniforms) if (m.has(k)) ru[k] = m.get(k)!;
    this.resolveMaterial = new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: VERT, fragmentShader: RESOLVE_FRAG, uniforms: ru, depthTest: false, depthWrite: false });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const quad = new Mesh(geo, this.resolveMaterial);
    quad.frustumCulled = false;
    this.resolveScene.add(quad);
  }

  /** The resolved buffer that this frame's render writes (bind it before `render`: it is the same target). */
  get texL(): Texture {
    return this.out[this.writeIdx]!.textures[0]!;
  }
  get texT(): Texture {
    return this.out[this.writeIdx]!.textures[1]!;
  }
  get width(): number {
    return this.cur.width;
  }
  get height(): number {
    return this.cur.height;
  }

  /** Drop the accumulated history (teleports, resizes). */
  resetHistory(): void {
    this.needReset = true;
  }

  setScale(s: number): void {
    this.scale = s;
    this.setSize(this.fullW, this.fullH);
  }

  override setDepthTexture(depthTexture: Texture, depthPacking?: Parameters<Pass['setDepthTexture']>[1]): void {
    super.setDepthTexture(depthTexture, depthPacking);
    this.depth = depthTexture;
    this.material.uniforms.uDepth!.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.fullW = width;
    this.fullH = height;
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w !== this.cur.width || h !== this.cur.height) {
      this.cur.setSize(w, h);
      this.out[0].setSize(w, h);
      this.out[1].setSize(w, h);
      this.needReset = true;
    }
  }

  override render(renderer: WebGLRenderer): void {
    if (!this.depth) return;
    renderer.setRenderTarget(this.cur);
    renderer.render(this.scene, this.camera);
    const ru = this.resolveMaterial.uniforms;
    const hist = this.out[this.writeIdx ^ 1]!;
    if (this.needReset) ru.uHistW!.value = 0;
    ru.uCurL!.value = this.cur.textures[0];
    ru.uCurT!.value = this.cur.textures[1];
    ru.uHistL!.value = hist.textures[0];
    ru.uHistT!.value = hist.textures[1];
    (ru.uSize!.value as Vector2).set(this.cur.width, this.cur.height);
    ru.uTaaClip!.value = config.clouds.taaClip;
    renderer.setRenderTarget(this.out[this.writeIdx]!);
    renderer.render(this.resolveScene, this.resolveCamera);
    this.needReset = false;
    this.writeIdx ^= 1;
  }

  override dispose(): void {
    this.cur.dispose();
    this.out[0].dispose();
    this.out[1].dispose();
    this.material.dispose();
    this.resolveMaterial.dispose();
    super.dispose();
  }
}

/**
 * Full resolution composite: scene * T + L, with the four nearest low resolution texels
 * weighted bilinearly and by how well their depth matches the full resolution depth, so
 * terrain, ship and planet edges stay crisp.
 */
export class VolumetricComposite extends Effect {
  constructor() {
    super(
      'VolumetricComposite',
      /* glsl */ `
uniform sampler2D uVolL;
uniform sampler2D uVolT;
uniform vec2 uVolSize;
uniform float uVolOn;
uniform float uVolLogFar;
uniform float uVolBlur;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (uVolOn < 0.5) { outputColor = inputColor; return; }
  float raw = texture2D(depthBuffer, uv).r;
  vec2 p = uv * uVolSize - 0.5;
  vec2 fl = floor(p);
  vec2 f = p - fl;
  ivec2 i0 = ivec2(fl);
  ivec2 hi = ivec2(uVolSize) - 1;
  vec3 T = vec3(0.0);
  vec3 L = vec3(0.0);
  float wSum = 0.0;
  if (uVolBlur > 0.5) {
    // Low resolution buffers: a small gaussian over 3x3 texels, still weighted by depth, so the
    // per pixel march jitter melts into soft cloud edges without smearing terrain or the ship.
    ivec2 n0 = ivec2(floor(p + 0.5));
    for (int k = 0; k < 9; k++) {
      ivec2 c = clamp(n0 + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), hi);
      vec2 dv = vec2(c) - p;
      vec4 t = texelFetch(uVolT, c, 0);
      float dd = abs(t.a - raw) * uVolLogFar * 20.0;
      float w = exp(-dot(dv, dv) * 0.85) / (1.0 + dd * dd);
      T += t.rgb * w;
      L += texelFetch(uVolL, c, 0).rgb * w;
      wSum += w;
    }
    T /= wSum;
    L /= wSum;
    outputColor = vec4(inputColor.rgb * T + L, inputColor.a);
    return;
  }
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 c = clamp(i0 + o, ivec2(0), hi);
    vec4 t = texelFetch(uVolT, c, 0);
    float bil = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float dd = abs(t.a - raw) * uVolLogFar * 20.0;
    float w = (bil + 1e-3) / (1.0 + dd * dd);
    T += t.rgb * w;
    L += texelFetch(uVolL, c, 0).rgb * w;
    wSum += w;
  }
  T /= wSum;
  L /= wSum;
  outputColor = vec4(inputColor.rgb * T + L, inputColor.a);
}
`,
      {
        attributes: EffectAttribute.DEPTH,
        uniforms: new Map<string, Uniform>([
          ['uVolL', new Uniform(null)],
          ['uVolT', new Uniform(null)],
          ['uVolSize', new Uniform(new Vector2(1, 1))],
          ['uVolOn', new Uniform(0)],
          ['uVolLogFar', new Uniform(1)],
          ['uVolBlur', new Uniform(0)],
        ]),
      },
    );
  }

  bind(pass: VolumetricPass, logFar: number, on: boolean): void {
    const u = this.uniforms;
    u.get('uVolL')!.value = pass.texL;
    u.get('uVolT')!.value = pass.texT;
    (u.get('uVolSize')!.value as Vector2).set(pass.width, pass.height);
    u.get('uVolLogFar')!.value = logFar;
    u.get('uVolOn')!.value = on ? 1 : 0;
    u.get('uVolBlur')!.value = pass.blur ? 1 : 0;
  }
}
