import { mulberry32 } from '../../core/rng';

/**
 * Boids in a flat tangent frame: x east, y up (meters above the body radius), z south.
 * Pure math, no Three, so tests can run it. Rules: separation, alignment and cohesion, plus a
 * wander, a seek toward a point that circles the flock's home, and a floor above the ground.
 */
export interface BoidParams {
  minSpeed: number;
  maxSpeed: number;
  sepRadius: number;
  neighRadius: number;
  /** Accelerations in m/s^2 at full strength. */
  sepW: number;
  aliW: number;
  cohW: number;
  seekW: number;
  wanderW: number;
  /** Keep at least this far above the ground. */
  floorClear: number;
  /** Preferred height above the ground. */
  hover: number;
  /** Never climb above this height over the ground. */
  ceiling: number;
}

export const BIRD_PARAMS: BoidParams = {
  minSpeed: 9,
  maxSpeed: 17,
  sepRadius: 7,
  neighRadius: 48,
  sepW: 16,
  aliW: 3.2,
  cohW: 1.1,
  seekW: 4.5,
  wanderW: 3,
  floorClear: 22,
  hover: 110,
  ceiling: 1500,
};

export interface Threat {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class Flock {
  readonly n: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** Smoothed roll, radians (positive: right wing down). */
  readonly bank: Float32Array;
  readonly phase: Float32Array;
  /** 0 gliding .. 1 flapping hard. */
  readonly flap: Float32Array;
  private readonly wander: Float64Array;
  private readonly rnd: () => number;
  private ang: number;
  private readonly orbitDir: number;
  private readonly orbitW: number;
  readonly orbitR: number;
  /** Seconds of fright left. */
  panic = 0;
  /** Where the circling target is now. */
  tx = 0;
  ty = 0;
  tz = 0;

  constructor(n: number, seed: number, orbitR: number, readonly params: BoidParams = BIRD_PARAMS, hover = params.hover) {
    this.n = n;
    this.rnd = mulberry32(seed);
    const r = this.rnd;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.bank = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.flap = new Float32Array(n);
    this.wander = new Float64Array(n);
    this.orbitR = orbitR;
    this.orbitDir = r() < 0.5 ? -1 : 1;
    const speed = (params.minSpeed + params.maxSpeed) * 0.5;
    this.orbitW = (speed * 0.6) / orbitR;
    this.ang = r() * Math.PI * 2;
    this.hover = hover;
    this.tx = Math.cos(this.ang) * orbitR;
    this.tz = Math.sin(this.ang) * orbitR;
    const heading = this.ang + this.orbitDir * Math.PI * 0.5;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 45;
      this.px[i] = this.tx + Math.cos(a) * d;
      this.pz[i] = this.tz + Math.sin(a) * d;
      this.py[i] = hover + (r() - 0.5) * 30;
      const h = heading + (r() - 0.5) * 0.6;
      const s = speed * (0.9 + 0.2 * r());
      this.vx[i] = Math.cos(h) * s;
      this.vz[i] = Math.sin(h) * s;
      this.phase[i] = r() * 6.28;
      this.wander[i] = r() * 6.28;
      this.flap[i] = 0.3;
    }
  }

  /** Preferred height above the ground for the flock. */
  hover: number;

