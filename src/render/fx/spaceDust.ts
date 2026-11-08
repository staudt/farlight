import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { mulberry32 } from '../../core/rng';
import { frameToWorldDir } from '../../sim/frames';
import type { FrameContext } from '../context';

const COUNT = 1400;
const SIZE = 400;
const STREAK_TIME = 0.014;
const MAX_STREAK = 55;
const MIN_STREAK = 0.35;

/**
 * Motion cue dust: a 400 m cube of particles around the camera. The particles sit still
 * relative to the local body, so they stream past at the ship's speed over the ground. Each
 * is drawn as a short streak along the velocity that grows with speed.
 */
export class SpaceDust {
  readonly object: LineSegments;
  private material: ShaderMaterial;
  /** Camera position in the dust's own (body fixed) coordinates, wrapped to the cube. */
  private anchor = new Vector3();
  private vel = new Vector3();
  private dir = new Vector3(0, 0, -1);

  constructor(seed = 31) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(COUNT * 2 * 3);
    const end = new Float32Array(COUNT * 2);
    const rand = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const x = rnd() * SIZE;
      const y = rnd() * SIZE;
      const z = rnd() * SIZE;
      const b = 0.35 + 0.65 * Math.pow(rnd(), 2);
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
        end[i * 2 + k] = k;
        rand[i * 2 + k] = b;
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new Float32BufferAttribute(end, 1));
    geo.setAttribute('aRand', new Float32BufferAttribute(rand, 1));

    this.material = new ShaderMaterial({
      uniforms: {
        uAnchor: { value: this.anchor },
        uStreak: { value: new Vector3() },
        uAlpha: { value: 0.4 },
        uSize: { value: SIZE },
        uColor: { value: new Vector3(0.7, 0.82, 1.0) },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aEnd;
        attribute float aRand;
        uniform vec3 uAnchor;
        uniform vec3 uStreak;
        uniform float uSize, uAlpha;
        varying float vAlpha;
        void main() {
          vec3 p = mod(position - uAnchor, uSize) - 0.5 * uSize;
          float edge = max(max(abs(p.x), abs(p.y)), abs(p.z)) / (0.5 * uSize);
          float dist = length(p);
          vAlpha = uAlpha * aRand * (1.0 - smoothstep(0.65, 1.0, edge)) * smoothstep(8.0, 30.0, dist) * (1.0 - 0.85 * aEnd);
          vec4 mv = modelViewMatrix * vec4(p + aEnd * uStreak, 1.0);
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(uColor, vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.object = new LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -5;
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    const ship = w.ship;
    // Ship velocity relative to the local body, in world axes.
    frameToWorldDir(ship.frame, ship.vel, this.vel);
    const speed = this.vel.length();
    if (speed > 0.5) this.dir.copy(this.vel).divideScalar(speed);

    // Real time based: the dust looks the same at any time warp.
    this.anchor.addScaledVector(this.vel, ctx.realDt);
    this.anchor.x = ((this.anchor.x % SIZE) + SIZE) % SIZE;
    this.anchor.y = ((this.anchor.y % SIZE) + SIZE) % SIZE;
    this.anchor.z = ((this.anchor.z % SIZE) + SIZE) % SIZE;

    const len = Math.min(MAX_STREAK, Math.max(MIN_STREAK, speed * STREAK_TIME));
    const u = this.material.uniforms;
    (u.uStreak!.value as Vector3).copy(this.dir).multiplyScalar(len);

    // Space: faint bluish dust. Atmosphere: very faint, fading as the sky brightens.
    const d = w.atmosphereDepth;
    const air = 1 - Math.min(1, d * 1.15);
    u.uAlpha!.value = 0.3 * air * air + 0.025 * air;
  }
}
