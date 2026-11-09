// Builds Earth's terrain maps from Natural Earth GeoJSON (public domain).
// Usage: node scripts/build-earth-maps.mjs [downloadDir]
// The downloads live in artifacts/naturalearth/dl (gitignored); only the outputs in public/maps are committed.
// The inputs are treated as plain data: they are only parsed as JSON.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dl = process.argv[2] ?? join(root, 'artifacts/naturalearth/dl');
const outDir = join(root, 'public/maps');
mkdirSync(outDir, { recursive: true });

const readJson = (name) => JSON.parse(readFileSync(join(dl, name), 'utf8'));
const pick = (name, alt) => (existsSync(join(dl, name)) ? name : alt);

/** Rings of a feature: array of arrays of [lon, lat]. Even-odd fill handles holes. */
function ringsOf(geom) {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

/** Fills the (even-odd) interior of `rings` into `mask` (W*H) with `value`, at pixel centres. */
function fillRings(mask, W, H, rings, value) {
  const edges = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      if (y0 === y1) continue;
      edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
    }
  }
  const xs = [];
  for (let row = 0; row < H; row++) {
    const lat = 90 - ((row + 0.5) / H) * 180;
    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if (lat < y0 || lat >= y1) continue;
      xs.push(x0 + ((lat - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(((xs[k] + 180) / 360) * W - 0.5));
      const b = Math.min(W - 1, Math.floor(((xs[k + 1] + 180) / 360) * W - 0.5));
      for (let x = a; x <= b; x++) mask[row * W + x] = value;
    }
  }
}

/** Separable box blur on a float image, wrapping in x and clamping in y. */
function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * W + ((x + k + W) % W)];
      tmp[y * W + x] = s / n;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x];
      dst[y * W + x] = s / n;
    }
  }
  return dst;
}

function softMask(mask, W, H, r, gain) {
  let f = Float32Array.from(mask, (v) => v / 255);
  for (let i = 0; i < 3; i++) f = boxBlur(f, W, H, r);
  return Uint8Array.from(f, (v) => Math.max(0, Math.min(255, Math.round(v * gain * 255))));
}

function write(name, W, H, data) {
  const buf = Buffer.alloc(4 + W * H);
  buf.writeUInt16LE(W, 0);
  buf.writeUInt16LE(H, 2);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(buf, 4);
  writeFileSync(join(outDir, name), buf);
  console.log(name, buf.length, 'bytes');
}

// ---- Land signed distance field -------------------------------------------------------------
const LW = 2048;
const LH = 1024;
const CLAMP_KM = 600;
const EARTH_KM = 6371;

const land = readJson(pick('ne_50m_land.geojson', 'ne_110m_land.geojson'));
const landMask = new Uint8Array(LW * LH);
for (const f of land.features) fillRings(landMask, LW, LH, ringsOf(f.geometry), 255);

