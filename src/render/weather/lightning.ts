import { AdditiveBlending, BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { mulberry32 } from '../../core/rng';
import type { Body } from '../../sim/universe';
import type { WeatherDef } from '../../data/types';
import { placeRelative, type FrameContext } from '../context';
import type { PostStack } from '../post';
import { lightningSettings } from './settings';
import { weatherAmount } from './weatherMap';

const MAX_SEGMENTS = 900;
const RANGE_TO_LAYER = 200_000;
const STRIKE_RADIUS = 40_000;
const FLASH_TIME = 0.45;
const BOLT_TIME = 0.22;

/** Lightning: cloud flashes (via the cloud effect) and the occasional visible bolt. */
export class Lightning {
  readonly object: LineSegments;
  /** Called with the distance from the camera to the strike, in meters (for thunder). */
  onStrike?: (distanceMeters: number) => void;

  private rnd = mulberry32(77);
  private geometry = new BufferGeometry();
  private positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private material: ShaderMaterial;

  private nextIn = 6;
  private lastSim = NaN;
  private flashT = Infinity;
  private pulses: { t: number; a: number }[] = [];
  private boltT = Infinity;
  private boltBody: Body | null = null;
  private boltGround = new Vector3();
  private cur: FrameContext | null = null;
  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private dirLocal = new Vector3();

  constructor(private post: PostStack) {
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(35048));
    this.geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      uniforms: { uColor: { value: new Vector3(5, 6.5, 10) }, uAlpha: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uAlpha;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(uColor * uAlpha, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.object = new LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 11;
  }

  /** Debug: strike now, ahead of the camera, ignoring weather and latitude. */
  strikeNow(distance = 14_000): void {
    const ctx = this.cur;
    if (!ctx) return;
    const body = this.findBody(ctx)?.body ?? this.anyBody(ctx);
    if (!body) return;
    const fwd = this.tmp2.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    this.strikeAt(ctx, body, fwd, distance, true);
  }

  /** Debug: stops the strike envelopes from advancing (for screenshots). */
  freeze = false;

  update(ctx: FrameContext): void {
    this.cur = ctx;
    const dt = this.freeze ? 0 : ctx.realDt;

    // Flash envelope.
    if (this.flashT < FLASH_TIME) {
      this.flashT += dt;
      let e = 0;
      for (const p of this.pulses) {
        const x = this.flashT - p.t;
        if (x >= 0) e = Math.max(e, p.a * Math.exp(-x * 16) * Math.min(1, x * 80));
      }
      this.post.clouds.flash = this.flashT >= FLASH_TIME ? 0 : e * lightningSettings.flashStrength;
    } else if (this.post.clouds.flash !== 0) {
      this.post.clouds.flash = 0;
    }

    // Bolt mesh.
    if (this.boltT < BOLT_TIME && this.boltBody) {
      this.boltT += dt;
      const b = this.boltBody;
      this.tmp.copy(this.boltGround).applyQuaternion(b.rotation).add(b.position);
      placeRelative(this.object, this.tmp, ctx.cameraWorld);
      this.object.quaternion.copy(b.rotation);
      const f = 1 - this.boltT / BOLT_TIME;
      const flicker = 0.55 + 0.45 * Math.sin(this.boltT * 140);
      this.material.uniforms.uAlpha!.value = Math.max(0, f) * flicker;
      this.object.visible = this.boltT < BOLT_TIME;
    } else if (this.object.visible) {
      this.object.visible = false;
    }

    if (!lightningSettings.enabled) return;
    const found = this.findBody(ctx);
    if (!found) return;
    const { body, def } = found;

    const simDt = Number.isNaN(this.lastSim) ? 0 : Math.max(0, ctx.simTime - this.lastSim);
    this.lastSim = ctx.simTime;
    // Warp speeds the storm up, but never into a strobe.
    this.nextIn -= Math.min(simDt, dt * 6);
    if (this.nextIn > 0) return;
    const rate = Math.max(0.1, (0.4 + def.intensity) * lightningSettings.intensity);
    this.nextIn = (3 + this.rnd() * 9) / rate;

    // Find a spot inside a storm cell. Retry a few times, otherwise skip this round.
    const up = this.tmp2.copy(ctx.cameraWorld).sub(body.position).normalize();
    for (let i = 0; i < 8; i++) {
      const a = this.rnd() * Math.PI * 2;
      const d = Math.sqrt(this.rnd()) * STRIKE_RADIUS;
      const east = _east.set(0, 1, 0).cross(up);
      if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      const north = _north.crossVectors(up, east);
      _dir.copy(east).multiplyScalar(Math.cos(a)).addScaledVector(north, Math.sin(a));
      const strikeUp = _su.copy(up).addScaledVector(_dir, d / body.radius).normalize();
      body.worldToLocalDir(strikeUp, this.dirLocal);
      if (weatherAmount(def, this.dirLocal, ctx.simTime, body) > 0.12) {
        this.strikeAt(ctx, body, _dir, d, false);
        return;
      }
    }
    this.nextIn = 1 + this.rnd() * 2;
  }

  private anyBody(ctx: FrameContext): Body | null {
    for (const b of ctx.world.universe.bodies) if (b.def.atmosphere?.clouds) return b;
    return null;
  }

  private findBody(ctx: FrameContext): { body: Body; def: WeatherDef } | null {
    const cam = ctx.cameraWorld;
    for (const b of ctx.world.universe.bodies) {
      const atm = b.def.atmosphere;
      const def = atm?.weather?.find((w) => w.kind === 'lightning');
      if (!atm || !def) continue;
      const alt = b.position.distanceTo(cam) - b.radius;
      const base = (atm.clouds?.altitude ?? 0.1) * b.atmosphereHeight;
      if (Math.abs(alt - base) > RANGE_TO_LAYER) continue;
      return { body: b, def };
    }
    return null;
  }

  /** Strike at `distance` meters along the horizontal direction `dir` (world axes). */
  private strikeAt(ctx: FrameContext, body: Body, dir: Vector3, distance: number, force: boolean): void {
    const atm = body.def.atmosphere!;
    const clouds = atm.clouds;
    const base = (clouds?.altitude ?? 0.1) * body.atmosphereHeight;
    const top = base + (clouds?.thickness ?? 0.05) * body.atmosphereHeight;
    const up = _up.copy(ctx.cameraWorld).sub(body.position).normalize();
    // Horizontal part of dir only.
    const h = _h.copy(dir).addScaledVector(up, -dir.dot(up));
    if (h.lengthSq() < 1e-8) h.set(up.z, 0, -up.x);
    h.normalize();
    const sUp = _su.copy(up).addScaledVector(h, distance / body.radius).normalize();
    const loc = body.worldToLocalDir(sUp, _loc);
    const ground = ctx.world.groundHeight(body, loc);
    const R = body.radius;

    // Body fixed positions.
    const cloudPos = _cp.copy(loc).multiplyScalar(R + base + (top - base) * 0.5);
    const strikeWorld = _sw.copy(sUp).multiplyScalar(R + base).add(body.position);
    const dist = strikeWorld.distanceTo(ctx.cameraWorld);

    this.post.clouds.flashPos.copy(cloudPos);
    this.flashT = 0;
    this.pulses = [{ t: 0, a: 1 }];
    let t = 0;
    const n = 1 + Math.floor(this.rnd() * 2.99);
    for (let i = 0; i < n; i++) {
      t += 0.05 + this.rnd() * 0.1;
      this.pulses.push({ t, a: 0.5 + this.rnd() * 0.5 });
    }

    if (lightningSettings.bolts && (force || this.rnd() < lightningSettings.boltChance)) {
      this.buildBolt(loc, R + base + (top - base) * 0.6, R + ground, dist);
      this.boltBody = body;
      this.boltT = 0;
      this.object.visible = true;
    }
    this.onStrike?.(dist);
  }

  /** Jagged branching polyline from the cloud down to the ground, relative to the ground point. */
  private buildBolt(dir: Vector3, topR: number, groundR: number, dist: number): void {
    const rnd = this.rnd;
    const ground = this.boltGround.copy(dir).multiplyScalar(groundR);
    const top = _bt.copy(dir).multiplyScalar(topR).sub(ground);
    // Perpendicular basis.
    const a = _ba.set(dir.y, -dir.x, 0);
    if (a.lengthSq() < 1e-6) a.set(0, 0, 1);
    a.normalize();
    const b = _bb.crossVectors(dir, a);
    let n = 0;
    const pos = this.positions;
    const push = (p: Vector3, q: Vector3): void => {
      if (n >= MAX_SEGMENTS) return;
      const o = n * 6;
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
      pos[o + 3] = q.x;
      pos[o + 4] = q.y;
      pos[o + 5] = q.z;
      n++;
    };
    const jag = (from: Vector3, to: Vector3, amp: number, depth: number): void => {
      if (depth === 0) {
        push(from, to);
        return;
      }
      const m = new Vector3().addVectors(from, to).multiplyScalar(0.5);
      const len = from.distanceTo(to);
      m.addScaledVector(a, (rnd() - 0.5) * 2 * amp * len).addScaledVector(b, (rnd() - 0.5) * 2 * amp * len);
      jag(from, m, amp, depth - 1);
      jag(m, to, amp, depth - 1);
    };
    const zero = new Vector3();
    const main: Vector3[] = [];
    // Main channel as a few jagged legs so branches can start from the joints.
    const legs = 10;
    for (let i = 0; i <= legs; i++) {
      const f = i / legs;
      const p = new Vector3().lerpVectors(top, zero, f);
      if (i > 0 && i < legs) {
        const w = top.length() * 0.035;
        p.addScaledVector(a, (rnd() - 0.5) * 2 * w).addScaledVector(b, (rnd() - 0.5) * 2 * w);
      }
      main.push(p);
    }
    for (let i = 0; i < legs; i++) jag(main[i]!, main[i + 1]!, 0.16, 3);
    // Branches.
    const branches = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < branches; k++) {
      const i = 1 + Math.floor(rnd() * (legs - 2));
      const start = main[i]!;
      const ang = rnd() * Math.PI * 2;
      const len = top.length() * (0.12 + rnd() * 0.22);
      const end = new Vector3()
        .copy(start)
        .addScaledVector(a, Math.cos(ang) * len * 0.8)
        .addScaledVector(b, Math.sin(ang) * len * 0.8)
        .addScaledVector(dir, -len * 0.7);
      jag(start, end, 0.2, 3);
    }
    // Fatten the channel: two offset copies, about a pixel apart at this distance.
    const w = Math.max(1, dist * 0.0014);
    const base = n;
    for (let k = 0; k < 2; k++) {
      const ox = k === 0 ? a.x * w : b.x * w;
      const oy = k === 0 ? a.y * w : b.y * w;
      const oz = k === 0 ? a.z * w : b.z * w;
      for (let i = 0; i < base && n < MAX_SEGMENTS; i++, n++) {
        for (let j = 0; j < 2; j++) {
          pos[n * 6 + j * 3] = pos[i * 6 + j * 3]! + ox;
          pos[n * 6 + j * 3 + 1] = pos[i * 6 + j * 3 + 1]! + oy;
          pos[n * 6 + j * 3 + 2] = pos[i * 6 + j * 3 + 2]! + oz;
        }
      }
    }
    this.geometry.setDrawRange(0, n * 2);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}

const _east = new Vector3();
const _north = new Vector3();
const _dir = new Vector3();
const _su = new Vector3();
const _up = new Vector3();
const _h = new Vector3();
const _loc = new Vector3();
const _cp = new Vector3();
const _sw = new Vector3();
const _bt = new Vector3();
const _ba = new Vector3();
const _bb = new Vector3();
