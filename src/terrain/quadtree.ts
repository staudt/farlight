/**
 * Pure cube-sphere quadtree math, shared by the main thread and the chunk worker.
 * No Three.js imports so it can be unit tested in node.
 */

/** Face basis: normal, right, up with right x up = normal (outward, counter clockwise). */
const FACES: readonly (readonly number[])[] = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1], // +X: a=Y b=Z
  [-1, 0, 0, 0, 0, 1, 0, 1, 0], // -X: a=Z b=Y
  [0, 1, 0, 0, 0, 1, 1, 0, 0], // +Y: a=Z b=X
  [0, -1, 0, 1, 0, 0, 0, 0, 1], // -Y: a=X b=Z
  [0, 0, 1, 1, 0, 0, 0, 1, 0], // +Z: a=X b=Y
  [0, 0, -1, 0, 1, 0, 1, 0, 0], // -Z: a=Y b=X
];

export const FACE_COUNT = 6;
export const CHUNK_GRID = 16;

/** Spherified cube mapping: face coordinates u, v in [-1, 1] -> unit direction. */
export function faceToDir(face: number, u: number, v: number, out: { x: number; y: number; z: number }): void {
  const f = FACES[face]!;
  const cx = f[0]! + u * f[3]! + v * f[6]!;
  const cy = f[1]! + u * f[4]! + v * f[7]!;
  const cz = f[2]! + u * f[5]! + v * f[8]!;
  const x2 = cx * cx;
  const y2 = cy * cy;
  const z2 = cz * cz;
  out.x = cx * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
  out.y = cy * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
  out.z = cz * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
}

/** Face coordinates of the chunk edges: returns [u0, v0, size]. */
export function chunkRect(level: number, x: number, y: number): [number, number, number] {
  const size = 2 / (1 << level);
  return [-1 + x * size, -1 + y * size, size];
}

/** Approximate length in meters of the edge of a chunk. */
export function chunkEdgeLength(radius: number, level: number): number {
  return (radius * Math.PI * 0.5) / (1 << level);
}

/** Smallest level whose chunk edge is at most `targetEdge` meters. */
export function maxLevelFor(radius: number, targetEdge = 400, cap = 16): number {
  const ratio = (radius * Math.PI * 0.5) / targetEdge;
  return Math.max(0, Math.min(cap, Math.ceil(Math.log2(Math.max(1, ratio)))));
}

export const SPLIT_FACTOR = 2.2;
export const MERGE_HYSTERESIS = 1.35;

/** A displayed leaf should split when the camera is closer than `edge * factor`. */
export function shouldSplit(distance: number, edge: number, level: number, maxLevel: number, factor = SPLIT_FACTOR): boolean {
  return level < maxLevel && distance < edge * factor;
}

/** A split node should merge back once the camera is clearly beyond its split distance. */
export function shouldMerge(distance: number, edge: number, factor = SPLIT_FACTOR, hysteresis = MERGE_HYSTERESIS): boolean {
  return distance > edge * factor * hysteresis;
}

/** Distance from a point to a bounding sphere (0 when inside). */
export function distanceToSphere(px: number, py: number, pz: number, cx: number, cy: number, cz: number, r: number): number {
  return Math.max(0, Math.hypot(px - cx, py - cy, pz - cz) - r);
}

/**
 * Horizon test. Camera at distance `camDist` from the body center along unit vector `camDir`;
 * a chunk with unit center direction `dir`, angular radius `angR` and highest point `maxR` is
 * hidden when it is entirely beyond the horizon of the lowest possible surface `minR`.
 */
export function isBeyondHorizon(
  camDir: { x: number; y: number; z: number },
  camDist: number,
  dir: { x: number; y: number; z: number },
  angR: number,
  minR: number,
  maxR: number,
): boolean {
  if (camDist <= minR) return false;
  const cosA = Math.min(1, Math.max(-1, camDir.x * dir.x + camDir.y * dir.y + camDir.z * dir.z));
  const ang = Math.acos(cosA) - angR;
  const horizon = Math.acos(minR / camDist) + (maxR > minR ? Math.acos(minR / maxR) : 0);
  return ang > horizon;
}
