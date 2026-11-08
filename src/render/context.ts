import type { Object3D, PerspectiveCamera, Vector3, WebGLRenderer } from 'three';
import type { World } from '../sim/world';
import type { Body } from '../sim/universe';

/**
 * Per frame data handed to every view. All `*World` vectors are float64 world positions.
 * Floating origin: the camera always sits at the scene origin, and every object is placed at
 * (worldPos - cameraWorld). Never put a raw world position into a Three object.
 */
export interface FrameContext {
  world: World;
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  cameraWorld: Vector3;
  /** Real seconds since the last frame. */
  realDt: number;
  /** Real seconds since start (for animations that should not speed up with warp). */
  realTime: number;
  /** Sim seconds (for animations that should follow warp, like cloud drift). */
  simTime: number;
  /** Viewport height in pixels, for apparent size math. */
  viewportHeight: number;
}

export interface BodyView {
  readonly body: Body;
  readonly object: Object3D;
  update(ctx: FrameContext): void;
  dispose(): void;
}

/** Sets obj.position to worldPos relative to the camera (double precision subtraction). */
export function placeRelative(obj: Object3D, worldPos: Vector3, cameraWorld: Vector3): void {
  obj.position.set(worldPos.x - cameraWorld.x, worldPos.y - cameraWorld.y, worldPos.z - cameraWorld.z);
}

/** Angular diameter in radians of a sphere of radius r at distance d. */
export function angularDiameter(r: number, d: number): number {
  return d <= r ? Math.PI : 2 * Math.asin(r / d);
}

/**
 * Scale factor that keeps a body at least `minSize` radians wide. Approaching blends
 * smoothly into the true size once it is bigger than the floor.
 */
export function apparentSizeBoost(radius: number, distance: number, minSize: number): number {
  const real = angularDiameter(radius, distance);
  if (real >= minSize) return 1;
  return minSize / Math.max(real, 1e-9);
}
