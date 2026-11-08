/**
 * Terrain height query shared by the sim (main thread) and chunk workers.
 * `dir` is a unit vector in BODY FIXED coordinates. Returns game meters above the body's
 * base radius (water surfaces are clamped to sea level, so this is the walkable surface).
 */
export interface HeightSampler {
  heightAt(x: number, y: number, z: number): number;
}

export const FLAT_SAMPLER: HeightSampler = { heightAt: () => 0 };

/** Body fixed unit direction from latitude and longitude (radians). East is +lon. */
export function latLonToDir(lat: number, lon: number, out: { x: number; y: number; z: number }): void {
  const c = Math.cos(lat);
  out.x = c * Math.cos(lon);
  out.y = Math.sin(lat);
  out.z = -c * Math.sin(lon);
}

export function dirToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  return { lat: Math.asin(Math.max(-1, Math.min(1, y))), lon: Math.atan2(-z, x) };
}
