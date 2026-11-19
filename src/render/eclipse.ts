import { Vector3, Vector4 } from 'three';
import { config } from '../core/config';
import type { World } from '../sim/world';
import type { Universe, Body } from '../sim/universe';

/**
 * Eclipses and moon shadows, shared by every shader that is lit by the sun.
 *
 * One set of uniforms (`eclipse.uniforms`) describes the sun and up to four occluder spheres,
 * all relative to the camera (floating origin, world axes). The GLSL chunk `eclipseLight(p, self)`
 * returns the light multiplier at a camera relative point; `self` is the body index of the
 * material's own body, which is skipped. The CPU twin (`sunLightAt`, `sunVisibilityAt`) runs the
 * same maths (`sunFraction`) for the ship light, stars, glow and audio.
 *
 * Feel over accuracy: the sun is shrunk by `config.eclipse.sunSizeScale` for shadow maths only,
 * so total eclipses happen at game scale.
 */

export const ECL_MAX = 4;

/** Plain xyz, so the maths needs no three objects. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Visible fraction (0..1) of a sun disc of radius `sunR` at `sun`, seen from `p`, with a sphere
 * (`oc`, `ocR`) in front of it. Angular radii and separation, with a smooth overlap blend:
 * 0 in the umbra, 1 - (occluder / sun)^2 in the antumbra (annular), smooth in the penumbra.
 */
export function sunFraction(p: V3, sun: V3, sunR: number, oc: V3, ocR: number, soft = 1): number {
  const sx = sun.x - p.x, sy = sun.y - p.y, sz = sun.z - p.z;
  const ox = oc.x - p.x, oy = oc.y - p.y, oz = oc.z - p.z;
  const ds = Math.hypot(sx, sy, sz);
  const dO = Math.hypot(ox, oy, oz);
  if (dO >= ds) return 1;
  if (dO <= ocR) return 0;
  const as = Math.asin(Math.min(1, sunR / ds));
  const ao = Math.asin(Math.min(1, ocR / dO));
  // Angle between the directions, from the cross product (acos of a dot loses precision near 0).
  const cx = sy * oz - sz * oy, cy = sz * ox - sx * oz, cz = sx * oy - sy * ox;
  const sep = Math.atan2(Math.hypot(cx, cy, cz), sx * ox + sy * oy + sz * oz);
  const hi = as + ao;
  if (sep >= hi) return 1;
  const lo = Math.abs(as - ao);
  const inner = ao >= as ? 0 : 1 - (ao / as) * (ao / as);
  if (sep <= lo) return inner;
  const t = Math.pow((sep - lo) / (hi - lo), soft);
  const s = t * t * (3 - 2 * t);
  return inner + (1 - inner) * s;
}

export interface Occluder {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Has an atmosphere: its umbra keeps a dim coloured light instead of black. */
  atmo: boolean;
  /** Body index in the universe. */
  id: number;
}

export interface EclipseParams {
  sunSizeScale: number;
  /** Light left in an atmosphere umbra (already times strength). */
  umbra: readonly [number, number, number];
  soft: number;
}

/** Light multiplier (rgb) at `p`: the product over occluders of mix(umbra or black, 1, visible fraction). */
export function eclipseLightMath(
  p: V3,
  sun: V3,
  sunRadius: number,
  occ: readonly Occluder[],
  count: number,
  selfId: number,
  prm: EclipseParams,
  out: Vector3,
): Vector3 {
  out.set(1, 1, 1);
  const sr = sunRadius * prm.sunSizeScale;
  for (let i = 0; i < count; i++) {
    const o = occ[i]!;
    if (o.id === selfId) continue;
    const v = sunFraction(p, sun, sr, o, o.r, prm.soft);
    if (v >= 1) continue;
    const k = o.atmo ? 1 : 0;
    out.x *= prm.umbra[0] * k * (1 - v) + v;
    out.y *= prm.umbra[1] * k * (1 - v) + v;
    out.z *= prm.umbra[2] * k * (1 - v) + v;
  }
  return out;
}

