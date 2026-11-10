import { BufferGeometry, DoubleSide, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, ShaderMaterial, Vector3 } from 'three';
import { mulberry32 } from '../../core/rng';
import type { LifeDef } from '../../data/types';
import { quality } from '../quality';
import { Anchor, hash01, smoothstep, writeBasis, type LifeEnv } from './env';
import { LIFE_LIGHT_GLSL, type LifeLight } from './lifeLight';
import { lifeBudget, lifeSettings } from './settings';
import { CELL_SIZE, CellGrid, Spawner, groupHome, makeSite } from './spawn';

const CELL = CELL_SIZE.fish;

const SPAWN = 800;
const DESPAWN = 1100;
const MAX_FISH = 640;
/** How far a school roams from its home. */
const ROAM = 90;
/** Height of the flecks above the water surface, meters. */
const LIFT = 0.45;

/** A fish seen from above: a kite body and a forked tail, length 1 along z, lying in the xz plane. */
export function fishGeometry(): BufferGeometry {
  const v = [
    // body
    [0, 0, -0.5], [-0.14, 0, -0.12], [0.14, 0, -0.12],
    [-0.14, 0, -0.12], [0.14, 0, -0.12], [0, 0, 0.2],
    // tail
    [0, 0, 0.14], [-0.2, 0, 0.5], [0.2, 0, 0.5],
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v.flat(), 3));
  return g;
}

