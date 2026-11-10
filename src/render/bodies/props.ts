import {
  type BufferGeometry,
  BufferGeometry as Geometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  type IUniform,
  ShaderMaterial,
} from 'three';
import type { PropKind } from '../../data/types';
import type { PropBatch } from '../../terrain/props';
import { starLight } from '../starLight';

type V3 = [number, number, number];

/** Tiny non indexed mesh builder: position, base color, instance color mix, emissive weight. */
class Builder {
  pos: number[] = [];
  col: number[] = [];
  mix: number[] = [];
  emit: number[] = [];

  tri(a: V3, b: V3, c: V3, color: V3, mix: number, ea = 0, eb = 0, ec = 0, shade = 1): void {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(color[0] * shade, color[1] * shade, color[2] * shade);
    this.mix.push(mix, mix, mix);
    this.emit.push(ea, eb, ec);
  }

  build(): BufferGeometry {
    const g = new Geometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMix', new Float32BufferAttribute(this.mix, 1));
    g.setAttribute('aEmit', new Float32BufferAttribute(this.emit, 1));
    return g;
  }
}

function hash01(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const WHITE: V3 = [1, 1, 1];
const BARK: V3 = [0.22, 0.14, 0.09];

/** Ring of `seg` points at height y, radius r, rotated by `rot`, optional center offset. */
function ring(seg: number, y: number, r: number, rot: number, ox = 0, oz = 0, jitter = 0, seed = 0): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = rot + (i / seg) * Math.PI * 2;
    const rr = r * (1 + (hash01(seed, i, Math.round(y * 100)) - 0.5) * jitter);
    out.push([ox + Math.cos(a) * rr, y, oz + Math.sin(a) * rr]);
  }
  return out;
}

/** Side band between two rings, plus an optional top (fan to `apex`) or flat cap. */
function band(b: Builder, lo: V3[], hi: V3[], color: V3, mix: number, shade = 1, emitHi = 0): void {
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const s = shade * (0.94 + 0.12 * hash01(i, Math.round(lo[0]![1] * 100), n));
    b.tri(lo[i]!, hi[j]!, hi[i]!, color, mix, 0, emitHi, emitHi, s);
    b.tri(lo[i]!, lo[j]!, hi[j]!, color, mix, 0, 0, emitHi, s);
  }
}

function cap(b: Builder, rg: V3[], center: V3, color: V3, mix: number, up: boolean, shade = 1, emit = 0): void {
  const n = rg.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (up) b.tri(rg[i]!, center, rg[j]!, color, mix, emit, emit, emit, shade);
    else b.tri(rg[i]!, rg[j]!, center, color, mix, emit, emit, emit, shade);
  }
}

function cone(b: Builder, y0: number, y1: number, r0: number, seg: number, rot: number, color: V3, mix: number, shade: number, ox = 0, oz = 0, jitter = 0, seed = 0, emitTip = 0): void {
  const base = ring(seg, y0, r0, rot, ox, oz, jitter, seed);
  const apex: V3 = [ox, y1, oz];
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const s = shade * (0.93 + 0.14 * hash01(seed, i, seg));
    b.tri(base[i]!, apex, base[j]!, color, mix, 0, emitTip, 0, s);
  }
  cap(b, base, [ox, y0, oz], color, mix, false, shade * 0.6);
}

function conifer(): BufferGeometry {
  const b = new Builder();
  band(b, ring(5, 0, 0.034, 0.3), ring(5, 0.2, 0.026, 0.3), BARK, 0);
  const tiers: [number, number, number, number][] = [
    [0.1, 0.5, 0.31, 0.82],
    [0.32, 0.76, 0.24, 0.92],
    [0.56, 1.0, 0.16, 1.02],
  ];
  tiers.forEach(([y0, y1, r, sh], i) => cone(b, y0, y1, r, 7, i * 0.55, WHITE, 1, sh, 0, 0, 0.12, 40 + i));
  return b.build();
}

function icoBlob(b: Builder, cx: number, cy: number, cz: number, r: number, squashY: number, seed: number, mix: number, jitter: number, color: V3 = WHITE): void {
  const g = new IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  const vtx: V3[] = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Jitter is keyed to the position so shared corners move together.
    const k = hash01(Math.round(x * 100) + seed, Math.round(y * 100), Math.round(z * 100));
    const s = r * (1 + (k - 0.5) * jitter);
    vtx.push([cx + x * s, cy + y * s * squashY, cz + z * s]);
  }
  for (let i = 0; i < vtx.length; i += 3) {
    const a = vtx[i]!;
    const bb = vtx[i + 1]!;
    const c = vtx[i + 2]!;
    const h = (a[1] + bb[1] + c[1]) / 3 - cy;
    const shade = 0.78 + 0.34 * Math.min(1, Math.max(0, (h / (r * squashY) + 1) / 2));
    b.tri(a, bb, c, color, mix, 0, 0, 0, shade);
  }
  g.dispose();
}

