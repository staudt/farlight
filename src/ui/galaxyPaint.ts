import { mulberry32 } from '../core/rng';
import type { GalaxyDef, StarClass } from '../data/galaxy';
import { galaxyArms, GALAXY_RADIUS, SPIRAL_PITCH, SPIRAL_R0 } from '../data/generate';

/** How far past the disc radius the painted texture reaches. */
export const TEXTURE_MARGIN = 1.15;

export const STAR_COLORS: Record<StarClass, string> = {
  M: '#ff9b72',
  K: '#ffc680',
  G: '#fff0a6',
  F: '#fffbe6',
  A: '#dde9ff',
  B: '#9cc2ff',
};

export const STAR_SIZE: Record<StarClass, number> = { M: 1.7, K: 2.0, G: 2.3, F: 2.6, A: 3.0, B: 3.5 };

function gauss(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
}

/** Soft round sprite in one color, reused for every glow. */
export function makeGlowSprite(rgb: string, size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.25, `rgba(${rgb},0.45)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * The galaxy itself, painted once in galaxy space: a warm core, a bluish haze and soft
 * stars strewn along the same logarithmic arms the generator places stars on.
 * The canvas covers [-E, E] light years on both axes with E = radius * TEXTURE_MARGIN.
 */
export function paintGalaxyTexture(galaxy: GalaxyDef, size = 1400): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(galaxy.seed ^ 0xa11ce);
  const E = galaxy.radius * TEXTURE_MARGIN;
  const k = size / (2 * E);
  const arms = galaxyArms(galaxy.seed);
  const sprites = {
    warm: makeGlowSprite('255,214,150'),
    white: makeGlowSprite('220,232,255'),
    blue: makeGlowSprite('110,160,255'),
    violet: makeGlowSprite('170,100,255'),
    pink: makeGlowSprite('255,110,200'),
  };
  g.globalCompositeOperation = 'lighter';
  const dot = (spr: HTMLCanvasElement, x: number, y: number, rad: number, a: number): void => {
    g.globalAlpha = a;
    g.drawImage(spr, size / 2 + x * k - rad, size / 2 + y * k - rad, rad * 2, rad * 2);
  };

  // Disc haze.
  for (let i = 0; i < 1400; i++) {
    const r = Math.abs(gauss(rnd)) * galaxy.radius * 0.42;
    const a = rnd() * Math.PI * 2;
    dot(rnd() < 0.35 ? sprites.violet : sprites.blue, Math.cos(a) * r, Math.sin(a) * r, 40 + rnd() * 70, 0.012 + rnd() * 0.02);
  }
  // Core.
  for (let i = 0; i < 6; i++) dot(sprites.warm, 0, 0, size * (0.2 - i * 0.025), 0.22);
  for (let i = 0; i < 220; i++) {
    const r = Math.abs(gauss(rnd)) * galaxy.radius * 0.1;
    const a = rnd() * Math.PI * 2;
    dot(sprites.warm, Math.cos(a) * r, Math.sin(a) * r, 8 + rnd() * 26, 0.05 + rnd() * 0.06);
  }

  // Arms.
  for (let arm = 0; arm < arms; arm++) {
    for (let i = 0; i < 3200; i++) {
      const r = SPIRAL_R0 * 0.55 + (GALAXY_RADIUS - SPIRAL_R0 * 0.55) * Math.pow(rnd(), 0.85);
      const spread = 0.16 + (r / GALAXY_RADIUS) * 0.12;
      const theta = Math.log(r / SPIRAL_R0) / SPIRAL_PITCH + (arm * 2 * Math.PI) / arms + gauss(rnd) * spread;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      const inner = 1 - Math.min(1, r / GALAXY_RADIUS);
      const roll = rnd();
      const spr = roll < 0.06 ? sprites.pink : roll < 0.2 ? sprites.violet : roll < 0.55 ? sprites.blue : inner > 0.55 ? sprites.warm : sprites.white;
      const big = roll < 0.2;
      dot(spr, x, y, big ? 30 + rnd() * 60 : 5 + rnd() * 16, big ? 0.035 + rnd() * 0.045 : 0.05 + rnd() * 0.1);
    }
    // Bright knots and fine stars.
    for (let i = 0; i < 1500; i++) {
      const r = SPIRAL_R0 * 0.5 + (GALAXY_RADIUS - SPIRAL_R0 * 0.5) * Math.pow(rnd(), 0.9);
      const theta = Math.log(r / SPIRAL_R0) / SPIRAL_PITCH + (arm * 2 * Math.PI) / arms + gauss(rnd) * 0.14;
      dot(sprites.white, r * Math.cos(theta), r * Math.sin(theta), 1.5 + rnd() * 2.5, 0.35 + rnd() * 0.5);
    }
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** Screen space backdrop: deep navy to violet with soft nebula clouds and dust. */
export function paintBackdrop(w: number, h: number, seed = 5): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d')!;
  const rnd = mulberry32(seed);
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#060a1c');
  bg.addColorStop(0.55, '#0b0b26');
  bg.addColorStop(1, '#10092a');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';
  const blobs: [number, number, number, string, number][] = [
    [0.15, 0.2, 0.5, '120,60,220', 0.2],
    [0.85, 0.75, 0.55, '40,100,230', 0.2],
    [0.7, 0.15, 0.4, '210,70,170', 0.1],
    [0.3, 0.85, 0.45, '60,60,200', 0.18],
    [0.5, 0.5, 0.6, '70,40,150', 0.12],
  ];
  for (const [bx, by, br, col, a] of blobs) {
    const rad = br * Math.max(w, h);
    const grad = g.createRadialGradient(bx * w, by * h, 0, bx * w, by * h, rad);
    grad.addColorStop(0, `rgba(${col},${a})`);
    grad.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  const n = Math.round((w * h) / 2200);
  for (let i = 0; i < n; i++) {
    const a = 0.1 + Math.pow(rnd(), 3) * 0.8;
    g.fillStyle = rnd() < 0.2 ? `rgba(190,170,255,${a})` : `rgba(210,230,255,${a})`;
    const s = rnd() < 0.06 ? 2 : 1;
    g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), s, s);
  }
  return c;
}
