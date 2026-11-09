import { Quaternion, Vector3 } from 'three';
import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';
import type { Body } from '../sim/universe';
import { noDashes } from './format';

/**
 * Small dim name tags next to distant bodies in the sky, so a bright dot reads as
 * "Jupiter". Hidden for the body you are at, the current target (it has its own marker),
 * bodies behind the local planet, and bodies that already look big.
 */
export class SkyLabels {
  private readonly layer: HTMLElement;
  private readonly labels = new Map<Body, HTMLElement>();

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly gfx: GameRenderer,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'sky-labels';
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    root.appendChild(this.layer);
    for (const b of world.universe.bodies) {
      const el = document.createElement('div');
      el.textContent = noDashes(b.name.toUpperCase());
      Object.assign(el.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        font: '500 10px Rajdhani, sans-serif',
        letterSpacing: '0.28em',
        color: 'rgba(170, 235, 255, 0.62)',
        textShadow: '0 0 6px rgba(0, 0, 0, 0.6)',
        whiteSpace: 'nowrap',
        opacity: '0',
        transition: 'opacity 0.4s',
        borderLeft: '1px solid rgba(120, 230, 255, 0.45)',
        paddingLeft: '6px',
      });
      this.layer.appendChild(el);
      this.labels.set(b, el);
    }
  }

  private readonly state = new Map<HTMLElement, { show: boolean; x: number; y: number }>();

  update(): void {
    const w = this.world;
    const cam = this.gfx.camera;
    const camPos = this.gfx.shipCamera.worldPos;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    _qi.copy(cam.quaternion).invert();
    const local = w.ship.frame.body;

    for (const [b, el] of this.labels) {
      let show = b !== local && b !== w.target;
      let sx = 0;
      let sy = 0;
      if (show) {
        _rel.copy(b.position).sub(camPos);
        const dist = _rel.length();
        // Already big in the sky: no label needed.
        if (b.radius / dist > 0.035) show = false;
        // Hidden behind the local body?
        if (show && occluded(camPos, b.position, local)) show = false;
        if (show) {
          _rel.applyQuaternion(_qi);
          if (_rel.z >= 0) show = false;
          else {
            const depth = -_rel.z;
            const nx = _rel.x / depth / (tanHalf * cam.aspect);
            const ny = _rel.y / depth / tanHalf;
            if (Math.abs(nx) > 0.95 || Math.abs(ny) > 0.92) show = false;
            sx = (nx * 0.5 + 0.5) * W;
            sy = (-ny * 0.5 + 0.5) * H;
            const rpx = Math.max(4, ((b.radius * Math.max(1, b.minApparentSize / (2 * b.radius / dist))) / dist / tanHalf) * (H / 2));
            sx += rpx + 6;
            sy -= 6;
          }
        }
      }
      // Touch the DOM only on change: style writes and string building are per frame costs.
      let st = this.state.get(el);
      if (!st) this.state.set(el, (st = { show: false, x: -1e9, y: -1e9 }));
      if (st.show !== show) {
        st.show = show;
        el.style.opacity = show ? '1' : '0';
      }
      if (show && (Math.abs(sx - st.x) >= 0.5 || Math.abs(sy - st.y) >= 0.5)) {
        st.x = sx;
        st.y = sy;
        el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      }
    }
  }
}

/** True when the segment camera -> target passes through the body's sphere. */
function occluded(from: Vector3, to: Vector3, body: Body): boolean {
  _d.copy(to).sub(from);
  const len = _d.length();
  _d.divideScalar(len);
  _oc.copy(from).sub(body.position);
  const b = _oc.dot(_d);
  const c = _oc.lengthSq() - body.radius * body.radius;
  if (c < 0) return false;
  const disc = b * b - c;
  if (disc < 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < len;
}

const _rel = new Vector3();
const _qi = new Quaternion();
const _d = new Vector3();
const _oc = new Vector3();