// Chamfer distance to the nearest pixel of the opposite class, in km. Horizontal steps shrink
// with cos(lat), so the metric is roughly spherical.
const pxKm = (Math.PI * EARTH_KM) / LH; // vertical pixel size (and equatorial horizontal)
const dxKm = new Float32Array(LH);
for (let y = 0; y < LH; y++) dxKm[y] = Math.max(0.05, Math.cos(((0.5 - (y + 0.5) / LH) * Math.PI)) * pxKm * (2048 / LW));
const dist = new Float32Array(LW * LH);
for (let i = 0; i < dist.length; i++) {
  const x = i % LW;
  const y = (i / LW) | 0;
  // Boundary seeds: a pixel with a differing 4-neighbour is at distance 0 from the other class.
  const v = landMask[i];
  const l = landMask[y * LW + ((x + LW - 1) % LW)];
  const r = landMask[y * LW + ((x + 1) % LW)];
  const u = y > 0 ? landMask[i - LW] : v;
  const d = y < LH - 1 ? landMask[i + LW] : v;
  dist[i] = l !== v || r !== v || u !== v || d !== v ? 0 : 1e9;
}
// Distances from boundary pixels: all pixels get distance to nearest boundary pixel.
function relax(i, j, cost) {
  const c = dist[j] + cost;
  if (c < dist[i]) dist[i] = c;
}
for (let round = 0; round < 4; round++) {
  for (let y = 0; y < LH; y++) {
    for (let x = 0; x < LW; x++) {
      const i = y * LW + x;
      const hx = dxKm[y];
      relax(i, y * LW + ((x + LW - 1) % LW), hx);
      if (y > 0) {
        relax(i, i - LW, pxKm);
        relax(i, (y - 1) * LW + ((x + LW - 1) % LW), Math.hypot(hx, pxKm));
        relax(i, (y - 1) * LW + ((x + 1) % LW), Math.hypot(hx, pxKm));
      }
    }
  }
  for (let y = LH - 1; y >= 0; y--) {
    for (let x = LW - 1; x >= 0; x--) {
      const i = y * LW + x;
      const hx = dxKm[y];
      relax(i, y * LW + ((x + 1) % LW), hx);
      if (y < LH - 1) {
        relax(i, i + LW, pxKm);
        relax(i, (y + 1) * LW + ((x + LW - 1) % LW), Math.hypot(hx, pxKm));
        relax(i, (y + 1) * LW + ((x + 1) % LW), Math.hypot(hx, pxKm));
      }
    }
  }
}
let signedKm = new Float32Array(LW * LH);
for (let i = 0; i < signedKm.length; i++) {
  // Boundary pixels sit half a pixel inside their own class, so the zero crossing lies between.
  const d = dist[i] + pxKm * 0.5;
  signedKm[i] = landMask[i] ? d : -d;
}
// Smooths the octagonal chamfer artefacts.
signedKm = boxBlur(boxBlur(signedKm, LW, LH, 1), LW, LH, 1);
const sdf = new Uint8Array(LW * LH);
for (let i = 0; i < sdf.length; i++) {
  const t = Math.max(-1, Math.min(1, signedKm[i] / CLAMP_KM));
  sdf[i] = Math.round(127.5 + t * 127.5);
}
write('earth-land.bin', LW, LH, sdf);

// ---- Mountains and deserts ------------------------------------------------------------------
const MW = 1024;
const MH = 512;
const regionsName = pick('ne_10m_geography_regions_polys.geojson', 'ne_50m_geography_regions_polys.geojson');
const regions = readJson(regionsName);
const cls = (f) => f.properties.featurecla ?? f.properties.FEATURECLA;
const mtn = new Uint8Array(MW * MH);
const des = new Uint8Array(MW * MH);
for (const f of regions.features) {
  const c = cls(f);
  if (c === 'Range/mtn') fillRings(mtn, MW, MH, ringsOf(f.geometry), 255);
  else if (c === 'Plateau') {
    // Plateaus (Tibet, Altiplano) are high ground: half strength, never overwriting a range.
    const tmp = new Uint8Array(MW * MH);
    fillRings(tmp, MW, MH, ringsOf(f.geometry), 130);
    for (let i = 0; i < tmp.length; i++) mtn[i] = Math.max(mtn[i], tmp[i]);
  } else if (c === 'Desert') fillRings(des, MW, MH, ringsOf(f.geometry), 255);
}
write('earth-mountains.bin', MW, MH, softMask(mtn, MW, MH, 2, 1.25));
write('earth-deserts.bin', MW, MH, softMask(des, MW, MH, 3, 1.15));
console.log('regions from', regionsName);

// ---- Ice (glaciated areas: Greenland, Antarctica, big glaciers) ------------------------------
const ice = readJson('ne_50m_glaciated_areas.geojson');
const iceMask = new Uint8Array(MW * MH);
for (const f of ice.features) fillRings(iceMask, MW, MH, ringsOf(f.geometry), 255);
write('earth-ice.bin', MW, MH, softMask(iceMask, MW, MH, 1, 1.1));
