import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
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
import { smooth } from './weatherMap';

const RIBBONS = 5;
const SEGMENTS = 320;

const vert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aDir;
  attribute float aTheta;
  attribute float aV;
  attribute float aRib;
  uniform float uHeight, uTime, uFold;
  uniform vec3 uSunLocal;
  varying float vTheta;
  varying float vV;
  varying float vRib;
  varying float vNight;
  varying float vDist;
  void main() {
    // Slow folding: the whole curtain sways sideways (toward and away from the pole) and ripples.
    vec3 axis = vec3(0.0, sign(aDir.y), 0.0);
    vec3 toPole = normalize(axis - aDir * dot(aDir, axis) + 1.0e-5);
    float fold = sin(aTheta * 3.0 + uTime * 0.09 + aRib * 6.0) * 0.6 + sin(aTheta * 7.0 - uTime * 0.17 + aRib * 3.0) * 0.4;
    float ripple = sin(aTheta * 23.0 + aV * 2.0 - uTime * 0.5 + aRib * 9.0);
    vec3 p = position + aDir * (aV * uHeight) + toPole * uFold * (fold * 0.8 + ripple * 0.12 * aV) * aV;
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
  uniform float uTime, uIntensity, uShell;
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
    // Folds lean and sway the rays; the lean grows with height.
    float th = vTheta + 0.007 * v * sin(v * 4.0 + t * 0.25 + vTheta * 13.0 + vRib * 5.0);
    // Fine vertical rays: sharp strands from layered noise, each flickering on its own.
    float r1 = vn(vec2(th * 150.0 + vRib * 31.0, t * 0.3 + vRib * 7.0));
    float r2 = vn(vec2(th * 52.0 - t * 0.1, vRib * 3.0 + t * 0.05));
    float r3 = vn(vec2(th * 420.0 + vRib * 13.0, t * 0.8));
    float strand = smoothstep(0.3, 0.95, r1) * (0.5 + 0.9 * r3);
    float rays = (0.25 + 1.6 * strand) * (0.5 + r2);
    // Slow bands of brightness, and pulses that travel along the curtain.
    float band = smoothstep(0.15, 0.8, vn(vec2(th * 5.0 + t * 0.04 + vRib * 9.0, t * 0.06)));
    float band2 = smoothstep(0.3, 0.9, vn(vec2(th * 11.0 - t * 0.07, 4.0 + vRib)));
    float pulse = 0.65 + 0.35 * sin(th * 17.0 - t * 1.3 + vRib * 6.0) * sin(th * 5.0 - t * 0.6);
    pulse *= 1.0 + 0.5 * pow(max(0.0, sin(th * 9.0 - t * 0.9 + vRib * 4.0)), 8.0);
    float shimmer = 0.85 + 0.3 * vn(vec2(th * 60.0 + t * 1.5, t * 2.0 + vRib * 5.0));
    // Vertical profile: bright lower edge, rays of varying length, soft top.
    float len = 0.22 + 0.78 * mix(r1, r2, 0.6) * (0.6 + 0.4 * band);
    float top = 1.0 - smoothstep(len * 0.3, len, v);
    float low = smoothstep(0.0, 0.03, v);
    float glow = exp(-v * 2.6);
    float I = rays * (0.1 + 0.9 * band) * (0.55 + 0.45 * band2) * pulse * shimmer * top * low * (0.3 + glow);
    // Green base, red and magenta at the top, a pink fringe under strong pulses.
    vec3 col = mix(uC0, uC1, smoothstep(0.1, 0.6, v));
    col = mix(col, uC2, smoothstep(0.35, 0.85, v));
    col = mix(col, vec3(1.0, 0.12, 0.35) * 1.2, smoothstep(0.55, 1.0, v) * 0.75);
    float strong = smoothstep(0.55, 0.95, band * band2 + 0.25 * pulse);
    col += vec3(1.0, 0.25, 0.55) * (1.0 - smoothstep(0.0, 0.09, v)) * strong * 1.6;
    float dist = smoothstep(1500.0, 25000.0, vDist);
    // From orbit the curtains are seen edge on: the shell mesh carries the ring there.
    float far = 1.0 - 0.55 * uShell;
    vec3 rgb = col * I * uIntensity * vNight * dist * far * 0.7;
    // A single NaN pixel turns the whole frame black through bloom: drop non finite or absurd values.
    if (!(rgb.r + rgb.g + rgb.b < 1.0e4)) discard;
    gl_FragColor = vec4(max(rgb, 0.0), 1.0);
  }
