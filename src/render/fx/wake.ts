import { BufferAttribute, BufferGeometry, Color, Group, Mesh, Points, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { config } from '../../core/config';
import { makeProbe } from '../life/env';
import type { SiteSample, SurfaceProbe } from '../life/spawn';
import type { Body } from '../../sim/universe';
import { starLight } from '../starLight';
import { waterLook } from '../bodies/waterWaves';
import type { FrameContext } from '../context';
import { quality } from '../quality';

/** Foam trail points: enough for the trail life at the emit interval. */
const POINTS = 170;
const MAX_PARTICLES = 3200;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const FOAM_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSide;
  attribute float aAlpha;
  attribute float aU;
  attribute float aAge;
  varying float vSide;
  varying float vAlpha;
  varying float vU;
  varying float vAge;
  void main() {
    vSide = aSide;
    vU = aU;
    vAge = aAge;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vAlpha = aAlpha * smoothstep(8.0, 40.0, length(mv.xyz));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const FOAM_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  varying float vSide;
  varying float vAlpha;
  varying float vU;
  varying float vAge;
  void main() {
    #include <logdepthbuf_fragment>
    float a = abs(vSide);
    // A V of foam: bright edges that spread with age, a streaky fill between them, a core near the ship.
    float edge = smoothstep(0.55, 0.82, a) * (1.0 - smoothstep(0.88, 1.0, a));
    float core = (1.0 - smoothstep(0.0, 0.35, a)) * (1.0 - vAge);
    float fill = 0.35 * (1.0 - a);
    float n = 0.5 + 0.5 * sin(vU * 0.37 + vSide * 9.0) * sin(vU * 0.11 - vSide * 5.0 + 2.0);
    float k = (edge * 0.9 + core * 0.8 + fill) * (0.45 + 0.75 * n);
    gl_FragColor = vec4(uColor, clamp(k, 0.0, 1.0) * vAlpha);
  }`;

const SPRAY_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPx;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 1.0);
    gl_PointSize = clamp(aSize * uPx * projectionMatrix[1][1] / d, 1.0, 220.0);
    vAlpha = aAlpha * smoothstep(4.0, 22.0, d);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const SPRAY_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float soft = exp(-d * d * 3.2) * (1.0 - smoothstep(0.7, 1.0, d));
    gl_FragColor = vec4(uColor, soft * vAlpha);
  }`;

const _l = new Vector3();
const _t = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _u = new Vector3();
const _r = new Vector3();
const _d = new Vector3();

class FoamTrail {
  readonly mesh: Mesh;
  readonly color = new Color(1, 1, 1);
  private pos: BufferAttribute;
  private side: BufferAttribute;
  private alpha: BufferAttribute;
  private uAttr: BufferAttribute;
  private ageAttr: BufferAttribute;
  // Ring buffer in body fixed meters (float64), with time, strength, speed and distance along the path.
  private lp = new Float64Array(POINTS * 3);
  private time = new Float64Array(POINTS);
  private str = new Float32Array(POINTS);
  private spd = new Float32Array(POINTS);
  private dist = new Float64Array(POINTS);
  private head = 0;
  private count = 0;
  private travelled = 0;
  private lastLocal = new Vector3();
  private rel = new Float64Array(POINTS * 3);
  private order = new Int32Array(POINTS);

  constructor() {
    const g = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(POINTS * 6), 3);
    this.side = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    this.alpha = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    this.uAttr = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    this.ageAttr = new BufferAttribute(new Float32Array(POINTS * 2), 1);
    for (const a of [this.pos, this.alpha, this.uAttr, this.ageAttr]) a.setUsage(35048);
    g.setAttribute('position', this.pos);
    g.setAttribute('aSide', this.side);
    g.setAttribute('aAlpha', this.alpha);
    g.setAttribute('aU', this.uAttr);
    g.setAttribute('aAge', this.ageAttr);
    const idx: number[] = [];
    for (let k = 0; k < POINTS - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    for (let k = 0; k < POINTS; k++) {
      this.side.setX(k * 2, -1);
      this.side.setX(k * 2 + 1, 1);
    }
    const mat = new ShaderMaterial({
      uniforms: { uColor: { value: this.color } },
      vertexShader: FOAM_VERT,
      fragmentShader: FOAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: 2,
    });
    this.mesh = new Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  reset(): void {
    this.count = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  /** `local` is the surface point under the ship (body fixed), null when not over water. */
  update(ctx: FrameContext, body: Body, local: Vector3 | null, strength: number, speed: number, life: number): void {
    const now = ctx.realTime;
    const interval = life / (POINTS - 2);
    if (local) {
      if (this.count > 0 && this.lastLocal.distanceToSquared(local) > 1500 * 1500) this.count = 0;
      const newest = (this.head + POINTS - 1) % POINTS;
      if (this.count === 0 || now - this.time[newest]! >= interval) {
        if (this.count > 0) this.travelled += this.lastLocal.distanceTo(local);
        this.lastLocal.copy(local);
        const h = this.head;
        this.lp[h * 3] = local.x;
        this.lp[h * 3 + 1] = local.y;
        this.lp[h * 3 + 2] = local.z;
        this.time[h] = now;
        this.str[h] = strength;
        this.spd[h] = speed;
        this.dist[h] = this.travelled;
        this.head = (h + 1) % POINTS;
        this.count = Math.min(POINTS - 1, this.count + 1);
      }
    }
    const pos = this.pos.array as Float32Array;
    const alpha = this.alpha.array as Float32Array;
    const ua = this.uAttr.array as Float32Array;
    const aa = this.ageAttr.array as Float32Array;
    const rel = this.rel;
    const cam = ctx.cameraWorld;
    // Body fixed to camera relative world (float64): body.position - camera + rot * local.
    const ox = body.position.x - cam.x;
    const oy = body.position.y - cam.y;
    const oz = body.position.z - cam.z;
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + POINTS * 2) % POINTS;
      const age = now - this.time[idx]!;
      if (age >= life) break;
      _l.set(this.lp[idx * 3]!, this.lp[idx * 3 + 1]!, this.lp[idx * 3 + 2]!).applyQuaternion(body.rotation);
      rel[m * 3] = _l.x + ox;
      rel[m * 3 + 1] = _l.y + oy;
      rel[m * 3 + 2] = _l.z + oz;
      this.order[m] = idx;
      m++;
    }
    if (m < 2) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    for (let k = 0; k < m; k++) {
      const idx = this.order[k]!;
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(m - 1, k + 1);
      _t.set(rel[k1 * 3]! - rel[k0 * 3]!, rel[k1 * 3 + 1]! - rel[k0 * 3 + 1]!, rel[k1 * 3 + 2]! - rel[k0 * 3 + 2]!);
      _p.set(rel[k * 3]!, rel[k * 3 + 1]!, rel[k * 3 + 2]!);
      // Surface normal: the direction from the body centre, in world.
      _u.set(this.lp[idx * 3]!, this.lp[idx * 3 + 1]!, this.lp[idx * 3 + 2]!).normalize().applyQuaternion(body.rotation);
      _s.crossVectors(_t, _u);
      if (_s.lengthSq() < 1e-12) _s.set(1, 0, 0);
      _s.normalize();
      const age = now - this.time[idx]!;
      const life01 = age / life;
      const width = 2.2 + age * (2.5 + this.spd[idx]! * 0.07) + life01 * 6;
      const a = this.str[idx]! * Math.pow(1 - life01, 1.4) * smooth(0, 0.12, age + 0.06);
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? -1 : 1;
        const o = (k * 2 + side) * 3;
        pos[o] = _p.x + _s.x * width * sgn + _u.x * 0.2;
        pos[o + 1] = _p.y + _s.y * width * sgn + _u.y * 0.2;
        pos[o + 2] = _p.z + _s.z * width * sgn + _u.z * 0.2;
        alpha[k * 2 + side] = a;
        ua[k * 2 + side] = this.dist[idx]!;
        aa[k * 2 + side] = life01;
      }
    }
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.uAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (m - 1) * 6);
  }
}