function broadleaf(): BufferGeometry {
  const b = new Builder();
  band(b, ring(5, 0, 0.045, 0.2), ring(5, 0.5, 0.032, 0.2), BARK, 0);
  icoBlob(b, 0, 0.64, 0, 0.36, 0.95, 3, 1, 0.3);
  icoBlob(b, 0.17, 0.5, 0.1, 0.22, 0.9, 11, 1, 0.3, [0.92, 0.95, 0.9]);
  return b.build();
}

function rock(): BufferGeometry {
  const b = new Builder();
  // Squashed, lumpy icosahedron resting on the ground.
  icoBlob(b, 0, 0.3, 0, 0.5, 0.62, 29, 1, 0.55, [0.95, 0.95, 0.95]);
  return b.build();
}

function spire(): BufferGeometry {
  const b = new Builder();
  const seg = 5;
  const lo = ring(seg, 0, 0.13, 0.1, 0, 0, 0.3, 5);
  const mid = ring(seg, 0.5, 0.07, 0.4, 0.02, 0, 0.2, 6);
  band(b, lo, mid, WHITE, 1, 0.9);
  cone(b, 0.5, 1, 0.07, seg, 0.4, WHITE, 1, 1.05, 0.02, 0);
  // A shorter companion needle.
  const lo2 = ring(4, 0, 0.07, 0.8, 0.12, 0.07, 0.2, 9);
  const hi2 = ring(4, 0.28, 0.04, 0.8, 0.13, 0.07, 0.1, 10);
  band(b, lo2, hi2, WHITE, 1, 0.85);
  cone(b, 0.28, 0.55, 0.04, 4, 0.8, WHITE, 1, 1.0, 0.13, 0.07);
  return b.build();
}

function crystal(): BufferGeometry {
  const b = new Builder();
  const prisms: [number, number, number, number, number][] = [
    // x, z, height, radius, lean (x offset of the tip)
    [0, 0, 1.0, 0.1, 0.03],
    [0.14, 0.05, 0.65, 0.07, 0.1],
    [-0.12, 0.08, 0.55, 0.06, -0.08],
    [0.04, -0.14, 0.5, 0.06, 0.02],
    [-0.06, -0.1, 0.38, 0.045, -0.06],
  ];
  const tint: V3 = [0.9, 0.95, 1];
  prisms.forEach(([x, z, h, r, lean], i) => {
    const lo = ring(6, 0, r, i * 0.4, x, z);
    const mid = ring(6, h * 0.7, r * 0.85, i * 0.4, x + lean * 0.7, z);
    const tip: V3 = [x + lean, h, z];
    band(b, lo, mid, tint, 1, 0.8, 0.5);
    for (let k = 0; k < 6; k++) b.tri(mid[k]!, tip, mid[(k + 1) % 6]!, tint, 1, 0.8, 1, 0.8, 1.05);
  });
  return b.build();
}

function mesa(): BufferGeometry {
  const b = new Builder();
  const seg = 8;
  const talus = ring(seg, 0, 1.5, 0.2, 0, 0, 0.18, 21);
  const foot = ring(seg, 0.34, 1.02, 0.2, 0, 0, 0.14, 22);
  const lip = ring(seg, 0.9, 0.92, 0.2, 0, 0, 0.12, 23);
  const top = ring(seg, 1.0, 0.86, 0.2, 0, 0, 0.1, 24);
  band(b, talus, foot, WHITE, 1, 1.12);
  band(b, foot, lip, WHITE, 1, 0.8);
  band(b, lip, top, WHITE, 1, 0.98);
  cap(b, top, [0, 1, 0], WHITE, 1, true, 1.12);
  cap(b, talus, [0, 0, 0], WHITE, 1, false, 0.5);
  return b.build();
}

const BUILDERS: Record<PropKind, (() => BufferGeometry)[]> = {
  tree: [conifer, broadleaf],
  rock: [rock],
  spire: [spire],
  crystal: [crystal],
  mesa: [mesa],
};

const cache = new Map<string, BufferGeometry>();

/** One shared geometry per kind and variant. */
export function propGeometry(kind: PropKind, variant: number): BufferGeometry {
  const key = `${kind}:${variant}`;
  let g = cache.get(key);
  if (!g) {
    const list = BUILDERS[kind];
    g = list[Math.min(variant, list.length - 1)]!();
    cache.set(key, g);
  }
  return g;
}

