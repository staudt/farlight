import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { config } from '../../core/config';
import { mulberry32 } from '../../core/rng';
import { frameToWorldDir } from '../../sim/frames';
import type { FrameContext } from '../context';
import { quality } from '../quality';
import { warpIntensity } from './speedFx';

const COUNT = 900;
/** Half length of the streak field along the motion, meters. */
const HALF = 3200;
const RADIUS = 900;

/** Screen overlays for speed: the warp tunnel and the plasma glow around the frame edges. */
export class FxScreen {
  private tunnel: HTMLDivElement;
  private plasma: HTMLDivElement;
  private lastT = -1;
  private lastP = -1;

  constructor() {
    const make = (bg: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:0;opacity:0;display:none;background:${bg}`;
      return d;
    };
    this.tunnel = make('radial-gradient(ellipse at center, rgba(0,0,0,0) 38%, rgba(20,40,150,0.35) 72%, rgba(6,8,50,0.85) 100%)');
    this.plasma = make('radial-gradient(ellipse at center, rgba(255,120,40,0) 52%, rgba(255,110,40,0.22) 78%, rgba(255,70,160,0.4) 93%, rgba(255,150,140,0.55) 100%)');
    const canvas = document.getElementById('game');
    if (canvas) canvas.after(this.tunnel, this.plasma);
    else document.body.append(this.tunnel, this.plasma);
  }

  set(tunnel: number, plasma: number): void {
    if (Math.abs(tunnel - this.lastT) > 0.004) {
      this.lastT = tunnel;
      this.tunnel.style.display = tunnel > 0.004 ? 'block' : 'none';
      this.tunnel.style.opacity = String(Math.min(1, tunnel));
    }
    if (Math.abs(plasma - this.lastP) > 0.004) {
      this.lastP = plasma;
      this.plasma.style.display = plasma > 0.004 ? 'block' : 'none';
      this.plasma.style.opacity = String(Math.min(1, plasma));
    }
  }
}

/**
 * Warp streaks: a layer of hyperspace lines around the ship, drawn only at high effective speed
 * (speed x time warp). They flow along the velocity, blue ahead and red behind. Zero cost when off.
 */
export class WarpStreaks {
  readonly object: LineSegments;
  private material: ShaderMaterial;
  private dir = new Vector3(0, 0, -1);
  private vel = new Vector3();
  private phase = 0;
  /** Smoothed 0..1 effect level, shared with the dust and the screen overlay. */
  k = 0;

  constructor(seed = 77) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(COUNT * 2 * 3);
    const end = new Float32Array(COUNT * 2);
    const rand = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const a = rnd();
      const r = rnd();
      const s = rnd();
      const b = rnd();
      for (let e = 0; e < 2; e++) {
        const o = (i * 2 + e) * 3;
        pos[o] = a;
        pos[o + 1] = r;
        pos[o + 2] = s;
        end[i * 2 + e] = e;
        rand[i * 2 + e] = b;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new Float32BufferAttribute(end, 1));
    geo.setAttribute('aRand', new Float32BufferAttribute(rand, 1));
    this.material = new ShaderMaterial({
      uniforms: {
        uDir: { value: this.dir },
        uPhase: { value: 0 },
        uLen: { value: 800 },
        uAlpha: { value: 0 },
        uTint: { value: 0.6 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aEnd;
        attribute float aRand;
        uniform vec3 uDir;
        uniform float uPhase, uLen, uAlpha, uTint;
        varying vec4 vCol;
        void main() {
          vec3 dir = normalize(uDir);
          vec3 ref = abs(dir.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
          vec3 u = normalize(cross(dir, ref));
          vec3 v = cross(dir, u);
          float ang = position.x * 6.2831853;
          // Denser near the axis, so the lines converge on the vanishing point.
          float rad = 40.0 + ${RADIUS.toFixed(1)} * position.y * position.y;
          float L2 = ${(HALF * 2).toFixed(1)};
          float s = mod(position.z * L2 - uPhase, L2) - ${HALF.toFixed(1)};
          vec3 p = (u * cos(ang) + v * sin(ang)) * rad + dir * s;
          float len = uLen * (0.45 + 0.8 * aRand);
          vec3 q = p + aEnd * dir * len;
          float cosA = dot(normalize(p), dir);
          vec3 blue = vec3(0.55, 0.8, 1.7);
          vec3 red = vec3(1.7, 0.55, 0.4);
          vec3 tint = mix(red, blue, smoothstep(-0.25, 0.45, cosA));
          vec3 col = mix(vec3(1.3), tint, uTint);
          // Keep the vanishing point clear so the view ahead stays readable.
          float axis = smoothstep(0.03, 0.2, rad / max(length(p), 1.0));
          float fade = axis * smoothstep(25.0, 140.0, length(p)) * (1.0 - smoothstep(0.62, 1.0, abs(s) / ${HALF.toFixed(1)}));
          float a = uAlpha * fade * (0.35 + 0.65 * aRand) * (1.0 - 0.88 * aEnd);
          vCol = vec4(col, a);
          vec4 mv = modelViewMatrix * vec4(q, 1.0);
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec4 vCol;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vCol;
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.object = new LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -4;
    this.object.visible = false;
  }

  update(ctx: FrameContext, target: number): void {
    const c = config.speedFx;
    this.k += (target - this.k) * (1 - Math.exp(-ctx.realDt / (target > this.k ? 0.5 : 0.25)));
    if (this.k < 0.004) {
      this.k = target === 0 ? 0 : this.k;
      this.object.visible = false;
      return;
    }
    const ship = ctx.world.ship;
    frameToWorldDir(ship.frame, ship.vel, this.vel);
    const sp = this.vel.length();
    if (sp > 0.5) this.vel.divideScalar(sp);
    else this.vel.copy(this.dir);
    this.dir.lerp(this.vel, 1 - Math.exp(-ctx.realDt * 8)).normalize();
    this.object.visible = true;
    const k = this.k;
    this.phase = (this.phase + (2500 + 20000 * k) * ctx.realDt) % (HALF * 2);
    const u = this.material.uniforms;
    u.uPhase!.value = this.phase;
    u.uLen!.value = c.warpStreakLength * (0.25 + 0.75 * k);
    u.uAlpha!.value = c.warpStreakAlpha * k * Math.min(1, 0.4 + quality.settings.fxScale);
    u.uTint!.value = c.warpTint;
    // Low quality draws fewer lines.
    const n = Math.round(COUNT * Math.min(1, 0.35 + quality.settings.fxScale));
    this.object.geometry.setDrawRange(0, n * 2);
  }
}

export { warpIntensity };
