import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from 'three';
import { mulberry32 } from '../../core/rng';
import type { LifeDef } from '../../data/types';
import { quality } from '../quality';
import { Anchor, smoothstep, type LifeEnv } from './env';
import type { LifeLight } from './lifeLight';
import { lifeBudget, lifeSettings } from './settings';
import { CELL_SIZE, CellGrid, Spawner, groupHome } from './spawn';

const CELL = CELL_SIZE.fireflies;

const SPAWN = 450;
const DESPAWN = 650;
const MAX_MOTES = 800;

function material(light: LifeLight): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uPx: light.uniforms.uPx, uGlow: light.uniforms.uGlow },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aBright;
      attribute vec3 aColor;
      uniform float uPx;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 0.5);
        vAlpha = aBright * (1.0 - smoothstep(220.0, 420.0, dist));
        vColor = aColor;
        gl_PointSize = clamp(1.3 * uPx / dist, 3.0, 44.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uGlow;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        if (vAlpha <= 0.003) discard;
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.0);
        float core = smoothstep(0.35, 0.0, d);
        gl_FragColor = vec4((vColor * a + vec3(1.0, 0.95, 0.8) * core) * uGlow * 2.2, min(1.0, (a + core) * vAlpha * 1.4));
      }`,
  });
}

interface Mote {
  ox: number;
  oz: number;
  h: number;
  /** Ground height under the mote's home. */
  g: number;
  ax: number;
  ay: number;
  az: number;
  w: [number, number, number];
  p: [number, number, number];
  blinkW: number;
  blinkP: number;
}

interface Swarm {
  dir: Vector3;
  def: LifeDef;
  anchor: Anchor;
  motes: Mote[];
  vis: number;
}

const _p = new Vector3();
const _d = new Vector3();

/** Glowing motes drifting near the ground at night. */
export class Fireflies {
  readonly object: Points;
  private readonly pos: Float32Array;
  private readonly bright: Float32Array;
  private readonly col: Float32Array;
  private spawner: Spawner<Swarm> | null = null;
  private bodyId = '';
  private lastScan = -9;

  constructor(light: LifeLight) {
    const geo = new BufferGeometry();
    this.pos = new Float32Array(MAX_MOTES * 3);
    this.bright = new Float32Array(MAX_MOTES);
    this.col = new Float32Array(MAX_MOTES * 3);
    const pa = new BufferAttribute(this.pos, 3).setUsage(35048);
    const ba = new BufferAttribute(this.bright, 1).setUsage(35048);
    const ca = new BufferAttribute(this.col, 3).setUsage(35048);
    geo.setAttribute('position', pa);
    geo.setAttribute('aBright', ba);
    geo.setAttribute('aColor', ca);
    geo.setDrawRange(0, 0);
    this.object = new Points(geo, material(light));
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 12;
  }

  get swarms(): number {
    return this.spawner?.groups.size ?? 0;
  }

  get homes(): Vector3[] {
    return [...(this.spawner?.groups.values() ?? [])].map((g) => g.dir);
  }

  clear(): void {
    this.spawner?.clear();
    this.object.geometry.setDrawRange(0, 0);
    this.object.visible = false;
  }

  update(env: LifeEnv | null): void {
    const entries: number[] = [];
    if (env && lifeSettings.enabled && lifeSettings.fireflies) env.defs.forEach((d, i) => d.kind === 'fireflies' && entries.push(i));
    const budget = env ? lifeBudget(quality.settings.fxScale, lifeSettings.density) : null;
    if (!env || !budget || entries.length === 0 || budget.swarms === 0) {
      this.clear();
      return;
    }
    const maxAlt = Math.max(...entries.map((i) => env.defs[i]!.maxAlt));
    if (env.camAgl > maxAlt + 250) {
      this.clear();
      return;
    }
    const R = env.body.radius;
    if (env.body.id !== this.bodyId || !this.spawner) {
      this.bodyId = env.body.id;
      const grid = new CellGrid(CELL / R);
      this.spawner = new Spawner<Swarm>(grid, R, SPAWN, DESPAWN, (cell, idx, centre) => this.make(env, grid, cell.row, cell.col, idx, centre));
    }
    const sp = this.spawner;
    const gate = (d: LifeDef): number => (d.day ? env.daylight : d.night ? env.night : 1);
    if (env.time - this.lastScan > 0.25) {
      this.lastScan = env.time;
      sp.scan(
        env.camDir,
        entries.filter((i) => gate(env.defs[i]!) > 0.2),
        budget.swarms,
        5,
      );
    }
    const t = env.time;
    let n = 0;
    for (const [key, s] of sp.groups) {
      const target = gate(s.def);
      s.vis += (target - s.vis) * Math.min(1, env.dt * 0.6);
      if (target < 0.05 && s.vis < 0.03) {
        sp.forget(key);
        continue;
      }
      s.anchor.frame(env);
      const c = s.def.color;
      const gain = (s.def.glow ?? 2) * s.vis;
      const cnt = Math.min(s.motes.length, budget.motesPerSwarm);
      for (let i = 0; i < cnt && n < MAX_MOTES; i++) {
        const m = s.motes[i]!;
        s.anchor.pos(
          m.ox + m.ax * Math.sin(t * m.w[0] + m.p[0]),
          m.g + m.h + m.ay * Math.sin(t * m.w[1] + m.p[1]),
          m.oz + m.az * Math.sin(t * m.w[2] + m.p[2]),
          _p,
        );
        this.pos[n * 3] = _p.x;
        this.pos[n * 3 + 1] = _p.y;
        this.pos[n * 3 + 2] = _p.z;
        // Slow blinks, mostly dark with short bright pulses.
        const b = smoothstep(0.55, 0.95, Math.sin(t * m.blinkW + m.blinkP));
        this.bright[n] = (0.12 + 0.88 * b) * Math.min(1, s.vis * 1.4);
        this.col[n * 3] = c[0] * gain;
        this.col[n * 3 + 1] = c[1] * gain;
        this.col[n * 3 + 2] = c[2] * gain;
        n++;
      }
    }
    const geo = this.object.geometry;
    geo.setDrawRange(0, n);
    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aBright').needsUpdate = true;
    geo.getAttribute('aColor').needsUpdate = true;
    this.object.visible = n > 0;
  }

  private make(env: LifeEnv, grid: CellGrid, row: number, col: number, idx: number, centre: Vector3): Swarm | null {
    const def = env.defs[idx]!;
    const home = groupHome(def, env.body.def.seed, idx, { row, col }, centre, grid, env.body.radius, env.probe, lifeSettings.density);
    if (!home) return null;
    const rnd = home.rnd;
    const anchor = new Anchor().set(home.dir);
    const budget = lifeBudget(quality.settings.fxScale, lifeSettings.density);
    const n = Math.max(4, Math.min(budget.motesPerSwarm, Math.round(def.count * (0.5 + 0.5 * rnd()))));
    const r = mulberry32(Math.floor(rnd() * 1e9));
    const motes: Mote[] = [];
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 13;
      const ox = Math.cos(a) * d;
      const oz = Math.sin(a) * d;
      anchor.dirAt(ox, oz, env.body.radius, _d);
      motes.push({
        ox,
        oz,
        h: def.minAlt + r() * (def.maxAlt - def.minAlt),
        g: env.probe.ground(_d.x, _d.y, _d.z),
        ax: 1.5 + r() * 3,
        ay: 0.5 + r() * 1.2,
        az: 1.5 + r() * 3,
        w: [0.15 + r() * 0.35, 0.3 + r() * 0.5, 0.15 + r() * 0.35],
        p: [r() * 6.28, r() * 6.28, r() * 6.28],
        blinkW: 0.6 + r() * 0.9,
        blinkP: r() * 6.28,
      });
    }
    return { dir: anchor.dir, def, anchor, motes, vis: 0 };
  }
}
