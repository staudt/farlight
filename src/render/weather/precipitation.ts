import {
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/rng';
import type { WeatherDef } from '../../data/types';
import { frameToWorldDir } from '../../sim/frames';
import type { Body } from '../../sim/universe';
import type { FrameContext } from '../context';
import type { PostStack } from '../post';
import { rainSettings, snowSettings } from './settings';
import { smooth, weatherAmount } from './weatherMap';

const SIZE = 160;
const RAIN_COUNT = 16000;
const SNOW_COUNT = 16000;
const RAIN_FALL = 22;
const SNOW_FALL = 2.6;

const COMMON_VERT_HEAD = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec3 uAnchor;
  uniform float uSize;
`;

function makeRain(): { object: LineSegments; material: ShaderMaterial } {
  const rnd = mulberry32(5);
  const pos = new Float32Array(RAIN_COUNT * 2 * 3);
  const end = new Float32Array(RAIN_COUNT * 2);
  const rand = new Float32Array(RAIN_COUNT * 2);
  for (let i = 0; i < RAIN_COUNT; i++) {
    const x = rnd() * SIZE;
    const y = rnd() * SIZE;
    const z = rnd() * SIZE;
    const r = rnd();
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3;
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      end[i * 2 + k] = k;
      rand[i * 2 + k] = r;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aEnd', new Float32BufferAttribute(end, 1));
  geo.setAttribute('aRand', new Float32BufferAttribute(rand, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uAnchor: { value: new Vector3() },
      uSize: { value: SIZE },
      uStreak: { value: new Vector3() },
      uAmount: { value: 0 },
      uColor: { value: new Vector3(0.3, 0.38, 0.52) },
    },
    vertexShader: /* glsl */ `${COMMON_VERT_HEAD}
      attribute float aEnd;
      attribute float aRand;
      uniform vec3 uStreak;
      uniform float uAmount;
      varying float vAlpha;
      void main() {
        vec3 p = mod(position - uAnchor, uSize) - 0.5 * uSize;
        float edge = max(max(abs(p.x), abs(p.y)), abs(p.z)) / (0.5 * uSize);
        float dist = length(p);
        // Thin out with distance, keep the nearest few meters clear.
        float vis = (1.0 - smoothstep(0.6, 1.0, edge)) * smoothstep(0.5, 3.0, dist);
        // Only some drops are drawn at low intensity.
        vis *= step(aRand, pow(uAmount, 0.45));
        vAlpha = vis * (0.9 - 0.8 * aEnd) * (0.6 + 0.4 * aRand);
        vec4 mv = modelViewMatrix * vec4(p + aEnd * uStreak * (0.7 + 0.6 * aRand), 1.0);
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
        if (vAlpha <= 0.002) discard;
        gl_FragColor = vec4(uColor, vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const object = new LineSegments(geo, material);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return { object, material };
}

function makeSnow(): { object: Points; material: ShaderMaterial } {
  const rnd = mulberry32(9);
  const pos = new Float32Array(SNOW_COUNT * 3);
  const rand = new Float32Array(SNOW_COUNT);
  for (let i = 0; i < SNOW_COUNT; i++) {
    pos[i * 3] = rnd() * SIZE;
    pos[i * 3 + 1] = rnd() * SIZE;
    pos[i * 3 + 2] = rnd() * SIZE;
    rand[i] = rnd();
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRand', new Float32BufferAttribute(rand, 1));
  const material = new ShaderMaterial({
    uniforms: {
      uAnchor: { value: new Vector3() },
      uSize: { value: SIZE },
      uAmount: { value: 0 },
      uTime: { value: 0 },
      uPx: { value: 600 },
      uFlake: { value: 0.2 },
      uColor: { value: new Vector3(1, 1, 1) },
    },
    vertexShader: /* glsl */ `${COMMON_VERT_HEAD}
      attribute float aRand;
      uniform float uAmount, uTime, uPx, uFlake;
      varying float vAlpha;
      void main() {
        vec3 p = mod(position - uAnchor, uSize) - 0.5 * uSize;
        float edge = max(max(abs(p.x), abs(p.y)), abs(p.z)) / (0.5 * uSize);
        float t = uTime * (0.5 + 0.5 * aRand);
        // Gentle swirl: each flake wanders on its own small loop.
        p += vec3(sin(t + aRand * 40.0) * 1.6, cos(t * 0.8 + aRand * 17.0) * 0.6, cos(t * 0.9 + aRand * 29.0) * 1.6);
        float dist = length(p);
        float vis = (1.0 - smoothstep(0.6, 1.0, edge)) * smoothstep(1.0, 4.0, dist) * step(aRand, pow(uAmount, 0.45));
        vAlpha = vis * (0.7 + 0.3 * fract(aRand * 7.31));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = uFlake * (0.5 + fract(aRand * 13.7)) * uPx / max(-mv.z, 0.5);
        gl_PointSize = clamp(size, 1.5, 28.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        #include <logdepthbuf_fragment>
        if (vAlpha <= 0.002) discard;
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float soft = 1.0 - smoothstep(0.2, 1.0, d);
        gl_FragColor = vec4(uColor, vAlpha * soft);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const object = new Points(geo, material);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return { object, material };
}

/** Rain and snow in a 300 m cube wrapping around the camera. */
export class Precipitation {
  readonly rain = makeRain();
  readonly snow = makeSnow();
  private rainAmount = 0;
  private snowAmount = 0;
  private primed = false;
  private rainAnchor = new Vector3();
  private snowAnchor = new Vector3();
  private vel = new Vector3();
  private up = new Vector3();
  private down = new Vector3();
  private dirLocal = new Vector3();
  private sunDir = new Vector3();
  private rel = new Vector3();

  constructor(private post: PostStack) {
    this.rain.material.uniforms.uAnchor!.value = this.rainAnchor;
    this.snow.material.uniforms.uAnchor!.value = this.snowAnchor;
    this.rain.object.visible = false;
    this.snow.object.visible = false;
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    const cam = ctx.cameraWorld;
    let body: Body | null = null;
    for (const b of w.universe.bodies) {
      const atm = b.def.atmosphere;
      if (!atm?.weather?.length) continue;
      if (b.position.distanceTo(cam) < b.radius + b.atmosphereHeight) {
        body = b;
        break;
      }
    }

    let rainT = 0;
    let snowT = 0;
    let light = 1;
    if (body) {
      const atm = body.def.atmosphere!;
      this.up.copy(cam).sub(body.position);
      const alt = this.up.length() - body.radius;
      this.up.normalize();
      body.worldToLocalDir(this.up, this.dirLocal);
      const base = (atm.clouds?.altitude ?? 0.3) * body.atmosphereHeight;
      const altFade = 1 - smooth(base * 0.75, base, alt);
      const time = ctx.simTime;
      const find = (kind: WeatherDef['kind']): WeatherDef | undefined => atm.weather!.find((d) => d.kind === kind);
      const rd = find('rain');
      const sd = find('snow');
      if (rd && rainSettings.enabled) {
        const a = rainSettings.force ? 1 : weatherAmount(rd, this.dirLocal, time, body);
        rainT = Math.min(1, a * rainSettings.intensity) * altFade;
        const c = rd.color;
        if (c) (this.rain.material.uniforms.uColor!.value as Vector3).set(c[0], c[1], c[2]);
      }
      if (sd && snowSettings.enabled) {
        const a = snowSettings.force ? 1 : weatherAmount(sd, this.dirLocal, time, body);
        snowT = Math.min(1, a * snowSettings.intensity) * altFade;
      }
      // Daylight brightness: dim at night, dimmer under overcast.
      this.sunDir.copy(w.universe.root.position).sub(body.position).normalize();
      light = 0.1 + 0.9 * smooth(-0.15, 0.35, this.up.dot(this.sunDir));
      light *= 0.8;
    }

    // Weather comes and goes smoothly.
    if (!this.primed) {
      this.rainAmount = rainT;
      this.snowAmount = snowT;
      this.primed = true;
    } else {
      const k = 1 - Math.exp(-ctx.realDt * 0.7);
      this.rainAmount += (rainT - this.rainAmount) * k;
      this.snowAmount += (snowT - this.snowAmount) * k;
    }

    const showRain = this.rainAmount > 0.01;
    const showSnow = this.snowAmount > 0.01;
    this.rain.object.visible = showRain;
    this.snow.object.visible = showSnow;
    if (!showRain && !showSnow) return;

    // Ship velocity over the ground in world axes. Particles are fixed in the air.
    frameToWorldDir(w.ship.frame, w.ship.vel, this.vel);
    this.down.copy(this.up).negate();
    const flash = 1 + this.post.clouds.flash * 3;
    const dt = ctx.realDt;

    if (showRain) {
      const u = this.rain.material.uniforms;
      this.rainAnchor.addScaledVector(this.vel, dt).addScaledVector(this.down, -RAIN_FALL * dt);
      wrap(this.rainAnchor);
      // Drops move through the view at (fall - ship velocity); streaks trail behind that.
      this.rel.copy(this.down).multiplyScalar(RAIN_FALL).sub(this.vel);
      const sp = this.rel.length();
      const len = Math.min(40, Math.max(1.5, sp * 0.06 * rainSettings.streakLength));
      (u.uStreak!.value as Vector3).copy(this.rel).multiplyScalar(-len / Math.max(sp, 1e-3));
      u.uAmount!.value = this.rainAmount;
      const c = u.uColor!.value as Vector3;
      const s = light * flash;
      // Colour carries the lighting; alpha stays put.
      c.set(0.3 * s, 0.38 * s, 0.52 * s);
      c.multiplyScalar(1 / Math.max(1, Math.max(c.x, c.y, c.z)));
    }
    if (showSnow) {
      const u = this.snow.material.uniforms;
      this.snowAnchor.addScaledVector(this.vel, dt).addScaledVector(this.down, -SNOW_FALL * dt);
      wrap(this.snowAnchor);
      u.uAmount!.value = this.snowAmount;
      u.uTime!.value = ctx.realTime;
      u.uPx!.value = (ctx.viewportHeight * ctx.renderer.getPixelRatio()) / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
      u.uFlake!.value = 0.16 * snowSettings.flakeSize;
      const s = Math.min(1.4, light * flash);
      (u.uColor!.value as Vector3).set(s, s * 1.0, s * 1.03);
    }
  }
}

function wrap(v: Vector3): void {
  v.x = ((v.x % SIZE) + SIZE) % SIZE;
  v.y = ((v.y % SIZE) + SIZE) % SIZE;
  v.z = ((v.z % SIZE) + SIZE) % SIZE;
}
