import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/600.css';
import { Vector3 } from 'three';
import type { Input } from '../input/input';
import type { GameRenderer } from '../render/renderer';
import type { Body } from '../sim/universe';
import type { FlightPhase } from '../sim/warp';
import type { World } from '../sim/world';
import { escapeHtml, formatDistance, formatDuration, formatSpeed, noDashes } from './format';
import './hud.css';

const TEXT_INTERVAL = 0.1;
const COMPASS_PX_PER_DEG = 2;
const COMPASS_STEP = 15;
const HINT_SECONDS = 12;
const TOAST_SECONDS = 3.6;

const _rel = new Vector3();
const _up = new Vector3();
const _north = new Vector3();
const _east = new Vector3();
const _fwd = new Vector3();
const _axis = new Vector3();

/** Minimal DOM HUD. Text refreshes about 10 times per second, markers every frame. */
export class Hud {
  private readonly compass: HTMLElement;
  private readonly compassItems: { el: HTMLElement; deg: number }[] = [];
  private readonly compassDeg: HTMLElement;
  private readonly alt: HTMLElement;
  private readonly spd: HTMLElement;
  private readonly speedFill: HTMLElement;
  private readonly speedTick: HTMLElement;
  private readonly boost: HTMLElement;
  private readonly timeBox: HTMLElement;
  private readonly timeValue: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardName: HTMLElement;
  private readonly cardRows: HTMLElement;
  private readonly stickDot: HTMLElement;
  private readonly target: HTMLElement;
  private readonly targetBox: HTMLElement;
  private readonly targetInfo: HTMLElement;
  private readonly edge: HTMLElement;
  private readonly edgeLabel: HTMLElement;
  private readonly alignHint: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly toastBig: HTMLElement;
  private readonly toastSmall: HTMLElement;
  private readonly hints: HTMLElement;
  private readonly prompt: HTMLElement;

  private textTimer = 0;
  private age = 0;
  private toastTimer = 0;
  private limitedTimer = 0;
  private lastPhase: FlightPhase;
  private lastBody: Body;
  private cardBody: Body | null = null;
  private heading = 0;
  private headingValid = false;
  private hudVisible = true;

  constructor(
    private readonly root: HTMLElement,
    private readonly world: World,
    private readonly gfx: GameRenderer,
    private readonly input: Input,
  ) {
    this.lastPhase = world.phase;
    this.lastBody = world.ship.frame.body;
    root.innerHTML = `
      <div class="hud-layer">
        <div class="compass"><div class="compass-wrap" data-k="ribbon"></div><div class="compass-pointer"></div></div>
        <div class="compass-deg" data-k="deg"></div>
        <div class="gauges">
          <div class="gauge-row"><span class="hud-label">ALT</span><span class="hud-value" data-k="alt"></span></div>
          <div class="gauge-row"><span class="hud-label">SPD</span><span class="hud-value" data-k="spd"></span><span class="boost" data-k="boost">BOOST</span></div>
          <div class="speedbar"><div class="speedbar-fill" data-k="fill"></div><div class="speedbar-tick" data-k="tick"></div></div>
        </div>
        <div class="timebox" data-k="time"><div class="note">WARP LIMITED</div><div><span class="hud-label">TIME </span><span class="hud-value" data-k="timev"></span></div></div>
        <div class="bodycard hud-panel" data-k="card"><div class="card-name"><span class="glyph"></span><span data-k="cname"></span></div><div data-k="crows"></div></div>
        <div class="crosshair"><i class="h" style="left:-14px"></i><i class="h" style="left:6px"></i><i class="v" style="top:-14px"></i><i class="v" style="top:6px"></i><i class="ring"></i><div class="stickdot" data-k="stick"></div></div>
        <div class="target" data-k="target"><div class="box" data-k="tbox"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><div class="info" data-k="tinfo"></div></div></div>
        <div class="edgearrow" data-k="edge"><i></i><em data-k="elabel"></em></div>
        <div class="alignhint" data-k="align">HOLD F TO ALIGN</div>
        <div class="toast" data-k="toast"><div class="big" data-k="tbig"></div><div class="small" data-k="tsmall"></div></div>
        <div class="hints hud-panel" data-k="hints">
          <b>CLICK</b> TO FLY · <b>MOUSE</b> STEER · <b>W S</b> THROTTLE · <b>A D</b> ROLL · <b>Q E</b> YAW · <b>SHIFT</b> BOOST · <b>, .</b> TIME · <b>C</b> CAMERA · <b>M</b> MAP · <b>T</b> TARGET · <b>F</b> ALIGN · <b>H</b> HIDE
        </div>
        <div class="clickprompt" data-k="prompt">CLICK TO FLY</div>
      </div>`;
    const q = (k: string): HTMLElement => root.querySelector(`[data-k="${k}"]`) as HTMLElement;
    this.compass = root.querySelector('.compass') as HTMLElement;
    this.compassDeg = q('deg');
    this.alt = q('alt');
    this.spd = q('spd');
    this.speedFill = q('fill');
    this.speedTick = q('tick');
    this.boost = q('boost');
    this.timeBox = q('time');
    this.timeValue = q('timev');
    this.card = q('card');
    this.cardName = q('cname');
    this.cardRows = q('crows');
    this.stickDot = q('stick');
    this.target = q('target');
    this.targetBox = q('tbox');
    this.targetInfo = q('tinfo');
    this.edge = q('edge');
    this.edgeLabel = q('elabel');
    this.alignHint = q('align');
    this.toast = q('toast');
    this.toastBig = q('tbig');
    this.toastSmall = q('tsmall');
    this.hints = q('hints');
    this.prompt = q('prompt');

    const ribbon = q('ribbon');
    const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = 0; d < 360; d += COMPASS_STEP) {
      const el = document.createElement('div');
      const name = names[d];
      el.className = d % 45 === 0 ? 'compass-tick major' : 'compass-tick';
      ribbon.appendChild(el);
      this.compassItems.push({ el, deg: d });
      if (name) {
        const t = document.createElement('div');
        t.className = 'compass-text';
        t.textContent = name;
        ribbon.appendChild(t);
        this.compassItems.push({ el: t, deg: d });
      }
    }

