import { Group, Matrix4, Mesh, Quaternion, type ShaderMaterial, Vector3 } from 'three';
import { config } from '../../core/config';
import { landmarkHeightMeters, landmarkRadiusMeters } from '../../data/landmarks';
import type { LandmarkTarget } from '../../sim/landmarks';
import type { Body } from '../../sim/universe';
import type { World } from '../../sim/world';
import { type FrameContext, placeRelative } from '../context';
import type { GameRenderer } from '../renderer';
import { type Ground, buildLandmark } from './builders';
import { createLandmarkMaterial } from './material';

interface Entry {
  lm: LandmarkTarget;
  group: Group;
  built: boolean;
}

interface BodyMaterials {
  solid: ShaderMaterial;
  fx: ShaderMaterial;
}

const _east = new Vector3();
const _north = new Vector3();
const _up = new Vector3();
const _south = new Vector3();
const _p = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _cam = new Vector3();

/** Tangent basis of a body fixed direction: x east, y up, z south (ship convention: forward is -Z). */
export function tangentBasis(dir: Vector3, lon: number, east: Vector3, north: Vector3, south: Vector3): void {
  east.set(-Math.sin(lon), 0, -Math.cos(lon));
  north.crossVectors(dir, east).normalize();
  south.copy(north).negate();
}

/**
 * Landmark meshes. Each one is built lazily when the camera comes near, sits on the shared
 * height sampler, and is placed by `placeRelative` like every other object (floating origin).
 */
export class LandmarkLayer {
  readonly object = new Group();
  private readonly entries: Entry[] = [];
  private readonly materials = new Map<string, BodyMaterials>();

  constructor(private readonly world: World) {
    this.object.name = 'landmarks';
    for (const lm of world.landmarks.all) {
      const group = new Group();
      group.visible = false;
      group.name = `landmark:${lm.key}`;
      group.matrixAutoUpdate = true;
      this.object.add(group);
      this.entries.push({ lm, group, built: false });
    }
  }

  private materialsFor(body: Body): BodyMaterials {
    let m = this.materials.get(body.id);
    if (!m) {
      m = { solid: createLandmarkMaterial(false), fx: createLandmarkMaterial(true) };
      this.materials.set(body.id, m);
    }
    return m;
  }

  private build(e: Entry): void {
    const { lm } = e;
    const body = lm.body;
    const sampler = this.world.sampler(body);
    if (Number.isNaN(lm.groundHeight)) lm.groundHeight = sampler.heightAt(lm.dir.x, lm.dir.y, lm.dir.z);
    const base = lm.groundHeight;
    tangentBasis(lm.dir, lm.def.lon, _east, _north, _south);
    const east = _east.clone();
    const north = _north.clone();
    const R = body.radius;
    const dir = lm.dir.clone();
    const ground: Ground = (x, z) => {
      // Tangent offsets (x east, z south) onto the sphere, then the shared sampler.
      _p.copy(dir).multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, -z).normalize();
      return sampler.heightAt(_p.x, _p.y, _p.z) - base;
    };
    const built = buildLandmark({ lm: lm.def, r: landmarkRadiusMeters(lm.def, R), h: landmarkHeightMeters(lm.def, R), ground });
    const mats = this.materialsFor(body);
    if (built.solid) e.group.add(new Mesh(built.solid, mats.solid));
    if (built.fx) {
      const m = new Mesh(built.fx, mats.fx);
      m.renderOrder = 2;
      e.group.add(m);
    }
    e.built = true;
  }

  update(ctx: FrameContext): void {
    const c = config.landmarks;
    const camera = ctx.cameraWorld;
    const inUse = new Set<Body>();
    for (const e of this.entries) {
      const lm = e.lm;
      const near = c.enabled && _cam.copy(lm.position).sub(camera).length() < c.drawRange;
      if (!near) {
        e.group.visible = false;
        continue;
      }
      if (!e.built) {
        if (_cam.copy(lm.position).sub(camera).length() > c.buildRange) {
          e.group.visible = false;
          continue;
        }
        this.build(e);
      }
      // Position at the sampled ground, oriented to the body fixed tangent frame.
      const body = lm.body;
      tangentBasis(lm.dir, lm.def.lon, _east, _north, _south);
      _up.copy(lm.dir);
      _m.makeBasis(_east, _up, _south);
      _q.setFromRotationMatrix(_m);
      e.group.quaternion.copy(body.rotation).multiply(_q);
      placeRelative(e.group, lm.position, camera);
      e.group.visible = true;
      inUse.add(body);
    }
    for (const body of inUse) {
      const m = this.materials.get(body.id);
      if (!m) continue;
      for (const mat of [m.solid, m.fx]) {
        const u = mat.uniforms;
        (u.uSunDirView!.value as Vector3)
          .copy(ctx.world.universe.root.position)
          .sub(body.position)
          .normalize()
          .transformDirection(ctx.camera.matrixWorldInverse);
        (u.uBodyCenterView!.value as Vector3).copy(body.position).sub(camera).applyMatrix4(ctx.camera.matrixWorldInverse);
        u.uTime!.value = ctx.realTime;
        u.uGlow!.value = config.landmarks.glow;
      }
    }
  }

  dispose(): void {
    for (const e of this.entries) {
      e.group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
    }
    for (const m of this.materials.values()) {
      m.solid.dispose();
      m.fx.dispose();
    }
  }
}

/** Adds the landmark meshes to the scene. */
export function installLandmarks(gfx: GameRenderer): LandmarkLayer {
  const layer = new LandmarkLayer(gfx.ctx.world);
  gfx.scene.add(layer.object);
  gfx.updaters.push((ctx) => layer.update(ctx));
  return layer;
}
