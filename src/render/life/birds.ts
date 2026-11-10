import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { LifeDef } from '../../data/types';
import { quality } from '../quality';
import { Flock } from './boids';
import { Anchor, hash01, smoothstep, writeBasis, type LifeEnv } from './env';
import { LIFE_LIGHT_GLSL, type LifeLight } from './lifeLight';
import { lifeBudget, lifeSettings } from './settings';
import { CELL_SIZE, CellGrid, Spawner, groupHome } from './spawn';

const CELL = CELL_SIZE.birds;

/** Ground cell edge, spawn and despawn distance for flocks (game meters). */
const SPAWN = 2800;
const DESPAWN = 3500;
const FADE_NEAR = 1700;
const FADE_FAR = 2600;
const MAX_BIRDS = 600;

type V3 = [number, number, number];

/** Bird geometry: wingspan 1 along x, nose toward -z. A 4 triangle body, a tail and four wing quads. */
export function birdGeometry(): BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tone: number[] = [];
  const tri = (a: V3, b: V3, c: V3, t: number, wa = 0, wb = 0, wc = 0): void => {
    pos.push(...a, ...b, ...c);
    wing.push(wa, wb, wc);
    tone.push(t, t, t);
  };
  const N: V3 = [0, 0, -0.24];
  const T: V3 = [0, 0.055, 0.05];
  const L: V3 = [-0.045, -0.03, 0.07];
  const R: V3 = [0.045, -0.03, 0.07];
  tri(N, T, L, 1);
  tri(N, R, T, 1);
  tri(N, L, R, 0.78);
  tri(T, L, R, 0.9);
  tri([0, 0.01, 0.07], [-0.07, 0.0, 0.24], [0.07, 0.0, 0.24], 0.95);
  for (const s of [-1, 1]) {
    const rf: V3 = [s * 0.04, 0.02, -0.07];
    const rb: V3 = [s * 0.04, 0.012, 0.09];
    const mf: V3 = [s * 0.26, 0.03, -0.075];
    const mb: V3 = [s * 0.26, 0.018, 0.075];
    const tf: V3 = [s * 0.5, 0.034, -0.01];
    const tb: V3 = [s * 0.5, 0.026, 0.08];
    tri(rf, mf, rb, 1, 0, 0.45, 0);
    tri(mf, mb, rb, 0.9, 0.45, 0.45, 0);
    tri(mf, tf, mb, 1, 0.45, 1, 0.45);
    tri(tf, tb, mb, 0.88, 1, 1, 0.45);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new Float32BufferAttribute(wing, 1));
  g.setAttribute('aTone', new Float32BufferAttribute(tone, 1));
  return g;
}

