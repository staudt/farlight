import { Quaternion, Vector3 } from 'three';
import type { LifeDef } from '../../data/types';
import { biomeNameAt } from '../../terrain/biomes';
import { makeSample, type TerrainSampler } from '../../terrain/heightfield';
import type { Body } from '../../sim/universe';
import type { World } from '../../sim/world';
import { makeSite, tangentFrame, type SiteSample, type SurfaceProbe } from './spawn';
import type { LifeBudget } from './settings';

/** Everything the creature layers need about this frame, computed once. */
export interface LifeEnv {
  body: Body;
  defs: readonly LifeDef[];
  probe: SurfaceProbe;
  /** Real seconds since the last frame, capped. */
  dt: number;
  time: number;
  /** Camera direction from the body centre, body fixed unit vector. */
  camDir: Vector3;
  /** Camera height above the ground below it. */
  camAgl: number;
  /** body.position minus cameraWorld (float64), the render origin of the body. */
  origin: Vector3;
  rot: Quaternion;
  /** Ship position from the body centre, body fixed. */
  shipLocal: Vector3;
  sunDirWorld: Vector3;
  /** Sun elevation sine at the camera. */
  sunElev: number;
  /** 0 night .. 1 day, and its complement, both smooth. */
  daylight: number;
  night: number;
  budget: LifeBudget;
}

const _sm = makeSample();

/** Wraps a body's shared height sampler as a read only probe. */
export function makeProbe(world: World, body: Body): SurfaceProbe {
  const sampler = world.sampler(body) as Partial<TerrainSampler>;
  const terrain = body.def.terrain;
  const has = typeof sampler.sample === 'function' && terrain !== undefined;
  return {
    sample(x, y, z, out: SiteSample): SiteSample {
      if (!has) {
        out.water = false;
        out.depth = out.depthN = 0;
        out.name = '';
        out.height = world.groundHeight(body, _v.set(x, y, z));
        return out;
      }
      sampler.sample!(x, y, z, _sm);
      out.water = _sm.water;
      out.depth = _sm.depth;
      out.depthN = _sm.depthN;
      out.height = _sm.height;
      out.name = _sm.water ? '' : biomeNameAt(terrain, _sm, 0.1);
      return out;
    },
    ground(x, y, z): number {
      return world.groundHeight(body, _v.set(x, y, z));
    },
  };
}

const _v = new Vector3();
export { makeSite };

const _sx = new Vector3();

/**
 * A point on a body with its own tangent frame, kept in float64. `frame(env)` fills the render
 * space (camera relative) anchor and axes; `pos` then turns tangent coordinates (x east, y up,
 * z south, meters) into a camera relative position.
 */
export class Anchor {
  readonly dir = new Vector3(0, 1, 0);
  readonly east = new Vector3(1, 0, 0);
  readonly south = new Vector3(0, 0, 1);
  /** Camera relative position of the anchor on the radius. */
  readonly a = new Vector3();
  readonly we = new Vector3();
  readonly wu = new Vector3();
  readonly ws = new Vector3();

  set(dir: Vector3): this {
    this.dir.copy(dir).normalize();
    tangentFrame(this.dir, this.east, this.south);
    return this;
  }

  /** Moves the anchor by (x, z) meters along the ground. */
  shift(x: number, z: number, radius: number): void {
    _sx.copy(this.dir).multiplyScalar(radius).addScaledVector(this.east, x).addScaledVector(this.south, z);
    this.set(_sx);
  }

  frame(env: LifeEnv): void {
    const q = env.rot;
    this.wu.copy(this.dir).applyQuaternion(q);
    this.we.copy(this.east).applyQuaternion(q);
    this.ws.copy(this.south).applyQuaternion(q);
    this.a.copy(this.wu).multiplyScalar(env.body.radius).add(env.origin);
  }

  pos(x: number, y: number, z: number, out: Vector3): Vector3 {
    return out.copy(this.a).addScaledVector(this.we, x).addScaledVector(this.wu, y).addScaledVector(this.ws, z);
  }

  /** Body fixed unit direction above tangent coordinates (x, z). */
  dirAt(x: number, z: number, radius: number, out: Vector3): Vector3 {
    return out.copy(this.dir).multiplyScalar(radius).addScaledVector(this.east, x).addScaledVector(this.south, z).normalize();
  }

  /** Tangent coordinates of a body fixed point (from the body centre). */
  local(p: Vector3, radius: number, out: { x: number; y: number; z: number }): void {
    const dx = p.x - this.dir.x * radius;
    const dy = p.y - this.dir.y * radius;
    const dz = p.z - this.dir.z * radius;
    out.x = dx * this.east.x + dy * this.east.y + dz * this.east.z;
    out.z = dx * this.south.x + dy * this.south.y + dz * this.south.z;
    out.y = dx * this.dir.x + dy * this.dir.y + dz * this.dir.z;
  }
}

/**
 * Writes one column major instance matrix: forward `f` (unit) maps to model -Z, `up` is the
 * hint for model +Y, `bank` rolls about forward (positive: right side down). Scales per axis.
 */
export function writeBasis(
  arr: Float32Array,
  i: number,
  px: number,
  py: number,
  pz: number,
  fx: number,
  fy: number,
  fz: number,
  ux: number,
  uy: number,
  uz: number,
  bank: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  // right = f x up
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-5) {
    // Looking straight along up: pick any right.
    rx = 1;
    ry = 0;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // up2 = right x f
  let vx = ry * fz - rz * fy;
  let vy = rz * fx - rx * fz;
  let vz = rx * fy - ry * fx;
  if (bank !== 0) {
    const c = Math.cos(bank);
    const s = Math.sin(bank);
    const nrx = rx * c - vx * s;
    const nry = ry * c - vy * s;
    const nrz = rz * c - vz * s;
    vx = vx * c + rx * s;
    vy = vy * c + ry * s;
    vz = vz * c + rz * s;
    rx = nrx;
    ry = nry;
    rz = nrz;
  }
  const o = i * 16;
  arr[o] = rx * sx;
  arr[o + 1] = ry * sx;
  arr[o + 2] = rz * sx;
  arr[o + 3] = 0;
  arr[o + 4] = vx * sy;
  arr[o + 5] = vy * sy;
  arr[o + 6] = vz * sy;
  arr[o + 7] = 0;
  arr[o + 8] = -fx * sz;
  arr[o + 9] = -fy * sz;
  arr[o + 10] = -fz * sz;
  arr[o + 11] = 0;
  arr[o + 12] = px;
  arr[o + 13] = py;
  arr[o + 14] = pz;
  arr[o + 15] = 1;
}

export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