  /** Flock centre (mean position). */
  centre(out: { x: number; y: number; z: number }): void {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < this.n; i++) {
      x += this.px[i]!;
      y += this.py[i]!;
      z += this.pz[i]!;
    }
    out.x = x / this.n;
    out.y = y / this.n;
    out.z = z / this.n;
  }

  /** Shifts every bird and the circling target (used when the tangent frame is re-anchored). */
  shift(dx: number, dz: number): void {
    for (let i = 0; i < this.n; i++) {
      this.px[i] = this.px[i]! - dx;
      this.pz[i] = this.pz[i]! - dz;
    }
  }

  /**
   * Advances by `dt` seconds. `ground(x, z)` is the terrain height (meters above the radius) at a
   * tangent position. A threat inside its radius scares the flock: it scatters, speeds up and flaps.
   */
  step(dt: number, ground: (x: number, z: number) => number, threat?: Threat | null, speedScale = 1): void {
    const p = this.params;
    const n = this.n;
    const { px, py, pz, vx, vy, vz } = this;
    this.ang += this.orbitDir * this.orbitW * dt * speedScale;
    this.tx = Math.cos(this.ang) * this.orbitR;
    this.tz = Math.sin(this.ang) * this.orbitR;
    const tg = ground(this.tx, this.tz);
    this.ty = Math.min(tg + p.ceiling * 0.8, tg + this.hover);

    if (threat) {
      let near = false;
      for (let i = 0; i < n && !near; i++) {
        const dx = px[i]! - threat.x;
        const dy = py[i]! - threat.y;
        const dz = pz[i]! - threat.z;
        near = dx * dx + dy * dy + dz * dz < threat.radius * threat.radius;
      }
      if (near) this.panic = 3.5;
    }
    this.panic = Math.max(0, this.panic - dt);
    const scared = Math.min(1, this.panic);
    const maxSpeed = (p.maxSpeed * (1 + 0.9 * scared)) * speedScale;
    const minSpeed = p.minSpeed * speedScale;

    const sep2 = p.sepRadius * p.sepRadius * (1 + 3 * scared);
    const nb2 = p.neighRadius * p.neighRadius;
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let cnt = 0;
      const xi = px[i]!;
      const yi = py[i]!;
      const zi = pz[i]!;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = px[j]! - xi;
        const dy = py[j]! - yi;
        const dz = pz[j]! - zi;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > nb2) continue;
        cnt++;
        ax += vx[j]!;
        ay += vy[j]!;
        az += vz[j]!;
        cx += dx;
        cy += dy;
        cz += dz;
        if (d2 < sep2) {
          const k = 1 / (d2 + 1);
          sx -= dx * k;
          sy -= dy * k;
          sz -= dz * k;
        }
      }
      let fx = 0;
      let fy = 0;
      let fz = 0;
      const calm = 1 - 0.7 * scared;
      if (cnt > 0) {
        const inv = 1 / cnt;
        fx += (ax * inv - vx[i]!) * 0.2 * p.aliW * calm + cx * inv * 0.03 * p.cohW * calm;
        fy += (ay * inv - vy[i]!) * 0.2 * p.aliW * calm + cy * inv * 0.03 * p.cohW * calm;
        fz += (az * inv - vz[i]!) * 0.2 * p.aliW * calm + cz * inv * 0.03 * p.cohW * calm;
      }
      fx += sx * p.sepW * 6 * (1 + scared);
      fy += sy * p.sepW * 6 * (1 + scared);
      fz += sz * p.sepW * 6 * (1 + scared);

      // Seek the circling target.
      const dtx = this.tx - xi;
      const dty = this.ty - yi;
      const dtz = this.tz - zi;
      const dl = Math.hypot(dtx, dty, dtz) + 1e-6;
      const sk = (p.seekW * Math.min(1, dl / 90)) / dl;
      fx += dtx * sk * calm;
      fy += dty * sk * 1.4 * calm;
      fz += dtz * sk * calm;

      // Wander: a slowly turning push.
      const w = (this.wander[i] = this.wander[i]! + (this.rnd() - 0.5) * 4 * dt);
      fx += Math.cos(w) * p.wanderW;
      fy += Math.sin(w * 0.7) * p.wanderW * 0.25;
      fz += Math.sin(w) * p.wanderW;

      // Fright: away from the threat, and up.
      if (scared > 0 && threat) {
        const dx = xi - threat.x;
        const dy = yi - threat.y;
        const dz = zi - threat.z;
        const l = Math.hypot(dx, dy, dz) + 1e-6;
        const k = (28 * scared) / l;
        fx += dx * k;
        fy += dy * k * 0.6 + 6 * scared;
        fz += dz * k;
      }

      // Floor and ceiling over the ground, looking a little ahead.
      const g = Math.max(ground(xi, zi), ground(xi + vx[i]! * 1.5, zi + vz[i]! * 1.5));
      const soft = g + p.floorClear * 1.8;
      if (yi < soft) fy += (soft - yi) * 1.2;
      if (yi > g + p.ceiling) fy -= (yi - g - p.ceiling) * 0.5;

      // Integrate, keeping the speed in range.
      let nvx = vx[i]! + fx * dt;
      let nvy = vy[i]! + fy * dt;
      let nvz = vz[i]! + fz * dt;
      // Flat-ish flight: damp the vertical speed.
      nvy *= 1 - Math.min(1, dt * 0.8);
      const s = Math.hypot(nvx, nvy, nvz) + 1e-9;
      const target = Math.min(maxSpeed, Math.max(minSpeed, s));
      const k = target / s;
      nvx *= k;
      nvy *= k;
      nvz *= k;

      // Bank into the turn: horizontal lateral acceleration (positive turns left on a north up map).
      const sh = Math.hypot(nvx, nvz) + 1e-6;
      const turn = (vz[i]! * (nvx - vx[i]!) - vx[i]! * (nvz - vz[i]!)) / (sh * Math.max(dt, 1e-4));
      const wantBank = Math.max(-0.9, Math.min(0.9, -turn * 0.11));
      this.bank[i] = this.bank[i]! + (wantBank - this.bank[i]!) * Math.min(1, dt * 2.5);

      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      px[i] = xi + nvx * dt;
      py[i] = yi + nvy * dt;
      pz[i] = zi + nvz * dt;
      const floor = ground(px[i]!, pz[i]!) + p.floorClear * 0.5;
      if (py[i]! < floor) {
        py[i] = floor;
        if (vy[i]! < 0) vy[i] = 0;
      }

      // Flapping: hard when climbing or scared, gliding on the way down.
      const climb = Math.max(0, Math.min(1, nvy / 4));
      const wantFlap = Math.max(0.12, Math.min(1, 0.25 + climb * 0.7 + scared));
      this.flap[i] = this.flap[i]! + (wantFlap - this.flap[i]!) * Math.min(1, dt * 2);
      this.phase[i] = this.phase[i]! + dt * (2.4 + 5.5 * this.flap[i]!) * Math.PI * 2 * 0.5;
    }
  }
}
