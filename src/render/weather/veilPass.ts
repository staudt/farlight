import { Effect, Pass } from 'postprocessing';
import { HalfFloatType, LinearFilter, RGBAFormat, Scene, Uniform, WebGLRenderTarget, type PerspectiveCamera, type Texture, type WebGLRenderer } from 'three';

/**
 * Transparent weather veils (rain shafts) drawn into their own small buffer after the volumetric pass and
 * blended over the finished sky by `VeilEffect`. Plain scene objects would be treated by the atmosphere as
 * sky at infinity and erased, so the veils are depth tested by hand against the scene depth instead.
 */
export class VeilPass extends Pass {
  readonly veilScene = new Scene();
  readonly target: WebGLRenderTarget;
  /** Set by the owner each frame: nothing is drawn (and the effect is skipped) when false. */
  active = false;
  /** Raw scene depth texture, for the shader's occlusion test. */
  readonly depthUniform = new Uniform<Texture | null>(null);
  readonly sizeUniform = new Uniform<[number, number]>([1, 1]);
  readonly logFarUniform = new Uniform(1);

  constructor(private veilCamera: PerspectiveCamera) {
    super('VeilPass');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.depthUniform.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.sizeUniform.value = [width, height];
    this.target.setSize(Math.max(1, Math.round(width * 0.4)), Math.max(1, Math.round(height * 0.4)));
  }

  override render(renderer: WebGLRenderer): void {
    if (!this.active || !this.depthUniform.value) return;
    this.logFarUniform.value = Math.log2(this.veilCamera.far + 1);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.veilScene, this.veilCamera);
  }

  override dispose(): void {
    this.target.dispose();
    super.dispose();
  }
}

/** Blends the veil buffer (premultiplied) over the composited frame. */
export class VeilEffect extends Effect {
  constructor(private pass: VeilPass) {
    super(
      'VeilEffect',
      /* glsl */ `
uniform sampler2D uVeilTex;
uniform float uVeilOn;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  if (uVeilOn > 0.5) {
    vec4 v = texture2D(uVeilTex, uv);
    outputColor.rgb = inputColor.rgb * (1.0 - v.a) + v.rgb;
  }
}`,
      {
        uniforms: new Map<string, Uniform>([
          ['uVeilTex', new Uniform(null)],
          ['uVeilOn', new Uniform(0)],
        ]),
      },
    );
  }

  override update(): void {
    this.uniforms.get('uVeilTex')!.value = this.pass.target.texture;
    this.uniforms.get('uVeilOn')!.value = this.pass.active ? 1 : 0;
  }
}
