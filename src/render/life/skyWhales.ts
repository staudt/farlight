import { BufferGeometry, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, ShaderMaterial, Vector3 } from 'three';
import type { LifeDef } from '../../data/types';
import { quality } from '../quality';
import { Anchor, hash01, smoothstep, writeBasis, type LifeEnv } from './env';
import { LIFE_LIGHT_GLSL, type LifeLight } from './lifeLight';
import { lifeBudget, lifeSettings } from './settings';
import { CELL_SIZE, CellGrid, Spawner, groupHome } from './spawn';

const CELL = CELL_SIZE.skyWhales;

const SPAWN = 15000;
const DESPAWN = 19000;
const FADE_NEAR = 10500;
const FADE_FAR = 14500;
const MAX_WHALES = 24;
const RINGS = 14;
const SIDES = 8;

type V3 = [number, number, number];

/**
 * Sky whale geometry: length 1 along z (head at -0.5), a flattened spindle with belly lights,
 * two long pectoral fins, a small dorsal fin and tail flukes. The shader undulates tail and fins.
 */
export function whaleGeometry(): BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tail: number[] = [];
  const glow: number[] = [];
  const tone: number[] = [];
  const tri = (a: V3, b: V3, c: V3, t: number, wa = 0, wb = 0, wc = 0, ga = 0, gb = ga, gc = ga): void => {
    pos.push(...a, ...b, ...c);
    tone.push(t, t, t);
    wing.push(wa, wb, wc);
    glow.push(ga, gb, gc);
    for (const v of [a, b, c]) {
      const u = Math.min(1, Math.max(0, (v[2] + 0.5 - 0.15) / 0.85));
      tail.push(wa || wb || wc ? 0 : u * u);
    }
  };
  const profile = (t: number): number => {
    const t0 = 0.26;
    if (t < t0) return Math.sqrt(Math.max(0, 1 - ((t0 - t) / t0) ** 2));
    return 1 - 0.88 * Math.pow((t - t0) / (1 - t0), 0.9);
  };
  const ring = (i: number): V3[] => {
    const t = i / RINGS;
    const r = 0.105 * profile(t);
    const z = -0.5 + t * 0.94;
    const out: V3[] = [];
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      out.push([Math.cos(a) * r * 1.2, Math.sin(a) * r * 0.82, z]);
    }
    return out;
  };
  let prev = ring(0);
  for (let i = 1; i <= RINGS; i++) {
    const cur = ring(i);
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      const a = (k + 0.5) / SIDES;
      // Angle zero is +x; the belly is the lower half (sin < 0).
      const belly = Math.sin(a * Math.PI * 2) < -0.2;
      const t = belly ? 1.0 : 0.62 + 0.25 * Math.max(0, Math.sin(a * Math.PI * 2));
      // Stripes of lights along the belly and flanks, every third ring.
      const spot = belly && i % 3 === 1 ? 1 : 0;
      const side = Math.abs(Math.cos(a * Math.PI * 2)) > 0.8 && i % 4 === 2 ? 0.7 : 0;
      const g = Math.max(spot, side);
      tri(prev[k]!, cur[k]!, cur[k2]!, t, 0, 0, 0, g);
      tri(prev[k]!, cur[k2]!, prev[k2]!, t, 0, 0, 0, g);
    }
    prev = cur;
  }
  // Pectoral fins.
  for (const s of [-1, 1]) {
    const z0 = -0.5 + 0.3 * 0.94;
    const rf: V3 = [s * 0.1, -0.025, z0 - 0.07];
    const rb: V3 = [s * 0.1, -0.025, z0 + 0.09];
    const mf: V3 = [s * 0.27, 0.0, z0 + 0.0];
    const mb: V3 = [s * 0.27, 0.0, z0 + 0.14];
    const tp: V3 = [s * 0.46, 0.03, z0 + 0.27];
    tri(rf, mf, rb, 0.9, 0, 0.5, 0, 0, 0.3, 0);
    tri(mf, mb, rb, 0.8, 0.5, 0.5, 0, 0.3, 0.3, 0);
    tri(mf, tp, mb, 0.95, 0.5, 1, 0.5, 0.3, 1, 0.3);
  }
  // Dorsal fin.
  tri([0, 0.085, -0.04], [0, 0.17, 0.08], [0, 0.07, 0.1], 0.6, 0, 0, 0, 0, 0.6, 0);
  // Tail flukes.
  const zt = -0.5 + 0.94;
  const c: V3 = [0, 0, zt - 0.03];
  const notch: V3 = [0, 0, zt + 0.09];
  tri(c, [-0.17, 0.0, zt + 0.1], notch, 0.85, 0, 1, 0.5, 0, 1, 0);
  tri(c, notch, [0.17, 0.0, zt + 0.1], 0.85, 0, 0.5, 1, 0, 0, 1);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new Float32BufferAttribute(wing, 1));
  g.setAttribute('aTail', new Float32BufferAttribute(tail, 1));
  g.setAttribute('aGlow', new Float32BufferAttribute(glow, 1));
  g.setAttribute('aTone', new Float32BufferAttribute(tone, 1));
  return g;
}

