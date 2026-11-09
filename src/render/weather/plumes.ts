import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/rng';
import type { RGB, WeatherDef, WeatherKind } from '../../data/types';
import { findEffect } from '../../data/types';
import type { Body } from '../../sim/universe';
import { latLonToDir } from '../../terrain/api';
import { type TerrainSampler, createHeightSampler, makeSample } from '../../terrain/heightfield';
import { type FrameContext, placeRelative } from '../context';
import { quality } from '../quality';
import { starLight } from '../starLight';
import { dustDevilSettings, geyserSettings, plumeSettings } from './settings';
import { smooth } from './weatherMap';

/**
 * Tall translucent columns standing on the ground: volcanic umbrella plumes, water vapour
 * geysers and dust devils. One lathe mesh whose profile and noise come from uniforms, plus a
 * point cloud of grains that arc up and fall back. All three are placed with the floating
 * origin (`placeRelative`) on top of the real terrain height.
 */

const SEG_A = 48;
const SEG_H = 44;
const MAX_GRAINS = 220;

type Look = 'volcano' | 'geyser' | 'devil';

interface Style {
  look: Look;
  /** Stem width at the base and the top, as a fraction of the plume width. */
  stem: [number, number];
  /** Umbrella or bloom: amplitude, centre and width along the height. */
  cap: [number, number, number];
  skirt: number;
  sway: number;
  twist: number;
  rise: number;
  opacity: number;
  /** Width as a fraction of the height. */
  widthPerHeight: number;
  /** Self lit fraction (shadow side brightness). */
  ambient: number;
  /** Height fraction over which the foot fades in. */
  baseFade: number;
  sparkle: number;
  grainSize: number;
  grains: number;
}

const STYLES: Record<Look, Style> = {
  volcano: { look: 'volcano', stem: [0.1, 0.2], cap: [1.0, 0.86, 0.075], skirt: 0.32, sway: 0.04, twist: 0.4, rise: 0.35, opacity: 0.5, widthPerHeight: 0.62, ambient: 0.32, baseFade: 0.2, sparkle: 0, grainSize: 0.012, grains: 200 },
  geyser: { look: 'geyser', stem: [0.1, 0.07], cap: [0.55, 0.8, 0.16], skirt: 0.55, sway: 0.07, twist: 0, rise: 0.6, opacity: 0.8, widthPerHeight: 0.22, ambient: 0.55, baseFade: 0.04, sparkle: 1, grainSize: 0.012, grains: 150 },
  devil: { look: 'devil', stem: [0.07, 0.42], cap: [0, 0.5, 0.2], skirt: 0.5, sway: 0.1, twist: 1, rise: 0.5, opacity: 0.85, widthPerHeight: 0.3, ambient: 0.6, baseFade: 0.1, sparkle: 0, grainSize: 0.02, grains: 90 },
};

const NOISE3 = /* glsl */ `
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { return n3(p) * 0.55 + n3(p * 2.07 + 3.1) * 0.3 + n3(p * 4.3 + 7.7) * 0.15; }
`;

