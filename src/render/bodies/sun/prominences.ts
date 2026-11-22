import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import { type ProminenceArc, prominenceArcs } from './starLook';

/** Ribbon samples along an arc, strands per arc. */
const SEGS = 28;
const STRANDS = 3;
const VERTS_PER_STRAND = (SEGS + 1) * 2;
const INDEX_PER_ARC = STRANDS * SEGS * 6;

/**
 * Prominence arcs: a few loops of glowing plasma standing on the limb. Each arc is a handful of
 * ribbon strands along a great circle bulging out from the surface. The ribbons are billboarded in
 * the vertex shader (widened across the view), additive, with flowing brightness. Geometry is in sun
 * radii, so the mesh is scaled by the disc radius.
 */
export class Prominences {
  readonly mesh: Mesh;
  private readonly geo = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  readonly arcs: ProminenceArc[];

  constructor(seed: number, maxArcs: number, color: Color) {
    this.arcs = prominenceArcs(seed, maxArcs);
    const nv = maxArcs * STRANDS * VERTS_PER_STRAND;
    const pos = new Float32Array(nv * 3);
    const tan = new Float32Array(nv * 3);
    // x: position along the arc 0..1, y: side -1 or 1, z: strand seed, w: arc phase.
    const par = new Float32Array(nv * 4);
    const idx = new Uint32Array(maxArcs * INDEX_PER_ARC);
    const c = new Vector3();
    const t = new Vector3();
    const ax = new Vector3();
    const p = new Vector3();
    const p2 = new Vector3();
    const p3 = new Vector3();
    let v = 0;
    let ii = 0;
    this.arcs.forEach((arc, ai) => {
      c.fromArray(arc.centre);
      t.fromArray(arc.tangent);
      for (let s = 0; s < STRANDS; s++) {
        const k = s / (STRANDS - 1) - 0.5;
        // Strands share the feet loosely and differ in height and span.
        const span = arc.span * (1 + k * 0.25);
        const height = arc.height * (1 + k * 0.35);
        const shift = k * arc.width * 3;
        ax.crossVectors(c, t).normalize();
        const base = v;
        const at = (u: number, out: Vector3): void => {
          const th = (u - 0.5) * span;
          const h = Math.pow(Math.sin(Math.PI * u), 0.85) * height;
          out.copy(c).multiplyScalar(Math.cos(th)).addScaledVector(t, Math.sin(th)).addScaledVector(ax, shift * Math.sin(Math.PI * u));
          out.normalize().multiplyScalar(0.995 + h);
        };
        for (let i = 0; i <= SEGS; i++) {
          const u = i / SEGS;
          at(u, p);
          // Tangent from the centre line a little either side, clamped at the feet.
          at(Math.min(1, u + 0.02), p2);
          at(Math.max(0, u - 0.02), p3);
          const d = p2.sub(p3).normalize();
          for (let side = -1; side <= 1; side += 2) {
            pos.set([p.x, p.y, p.z], v * 3);
            tan.set([d.x, d.y, d.z], v * 3);
            par.set([u, side, s + ai * 3.7, arc.phase], v * 4);
            v++;
          }
        }
        for (let i = 0; i < SEGS; i++) {
          const a = base + i * 2;
          idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], ii);
          ii += 6;
        }
      }
    });
    this.geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.geo.setAttribute('aTan', new BufferAttribute(tan, 3));
    this.geo.setAttribute('aPar', new BufferAttribute(par, 4));
    this.geo.setIndex(new BufferAttribute(idx, 1));
    this.mat = new ShaderMaterial({
      uniforms: { uColor: { value: color }, uTime: { value: 0 }, uAmount: { value: 1 }, uScale: { value: 1 }, uArcs: { value: maxArcs } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aTan;
        attribute vec4 aPar;
        uniform float uTime, uScale;
        varying vec3 vData;
        void main() {
          float u = aPar.x;
          float life = 0.78 + 0.22 * sin(uTime * 0.17 + aPar.w * 3.0);
          vec3 pos = position;
          // The loop breathes: it rises and settles over tens of seconds.
          pos *= 1.0 + (length(pos) - 1.0) * (life - 1.0) / max(length(pos), 0.001);
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          vec3 tv = normalize(mat3(modelViewMatrix) * aTan);
          vec3 view = normalize(mv.xyz);
          vec3 side = cross(tv, view);
          float sl = length(side);
          side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
          float prof = 0.45 + 0.55 * sin(3.14159 * u);
          float w = 0.045 * (0.7 + 0.5 * fract(aPar.z * 0.37)) * prof * uScale * (0.85 + 0.3 * sin(uTime * 0.31 + aPar.z * 2.0));
          mv.xyz += side * aPar.y * w;
          // Blobs of brighter plasma run along the strand.
          float flow = 0.65 + 0.35 * sin(u * 14.0 - uTime * 0.9 + aPar.z * 5.0);
          vData = vec3(aPar.y, flow * pow(sin(3.14159 * u), 0.6), life);
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uAmount;
        varying vec3 vData;
        void main() {
          #include <logdepthbuf_fragment>
          float x = vData.x;
          float prof = exp(-x * x * 2.4);
          float core = exp(-x * x * 12.0);
          vec3 col = uColor * (prof * 1.0 + core * 0.7) * vData.y * vData.z * uAmount;
          gl_FragColor = vec4(col, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    this.mat.uniforms.uScale!.value = 1;
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  /** Draws only the first `n` arcs. */
  setCount(n: number): void {
    const c = Math.max(0, Math.min(this.arcs.length, Math.floor(n)));
    this.geo.setDrawRange(0, c * INDEX_PER_ARC);
    this.mesh.visible = c > 0;
  }

  update(time: number, amount: number, discRadius: number): void {
    const u = this.mat.uniforms;
    u.uTime!.value = time;
    u.uAmount!.value = amount;
    // The ribbon width is added in view space, so it needs the sphere scale.
    u.uScale!.value = discRadius;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