function whaleMaterial(light: LifeLight): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...light.uniforms },
    transparent: true,
    depthWrite: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aWing;
      attribute float aTail;
      attribute float aGlow;
      attribute float aTone;
      attribute vec4 aLife;
      uniform float uTime;
      varying vec3 vViewPos;
      varying vec3 vColor;
      varying float vGlow;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        vec3 p = position;
        float ph = uTime * 0.75 + aLife.z * 30.0;
        p.y += sin(ph - p.z * 6.0) * 0.04 * aTail;
        p.x += sin(ph * 0.7 - p.z * 5.0 + 1.0) * 0.012 * aTail;
        p.y += aWing * sin(ph * 0.9 - aWing * 1.6) * 0.085;
        vec3 inst = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          inst = instanceColor;
        #endif
        vColor = inst * aTone;
        vGlow = aGlow;
        vAlpha = aLife.y;
        vSeed = aLife.z;
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
      varying float vGlow;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        vec3 V = normalize(-vViewPos);
        float rim = 1.0 - abs(dot(N, V));
        vec3 col = lifeLit(vColor, N) + vColor * 0.12;
        float pulse = 0.7 + 0.3 * sin(uTime * 1.1 + vSeed * 40.0 + vViewPos.z * 0.004);
        vec3 emit = mix(vColor, vec3(1.0), 0.25) * 2.4;
        col += emit * vGlow * uGlow * (0.12 + 1.5 * uNight) * pulse;
        col += vColor * rim * rim * 0.25 * (0.3 + 0.7 * uSunElev);
        float a = mix(0.72, 0.97, rim * rim) * vAlpha * smoothstep(40.0, 220.0, length(vViewPos));
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** The draws that decide a pod's size, height and heading (shared with scenarios). */
export function whalePlan(def: LifeDef, rnd: () => number, maxPerPod: number): { n: number; baseAgl: number; lead: number } {
  const n = Math.max(1, Math.min(maxPerPod, 1 + Math.floor(rnd() * def.count)));
  const baseAgl = def.minAlt + rnd() * (def.maxAlt - def.minAlt) * 0.5;
  const lead = rnd() * Math.PI * 2;
  return { n, baseAgl, lead };
}

interface Whale {
  x: number;
  z: number;
  /** Meters above the body radius. */
  y: number;
  heading: number;
  speed: number;
  /** Wanted height over the ground. */
  agl: number;
  bank: number;
  /** Vertical speed shown as pitch. */
  climb: number;
  size: number;
  seed: number;
}

interface Pod {
  dir: Vector3;
  def: LifeDef;
  anchor: Anchor;
  whales: Whale[];
  ground: number;
  nextGround: number;
  vis: number;
  seed: number;
}

const _p = new Vector3();
const _d = new Vector3();

/** A few huge, slow, translucent creatures drifting high above the ground. */
export class SkyWhales {
  readonly object: InstancedMesh;
  private readonly lifeAttr: InstancedBufferAttribute;
  private readonly colors: Float32Array;
  private readonly matrices: Float32Array;
  private spawner: Spawner<Pod> | null = null;
  private bodyId = '';
  private lastScan = -9;

