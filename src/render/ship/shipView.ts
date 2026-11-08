import { ConeGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { FrameContext } from '../context';
import { placeRelative } from '../context';

/** Placeholder ship mesh; replaced by the low poly model in render/ship. */
export class ShipView {
  readonly object = new Group();

  constructor() {
    const body = new Mesh(
      new ConeGeometry(3, 18, 5),
      new MeshStandardMaterial({ color: 0xdddddd, flatShading: true, metalness: 0.2, roughness: 0.6 }),
    );
    body.rotation.x = -Math.PI / 2;
    this.object.add(body);
  }

  update(ctx: FrameContext): void {
    const w = ctx.world;
    placeRelative(this.object, w.shipWorldPos, ctx.cameraWorld);
    this.object.quaternion.copy(w.shipWorldQuat);
  }
}
