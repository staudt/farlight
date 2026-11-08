import { Effect, EffectAttribute } from 'postprocessing';
import { Color, Matrix3, Matrix4, type PerspectiveCamera, Quaternion, Uniform, Vector3 } from 'three';
import type { Body } from '../../sim/universe';
import { cloudFragment } from './clouds.glsl';
import { cloudDrift } from './coverage';
import { createCloudNoiseTexture } from './noiseTexture';

/** Raymarched cloud layer for the nearest body that has clouds. */
export class CloudEffect extends Effect {
  /** Global tuning knobs (debug panel). */
  coverageBias = 0;
  sunIntensity = 1.6;
  private frame = 0;
  /** Current cloud body, for weather systems that want to know. */
  body: Body | null = null;
  readonly flashPos = new Vector3();
  flash = 0;

  constructor() {
    super('CloudEffect', cloudFragment, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uNoise', new Uniform(createCloudNoiseTexture())],
        ['uActive', new Uniform(0)],
        ['uInvProj', new Uniform(new Matrix4())],
        ['uCamToWorld', new Uniform(new Matrix4())],
        ['uLogFar', new Uniform(1)],
        ['uCenter', new Uniform(new Vector3())],
        ['uToLocal', new Uniform(new Matrix3())],
        ['uR', new Uniform(1)],
        ['uCamAlt', new Uniform(1)],
        ['uBase', new Uniform(1)],
        ['uTop', new Uniform(2)],
        ['uScale', new Uniform(10000)],
        ['uCoverage', new Uniform(0.5)],
        ['uDrift', new Uniform(new Vector3())],
        ['uSunDir', new Uniform(new Vector3(1, 0, 0))],
        ['uCloudColor', new Uniform(new Color(1, 1, 1))],
        ['uSunI', new Uniform(1.6)],
        ['uFlash', new Uniform(0)],
        ['uFlashPos', new Uniform(new Vector3())],
        ['uFrame', new Uniform(0)],
      ]),
    });
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
    if (!best) return;
    const c = best.def.atmosphere!.clouds!;
    const H = best.atmosphereHeight;

    (u.get('uInvProj')!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.get('uCamToWorld')!.value as Matrix4).copy(camera.matrixWorld);
    u.get('uLogFar')!.value = Math.log2(camera.far + 1);
    (u.get('uCenter')!.value as Vector3).copy(best.position).sub(cameraWorld);
    _m4.makeRotationFromQuaternion(_q.copy(best.rotation).invert());
    (u.get('uToLocal')!.value as Matrix3).setFromMatrix4(_m4);
    u.get('uR')!.value = best.radius;
    u.get('uCamAlt')!.value = best.position.distanceTo(cameraWorld) - best.radius;
    u.get('uBase')!.value = c.altitude * H;
    u.get('uTop')!.value = (c.altitude + c.thickness) * H;
    const scale = c.scale * best.radius;
    u.get('uScale')!.value = scale;
    u.get('uCoverage')!.value = Math.min(1, Math.max(0, c.coverage + this.coverageBias));
    // Drift wraps at the weather map period so float32 never sees huge offsets.
    const drift = cloudDrift(c, best.radius, simTime);
    (u.get('uDrift')!.value as Vector3).set(drift.x, 0, drift.z);
    (u.get('uSunDir')!.value as Vector3).copy(sun.position).sub(best.position).normalize();
    (u.get('uCloudColor')!.value as Color).setRGB(c.color[0], c.color[1], c.color[2]);
    u.get('uSunI')!.value = this.sunIntensity;
    u.get('uFlash')!.value = this.flash;
    (u.get('uFlashPos')!.value as Vector3).copy(this.flashPos);
    u.get('uFrame')!.value = this.frame++;
  }
}

const _m4 = new Matrix4();
const _q = new Quaternion();
