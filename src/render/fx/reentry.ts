import { BufferGeometry, Float32BufferAttribute, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, CylinderGeometry, DoubleSide, Group, Mesh, PointLight, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { config } from '../../core/config';
import type { FrameContext } from '../context';
import { placeRelative } from '../context';
import { NOISE_GLSL } from './noiseGlsl';
import { quality } from '../quality';
import { smooth } from './speedFx';

const shake = { x: 0, y: 0 };

/**
 * Light camera shake from re-entry, in meters of camera offset along the camera's right (x)
 * and up (y) axes. Zero when there is no heat.
 */
export function getShake(): { x: number; y: number } {
  return shake;
}

/**
 * Screen space plasma state for the heat shimmer pass: uv of the ship's tail, radius in uv, strength,
 * and a wobble along the frame edges (first person). All zero when there is no heat.
 */
export const plasmaShimmer = { x: 0.5, y: 0.5, radius: 0.2, amount: 0, edge: 0 };

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

/** Plasma ramp, HDR. h is heat 0..1 (hot is white). */
const RAMP_GLSL = /* glsl */ `
  vec3 plasma(float h) {
    vec3 orange = vec3(2.2, 0.75, 0.12);
    vec3 pink = vec3(2.4, 0.5, 1.1);
    vec3 white = vec3(3.0, 2.6, 2.4);
    vec3 c = mix(orange, pink, smoothstep(0.25, 0.65, h));
    return mix(c, white, smoothstep(0.65, 1.0, h));
  }
  // Shock layer colour by position along the body: s is 0 at the stagnation point, 1 at the tail.
  vec3 shockColor(float s) {
    vec3 stag = vec3(3.4, 2.7, 2.0);
    vec3 orange = vec3(1.55, 0.5, 0.05);
    vec3 pink = vec3(1.35, 0.14, 0.75);
    vec3 violet = vec3(0.55, 0.1, 1.3);
    vec3 c = mix(stag, orange, smoothstep(0.0, 0.22, s));
    c = mix(c, pink, smoothstep(0.2, 0.55, s));
    return mix(c, violet, smoothstep(0.5, 0.95, s));
  }`;

function shellMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 0 }, uView: { value: 1 } },
    vertexShader: COMMON_VERT,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uHeat, uView;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      ${NOISE_GLSL}
      ${RAMP_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float face = clamp(abs(dot(normalize(vN), normalize(-vV))), 0.0, 1.0);
        float fres = pow(1.0 - face, 1.8);
        // Local z of the unit sphere: -1 at the nose, +1 at the tail.
        float front = smoothstep(0.7, -0.8, vL.z);
        float flowZ = vL.z * 3.0 - uTime * 5.0;
        float n = fxNoise(vec2(vL.x * 4.0 + vL.y * 3.0, flowZ)) * 0.6
                + fxNoise(vec2(vL.y * 6.0 - vL.x * 2.0, flowZ * 1.7 + 4.0)) * 0.4;
        float s = clamp((vL.z + 1.0) * 0.5, 0.0, 1.0);
        // Stagnation cap: a hard bright spot on the nose, orange white.
        float cap = pow(smoothstep(0.35, 1.0, -vL.z), 2.0);
        float a = uHeat * (0.6 * (fres * (0.35 + 0.65 * n) * (0.35 + 0.65 * front) + 0.08 * front * n) + cap * (0.5 + 0.4 * n));
        vec3 col = shockColor(clamp(s * (1.5 - 0.6 * uHeat) + (n - 0.5) * 0.12, 0.0, 1.0));
        col *= 0.6 + 0.6 * uHeat;
        a = clamp(a, 0.0, 1.0) * uView;
        gl_FragColor = vec4(col * a, a * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
    // Emissive but not purely additive: some of the backdrop is covered, so plasma reads over bright cloud.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: DoubleSide,
  });
}

function trailMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 0 }, uLen: { value: 100 }, uPink: { value: 0 }, uSway: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      uniform float uTime, uSway;
      void main() {
        vL = position;
        vN = normalize(normalMatrix * normal);
        vec3 pp = position;
        // Streamers whip sideways along their length.
        pp.x += uSway * sin(pp.z * 14.0 - uTime * 9.0) * pp.z * 0.5;
        pp.y += uSway * sin(pp.z * 11.0 - uTime * 7.0 + 1.7) * pp.z * 0.3;
        vec4 mv = modelViewMatrix * vec4(pp, 1.0);
        vV = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uHeat, uLen, uPink;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      ${NOISE_GLSL}
      ${RAMP_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float t = vL.z; // 0 at the ship, 1 at the end of the trail
        float face = clamp(abs(dot(normalize(vN), normalize(-vV))), 0.0, 1.0);
        float z = t * uLen;
        float n = fxNoise(vec2(vL.x * 1.4 + vL.y * 1.1, z * 0.12 - uTime * 6.0)) * 0.55
                + fxNoise(vec2(vL.y * 2.1 - vL.x * 0.9, z * 0.3 - uTime * 9.0)) * 0.45;
        float fade = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.04, t);
        float dist = length(vV);
        float near = smoothstep(3.0, 16.0, dist);
        float a = uHeat * fade * (0.5 + 0.5 * pow(face, 1.3)) * (0.4 + 1.0 * n) * 0.9 * near;
        float h = clamp(uHeat * (1.1 - t) * (0.5 + 0.7 * n), 0.0, 1.0);
        vec3 col = shockColor(clamp(0.1 + t * 0.85, 0.0, 1.0));
        // Streamers: bright orange at the wing, pink then violet as they stretch away.
        
        gl_FragColor = vec4(col * clamp(a, 0.0, 1.0), clamp(a, 0.0, 1.0) * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
    // Emissive but not purely additive: some of the backdrop is covered, so plasma reads over bright cloud.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: DoubleSide,
  });
}

