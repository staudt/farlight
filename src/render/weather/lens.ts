import type { RGB } from '../../data/types';

interface Drop {
  x: number;
  y: number;
  r: number;
  rMax: number;
  age: number;
  life: number;
  /** Slide speed in px/s, 0 while the drop clings. */
  slide: number;
  hold: number;
}

const MAX_DROPS = 40;

/**
 * Droplets beading on the camera lens while inside rain. A transparent 2D canvas over the
 * game: each drop is a tiny lens (dark rim, tinted body, bright glint) that grows, sometimes
 * slides down and fades. Cheap, no post pass needed.
 */
export class LensDrops {
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private drops: Drop[] = [];
  private spawnAcc = 0;
  private tint: RGB = [0.72, 0.82, 0.2];
  private clean = true;

  private ensure(): boolean {
    if (this.canvas) return !!this.g;
    if (typeof document === 'undefined') return false;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
    c.dataset.layer = 'lens';
    // Right after the game canvas, so it sits under the HUD and the game canvas stays the first canvas.
    const game = document.querySelector('canvas');
    if (game) game.after(c);
    else document.body.append(c);
    this.canvas = c;
    this.g = c.getContext('2d');
    return !!this.g;
  }

  /** `amount` 0..1 rain strength at the camera, `light` 0..1 scene brightness, `speed` ship m/s. */
  update(dt: number, amount: number, color: RGB, light: number, speed: number): void {
    if (amount < 0.02 && this.drops.length === 0) {
      if (!this.clean && this.g && this.canvas) this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.clean = true;
      return;
    }
    if (!this.ensure()) return;
    const c = this.canvas!;
    const g = this.g!;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.tint = color;
    this.clean = false;

    // Spawn: a drop every so often, more when the rain is heavy and the ship is fast.
    this.spawnAcc += dt * (1.5 + 8 * amount) * (1 + Math.min(1, speed / 300));
    while (this.spawnAcc >= 1 && this.drops.length < MAX_DROPS) {
      this.spawnAcc -= 1;
      const r = (2 + Math.random() * Math.random() * 7) * dpr;
      this.drops.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: r * 0.3,
        rMax: r,
        age: 0,
        life: 2.5 + Math.random() * 5,
        slide: Math.random() < 0.4 ? (25 + Math.random() * 90) * dpr : 0,
        hold: 0.4 + Math.random() * 1.2,
      });
    }
    this.spawnAcc = Math.min(this.spawnAcc, 1);

    g.clearRect(0, 0, w, h);
    const [tr, tg, tb] = this.tint;
    const lit = 0.35 + 0.65 * light;
    const body = `rgba(${Math.round(255 * Math.min(1, tr * 1.1 * lit))},${Math.round(255 * Math.min(1, tg * 1.1 * lit))},${Math.round(255 * Math.min(1, tb * 1.1 * lit + 0.1))},`;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i]!;
      d.age += dt;
      if (d.age > d.life) {
        this.drops.splice(i, 1);
        continue;
      }
      const grow = Math.min(1, d.age / 0.6);
      d.r = d.rMax * (0.3 + 0.7 * grow);
      if (d.slide > 0 && d.age > d.hold) d.y += d.slide * dt * Math.min(1, (d.age - d.hold) * 0.8);
      const fadeIn = Math.min(1, d.age / 0.25);
      const fadeOut = Math.min(1, (d.life - d.age) / 1.2);
      const a = fadeIn * fadeOut * Math.min(1, 0.35 + amount);
      if (d.slide > 0 && d.age > d.hold) {
        // Wet trail behind a sliding drop.
        const len = Math.min(120, (d.age - d.hold) * d.slide * 0.6);
        g.fillStyle = `${body}${(0.07 * a).toFixed(3)})`;
        g.fillRect(d.x - d.r * 0.22, d.y - len, d.r * 0.44, len);
      }
      // Body: a lens slightly taller than wide, brighter toward the lower edge (refracted sky).
      g.save();
      g.translate(d.x, d.y);
      g.scale(1, 1.18);
      const grad = g.createRadialGradient(-d.r * 0.2, -d.r * 0.25, d.r * 0.05, 0, 0, d.r);
      grad.addColorStop(0, `${body}${(0.12 * a).toFixed(3)})`);
      grad.addColorStop(0.7, `${body}${(0.14 * a).toFixed(3)})`);
      grad.addColorStop(0.9, `rgba(15,12,0,${(0.45 * a).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(15,12,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, d.r, 0, Math.PI * 2);
      g.fill();
      // Glint.
      g.fillStyle = `rgba(255,252,220,${(0.75 * a).toFixed(3)})`;
      g.beginPath();
      g.arc(-d.r * 0.32, -d.r * 0.38, Math.max(1, d.r * 0.18), 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
}
