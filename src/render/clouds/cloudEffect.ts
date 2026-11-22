import { Color, Matrix3, Matrix4, type PerspectiveCamera, Quaternion, Uniform, Vector3, Vector4 } from 'three';
import type { GUI } from 'lil-gui';
import type { Body } from '../../sim/universe';
import { cloudDrift, cloudStructure, cycloneData, MAX_CYCLONES } from './coverage';
import { config } from '../../core/config';
import { nightLight, nightUniforms } from '../nightLight';
import { createCloudNoiseTexture } from './noiseTexture';
import { eclipse } from '../eclipse';

/** Uniforms and per frame state of the raymarched cloud layer (drawn by the volumetric pass). */
export class CloudEffect {
  readonly uniforms: Map<string, Uniform>;
  /** Global tuning knobs (debug panel). */
  coverageBias = 0;
  sunIntensity = 0.55;
  private frame = 0;
  /** Kept for the wiring in post.ts: the march jitter always changes per frame now, the temporal resolve averages it. */
  animateJitter = true;
  /** Previous frame's cloud frame, for the temporal reprojection. */
  private readonly prev = {
    valid: false,
    body: null as Body | null,
    time: 0,
    simTime: 0,
    camLocal: new Vector3(),
    center: new Vector3(),
    toWorld: new Matrix3(),
    viewInv: new Matrix3(),
    proj: new Matrix4(),
  };
  private readonly cyc = new Float32Array(MAX_CYCLONES * 4);
  private readonly camLocal = new Vector3();
  /** Current cloud body, for weather systems that want to know. */
  body: Body | null = null;
  readonly flashPos = new Vector3();
  flash = 0;
  /** Reach of the flash in the far (orbit) cloud mode, meters. */
  flashRadius = 1;

  constructor() {
    this.uniforms = new Map<string, Uniform>([
        ['uNoise', new Uniform(createCloudNoiseTexture())],
        ['uActive', new Uniform(0)],
        ['uInvProj', new Uniform(new Matrix4())],
        ['uCamToWorld', new Uniform(new Matrix4())],
        ['uLogFar', new Uniform(1)],
        ['uCCenter', new Uniform(new Vector3())],
        ['uToLocal', new Uniform(new Matrix3())],
        ['uR', new Uniform(1)],
        ['uCCamAlt', new Uniform(1)],
        ['uBase', new Uniform(1)],
        ['uCTop', new Uniform(2)],
        ['uScale', new Uniform(10000)],
        ['uCoverage', new Uniform(0.5)],
        ['uDrift', new Uniform(new Vector3())],
        ['uCSunDir', new Uniform(new Vector3(1, 0, 0))],
        ['uCloudColor', new Uniform(new Color(1, 1, 1))],
        ['uCSunI', new Uniform(0.55)],
        ['uCloudSelf', new Uniform(-1)],
        ['uFlash', new Uniform(0)],
        ['uFlashPos', new Uniform(new Vector3())],
        ['uFlashR', new Uniform(1)],
        ['uFrame', new Uniform(0)],
        ['uCStruct', new Uniform(1)],
        ['uCMoonDir', new Uniform(new Vector3(0, 1, 0))],
        ['uNLCol', nightUniforms.uNLCol as unknown as Uniform],
        ['uCyc', new Uniform(new Float32Array(MAX_CYCLONES * 4))],
        ['uCLit', new Uniform(new Vector4(0.8, 1, 0.6, 1))],
        ['uHistW', new Uniform(0)],
        ['uPrevCenter', new Uniform(new Vector3())],
        ['uPrevToWorld', new Uniform(new Matrix3())],
        ['uPrevViewInv', new Uniform(new Matrix3())],
        ['uPrevProj', new Uniform(new Matrix4())],
        ['uCloudSteps', new Uniform(30)],
        ['uCloudLight', new Uniform(3)],
        ['uCloudShadows', new Uniform(1)],
    ]);
  }

