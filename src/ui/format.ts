/** Shared UI formatters. The UI never shows dash characters. */

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '·';
  const a = Math.abs(m);
  if (a < 1000) return `${Math.round(a)} m`;
  if (a < 1e7) return `${(a / 1000).toFixed(a < 1e4 ? 1 : 0)} km`;
  if (a < 1e9) return `${Math.round(a / 1000).toLocaleString('en-US')} km`;
  return `${(a / 1e9).toFixed(2)} Mkm`;
}

export function formatSpeed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} m/s`;
  return `${(ms / 1000).toFixed(ms < 1e4 ? 2 : 1)} km/s`;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s)) return '·';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${s % 60} s`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** Removes dashes from authored text: hyphens become spaces, a leading minus becomes MINUS. */
export function noDashes(text: string): string {
  return text
    .replace(/(^|\s)[-−–—](?=\d)/g, '$1MINUS ')
    .replace(/\s*[-−–—]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** Linear RGB 0..1 to a CSS color, lifted toward white by `lift`. */
export function rgbCss(c: readonly [number, number, number], lift = 0): string {
  const f = (v: number): number => Math.round(255 * Math.min(1, Math.pow(Math.max(0, v), 1 / 2.2) * (1 - lift) + lift));
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}
