import { Matrix4, Vector3 } from 'three';
import { config } from '../core/config';
import type { Body } from '../sim/universe';
import type { World } from '../sim/world';

/**
 * Moonlight. The brightest satellite of the body under the ship (or the parent planet, when the ship
 * is at a moon: planetshine) becomes a second, faint directional light with a cool silver tint. Chosen
 * from the body hierarchy and sized by angular size and phase, never by id. One set of shared uniform
 * objects goes into every lit material, so nothing is written per view.
 *
 * Eclipses are ignored on purpose: moonlight is a faint cosmetic term.
 */

/** Angular radius (radians) of Earth's Moon seen from Earth: the reference size for "1". */
const REF_ANGULAR = 0.0045;
const SIZE_CAP = 1.5;
/** Silver blue; blended a little toward the source body colour. */
const MOON_TINT: readonly [number, number, number] = [0.62, 0.74, 1.0];

export interface MoonSource {
  body: Body;
  /** 0..SIZE_CAP: phase squared times size. */
  level: number;
}

/**
 * Picks the light source for a ship at `focus`: the child or parent (non star) with the biggest
 * phase times apparent size. Pure apart from the scratch vectors; used by tests.
 */
export function pickMoon(focus: Body, sunPos: Vector3, shipPos: Vector3, outDir: Vector3): MoonSource | null {
  if (focus.kind === 'star') return null;
  let best: MoonSource | null = null;
  const sunDir = _sun.copy(sunPos).sub(focus.position).normalize();
  const cands = focus.parent ? [...focus.children, focus.parent] : focus.children;
  for (const b of cands) {
    if (b.kind === 'star') continue;
    _to.copy(b.position).sub(focus.position);
    const dist = _to.length();
    if (dist < 1) continue;
    _to.divideScalar(dist);
    const lit = 0.5 - 0.5 * _to.dot(sunDir); // 1 when the source is opposite the sun (full)
    const size = Math.min(SIZE_CAP, (b.radius / dist / REF_ANGULAR) ** 2);
    const level = lit * lit * size;
    if (best === null || level > best.level) {
      best = { body: b, level };
      // Direction from the ship to the source.
      outDir.copy(b.position).sub(shipPos).normalize();
    }
  }
  return best;
}

class NightLight {
  /** View space unit direction toward the moon (shared uniform). */
  readonly dirView = { value: new Vector3(0, 1, 0) };
  /** Linear light colour, already scaled: 0 with no moon, about 0.2 full (shared uniform). */
  readonly color = { value: new Vector3(0, 0, 0) };
  /** World (camera axes) unit direction toward the moon. */
  readonly dirWorld = new Vector3(0, 1, 0);
  /** Sky wash colour for the atmosphere pass (faint blue), and its centre direction (world). */
  readonly skyColor = { value: new Vector3(0, 0, 0) };
  /** Scalar light for three.js lights (ship, creatures) before the horizon term. */
  intensity = 0;
  /** 0..1 night weight at the ship (1 when the sun is well below the local horizon). */
  night = 0;
  /** 0..SIZE_CAP of the chosen source, 0 for none. */
  level = 0;
  /** 0..1: the moon above the ship's local horizon. */
  moonUp = 0;
  source: Body | null = null;
  private readonly inv = new Matrix4();

  update(world: World, matrixWorldInverse: Matrix4): void {
    const c = config.night;
    this.inv.copy(matrixWorldInverse);
    const focus = world.ship.frame.body;
    const shipPos = world.shipWorldPos;
    const sunPos = world.universe.root.position;
    const src = c.enabled ? pickMoon(focus, sunPos, shipPos, this.dirWorld) : null;
    this.source = src?.body ?? null;
    if (!src || focus.kind === 'star') {
      this.level = 0;
      this.night = 0;
      this.moonUp = 0;
      this.intensity = 0;
      this.color.value.set(0, 0, 0);
      this.skyColor.value.set(0, 0, 0);
      return;
    }
    // Local night at the ship: sun below the local horizon.
    _up.copy(shipPos).sub(focus.position).normalize();
    _sun.copy(sunPos).sub(shipPos).normalize();
    const sunR = _up.dot(_sun);
    const day = smooth(-0.1, 0.22, sunR);
    this.night = 1 - day;
    this.level = src.level;
    const k = src.level * c.moonLight * c.moonStrength;
    // Tint: silver blue with a trace of the source body colour.
    const bc = src.body.def.visual.color;
    const m = Math.max(bc[0], bc[1], bc[2], 1e-3);
    _tint.set(
      MOON_TINT[0] * 0.8 + (bc[0] / m) * 0.2,
      MOON_TINT[1] * 0.8 + (bc[1] / m) * 0.2,
      MOON_TINT[2] * 0.8 + (bc[2] / m) * 0.2,
    );
    this.color.value.copy(_tint).multiplyScalar(k);
    this.intensity = k * 2.4 * 3;
    _mv.copy(this.dirWorld).transformDirection(this.inv);
    this.dirView.value.copy(_mv);
    // The moon above the local horizon of the ship lifts the sky; the horizon term mirrors the shaders.
    const up = smooth(-0.05, 0.14, _up.dot(this.dirWorld));
    this.moonUp = up;
    this.skyColor.value.set(0.05, 0.09, 0.2).multiplyScalar(src.level * c.moonSky * this.night * (0.35 + 0.65 * up));
  }
}

const _sun = new Vector3();
const _to = new Vector3();
const _up = new Vector3();
const _tint = new Vector3();
const _mv = new Vector3();

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const nightLight = new NightLight();

/**
 * GLSL for lit surfaces. `nightMoon` is the moon's diffuse light at a fragment: N and R are the
 * view space surface and outward radial normals, `term` the day factor. `nightPurkinje` blends a dark,
 * dim lit colour toward a blue grey (rod vision), only when the sun is well below the local horizon (`sunR`).
 */
export const NIGHT_LIGHT_GLSL = /* glsl */ `
  uniform vec3 uNLDir;
  uniform vec3 uNLCol;
  uniform float uNLPurk;
  vec3 nightMoon(vec3 N, vec3 R, float term) {
    float up = smoothstep(-0.05, 0.14, dot(R, uNLDir));
    return uNLCol * max(dot(N, uNLDir), 0.0) * up * (1.0 - term);
  }
  // Only at real night: shade by day and dim dusk keep their own colour (rusty Mars rock stays rusty).
  vec3 nightPurkinje(vec3 col, vec3 lightIn, float sunR) {
    float ll = dot(lightIn, vec3(0.2126, 0.7152, 0.0722));
    float k = (1.0 - smoothstep(0.03, 0.9, ll)) * uNLPurk * (1.0 - smoothstep(-0.22, -0.08, sunR));
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    return mix(col, vec3(lum) * vec3(0.62, 0.82, 1.25), k * 0.8);
  }
`;

/** Uniform objects for the GLSL above (the same objects in every material). */
export const nightUniforms = {
  uNLDir: nightLight.dirView,
  uNLCol: nightLight.color,
  uNLPurk: { value: 0.8 },
};

/** Keeps the Purkinje uniform in step with config (call once per frame). */
export function syncNightUniforms(): void {
  nightUniforms.uNLPurk.value = config.night.enabled ? config.night.purkinje : 0;
}
