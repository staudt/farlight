import { BufferAttribute, BufferGeometry, Group, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { FrameContext } from '../context';

const POINTS = 110;
const LIFE = 4;
const INTERVAL = LIFE / (POINTS - 2);
/** Wingtip points in ship space (matches shipModel). */
const TIPS: [number, number, number][] = [
  [11, -1.1, 8],
  [-11, -1.1, 8],
];

class Ribbon {
  readonly mesh: Mesh;
  private posAttr: BufferAttribute;
  private sideAttr: BufferAttribute;
  private alphaAttr: BufferAttribute;
  // Ring buffer, world float64.
  private wp = new Float64Array(POINTS * 3);
  private time = new Float64Array(POINTS);
  private strength = new Float32Array(POINTS);
  private head = 0;
  private count = 0;
  private lastPos = new Vector3();

  constructor() {
    const geo = new BufferGeometry();
    this.posAttr = new BufferAttribute(new Float32Array(POINTS * 2 * 3), 3);
    this.sideAttr = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    this.alphaAttr = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    this.posAttr.setUsage(35048);
    this.alphaAttr.setUsage(35048);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSide', this.sideAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    const idx: number[] = [];
    for (let k = 0; k < POINTS - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    for (let k = 0; k < POINTS; k++) {
      this.sideAttr.setX(k * 2, -1);
      this.sideAttr.setX(k * 2 + 1, 1);
    }
    const mat = new ShaderMaterial({
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSide;
        attribute float aAlpha;
        varying float vSide;
        varying float vAlpha;
        void main() {
          vSide = aSide;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Fade out close to the camera so the trail does not slap the lens.
          vAlpha = aAlpha * smoothstep(6.0, 45.0, length(mv.xyz));
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vSide;
        varying float vAlpha;
        void main() {
          #include <logdepthbuf_fragment>
          float soft = 1.0 - vSide * vSide;
          gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), vAlpha * soft * soft);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(ctx: FrameContext, tip: Vector3, strengthNow: number): void {
    const now = ctx.realTime;
    // A jump (teleport, scenario change) breaks the trail.
    if (this.count > 0 && this.lastPos.distanceToSquared(tip) > 500 * 500) this.count = 0;
    this.lastPos.copy(tip);
    const newest = (this.head + POINTS - 1) % POINTS;
    if (this.count === 0 || now - this.time[newest]! >= INTERVAL) {
      const h = this.head;
      this.wp[h * 3] = tip.x;
      this.wp[h * 3 + 1] = tip.y;
      this.wp[h * 3 + 2] = tip.z;
      this.time[h] = now;
      this.strength[h] = strengthNow;
      this.head = (h + 1) % POINTS;
      this.count = Math.min(POINTS - 1, this.count + 1);
    }

    // Gather live points newest first, with the live wingtip as point 0.
    const cam = ctx.cameraWorld;
    const pos = this.posAttr.array as Float32Array;
    const alpha = this.alphaAttr.array as Float32Array;
    let m = 0;
    const rel = _rel;
    const put = (x: number, y: number, z: number, age: number, str: number): void => {
      rel[m * 3] = x - cam.x;
      rel[m * 3 + 1] = y - cam.y;
      rel[m * 3 + 2] = z - cam.z;
      _age[m] = age;
      _str[m] = str;
      m++;
    };
    put(tip.x, tip.y, tip.z, 0, strengthNow);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + POINTS * 2) % POINTS;
      const age = now - this.time[idx]!;
      if (age >= LIFE) break;
      put(this.wp[idx * 3]!, this.wp[idx * 3 + 1]!, this.wp[idx * 3 + 2]!, age, this.strength[idx]!);
    }
    if (m < 2) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    for (let k = 0; k < m; k++) {
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(m - 1, k + 1);
      _t.set(rel[k1 * 3]! - rel[k0 * 3]!, rel[k1 * 3 + 1]! - rel[k0 * 3 + 1]!, rel[k1 * 3 + 2]! - rel[k0 * 3 + 2]!);
      _p.set(rel[k * 3]!, rel[k * 3 + 1]!, rel[k * 3 + 2]!);
      _s.crossVectors(_t, _p);
      if (_s.lengthSq() < 1e-12) _s.set(0, 1, 0);
      _s.normalize();
      const age = _age[k]!;
      const life = age / LIFE;
      const width = 0.25 + 3.2 * life;
      const a = _str[k]! * Math.pow(1 - life, 1.5) * 0.5 * Math.min(1, age * 6 + 0.25);
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        const o = (k * 2 + side) * 3;
        pos[o] = _p.x + _s.x * width * sgn;
        pos[o + 1] = _p.y + _s.y * width * sgn;
        pos[o + 2] = _p.z + _s.z * width * sgn;
        alpha[k * 2 + side] = a;
      }
    }
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (m - 1) * 6);
  }
}

const _rel = new Float64Array(POINTS * 3);
const _age = new Float64Array(POINTS);
const _str = new Float32Array(POINTS);
const _t = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _tip = new Vector3();

/** Soft white wingtip ribbons that appear in air at speed and widen as they age. */
export class Contrails {
  readonly object = new Group();
  private ribbons = [new Ribbon(), new Ribbon()];

  constructor() {
    for (const r of this.ribbons) this.object.add(r.mesh);
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    const density = w.env.density;
    const speed = w.ship.speed;
    const strength = smooth(0.05, 0.25, density) * smooth(60, 140, speed) * (w.ship.landed ? 0 : 1);
    for (let i = 0; i < 2; i++) {
      const t = TIPS[i]!;
      _tip.set(t[0], t[1], t[2]).applyQuaternion(w.shipWorldQuat).add(w.shipWorldPos);
      this.ribbons[i]!.update(ctx, _tip, strength);
    }
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