/** A camera facing strip along +Z (ship space) from the mesh origin: used for the wing tip streamers. */
export function streamerGeometry(): BufferGeometry {
  const N = 28;
  const pos = new Float32Array((N + 1) * 2 * 3);
  const t = new Float32Array((N + 1) * 2);
  const side = new Float32Array((N + 1) * 2);
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    for (let k = 0; k < 2; k++) {
      t[i * 2 + k] = i / N;
      side[i * 2 + k] = k === 0 ? -1 : 1;
    }
    if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new Float32BufferAttribute(t, 1));
  g.setAttribute('aSide', new Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

function streamerMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 0 }, uLen: { value: 100 }, uWidth: { value: 1 }, uPhase: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aT;
      attribute float aSide;
      uniform float uTime, uLen, uWidth, uPhase;
      varying float vT;
      varying float vSide;
      void main() {
        vT = aT;
        vSide = aSide;
        // Whip sideways along the length, more toward the end.
        vec3 p = vec3(sin(aT * 9.0 - uTime * 11.0 + uPhase) * 0.9 * aT * aT * uLen * 0.02, cos(aT * 7.0 - uTime * 9.0 + uPhase) * 0.5 * aT * aT * uLen * 0.012, aT * uLen);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 dir = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vec3 sideV = cross(dir, normalize(mv.xyz));
        float sl = length(sideV);
        sideV = sl > 1e-4 ? sideV / sl : vec3(1.0, 0.0, 0.0);
        float w = uWidth * (0.35 + 1.6 * aT) * (1.0 - 0.6 * aT * aT);
        mv.xyz += sideV * aSide * w;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uHeat;
      varying float vT;
      varying float vSide;
      ${NOISE_GLSL}
      ${RAMP_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float across = 1.0 - vSide * vSide;
        float n = fxNoise(vec2(vT * 9.0 - uTime * 12.0, vSide * 1.5)) * 0.6 + 0.4;
        float a = uHeat * across * across * pow(1.0 - vT, 0.9) * smoothstep(0.0, 0.05, vT + 0.05) * (0.8 + 0.7 * n);
        a = clamp(a * 1.7, 0.0, 1.0);
        vec3 col = shockColor(clamp(0.2 + vT * 0.7, 0.0, 1.0)) * 1.0;
        gl_FragColor = vec4(col * a, a * 0.9);
      }`,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    side: DoubleSide,
  });
}

const _v = new Vector3();

/**
 * Re-entry plasma: a shock layer on the nose (orange white at the stagnation point, pink then violet
 * along the cone), glowing streamers off the wing tips, an ion trail, a light that tints the ship,
 * screen edge glow and shimmer, and a little camera shake.
 */
export class Reentry {
  readonly object = new Group();
  /** Smoothed heat 0..1. */
  heat = 0;
  private shell: Mesh;
  private trail: Mesh;
  private streamers: Mesh[] = [];
  private streamMat = streamerMaterial();
  private shellMat = shellMaterial();
  private trailMat = trailMaterial();
  private light = new PointLight(0xff8a40, 0, 70, 1.6);
  /** Hidden while there is no heat, so three.js does not light with it at all. */
  readonly lightHolder = new Group();

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

    const sg = streamerGeometry();
    for (const sx of [-1, 1]) {
      const m = new Mesh(sg, this.streamMat);
      m.position.set(sx * 10.5, -1.1, 8);
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.streamers.push(m);
    }
    this.object.add(this.shell, this.trail, ...this.streamers);
    this.object.visible = false;
    this.light.position.set(0, 1.5, -13);
    this.lightHolder.add(this.light);
    this.lightHolder.visible = false;
  }

  /** Returns the 0..1 plasma glow for the screen edges. */
  update(ctx: FrameContext, cockpit: boolean): number {
    const w = ctx.world;
    const ship = w.ship;
    const c = config.speedFx;
    // Stress is 0..1 already (the air braking the ship); ease it in so faint heat stays faint.
    const target = c.enabled ? smooth(0.03, 0.4, ship.stress) * smooth(250, 700, ship.speed) : 0;
    this.heat += (target - this.heat) * (1 - Math.exp(-ctx.realDt / 0.4));
    const heat = this.heat;

    if (heat < 0.003) {
      this.object.visible = false;
      this.light.intensity = 0;
      this.lightHolder.visible = false;
      shake.x = 0;
      shake.y = 0;
      plasmaShimmer.amount = 0;
      plasmaShimmer.edge = 0;
      return 0;
    }
    this.object.visible = true;
    this.lightHolder.visible = true;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);
    placeRelative(this.lightHolder, w.shipWorldPos, ctx.cameraWorld);
    this.lightHolder.quaternion.copy(w.shipWorldQuat);
    this.light.intensity = heat * heat * 700 * c.plasmaLight;

    const t = ctx.realTime;
    this.shellMat.uniforms.uTime!.value = t;
    this.shellMat.uniforms.uHeat!.value = heat;
    // First person sits inside the shell: keep only a light glow ahead.
    this.shellMat.uniforms.uView!.value = cockpit ? 0.3 : 1;
    const pulse = 1 + 0.04 * Math.sin(t * 31) * heat;
    this.shell.scale.set(8.5 * (0.9 + 0.2 * heat) * pulse, 4.2 * (0.9 + 0.2 * heat) * pulse, 15 + 3 * heat);

    const len = 40 + 160 * heat;
    this.trail.scale.set(3.4 + 2 * heat, 2.2 + 1.2 * heat, len);
    this.trailMat.uniforms.uTime!.value = t;
    this.trailMat.uniforms.uHeat!.value = heat;
    this.trailMat.uniforms.uLen!.value = len;

    // Wing streamers: ribbons of plasma that stream off the tips, orange then pink.
    const sAmt = c.plasmaStreamers * smooth(0.12, 0.5, heat);
    for (const m of this.streamers) m.visible = sAmt > 0.01;
    const su = this.streamMat.uniforms;
    su.uTime!.value = t;
    su.uHeat!.value = Math.min(1.3, sAmt * 1.2);
    su.uLen!.value = 90 + 190 * heat;
    su.uWidth!.value = 1.2 + 1.6 * heat;

    // Shimmer behind the ship (chase) or along the frame edges (cockpit).
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _v.set(0, 0, 18).applyQuaternion(w.shipWorldQuat).add(w.shipWorldPos);
    _v.set(_v.x - ctx.cameraWorld.x, _v.y - ctx.cameraWorld.y, _v.z - ctx.cameraWorld.z).project(cam);
    const behind = _v.z > 1;
    plasmaShimmer.x = _v.x * 0.5 + 0.5;
    plasmaShimmer.y = _v.y * 0.5 + 0.5;
    plasmaShimmer.radius = 0.12 + 0.16 * heat;
    const on = quality.settings.shimmer ? c.plasmaShimmer : 0;
    plasmaShimmer.amount = behind || cockpit ? 0 : heat * on;
    plasmaShimmer.edge = cockpit ? heat * on : 0;

    const amp = 0.22 * heat * heat;
    shake.x = amp * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 91.7 + 1.0) * 0.4);
    shake.y = amp * (Math.sin(t * 43.3 + 2.0) * 0.6 + Math.sin(t * 77.9 + 4.0) * 0.4);
    // Edge glow: full in the cockpit, a faint rim in chase view.
    return heat * c.plasmaEdgeGlow * (cockpit ? 1 : 0.3);
  }
}