function makeColumnGeometry(): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= SEG_H; j++) {
    const t = j / SEG_H;
    for (let i = 0; i <= SEG_A; i++) {
      const a = (i / SEG_A) * Math.PI * 2;
      pos.push(Math.cos(a), t, Math.sin(a));
    }
  }
  const row = SEG_A + 1;
  for (let j = 0; j < SEG_H; j++) {
    for (let i = 0; i < SEG_A; i++) {
      const a = j * row + i;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function makeGrainGeometry(seed: number): BufferGeometry {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(MAX_GRAINS * 3);
  const rand = new Float32Array(MAX_GRAINS * 4);
  for (let i = 0; i < MAX_GRAINS; i++) {
    for (let k = 0; k < 4; k++) rand[i * 4 + k] = rnd();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aRand', new Float32BufferAttribute(rand, 4));
  return g;
}

const COLUMN_GEO = makeColumnGeometry();
const GRAIN_GEO = makeGrainGeometry(404);

const COMMON_UNIFORMS = () => ({
  uH: { value: 1000 },
  uW: { value: 200 },
  uTime: { value: 0 },
  uSeed: { value: 0 },
  uStem: { value: [0.1, 0.2] as unknown as { x: number; y: number } },
  uCap: { value: new Vector3(1, 0.86, 0.075) },
  uSkirt: { value: 0.3 },
  uSway: { value: 0.05 },
  uTwist: { value: 0 },
  uRise: { value: 0.4 },
  uLook: { value: 0 },
  uFade: { value: 1 },
  uColor: { value: new Vector3(1, 1, 1) },
  uGlow: { value: new Vector3(0, 0, 0) },
  uOpacity: { value: 0.6 },
  uAmbient: { value: 0.4 },
  uSparkle: { value: 0 },
  uBaseFade: { value: 0.05 },
  uSunLocal: { value: new Vector3(0, 1, 0) },
  uStarColor: starLight.uniform,
});

function makeColumnMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: COMMON_UNIFORMS(),
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uH, uW, uTime, uSeed, uSkirt, uSway;
      uniform vec2 uStem;
      uniform vec3 uCap;
      varying vec3 vP;
      varying float vT;
      varying vec3 vN;
      varying vec3 vNV;
      varying vec3 vView;
      void main() {
        float t = position.y;
        float a = atan(position.z, position.x);
        float cap = uCap.x * exp(-pow((t - uCap.y) / uCap.z, 2.0));
        float stem = mix(uStem.x, uStem.y, t);
        float skirt = uSkirt * exp(-t * 14.0);
        float dome = sqrt(max(0.0, 1.0 - pow(max(0.0, (t - 0.93) / 0.07), 2.0)));
        float r = (stem * (1.0 - smoothstep(0.9, 1.0, t)) + cap) * dome + skirt;
        r *= 1.0 + 0.16 * sin(a * 3.0 + t * 6.0 + uSeed * 9.0 - uTime * 0.35) + 0.08 * sin(a * 7.0 - t * 11.0 + uTime * 0.5);
        float ph = uSeed * 6.0;
        vec2 sway = uSway * t * vec2(sin(t * 3.1 + uTime * 0.45 + ph), cos(t * 2.3 + uTime * 0.37 + ph));
        vec3 local = vec3(cos(a) * r + sway.x, t * uH / uW, sin(a) * r + sway.y);
        vP = local;
        vT = t;
        vN = normalize(vec3(cos(a), 0.35, sin(a)));
        vNV = normalMatrix * vN;
        vec4 mv = modelViewMatrix * vec4(local * uW, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uSeed, uRise, uTwist, uFade, uOpacity, uAmbient, uSparkle, uLook, uBaseFade;
      uniform vec3 uColor, uGlow, uSunLocal, uStarColor;
      varying vec3 vP;
      varying float vT;
      varying vec3 vN;
      varying vec3 vNV;
      varying vec3 vView;
      ${NOISE3}
      void main() {
        #include <logdepthbuf_fragment>
        float rot = uTwist * (uTime * 1.3 - vT * 6.0);
        float cs = cos(rot), sn = sin(rot);
        vec2 q = mat2(cs, -sn, sn, cs) * vP.xz;
        vec3 np = vec3(q.x * 2.2, vP.y * 1.5 - uTime * uRise, q.y * 2.2) + uSeed * 31.0;
        float n = fbm3(np);
        float view = abs(dot(normalize(vNV), normalize(vView)));
        float body = smoothstep(0.28, 0.72, n + 0.18 * (view - 0.5));
        float alpha = uOpacity * body * (0.3 + 0.7 * pow(view, 0.6));
        alpha *= smoothstep(0.0, uBaseFade, vT) * (1.0 - smoothstep(0.9, 1.0, vT)) * uFade;
        float ndl = dot(normalize(vN), uSunLocal) * 0.5 + 0.5;
        float lit = mix(uAmbient, 1.0, ndl * ndl * (3.0 - 2.0 * ndl));
        vec3 col = uColor * uStarColor * lit * (0.6 + 0.5 * n);
        // Hot vent glow at the foot.
        col += uGlow * exp(-vT * 7.0) * (0.6 + n);
        // Ice crystals catching the sun.
        float tw = pow(h3(floor(np * 6.0) + floor(uTime * 4.0)), 14.0);
        col += uSparkle * tw * vec3(2.2, 2.3, 2.5) * (0.4 + ndl);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

function makeGrainMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...COMMON_UNIFORMS(), uPx: { value: 800 }, uGrain: { value: 0.01 }, uSpread: { value: 1 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec4 aRand;
      uniform float uH, uW, uTime, uSeed, uPx, uGrain, uLook, uTwist, uFade;
      varying float vA;
      varying float vR;
      void main() {
        float rate = 0.07 + 0.08 * aRand.x;
        float u = fract(uTime * rate + aRand.y * 7.31 + uSeed);
        float phi = aRand.z * 6.2831 + (uLook > 1.5 ? u * 7.0 * uTwist : 0.0);
        float spread = uW * (0.25 + 0.9 * aRand.w);
        vec3 local;
        float arc = 4.0 * u * (1.0 - u);
        if (uLook > 1.5) {
          // Dust devil: grains spiral up the column.
          float rr = uW * (0.2 + 0.7 * u) * (0.5 + aRand.w);
          local = vec3(cos(phi) * rr, u * uH, sin(phi) * rr);
        } else if (uLook > 0.5) {
          // Geyser: droplets leave the vent and arc back down.
          local = vec3(cos(phi) * spread * u * 1.4, arc * uH * (0.35 + 0.65 * aRand.x), sin(phi) * spread * u * 1.4);
        } else {
          // Volcano: ejecta thrown out of the umbrella, falling back.
          float top = 0.7 + 0.3 * aRand.x;
          local = vec3(cos(phi) * spread * (0.2 + u * 1.3), uH * (top - (top + 0.05) * u * u), sin(phi) * spread * (0.2 + u * 1.3));
        }
        vec4 mv = modelViewMatrix * vec4(local, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = uGrain * (0.6 + aRand.x) * uPx / max(-mv.z, 1.0);
        gl_PointSize = clamp(size, 1.5, 26.0);
        vA = uFade * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.75, 1.0, u)) * (0.5 + 0.5 * aRand.w);
        vR = aRand.x;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor, uStarColor, uGlow;
      uniform float uSparkle, uAmbient;
      varying float vA;
      varying float vR;
      void main() {
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float soft = 1.0 - smoothstep(0.3, 1.0, d);
        if (vA * soft < 0.004) discard;
        vec3 col = uColor * uStarColor * (0.6 + 0.4 * vR) + uGlow * 0.4 + uSparkle * vec3(1.4, 1.5, 1.7) * step(0.7, vR);
        gl_FragColor = vec4(col, vA * soft * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** One standing column with its grains. */
class Column {
  readonly group = new Group();
  readonly mesh: Mesh;
  readonly points: Points;
  readonly meshMat = makeColumnMaterial();
  readonly grainMat = makeGrainMaterial();
  /** Body fixed direction of the foot. */
  readonly dir = new Vector3();
  /** Foot height above the base radius, game meters. */
  groundHeight = 0;
  height = 1;
  width = 1;
  seed = 0;
  fade = 1;
  readonly look: Look;
  /** Set per frame: does it draw. */
  get shown(): boolean {
    return this.group.visible;
  }

  constructor(look: Look, seed: number, color: RGB, glow: RGB) {
    this.look = look;
    this.seed = seed;
    const st = STYLES[look];
    this.mesh = new Mesh(COLUMN_GEO, this.meshMat);
    this.points = new Points(GRAIN_GEO, this.grainMat);
    for (const o of [this.mesh, this.points]) {
      o.frustumCulled = false;
      o.renderOrder = 9;
    }
    this.group.add(this.mesh, this.points);
    this.group.visible = false;
    for (const m of [this.meshMat, this.grainMat]) {
      const u = m.uniforms;
      u.uStem!.value = { x: st.stem[0], y: st.stem[1] };
      (u.uCap!.value as Vector3).set(st.cap[0], st.cap[1], st.cap[2]);
      u.uSkirt!.value = st.skirt;
      u.uSway!.value = st.sway;
      u.uTwist!.value = st.twist;
      u.uRise!.value = st.rise;
      u.uOpacity!.value = st.opacity;
      u.uAmbient!.value = st.ambient;
      u.uSparkle!.value = st.sparkle;
      u.uBaseFade!.value = st.baseFade;
      u.uLook!.value = look === 'volcano' ? 0 : look === 'geyser' ? 1 : 2;
      u.uSeed!.value = seed;
      (u.uColor!.value as Vector3).set(color[0], color[1], color[2]);
      (u.uGlow!.value as Vector3).set(glow[0], glow[1], glow[2]);
    }
  }

  /** Positions the column on the body and feeds the per frame uniforms. */
  place(ctx: FrameContext, body: Body, sun: Vector3, scratch: Vector3, q: Quaternion, intensity: number, px: number): void {
    scratch.copy(this.dir).applyQuaternion(body.rotation); // world direction of the foot
    const r = body.radius + this.groundHeight;
    _foot.copy(body.position).addScaledVector(scratch, r);
    placeRelative(this.group, _foot, ctx.cameraWorld);
    this.group.quaternion.setFromUnitVectors(_Y, scratch);
    // Sun direction in the column's own frame (local up = surface normal).
    _sunL.copy(sun).applyQuaternion(q.copy(this.group.quaternion).invert());
    const dist = this.group.position.length();
    const pulse = this.look === 'volcano' ? 0.88 + 0.12 * Math.sin(ctx.realTime * 0.23 + this.seed * 20) : 1;
    const h = this.height * pulse;
    const st = STYLES[this.look];
    const grainN = Math.round(st.grains * quality.settings.fxScale);
    GRAIN_GEO.setDrawRange(0, Math.min(MAX_GRAINS, grainN));
    for (const m of [this.meshMat, this.grainMat]) {
      const u = m.uniforms;
      u.uH!.value = h;
      u.uW!.value = this.width;
      u.uTime!.value = ctx.realTime + this.seed * 97;
      u.uFade!.value = this.fade * intensity;
      (u.uSunLocal!.value as Vector3).copy(_sunL);
    }
    this.grainMat.uniforms.uPx!.value = px;
    this.grainMat.uniforms.uGrain!.value = Math.max(2, this.width * st.grainSize * 3 * (this.look === 'devil' ? 0.7 : 1));
    this.group.visible = dist < this.height * 90 && this.fade * intensity > 0.01 && grainN > 0;
  }
}

const _Y = new Vector3(0, 1, 0);
const _foot = new Vector3();
const _sunL = new Vector3();

function hash01(n: number): number {
  let h = Math.imul(n | 0, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Seeded vent positions (body fixed unit directions, no polar caps). Shared with scenarios. */
export function geyserSites(bodySeed: number, count: number): { dir: Vector3; seed: number }[] {
  const rnd = mulberry32(bodySeed ^ 0x9e3779b1);
  const out: { dir: Vector3; seed: number }[] = [];
  for (let i = 0; i < count; i++) {
    const seed = rnd();
    const y = rnd() * 1.7 - 0.85;
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(1 - y * y);
    out.push({ dir: new Vector3(rr * Math.cos(a), y, rr * Math.sin(a)), seed });
  }
  return out;
}

/** Dust devil cell size, game meters. */
const DEVIL_CELL = 3000;

/**
 * Devils live on a body fixed 3D grid: each cell may host one that wanders slowly inside it.
 * Returns the ones around `local` (a body fixed unit direction), nearest first, with ground
 * distance `d` in meters. Shared with scenarios, which aim the camera at one.
 */
export function devilSites(radius: number, local: Vector3, t: number, cell = DEVIL_CELL): { d: number; dir: Vector3; seed: number }[] {
  const cx = Math.floor((local.x * radius) / cell);
  const cy = Math.floor((local.y * radius) / cell);
  const cz = Math.floor((local.z * radius) / cell);
  const cands: { d: number; dir: Vector3; seed: number }[] = [];
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ix = cx + i;
        const iy = cy + j;
        const iz = cz + k;
        const id = ix * 73856093 + iy * 19349663 + iz * 83492791;
        if (hash01(id) > 0.4) continue;
        // Wander on a slow lissajous inside the cell.
        const ph = hash01(id + 5) * 40;
        const px0 = (ix + 0.5 + (hash01(id + 1) - 0.5) * 0.6 + 0.12 * Math.sin(t * 0.012 + ph)) * cell;
        const py0 = (iy + 0.5 + (hash01(id + 2) - 0.5) * 0.6 + 0.12 * Math.cos(t * 0.01 + ph)) * cell;
        const pz0 = (iz + 0.5 + (hash01(id + 3) - 0.5) * 0.6 + 0.12 * Math.sin(t * 0.009 + ph * 1.7)) * cell;
        // Cells whose centre is far from the surface shell mostly miss it.
        if (Math.abs(Math.hypot(px0, py0, pz0) - radius) > cell * 0.8) continue;
        const dir = new Vector3(px0, py0, pz0).normalize();
        cands.push({ d: Math.acos(Math.min(1, dir.dot(local))) * radius, dir, seed: hash01(id + 9) });
      }
    }
  }
  return cands.sort((x, y) => x.d - y.d);
}

interface BodyPlumes {
  body: Body;
  kind: WeatherKind;
  def: WeatherDef;
  columns: Column[];
  settings: { enabled: boolean; intensity: number; height: number };
  sampler: TerrainSampler | null;
  /** Dust devils wander; the others stand still. */
  roaming: boolean;
}

/** Every plume, geyser and dust devil in the system, driven by the bodies' effect data. */
export class SurfacePlumes {
  readonly object = new Group();
  private sets: BodyPlumes[] = [];
  private scratch = new Vector3();
  private sun = new Vector3();
  private q = new Quaternion();
  private cam = new Vector3();
  private sample = makeSample();
  private tmp = new Vector3();

  constructor(bodies: readonly Body[]) {
    for (const body of bodies) {
      const volcano = findEffect(body.def, 'volcanicPlume');
      const geyser = findEffect(body.def, 'geyser');
      const devil = findEffect(body.def, 'dustDevil');
      if (volcano) this.addVolcanoes(body, volcano);
      if (geyser) this.addGeysers(body, geyser);
      if (devil) this.addDevils(body, devil);
    }
  }

  private colors(body: Body, def: WeatherDef, fallback: RGB): { color: RGB; glow: RGB } {
    const mie = body.def.atmosphere?.mieColor;
    return { color: def.color ?? (def.kind === 'dustDevil' && mie ? mie : fallback), glow: [0, 0, 0] };
  }

  private sampler(set: BodyPlumes): TerrainSampler | null {
    if (!set.sampler && set.body.def.terrain) set.sampler = createHeightSampler(set.body.def, set.body.radius);
    return set.sampler;
  }

  private groundAt(set: BodyPlumes, dir: Vector3): number {
    const s = this.sampler(set);
    if (!s) return 0;
    return s.sample(dir.x, dir.y, dir.z, this.sample).height;
  }

  private addVolcanoes(body: Body, def: WeatherDef): void {
    const vols = (body.def.terrain?.features ?? []).filter((f) => f.kind === 'volcano');
    if (!vols.length) return;
    const { color } = this.colors(body, def, [0.7, 0.8, 1]);
    const glow: RGB = [0.5 * color[0], 0.25 * color[1], 0.12 * color[2]];
    const set: BodyPlumes = { body, kind: 'volcanicPlume', def, columns: [], settings: plumeSettings, sampler: null, roaming: false };
    vols.forEach((f, i) => {
      const c = new Column('volcano', hash01(body.def.seed * 13 + i), color, glow);
      latLonToDir(f.lat, f.lon, c.dir);
      c.groundHeight = this.groundAt(set, c.dir);
      c.fade = 1;
      set.columns.push(c);
      this.object.add(c.group);
    });
    this.sets.push(set);
  }

  private addGeysers(body: Body, def: WeatherDef): void {
    const color: RGB = def.color ?? [0.92, 0.96, 1];
    const set: BodyPlumes = { body, kind: 'geyser', def, columns: [], settings: geyserSettings, sampler: null, roaming: false };
    for (const g of geyserSites(body.def.seed, def.count ?? 5)) {
      const c = new Column('geyser', g.seed, color, [0, 0, 0]);
      c.dir.copy(g.dir);
      c.groundHeight = this.groundAt(set, c.dir);
      set.columns.push(c);
      this.object.add(c.group);
    }
    this.sets.push(set);
  }

  private addDevils(body: Body, def: WeatherDef): void {
    const color: RGB = def.color ?? body.def.atmosphere?.mieColor ?? [0.75, 0.55, 0.4];
    const set: BodyPlumes = { body, kind: 'dustDevil', def, columns: [], settings: dustDevilSettings, sampler: null, roaming: true };
    // The lit-from-below dust is a bit darker than the sky haze that carries the same hue.
    const dust: RGB = [color[0] * 0.5, color[1] * 0.38, color[2] * 0.28];
    for (let i = 0; i < 5; i++) {
      const c = new Column('devil', hash01(i + 1), dust, [0, 0, 0]);
      set.columns.push(c);
      this.object.add(c.group);
    }
    this.sets.push(set);
  }

  /** Columns drawn this frame (debug). */
  get shown(): number {
    let n = 0;
    for (const s of this.sets) for (const c of s.columns) if (c.shown) n++;
    return n;
  }

  update(ctx: FrameContext): void {
    const cam = ctx.cameraWorld;
    const px = (ctx.viewportHeight * ctx.renderer.getPixelRatio()) / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
    for (const set of this.sets) {
      const body = set.body;
      const s = set.settings;
      const dist = body.position.distanceTo(cam);
      const r = (set.def.size ?? 0.1) * body.radius * s.height;
      const near = dist < body.radius + r * 70 + body.radius * 3;
      if (!s.enabled || !near) {
        for (const c of set.columns) c.group.visible = false;
        continue;
      }
      this.sun.copy(ctx.world.universe.root.position).sub(body.position).normalize();
      const intensity = Math.min(1.3, set.def.intensity * s.intensity);
      if (set.roaming) {
        this.updateDevils(ctx, set, intensity, px);
        continue;
      }
      for (const c of set.columns) {
        c.height = r * (0.6 + 0.5 * hash01(c.seed * 1000 + 3));
        c.width = c.height * STYLES[c.look].widthPerHeight;
        c.place(ctx, body, this.sun, this.scratch, this.q, intensity, px);
      }
    }
  }

  /** Devils live on a body fixed grid; the nearest few stand up and wander within their cell. */
  private updateDevils(ctx: FrameContext, set: BodyPlumes, intensity: number, px: number): void {
    const body = set.body;
    const CELL = DEVIL_CELL;
    this.cam.copy(ctx.cameraWorld).sub(body.position);
    const alt = this.cam.length() - body.radius;
    for (const c of set.columns) c.group.visible = false;
    if (alt > 12000) return;
    const up = this.cam.normalize();
    const sunDot = up.dot(this.sun);
    const day = smooth(0.08, 0.4, sunDot);
    if (day <= 0) return;
    const local = body.worldToLocalDir(up, this.tmp);
    const t = ctx.simTime;
    const cands = devilSites(body.radius, local, t, CELL);
    const h = (set.def.size ?? 0.0012) * body.radius * set.settings.height;
    for (let i = 0; i < set.columns.length && i < cands.length; i++) {
      const c = set.columns[i]!;
      const cand = cands[i]!;
      c.dir.copy(cand.dir);
      c.groundHeight = this.groundAt(set, c.dir);
      c.seed = cand.seed;
      c.height = h * (0.6 + 0.8 * cand.seed);
      c.width = c.height * STYLES.devil.widthPerHeight;
      c.fade = day * (1 - smooth(CELL * 0.55, CELL * 1.35, cand.d)) * smooth(40, 200, cand.d);
      c.place(ctx, body, this.sun, this.scratch, this.q, intensity, px);
    }
  }
}
