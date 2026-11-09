import { mulberry32 } from '../core/rng';
import type { BodyDef, RGB } from '../data/types';
import { rgbCss } from './format';

/**
 * A cheap 2D portrait of a planet: lit disc, bands or patches, atmosphere rim, rings.
 * Deterministic from the body seed, so it can be cached per system.
 */
export function drawPlanetPreview(canvas: HTMLCanvasElement, def: BodyDef): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const rnd = mulberry32(def.seed ^ 0x51ed);
  const cx = w * 0.5;
  const cy = h * 0.5;
  const r = Math.min(w, h) * (def.rings ? 0.3 : 0.38);

  // Backdrop with a few stars.
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
  bg.addColorStop(0, '#101a38');
  bg.addColorStop(1, '#04060f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(220,235,255,${(0.15 + rnd() * 0.5).toFixed(2)})`;
    const s = rnd() < 0.15 ? 1.6 : 1;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }

  const ringBack = (): void => {
    if (!def.rings) return;
    strokeRing(ctx, def, cx, cy, r, true);
  };
  ringBack();

  // Atmosphere glow behind the disc.
  const atmo = def.atmosphere;
  if (atmo) {
    const c = atmo.rayleighDepth;
    const m = Math.max(c[0], c[1], c[2], 1e-6);
    const col: RGB = [c[0] / m, c[1] / m, c[2] / m];
    // Rayleigh depth is largest in blue, so invert for a scattered sky tint.
    const tint: RGB = [col[2] * 0.25 + 0.1, col[1] * 0.6 + 0.2, col[0] * 0.6 + 0.4];
    const g = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.28);
    g.addColorStop(0, rgbCss(tint, 0.1).replace('rgb', 'rgba').replace(')', ',0.55)'));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.28, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  const base = def.visual.color;
  ctx.fillStyle = rgbCss(base);
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  if (def.gas) {
    const bands = def.gas.bands;
    const n = 9 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const y = cy - r + (i / n) * r * 2 + (rnd() - 0.5) * 3;
      const c = bands[Math.floor(rnd() * bands.length)] ?? base;
      ctx.fillStyle = rgbCss(c);
      ctx.globalAlpha = 0.5 + rnd() * 0.4;
      ctx.fillRect(cx - r, y, r * 2, (r * 2) / n + 1);
    }
    ctx.globalAlpha = 1;
    for (const s of def.gas.storms ?? []) {
      ctx.fillStyle = rgbCss(s.color);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(cx + (rnd() - 0.5) * r, cy + s.lat * r * 0.6, r * 0.16, r * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    const water = def.terrain?.water?.color;
    const dark: RGB = [base[0] * 0.55, base[1] * 0.55, base[2] * 0.6];
    const light: RGB = [Math.min(1, base[0] * 1.5 + 0.05), Math.min(1, base[1] * 1.45 + 0.04), Math.min(1, base[2] * 1.4 + 0.04)];
    const land = water ? base : dark;
    if (water) {
      ctx.fillStyle = rgbCss(water);
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    // Patches: continents on water worlds, craters and plains on dry ones.
    for (let i = 0; i < 26; i++) {
      const px = cx + (rnd() * 2 - 1) * r;
      const py = cy + (rnd() * 2 - 1) * r;
      const pr = r * (0.1 + rnd() * 0.3);
      ctx.fillStyle = rgbCss(water ? land : rnd() < 0.5 ? dark : light);
      ctx.globalAlpha = water ? 0.9 : 0.35 + rnd() * 0.3;
      ctx.beginPath();
      ctx.ellipse(px, py, pr, pr * (0.5 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const cap = def.terrain?.polarCaps?.color;
    if (cap) {
      ctx.fillStyle = rgbCss(cap);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(cx, cy - r, r * 0.7, r * 0.22, 0, 0, Math.PI * 2);
      ctx.ellipse(cx, cy + r, r * 0.6, r * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (def.atmosphere?.clouds) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.ellipse(cx + (rnd() * 2 - 1) * r, cy + (rnd() * 2 - 1) * r, r * (0.15 + rnd() * 0.3), r * 0.05, rnd() * 0.6 - 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Light from the upper left, soft terminator.
  const lx = cx - r * 0.55;
  const ly = cy - r * 0.45;
  const sh = ctx.createRadialGradient(lx, ly, r * 0.2, lx, ly, r * 2.1);
  sh.addColorStop(0, 'rgba(0,0,12,0)');
  sh.addColorStop(0.5, 'rgba(0,0,12,0.35)');
  sh.addColorStop(1, 'rgba(0,0,12,0.93)');
  ctx.fillStyle = sh;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  if (atmo) {
    ctx.strokeStyle = 'rgba(150,210,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.95, Math.PI * 1.65);
    ctx.stroke();
  }
  if (def.rings) strokeRing(ctx, def, cx, cy, r, false);
}

function strokeRing(ctx: CanvasRenderingContext2D, def: BodyDef, cx: number, cy: number, r: number, back: boolean): void {
  const rg = def.rings;
  if (!rg) return;
  const c = rg.color;
  const a = back ? 0 : Math.PI;
  const b = back ? Math.PI : Math.PI * 2;
  const tilt = -0.28;
  for (let i = 0; i < 4; i++) {
    const k = rg.innerRadius + ((rg.outerRadius - rg.innerRadius) * (i + 0.5)) / 4;
    ctx.strokeStyle = rgbCss(c, 0.1).replace('rgb', 'rgba').replace(')', `,${(0.25 + 0.5 * rg.opacity - i * 0.04).toFixed(2)})`);
    ctx.lineWidth = Math.max(2, ((rg.outerRadius - rg.innerRadius) / 4) * r * 0.9);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * k, r * k * 0.28, tilt, a, b);
    ctx.stroke();
  }
}
