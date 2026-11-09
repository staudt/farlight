import { Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { config } from '../core/config';
import type { PadFrame } from '../input/gamepad';
import type { Input } from '../input/input';
import type { PostStack } from '../render/post';
import type { CameraOverride } from '../render/camera/shipCamera';
import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';
import './photoMode.css';

const HOUR = 3600;

/** Pure: a time scrub in hours to a label without dashes. */
export function timeOffsetLabel(hours: number): string {
  const a = Math.abs(hours);
  if (a < 0.05) return 'NOW';
  return `${a.toFixed(1)} H ${hours < 0 ? 'EARLIER' : 'LATER'}`;
}

/** Pure: log zoom, clamped to the photo distance limits. */
export function zoomDistance(dist: number, factor: number): number {
  const c = config.photo;
  return Math.min(c.distMax, Math.max(c.distMin, dist * factor));
}

/**
 * Photo mode: the sim clock pauses, HUD and touch controls hide, and the camera orbits the
 * ship freely. A small panel offers FOV, a time of day scrub, toggles and PNG capture.
 */
export class PhotoMode {
  active = false;
  shipVisible = true;
  fov = config.photo.fov;
  /** Scrub offset from the time photo mode was entered, hours. */
  hours = 0;

  // Orbit state, in ship local space so the camera follows the ship and its planet.
  yaw = 0;
  pitch = 0.2;
  dist = 34;
  roll = 0;
  readonly pan = new Vector3();

  private readonly panel: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly els: Record<string, HTMLElement> = {};
  private readonly quat = new Quaternion();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private idle = 0;
  private enteredAt = 0;
  private savedBias = 0;
  private savedDarkness = 0;
  private cloudsOn = true;
  private vignetteOn = true;
  private appliedHours = 0;
  private readonly rig: CameraOverride = {
    shipVisible: true,
    fov: config.photo.fov,
    update: (world, camera, out) => this.place(world, camera, out),
  };

  constructor(
    private readonly world: World,
    private readonly gfx: GameRenderer,
    private readonly post: PostStack,
    private readonly input: Input,
    private readonly systemId: string,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'pm-panel';
    this.panel.innerHTML = `
      <div class="pm-sliders">
        <label><span class="pm-l">FOV</span><input type="range" data-k="fov" min="${config.photo.fovMin}" max="${config.photo.fovMax}" step="1"><span class="pm-v" data-k="fovv"></span></label>
        <label><span class="pm-l">TIME</span><input type="range" data-k="time" min="-12" max="12" step="0.05" value="0"><span class="pm-v" data-k="timev"></span></label>
      </div>
      <div class="pm-row">
        <button type="button" class="pm-b on" data-k="ship">SHIP</button>
        <button type="button" class="pm-b on" data-k="clouds">CLOUDS</button>
        <button type="button" class="pm-b on" data-k="vig">VIGNETTE</button>
        <button type="button" class="pm-b pm-cap" data-k="capture">CAPTURE</button>
        <button type="button" class="pm-b pm-x" data-k="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`;
    this.flash = document.createElement('div');
    this.flash.className = 'pm-flash';
    document.body.append(this.panel, this.flash);
    for (const el of this.panel.querySelectorAll<HTMLElement>('[data-k]')) this.els[el.dataset.k as string] = el;

    const fov = this.els.fov as HTMLInputElement;
    fov.addEventListener('input', () => {
      this.fov = Number(fov.value);
      this.syncLabels();
    });
    const time = this.els.time as HTMLInputElement;
    time.addEventListener('input', () => {
      this.hours = Number(time.value);
      this.syncLabels();
    });
    this.els.ship!.addEventListener('click', () => {
      this.shipVisible = !this.shipVisible;
      this.syncLabels();
    });
    this.els.clouds!.addEventListener('click', () => {
      this.cloudsOn = !this.cloudsOn;
      this.applyToggles();
    });
    this.els.vig!.addEventListener('click', () => {
      this.vignetteOn = !this.vignetteOn;
      this.applyToggles();
    });
    this.els.capture!.addEventListener('click', () => this.capture());
    this.els.close!.addEventListener('click', () => this.exit());

    const wake = (): void => {
      this.idle = 0;
    };
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, wake, { passive: true });

    const canvas = gfx.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    window.addEventListener('keydown', (e) => {
      if (this.active && e.code === 'Escape') this.exit();
    });
    input.on('photo', () => this.toggle());
    input.on('capture', () => this.capture());
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.active || this.world.clock.paused) return;
    if (document.getElementById('map')?.style.display === 'block') return;
    const c = config.photo;
    this.active = true;
    this.enteredAt = this.world.clock.time;
    this.world.clock.paused = true;
    this.hours = 0;
    this.appliedHours = 0;
    this.yaw = 0;
    this.pitch = 0.2;
    this.roll = 0;
    this.dist = Math.min(c.distMax, Math.max(c.distMin, config.camera.chaseDistance));
    this.pan.set(0, 0, 0);
    this.fov = c.fov;
    this.shipVisible = true;
    this.cloudsOn = true;
    this.vignetteOn = true;
    this.savedBias = this.post.clouds.coverageBias;
    this.savedDarkness = this.post.vignette.darkness;
    this.quat.copy(this.gfx.camera.quaternion);
    this.gfx.shipCamera.override = this.rig;
    this.input.lockEnabled = false;
    this.input.rightMouse = false;
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.classList.add('photo');
    (this.els.fov as HTMLInputElement).value = String(this.fov);
    (this.els.time as HTMLInputElement).value = '0';
    this.syncLabels();
    this.applyToggles();
    this.idle = 0;
    this.panel.classList.add('on');
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.pointers.clear();
    this.gfx.shipCamera.override = null;
    this.post.clouds.coverageBias = this.savedBias;
    this.post.vignette.darkness = this.savedDarkness;
    if (this.appliedHours !== 0) {
      this.world.clock.time = this.enteredAt;
      this.world.refresh();
    }
    this.world.clock.paused = false;
    this.input.lockEnabled = true;
    document.body.classList.remove('photo');
    this.panel.classList.remove('on', 'hide');
  }

  private applyToggles(): void {
    this.post.clouds.coverageBias = this.cloudsOn ? this.savedBias : -1;
    this.post.vignette.darkness = this.vignetteOn ? this.savedDarkness : 0;
    this.syncLabels();
  }

  private syncLabels(): void {
    this.els.fovv!.textContent = `${Math.round(this.fov)}`;
    this.els.timev!.textContent = timeOffsetLabel(this.hours);
    this.els.ship!.classList.toggle('on', this.shipVisible);
    this.els.clouds!.classList.toggle('on', this.cloudsOn);
    this.els.vig!.classList.toggle('on', this.vignetteOn);
  }

  // Pointer: one finger or mouse drag orbits, two fingers pinch zoom.

  private onDown(e: PointerEvent): void {
    if (!this.active) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinch = this.pinchDistance();
  }

  private onMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!this.active || !p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      const k = config.photo.orbitSpeed;
      this.yaw -= dx * k;
      this.pitch = clamp(this.pitch + dy * k, -1.5, 1.5);
    } else if (this.pointers.size === 2) {
      const d = this.pinchDistance();
      if (this.pinch > 0 && d > 0) this.dist = zoomDistance(this.dist, this.pinch / d);
      this.pinch = d;
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = this.pinchDistance();
  }

  private pinchDistance(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  }

  /** Per frame, before the render. Handles keys, wheel, gamepad and the time scrub. */
  tick(realDt: number, pad: PadFrame | null): void {
    if (!this.active) return;
    const c = config.photo;
    const inp = this.input;

    // Zoom: wheel, triggers.
    let zoom = -inp.wheelUsed * c.wheelZoom;
    if (pad) zoom += (pad.lt - pad.rt) * realDt * 1.4;
    if (zoom !== 0) this.dist = zoomDistance(this.dist, Math.exp(zoom));

    // Orbit with the right stick, roll with Q/E.
    if (pad) {
      this.yaw -= pad.lookX * realDt * 1.8;
      this.pitch = clamp(this.pitch + pad.lookY * realDt * 1.4, -1.5, 1.5);
    }
    let roll = 0;
    if (inp.down('KeyQ')) roll -= 1;
    if (inp.down('KeyE')) roll += 1;
    this.roll += roll * c.rollSpeed * realDt;

    // Pan: WASD or the left stick, in camera space.
    let fwd = 0;
    let right = 0;
    if (inp.down('KeyW')) fwd += 1;
    if (inp.down('KeyS')) fwd -= 1;
    if (inp.down('KeyD')) right += 1;
    if (inp.down('KeyA')) right -= 1;
    if (pad) {
      right += pad.moveX;
      fwd -= pad.moveY;
    }
    if (fwd !== 0 || right !== 0) {
      const s = c.panSpeed * this.dist * realDt;
      _v.set(right * s, 0, -fwd * s).applyQuaternion(this.quat);
      _qi.copy(this.world.shipWorldQuat).invert();
      this.pan.add(_v.applyQuaternion(_qi));
    }

    // Time scrub: re-evaluate the universe at the new time, ship untouched.
    if (this.hours !== this.appliedHours) {
      this.appliedHours = this.hours;
      this.world.clock.time = this.enteredAt + this.hours * HOUR;
      this.world.refresh();
    }

    this.rig.shipVisible = this.shipVisible;
    this.rig.fov = this.fov;
    this.idle += realDt;
    const hidden = this.idle > c.panelHide && !this.panel.matches(':hover') && !this.panel.contains(document.activeElement);
    this.panel.classList.toggle('hide', hidden);
  }

  /** CameraOverride: places the camera on its orbit around the ship. */
  private place(world: World, camera: PerspectiveCamera, out: Vector3): void {
    const q = world.shipWorldQuat;
    const cp = Math.cos(this.pitch);
    _off
      .set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp)
      .multiplyScalar(this.dist)
      .add(this.pan)
      .applyQuaternion(q);
    _target.copy(this.pan).applyQuaternion(q).add(world.shipWorldPos);
    out.copy(world.shipWorldPos).add(_off);
    _dir.copy(_target).sub(out);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    _m.lookAt(_zero, _dir, _up);
    this.quat.setFromRotationMatrix(_m);
    _roll.setFromAxisAngle(_z, this.roll);
    this.quat.multiply(_roll);
    camera.quaternion.copy(this.quat);
  }

  capture(): void {
    if (!this.active) return;
    const canvas = this.gfx.renderer.domElement;
    const body = this.world.ship.frame.body.id;
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17);
    const name = `farlight-${this.systemId}-${body}-${stamp}.png`;
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

const _v = new Vector3();
const _off = new Vector3();
const _target = new Vector3();
const _dir = new Vector3();
const _up = new Vector3();
const _zero = new Vector3();
const _z = new Vector3(0, 0, 1);
const _m = new Matrix4();
const _qi = new Quaternion();
const _roll = new Quaternion();
