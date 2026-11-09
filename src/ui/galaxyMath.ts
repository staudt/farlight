import type { GalaxyStar } from '../data/galaxy';

/** Pure helpers for the galaxy map and the jump: routes, travel times, URLs. */

export const TRAVEL_FACTORS = [1, 2, 5, 10, 30, 60] as const;
export const DEFAULT_TRAVEL_FACTOR = 10;
/** Feel formula: minutes of travel per 1000 light years at x1. */
export const MINUTES_PER_KLY = 4;
export const JUMP_MIN_SECONDS = 3;
export const JUMP_MAX_SECONDS = 12;

export function starDistance(a: GalaxyStar, b: GalaxyStar): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Straight line parameter 0..1 of the closest point on a to b segment. */
function lineParam(a: GalaxyStar, b: GalaxyStar, p: GalaxyStar): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 === 0) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2;
}

/**
 * Greedy route: for each evenly spaced point on the straight line, hop through the nearest
 * unused star (close to the line, never going backwards). Returns from, waypoints..., to.
 */
export function findRoute(stars: readonly GalaxyStar[], fromId: string, toId: string, waypoints = 3): GalaxyStar[] {
  const from = stars.find((s) => s.id === fromId);
  const to = stars.find((s) => s.id === toId);
  if (!from || !to) return [];
  if (from === to) return [from];
  const total = starDistance(from, to);
  const route: GalaxyStar[] = [from];
  let lastT = 0;
  for (let k = 1; k <= waypoints; k++) {
    const ideal = k / (waypoints + 1);
    const ix = from.x + (to.x - from.x) * ideal;
    const iy = from.y + (to.y - from.y) * ideal;
    const iz = from.z + (to.z - from.z) * ideal;
    let best: GalaxyStar | null = null;
    let bestD = total * 0.18;
    for (const s of stars) {
      if (s === from || s === to || route.includes(s)) continue;
      const t = lineParam(from, to, s);
      if (t <= lastT + 0.02 || t >= 0.98) continue;
      const d = Math.hypot(s.x - ix, s.y - iy, s.z - iz);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      route.push(best);
      lastT = lineParam(from, to, best);
    }
  }
  route.push(to);
  return route;
}

export function routeLength(route: readonly GalaxyStar[]): number {
  let sum = 0;
  for (let i = 1; i < route.length; i++) sum += starDistance(route[i - 1]!, route[i]!);
  return sum;
}

/** Travel time in minutes at time acceleration `factor`. */
export function travelMinutes(lightYears: number, factor = 1): number {
  return ((lightYears / 1000) * MINUTES_PER_KLY) / Math.max(1, factor);
}

/** Real seconds the jump cinematic lasts: always short. */
export function jumpSeconds(lightYears: number, factor: number): number {
  const s = travelMinutes(lightYears, factor) * 60;
  return Math.min(JUMP_MAX_SECONDS, Math.max(JUMP_MIN_SECONDS, s));
}

export function formatLightYears(ly: number): string {
  return `${Math.round(ly).toLocaleString('en-US')} LY`;
}

export function formatMinutes(min: number): string {
  const s = Math.max(0, Math.round(min * 60));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** URL for arriving at `systemId`, keeping the debug, quality and touch params. */
export function buildTravelUrl(search: string, systemId: string, pathname = '/'): string {
  const cur = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of ['debug', 'quality', 'touch']) {
    if (cur.has(k)) out.set(k, cur.get(k) ?? '');
  }
  out.set('system', systemId);
  out.set('arrive', '1');
  return `${pathname}?${out.toString().replace(/=(&|$)/g, '$1')}`;
}