function fishMaterial(light: LifeLight): ShaderMaterial {
  return new ShaderMaterial({
    side: DoubleSide,
    uniforms: { ...light.uniforms },
    transparent: true,
    depthWrite: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec2 aFish;
      uniform float uTime;
      varying vec3 vColor;
      varying vec2 vFish;
      varying vec3 vN;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 16.0 + aFish.y * 40.0 + p.z * 9.0) * 0.1 * smoothstep(0.0, 0.5, p.z);
        vec3 inst = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          inst = instanceColor;
        #endif
        vColor = inst;
        vFish = aFish;
        mat4 mvi = modelViewMatrix * instanceMatrix;
        vN = normalize(mat3(mvi) * vec3(0.0, 1.0, 0.0));
        vec4 mv = mvi * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${LIFE_LIGHT_GLSL}
      varying vec3 vColor;
      varying vec2 vFish;
      varying vec3 vN;
      void main() {
        #include <logdepthbuf_fragment>
        float term = smoothstep(-0.10, 0.22, uSunElev);
        vec3 col = lifeLit(vColor, normalize(vN));
        // Flashes of silver as the fish turn.
        float glint = pow(max(0.0, sin(uTime * (2.5 + 3.0 * fract(vFish.y * 7.3)) + vFish.y * 60.0)), 16.0);
        col += vec3(1.0, 0.97, 0.9) * glint * 2.6 * term;
        gl_FragColor = vec4(col, vFish.x);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

interface Fish {
  x: number;
  z: number;
  heading: number;
  /** Slot in the school, meters from its centre. */
  sx: number;
  sz: number;
  seed: number;
}

interface School {
  dir: Vector3;
  def: LifeDef;
  anchor: Anchor;
  fish: Fish[];
  cx: number;
  cz: number;
  heading: number;
  speed: number;
  dart: number;
  nextCheck: number;
  /** Sea surface height above the radius. */
  seaY: number;
  alpha: number;
  vis: number;
  seed: number;
  rnd: () => number;
}

const _p = new Vector3();
const _d = new Vector3();
const _site = makeSite();

/** Schools of silver flecks darting just under the surface in shallow water. */
export class FishSchools {
  readonly object: InstancedMesh;
  private readonly fishAttr: InstancedBufferAttribute;
  private readonly colors: Float32Array;
  private readonly matrices: Float32Array;
  private spawner: Spawner<School> | null = null;
  private bodyId = '';
  private lastScan = -9;

  constructor(light: LifeLight) {
    const geo = fishGeometry();
    this.fishAttr = new InstancedBufferAttribute(new Float32Array(MAX_FISH * 2), 2);
    this.fishAttr.setUsage(35048);
    geo.setAttribute('aFish', this.fishAttr);
    this.object = new InstancedMesh(geo, fishMaterial(light), MAX_FISH);
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    this.object.renderOrder = 3;
    this.object.instanceMatrix.setUsage(35048);
    this.matrices = this.object.instanceMatrix.array as Float32Array;
    this.object.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_FISH * 3), 3);
    this.colors = this.object.instanceColor.array as Float32Array;
  }

  get schools(): number {
    return this.spawner?.groups.size ?? 0;
  }

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
    if (env && lifeSettings.enabled && lifeSettings.fish) env.defs.forEach((d, i) => d.kind === 'fish' && entries.push(i));
    const budget = env ? lifeBudget(quality.settings.fxScale, lifeSettings.density) : null;
    if (!env || !budget || entries.length === 0 || budget.schools === 0) {
      this.clear();
      return;
    }
    const maxAlt = Math.max(...entries.map((i) => env.defs[i]!.maxAlt));
    // Only worth drawing when flying low (the flecks are small).
    if (env.camAgl > maxAlt + 100) {
      this.clear();
      return;
    }
    const R = env.body.radius;
    if (env.body.id !== this.bodyId || !this.spawner) {
      this.bodyId = env.body.id;
      const grid = new CellGrid(CELL / R);
      this.spawner = new Spawner<School>(grid, R, SPAWN, DESPAWN, (cell, idx, centre) => this.make(env, grid, cell.row, cell.col, idx, centre));
    }
    const sp = this.spawner;
    const gate = (d: LifeDef): number => (d.day ? env.daylight : d.night ? env.night : 1);
    if (env.time - this.lastScan > 0.3) {
      this.lastScan = env.time;
      sp.scan(
        env.camDir,
        entries.filter((i) => gate(env.defs[i]!) > 0.15),
        budget.schools,
        3,
      );
    }
    let n = 0;
    for (const [key, s] of sp.groups) {
      const target = gate(s.def);
      s.vis += (target - s.vis) * Math.min(1, env.dt * 1.5);
      if (target < 0.05 && s.vis < 0.03) {
        sp.forget(key);
        continue;
      }
      s.anchor.frame(env);
      this.swim(env, s);
      const cnt = Math.min(s.fish.length, budget.fishPerSchool);
      for (let i = 0; i < cnt && n < MAX_FISH; i++) this.write(s, i, n++);
    }
    this.object.count = n;
    this.object.visible = n > 0;
    this.object.instanceMatrix.needsUpdate = true;
    this.object.instanceColor!.needsUpdate = true;
    this.fishAttr.needsUpdate = true;
  }

  private swim(env: LifeEnv, s: School): void {
    const dt = env.dt;
    s.dart -= dt;
    if (s.dart <= 0) {
      // A sudden dart: new heading, a burst of speed.
      s.heading += (s.rnd() - 0.5) * 2.6;
      s.speed = 7 + s.rnd() * 7;
      s.dart = 1.6 + s.rnd() * 3.2;
    }
    s.speed += (1.8 - s.speed) * Math.min(1, dt * 0.8);
    // Stay near home and over water.
    const away = Math.hypot(s.cx, s.cz);
    if (away > ROAM || env.time >= s.nextCheck) {
      s.nextCheck = env.time + 0.7;
      s.anchor.dirAt(s.cx + Math.cos(s.heading) * 25, s.cz + Math.sin(s.heading) * 25, env.body.radius, _d);
      const site = env.probe.sample(_d.x, _d.y, _d.z, _site);
      if (away > ROAM || !site.water) {
        const home = Math.atan2(-s.cz, -s.cx);
        let diff = home - s.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        s.heading += diff * 0.8;
      }
    }
    s.cx += Math.cos(s.heading) * s.speed * dt;
    s.cz += Math.sin(s.heading) * s.speed * dt;
    const cs = Math.cos(s.heading);
    const sn = Math.sin(s.heading);
    const k = Math.min(1, dt * 4);
    for (const f of s.fish) {
      // Slots are an ellipse stretched along the heading.
      const tx = s.cx + f.sx * cs - f.sz * sn;
      const tz = s.cz + f.sx * sn + f.sz * cs;
      const dx = tx - f.x;
      const dz = tz - f.z;
      f.x += dx * k;
      f.z += dz * k;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const h = Math.atan2(dz, dx);
        let diff = h - f.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        f.heading += diff * Math.min(1, dt * 8);
      }
    }
  }

  private write(s: School, i: number, slot: number): void {
    const f = s.fish[i]!;
    const a = s.anchor;
    a.pos(f.x, s.seaY + LIFT, f.z, _p);
    const dist = _p.length();
    const near = 1 - smoothstep(280, 650, dist);
    // Model forward is -z, so face along the heading.
    const hx = Math.cos(f.heading);
    const hz = Math.sin(f.heading);
    const fx = a.we.x * hx + a.ws.x * hz;
    const fy = a.we.y * hx + a.ws.y * hz;
    const fz = a.we.z * hx + a.ws.z * hz;
    const l = Math.hypot(fx, fy, fz) || 1;
    const size = s.def.size * (0.8 + 0.4 * hash01(s.seed, i)) * (near > 0.02 ? 1 : 0);
    writeBasis(this.matrices, slot, _p.x, _p.y, _p.z, fx / l, fy / l, fz / l, a.wu.x, a.wu.y, a.wu.z, 0, size * 0.55, size, size);
    const c = s.def.color;
    const v = 0.8 + 0.3 * hash01(s.seed, i + 5);
    this.colors[slot * 3] = c[0] * v;
    this.colors[slot * 3 + 1] = c[1] * v;
    this.colors[slot * 3 + 2] = c[2] * v;
    this.fishAttr.array[slot * 2] = s.alpha * near * Math.min(1, s.vis * 1.5);
    this.fishAttr.array[slot * 2 + 1] = f.seed;
  }

  private make(env: LifeEnv, grid: CellGrid, row: number, col: number, idx: number, centre: Vector3): School | null {
    const def = env.defs[idx]!;
    const home = groupHome(def, env.body.def.seed, idx, { row, col }, centre, grid, env.body.radius, env.probe, lifeSettings.density);
    if (!home) return null;
    const rnd = home.rnd;
    const anchor = new Anchor().set(home.dir);
    const site = env.probe.sample(centre.x, centre.y, centre.z, _site);
    const n = Math.max(12, Math.round(def.count * (0.4 + 0.6 * rnd())));
    const seed = Math.floor(rnd() * 1e9);
    const r = mulberry32(seed);
    const heading = r() * Math.PI * 2;
    const fish: Fish[] = [];
    for (let i = 0; i < n; i++) {
      const sx = (r() - 0.5) * 22;
      const sz = (r() - 0.5) * 9;
      fish.push({ x: sx, z: sz, heading, sx, sz, seed: r() });
    }
    return {
      dir: anchor.dir,
      def,
      anchor,
      fish,
      cx: 0,
      cz: 0,
      heading,
      speed: 2,
      dart: 1 + r() * 2,
      nextCheck: 0,
      seaY: site.height,
      alpha: 0.62 + 0.33 * Math.exp(-site.depth / 250),
      vis: 0,
      seed,
      rnd: r,
    };
  }
}