/**
 * Flat shaded prop material. `shared` carries the terrain material uniforms (sun, body center,
 * sky ambient) by reference, so the planet view updates both with one write.
 */
export function createPropMaterial(shared: Record<string, IUniform>, bioGlow = 0): ShaderMaterial {
  return new ShaderMaterial({
    side: 2,
    uniforms: {
      uSunDirView: shared.uSunDirView!,
      uBodyCenterView: shared.uBodyCenterView!,
      uSkyAmbient: shared.uSkyAmbient!,
      uSunIntensity: shared.uSunIntensity!,
      uStarColor: starLight.uniform,
      uFadeNear: { value: 900 },
      uFadeFar: { value: 1900 },
      uEmissive: { value: 2.2 },
      /** Night glow weight of the instance colour (bioluminescence), per material. */
      uBioGlow: { value: bioGlow },
      uNightGlow: { value: 1 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aColor;
      attribute float aMix;
      attribute float aEmit;
      uniform float uFadeNear;
      uniform float uFadeFar;
      varying vec3 vColor;
      varying vec3 vViewPos;
      varying float vEmit;
      varying float vMix;
      varying vec3 vInst;
      void main() {
        mat4 mvi = modelViewMatrix * instanceMatrix;
        // Distance fade: props shrink into the ground instead of popping.
        float d = length(mvi[3].xyz);
        float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, d);
        vec3 inst = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          inst = instanceColor;
        #endif
        vInst = inst;
        vColor = aColor * mix(vec3(1.0), inst, aMix);
        vEmit = aEmit;
        vMix = aMix;
        vec4 mv = mvi * vec4(position * fade, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDirView;
      uniform vec3 uBodyCenterView;
      uniform vec3 uSkyAmbient;
      uniform float uSunIntensity;
      uniform vec3 uStarColor;
      uniform float uEmissive;
      uniform float uBioGlow;
      uniform float uNightGlow;
      varying vec3 vColor;
      varying vec3 vViewPos;
      varying float vEmit;
      varying float vMix;
      varying vec3 vInst;
      void main() {
        #include <logdepthbuf_fragment>
        // Flat normal from screen derivatives: it already faces the camera.
        vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
        vec3 L = normalize(uSunDirView);
        vec3 R = normalize(vViewPos - uBodyCenterView);
        float sunR = dot(R, L);
        float term = smoothstep(-0.10, 0.22, sunR);
        float lam = clamp(dot(N, L), 0.0, 1.0);
        float diffuse = lam * term;
        vec3 sunCol = mix(vec3(1.0, 0.5, 0.25), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.45, sunR));
        float skyTerm = 0.35 + 0.65 * clamp(dot(N, R), 0.0, 1.0);
        vec3 amb = (vec3(0.05) + uSkyAmbient * skyTerm * (0.25 + 0.75 * term)) * mix(vec3(1.0), uStarColor, 0.6);
        vec3 col = vColor * (sunCol * uStarColor * uSunIntensity * diffuse + amb);
        // Crystal glow: brighter at night, still readable by day.
        col += vInst * vEmit * uEmissive * (0.35 + 0.65 * (1.0 - term)) * uNightGlow;
        // Bioluminescence: the tinted parts (foliage, not bark) glow once the sun is down.
        float night = 1.0 - smoothstep(-0.14, 0.04, sunR);
        col += vInst * vMix * uBioGlow * night * uNightGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Builds the instanced meshes for one chunk's prop batches (children of the chunk mesh). */
function releaseArray(this: InstancedBufferAttribute): void {
  (this as unknown as { array: null }).array = null;
}

export function createPropMeshes(batches: readonly PropBatch[], materialFor: (batch: PropBatch) => ShaderMaterial): InstancedMesh[] {
  const out: InstancedMesh[] = [];
  for (const b of batches) {
    if (b.count === 0) continue;
    const m = new InstancedMesh(propGeometry(b.kind, b.variant), materialFor(b), b.count);
    m.instanceMatrix = new InstancedBufferAttribute(b.matrices, 16);
    m.instanceColor = new InstancedBufferAttribute(b.colors, 3);
    m.matrixAutoUpdate = false;
    m.name = `props:${b.kind}`;
    m.computeBoundingSphere(); // frustum culling needs it, and the arrays go after upload
    m.instanceMatrix.onUpload(releaseArray);
    m.instanceColor.onUpload(releaseArray);
    out.push(m);
  }
  return out;
}

export function disposePropMeshes(meshes: readonly InstancedMesh[]): void {
  // Geometry and material are shared: only the per mesh instance buffers go.
  for (const m of meshes) {
    m.parent?.remove(m);
    m.dispose();
  }
}
