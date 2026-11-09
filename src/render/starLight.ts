import { Color, Vector3 } from 'three';
import type { StarDef } from '../data/types';

/**
 * Star colour for everything lit by the sun. One shared uniform object (`starLight.uniform`,
 * a linear RGB vec3 tint times an intensity factor) is handed to every shader, so colour flows
 * from the root star's data and no shader names a body.
 *
 * The shaders already hold Sol-like sun colours (warm sunsets, slightly cream noon), so the
 * tint is relative to a reference star colour: the reference maps to exactly white and Sol
 * renders as it always did. Tint is luminance normalised and only partly saturated to stay
 * pretty; brightness comes from the intensity factor.
 */
const REFERENCE: readonly [number, number, number] = [1.0, 0.93, 0.8];
/** 0 = white light, 1 = the full relative star colour. */
const SATURATION = 0.7;
/** Soften the data intensity (M 0.6, B 1.8) so dim stars stay readable and bright ones don't blow out. */
const INTENSITY_EXPONENT = 0.6;
const TINT_MIN = 0.3;
const TINT_MAX = 1.9;

export interface StarLightValue {
  /** Linear RGB tint, luminance about 1 (white for Sol). */
  tint: Vector3;
  /** Scalar brightness factor (1 for Sol). */
  intensity: number;
}

/** Pure: star data to tint and intensity. */
export function computeStarLight(star: StarDef | undefined, out: StarLightValue = { tint: new Vector3(), intensity: 1 }): StarLightValue {
  if (!star) {
    out.tint.set(1, 1, 1);
    out.intensity = 1;
    return out;
  }
  const r = star.color[0] / REFERENCE[0];
  const g = star.color[1] / REFERENCE[1];
  const b = star.color[2] / REFERENCE[2];
  const luma = Math.max(1e-3, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const clampT = (v: number): number => Math.min(TINT_MAX, Math.max(TINT_MIN, 1 + (v / luma - 1) * SATURATION));
  out.tint.set(clampT(r), clampT(g), clampT(b));
  out.intensity = Math.pow(Math.max(0.05, star.intensity), INTENSITY_EXPONENT);
  return out;
}

class StarLight {
  private readonly value: StarLightValue = { tint: new Vector3(1, 1, 1), intensity: 1 };
  private source: StarDef | undefined;
  /** Shared uniform: tint * intensity. Put this same object in every material. */
  readonly uniform = { value: new Vector3(1, 1, 1) };
  readonly tint = this.value.tint;

  get intensity(): number {
    return this.value.intensity;
  }

  /** Call once per frame with the root star's def. Cheap when nothing changed. */
  update(star: StarDef | undefined): void {
    if (star === this.source) return;
    this.source = star;
    computeStarLight(star, this.value);
    this.uniform.value.copy(this.value.tint).multiplyScalar(this.value.intensity);
  }

  /** Tint only, for lights that carry intensity themselves. */
  applyTint(c: Color): void {
    c.setRGB(this.value.tint.x, this.value.tint.y, this.value.tint.z);
  }
}

export const starLight = new StarLight();

/** GLSL declaration to include once per shader that uses `uStarColor`. */
export const STAR_COLOR_GLSL = /* glsl */ `uniform vec3 uStarColor;`;