  constructor(light: LifeLight) {
    const geo = whaleGeometry();
    this.lifeAttr = new InstancedBufferAttribute(new Float32Array(MAX_WHALES * 4), 4);
    this.lifeAttr.setUsage(35048);
    geo.setAttribute('aLife', this.lifeAttr);
    this.object = new InstancedMesh(geo, whaleMaterial(light), MAX_WHALES);
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    this.object.renderOrder = 6;
    this.object.instanceMatrix.setUsage(35048);
    this.matrices = this.object.instanceMatrix.array as Float32Array;
    this.object.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_WHALES * 3), 3);
    this.colors = this.object.instanceColor.array as Float32Array;
  }

  get pods(): number {
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
    if (env && lifeSettings.enabled && lifeSettings.skyWhales) env.defs.forEach((d, i) => d.kind === 'skyWhales' && entries.push(i));
    const budget = env ? lifeBudget(quality.settings.fxScale, lifeSettings.density) : null;
    if (!env || !budget || entries.length === 0 || budget.pods === 0) {
      this.clear();
      return;
    }
    const maxAlt = Math.max(...entries.map((i) => env.defs[i]!.maxAlt));
    if (env.camAgl > maxAlt + SPAWN) {
      this.clear();
      return;
    }
    const R = env.body.radius;
    if (env.body.id !== this.bodyId || !this.spawner) {
      this.bodyId = env.body.id;
      const grid = new CellGrid(CELL / R);
      this.spawner = new Spawner<Pod>(grid, R, SPAWN, DESPAWN, (cell, idx, centre) => this.make(env, grid, cell.row, cell.col, idx, centre));
    }
    const sp = this.spawner;
    const gate = (d: LifeDef): number => (d.day ? env.daylight : d.night ? env.night : 1);
    if (env.time - this.lastScan > 0.5) {
      this.lastScan = env.time;
      sp.scan(
        env.camDir,
        entries.filter((i) => gate(env.defs[i]!) > 0.15),
        budget.pods,
        3,
      );
    }

    let n = 0;
    for (const [key, pod] of sp.groups) {
      const target = gate(pod.def);
      pod.vis += (target - pod.vis) * Math.min(1, env.dt * 0.5);
      if (target < 0.05 && pod.vis < 0.03) {
        sp.forget(key);
        continue;
      }
      pod.anchor.frame(env);
      if (env.time >= pod.nextGround) {
        pod.nextGround = env.time + 1.5;
        this.sampleGround(env, pod);
      }
      this.move(env, pod);
      for (const w of pod.whales) {
        if (n >= MAX_WHALES || n >= budget.pods * budget.whalesPerPod) break;
        this.write(pod, w, n++);
      }
    }
    this.object.count = n;
    this.object.visible = n > 0;
    this.object.instanceMatrix.needsUpdate = true;
    this.object.instanceColor!.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
  }

  private sampleGround(env: LifeEnv, pod: Pod): void {
    let cx = 0;
    let cz = 0;
    for (const w of pod.whales) {
      cx += w.x;
      cz += w.z;
    }
    cx /= pod.whales.length;
    cz /= pod.whales.length;
    pod.anchor.dirAt(cx, cz, env.body.radius, _d);
    pod.ground = env.probe.ground(_d.x, _d.y, _d.z);
  }

  private move(env: LifeEnv, pod: Pod): void {
    const dt = env.dt;
    const t = env.time;
    let cx = 0;
    let cz = 0;
    for (const w of pod.whales) {
      cx += w.x;
      cz += w.z;
    }
    cx /= pod.whales.length;
    cz /= pod.whales.length;
    for (const w of pod.whales) {
      // A lazy wander, with a pull back toward the pod when it strays.
      let turn = 0.018 * Math.sin(t * 0.07 + w.seed * 40) + 0.01 * Math.sin(t * 0.031 + w.seed * 11);
      const dx = cx - w.x;
      const dz = cz - w.z;
      const away = Math.hypot(dx, dz);
      if (away > 700) {
        let diff = Math.atan2(dz, dx) - w.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        turn += Math.max(-0.05, Math.min(0.05, diff * 0.05));
      }
      w.heading += turn * dt * lifeSettings.whaleSpeed;
      w.bank += (-turn * 30 - w.bank) * Math.min(1, dt * 0.5);
      const s = w.speed * lifeSettings.whaleSpeed;
      w.x += Math.cos(w.heading) * s * dt;
      w.z += Math.sin(w.heading) * s * dt;
      const wantY = Math.max(pod.ground + 900, pod.ground + w.agl + 70 * Math.sin(t * 0.05 + w.seed * 20));
      w.climb = Math.max(-1.5, Math.min(1.5, (wantY - w.y) * 0.02));
      w.y += (wantY - w.y) * Math.min(1, dt * 0.15);
    }
    // Keep the tangent frame close to the pod.
    if (Math.hypot(cx, cz) > 500) {
      pod.anchor.shift(cx, cz, env.body.radius);
      for (const w of pod.whales) {
        w.x -= cx;
        w.z -= cz;
      }
      pod.anchor.frame(env);
    }
  }

  private write(pod: Pod, w: Whale, slot: number): void {
    const a = pod.anchor;
    a.pos(w.x, w.y, w.z, _p);
    const dist = _p.length();
    const alpha = (1 - smoothstep(FADE_NEAR, FADE_FAR, dist)) * Math.min(1, pod.vis * 1.4);
    const sp = w.speed;
    const vx = Math.cos(w.heading) * sp;
    const vz = Math.sin(w.heading) * sp;
    const vy = w.climb;
    const fx = a.we.x * vx + a.wu.x * vy + a.ws.x * vz;
    const fy = a.we.y * vx + a.wu.y * vy + a.ws.y * vz;
    const fz = a.we.z * vx + a.wu.z * vy + a.ws.z * vz;
    const l = Math.hypot(fx, fy, fz) || 1;
    const sz = w.size;
    writeBasis(this.matrices, slot, _p.x, _p.y, _p.z, fx / l, fy / l, fz / l, a.wu.x, a.wu.y, a.wu.z, w.bank, sz, sz, sz);
    const c = pod.def.color;
    this.colors[slot * 3] = c[0];
    this.colors[slot * 3 + 1] = c[1];
    this.colors[slot * 3 + 2] = c[2];
    const o = slot * 4;
    this.lifeAttr.array[o] = 0;
    this.lifeAttr.array[o + 1] = alpha;
    this.lifeAttr.array[o + 2] = w.seed;
    this.lifeAttr.array[o + 3] = 0;
  }

  private make(env: LifeEnv, grid: CellGrid, row: number, col: number, idx: number, centre: Vector3): Pod | null {
    const def = env.defs[idx]!;
    const home = groupHome(def, env.body.def.seed, idx, { row, col }, centre, grid, env.body.radius, env.probe, lifeSettings.density);
    if (!home) return null;
    const rnd = home.rnd;
    const anchor = new Anchor().set(home.dir);
    anchor.dirAt(0, 0, env.body.radius, _d);
    const ground = env.probe.ground(_d.x, _d.y, _d.z);
    const budget = lifeBudget(quality.settings.fxScale, lifeSettings.density);
    const plan = whalePlan(def, rnd, budget.whalesPerPod);
    const { n, baseAgl, lead } = plan;
    const whales: Whale[] = [];
    for (let i = 0; i < n; i++) {
      const seed = rnd();
      const agl = baseAgl + (rnd() - 0.5) * 700;
      whales.push({
        x: (i === 0 ? 0 : (rnd() - 0.5) * 1500),
        z: (i === 0 ? 0 : (rnd() - 0.5) * 1500),
        y: ground + agl,
        heading: lead + (rnd() - 0.5) * 0.5,
        speed: 6 + rnd() * 3,
        agl,
        bank: 0,
        climb: 0,
        size: def.size * (i === 0 ? 1 : 0.65 + 0.3 * hash01(Math.floor(seed * 1e6))),
        seed,
      });
    }
    return { dir: anchor.dir, def, anchor, whales, ground, nextGround: 0, vis: 0, seed: rnd() };
  }
}
