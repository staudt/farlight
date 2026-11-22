import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { config } from '../../core/config';
import { placeRelative, type FrameContext } from '../context';
import { TIPS } from './contrails';
import { streamerGeometry } from './reentry';
import { NOISE_GLSL } from './noiseGlsl';
import { smooth, VaporPulse } from './speedFx';

/** Ship space: the nose and the length the cone covers. */
const NOSE_Z = -9.5;
const CONE_LEN = 24;
const CONE_R = 9;
const NOZZLES: [number, number, number][] = [
  [2.9, 0.05, 10.9],
  [-2.9, 0.05, 10.9],
];

function coneMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uProg: { value: 0 }, uTime: { value: 0 } },
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
      uniform float uAmt, uProg, uTime;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vL;
      ${NOISE_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        // vL.z runs 0 at the nose to 1 at the base of the cone.
        float v = vL.z;
        float face = abs(dot(normalize(vN), normalize(-vV)));
        float rim = pow(1.0 - face, 1.3);
        float n = fxNoise(vec2(atan(vL.x, vL.y) * 3.0, v * 6.0 - uTime * 3.0));
        // Wispy skin, thicker toward the base, and a bright shock ring that sweeps back.
        float skin = (0.2 + 0.8 * rim) * (0.15 + 0.85 * n) * smoothstep(0.0, 0.25, v);
        float ring = exp(-pow((v - uProg) * 9.0, 2.0)) * (0.6 + 0.6 * n);
        float a = uAmt * (skin * (0.3 + 0.5 * v) + ring * 0.9);
        vec3 col = mix(vec3(0.85, 0.95, 1.15), vec3(1.6, 1.7, 1.8), ring);
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.6));
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}


