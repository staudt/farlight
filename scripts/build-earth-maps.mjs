// Builds Earth's terrain maps from Natural Earth GeoJSON (public domain).
// Usage: node scripts/build-earth-maps.mjs [downloadDir] [--lights]
// `--lights` builds only earth-lights.bin from the populated places database (.dbf, plain table
// data with latitude, longitude and pop_max columns) at artifacts/naturalearth/pp (unzip
// ne_10m_populated_places_simple.zip there; it is only read as bytes, never executed).
// The downloads live in artifacts/naturalearth/dl (gitignored); only the outputs in public/maps are committed.
// The inputs are treated as plain data: they are only parsed as JSON.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dl = args.find((a) => !a.startsWith('--')) ?? join(root, 'artifacts/naturalearth/dl');
const ppDir = join(root, 'artifacts/naturalearth/pp');
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

// ---- Night lights ------------------------------------------------------------------------------
/** Reads columns of a dBase table as plain data. Returns rows as objects of the wanted fields. */
function readDbf(path, wanted) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(4);
  const headerLen = b.readUInt16LE(8);
  const recLen = b.readUInt16LE(10);
  const fields = [];
  let off = 1;
  for (let o = 32; b[o] !== 0x0d; o += 32) {
    const name = b.toString('latin1', o, o + 11).replace(/\0.*/, '');
    const len = b[o + 16];
    if (wanted.includes(name)) fields.push({ name, off, len });
    off += len;
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const base = headerLen + i * recLen;
    if (b[base] === 0x2a) continue; // deleted
    const row = {};
    for (const f of fields) row[f.name] = parseFloat(b.toString('latin1', base + f.off, base + f.off + f.len));
    rows.push(row);
  }
  return rows;
}

/**
 * Settlement density: every populated place splats a small core plus a wider halo (sigma follows
 * log population, horizontally stretched by 1/cos(lat) so sizes are round on the ground). The sum
 * goes through a soft clip and a power curve, so towns stand out and rural land stays dark.
 */
function buildLights() {
  const W = 2048;
  const H = 1024;
  const places = readDbf(join(ppDir, 'ne_10m_populated_places_simple.dbf'), ['latitude', 'longitude', 'pop_max']);
  const acc = new Float32Array(W * H);
  const splat = (lat, lon, amp, sigma) => {
    const cy = (0.5 - lat / 180) * H - 0.5;
    const cx = ((lon + 180) / 360) * W - 0.5;
    const sx = sigma / Math.min(4, Math.max(0.25, Math.cos((lat * Math.PI) / 180)));
    const rx = Math.ceil(sx * 3);
    const ry = Math.ceil(sigma * 3);
    for (let y = Math.round(cy) - ry; y <= Math.round(cy) + ry; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = Math.round(cx) - rx; x <= Math.round(cx) + rx; x++) {
        const dx = (x - cx) / sx;
        const dy = (y - cy) / sigma;
        acc[y * W + ((x + W) % W)] += amp * Math.exp(-(dx * dx + dy * dy) / 2);
      }
    }
  };
  let used = 0;
  for (const p of places) {
    if (!(p.pop_max > 1000) || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    used++;
    const lp = Math.log10(p.pop_max);
    const amp = Math.min(1.6, 0.18 + 0.16 * Math.max(0, lp - 3.7) ** 1.6);
    const core = 0.4 + 0.2 * Math.max(0, lp - 4);
    splat(p.latitude, p.longitude, amp, core);
    splat(p.latitude, p.longitude, amp * 0.22, core * 2.6);
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(255 * Math.pow(1 - Math.exp(-acc[i] * 1.0), 1.15));
  write('earth-lights.bin', W, H, out);
  console.log('lights from', used, 'places');
}

if (args.includes('--lights')) {
  buildLights();
  process.exit(0);
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

// ---- Night lights (needs the populated places database, see the usage note) -----------------
if (existsSync(join(ppDir, 'ne_10m_populated_places_simple.dbf'))) buildLights();
