import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  ShaderMaterial,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/rng';
import { placeRelative, type FrameContext } from '../context';
import type { Body } from '../../sim/universe';
import type { PostStack } from '../post';
import { auroraSettings } from './settings';

const RIBBONS = 5;
const SEGMENTS = 320;

const vert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aDir;
  attribute float aTheta;
  attribute float aV;
  attribute float aRib;
  uniform float uHeight;
  uniform vec3 uSunLocal;
  varying float vTheta;
  varying float vV;
  varying float vRib;
  varying float vNight;
  varying float vDist;
  void main() {
    vec3 p = position + aDir * (aV * uHeight);
    // Only the night side glows. Fade by the sun direction at the vertex.
    vNight = 1.0 - smoothstep(-0.28, 0.12, dot(normalize(p), uSunLocal));
    vTheta = aTheta;
    vV = aV;
    vRib = aRib;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const frag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime, uIntensity;
  uniform vec3 uC0, uC1, uC2;
  varying float vTheta;
  varying float vV;
  varying float vRib;
  varying float vNight;
  varying float vDist;

  float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = h11(i.x + i.y * 57.0), b = h11(i.x + 1.0 + i.y * 57.0);
    float c = h11(i.x + (i.y + 1.0) * 57.0), d = h11(i.x + 1.0 + (i.y + 1.0) * 57.0);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    #include <logdepthbuf_fragment>
    if (vNight <= 0.003) discard;
    float t = uTime;
    float v = vV;
    // Slow folds make the rays lean and sway.
    float th = vTheta + 0.006 * sin(v * 4.0 + t * 0.25 + vTheta * 13.0 + vRib * 5.0);
    float r1 = vn(vec2(th * 140.0 + vRib * 31.0, t * 0.35 + vRib * 7.0));
    float r2 = vn(vec2(th * 46.0 - t * 0.12, vRib * 3.0 + t * 0.05));
    float r3 = vn(vec2(th * 380.0 + vRib * 13.0, t * 0.9));
    float rays = pow(mix(r1, r2, 0.45), 1.5) * (0.7 + 0.6 * r3) * 2.0;
    // Large slow bands of brightness drifting around the ring.
    float band = smoothstep(0.2, 0.8, vn(vec2(th * 5.0 + t * 0.04 + vRib * 9.0, t * 0.06)));
    float band2 = smoothstep(0.3, 0.9, vn(vec2(th * 11.0 - t * 0.07, 4.0 + vRib)));
    float shimmer = 0.8 + 0.4 * vn(vec2(th * 60.0 + t * 1.5, t * 2.0 + vRib * 5.0));
    // Vertical profile: sharp bright lower edge, rays of varying length, soft top.
    float len = 0.3 + 0.7 * r1;
    float top = 1.0 - smoothstep(len * 0.25, len, v);
    float low = smoothstep(0.0, 0.04, v);
    float glow = exp(-v * 2.2);
    float I = rays * (0.1 + 0.9 * band) * (0.55 + 0.45 * band2) * shimmer * top * low * (0.35 + glow);
    vec3 col = mix(uC0, uC1, smoothstep(0.08, 0.7, v));
    col = mix(col, uC2, smoothstep(0.6, 1.0, v));
    float dist = smoothstep(1500.0, 25000.0, vDist);
    vec3 rgb = col * I * uIntensity * vNight * dist * 1.0;
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

/** One ribbon mesh set (all curtains, both poles) in body fixed coordinates for a body. */
export class Aurora {
  readonly object: Mesh;
  private material: ShaderMaterial;
  private sun = new Vector3();

  constructor(
    private body: Body,
    private post: PostStack,
  ) {
    const def = body.def.atmosphere!.aurora!;
    const rnd = mulberry32(body.def.seed ?? 3);
    const R = body.radius;
    const H = body.atmosphereHeight;

    const verts = RIBBONS * 2 * (SEGMENTS + 1) * 2;
    const pos = new Float32Array(verts * 3);
    const dir = new Float32Array(verts * 3);
    const theta = new Float32Array(verts);
    const vv = new Float32Array(verts);
    const rib = new Float32Array(verts);
    const idx: number[] = [];
    let vi = 0;
    for (let pole = 0; pole < 2; pole++) {
      const sgn = pole === 0 ? 1 : -1;
      for (let r = 0; r < RIBBONS; r++) {
        const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
        const latOff = (r - (RIBBONS - 1) / 2) * 0.012 + (rnd() - 0.5) * 0.01;
        const bottom = H * (0.8 + 0.12 * rnd());
        const seed = rnd();
        const first = vi;
        for (let s = 0; s <= SEGMENTS; s++) {
          const th = (s / SEGMENTS) * Math.PI * 2;
          const lat =
            def.latitude +
            latOff +
            0.035 * Math.sin(2 * th + ph[0]!) +
            0.02 * Math.sin(5 * th + ph[1]!) +
            0.008 * Math.sin(11 * th + ph[2]!);
          const c = Math.cos(lat);
          const dx = c * Math.cos(th);
          const dy = sgn * Math.sin(lat);
          const dz = -c * Math.sin(th);
          // The lower edge undulates so the curtain does not hang like a flat ceiling.
          const b = R + bottom + H * (0.05 * Math.sin(3 * th + ph[1]!) + 0.025 * Math.sin(8 * th + ph[2]!));
          for (let k = 0; k < 2; k++) {
            const o = vi * 3;
            pos[o] = dx * b;
            pos[o + 1] = dy * b;
            pos[o + 2] = dz * b;
            dir[o] = dx;
            dir[o + 1] = dy;
            dir[o + 2] = dz;
            theta[vi] = th + pole * 1.7;
            vv[vi] = k;
            rib[vi] = seed + r * 0.37 + pole * 0.11;
            vi++;
          }
        }
        for (let s = 0; s < SEGMENTS; s++) {
          const a = first + s * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new Float32BufferAttribute(dir, 3));
    geo.setAttribute('aTheta', new Float32BufferAttribute(theta, 1));
    geo.setAttribute('aV', new Float32BufferAttribute(vv, 1));
    geo.setAttribute('aRib', new Float32BufferAttribute(rib, 1));
    geo.setIndex(new Uint32BufferAttribute(idx, 1));

    const c = def.colors;
    const col = (i: number): Vector3 => {
      const x = c[Math.min(i, c.length - 1)]!;
      return new Vector3(x[0], x[1], x[2]);
    };
    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uHeight: { value: R * 0.16 },
        uSunLocal: { value: this.sun },
        uC0: { value: col(0) },
        uC1: { value: col(1) },
        uC2: { value: c.length > 2 ? col(2) : col(1).clone().lerp(new Vector3(1, 0.25, 0.45), 0.6) },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.object = new Mesh(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -4;
  }

  update(ctx: FrameContext): void {
    const b = this.body;
    const def = b.def.atmosphere!.aurora!;
    const dist = b.position.distanceTo(ctx.cameraWorld);
    const show = auroraSettings.enabled && dist < b.radius * 40;
    this.object.visible = show;
    if (!show) return;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    this.object.quaternion.copy(b.rotation);
    this.sun.copy(ctx.world.universe.root.position).sub(b.position).normalize();
    b.worldToLocalDir(this.sun, this.sun);
    const u = this.material.uniforms;
    u.uTime!.value = ctx.realTime % 3600;
    // Daylight sky washes the aurora out, whatever side of the planet it is on.
    u.uIntensity!.value = def.intensity * auroraSettings.intensity * (1 - 0.97 * this.post.skyBrightness);
    u.uHeight!.value = b.radius * auroraSettings.height;
  }
}