/** GLSL declarations and `eclipseLight`. Include once per shader (GLSL 1 or 3). */
export const ECLIPSE_GLSL = /* glsl */ `
#define ECL_MAX ${ECL_MAX}
uniform vec4 uEclSun;            // xyz sun centre relative to camera, w shadow radius
uniform vec4 uEclOcc[ECL_MAX];   // xyz centre relative to camera, w radius
uniform vec4 uEclMeta[ECL_MAX];  // x body index, y 1 when the body has an atmosphere
uniform vec4 uEclCfg;            // x occluder count, y penumbra softness
uniform vec3 uEclUmbra;          // light left in an atmosphere umbra

float eclFraction(vec3 p, vec3 oc, float orad) {
  vec3 ts = uEclSun.xyz - p;
  vec3 to = oc - p;
  float ds = length(ts);
  float dO = length(to);
  if (dO >= ds) return 1.0;
  if (dO <= orad) return 0.0;
  float as = asin(min(1.0, uEclSun.w / ds));
  float ao = asin(min(1.0, orad / dO));
  float sep = atan(length(cross(ts, to)), dot(ts, to));
  float hi = as + ao;
  if (sep >= hi) return 1.0;
  float lo = abs(as - ao);
  float inner = ao >= as ? 0.0 : 1.0 - (ao / as) * (ao / as);
  if (sep <= lo) return inner;
  float t = pow((sep - lo) / (hi - lo), uEclCfg.y);
  float s = t * t * (3.0 - 2.0 * t);
  return mix(inner, 1.0, s);
}

// Sunlight multiplier at a point relative to the camera (world axes). self = body index to skip.
vec3 eclipseLight(vec3 p, float self) {
  vec3 L = vec3(1.0);
  int n = int(uEclCfg.x);
  for (int i = 0; i < ECL_MAX; i++) {
    if (i >= n) break;
    vec4 m = uEclMeta[i];
    if (abs(m.x - self) < 0.5) continue;
    vec4 o = uEclOcc[i];
    float v = eclFraction(p, o.xyz, o.w);
    L *= mix(uEclUmbra * m.y, vec3(1.0), v);
  }
  return L;
}
`;

const _dir = new Vector3();
const _sunRel = new Vector3();
const _l = new Vector3();

class Eclipse {
  /** Shared uniforms. Spread these into every material that uses ECLIPSE_GLSL. */
  readonly uniforms = {
    uEclSun: { value: new Vector4(0, 0, 1e30, 1) },
    uEclOcc: { value: Array.from({ length: ECL_MAX }, () => new Vector4(0, 0, 1e30, 1)) },
    uEclMeta: { value: Array.from({ length: ECL_MAX }, () => new Vector4(-1, 0, 0, 0)) },
    uEclCfg: { value: new Vector4(0, 1, 0, 0) },
    uEclUmbra: { value: new Vector3(0, 0, 0) },
  };
  /** Active occluders in world space (float64), for the CPU twin. */
  readonly occluders: Occluder[] = Array.from({ length: ECL_MAX }, () => ({ x: 0, y: 0, z: 0, r: 1, atmo: false, id: -1 }));
  count = 0;
  private readonly sunPos = new Vector3();
  private sunRadius = 1;
  /** Scale for the visible sun disc and glow (1 normally, the shadow sun while something crosses it). */
  discScale = 1;
  private universe: Universe | null = null;
  private readonly ids = new Map<Body, number>();
  private readonly cand: Body[] = [];
  private readonly score: number[] = [];
  private readonly params: EclipseParams = { sunSizeScale: 1, umbra: [0, 0, 0], soft: 1 };

  /** Body index for `self` uniforms; -1 for none. */
  idOf(b: Body | null | undefined): number {
    return b ? (this.ids.get(b) ?? -1) : -1;
  }

