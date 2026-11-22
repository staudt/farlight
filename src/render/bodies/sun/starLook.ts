import { hashInts, mulberry32 } from '../../../core/rng';
import type { RGB, StarDef } from '../../../data/types';

/** Everything the star surface needs, derived from the star data. Pure. */
export interface StarLook {
  /** Colour normalised to a peak of 1 (the HDR gain is applied by the view). */
  tint: RGB;
  /** 0 (red dwarf) .. 1 (blue star): a stand in for temperature, from the colour. */
  heat: number;
  /** Limb darkening per channel: intensity is 1 - u * (1 - mu). Blue darkens most, so the rim goes orange. */
  limbU: RGB;
  /** Granule contrast, weaker on cool stars. */
  granuleContrast: number;
  /** Spot cover threshold on the 0..1 spot field (lower = more spots) and 0..1 faculae strength. */
  spotThreshold: number;
  faculae: number;
  activity: number;
}

/** 0..1 activity: the data field, or a stable value from the body seed. */
export function activityOf(star: Pick<StarDef, 'activity'> | undefined, seed: number): number {
  if (star?.activity !== undefined) return Math.min(1, Math.max(0, star.activity));
  return 0.25 + mulberry32(hashInts(seed, 0xac71))() * 0.5;
}

export function starLook(star: Pick<StarDef, 'color' | 'activity'> | undefined, fallback: RGB, seed: number): StarLook {
  const c = star?.color ?? fallback;
  const peak = Math.max(c[0], c[1], c[2], 1e-3);
  const tint: RGB = [c[0] / peak, c[1] / peak, c[2] / peak];
  // Blue over red: red dwarf about 0.2, Sun about 0.8, blue giant 1.6 or more.
  const ratio = c[2] / Math.max(c[0], 1e-3);
  const heat = Math.min(1, Math.max(0, (ratio - 0.2) / 1.2));
  const k = 0.95 + 0.5 * heat;
  const activity = activityOf(star, seed);
  return {
    tint,
    heat,
    limbU: [0.5 * k, 0.66 * k, 0.86 * k],
    granuleContrast: 0.15 + 0.08 * heat,
    spotThreshold: 0.8 - 0.16 * activity,
    faculae: 0.25 + 0.75 * activity,
    activity,
  };
}

export interface ProminenceArc {
  /** Footpoint centre, unit vector in sun local space (spin axis +Y). */
  centre: [number, number, number];
  /** Unit tangent at the centre: the direction the arc spans. */
  tangent: [number, number, number];
  /** Angular span between the feet, radians. */
  span: number;
  /** Peak height in sun radii. */
  height: number;
  /** Ribbon half width in sun radii. */
  width: number;
  phase: number;
}

/** Deterministic arcs for a star, the first one always at a moderate latitude. */
export function prominenceArcs(seed: number, count: number): ProminenceArc[] {
  const rnd = mulberry32(hashInts(seed, 0x9a0b));
  const out: ProminenceArc[] = [];
  for (let i = 0; i < count; i++) {
    const lat = (rnd() * 2 - 1) * (i === 0 ? 0.7 : 1.15);
    const lon = rnd() * Math.PI * 2;
    const cl = Math.cos(lat);
    const centre: [number, number, number] = [cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon)];
    // Local east and north at the centre, then a random mix: loops mostly follow the latitude lines.
    const east: [number, number, number] = [-Math.sin(lon), 0, Math.cos(lon)];
    const north: [number, number, number] = [-Math.sin(lat) * Math.cos(lon), cl, -Math.sin(lat) * Math.sin(lon)];
    const a = (rnd() - 0.5) * 1.2;
    const t: [number, number, number] = [
      east[0] * Math.cos(a) + north[0] * Math.sin(a),
      east[1] * Math.cos(a) + north[1] * Math.sin(a),
      east[2] * Math.cos(a) + north[2] * Math.sin(a),
    ];
    const span = 0.3 + rnd() * 0.35;
    out.push({ centre, tangent: t, span, height: span * (0.65 + rnd() * 0.4), width: 0.012 + rnd() * 0.012, phase: rnd() * 6.283 });
  }
  return out;
}

/** 0..1 blend of the detailed surface from the disc's on screen pixel radius. */
export function surfaceDetail(pixelRadius: number, start: number, full: number): number {
  if (full <= start) return pixelRadius >= start ? 1 : 0;
  const t = Math.min(1, Math.max(0, (pixelRadius - start) / (full - start)));
  return t * t * (3 - 2 * t);
}

/** Disc radius in pixels for a sphere of radius r at distance d seen with a vertical fov (degrees). */
export function discPixelRadius(r: number, d: number, fovDeg: number, viewportHeight: number): number {
  if (d <= r) return viewportHeight;
  return (Math.asin(r / d) * viewportHeight) / ((fovDeg * Math.PI) / 180);
}
