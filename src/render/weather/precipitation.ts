import {
  BufferGeometry,
  Float32BufferAttribute,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/rng';
import type { RGB, WeatherDef } from '../../data/types';
import { frameToWorldDir } from '../../sim/frames';
import type { Body } from '../../sim/universe';
import type { FrameContext } from '../context';
import type { PostStack } from '../post';
import { acidRainSettings, methaneRainSettings, rainSettings, snowSettings } from './settings';
import { smooth, weatherAmount } from './weatherMap';

const SIZE = 160;
const RAIN_COUNT = 16000;
const SNOW_COUNT = 16000;
const RAIN_FALL = 22;
const SNOW_FALL = 2.6;
const METHANE_FALL = 4.5;

const COMMON_VERT_HEAD = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec3 uAnchor;
  uniform float uSize;
`;

function makeRain(virga: boolean, seed = 5): { object: LineSegments; material: ShaderMaterial } {
  const rnd = mulberry32(seed);
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
      uUp: { value: new Vector3(0, 1, 0) },
      uAlt: { value: 0 },
      uVirga: { value: virga ? 1 : 0 },
      uBoost: { value: virga ? 2.2 : 1 },
      // HDR gain: the atmosphere pass multiplies by transmittance, thick haze would bury plain colours.
      uGain: { value: virga ? 3.2 : 1 },
      uVirgaLo: { value: 0 },
      uVirgaHi: { value: 1 },
    },
    vertexShader: /* glsl */ `${COMMON_VERT_HEAD}
      attribute float aEnd;
      attribute float aRand;
      uniform vec3 uStreak;
      uniform vec3 uUp;
      uniform float uAmount, uAlt, uVirga, uVirgaLo, uVirgaHi, uBoost;
      varying float vAlpha;
      void main() {
        vec3 p = mod(position - uAnchor, uSize) - 0.5 * uSize;
        float edge = max(max(abs(p.x), abs(p.y)), abs(p.z)) / (0.5 * uSize);
        float dist = length(p);
        // Thin out with distance, keep the nearest few meters clear.
        float vis = (1.0 - smoothstep(0.6, 1.0, edge)) * smoothstep(0.5, 3.0, dist);
        // Only some drops are drawn at low intensity.
        vis *= step(aRand, pow(uAmount, 0.45));
        // Virga: the drops evaporate on the way down, so the ground stays dry.
        float h = uAlt + dot(p, uUp);
        vis *= mix(1.0, smoothstep(uVirgaLo, uVirgaHi, h), uVirga);
        vAlpha = min(1.0, vis * (0.9 - 0.8 * aEnd) * (0.6 + 0.4 * aRand) * uBoost);
        vec4 mv = modelViewMatrix * vec4(p + aEnd * uStreak * (0.7 + 0.6 * aRand), 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uGain;
      varying float vAlpha;
      void main() {
        #include <logdepthbuf_fragment>
        if (vAlpha <= 0.002) discard;
        gl_FragColor = vec4(uColor * uGain, vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const object = new LineSegments(geo, material);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return { object, material };
}

function makeSnow(round: boolean, seed = 9): { object: Points; material: ShaderMaterial } {
  const rnd = mulberry32(seed);
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
      uSwirl: { value: round ? 0.12 : 1 },
      uRound: { value: round ? 1 : 0 },
      uGain: { value: round ? 0.75 : 1 },
    },
    vertexShader: /* glsl */ `${COMMON_VERT_HEAD}
      attribute float aRand;
      uniform float uAmount, uTime, uPx, uFlake, uSwirl;
      varying float vAlpha;
      void main() {
        vec3 p = mod(position - uAnchor, uSize) - 0.5 * uSize;
        float edge = max(max(abs(p.x), abs(p.y)), abs(p.z)) / (0.5 * uSize);
        float t = uTime * (0.5 + 0.5 * aRand);
        // Gentle swirl: each flake wanders on its own small loop.
        p += uSwirl * vec3(sin(t + aRand * 40.0) * 1.6, cos(t * 0.8 + aRand * 17.0) * 0.6, cos(t * 0.9 + aRand * 29.0) * 1.6);
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
      uniform float uRound, uGain;
      varying float vAlpha;
      void main() {
        #include <logdepthbuf_fragment>
        if (vAlpha <= 0.002) discard;
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        float d = length(q);
        float soft = 1.0 - smoothstep(0.2, 1.0, d);
        vec3 col = uColor;
        if (uRound > 0.5) {
          // Fat liquid drop: crisp edge, darker rim, bright glint up and to the left.
          soft = 1.0 - smoothstep(0.78, 1.0, d);
          float glint = smoothstep(0.55, 0.0, length(q - vec2(-0.3, 0.3)));
          float rim = smoothstep(0.55, 0.95, d);
          col = mix(uColor * 1.0, uColor * 0.25, rim) + vec3(1.0, 0.92, 0.75) * glint * 0.3;
          if (soft < 0.4) discard;
          soft = 0.95;
        }
        gl_FragColor = vec4(col * uGain, vAlpha * soft);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const object = new Points(geo, material);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return { object, material };
}

interface Layer {
  object: LineSegments | Points;
  material: ShaderMaterial;
  anchor: Vector3;
  amount: number;
  fall: number;
}

/** Rain, acid rain, methane rain and snow in a cube wrapping around the camera. */
export class Precipitation {
  readonly rain = makeRain(false);
  readonly snow = makeSnow(false);
  readonly acid = makeRain(true, 6);
  readonly methane = makeSnow(true, 10);
  /** Strength of acid rain at the camera, 0..1 (for the lens droplets). */
  acidAmount = 0;
  private layers: Layer[];
  private primed = false;
  private vel = new Vector3();
  private up = new Vector3();
  private down = new Vector3();
  private dirLocal = new Vector3();
  private sunDir = new Vector3();
  private rel = new Vector3();
  private target = [0, 0, 0, 0];
  private acidColor = new Vector3(0.72, 0.82, 0.2);
  private methaneColor = new Vector3(1, 0.62, 0.22);

  constructor(private post: PostStack) {
    const mk = (l: { object: LineSegments | Points; material: ShaderMaterial }, fall: number): Layer => {
      const anchor = new Vector3();
      l.material.uniforms.uAnchor!.value = anchor;
      l.object.visible = false;
      return { ...l, anchor, amount: 0, fall };
    };
    this.layers = [mk(this.rain, RAIN_FALL), mk(this.snow, SNOW_FALL), mk(this.acid, RAIN_FALL * 0.8), mk(this.methane, METHANE_FALL)];
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

    const t = this.target;
    t.fill(0);
    let light = 1;
    let alt = 0;
    let base = 1;
    if (body) {
      const atm = body.def.atmosphere!;
      this.up.copy(cam).sub(body.position);
      alt = this.up.length() - body.radius;
      this.up.normalize();
      body.worldToLocalDir(this.up, this.dirLocal);
      base = (atm.clouds?.altitude ?? 0.3) * body.atmosphereHeight;
      const altFade = 1 - smooth(base * 0.75, base, alt);
      const time = ctx.simTime;
      const amount = (kind: WeatherDef['kind'], s: { enabled: boolean; intensity: number; force?: boolean }): number => {
        const d = atm.weather!.find((x) => x.kind === kind);
        if (!d || !s.enabled) return 0;
        const a = s.force ? 1 : weatherAmount(d, this.dirLocal, time, body!);
        return Math.min(1, a * s.intensity) * altFade;
      };
      t[0] = amount('rain', rainSettings);
      t[1] = amount('snow', snowSettings);
      t[2] = amount('acidRain', acidRainSettings);
      t[3] = amount('methaneRain', methaneRainSettings);
      const col = (kind: WeatherDef['kind']): RGB | undefined => atm.weather!.find((x) => x.kind === kind)?.color;
      const ac = col('acidRain');
      if (ac) this.acidColor.set(ac[0], ac[1], ac[2]);
      const mc = col('methaneRain');
      if (mc) this.methaneColor.set(mc[0], mc[1], mc[2]);
      // Daylight brightness: dim at night, dimmer under overcast.
      this.sunDir.copy(w.universe.root.position).sub(body.position).normalize();
      light = 0.1 + 0.9 * smooth(-0.15, 0.35, this.up.dot(this.sunDir));
      light *= 0.8;
    }

    // Weather comes and goes smoothly.
    const k = this.primed ? 1 - Math.exp(-ctx.realDt * 0.7) : 1;
    this.primed = true;
    let any = false;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      l.amount += (t[i]! - l.amount) * k;
      l.object.visible = l.amount > 0.01;
      any ||= l.object.visible;
    }
    this.acidAmount = this.layers[2]!.amount;
    if (!any) return;

    // Ship velocity over the ground in world axes. Particles are fixed in the air.
    frameToWorldDir(w.ship.frame, w.ship.vel, this.vel);
    this.down.copy(this.up).negate();
    const flash = 1 + this.post.clouds.flash * 3;
    const dt = ctx.realDt;
    const px = (ctx.viewportHeight * ctx.renderer.getPixelRatio()) / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));

    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      if (!l.object.visible) continue;
      const u = l.material.uniforms;
      l.anchor.addScaledVector(this.vel, dt).addScaledVector(this.down, -l.fall * dt);
      wrap(l.anchor);
      u.uAmount!.value = i === 2 ? l.amount * 0.6 : i === 3 ? l.amount * 0.2 : l.amount;
      if (i === 0 || i === 2) {
        // Drops move through the view at (fall - ship velocity); streaks trail behind that.
        this.rel.copy(this.down).multiplyScalar(l.fall).sub(this.vel);
        const sp = this.rel.length();
        const len = Math.min(40, Math.max(1.5, sp * 0.06 * rainSettings.streakLength));
        (u.uStreak!.value as Vector3).copy(this.rel).multiplyScalar(-len / Math.max(sp, 1e-3));
        const c = u.uColor!.value as Vector3;
        const s = light * flash;
        if (i === 0) {
          // Colour carries the lighting; alpha stays put.
          c.set(0.3 * s, 0.38 * s, 0.52 * s);
        } else {
          // Sickly sulphur drops, lit by the orange gloom.
          c.copy(this.acidColor).multiplyScalar(Math.max(0.35, s) * 1.15);
          (u.uUp!.value as Vector3).copy(this.up);
          u.uAlt!.value = alt;
          u.uVirgaLo!.value = base * 0.02;
          u.uVirgaHi!.value = base * 0.2;
        }
        c.multiplyScalar(1 / Math.max(1, Math.max(c.x, c.y, c.z)));
      } else {
        u.uTime!.value = ctx.realTime;
        u.uPx!.value = px;
        if (i === 1) {
          u.uFlake!.value = 0.16 * snowSettings.flakeSize;
          const s = Math.min(1.4, light * flash);
          (u.uColor!.value as Vector3).set(s, s * 1.0, s * 1.03);
        } else {
          u.uFlake!.value = 0.55 * methaneRainSettings.dropSize;
          const s = Math.min(0.8, Math.max(0.25, light * flash) * 0.8);
          (u.uColor!.value as Vector3).copy(this.methaneColor).multiplyScalar(s);
        }
      }
    }
  }
}

function wrap(v: Vector3): void {
  v.x = ((v.x % SIZE) + SIZE) % SIZE;
  v.y = ((v.y % SIZE) + SIZE) % SIZE;
  v.z = ((v.z % SIZE) + SIZE) % SIZE;
}