  /** Per frame: choose the occluders near the camera and upload the uniforms. */
  update(world: World, cameraWorld: Vector3): void {
    const cfg = config.eclipse;
    const uni = world.universe;
    if (this.universe !== uni) {
      this.universe = uni;
      this.ids.clear();
      uni.bodies.forEach((b, i) => this.ids.set(b, i));
    }
    const prm = this.params;
    prm.sunSizeScale = cfg.sunSizeScale;
    prm.umbra = [cfg.umbraTint[0] * cfg.umbraStrength, cfg.umbraTint[1] * cfg.umbraStrength, cfg.umbraTint[2] * cfg.umbraStrength];
    prm.soft = Math.max(0.2, cfg.penumbraSoft);
    this.discScale = 1;
    this.count = 0;
    const u = this.uniforms;
    u.uEclCfg.value.set(0, prm.soft, 0, 0);
    if (!cfg.enabled) return;

    const sun = uni.root;
    this.sunPos.copy(sun.position);
    this.sunRadius = sun.radius;

    // Candidates: the dominant body, its parent, its children and its siblings, largest in the sky first.
    const dom = uni.dominantBody(cameraWorld);
    const cand = this.cand;
    const score = this.score;
    let n = 0;
    const add = (b: Body | null): void => {
      if (!b || b.kind === 'star') return;
      for (let i = 0; i < n; i++) if (cand[i] === b) return;
      const d = Math.max(b.position.distanceTo(cameraWorld), b.radius);
      const s = b.radius / d;
      let k = n++;
      while (k > 0 && score[k - 1]! < s) {
        cand[k] = cand[k - 1]!;
        score[k] = score[k - 1]!;
        k--;
      }
      cand[k] = b;
      score[k] = s;
    };
    add(dom);
    add(dom.parent);
    for (const c of dom.children) add(c);
    if (dom.parent && dom.parent.kind !== 'star') for (const c of dom.parent.children) add(c);
    const max = Math.min(ECL_MAX, Math.max(0, Math.floor(cfg.maxOccluders)), n);
    for (let i = 0; i < max; i++) {
      const b = cand[i]!;
      const o = this.occluders[i]!;
      o.x = b.position.x;
      o.y = b.position.y;
      o.z = b.position.z;
      o.r = b.radius;
      o.atmo = !!b.def.atmosphere;
      o.id = this.ids.get(b) ?? -1;
      u.uEclOcc.value[i]!.set(o.x - cameraWorld.x, o.y - cameraWorld.y, o.z - cameraWorld.z, o.r);
      u.uEclMeta.value[i]!.set(o.id, o.atmo ? 1 : 0, 0, 0);
    }
    this.count = max;
    _sunRel.copy(sun.position).sub(cameraWorld);
    u.uEclSun.value.set(_sunRel.x, _sunRel.y, _sunRel.z, this.sunRadius * prm.sunSizeScale);
    u.uEclCfg.value.set(max, prm.soft, 0, 0);
    u.uEclUmbra.value.set(prm.umbra[0], prm.umbra[1], prm.umbra[2]);

    // The visible sun shrinks to the shadow sun while a body is near its disc, so a total cover hides all of it.
    if (cfg.discMatch && cfg.sunSizeScale < 1 && max > 0) {
      const sc = cfg.sunSizeScale;
      const ds = _sunRel.length();
      const as = Math.asin(Math.min(1, (this.sunRadius * sc) / ds));
      let f = 1;
      for (let i = 0; i < max; i++) {
        const o = this.occluders[i]!;
        _dir.set(o.x - cameraWorld.x, o.y - cameraWorld.y, o.z - cameraWorld.z);
        const dO = _dir.length();
        if (dO >= ds || dO <= o.r) continue;
        const ao = Math.asin(Math.min(1, o.r / dO));
        const sep = _dir.angleTo(_sunRel);
        const hi = as + ao;
        const t = Math.min(1, Math.max(0, (sep - hi) / (hi * 1.5)));
        f = Math.min(f, sc + (1 - sc) * t * t * (3 - 2 * t));
      }
      this.discScale = f;
    }
  }

  /** Sunlight multiplier at a world position (rgb), skipping `exclude`'s own shadow. */
  sunLightAt(worldPos: Vector3, exclude?: Body | null, out: Vector3 = new Vector3()): Vector3 {
    if (!config.eclipse.enabled || this.count === 0) return out.set(1, 1, 1);
    return eclipseLightMath(worldPos, this.sunPos, this.sunRadius, this.occluders, this.count, this.idOf(exclude), this.params, out);
  }

  /** Luminance of `sunLightAt`: 1 clear, 0 in a black umbra. */
  sunVisibilityAt(worldPos: Vector3, exclude?: Body | null): number {
    const l = this.sunLightAt(worldPos, exclude, _l);
    return 0.2126 * l.x + 0.7152 * l.y + 0.0722 * l.z;
  }
}

export const eclipse = new Eclipse();
