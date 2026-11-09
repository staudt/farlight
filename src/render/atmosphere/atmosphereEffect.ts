import { Matrix4, type PerspectiveCamera, Uniform, Vector3 } from 'three';
import type { Body } from '../../sim/universe';
import { MAX_ATMOS } from './atmosphere.glsl';

/** Mie haze hugs the ground: its scale height is this fraction of the Rayleigh one. */
const MIE_SCALE = 0.22;

/**
 * Post effect that renders every nearby atmosphere: sky color, aerial perspective on terrain,
 * distant bodies tinted through the sky, sunsets and the rim seen from orbit.
 */
export class AtmosphereEffect {
  readonly uniforms: Map<string, Uniform>;
  private centers = Array.from({ length: MAX_ATMOS }, () => new Vector3());
  private betaR = Array.from({ length: MAX_ATMOS }, () => new Vector3());
  private betaM = Array.from({ length: MAX_ATMOS }, () => new Vector3());
  private betaA = Array.from({ length: MAX_ATMOS }, () => new Vector3());
  private nums = {
    radius: new Array<number>(MAX_ATMOS).fill(1),
    top: new Array<number>(MAX_ATMOS).fill(1),
    camAlt: new Array<number>(MAX_ATMOS).fill(1),
    hr: new Array<number>(MAX_ATMOS).fill(1),
    hm: new Array<number>(MAX_ATMOS).fill(1),
    g: new Array<number>(MAX_ATMOS).fill(0.76),
    sunI: new Array<number>(MAX_ATMOS).fill(20),
  };
  private cand: Body[] = [];
  private shells: number[] = [];
  /** Global multiplier for tuning. */
  intensity = 1;

  constructor() {
    this.uniforms = new Map<string, Uniform>([
      ['uInvProj', new Uniform(new Matrix4())],
      ['uCamToWorld', new Uniform(new Matrix4())],
      ['uLogFar', new Uniform(1)],
      ['uSunDir', new Uniform(new Vector3(1, 0, 0))],
      ['uCount', new Uniform(0)],
      ['uAtmoSteps', new Uniform(14)],
      ['uAtmoLight', new Uniform(5)],
    ]);
    const u = this.uniforms;
    u.set('uCenter', new Uniform(this.centers));
    u.set('uBetaR', new Uniform(this.betaR));
    u.set('uBetaM', new Uniform(this.betaM));
    u.set('uBetaA', new Uniform(this.betaA));
    u.set('uRadius', new Uniform(this.nums.radius));
    u.set('uTop', new Uniform(this.nums.top));
    u.set('uCamAlt', new Uniform(this.nums.camAlt));
    u.set('uHr', new Uniform(this.nums.hr));
    u.set('uHm', new Uniform(this.nums.hm));
    u.set('uMieG', new Uniform(this.nums.g));
    u.set('uSunI', new Uniform(this.nums.sunI));
  }

  /**
   * Picks the atmospheres to draw (nearest by distance to their shell) and uploads uniforms.
   * Bodies are composited far to near.
   */
  updateFrame(camera: PerspectiveCamera, cameraWorld: Vector3, sun: Body, bodies: readonly Body[]): void {
    const u = this.uniforms;
    (u.get('uInvProj')!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.get('uCamToWorld')!.value as Matrix4).copy(camera.matrixWorld);
    u.get('uLogFar')!.value = Math.log2(camera.far + 1);

    // The MAX_ATMOS nearest shells, kept sorted far to near, without allocating.
    const cand = this.cand;
    const shells = this.shells;
    let n = 0;
    for (const b of bodies) {
      if (!b.def.atmosphere || b.atmosphereHeight <= 0) continue;
      const shell = b.position.distanceTo(cameraWorld) - b.atmosphereTop;
      if (shell >= b.radius * 60) continue;
      // Insert keeping ascending shell distance, dropping the farthest beyond MAX_ATMOS.
      let k = n < MAX_ATMOS ? n : MAX_ATMOS - 1;
      if (n >= MAX_ATMOS && shell >= shells[k]!) continue;
      while (k > 0 && shells[k - 1]! > shell) {
        cand[k] = cand[k - 1]!;
        shells[k] = shells[k - 1]!;
        k--;
      }
      cand[k] = b;
      shells[k] = shell;
      if (n < MAX_ATMOS) n++;
    }
    // Composited far to near: slot 0 is the farthest.
    for (let i = 0; i < n >> 1; i++) {
      const t = cand[i]!;
      cand[i] = cand[n - 1 - i]!;
      cand[n - 1 - i] = t;
    }

    // Sun direction from the nearest atmospheric body (or the camera) toward the sun.
    const ref = n ? cand[n - 1]!.position : cameraWorld;
    (u.get('uSunDir')!.value as Vector3).copy(sun.position).sub(ref).normalize();

    for (let i = 0; i < n; i++) {
      const b = cand[i]!;
      const a = b.def.atmosphere!;
      const H = b.atmosphereHeight;
      const hr = a.scaleHeight * H;
      const hm = hr * MIE_SCALE;
      this.centers[i]!.copy(b.position).sub(cameraWorld);
      this.nums.radius[i] = b.radius;
      this.nums.top[i] = H;
      this.nums.camAlt[i] = b.position.distanceTo(cameraWorld) - b.radius;
      this.nums.hr[i] = hr;
      this.nums.hm[i] = hm;
      this.nums.g[i] = a.mieG;
      this.nums.sunI[i] = a.sunIntensity * this.intensity;
      // Zenith optical depth -> per meter coefficient at sea level.
      this.betaR[i]!.set(a.rayleighDepth[0] / hr, a.rayleighDepth[1] / hr, a.rayleighDepth[2] / hr);
      const mc = a.mieColor ?? [1, 1, 1];
      const bm = a.mieDepth / hm;
      // Colored Mie: dust scatters its own color and absorbs the complement a bit.
      this.betaM[i]!.set(bm * mc[0], bm * mc[1], bm * mc[2]);
      const ab = a.absorptionDepth ?? [0, 0, 0];
      this.betaA[i]!.set(ab[0] / hr, ab[1] / hr, ab[2] / hr);
    }
    u.get('uCount')!.value = n;
  }
}