class Spray {
  readonly points: Points;
  readonly color = new Color(1, 1, 1);
  private pos = new Float64Array(MAX_PARTICLES * 3); // body fixed
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private age = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private size0 = new Float32Array(MAX_PARTICLES);
  private size1 = new Float32Array(MAX_PARTICLES);
  private alive = 0;
  private emitAcc = 0;
  private posA: BufferAttribute;
  private sizeA: BufferAttribute;
  private alphaA: BufferAttribute;
  private uPx = { value: 400 };
  private seed = 1234567;

  constructor() {
    const g = new BufferGeometry();
    this.posA = new BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.sizeA = new BufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.alphaA = new BufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    for (const a of [this.posA, this.sizeA, this.alphaA]) a.setUsage(35048);
    g.setAttribute('position', this.posA);
    g.setAttribute('aSize', this.sizeA);
    g.setAttribute('aAlpha', this.alphaA);
    g.setDrawRange(0, 0);
    const mat = new ShaderMaterial({
      uniforms: { uColor: { value: this.color }, uPx: this.uPx },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  private rnd(): number {
    // xorshift: deterministic and allocation free.
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed & 0xffffff) / 0xffffff;
  }

  clear(): void {
    this.alive = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  /** Emits and advances. `origin` is the sea point under the ship (body fixed). */
  update(ctx: FrameContext, body: Body, origin: Vector3 | null, up: Vector3, fwd: Vector3, strength: number, speed: number, cap: number): void {
    const dt = Math.min(ctx.realDt, 0.1);
    this.uPx.value = ctx.viewportHeight * 0.5;
    const grav = 11;
    // Advance, compacting the live ones.
    let n = 0;
    for (let i = 0; i < this.alive; i++) {
      const a = this.age[i]! + dt;
      if (a >= this.life[i]!) continue;
      const k = n++;
      if (k !== i) {
        for (let c = 0; c < 3; c++) {
          this.pos[k * 3 + c] = this.pos[i * 3 + c]!;
          this.vel[k * 3 + c] = this.vel[i * 3 + c]!;
        }
        this.life[k] = this.life[i]!;
        this.size0[k] = this.size0[i]!;
        this.size1[k] = this.size1[i]!;
      }
      this.age[k] = a;
      const r = Math.hypot(this.pos[k * 3]!, this.pos[k * 3 + 1]!, this.pos[k * 3 + 2]!) || 1;
      // Gravity toward the body centre, drag in the air.
      const drag = Math.exp(-1.4 * dt);
      for (let c = 0; c < 3; c++) {
        const pc = this.pos[k * 3 + c]!;
        const v = this.vel[k * 3 + c]! * drag - (pc / r) * grav * dt;
        this.vel[k * 3 + c] = v;
        this.pos[k * 3 + c] = pc + v * dt;
      }
    }
    this.alive = n;

    if (origin && strength > 0.01) {
      this.emitAcc += 2600 * Math.pow(strength, 1.3) * dt;
      const room = Math.min(cap, MAX_PARTICLES) - this.alive;
      let emit = Math.min(Math.floor(this.emitAcc), Math.max(0, room));
      this.emitAcc -= Math.floor(this.emitAcc);
      _r.crossVectors(fwd, up).normalize();
      const sp = Math.min(speed, 400);
      const big = config.water.spraySize;
      while (emit-- > 0) {
        const k = this.alive++;
        const side = this.rnd() * 2 - 1;
        const sgn = side < 0 ? -1 : 1;
        // Most of the mist is the ship's pressure wave: kicked up on the sea ahead and to both sides,
        // where the camera can see it rush past. The rest is the wake left behind.
        const bow = this.rnd() < 0.7;
        const lat = sgn * (4 + Math.abs(side) * (6 + sp * 0.07));
        const along = bow ? 12 + this.rnd() * (30 + sp * 0.3) : 6 - this.rnd() * (14 + sp * 0.03);
        const vy = 3 + this.rnd() * (4 + Math.min(28, sp * 0.11)) * strength;
        const vr = sgn * (3 + this.rnd() * (3 + 0.05 * sp));
        const vf = sp * (bow ? 0.05 + this.rnd() * 0.15 : 0.55 + this.rnd() * 0.3);
        this.pos[k * 3] = origin.x + up.x * 0.8 + _r.x * lat + fwd.x * along;
        this.pos[k * 3 + 1] = origin.y + up.y * 0.8 + _r.y * lat + fwd.y * along;
        this.pos[k * 3 + 2] = origin.z + up.z * 0.8 + _r.z * lat + fwd.z * along;
        this.vel[k * 3] = up.x * vy + _r.x * vr + fwd.x * vf;
        this.vel[k * 3 + 1] = up.y * vy + _r.y * vr + fwd.y * vf;
        this.vel[k * 3 + 2] = up.z * vy + _r.z * vr + fwd.z * vf;
        this.age[k] = 0;
        this.life[k] = 0.9 + this.rnd() * 1.5;
        this.size0[k] = (0.9 + this.rnd() * 1.3) * big;
        this.size1[k] = (2.6 + this.rnd() * 4 + sp * 0.015) * big;
      }
    } else {
      this.emitAcc = 0;
    }

    // Upload camera relative float32.
    const cam = ctx.cameraWorld;
    const ox = body.position.x - cam.x;
    const oy = body.position.y - cam.y;
    const oz = body.position.z - cam.z;
    const pa = this.posA.array as Float32Array;
    const sa = this.sizeA.array as Float32Array;
    const aa = this.alphaA.array as Float32Array;
    for (let i = 0; i < this.alive; i++) {
      _l.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!).applyQuaternion(body.rotation);
      pa[i * 3] = _l.x + ox;
      pa[i * 3 + 1] = _l.y + oy;
      pa[i * 3 + 2] = _l.z + oz;
      const t = this.age[i]! / this.life[i]!;
      sa[i] = this.size0[i]! + (this.size1[i]! - this.size0[i]!) * Math.sqrt(t);
      aa[i] = 0.9 * smooth(0, 0.08, t) * (1 - t) * (1 - t);
    }
    this.posA.needsUpdate = true;
    this.sizeA.needsUpdate = true;
    this.alphaA.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.alive);
  }
}

/**
 * Low flight over water: a foam V on the surface that follows the ground track (about 6 s) and a
 * spray of white mist thrown up behind the bow. Both live in body fixed float64 coordinates, so
 * they stay on the sea as the planet turns, and go camera relative at the render boundary.
 */
export class OceanWake {
  readonly object = new Group();
  private trail = new FoamTrail();
  private spray = new Spray();
  private probe: SurfaceProbe | null = null;
  private probeBody: string | null = null;
  private prevLocal = new Vector3();
  private hasPrev = false;
  private fwd = new Vector3(0, 0, -1);
  private local = new Vector3();
  private up = new Vector3(0, 1, 0);
  private origin = new Vector3();
  private trailPt = new Vector3();
  private sea = { water: false, height: 0 } as SiteSample;
  private qInv = new Quaternion();
  private sunV = new Vector3();
  private upW = new Vector3();

