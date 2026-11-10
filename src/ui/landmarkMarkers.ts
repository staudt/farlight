import { Quaternion, Vector3 } from 'three';
import { config } from '../core/config';
import type { GameRenderer } from '../render/renderer';
import type { LandmarkTarget } from '../sim/landmarks';
import type { World } from '../sim/world';
import { formatDistance, noDashes } from './format';

const _rel = new Vector3();
const _qi = new Quaternion();
const _bq = new Quaternion();
const _cam = new Vector3();

interface Marker {
  el: HTMLElement;
  label: HTMLElement;
  shown: boolean;
  text: string;
  x: number;
  y: number;
}

/**
 * Faint diamond markers over the landmarks of the body you are at: "?" while undiscovered, the
 * name once found. Shown within line of sight and `config.landmarks.markerRange`. The current
 * target has its own marker, so it is skipped here.
 */
export class LandmarkMarkers {
  private readonly layer: HTMLElement;
  private readonly markers = new Map<LandmarkTarget, Marker>();

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly gfx: GameRenderer,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'sky-labels lm-markers';
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    (root.querySelector('.hud-layer') ?? root).appendChild(this.layer);
  }

  private markerFor(l: LandmarkTarget): Marker {
    let m = this.markers.get(l);
    if (!m) {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', opacity: '0', transition: 'opacity 0.5s', whiteSpace: 'nowrap' });
      const dia = document.createElement('i');
      Object.assign(dia.style, {
        position: 'absolute',
        left: '-7px',
        top: '-7px',
        width: '14px',
        height: '14px',
        boxSizing: 'border-box',
        border: '1px solid rgba(170, 240, 255, 0.95)',
        transform: 'rotate(45deg)',
        boxShadow: '0 0 8px rgba(95, 242, 255, 0.35)',
      });
      const label = document.createElement('span');
      Object.assign(label.style, {
        position: 'absolute',
        left: '16px',
        top: '-9px',
        font: '600 13px Rajdhani, sans-serif',
        letterSpacing: '0.24em',
        color: 'rgba(190, 240, 255, 0.78)',
        textShadow: '0 0 6px rgba(0, 0, 0, 0.7)',
      });
      el.append(dia, label);
      this.layer.appendChild(el);
      m = { el, label, shown: false, text: '', x: -1e9, y: -1e9 };
      this.markers.set(l, m);
    }
    return m;
  }

  private frame = 0;

  update(): void {
    // Phones: half rate is plenty for DOM labels and saves main thread time.
    if (document.body.classList.contains('touch') && this.frame++ % 2 === 1) return;
    const w = this.world;
    const cam = this.gfx.camera;
    const body = w.ship.frame.body;
    const list = config.landmarks.enabled ? w.landmarks.of(body) : [];
    for (const [l, m] of this.markers) if (!list.includes(l) && m.shown) this.hide(m);
    if (list.length === 0) return;
    const camPos = this.gfx.shipCamera.worldPos;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    _qi.copy(cam.quaternion).invert();
    // Camera in body fixed coordinates for the line of sight test.
    _cam.copy(camPos).sub(body.position).applyQuaternion(_bq.copy(body.rotation).invert());
    const camLen = _cam.length();
    const range = config.landmarks.markerRange;

    for (const l of list) {
      const m = this.markerFor(l);
      let show = l !== w.target;
      let sx = 0;
      let sy = 0;
      let dist = 0;
      if (show) {
        _rel.copy(l.position).sub(camPos);
        dist = _rel.length();
        if (dist > range) show = false;
        else if (!this.visibleFrom(l, camLen)) show = false;
        else {
          _rel.applyQuaternion(_qi);
          if (_rel.z >= 0) show = false;
          else {
            const depth = -_rel.z;
            const nx = _rel.x / depth / (tanHalf * cam.aspect);
            const ny = _rel.y / depth / tanHalf;
            if (Math.abs(nx) > 0.96 || Math.abs(ny) > 0.93) show = false;
            sx = (nx * 0.5 + 0.5) * W;
            sy = (-ny * 0.5 + 0.5) * H;
          }
        }
      }
      if (!show) {
        if (m.shown) this.hide(m);
        continue;
      }
      if (!m.shown) {
        m.shown = true;
        m.el.style.opacity = '1';
      }
      const text = l.discovered ? `${noDashes(l.def.name).toUpperCase()} ${formatDistance(dist)}` : '?';
      if (text !== m.text) {
        m.text = text;
        m.label.textContent = text;
      }
      if (Math.abs(sx - m.x) >= 0.5 || Math.abs(sy - m.y) >= 0.5) {
        m.x = sx;
        m.y = sy;
        m.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      }
    }
  }

  private hide(m: Marker): void {
    m.shown = false;
    m.el.style.opacity = '0';
  }

  /** Horizon test: is the landmark above the sphere's horizon as seen from the camera? */
  private visibleFrom(l: LandmarkTarget, camLen: number): boolean {
    const R = l.body.radius + (Number.isNaN(l.groundHeight) ? 0 : l.groundHeight);
    const rs = R - 40;
    if (camLen <= rs) return true;
    const cosAngle = _cam.dot(l.dir) / camLen;
    const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
    const limit = Math.acos(Math.min(1, rs / camLen)) + Math.acos(Math.min(1, rs / R));
    return angle <= limit;
  }
}
