import {
  AdditiveBlending,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
} from 'three';
import type { FrameContext } from '../context';
import { placeRelative } from '../context';
import { NOISE_GLSL } from '../fx/noiseGlsl';
import { buildShipModel, type ShipModel } from './shipModel';

/** Open cone along +Z, base (radius 1) at z=0, tip at z=1. */
function plumeGeometry(): CylinderGeometry {
  const g = new CylinderGeometry(0.12, 1, 1, 14, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 0.5);
  return g;
}

function plumeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLen: { value: 6 }, uIntensity: { value: 1 }, uBoost: { value: 0 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vT;
      varying vec3 vN;
      varying vec3 vV;
      varying vec2 vXY;
      void main() {
        vT = position.z;
        vXY = position.xy;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uLen, uIntensity, uBoost;
      varying float vT;
      varying vec3 vN;
      varying vec3 vV;
      varying vec2 vXY;
      ${NOISE_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float z = vT * uLen;
        float n = fxNoise(vec2(vXY.x * 2.2 + vXY.y * 1.7, z * 0.9 - uTime * 9.0)) * 0.6
                + fxNoise(vec2(vXY.y * 2.9 - vXY.x * 1.3, z * 1.9 - uTime * 14.0)) * 0.4;
        float face = abs(dot(normalize(vN), normalize(-vV)));
        float core = pow(face, 1.6);
        float fade = pow(1.0 - vT, 1.4) * smoothstep(0.0, 0.025, vT);
        float a = fade * (0.25 + 0.75 * core) * (0.55 + 0.9 * n) * uIntensity;
        vec3 outer = vec3(0.05, 0.55, 1.5);
        vec3 inner = vec3(0.55, 1.6, 2.4);
        vec3 col = mix(outer, inner, core);
        col = mix(col, vec3(2.6, 2.7, 2.8), uBoost * core * (1.0 - vT));
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/** The player's ship: low poly glider with glowing engines and a flowing exhaust plume. */
export class ShipView {
  readonly object = new Group();
  private model: ShipModel;
  private discs: Mesh[] = [];
  private plumes: Mesh[] = [];
  private plumeMats: ShaderMaterial[] = [];
  private thr = 0.1;
  private boost = 0;

  constructor() {
    this.model = buildShipModel();
    this.object.add(this.model.group);

    const discGeo = new CircleGeometry(this.model.nozzleRadius, 16);
    const plumeGeo = plumeGeometry();
    for (const n of this.model.nozzles) {
      const disc = new Mesh(discGeo, new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide }));
      disc.position.copy(n);
      disc.position.z += 0.02;
      disc.rotation.y = Math.PI; // face backward (+Z)
      this.discs.push(disc);
      const mat = plumeMaterial();
      const plume = new Mesh(plumeGeo, mat);
      plume.position.copy(n);
      plume.frustumCulled = false;
      plume.renderOrder = 3;
      this.plumes.push(plume);
      this.plumeMats.push(mat);
      this.model.group.add(disc, plume);
    }
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);

    const ship = w.ship;
    const t = ctx.realTime;
    const targetThr = ship.landed ? 0.04 : ship.throttle;
    const targetBoost = ship.boosting && !ship.landed ? 1 : 0;
    const k = 1 - Math.exp(-ctx.realDt / 0.2);
    this.thr += (targetThr - this.thr) * k;
    this.boost += (targetBoost - this.boost) * k;
    const thr = this.thr;
    const boost = this.boost;

    const flicker = 1 + 0.07 * Math.sin(t * 47) + 0.05 * Math.sin(t * 83 + 1.3);
    const len = (1.4 + 9 * Math.pow(thr, 1.1)) * (1 + 0.9 * boost) * flicker;
    const intensity = 0.35 + 0.65 * thr + 0.5 * boost;
    const width = 0.75 + 0.35 * thr + 0.25 * boost;
    const r = this.model.nozzleRadius;
    for (let i = 0; i < this.plumes.length; i++) {
      this.plumes[i]!.scale.set(r * width, r * width, len);
      const u = this.plumeMats[i]!.uniforms;
      u.uTime!.value = t + i * 3.1;
      u.uLen!.value = len;
      u.uIntensity!.value = intensity;
      u.uBoost!.value = boost;
    }
    const glow = 0.4 + 1.3 * thr + 0.9 * boost;
    for (const d of this.discs) {
      (d.material as MeshBasicMaterial).color.setRGB(0.25 * glow, 1.15 * glow, 1.9 * glow);
    }

    // Nav lights: slow blink on the tips, double flash strobe at the tail.
    const blink = (t % 1.5) / 1.5 < 0.22 ? 1 : 0.08;
    (this.model.navLeft.material as MeshBasicMaterial).color.setRGB(2.6 * blink, 0.1 * blink, 0.1 * blink);
    (this.model.navRight.material as MeshBasicMaterial).color.setRGB(0.1 * blink, 2.5 * blink, 0.4 * blink);
    const sp = (t % 2.2) / 2.2;
    const strobeOn = sp < 0.04 || (sp > 0.1 && sp < 0.14) ? 1 : 0.03;
    (this.model.strobe.material as MeshBasicMaterial).color.setScalar(3.2 * strobeOn);
  }
}