  constructor() {
    this.object.add(this.trail.mesh, this.spray.points);
  }

  update(ctx: FrameContext): void {
    const c = config.water;
    const w = ctx.world;
    const ship = w.ship;
    const body = ship.frame.body;
    const speed = ship.speed;
    const alt = w.env.altitude;
    const fx = Math.min(1, quality.settings.fxScale);
    const cap = Math.round(c.sprayMax * Math.max(0.3, fx));
    let strength = 0;
    let onWater = false;
    if (c.enabled && !ship.landed && body.kind === 'rocky' && body.def.terrain?.water && w.clock.warp <= 1 && alt < c.wakeAltitude * 1.2) {
      if (this.probeBody !== body.id) {
        this.probe = makeProbe(w, body);
        this.probeBody = body.id;
        this.trail.reset();
        this.spray.clear();
      }
      this.qInv.copy(body.rotation).invert();
      this.local.copy(w.shipWorldPos).sub(body.position).applyQuaternion(this.qInv);
      const r = this.local.length();
      this.up.copy(this.local).divideScalar(r || 1);
      this.probe!.sample(this.up.x, this.up.y, this.up.z, this.sea);
      onWater = this.sea.water;
      if (onWater) {
        const surfaceR = body.radius + this.sea.height;
        const h = r - surfaceR;
        strength = Math.min(1, smooth(c.wakeSpeedMin, c.wakeSpeedFull, speed) * (1 - smooth(c.wakeAltitude * 0.25, c.wakeAltitude, h)));
        this.origin.copy(this.up).multiplyScalar(surfaceR);
        if (this.hasPrev) {
          _d.copy(this.local).sub(this.prevLocal);
          _d.addScaledVector(this.up, -_d.dot(this.up));
          if (_d.lengthSq() > 1e-6) this.fwd.copy(_d).normalize();
        }
      }
      this.prevLocal.copy(this.local);
      this.hasPrev = true;
    } else {
      this.hasPrev = false;
    }
    const look = waterLook(body.def);
    // Daylight on the foam: sun elevation at the ship.
    this.sunV.copy(w.universe.root.position).sub(body.position).normalize();
    this.upW.copy(this.up).applyQuaternion(body.rotation);
    const day = smooth(-0.12, 0.25, this.sunV.dot(this.upW));
    const lit = 0.1 + 0.9 * day;
    const star = starLight.uniform.value;
    const tint = (col: Color): void => {
      col.setRGB(
        (0.55 + look.foamColor[0] * 0.45) * lit * star.x,
        (0.55 + look.foamColor[1] * 0.45) * lit * star.y,
        (0.55 + look.foamColor[2] * 0.45) * lit * star.z,
      );
    };
    tint(this.trail.color);
    tint(this.spray.color);
    this.trail.mesh.visible = c.enabled;
    this.spray.points.visible = c.enabled;
    this.trailPt.copy(this.origin).addScaledVector(this.fwd, 22);
    this.trail.update(ctx, body, onWater ? this.trailPt : null, strength, speed, c.wakeLife);
    this.spray.update(ctx, body, onWater ? this.origin : null, this.up, this.fwd, strength, speed, cap);
  }
}
