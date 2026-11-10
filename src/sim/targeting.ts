import type { Vector3 } from 'three';

export interface Aimable {
  readonly position: Vector3;
}

/**
 * Orders candidates by how close they are to the crosshair: the angle between the view
 * direction and the direction to each candidate. Things behind the camera come last.
 */
export function orderByAim<T extends Aimable>(cands: readonly T[], camPos: Vector3, forward: Vector3): T[] {
  return cands
    .map((c) => {
      const dx = c.position.x - camPos.x;
      const dy = c.position.y - camPos.y;
      const dz = c.position.z - camPos.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const cos = (dx * forward.x + dy * forward.y + dz * forward.z) / len;
      return { c, angle: Math.acos(Math.max(-1, Math.min(1, cos))) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((e) => e.c);
}

/**
 * Target cycling: a fresh press picks what is nearest the crosshair; presses in quick
 * succession step outward through the same ordering (so a missed pick is one tap away).
 */
export class AimCycler<T extends Aimable> {
  private list: T[] = [];
  private index = -1;
  private lastPress = -Infinity;

  constructor(private readonly repeatWindow = 2.5) {}

  next(now: number, cands: readonly T[], camPos: Vector3, forward: Vector3, current: T | null): T | null {
    const repeat = now - this.lastPress < this.repeatWindow && this.list.length > 0;
    this.lastPress = now;
    if (!repeat) {
      this.list = orderByAim(cands, camPos, forward);
      if (this.list.length === 0) return null;
      // The nearest is already targeted: the press means "the next one".
      this.index = this.list[0] === current && this.list.length > 1 ? 1 : 0;
    } else {
      this.index = (this.index + 1) % this.list.length;
    }
    return this.list[this.index] ?? null;
  }
}