function birdMaterial(light: LifeLight): ShaderMaterial {
  return new ShaderMaterial({
    side: DoubleSide,
    uniforms: { ...light.uniforms },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aWing;
      attribute float aTone;
      attribute vec4 aLife;
      varying vec3 vViewPos;
      varying vec3 vColor;
      void main() {
        vec3 p = position;
        float flap = sin(aLife.x - aWing * 1.1) * aLife.y;
        p.y += aWing * (0.05 + 0.3 * flap);
        p.x *= 1.0 - 0.16 * abs(flap) * aWing;
        vec3 inst = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          inst = instanceColor;
        #endif
        float lum = dot(inst, vec3(0.33));
        float tip = smoothstep(0.6, 1.0, aWing) * step(0.55, lum);
        vColor = inst * aTone * mix(1.0, 0.2, tip);
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${LIFE_LIGHT_GLSL}
      varying vec3 vViewPos;
      varying vec3 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        gl_FragColor = vec4(lifeLit(vColor, N), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** The draws that decide a flock's size, seed, height and orbit (shared with scenarios). */
export function flockPlan(def: LifeDef, rnd: () => number): { n: number; seed: number; hover: number; orbitR: number } {
  const minN = Math.min(8, def.count);
  const n = Math.max(minN, Math.round(minN + rnd() * (def.count - minN)));
  const seed = Math.floor(rnd() * 1e9);
  const hover = Math.min(def.maxAlt * 0.85, def.minAlt + 40 + rnd() * (def.maxAlt - def.minAlt) * 0.2);
  const orbitR = 160 + rnd() * 200;
  return { n, seed, hover, orbitR };
}

interface FlockGroup {
  dir: Vector3;
  idx: number;
  def: LifeDef;
  anchor: Anchor;
  flock: Flock;
  /** Ground height used by the boids (max of a few samples). */
  ground: number;
  nextGround: number;
  vis: number;
  seed: number;
}

const _p = new Vector3();
const _c = { x: 0, y: 0, z: 0 };
const _threat = { x: 0, y: 0, z: 0, radius: 150 };
const _d = new Vector3();

/** Flocks of low-poly birds circling coasts and forests. */
export class Birds {
  readonly object: InstancedMesh;
  private readonly matrices: Float32Array;
  private readonly colors: Float32Array;
  private readonly lifeAttr: InstancedBufferAttribute;
  private spawner: Spawner<FlockGroup> | null = null;
  private bodyId = '';
  private lastScan = -9;
  private readonly rows: { g: FlockGroup; i: number }[] = [];

  constructor(light: LifeLight) {
    const geo = birdGeometry();
    this.lifeAttr = new InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 4), 4);
    this.lifeAttr.setUsage(35048);
    geo.setAttribute('aLife', this.lifeAttr);
    this.object = new InstancedMesh(geo, birdMaterial(light), MAX_BIRDS);
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    this.object.renderOrder = 4;
    this.matrices = this.object.instanceMatrix.array as Float32Array;
    this.object.instanceMatrix.setUsage(35048);
    this.object.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 3), 3);
    this.object.instanceColor.setUsage(35048);
    this.colors = this.object.instanceColor.array as Float32Array;
  }

  get flocks(): number {
    return this.spawner?.groups.size ?? 0;
  }

  /** Anchors of the live flocks, for debugging and scenarios. */
  get homes(): Vector3[] {
    return [...(this.spawner?.groups.values() ?? [])].map((g) => g.dir);
  }

  clear(): void {
    this.spawner?.clear();
    this.object.count = 0;
    this.object.visible = false;
  }

  update(env: LifeEnv | null): void {
    const entries: number[] = [];
    if (env && lifeSettings.enabled && lifeSettings.birds) env.defs.forEach((d, i) => d.kind === 'birds' && entries.push(i));
    const budget = env ? lifeBudget(quality.settings.fxScale, lifeSettings.density) : null;
    if (!env || !budget || entries.length === 0 || budget.flocks === 0) {
      this.clear();
      return;
    }
    const maxAlt = Math.max(...entries.map((i) => env.defs[i]!.maxAlt));
    if (env.camAgl > maxAlt + SPAWN * 0.5) {
      this.clear();
      return;
    }
    if (env.body.id !== this.bodyId || !this.spawner) {
      this.bodyId = env.body.id;
      const grid = new CellGrid(CELL / env.body.radius);
      const R = env.body.radius;
      this.spawner = new Spawner<FlockGroup>(grid, R, SPAWN, DESPAWN, (cell, idx, centre) => this.make(env, grid, cell.row, cell.col, idx, centre));
    }
    const sp = this.spawner;
    const day = (d: LifeDef): number => (d.day ? env.daylight : d.night ? env.night : 1);

    if (env.time - this.lastScan > 0.3) {
      this.lastScan = env.time;
      sp.scan(
        env.camDir,
        entries.filter((i) => day(env.defs[i]!) > 0.15),
        budget.flocks,
        4,
      );
    }

    const R = env.body.radius;
    this.rows.length = 0;
    let n = 0;
    for (const [key, g] of sp.groups) {
      const target = day(g.def);
      g.vis += (target - g.vis) * Math.min(1, env.dt * 0.8);
      if (target < 0.05 && g.vis < 0.03) {
        sp.forget(key);
        continue;
      }
      g.anchor.frame(env);
      const fl = g.flock;
      if (env.time >= g.nextGround) {
        g.nextGround = env.time + 0.4 + 0.1 * hash01(g.seed);
        this.sampleGround(env, g);
      }
      g.anchor.local(env.shipLocal, R, _c);
      _threat.x = _c.x;
      _threat.y = _c.y;
      _threat.z = _c.z;
      _threat.radius = lifeSettings.scatterRadius;
      const gr = g.ground;
      fl.step(env.dt, () => gr, _threat, lifeSettings.birdSpeed);
      const cnt = Math.min(fl.n, Math.floor(budget.birdsPerFlock));
      for (let i = 0; i < cnt && n < MAX_BIRDS; i++) this.write(g, i, n++);
    }
    this.object.count = n;
    this.object.visible = n > 0;
    this.object.instanceMatrix.needsUpdate = true;
    this.object.instanceColor!.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
  }

  private sampleGround(env: LifeEnv, g: FlockGroup): void {
    const R = env.body.radius;
    const fl = g.flock;
    fl.centre(_c);
    let h = -Infinity;
    for (const [x, z] of [
      [_c.x, _c.z],
      [fl.tx, fl.tz],
      [_c.x + fl.vx[0]! * 4, _c.z + fl.vz[0]! * 4],
    ] as const) {
      g.anchor.dirAt(x, z, R, _d);
      h = Math.max(h, env.probe.ground(_d.x, _d.y, _d.z));
    }
    g.ground = h;
  }

  private write(g: FlockGroup, i: number, slot: number): void {
    const fl = g.flock;
    const a = g.anchor;
    a.pos(fl.px[i]!, fl.py[i]!, fl.pz[i]!, _p);
    const dist = _p.length();
    const fade = (1 - smoothstep(FADE_NEAR, FADE_FAR, dist)) * Math.min(1, g.vis * 1.5);
    const size = g.def.size * (0.85 + 0.3 * hash01(g.seed, i)) * fade;
    let fx = a.we.x * fl.vx[i]! + a.wu.x * fl.vy[i]! + a.ws.x * fl.vz[i]!;
    let fy = a.we.y * fl.vx[i]! + a.wu.y * fl.vy[i]! + a.ws.y * fl.vz[i]!;
    let fz = a.we.z * fl.vx[i]! + a.wu.z * fl.vy[i]! + a.ws.z * fl.vz[i]!;
    const l = Math.hypot(fx, fy, fz) || 1;
    fx /= l;
    fy /= l;
    fz /= l;
    writeBasis(this.matrices, slot, _p.x, _p.y, _p.z, fx, fy, fz, a.wu.x, a.wu.y, a.wu.z, fl.bank[i]!, size, size, size);
    const c = g.def.color;
    const v = 0.88 + 0.2 * hash01(g.seed, i + 77);
    this.colors[slot * 3] = c[0] * v;
    this.colors[slot * 3 + 1] = c[1] * v;
    this.colors[slot * 3 + 2] = c[2] * v;
    const o = slot * 4;
    this.lifeAttr.array[o] = fl.phase[i]!;
    this.lifeAttr.array[o + 1] = fl.flap[i]!;
    this.lifeAttr.array[o + 2] = 0;
    this.lifeAttr.array[o + 3] = hash01(g.seed, i);
  }

  private make(env: LifeEnv, grid: CellGrid, row: number, col: number, idx: number, centre: Vector3): FlockGroup | null {
    const def = env.defs[idx]!;
    const home = groupHome(def, env.body.def.seed, idx, { row, col }, centre, grid, env.body.radius, env.probe, lifeSettings.density);
    if (!home) return null;
    const rnd = home.rnd;
    const anchor = new Anchor().set(home.dir);
    const budget = lifeBudget(quality.settings.fxScale, lifeSettings.density);
    const plan = flockPlan(def, rnd);
    const flock = new Flock(Math.min(plan.n, Math.max(budget.birdsPerFlock, Math.min(8, def.count))), plan.seed, plan.orbitR, undefined, plan.hover);
    const seed = plan.seed;
    const g: FlockGroup = { dir: anchor.dir, idx, def, anchor, flock, ground: 0, nextGround: 0, vis: 0, seed };
    anchor.dirAt(0, 0, env.body.radius, _d);
    g.ground = env.probe.ground(_d.x, _d.y, _d.z);
    // Start with the ground right, so the first frames do not dive.
    this.sampleGround(env, g);
    return g;
  }
}