  updateFrame(camera: PerspectiveCamera, cameraWorld: Vector3, sun: Body, bodies: readonly Body[], simTime: number): void {
    const u = this.uniforms;
    // Nearest body with clouds whose cloud top is within view range.
    let best: Body | null = null;
    let bestDist = Infinity;
    for (const b of bodies) {
      const c = b.def.atmosphere?.clouds;
      if (!c) continue;
      const dist = b.position.distanceTo(cameraWorld) - b.radius;
      if (dist < b.radius * 40 && dist < bestDist) {
        best = b;
        bestDist = dist;
      }
    }
    this.body = best;
    u.get('uActive')!.value = best ? 1 : 0;
    if (!best) {
      this.prev.valid = false;
      u.get('uHistW')!.value = 0;
      return;
    }
    const c = best.def.atmosphere!.clouds!;
    const H = best.atmosphereHeight;

    (u.get('uInvProj')!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.get('uCamToWorld')!.value as Matrix4).copy(camera.matrixWorld);
    u.get('uLogFar')!.value = Math.log2(camera.far + 1);
    (u.get('uCCenter')!.value as Vector3).copy(best.position).sub(cameraWorld);
    _m4.makeRotationFromQuaternion(_q.copy(best.rotation).invert());
    (u.get('uToLocal')!.value as Matrix3).setFromMatrix4(_m4);
    u.get('uR')!.value = best.radius;
    u.get('uCCamAlt')!.value = best.position.distanceTo(cameraWorld) - best.radius;
    u.get('uBase')!.value = c.altitude * H;
    u.get('uCTop')!.value = (c.altitude + c.thickness) * H;
    const scale = c.scale * best.radius;
    u.get('uScale')!.value = scale;
    u.get('uCoverage')!.value = Math.min(1, Math.max(0, c.coverage + this.coverageBias));
    // Drift wraps at the weather map period so float32 never sees huge offsets.
    const drift = cloudDrift(c, best.radius, simTime);
    (u.get('uDrift')!.value as Vector3).set(drift.x, 0, drift.z);
    (u.get('uCSunDir')!.value as Vector3).copy(sun.position).sub(best.position).normalize();
    (u.get('uCloudColor')!.value as Color).setRGB(c.color[0], c.color[1], c.color[2]);
    u.get('uCSunI')!.value = this.sunIntensity;
    u.get('uCloudSelf')!.value = eclipse.idOf(best);
    u.get('uFlash')!.value = this.flash;
    u.get('uFlashR')!.value = this.flashRadius;
    (u.get('uFlashPos')!.value as Vector3).copy(this.flashPos);
    u.get('uFrame')!.value = this.frame++;
    u.get('uCStruct')!.value = cloudStructure(c);
    (u.get('uCMoonDir')!.value as Vector3).copy(nightLight.dirWorld);
    u.get('uCyc')!.value = cycloneData(this.cyc);
    const cl = config.clouds;
    (u.get('uCLit')!.value as Vector4).set(cl.powder, cl.silver, cl.underside, cl.warmth);
    this.updateHistory(camera, best, simTime);
  }

  /** Sets the reprojection uniforms from last frame's state, then stores this frame's. */
  private updateHistory(camera: PerspectiveCamera, best: Body, simTime: number): void {
    const u = this.uniforms;
    const p = this.prev;
    const now = performance.now() / 1000;
    const realDt = now - p.time;
    const center = u.get('uCCenter')!.value as Vector3;
    const toLocal = u.get('uToLocal')!.value as Matrix3;
    this.camLocal.copy(center).negate().applyMatrix3(toLocal);
    const alt = u.get('uCCamAlt')!.value as number;
    const ratio = this.camLocal.distanceTo(p.camLocal) / Math.max(alt, 3000);
    const simDt = simTime - p.simTime;
    // Reset on a new body, a stall, time warp (the clouds slide by many pixels) or a teleport.
    const reset = !p.valid || p.body !== best || realDt > 0.25 || realDt <= 0 || Math.abs(simDt) > 6 * realDt + 0.05 || ratio > 0.25;
    const w = config.clouds.taa * (1 - smooth(0.01, 0.08, ratio));
    u.get('uHistW')!.value = reset ? 0 : Math.min(0.95, Math.max(0, w));
    (u.get('uPrevCenter')!.value as Vector3).copy(p.center);
    (u.get('uPrevToWorld')!.value as Matrix3).copy(p.toWorld);
    (u.get('uPrevViewInv')!.value as Matrix3).copy(p.viewInv);
    (u.get('uPrevProj')!.value as Matrix4).copy(p.proj);
    p.valid = true;
    p.body = best;
    p.time = now;
    p.simTime = simTime;
    p.camLocal.copy(this.camLocal);
    p.center.copy(center);
    p.toWorld.copy(toLocal).transpose();
    p.viewInv.setFromMatrix4(camera.matrixWorld).transpose();
    p.proj.copy(camera.projectionMatrix);
  }

  addDebug(f: GUI): void {
    const c = config.clouds;
    f.add(c, 'structure', 0, 1.5).name('weather structure');
    f.add(c, 'cyclones', 0, MAX_CYCLONES, 1);
    f.add(c, 'cycloneSize', 0.1, 0.6);
    f.add(c, 'taa', 0, 0.95).name('temporal blend');
    f.add(c, 'taaClip', 0.5, 3).name('temporal clip');
    f.add(c, 'powder', 0, 1);
    f.add(c, 'silver', 0, 2).name('silver lining');
    f.add(c, 'underside', 0, 1).name('dark underside');
    f.add(c, 'warmth', 0, 2).name('sunset warmth');
  }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const _m4 = new Matrix4();
const _q = new Quaternion();
