import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { FrameContext } from '../context';
import { placeRelative } from '../context';
import { NOISE_GLSL } from './noiseGlsl';

const shake = { x: 0, y: 0 };

/**
 * Light camera shake from re-entry, in meters of camera offset along the camera's right (x)
 * and up (y) axes. Zero when there is no heat.
 */
export function getShake(): { x: number; y: number } {
  return shake;
}

const COMMON_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vL;
  void main() {
    vL = position;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

/** Orange to pink to white plasma ramp, HDR. */
const RAMP_GLSL = /* glsl */ `
  vec3 plasma(float h) {
    vec3 orange = vec3(2.2, 0.75, 0.12);
    vec3 pink = vec3(2.4, 0.5, 1.1);
    vec3 white = vec3(3.0, 2.6, 2.4);
    vec3 c = mix(orange, pink, smoothstep(0.25, 0.65, h));
    return mix(c, white, smoothstep(0.65, 1.0, h));
  }`;

function shellMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 0 } },
    vertexShader: COMMON_VERT,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uHeat;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      ${NOISE_GLSL}
      ${RAMP_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float face = abs(dot(normalize(vN), normalize(-vV)));
        float fres = pow(1.0 - face, 1.8);
        // Local z of the unit sphere: -1 at the nose, +1 at the tail.
        float front = smoothstep(0.7, -0.8, vL.z);
        float flowZ = vL.z * 3.0 - uTime * 5.0;
        float n = fxNoise(vec2(vL.x * 4.0 + vL.y * 3.0, flowZ)) * 0.6
                + fxNoise(vec2(vL.y * 6.0 - vL.x * 2.0, flowZ * 1.7 + 4.0)) * 0.4;
        float h = clamp(uHeat * (0.35 + 0.9 * front) * (0.6 + 0.7 * n) + fres * 0.25 * uHeat, 0.0, 1.0);
        float a = uHeat * (fres * (0.35 + 0.65 * n) * (0.35 + 0.65 * front) + 0.08 * front * n);
        gl_FragColor = vec4(plasma(h), clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

function trailMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 0 }, uLen: { value: 100 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      void main() {
        vL = position;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uHeat, uLen;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      ${NOISE_GLSL}
      ${RAMP_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float t = vL.z; // 0 at the ship, 1 at the end of the trail
        float face = abs(dot(normalize(vN), normalize(-vV)));
        float z = t * uLen;
        float n = fxNoise(vec2(vL.x * 1.4 + vL.y * 1.1, z * 0.12 - uTime * 6.0)) * 0.55
                + fxNoise(vec2(vL.y * 2.1 - vL.x * 0.9, z * 0.3 - uTime * 9.0)) * 0.45;
        float fade = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.04, t);
        float dist = length(vV);
        float near = smoothstep(10.0, 40.0, dist);
        float a = uHeat * fade * (0.15 + 0.85 * pow(face, 1.3)) * (0.4 + 1.0 * n) * 1.4 * near;
        float h = clamp(uHeat * (1.1 - t) * (0.5 + 0.7 * n), 0.0, 1.0);
        gl_FragColor = vec4(plasma(h * 0.85), clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/** Re-entry plasma: a fresnel heat shell, an ion trail and a little camera shake. */
export class Reentry {
  readonly object = new Group();
  private shell: Mesh;
  private trail: Mesh;
  private shellMat = shellMaterial();
  private trailMat = trailMaterial();
  private heat = 0;

  constructor() {
    this.shell = new Mesh(new SphereGeometry(1, 28, 18), this.shellMat);
    this.shell.scale.set(8.5, 4.2, 15);
    this.shell.position.set(0, 0.2, -1.5);
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 6;

    // Open cone along +Z from the tail: radius 1 at z=0 down to a point at z=1.
    const g = new CylinderGeometry(0.05, 1, 1, 16, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, 0.5);
    this.trail = new Mesh(g, this.trailMat);
    this.trail.position.set(0, 0, 10);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;

    this.object.add(this.shell, this.trail);
    this.object.visible = false;
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    const ship = w.ship;
    // Raw stress is tiny in thin air at orbital speed, so map it on a log scale. Slow flight in
    // dense air stays cold.
    const s = Math.max(ship.stress, 1e-6);
    const target = clamp01((Math.log10(s) + 3.9) / 1.5) * smooth(250, 700, ship.speed);
    this.heat += (target - this.heat) * (1 - Math.exp(-ctx.realDt / 0.4));
    const heat = this.heat;

    if (heat < 0.003) {
      this.object.visible = false;
      shake.x = 0;
      shake.y = 0;
      return;
    }
    this.object.visible = true;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);

    const t = ctx.realTime;
    this.shellMat.uniforms.uTime!.value = t;
    this.shellMat.uniforms.uHeat!.value = heat;
    const pulse = 1 + 0.04 * Math.sin(t * 31) * heat;
    this.shell.scale.set(8.5 * (0.9 + 0.2 * heat) * pulse, 4.2 * (0.9 + 0.2 * heat) * pulse, 15 + 3 * heat);

    const len = 40 + 160 * heat;
    this.trail.scale.set(3.4 + 2 * heat, 2.2 + 1.2 * heat, len);
    this.trailMat.uniforms.uTime!.value = t;
    this.trailMat.uniforms.uHeat!.value = heat;
    this.trailMat.uniforms.uLen!.value = len;

    const amp = 0.22 * heat * heat;
    shake.x = amp * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 91.7 + 1.0) * 0.4);
    shake.y = amp * (Math.sin(t * 43.3 + 2.0) * 0.6 + Math.sin(t * 77.9 + 4.0) * 0.4);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