    input.on('hud', () => {
      this.hudVisible = !this.hudVisible;
      root.classList.toggle('hidden', !this.hudVisible);
    });
    input.on('target', () => this.cycleTarget());
    window.addEventListener('keydown', () => this.dismissHints(), { once: true });
    window.addEventListener('click', () => this.dismissHints(), { once: true });
    if (input.touchMode) {
      window.addEventListener('pointerdown', () => this.dismissHints(), { once: true });
      this.hints.innerHTML = 'LEFT THUMB STEER · RIGHT SLIDER THROTTLE · HOLD BOOST';
      this.hints.classList.add('touch');
      this.alignHint.textContent = 'HOLD ALIGN';
    }
  }

  private hintsDismissed = false;

  private dismissHints(): void {
    // Keep the hint visible a little after the first input, then let it fade.
    if (this.hintsDismissed) return;
    this.hintsDismissed = true;
    this.age = Math.max(this.age, HINT_SECONDS - 5);
  }

  private cycleTarget(): void {
    const w = this.world;
    const frameBody = w.ship.frame.body;
    const list = w.universe.bodies
      .filter((b) => b !== frameBody)
      .map((b) => ({ b, d: b.position.distanceTo(w.shipWorldPos) }))
      .sort((a, b) => a.d - b.d)
      .map((e) => e.b);
    if (list.length === 0) return;
    const idx = w.target ? list.indexOf(w.target) : -1;
    w.target = list[(idx + 1) % list.length] ?? null;
  }

  update(realDt: number): void {
    this.age += realDt;
    this.detectEvents();
    this.updateHeading();
    this.updateCompass();
    this.updateStick();
    this.updateTarget();

    this.textTimer -= realDt;
    this.toastTimer -= realDt;
    this.limitedTimer -= realDt;
    if (this.world.warpDropped) this.limitedTimer = 2.5;
    if (this.textTimer <= 0) {
      this.textTimer = TEXT_INTERVAL;
      this.updateText();
    }
    if (this.toastTimer <= 0) this.toast.classList.remove('on');
    this.timeBox.classList.toggle('limited', this.limitedTimer > 0);
    this.hints.classList.toggle('on', this.age < HINT_SECONDS && this.hudVisible);
    const mapOpen = this.root.ownerDocument.getElementById('map')?.style.display === 'block';
    this.prompt.classList.toggle('on', !this.input.touchMode && !this.input.pointerLocked && !mapOpen && this.age > 0.5);
    this.root.style.visibility = mapOpen ? 'hidden' : 'visible';
  }

  // Events and toasts

  /** Gentle message from other systems (survey, travel). */
  notify(big: string, small: string): void {
    this.showToast(big, small);
  }

  private showToast(big: string, small: string): void {
    this.toastBig.textContent = noDashes(big);
    this.toastSmall.textContent = noDashes(small);
    this.toast.classList.add('on');
    this.toastTimer = TOAST_SECONDS;
  }

  private detectEvents(): void {
    const w = this.world;
    const body = w.ship.frame.body;
    const phase = w.phase;
    if (body !== this.lastBody) {
      this.showToast(body.name, 'SPHERE OF INFLUENCE');
      this.lastBody = body;
    } else if (phase !== this.lastPhase) {
      const was = this.lastPhase;
      if (phase === 'landed') this.showToast('LANDED', body.name);
      else if (was === 'landed') this.showToast('LIFTOFF', body.name);
      else if (phase === 'atmosphere') this.showToast(body.name, 'ATMOSPHERE');
      else if (was === 'atmosphere') this.showToast(body.name, 'LEAVING ATMOSPHERE');
    }
    this.lastPhase = phase;
  }

  // Compass

  private updateHeading(): void {
    const ship = this.world.ship;
    const frame = ship.frame;
    this.headingValid = false;
    if (!frame.rotating) return;
    _up.copy(ship.pos);
    if (_up.lengthSq() < 1e-6) return;
    _up.normalize();
    _axis.set(0, 1, 0);
    _north.copy(_axis).addScaledVector(_up, -_axis.dot(_up));
    if (_north.lengthSq() < 1e-8) return;
    _north.normalize();
    // +lon is east (terrain/api.ts), which gives east = north x up.
    _east.crossVectors(_north, _up);
    ship.forward(_fwd);
    // Project onto the horizontal plane; near vertical flight keeps the last heading.
    const n = _fwd.dot(_north);
    const e = _fwd.dot(_east);
    if (n * n + e * e < 1e-4) {
      this.headingValid = true;
      return;
    }
    this.heading = (Math.atan2(e, n) * 180) / Math.PI;
    this.headingValid = true;
  }

  private updateCompass(): void {
    const show = this.world.ship.frame.rotating && this.world.ship.frame.body.kind !== 'star';
    this.compass.style.opacity = show ? '1' : '0';
    this.compassDeg.style.opacity = show ? '1' : '0';
    if (!show) return;
    const half = 180;
    for (const it of this.compassItems) {
      let d = it.deg - this.heading;
      d = ((((d + 180) % 360) + 360) % 360) - 180;
      it.el.style.transform = `translateX(${half + d * COMPASS_PX_PER_DEG}px)`;
      it.el.style.display = Math.abs(d) > 100 ? 'none' : '';
    }
  }

  // Crosshair stick

  private updateStick(): void {
    const s = this.input.stick;
    this.stickDot.style.transform = `translate(${s.x * 60}px, ${s.y * 60}px)`;
    this.stickDot.style.opacity = this.input.pointerLocked && !this.input.touchMode ? '0.85' : '0';
  }

  // Target

  private updateTarget(): void {
    const w = this.world;
    const t = w.target;
    if (!t || !this.hudVisible) {
      this.target.style.opacity = '0';
      this.edge.style.opacity = '0';
      this.alignHint.style.opacity = '0';
      return;
    }
    const cam = this.gfx.camera;
    const W = this.root.clientWidth || window.innerWidth;
    const H = this.root.clientHeight || window.innerHeight;
    _rel.copy(t.position).sub(this.gfx.shipCamera.worldPos);
    const dist = _rel.length();
    _rel.applyQuaternion(cam.quaternion.clone().invert());
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const behind = _rel.z >= 0;
    const depth = Math.max(1e-6, -_rel.z);
    const nx = _rel.x / depth / (tanHalf * cam.aspect);
    const ny = _rel.y / depth / tanHalf;
    const sx = (nx * 0.5 + 0.5) * W;
    const sy = (-ny * 0.5 + 0.5) * H;
    const onScreen = !behind && Math.abs(nx) < 0.96 && Math.abs(ny) < 0.94;

    // Angle off the nose, for the align hint.
    const cosOff = dist > 0 ? -_rel.z / dist : 1;
    const off = Math.acos(Math.max(-1, Math.min(1, cosOff)));
    this.alignHint.style.opacity = off > 0.45 && !this.input.aligning ? '0.85' : '0';

    if (onScreen) {
      const rpx = (t.radius / Math.max(dist, 1) / tanHalf) * (H / 2);
      const size = Math.max(34, Math.min(H * 0.9, rpx * 2 + 16));
      this.target.style.opacity = '1';
      this.edge.style.opacity = '0';
      this.target.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      this.targetBox.style.width = `${size.toFixed(0)}px`;
      this.targetBox.style.height = `${size.toFixed(0)}px`;
      this.targetBox.style.top = '0';
      this.targetBox.style.left = '0';
    } else {
      this.target.style.opacity = '0';
      let dx = behind ? -nx : nx;
      let dy = behind ? ny : -ny;
      if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) dy = 1;
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      const mx = W / 2 - 56;
      const my = H / 2 - 56;
      const k = Math.min(mx / Math.max(1e-4, Math.abs(dx)), my / Math.max(1e-4, Math.abs(dy)));
      const ex = W / 2 + dx * k;
      const ey = H / 2 + dy * k;
      this.edge.style.opacity = '1';
      this.edge.style.transform = `translate(${ex.toFixed(1)}px, ${ey.toFixed(1)}px) rotate(${Math.atan2(dy, dx)}rad)`;
      this.edgeLabel.style.transform = `translate(${(-dx * 34).toFixed(0)}px, ${(-dy * 28 + 14).toFixed(0)}px) rotate(${-Math.atan2(dy, dx)}rad)`;
    }
  }

  // Text, about 10 times per second

  private updateText(): void {
    const w = this.world;
    const ship = w.ship;

    this.alt.textContent = formatDistance(w.env.altitude);
    this.spd.textContent = formatSpeed(ship.speed);
    const cap = Math.max(1, ship.speedCap);
    this.speedFill.style.width = `${Math.min(100, (ship.speed / cap) * 100).toFixed(1)}%`;
    this.speedTick.style.left = `${(ship.throttle * 100).toFixed(1)}%`;
    this.boost.classList.toggle('on', ship.boosting);

    const clock = w.clock;
    if (clock.paused) this.timeValue.textContent = 'PAUSED';
    else {
      const glyphs = '▶'.repeat(Math.min(8, clock.warpIndex + 1));
      this.timeValue.textContent = `×${clock.warp} ${glyphs}`;
    }

    this.compassDeg.textContent = this.headingValid ? `${Math.round((this.heading + 360) % 360)}°` : '';

    // Body card
    const fb = ship.frame.body;
    const showCard = fb.kind !== 'star';
    this.card.classList.toggle('on', showCard);
    if (showCard && this.cardBody !== fb) {
      this.cardBody = fb;
      const info = fb.def.info;
      this.cardName.textContent = fb.name;
      const rows: [string, string][] = [
        ['TYPE', info.type],
        ['ATMOSPHERE', info.atmosphere],
        ['GRAVITY', `${fb.def.physical.surfaceGravity.toFixed(2)} g`],
        ['TEMP', info.temperature],
        ['FEATURES', info.features.join(', ')],
      ];
      this.cardRows.innerHTML = rows
        .map(([k, v]) => `<div class="card-row"><span class="k">${k}</span><span class="v">${escapeHtml(noDashes(v))}</span></div>`)
        .join('');
    }

    // Target info
    const t = w.target;
    if (t) {
      const dist = Math.max(0, t.position.distanceTo(w.shipWorldPos) - t.radius);
      const eta = dist / Math.max(ship.speed, 1) / Math.max(clock.warp, 1);
      this.targetInfo.innerHTML = `<b>${escapeHtml(noDashes(t.name))}</b><span>${formatDistance(dist)}</span><span>${formatDuration(eta)}</span>`;
      this.edgeLabel.textContent = `${noDashes(t.name)} ${formatDistance(dist)}`;
    }
  }
}
