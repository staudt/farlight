/**
 * Equirectangular data maps (lon -180..180 left to right, lat 90..-90 top to bottom), Uint8 with a
 * 4 byte header (u16 width, u16 height, little endian). Loaded once per URL on the main thread and in
 * every worker; sampling is synchronous and bilinear.
 */
export interface GridMap {
  w: number;
  h: number;
  data: Uint8Array;
}

const cache = new Map<string, GridMap>();
const pending = new Map<string, Promise<GridMap>>();

export function parseMap(buf: ArrayBuffer): GridMap {
  const dv = new DataView(buf);
  const w = dv.getUint16(0, true);
  const h = dv.getUint16(2, true);
  return { w, h, data: new Uint8Array(buf, 4, w * h) };
}

/** Registers map bytes under a (relative) url key; used by tests and by the loader. */
export function registerMap(key: string, buf: ArrayBuffer): GridMap {
  const m = parseMap(buf);
  cache.set(key, m);
  return m;
}

export function getMap(key: string | undefined): GridMap | undefined {
  return key ? cache.get(key) : undefined;
}

export interface MapUrls {
  land?: string;
  mountains?: string;
  deserts?: string;
  ice?: string;
  lights?: string;
}

/** Loads all maps of a terrain def. `base` resolves relative urls (the document base). */
/** Fetch with a few retries and backoff: phones on flaky networks, servers mid deploy. */
async function fetchWithRetry(url: URL, key: string, attempts = 4): Promise<ArrayBuffer> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.arrayBuffer();
      last = new Error(`terrain map ${key}: HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 400 * 2 ** i));
  }
  throw last;
}

export async function loadTerrainMaps(maps: MapUrls | undefined, base: string): Promise<void> {
  if (!maps) return;
  const keys = [maps.land, maps.mountains, maps.deserts, maps.ice, maps.lights].filter((k): k is string => !!k);
  await Promise.all(
    keys.map((key) => {
      if (cache.has(key)) return Promise.resolve();
      let p = pending.get(key);
      if (!p) {
        p = fetchWithRetry(new URL(key, base), key).then((buf) => registerMap(key, buf));
        // A failed load must not poison the cache: the next call retries from scratch.
        p.catch(() => pending.delete(key));
        pending.set(key, p);
      }
      return p.then(() => undefined);
    }),
  );
}

/** Bilinear sample as 0..1 (wraps in longitude, clamps in latitude). Angles in radians. */
export function sampleMap(m: GridMap, lat: number, lon: number): number {
  const fx = ((lon / (2 * Math.PI) + 0.5) * m.w - 0.5);
  const fy = (0.5 - lat / Math.PI) * m.h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % m.w) + m.w) % m.w;
  const xb = (xa + 1) % m.w;
  const ya = Math.min(m.h - 1, Math.max(0, y0));
  const yb = Math.min(m.h - 1, Math.max(0, y0 + 1));
  const d = m.data;
  const a = d[ya * m.w + xa]! * (1 - tx) + d[ya * m.w + xb]! * tx;
  const b = d[yb * m.w + xa]! * (1 - tx) + d[yb * m.w + xb]! * tx;
  return (a * (1 - ty) + b * ty) / 255;
}

/** Catmull-Rom weights for a fraction t. */
function cr(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}
const _wx = new Float64Array(4);
const _wy = new Float64Array(4);

/**
 * Bicubic (Catmull-Rom) sample as 0..1. Smooth contours for signed distance and mountain maps, so
 * coasts and ranges stay round when a texel covers several screen pixels. Clamped to 0..1.
 */
export function sampleMapSmooth(m: GridMap, lat: number, lon: number): number {
  const fx = (lon / (2 * Math.PI) + 0.5) * m.w - 0.5;
  const fy = (0.5 - lat / Math.PI) * m.h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  cr(fx - x0, _wx);
  cr(fy - y0, _wy);
  const d = m.data;
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const yy = Math.min(m.h - 1, Math.max(0, y0 - 1 + j));
    let row = 0;
    for (let i = 0; i < 4; i++) row += d[yy * m.w + ((((x0 - 1 + i) % m.w) + m.w) % m.w)]! * _wx[i]!;
    sum += row * _wy[j]!;
  }
  return Math.min(1, Math.max(0, sum / 255));
}
