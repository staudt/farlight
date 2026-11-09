import type { Vector3 } from 'three';
import { findEffect } from '../../data/types';
import type { Body } from '../../sim/universe';
import { scorchSettings } from '../weather/settings';
import { smooth } from '../weather/weatherMap';

/**
 * How scorched the camera's sky is, 0..1: near a body with the `scorching` effect the sun grows
 * and turns harsh (see SunView). Fades out with altitude over a few radii, so it reads from the
 * surface and from low orbit but not from across the system.
 */
export class Scorch {
  amount = 0;

  update(dt: number, cameraWorld: Vector3, bodies: readonly Body[]): number {
    let target = 0;
    if (scorchSettings.enabled) {
      for (const b of bodies) {
        const def = findEffect(b.def, 'scorching');
        if (!def) continue;
        const alt = Math.max(0, b.position.distanceTo(cameraWorld) - b.radius);
        target = Math.max(target, def.intensity * (1 - smooth(b.radius * 0.5, b.radius * 6, alt)));
      }
    }
    target *= scorchSettings.intensity;
    this.amount += (target - this.amount) * (1 - Math.exp(-dt * 2));
    return this.amount;
  }
}