/** Wingtip vortex: a thin white helix strip trailing from the tip, camera facing. */
function vortexMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAmt: { value: 0 }, uLen: { value: 60 }},
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aT;
      attribute float aSide;
      uniform float uTime, uLen;
      varying float vT;
      varying float vSide;
      void main() {
        vT = aT;
        vSide = aSide;
        float r = 0.3 + aT * 1.6;
        float ph = aT * 26.0 - uTime * 30.0;
        // Helix around a path that drifts outward and up as it ages.
        vec3 p = vec3(cos(ph) * r, aT * uLen * 0.02 + sin(ph) * r, aT * uLen);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 dir = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vec3 sideV = cross(dir, normalize(mv.xyz));
        float sl = length(sideV);
        sideV = sl > 1e-4 ? sideV / sl : vec3(1.0, 0.0, 0.0);
        mv.xyz += sideV * aSide * (0.22 + 0.9 * aT);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uAmt;
      varying float vT;
      varying float vSide;
      void main() {
        #include <logdepthbuf_fragment>
        float across = 1.0 - vSide * vSide;
        float a = uAmt * across * across * pow(1.0 - vT, 1.4) * smoothstep(0.0, 0.03, vT + 0.03);
        gl_FragColor = vec4(vec3(1.5, 1.6, 1.8), clamp(a * 0.7, 0.0, 0.7));
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

const _fwd = new Vector3();
const _prev = new Vector3();

/**
 * Boost in air: a brief Prandtl Glauert style condensation cone when boosting through dense air near
 * the speed cap, shock diamonds in the exhaust, and wingtip vortices on hard turns.
 */
export class BoostFx {
  readonly object = new Group();
  private cone: Mesh;
  private coneMat = coneMaterial();
  private diamonds: Mesh[] = [];
  private diamondMat = new MeshBasicMaterial({ color: 0xffffff, blending: AdditiveBlending, transparent: true, depthWrite: false });
  private vortexMat = vortexMaterial();
  private vortices: Mesh[] = [];
  private pulse = new VaporPulse();
  private boost = 0;
  private turn = 0;
  private hasPrev = false;

  constructor() {
    const g = new CylinderGeometry(1, 0.04, 1, 56, 8, true);
    g.rotateX(Math.PI / 2); // +Y to +Z: the point ends at z = 0, the wide end at z = 1
    g.translate(0, 0, 0.5);
    this.cone = new Mesh(g, this.coneMat);
    this.cone.position.set(0, 0, NOSE_Z);
    this.cone.scale.set(CONE_R, CONE_R * 0.8, CONE_LEN);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 7;
    this.cone.visible = false;

    const dg = new SphereGeometry(1, 8, 6);
    for (const n of NOZZLES) {
      for (let i = 0; i < 5; i++) {
        const m = new Mesh(dg, this.diamondMat);
        m.position.set(n[0], n[1], n[2] + 2.6 + i * 2.1);
        m.frustumCulled = false;
        m.renderOrder = 4;
        m.visible = false;
        this.diamonds.push(m);
      }
    }
    const vg = streamerGeometry();
    for (const t of TIPS) {
      const m = new Mesh(vg, this.vortexMat);
      m.position.set(t[0], t[1], t[2]);
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.visible = false;
      this.vortices.push(m);
    }
    this.object.add(this.cone, ...this.diamonds, ...this.vortices);
    this.object.visible = false;
  }

  update(ctx: FrameContext, cockpit: boolean): void {
    const c = config.speedFx;
    const w = ctx.world;
    const ship = w.ship;
    const dt = Math.min(ctx.realDt, 0.1);
    const inAir = w.env.density > 0.001 && !ship.landed;

    // Turn rate from the nose direction (roll does not count).
    _fwd.set(0, 0, -1).applyQuaternion(w.shipWorldQuat);
    if (this.hasPrev && dt > 0) {
      const ang = Math.acos(Math.min(1, Math.max(-1, _fwd.dot(_prev))));
      this.turn += (ang / dt - this.turn) * (1 - Math.exp(-dt / 0.15));
    }
    _prev.copy(_fwd);
    this.hasPrev = true;

    // Vortices.
    const vStrength = c.enabled && inAir ? c.vortices * smooth(c.vortexTurnRate, c.vortexTurnRate + 0.45, this.turn) * smooth(0.04, 0.2, w.env.density) * smooth(70, 200, ship.speed) : 0;
    const showVortex = vStrength > 0.02;
    // Condensation cone pulse.
    const hot = c.enabled && inAir;
    const v = hot ? this.pulse.update(dt, ship.boosting, w.env.density, ship.speed, ship.speedCap) * c.vaporCone : this.pulse.update(dt, false, 0, 0, 1);
    const showCone = v > 0.01 && !cockpit;
    this.cone.visible = showCone;

    // Mach diamonds.
    const bt = ship.boosting && !ship.landed && c.enabled ? 1 : 0;
    this.boost += (bt - this.boost) * (1 - Math.exp(-dt / 0.2));
    const d = this.boost * c.machDiamonds;
    const showDiamonds = d > 0.02 && !cockpit;

    this.object.visible = showCone || showDiamonds || showVortex;
    if (!this.object.visible) return;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);

    const t = ctx.realTime;
    for (let i = 0; i < 2; i++) this.vortices[i]!.visible = showVortex;
    if (showVortex) {
      const u = this.vortexMat.uniforms;
      u.uTime!.value = t;
      u.uAmt!.value = Math.min(1.2, vStrength);
      u.uLen!.value = 40 + 60 * Math.min(1, vStrength);
    }
    if (showCone) {
      const u = this.coneMat.uniforms;
      u.uAmt!.value = v;
      u.uProg!.value = Math.min(1.2, this.pulseAge() * 0.9);
      u.uTime!.value = t;
      const grow = 0.55 + 0.45 * smooth(0, 0.5, this.pulseAge());
      this.cone.scale.set(CONE_R * grow, CONE_R * 0.8 * grow, CONE_LEN);
    }
    for (let i = 0; i < this.diamonds.length; i++) {
      const m = this.diamonds[i]!;
      m.visible = showDiamonds;
      if (!showDiamonds) continue;
      const k = i % 5;
      const fl = 0.85 + 0.15 * Math.sin(t * 55 + i * 1.9);
      const s = (0.52 - k * 0.07) * fl * Math.min(1, d);
      m.scale.set(s, s, s * 1.8 + 0.4);
    }
    const dm = this.diamondMat.color;
    dm.setRGB(1.6 * d, 2.2 * d, 3.2 * d);
    this.diamondMat.opacity = Math.min(1, d);
  }

  private pulseAge(): number {
    return this.pulse.age;
  }
}