`;


/** The oval seen from orbit: a glowing band on a thin shell, looking down through the curtains. */
const shellVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aTheta;
  attribute float aV;
  uniform vec3 uSunLocal;
  varying float vTheta;
  varying float vV;
  varying float vNight;
  varying float vFacing;
  void main() {
    vNight = 1.0 - smoothstep(-0.28, 0.12, dot(normalize(position), uSunLocal));
    vTheta = aTheta;
    vV = aV;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normalize(position));
    vFacing = abs(dot(n, normalize(mv.xyz)));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const shellFrag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime, uIntensity, uShell;
  uniform vec3 uC0, uC1, uC2;
  varying float vTheta;
  varying float vV;
  varying float vNight;
  varying float vFacing;
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
    if (vNight <= 0.003 || uShell <= 0.001) discard;
    float t = uTime;
    // Across the band: bright sharp equatorward edge, soft poleward fade.
    float across = smoothstep(0.0, 0.18, vV) * pow(1.0 - vV, 1.6);
    float rays = 0.45 + 0.9 * smoothstep(0.2, 0.9, vn(vec2(vTheta * 70.0, t * 0.25 + vV * 3.0)));
    float band = 0.35 + 0.65 * smoothstep(0.1, 0.8, vn(vec2(vTheta * 4.0 + t * 0.03, t * 0.05)));
    float pulse = 0.75 + 0.25 * sin(vTheta * 13.0 - t * 1.1) + 0.4 * pow(max(0.0, sin(vTheta * 7.0 - t * 0.7)), 6.0);
    float I = across * rays * band * pulse * (0.4 + 0.6 * vFacing);
    vec3 col = mix(uC0, uC1, smoothstep(0.25, 0.9, vV));
    col = mix(col, uC2, smoothstep(0.7, 1.0, vV) * 0.6);
    col += vec3(1.0, 0.3, 0.55) * (1.0 - smoothstep(0.0, 0.12, vV)) * 0.5;
    vec3 rgb = col * I * uIntensity * vNight * uShell * 2.4;
    if (!(rgb.r + rgb.g + rgb.b < 1.0e4)) discard;
    gl_FragColor = vec4(max(rgb, 0.0), 1.0);
  }
`;

/** One ribbon mesh set (all curtains, both poles) in body fixed coordinates for a body. */
export class Aurora {
  readonly object = new Group();
  private material: ShaderMaterial;
  private shellMat: ShaderMaterial;
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
    const shellPh: number[][] = [];
    for (let pole = 0; pole < 2; pole++) {
      const sgn = pole === 0 ? 1 : -1;
      for (let r = 0; r < RIBBONS; r++) {
        const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
        if (r === 0) shellPh.push(ph);
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
        uFold: { value: R * 0.01 },
        uShell: { value: 0 },
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
    const curtains = new Mesh(geo, this.material);
    curtains.frustumCulled = false;
    curtains.renderOrder = -4;

    // Shell band for the view from orbit: latitude strips around each pole, sharing the ring shape.
    const SS = 4;
    const sv = 2 * (SEGMENTS + 1) * (SS + 1);
    const spos = new Float32Array(sv * 3);
    const sth = new Float32Array(sv);
    const sv2 = new Float32Array(sv);
    const sidx: number[] = [];
    let si = 0;
    for (let pole = 0; pole < 2; pole++) {
      const sgn = pole === 0 ? 1 : -1;
      const ph = shellPh[pole]!;
      const first = si;
      for (let s = 0; s <= SEGMENTS; s++) {
        const th = (s / SEGMENTS) * Math.PI * 2;
        const lat0 =
          def.latitude + 0.035 * Math.sin(2 * th + ph[0]!) + 0.02 * Math.sin(5 * th + ph[1]!) + 0.008 * Math.sin(11 * th + ph[2]!);
        for (let k = 0; k <= SS; k++) {
          const f = k / SS;
          const lat = lat0 - 0.03 + f * 0.1;
          const c = Math.cos(lat);
          const rr = R + H * 0.95;
          const o = si * 3;
          spos[o] = c * Math.cos(th) * rr;
          spos[o + 1] = sgn * Math.sin(lat) * rr;
          spos[o + 2] = -c * Math.sin(th) * rr;
          sth[si] = th + pole * 1.7;
          sv2[si] = f;
          si++;
        }
      }
      for (let s = 0; s < SEGMENTS; s++) {
        for (let k = 0; k < SS; k++) {
          const a = first + s * (SS + 1) + k;
          const b = a + (SS + 1);
          sidx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const sgeo = new BufferGeometry();
    sgeo.setAttribute('position', new Float32BufferAttribute(spos, 3));
    sgeo.setAttribute('aTheta', new Float32BufferAttribute(sth, 1));
    sgeo.setAttribute('aV', new Float32BufferAttribute(sv2, 1));
    sgeo.setIndex(new Uint32BufferAttribute(sidx, 1));
    this.shellMat = new ShaderMaterial({
      uniforms: {
        uTime: this.material.uniforms.uTime!,
        uIntensity: this.material.uniforms.uIntensity!,
        uShell: this.material.uniforms.uShell!,
        uSunLocal: this.material.uniforms.uSunLocal!,
        uC0: this.material.uniforms.uC0!,
        uC1: this.material.uniforms.uC1!,
        uC2: this.material.uniforms.uC2!,
      },
      vertexShader: shellVert,
      fragmentShader: shellFrag,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    const shell = new Mesh(sgeo, this.shellMat);
    shell.frustumCulled = false;
    shell.renderOrder = -4;
    this.object.add(curtains, shell);
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
    u.uFold!.value = b.radius * 0.012 * auroraSettings.fold;
    // The ring shows from above the atmosphere; low down the curtains do the work.
    const alt = dist - b.radius;
    u.uShell!.value = auroraSettings.shell * smooth(b.atmosphereHeight * 1.2, b.atmosphereHeight * 5, alt);
  }
}
