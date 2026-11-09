import { Effect, EffectAttribute, Pass } from 'postprocessing';
import {
  HalfFloatType,
  NearestFilter,
  RawShaderMaterial,
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
  cloudCompute(d, dView, tScene, tc, lc);
  vec3 T = vec3(tc);
  vec3 L = lc;
  atmoCompute(d, tScene, T, L);
  // One NaN turns the whole frame black through bloom: never let one out.
  if (any(isnan(L)) || any(isnan(T))) { L = vec3(0.0); T = vec3(1.0); }
  oL = vec4(min(L, vec3(60000.0)), 0.0);
  oT = vec4(clamp(T, 0.0, 1.0), raw);
}
`;

export class VolumetricPass extends Pass {
  readonly target: WebGLRenderTarget;
  private readonly material: RawShaderMaterial;
  /** Fraction of the full resolution. */
  private scale = 0.5;
  /** True at 0.55 scale or lower (medium, low): the composite blurs the jitter grain. */
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
    this.target = new WebGLRenderTarget(1, 1, {
      count: 2,
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
    });
    const u: Record<string, Uniform> = { uDepth: new Uniform(null), uStarColor: starLight.uniform as Uniform };
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
  }

  get texL(): Texture {
    return this.target.textures[0]!;
  }
  get texT(): Texture {
    return this.target.textures[1]!;
  }
  get width(): number {
    return this.target.width;
  }
  get height(): number {
    return this.target.height;
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
    this.target.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  override render(renderer: WebGLRenderer): void {
    if (!this.depth) return;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
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
