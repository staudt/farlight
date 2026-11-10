import { hashInts, mulberry32 } from '../core/rng';
import type { GalaxyDef, GalaxyStar, StarClass } from './galaxy';
import { generateLandmarks, type LandmarkWorld } from './landmarkGen';
import { makeName, makeUniqueNames, moonName, slug } from './names';
import { SOLAR_SYSTEM } from './solarSystem';
import type {
  AtmosphereDef,
  BiomeDef,
  BodyDef,
  CraterDef,
  FeatureDef,
  GasDef,
  NoiseLayer,
  OrbitDef,
  PropDef,
  RGB,
  RingDef,
  StarSystemDef,
  TerrainDef,
  WeatherDef,
} from './types';

/**
 * Procedural galaxy and star systems. `createGalaxy(seed)` lays out the stars; `generateSystem(star)`
 * builds a full StarSystemDef from the star's seed. Everything is deterministic, and every system
 * is plain schema data: the sim and the renderer never know it was generated.
 */

const DEG = Math.PI / 180;
const DAY = 86400;
const AU = 1.495978707e11;
const G_CONST = 6.674e-11;
const R_EARTH = 6.371e6;
const STAR_COUNT = 240;
export const GALAXY_RADIUS = 50000;

// ---------------------------------------------------------------------------------------------
// Small helpers

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  r(): number {
    return this.next();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  /** Standard normal. */
  gauss(): number {
    const u = Math.max(1e-9, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  weighted<T extends string>(table: Record<T, number>): T {
    const keys = Object.keys(table) as T[];
    let total = 0;
    for (const k of keys) total += table[k];
    let x = this.next() * total;
    for (const k of keys) {
      x -= table[k];
      if (x <= 0) return k;
    }
    return keys[keys.length - 1]!;
  }
  seed(): number {
    return Math.floor(this.next() * 0xffffffff) >>> 0;
  }
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;

/** Per channel multiplicative jitter. */
function jit(c: RGB, rng: Rng, amt = 0.1): RGB {
  return [0, 1, 2].map((i) => round(clamp01(c[i]! * (1 + rng.range(-amt, amt))))) as unknown as RGB;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t), round(a[2] + (b[2] - a[2]) * t)];
}

function mul(c: RGB, k: number): RGB {
  return [round(clamp01(c[0] * k)), round(clamp01(c[1] * k)), round(clamp01(c[2] * k))];
}

/** HSL (h in degrees) to RGB. Not gamma converted; tuned by eye like Sol's palettes. */
function hsl(h: number, s: number, l: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [round(f(hh + 1 / 3)), round(f(hh)), round(f(hh - 1 / 3))];
}

function normMax(c: RGB): RGB {
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
}

/** Very cold worlds read better a little less extreme. */
function softFloor(c: number): number {
  return c < -150 ? -150 + (c + 150) * 0.35 : c;
}

/** Surface temperature plausible for the archetype: equilibrium temperature squashed into its range. */
function surfaceTemp(a: Archetype, tEq: number): number {
  const squash = (lo: number, hi: number, mid: number, scale: number): number => lo + (hi - lo) * (0.5 + 0.5 * Math.tanh((tEq - mid) / scale));
  switch (a) {
    case 'desert':
      return squash(-80, 60, -20, 120);
    case 'ice':
      return squash(-150, -20, -120, 90);
    case 'lava':
      return Math.min(1200, Math.max(300, tEq));
    case 'toxic':
      return Math.min(480, Math.max(150, tEq));
    case 'earthlike':
    case 'ocean':
    case 'alien':
      return squash(-10, 40, 15, 60);
    default:
      return softFloor(tEq);
  }
}

function celsiusText(c: number): string {
  const v = Math.round(c / 5) * 5;
  return v < 0 ? `minus ${-v} °C` : `${v} °C`;
}

// ---------------------------------------------------------------------------------------------
// Galaxy

const CLASS_WEIGHTS: Record<StarClass, number> = { M: 0.4, K: 0.26, G: 0.2, F: 0.08, A: 0.04, B: 0.02 };

function planetCountFor(rng: Rng, cls: StarClass): number {
  switch (cls) {
    case 'M':
      return rng.int(2, 6);
    case 'K':
      return rng.int(3, 8);
    case 'G':
      return rng.int(3, 9);
    case 'F':
      return rng.int(3, 8);
    default:
      return rng.int(2, 6);
  }
}

export const SPIRAL_R0 = 3000;
export const SPIRAL_PITCH = 0.25;

/** Number of spiral arms the generator uses for a galaxy seed. */
export function galaxyArms(seed: number): number {
  return seed % 7 === 0 ? 4 : 2;
}

export function createGalaxy(seed = 1977): GalaxyDef {
  const rng = new Rng(seed);
  const arms = galaxyArms(seed);
  const names = makeUniqueNames(seed, STAR_COUNT, ['Sol']);
  const stars: GalaxyStar[] = [];
  const usedIds = new Set<string>(['sol']);

  // Sol lives in an outer arm.
  const solR = 26000;
  const solTheta = Math.log(solR / SPIRAL_R0) / SPIRAL_PITCH + (2 * Math.PI) / arms;
  stars.push({
    id: 'sol',
    seed: SOLAR_SYSTEM.seed,
    name: 'Sol',
    starClass: 'G',
    x: round(solR * Math.cos(solTheta), 1),
    y: round(solR * Math.sin(solTheta), 1),
    z: 0,
    planetCount: SOLAR_SYSTEM.bodies.filter((b) => b.parentId === 'sun').length,
  });

  for (let i = 0; i < STAR_COUNT - 1; i++) {
    let r: number;
    let theta: number;
    let z: number;
    if (rng.chance(0.14)) {
      r = Math.min(9000, Math.abs(rng.gauss()) * 3500);
      theta = rng.range(0, Math.PI * 2);
      z = rng.gauss() * 650;
    } else {
      r = SPIRAL_R0 + (GALAXY_RADIUS - SPIRAL_R0) * Math.pow(rng.r(), 0.85);
      const arm = rng.int(0, arms - 1);
      theta = Math.log(r / SPIRAL_R0) / SPIRAL_PITCH + (arm * 2 * Math.PI) / arms + rng.gauss() * 0.22;
      z = rng.gauss() * 380;
    }
    let sSeed = rng.seed();
    while (usedIds.has('s' + sSeed.toString(36))) sSeed = (sSeed + 1) >>> 0;
    const id = 's' + sSeed.toString(36);
    usedIds.add(id);
    const starClass = rng.weighted(CLASS_WEIGHTS);
    // Planet count comes from the star's own rng stream so the map hint matches the system.
    const planetCount = planetCountFor(new Rng(sSeed ^ 0x9e3779b9), starClass);
    stars.push({
      id,
      seed: sSeed,
      name: names[i]!,
      starClass,
      x: round(r * Math.cos(theta), 1),
      y: round(r * Math.sin(theta), 1),
      z: round(z, 1),
      planetCount,
    });
  }
  return { seed, name: 'Milky Way', radius: GALAXY_RADIUS, stars, homeId: 'sol' };
}

// ---------------------------------------------------------------------------------------------
// Stars

interface StarSpec {
  radiusSolar: [number, number];
  massSolar: number;
  luminosity: number;
  orbitScale: number;
  color: RGB;
  intensity: number;
  tempC: number;
  label: string;
}

const STAR_SPECS: Record<StarClass, StarSpec> = {
  M: { radiusSolar: [0.25, 0.6], massSolar: 0.4, luminosity: 0.04, orbitScale: 0.35, color: [1.0, 0.45, 0.2], intensity: 0.6, tempC: 3200, label: 'A red dwarf' },
  K: { radiusSolar: [0.7, 0.9], massSolar: 0.75, luminosity: 0.4, orbitScale: 0.7, color: [1.0, 0.65, 0.35], intensity: 0.85, tempC: 4500, label: 'An orange dwarf' },
  G: { radiusSolar: [0.9, 1.1], massSolar: 1.0, luminosity: 1.0, orbitScale: 1.0, color: [1.0, 0.93, 0.78], intensity: 1.0, tempC: 5600, label: 'A yellow dwarf' },
  F: { radiusSolar: [1.2, 1.5], massSolar: 1.3, luminosity: 3.0, orbitScale: 1.3, color: [1.0, 0.97, 0.9], intensity: 1.15, tempC: 6700, label: 'A pale yellow star' },
  A: { radiusSolar: [1.6, 2.2], massSolar: 2.0, luminosity: 12, orbitScale: 1.8, color: [0.86, 0.92, 1.0], intensity: 1.4, tempC: 9000, label: 'A white star' },
  B: { radiusSolar: [2.5, 3.8], massSolar: 5.0, luminosity: 80, orbitScale: 2.5, color: [0.62, 0.76, 1.0], intensity: 1.8, tempC: 18000, label: 'A blue giant' },
};

const SOLAR_MASS = 1.989e30;
const SOLAR_RADIUS = 6.957e8;

function buildStar(rng: Rng, star: GalaxyStar, spec: StarSpec): BodyDef {
  const radius = rng.range(spec.radiusSolar[0], spec.radiusSolar[1]) * SOLAR_RADIUS;
  const color = jit(spec.color, rng, 0.04);
  return {
    id: 'star',
    name: star.name,
    kind: 'star',
    seed: rng.seed(),
    physical: { radius, surfaceGravity: round(28 * spec.massSolar / Math.pow(radius / SOLAR_RADIUS, 2), 1), rotationPeriod: rng.range(8, 40) * DAY, axialTilt: rng.range(0, 10) * DEG },
    visual: { color, minApparentSize: 0.02 },
    star: { color, intensity: spec.intensity, coronaSize: round(rng.range(5, 7.5), 1) },
    info: {
      type: 'Star',
      atmosphere: 'Plasma',
      temperature: `${Math.round(spec.tempC / 100) * 100} °C`,
      features: ['Corona', 'Flares'],
      summary: `${spec.label} that lights the ${star.name} system.`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Skies and palettes

interface SkyTheme {
  name: string;
  /** Rayleigh channel ratios; the brightest channel is scaled to the zenith depth. */
  ratio: RGB;
  mie: RGB;
  cloud: RGB;
  aurora: RGB[];
}

const SKIES: Record<string, SkyTheme> = {
  blue: { name: 'blue', ratio: [0.18, 0.4, 1], mie: [1, 1, 1], cloud: [1, 1, 1], aurora: [[0.2, 1.0, 0.5], [0.6, 0.3, 1.0]] },
  violet: { name: 'violet', ratio: [0.5, 0.16, 1], mie: [1, 0.85, 1], cloud: [1, 0.9, 1], aurora: [[0.9, 0.3, 1.0], [0.3, 0.6, 1.0]] },
  green: { name: 'green', ratio: [0.28, 1, 0.38], mie: [0.9, 1, 0.85], cloud: [0.92, 1, 0.9], aurora: [[0.4, 1.0, 0.3], [1.0, 0.9, 0.3]] },
  teal: { name: 'teal', ratio: [0.1, 0.85, 1], mie: [0.85, 1, 1], cloud: [0.9, 1, 1], aurora: [[0.2, 1.0, 0.8], [0.3, 0.5, 1.0]] },
  magenta: { name: 'magenta', ratio: [1, 0.16, 0.7], mie: [1, 0.85, 0.95], cloud: [1, 0.9, 0.95], aurora: [[1.0, 0.3, 0.7], [0.5, 0.3, 1.0]] },
  smoke: { name: 'smoke', ratio: [0.75, 0.55, 0.42], mie: [0.8, 0.5, 0.35], cloud: [0.25, 0.2, 0.18], aurora: [[1.0, 0.5, 0.2]] },
  amber: { name: 'amber', ratio: [1, 0.55, 0.16], mie: [1, 0.78, 0.5], cloud: [1, 0.9, 0.75], aurora: [[1.0, 0.5, 0.2], [1.0, 0.9, 0.3]] },
};

function rayleigh(theme: SkyTheme, depth: number, rng: Rng): RGB {
  const n = normMax(theme.ratio);
  return [round(n[0] * depth * rng.range(0.9, 1.1), 4), round(n[1] * depth * rng.range(0.92, 1.08), 4), round(n[2] * depth * rng.range(0.92, 1.08), 4)];
}

function auroraFor(rng: Rng, theme: SkyTheme, chance: number): AtmosphereDef['aurora'] {
  if (!rng.chance(chance)) return undefined;
  const palette: RGB[] = [...theme.aurora, [0.2, 0.9, 1.0], [1.0, 0.3, 0.4], [0.3, 1.0, 0.5]];
  const a = rng.pick(palette);
  const b = rng.pick(palette);
  return { colors: a === b ? [a] : [a, b], latitude: round(rng.range(58, 78) * DEG), intensity: round(rng.range(0.7, 1.2), 2) };
}

// ---------------------------------------------------------------------------------------------
// Terrain building blocks

function jitterLayers(layers: NoiseLayer[], rng: Rng, f = 0.2): NoiseLayer[] {
  return layers.map((l) => ({
    ...l,
    frequency: round(l.frequency * rng.range(1 - f, 1 + f), 2),
    amplitude: round(l.amplitude * rng.range(1 - f * 0.75, 1 + f * 0.75), 3),
    ...(l.mask ? { mask: { frequency: round(l.mask.frequency * rng.range(0.8, 1.25), 2), threshold: round(l.mask.threshold + rng.range(-0.08, 0.08), 3) } } : {}),
  }));
}

function features(rng: Rng, kind: FeatureDef['kind'], count: number, radius: [number, number], height: [number, number]): FeatureDef[] {
  const out: FeatureDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      kind,
      lat: round(rng.range(-1.2, 1.2)),
      lon: round(rng.range(-Math.PI, Math.PI)),
      radius: round(rng.range(radius[0], radius[1]), 3),
      height: round(rng.range(height[0], height[1]), 2),
    });
  }
  return out;
}

function craters(rng: Rng, count: [number, number], maxR: [number, number]): CraterDef {
  return {
    count: rng.int(count[0], count[1]),
    minRadius: round(rng.range(0.002, 0.005), 4),
    maxRadius: round(rng.range(maxR[0], maxR[1]), 3),
    depth: round(rng.range(0.18, 0.32), 2),
    rimHeight: round(rng.range(0.07, 0.16), 2),
  };
}

const EARTH_LAYERS: NoiseLayer[] = [
  { type: 'fbm', frequency: 1.5, amplitude: 1.0, octaves: 5, warp: 0.4 },
  { type: 'ridged', frequency: 5, amplitude: 0.95, octaves: 5, mask: { frequency: 1.8, threshold: 0.05 } },
  { type: 'ridged', frequency: 16, amplitude: 0.25, octaves: 4, lacunarity: 2.1, mask: { frequency: 2.4, threshold: 0.0 } },
  { type: 'billow', frequency: 9, amplitude: 0.2, octaves: 3 },
  { type: 'fbm', frequency: 22, amplitude: 0.11, octaves: 3 },
  { type: 'fbm', frequency: 40, amplitude: 0.06, octaves: 4 },
  { type: 'fbm', frequency: 700, amplitude: 0.012, octaves: 3 },
  { type: 'fbm', frequency: 5000, amplitude: 0.004, octaves: 3 },
];

const MARS_LAYERS: NoiseLayer[] = [
  { type: 'fbm', frequency: 2, amplitude: 1.0, octaves: 5 },
  { type: 'ridged', frequency: 6, amplitude: 0.6, octaves: 4 },
  { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
];

const MOON_LAYERS: NoiseLayer[] = [
  { type: 'fbm', frequency: 2, amplitude: 0.3, octaves: 5 },
  { type: 'ridged', frequency: 9, amplitude: 0.09, octaves: 3 },
  { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
  { type: 'fbm', frequency: 900, amplitude: 0.0018, octaves: 3 },
];

// ---------------------------------------------------------------------------------------------
// Archetypes

type Archetype = 'lava' | 'desert' | 'earthlike' | 'ocean' | 'ice' | 'alien' | 'toxic' | 'cratered' | 'gas' | 'iceGiant';

interface Built {
  archetype: Archetype;
  kind: 'rocky' | 'gas';
  /** Planet radius in Earth radii. */
  radiusEarth: number;
  color: RGB;
  terrain?: TerrainDef;
  atmosphere?: AtmosphereDef;
  gas?: GasDef;
  /** Extra greenhouse warming in kelvin. */
  greenhouse: number;
  atmosphereText: string;
  type: string;
  features: string[];
  summary: string;
  /** Surface and sky effects that do not need an atmosphere. */
  effects?: WeatherDef[];
  hazards?: string[];
}

interface Flora {
  forest: RGB;
  grass: RGB;
  meadow: RGB;
  desert: RGB;
  tundra: RGB;
  sand: RGB;
  rock: RGB;
  trunk: RGB;
  words: string;
  /** Alien extras: black sand, crystal and spire colours, optional strange desert. */
  beach?: RGB;
  crystal?: RGB;
  spire?: RGB;
  alienDesert?: RGB;
}

const FLORAS: Record<string, Flora> = {
  terran: { forest: [0.02, 0.14, 0.04], grass: [0.1, 0.35, 0.05], meadow: [0.28, 0.46, 0.07], desert: [0.66, 0.4, 0.15], tundra: [0.3, 0.32, 0.2], sand: [0.72, 0.62, 0.36], rock: [0.3, 0.26, 0.22], trunk: [0.14, 0.34, 0.15], words: 'forests' },
  autumn: { forest: [0.3, 0.07, 0.02], grass: [0.5, 0.25, 0.05], meadow: [0.7, 0.42, 0.1], desert: [0.62, 0.4, 0.2], tundra: [0.36, 0.28, 0.18], sand: [0.78, 0.66, 0.4], rock: [0.3, 0.24, 0.2], trunk: [0.65, 0.25, 0.05], words: 'copper forests' },
};

interface Water {
  color: RGB;
  deepColor: RGB;
}
const WATERS: Record<string, Water> = {
  blue: { color: [0.05, 0.42, 0.5], deepColor: [0.008, 0.07, 0.25] },
  turquoise: { color: [0.05, 0.55, 0.5], deepColor: [0.01, 0.2, 0.3] },
  amber: { color: [0.6, 0.3, 0.05], deepColor: [0.22, 0.08, 0.01] },
  violet: { color: [0.3, 0.12, 0.5], deepColor: [0.08, 0.02, 0.22] },
  green: { color: [0.12, 0.5, 0.25], deepColor: [0.02, 0.18, 0.1] },
  rose: { color: [0.6, 0.18, 0.36], deepColor: [0.22, 0.03, 0.14] },
  orange: { color: [0.85, 0.38, 0.06], deepColor: [0.34, 0.1, 0.02] },
  jade: { color: [0.1, 0.62, 0.34], deepColor: [0.02, 0.22, 0.14] },
};

interface Theme {
  sky: string;
  /** Terran flora key, or an inline alien palette. */
  flora: string | Flora;
  water: string;
  words: string;
}

/** Every alien variant has its own complete ground palette: no beige, black sand, white or pink rock. */
const ALIEN_THEMES: Theme[] = [
  {
    sky: 'violet',
    water: 'orange',
    words: 'violet',
    flora: { forest: [0.1, 0.03, 0.26], grass: [0.3, 0.1, 0.55], meadow: [0.6, 0.3, 0.8], desert: [0.8, 0.28, 0.55], tundra: [0.42, 0.32, 0.58], sand: [0.05, 0.045, 0.07], rock: [0.88, 0.8, 0.94], trunk: [0.6, 0.25, 0.95], words: 'violet forests', beach: [0.05, 0.045, 0.07], crystal: [0.55, 0.95, 1.0], spire: [0.95, 0.93, 1.0], alienDesert: [0.8, 0.28, 0.55] },
  },
  {
    sky: 'green',
    water: 'orange',
    words: 'emerald',
    flora: { forest: [0.0, 0.14, 0.17], grass: [0.02, 0.4, 0.36], meadow: [0.25, 0.62, 0.48], desert: [0.85, 0.35, 0.45], tundra: [0.3, 0.5, 0.46], sand: [0.04, 0.05, 0.05], rock: [0.96, 0.76, 0.84], trunk: [0.15, 0.45, 1.0], words: 'teal grasslands', beach: [0.04, 0.05, 0.05], crystal: [1.0, 0.5, 0.85], spire: [0.97, 0.97, 0.97], alienDesert: [0.85, 0.35, 0.45] },
  },
  {
    sky: 'amber',
    water: 'jade',
    words: 'amber',
    flora: { forest: [0.2, 0.01, 0.06], grass: [0.5, 0.03, 0.12], meadow: [0.8, 0.16, 0.2], desert: [0.95, 0.5, 0.12], tundra: [0.5, 0.3, 0.32], sand: [0.06, 0.05, 0.05], rock: [0.94, 0.92, 0.9], trunk: [0.9, 0.15, 0.22], words: 'crimson forests', beach: [0.06, 0.05, 0.05], crystal: [0.4, 1.0, 0.9], spire: [0.98, 0.96, 0.94], alienDesert: [0.95, 0.5, 0.12] },
  },
  {
    sky: 'magenta',
    water: 'orange',
    words: 'rose',
    flora: { forest: [0.01, 0.03, 0.22], grass: [0.03, 0.12, 0.5], meadow: [0.12, 0.28, 0.62], desert: [0.5, 0.22, 0.8], tundra: [0.35, 0.42, 0.62], sand: [0.04, 0.04, 0.06], rock: [0.97, 0.78, 0.88], trunk: [0.3, 0.5, 1.0], words: 'blue forests', beach: [0.04, 0.04, 0.06], crystal: [1.0, 0.6, 0.95], spire: [0.97, 0.95, 1.0], alienDesert: [0.5, 0.22, 0.8] },
  },
  {
    sky: 'green',
    water: 'rose',
    words: 'emerald',
    flora: { forest: [0.0, 0.18, 0.07], grass: [0.04, 0.46, 0.2], meadow: [0.3, 0.66, 0.3], desert: [0.95, 0.45, 0.6], tundra: [0.4, 0.55, 0.4], sand: [0.05, 0.06, 0.05], rock: [0.92, 0.95, 0.92], trunk: [0.2, 0.55, 1.0], words: 'emerald groves', beach: [0.05, 0.06, 0.05], crystal: [1.0, 0.4, 0.6], spire: [0.97, 1.0, 0.97], alienDesert: [0.95, 0.45, 0.6] },
  },
  {
    sky: 'teal',
    water: 'orange',
    words: 'twilight',
    flora: { forest: [0.14, 0.03, 0.3], grass: [0.4, 0.12, 0.62], meadow: [0.2, 0.7, 0.7], desert: [0.2, 0.62, 0.62], tundra: [0.4, 0.34, 0.6], sand: [0.05, 0.04, 0.07], rock: [0.9, 0.85, 0.96], trunk: [0.7, 0.3, 1.0], words: 'twilight forests', beach: [0.05, 0.04, 0.07], crystal: [0.3, 1.0, 0.9], spire: [0.97, 0.95, 1.0], alienDesert: [0.2, 0.62, 0.62] },
  },
];

function livingBiomes(rng: Rng, f: Flora, seaLevel: number, ocean: boolean, alien = false): BiomeDef[] {
  const j = (c: RGB): RGB => jit(c, rng, 0.08);
  const beachColor = f.beach ?? f.sand;
  const biomes: BiomeDef[] = [
    { name: 'snow', color: [0.88, 0.92, 0.96], minHeight: 1.0 },
    { name: 'ice', color: [0.8, 0.87, 0.94], latitude: [1.2, 1.6] },
    { name: 'rock', color: j(f.rock), minHeight: alien ? 0.7 : 0.75 },
    { name: 'beach', color: j(beachColor), maxHeight: round(seaLevel + 0.01) },
  ];
  // Alien deserts are strange colours and only on some variants.
  const desertColor = f.alienDesert ?? f.desert;
  if (!ocean && (!alien || rng.chance(0.4))) biomes.push({ name: 'desert', color: j(desertColor), moisture: [0, alien ? 0.3 : 0.36], latitude: [0, 0.75] });
  biomes.push({ name: 'tundra', color: j(f.tundra), latitude: [0.98, 1.2] });
  biomes.push({ name: 'forest', color: j(f.forest), moisture: [ocean ? 0.45 : alien ? 0.5 : 0.56, 1] });
  if (alien && f.crystal) biomes.push({ name: 'crystal field', color: j(mul(f.crystal, 0.5)), moisture: [0.36, 0.45], maxSlope: 0.5 });
  biomes.push({ name: 'meadow', color: j(alien ? mix(f.meadow, f.grass, 0.4) : f.meadow), moisture: [0.2, 0.46] });
  biomes.push({ name: 'grass', color: j(f.grass) });
  return biomes;
}

function livingProps(f: Flora, rng: Rng, alien: boolean): PropDef[] {
  if (alien) {
    const crystal = f.crystal ?? mix(f.trunk, [1, 1, 1], 0.4);
    return [
      { kind: 'tree', density: round(rng.range(420, 650), 0), color: f.trunk, minSize: 14, maxSize: round(rng.range(30, 44), 0), biomes: ['forest'], maxSlope: 0.7 },
      { kind: 'tree', density: round(rng.range(70, 120), 0), color: mix(f.trunk, f.meadow, 0.35), minSize: 9, maxSize: 24, biomes: ['grass', 'meadow'], maxSlope: 0.6 },
      { kind: 'crystal', density: round(rng.range(20, 40), 0), color: crystal, minSize: 8, maxSize: 42, biomes: ['crystal field', 'rock', 'beach'] },
      { kind: 'spire', density: round(rng.range(2, 5), 1), color: f.spire ?? [0.95, 0.95, 0.95], minSize: 30, maxSize: 95, biomes: ['rock', 'tundra', 'beach'], maxSlope: 0.7 },
      { kind: 'rock', density: 30, color: mix(f.rock, [0.4, 0.4, 0.45], 0.45), minSize: 3, maxSize: 18, biomes: ['rock', 'tundra', 'beach', 'desert'] },
    ];
  }
  return [
    { kind: 'tree', density: round(rng.range(380, 620), 0), color: f.trunk, minSize: 12, maxSize: round(rng.range(26, 40), 0), biomes: ['forest'], maxSlope: 0.65 },
    { kind: 'tree', density: round(rng.range(60, 110), 0), color: mix(f.trunk, f.meadow, 0.3), minSize: 8, maxSize: 22, biomes: ['grass', 'meadow'], maxSlope: 0.55 },
    { kind: 'rock', density: 30, color: mix(f.rock, [0.5, 0.5, 0.5], 0.4), minSize: 4, maxSize: 20, biomes: ['rock', 'tundra', 'desert'] },
    ...(rng.chance(0.3) ? [{ kind: 'crystal' as const, density: 4, color: mix(f.trunk, [1, 1, 1], 0.4), minSize: 6, maxSize: 24, biomes: ['rock', 'meadow'] }] : []),
  ];
}

/** Brightest channel to 1, so a dark palette colour becomes a usable glow colour. */
function glowOf(c: RGB): RGB {
  const m = Math.max(c[0], c[1], c[2], 1e-3);
  return [round(c[0] / m, 2), round(c[1] / m, 2), round(c[2] / m, 2)];
}

/**
 * Some alien worlds glow at night: forests, crystal fields or seas. Decided by a hash of values the
 * world already has (flora trunk colour, sea level), so it draws nothing from the system rng and
 * every existing world keeps its look. Returns true when the world glows.
 */
function addBioluminescence(terrain: TerrainDef, f: Flora, waterColor: RGB): boolean {
  const h = hashInts(Math.round(f.trunk[0] * 1000), Math.round(f.trunk[1] * 1000), Math.round(f.trunk[2] * 1000), Math.round((terrain.seaLevel ?? 0) * 10000));
  if (h % 100 >= 70) return false;
  const mode = (h >>> 8) % 3;
  const palette: RGB[] = [f.trunk, f.crystal ?? f.trunk, waterColor];
  const glow = glowOf(palette[(h >>> 16) % 3]!);
  const treeGlow = [0.75, 0.3, 0.4][mode]!;
  for (const pd of terrain.props ?? []) {
    if (pd.kind === 'tree') pd.glow = treeGlow;
    else if (pd.kind === 'crystal') pd.glow = mode === 1 ? 1.2 : 0.5;
  }
  const forest = terrain.biomes.find((b) => b.name === 'forest');
  if (forest && mode === 0) forest.emissive = { color: glow, intensity: 0.05 };
  const field = terrain.biomes.find((b) => b.name === 'crystal field');
  if (field && mode === 1) field.emissive = { color: glow, intensity: 0.3 };
  if (mode === 2 && terrain.water) terrain.water.emissive = { color: glow, intensity: 0.08 };
  return true;
}

function skyAtmosphere(rng: Rng, theme: SkyTheme, o: { height: [number, number]; depth: [number, number]; mie: [number, number]; sun: [number, number]; coverage: [number, number]; cloudAlt?: number }): AtmosphereDef {
  const height = round(rng.range(o.height[0], o.height[1]), 3);
  return {
    height,
    scaleHeight: round(rng.range(0.12, 0.2), 3),
    rayleighDepth: rayleigh(theme, rng.range(o.depth[0], o.depth[1]), rng),
    mieDepth: round(rng.range(o.mie[0], o.mie[1]), 3),
    mieG: round(rng.range(0.72, 0.8), 2),
    mieColor: theme.mie,
    sunIntensity: round(rng.range(o.sun[0], o.sun[1]), 1),
    stabilization: 1,
    clouds: {
      altitude: round(o.cloudAlt ?? rng.range(0.06, 0.1), 3),
      thickness: round(rng.range(0.06, 0.1), 3),
      coverage: round(rng.range(o.coverage[0], o.coverage[1]), 2),
      color: theme.cloud,
      scale: round(rng.range(0.015, 0.03), 3),
      speed: round(rng.range(5, 14), 1),
    },
  };
}

/** Earthlike, ocean and alien living worlds share one builder. */
function buildLiving(rng: Rng, archetype: 'earthlike' | 'ocean' | 'alien'): Built {
  const ocean = archetype === 'ocean';
  let theme: Theme;
  if (archetype === 'alien') theme = rng.pick(ALIEN_THEMES);
  else {
    theme = {
      sky: 'blue',
      flora: rng.chance(0.8) ? 'terran' : 'autumn',
      water: rng.chance(0.7) ? 'blue' : 'turquoise',
      words: 'blue',
    };
  }
  const sky = SKIES[theme.sky]!;
  const flora = typeof theme.flora === 'string' ? FLORAS[theme.flora]! : theme.flora;
  const water = WATERS[theme.water]!;
  const seaLevel = round(ocean ? rng.range(0.52, 0.7) : rng.range(0.08, 0.3));
  const layers = jitterLayers(EARTH_LAYERS, rng).map((l, i) => (ocean && i < 3 ? { ...l, amplitude: round(l.amplitude * 0.8, 3) } : l));
  const atmosphere = skyAtmosphere(rng, sky, {
    height: [0.08, 0.13],
    depth: [0.22, 0.32],
    mie: [0.008, 0.03],
    sun: [13, 16],
    coverage: ocean ? [0.42, 0.62] : [0.3, 0.55],
  });
  const weather: WeatherDef[] = [
    { kind: 'rain', intensity: ocean ? 0.7 : round(rng.range(0.35, 0.6), 2), latitudeBand: [0, 0.9] },
    { kind: 'lightning', intensity: round(rng.range(0.25, 0.5), 2), latitudeBand: [0, 0.7] },
    { kind: 'snow', intensity: 0.6, latitudeBand: [1.0, 1.6] },
  ];
  atmosphere.weather = weather;
  atmosphere.absorptionDepth = archetype === 'earthlike' ? [0, 0.012, 0] : undefined;
  atmosphere.aurora = auroraFor(rng, sky, 0.55);
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.01, 0.016), 4),
    seaLevel,
    layers,
    biomes: livingBiomes(rng, flora, seaLevel, ocean, archetype === 'alien'),
    water: { color: jit(water.color, rng, 0.06), deepColor: jit(water.deepColor, rng, 0.08) },
    polarCaps: { latitude: round(rng.range(1.2, 1.4)), color: [0.88, 0.92, 0.96] },
    props: livingProps(flora, rng, archetype === 'alien'),
  };
  const glows = archetype === 'alien' && addBioluminescence(terrain, flora, water.color);
  const landColor = mix(flora.grass, flora.forest, 0.3);
  const color = mix(water.color, landColor, ocean ? 0.12 : 0.3);
  const fts = ocean ? ['Oceans', 'Islands', 'Storms'] : archetype === 'earthlike' ? ['Oceans', 'Forests', 'Clouds'] : ['Oceans', flora.words.replace(/^./, (c) => c.toUpperCase()), 'Strange sky'];
  if (glows) fts.push('Glowing nights');
  if (atmosphere.aurora) fts.push('Auroras');
  const skyWord = sky.name === 'blue' ? 'blue' : sky.name === 'magenta' ? 'magenta' : sky.name;
  const summaries = {
    earthlike: [
      `A green and blue world of oceans, ${flora.words} and drifting weather.`,
      `A gentle world where ${flora.words} meet bright seas under a ${skyWord} sky.`,
      'Warm seas, wide continents and clouds that glow at sunset.',
    ],
    ocean: [
      'An endless sea scattered with green islands and heavy storms.',
      'A water world where thunderheads roll over a few lonely islands.',
      'Nearly all ocean, with small islands and a sky full of clouds.',
    ],
    alien: [
      `A strange world of ${flora.words} beneath a ${skyWord} sky.`,
      `${theme.words.replace(/^./, (c) => c.toUpperCase())} light spills across ${flora.words} and quiet ${theme.water} seas.`,
      `Alien seas and ${flora.words} under a sky of ${skyWord} haze.`,
    ],
  };
  return {
    archetype,
    kind: 'rocky',
    radiusEarth: ocean ? rng.range(0.9, 1.7) : rng.range(0.8, 1.4),
    color,
    terrain,
    atmosphere,
    greenhouse: 33,
    atmosphereText: archetype === 'earthlike' ? 'Breathable' : archetype === 'ocean' ? 'Humid nitrogen' : rng.pick(['Argon and neon', 'Nitrogen with sulfur', 'Methane haze', 'Rich in ammonia']),
    type: 'Terrestrial',
    features: fts,
    summary: rng.pick(summaries[archetype]),
  };
}

const DESERT_PALETTES: { low: RGB; high: RGB; sand: RGB; dust: RGB; mie: RGB; name: string }[] = [
  { low: [0.2, 0.14, 0.12], high: [0.7, 0.48, 0.27], sand: [0.8, 0.42, 0.2], dust: [0.6, 0.26, 0.13], mie: [1.0, 0.62, 0.35], name: 'red' },
  { low: [0.25, 0.2, 0.1], high: [0.78, 0.62, 0.3], sand: [0.88, 0.7, 0.32], dust: [0.65, 0.5, 0.22], mie: [1.0, 0.8, 0.4], name: 'ochre' },
  { low: [0.35, 0.3, 0.28], high: [0.85, 0.8, 0.7], sand: [0.92, 0.88, 0.78], dust: [0.7, 0.62, 0.55], mie: [1.0, 0.92, 0.8], name: 'pale' },
  { low: [0.22, 0.12, 0.14], high: [0.75, 0.45, 0.42], sand: [0.85, 0.55, 0.5], dust: [0.6, 0.3, 0.32], mie: [1.0, 0.65, 0.6], name: 'rose' },
  { low: [0.15, 0.1, 0.2], high: [0.55, 0.4, 0.6], sand: [0.65, 0.45, 0.65], dust: [0.4, 0.25, 0.45], mie: [0.9, 0.65, 1.0], name: 'violet' },
  { low: [0.12, 0.16, 0.12], high: [0.4, 0.55, 0.4], sand: [0.5, 0.6, 0.3], dust: [0.3, 0.4, 0.25], mie: [0.8, 0.95, 0.55], name: 'green' },
];

function buildDesert(rng: Rng): Built {
  const p = rng.pick(DESERT_PALETTES);
  const feats: FeatureDef[] = [];
  if (rng.chance(0.6)) feats.push(...features(rng, 'volcano', rng.int(1, 2), [0.07, 0.12], [0.7, 1.0]));
  if (rng.chance(0.55)) feats.push(...features(rng, 'canyon', 1, [0.18, 0.28], [-0.7, -0.45]));
  if (rng.chance(0.5)) feats.push(...features(rng, 'mesa', rng.int(2, 4), [0.03, 0.06], [0.25, 0.5]));
  const j = (c: RGB): RGB => jit(c, rng, 0.07);
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.02, 0.035), 3),
    layers: jitterLayers(MARS_LAYERS, rng),
    craters: craters(rng, [100, 500], [0.06, 0.1]),
    features: feats,
    biomes: [
      { name: 'basalt lowlands', color: j(p.low), maxHeight: -0.2 },
      { name: 'highlands', color: j(p.high), minHeight: 0.2 },
      { name: 'sand', color: j(p.sand) },
      { name: 'dust', color: j(p.dust), moisture: [0, 0.4] },
    ],
    polarCaps: { latitude: round(rng.range(1.25, 1.4)), color: [0.95, 0.95, 0.97] },
    props: [
      { kind: 'rock', density: 12, color: mix(p.dust, [0.4, 0.4, 0.4], 0.3), minSize: 4, maxSize: 22 },
      { kind: 'mesa', density: 0.6, color: p.high, minSize: 40, maxSize: 120, minHeight: -0.1 },
    ],
  };
  const thickness = rng.range(0.035, 0.07);
  const atmosphere: AtmosphereDef = {
    height: round(rng.range(0.07, 0.1), 3),
    scaleHeight: round(rng.range(0.13, 0.18), 3),
    rayleighDepth: rayleigh(SKIES.blue!, thickness, rng),
    mieDepth: round(rng.range(0.12, 0.22), 3),
    mieG: round(rng.range(0.72, 0.78), 2),
    mieColor: p.mie,
    sunIntensity: round(rng.range(11, 14), 1),
    stabilization: 0.7,
    clouds: { altitude: 0.5, thickness: 0.2, coverage: round(rng.range(0.05, 0.25), 2), color: [0.95, 0.9, 0.85], scale: round(rng.range(0.03, 0.05), 3), speed: 20 },
    weather: [{ kind: 'dust', intensity: round(rng.range(0.4, 0.8), 2) }, { kind: 'dustDevil', intensity: 1, size: 0.002 }],
  };
  return {
    archetype: 'desert',
    kind: 'rocky',
    radiusEarth: rng.range(0.4, 1.1),
    color: p.sand,
    terrain,
    atmosphere,
    greenhouse: 5,
    atmosphereText: 'Thin carbon dioxide',
    type: 'Terrestrial',
    features: ['Dunes', feats.some((f) => f.kind === 'canyon') ? 'Canyons' : 'Plateaus', 'Polar caps', 'Dust storms'],
    hazards: ['Dust devils'],
    summary: rng.pick([
      `A dry ${p.name} desert under a dusty butterscotch sky.`,
      `Wind scoured ${p.name} plains and dust storms that rise at noon.`,
      `A cold ${p.name} wasteland with long shadows and thin air.`,
    ]),
  };
}

function buildLava(rng: Rng): Built {
  const glow = rng.pick<RGB>([[1.0, 0.36, 0.04], [1.0, 0.24, 0.03], [1.0, 0.5, 0.06], [1.0, 0.3, 0.14]]);
  const ash = rng.pick<RGB>([[0.03, 0.025, 0.024], [0.033, 0.026, 0.026], [0.026, 0.026, 0.032]]);
  const crust = rng.pick<RGB>([[0.024, 0.024, 0.028], [0.03, 0.027, 0.025], [0.022, 0.024, 0.032]]);
  const basalt = rng.pick<RGB>([[0.012, 0.012, 0.015], [0.015, 0.013, 0.013], [0.011, 0.012, 0.017]]);
  const lavaLevel = round(rng.range(-0.24, -0.16));
  const feats = [...features(rng, 'volcano', rng.int(2, 4), [0.05, 0.1], [0.5, 0.9])];
  if (rng.chance(0.5)) feats.push(...features(rng, 'spires', rng.int(1, 3), [0.03, 0.06], [0.3, 0.6]));
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.02, 0.03), 3),
    layers: jitterLayers(
      [
        { type: 'fbm', frequency: 2, amplitude: 0.7, octaves: 5 },
        { type: 'ridged', frequency: 5, amplitude: 0.5, octaves: 5, warp: 0.5 },
        { type: 'ridged', frequency: 18, amplitude: 0.2, octaves: 4 },
        { type: 'billow', frequency: 8, amplitude: 0.25, octaves: 3 },
        { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
      ],
      rng,
    ),
    features: feats,
    biomes: [
      // Glow only in the lowest channels, in thin cracks and on the volcano summits. Rank order matters.
      { name: 'lava channel', color: glow, maxHeight: lavaLevel, emissive: { intensity: 1.1, day: 0.2 } },
      { name: 'caldera', color: mix(glow, [1, 0.75, 0.2], 0.3), minHeight: 0.72, emissive: { intensity: 1.6, day: 0.2 } },
      { name: 'glowing cracks', color: mix(glow, [0.5, 0.1, 0.02], 0.25), moisture: [0.475, 0.525], maxHeight: 0.35, emissive: { intensity: 1.0, day: 0.15 } },
      { name: 'cooled crust', color: jit(crust, rng, 0.08), minHeight: 0.45 },
      { name: 'ash plains', color: jit(ash, rng, 0.1), minHeight: 0.0 },
      { name: 'basalt', color: jit(basalt, rng, 0.1) },
    ],
    craters: craters(rng, [50, 250], [0.04, 0.08]),
    props: [
      { kind: 'rock', density: 30, color: [0.1, 0.09, 0.09], minSize: 4, maxSize: 24 },
      { kind: 'spire', density: 2.5, color: [0.07, 0.065, 0.065], minSize: 20, maxSize: 70, biomes: ['cooled crust', 'ash plains', 'basalt'] },
    ],
  };
  const haze = rng.chance(0.75);
  const atmosphere: AtmosphereDef | undefined = haze
    ? {
        height: round(rng.range(0.08, 0.14), 3),
        scaleHeight: round(rng.range(0.15, 0.22), 3),
        rayleighDepth: rayleigh(SKIES.smoke!, rng.range(0.1, 0.16), rng),
        mieDepth: round(rng.range(0.05, 0.1), 3),
        mieG: 0.72,
        mieColor: [0.8, 0.5, 0.35],
        sunIntensity: round(rng.range(10, 12.5), 1),
        stabilization: 1,
        clouds: { altitude: 0.3, thickness: 0.2, coverage: round(rng.range(0.35, 0.65), 2), color: [0.3, 0.22, 0.2], scale: 0.04, speed: round(rng.range(15, 35), 1) },
        weather: [{ kind: 'lightning', intensity: round(rng.range(0.4, 0.7), 2) }],
      }
    : undefined;
  return {
    archetype: 'lava',
    kind: 'rocky',
    radiusEarth: rng.range(0.4, 1.3),
    color: mix(glow, [0.1, 0.09, 0.09], 0.72),
    terrain,
    atmosphere,
    greenhouse: 450,
    atmosphereText: haze ? 'Sulfur smoke' : 'None',
    type: 'Terrestrial',
    features: ['Lava seas', 'Volcanoes', haze ? 'Ash clouds' : 'Glowing cracks'],
    effects: [
      { kind: 'heatShimmer', intensity: 0.9 },
      { kind: 'scorching', intensity: 0.8 },
      { kind: 'volcanicPlume', intensity: 0.8, size: 0.12, color: [1.0, 0.55, 0.3] },
    ],
    hazards: ['Searing heat', 'Erupting volcanoes'],
    summary: rng.pick([
      'A scorched world where rivers of lava glow under black crust.',
      'Molten lowlands burn red beneath a sky of drifting ash.',
      'A furnace of volcanoes and glowing seas, too close to its star.',
    ]),
  };
}

function buildIce(rng: Rng): Built {
  const tint = rng.pick<{ ice: RGB; blue: RGB; deep: RGB; name: string }>([
    { ice: [0.9, 0.94, 0.98], blue: [0.55, 0.75, 0.92], deep: [0.12, 0.28, 0.5], name: 'blue' },
    { ice: [0.88, 0.96, 0.97], blue: [0.5, 0.85, 0.9], deep: [0.1, 0.35, 0.45], name: 'cyan' },
    { ice: [0.95, 0.92, 0.97], blue: [0.72, 0.65, 0.9], deep: [0.25, 0.18, 0.45], name: 'lavender' },
    { ice: [0.97, 0.94, 0.9], blue: [0.8, 0.72, 0.62], deep: [0.35, 0.24, 0.16], name: 'cream' },
  ]);
  const feats = rng.chance(0.4) ? features(rng, 'spires', rng.int(1, 3), [0.03, 0.05], [0.2, 0.4]) : [];
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.006, 0.014), 4),
    layers: jitterLayers(
      [
        { type: 'fbm', frequency: 1.5, amplitude: 0.5, octaves: 4 },
        { type: 'ridged', frequency: 6, amplitude: 0.5, octaves: 4, warp: 0.25 },
        { type: 'ridged', frequency: 22, amplitude: 0.16, octaves: 4 },
        { type: 'billow', frequency: 4, amplitude: 0.12, octaves: 3 },
        { type: 'fbm', frequency: 40, amplitude: 0.04, octaves: 3 },
      ],
      rng,
    ),
    features: feats,
    craters: rng.chance(0.5) ? craters(rng, [60, 300], [0.04, 0.08]) : undefined,
    biomes: [
      { name: 'crevasse', color: jit(tint.deep, rng, 0.08), minHeight: 0.4 },
      { name: 'blue ice', color: jit(tint.blue, rng, 0.06), maxHeight: -0.15 },
      { name: 'snowfield', color: jit(tint.ice, rng, 0.03) },
    ],
    polarCaps: { latitude: 1.1, color: [0.94, 0.96, 0.98] },
    props: [
      { kind: 'crystal', density: 2.5, color: mix(tint.blue, [1, 1, 1], 0.4), minSize: 6, maxSize: 30, biomes: ['blue ice', 'snowfield'] },
      { kind: 'rock', density: 3, color: [0.55, 0.57, 0.6], minSize: 3, maxSize: 14 },
    ],
  };
  const sky = SKIES.blue!;
  const atmosphere: AtmosphereDef = {
    height: round(rng.range(0.07, 0.12), 3),
    scaleHeight: round(rng.range(0.14, 0.2), 3),
    rayleighDepth: rayleigh(sky, rng.range(0.1, 0.18), rng),
    mieDepth: round(rng.range(0.03, 0.08), 3),
    mieG: 0.78,
    mieColor: [0.92, 0.96, 1],
    sunIntensity: round(rng.range(12, 15), 1),
    stabilization: 1,
    clouds: { altitude: 0.1, thickness: 0.08, coverage: round(rng.range(0.15, 0.4), 2), color: [0.97, 0.98, 1], scale: round(rng.range(0.02, 0.04), 3), speed: round(rng.range(6, 12), 1) },
    weather: [{ kind: 'snow', intensity: round(rng.range(0.5, 0.9), 2) }],
    aurora: auroraFor(rng, sky, 0.5),
  };
  return {
    archetype: 'ice',
    kind: 'rocky',
    radiusEarth: rng.range(0.5, 1.5),
    color: mix(tint.ice, tint.blue, 0.4),
    terrain,
    atmosphere,
    greenhouse: 0,
    atmosphereText: 'Thin nitrogen',
    type: 'Terrestrial',
    features: ['Glaciers', 'Crevasses', 'Snowfall', ...(atmosphere.aurora ? ['Auroras'] : [])],
    effects: [{ kind: 'geyser', intensity: 0.7, size: 0.03, count: 4 }],
    hazards: ['Freezing winds', 'Ice geysers'],
    summary: rng.pick([
      `A frozen ${tint.name} world of glaciers split by deep crevasses.`,
      'Endless ice fields under a pale sky and slow falling snow.',
      'A silent white world where the wind carves long ridges of ice.',
    ]),
  };
}

function buildToxic(rng: Rng): Built {
  const variants: { theme: string; ground: RGB[]; cloud: RGB; name: string }[] = [
    { theme: 'amber', ground: [[0.5, 0.3, 0.16], [0.42, 0.22, 0.09], [0.28, 0.14, 0.07]], cloud: [1.0, 0.92, 0.72], name: 'yellow' },
    { theme: 'green', ground: [[0.36, 0.42, 0.18], [0.26, 0.32, 0.12], [0.14, 0.18, 0.08]], cloud: [0.85, 0.98, 0.7], name: 'green' },
    { theme: 'magenta', ground: [[0.5, 0.25, 0.4], [0.36, 0.16, 0.3], [0.2, 0.08, 0.18]], cloud: [1.0, 0.82, 0.92], name: 'pink' },
    { theme: 'violet', ground: [[0.4, 0.3, 0.5], [0.28, 0.2, 0.4], [0.14, 0.1, 0.22]], cloud: [0.92, 0.85, 1.0], name: 'violet' },
    { theme: 'teal', ground: [[0.25, 0.45, 0.42], [0.16, 0.34, 0.32], [0.08, 0.18, 0.2]], cloud: [0.85, 1.0, 0.98], name: 'teal' },
  ];
  const v = rng.pick(variants);
  const sky = SKIES[v.theme]!;
  const feats = features(rng, 'volcano', rng.int(2, 4), [0.05, 0.1], [0.4, 0.8]);
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.012, 0.02), 3),
    layers: jitterLayers(
      [
        { type: 'fbm', frequency: 1.2, amplitude: 0.8, octaves: 5 },
        { type: 'billow', frequency: 6, amplitude: 0.3, octaves: 4 },
        { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
      ],
      rng,
    ),
    features: feats,
    biomes: [
      { name: 'highlands', color: jit(v.ground[0]!, rng, 0.06), minHeight: 0.35 },
      { name: 'volcanic plains', color: jit(v.ground[1]!, rng, 0.06) },
      { name: 'basalt', color: jit(v.ground[2]!, rng, 0.06), maxHeight: -0.2 },
    ],
    props: [{ kind: 'spire', density: 1.5, color: mul(v.ground[2]!, 0.8), minSize: 15, maxSize: 60 }],
  };
  const atmosphere: AtmosphereDef = {
    height: round(rng.range(0.12, 0.2), 3),
    scaleHeight: round(rng.range(0.18, 0.24), 3),
    rayleighDepth: rayleigh(sky, rng.range(0.16, 0.24), rng),
    mieDepth: round(rng.range(0.15, 0.3), 3),
    mieG: 0.7,
    mieColor: sky.mie,
    sunIntensity: round(rng.range(20, 25), 1),
    stabilization: 1,
    clouds: { altitude: 0.35, thickness: 0.3, coverage: round(rng.range(0.85, 0.97), 2), color: v.cloud, scale: round(rng.range(0.04, 0.06), 3), speed: round(rng.range(40, 70), 1) },
    weather: [
      { kind: 'lightning', intensity: round(rng.range(0.4, 0.7), 2) },
      { kind: 'acidRain', intensity: 0.8 },
      { kind: 'heatShimmer', intensity: 0.7 },
    ],
  };
  return {
    archetype: 'toxic',
    kind: 'rocky',
    radiusEarth: rng.range(0.8, 1.2),
    color: mix(v.ground[0]!, v.cloud, 0.5),
    terrain,
    atmosphere,
    greenhouse: 380,
    atmosphereText: rng.pick(['Thick carbon dioxide', 'Thick sulfur and chlorine', 'Crushing acid fog']),
    type: 'Terrestrial',
    features: ['Volcanoes', 'Lightning', `${v.name.replace(/^./, (c) => c.toUpperCase())} clouds`],
    hazards: ['Acid rain', 'Crushing heat'],
    summary: rng.pick([
      `A shrouded ${v.name} world under a crushing, cloud thick sky.`,
      `Acid ${v.name} fog hides a land of volcanoes and constant lightning.`,
      `A heavy ${v.name} haze wraps this world like a blanket.`,
    ]),
  };
}

const ROCK_PALETTES: { a: RGB; b: RGB; c: RGB; name: string }[] = [
  { a: [0.2, 0.19, 0.18], b: [0.42, 0.4, 0.38], c: [0.3, 0.28, 0.26], name: 'grey' },
  { a: [0.3, 0.27, 0.24], b: [0.5, 0.48, 0.45], c: [0.42, 0.34, 0.26], name: 'brown' },
  { a: [0.14, 0.15, 0.2], b: [0.36, 0.4, 0.5], c: [0.25, 0.28, 0.36], name: 'blue grey' },
  { a: [0.25, 0.14, 0.1], b: [0.55, 0.32, 0.22], c: [0.4, 0.22, 0.15], name: 'rust' },
  { a: [0.22, 0.2, 0.12], b: [0.55, 0.5, 0.3], c: [0.4, 0.36, 0.2], name: 'ochre' },
];

function buildCratered(rng: Rng): Built {
  const p = rng.pick(ROCK_PALETTES);
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.015, 0.025), 3),
    layers: jitterLayers(MOON_LAYERS, rng),
    craters: craters(rng, [900, 4500], [0.07, 0.12]),
    biomes: [
      { name: 'dark plains', color: jit(p.a, rng, 0.08), maxHeight: -0.1 },
      { name: 'rim', color: mul(p.b, 1.15), minHeight: 0.3 },
      { name: 'highlands', color: jit(p.c, rng, 0.08) },
    ],
    props: [{ kind: 'rock', density: 14, color: mix(p.b, [0.6, 0.6, 0.6], 0.3), minSize: 2, maxSize: 14 }],
  };
  return {
    archetype: 'cratered',
    kind: 'rocky',
    radiusEarth: rng.range(0.25, 0.9),
    color: p.b,
    terrain,
    greenhouse: 0,
    atmosphereText: 'None',
    type: 'Terrestrial',
    features: ['Craters', 'Dark plains', 'Silence'],
    summary: rng.pick([
      `A ${p.name} world with no air, scarred by ancient impacts.`,
      'Bare rock and crater upon crater under a black sky.',
      'A dead, airless ball of stone with long sharp shadows.',
    ]),
  };
}

// Gas giants

interface GasFamily {
  name: string;
  hue: number;
  hueSpread: number;
  sat: [number, number];
  light: [number, number];
  sky: string;
}

const GAS_FAMILIES: GasFamily[] = [
  { name: 'ochre', hue: 36, hueSpread: 14, sat: [0.3, 0.55], light: [0.45, 0.82], sky: 'amber' },
  { name: 'teal', hue: 178, hueSpread: 14, sat: [0.3, 0.55], light: [0.4, 0.78], sky: 'teal' },
  { name: 'rose', hue: 348, hueSpread: 14, sat: [0.3, 0.55], light: [0.5, 0.85], sky: 'magenta' },
  { name: 'violet', hue: 268, hueSpread: 14, sat: [0.25, 0.5], light: [0.4, 0.8], sky: 'violet' },
  { name: 'slate', hue: 215, hueSpread: 8, sat: [0.1, 0.25], light: [0.4, 0.8], sky: 'blue' },
];

function buildGas(rng: Rng): Built {
  const fam = rng.pick(GAS_FAMILIES);
  const bands: RGB[] = [];
  const hue = fam.hue + rng.range(-10, 10);
  for (let i = 0; i < 4; i++) bands.push(hsl(hue + rng.range(-fam.hueSpread, fam.hueSpread), rng.range(fam.sat[0], fam.sat[1]), rng.range(fam.light[0], fam.light[1])));
  const storms: NonNullable<GasDef['storms']> = [];
  const nStorms = rng.chance(0.6) ? rng.int(1, 2) : 0;
  for (let i = 0; i < nStorms; i++) {
    storms.push({
      lat: round((rng.chance(0.5) ? -1 : 1) * rng.range(12, 40) * DEG),
      lon: round(rng.range(-Math.PI, Math.PI)),
      size: round(rng.range(0.07, 0.14), 3),
      color: i === 0 ? mix(bands[2]!, hsl(hue + 180, 0.5, 0.35), 0.15) : mul(bands[1]!, 0.7),
    });
  }
  const sky = SKIES[fam.sky]!;
  const atmosphere: AtmosphereDef = {
    height: round(rng.range(0.035, 0.05), 3),
    scaleHeight: 0.2,
    rayleighDepth: rayleigh(sky, rng.range(0.14, 0.2), rng),
    mieDepth: round(rng.range(0.14, 0.22), 3),
    mieG: 0.75,
    mieColor: mix([1, 1, 1], bands[0]!, 0.5),
    sunIntensity: round(rng.range(12, 14), 1),
    weather: rng.chance(0.6) ? [{ kind: 'lightning', intensity: round(rng.range(0.5, 0.9), 2) }] : undefined,
    aurora: auroraFor(rng, sky, 0.4),
  };
  const gas: GasDef = {
    bands,
    bandFrequency: round(rng.range(8, 22), 1),
    turbulence: round(rng.range(0.15, 0.7), 2),
    storms: storms.length ? storms : undefined,
    cloudDeckDepth: 0.02,
  };
  return {
    archetype: 'gas',
    kind: 'gas',
    radiusEarth: rng.range(5, 12.5),
    color: bands[1]!,
    gas,
    atmosphere,
    greenhouse: 0,
    atmosphereText: 'Hydrogen and helium',
    type: 'Gas giant',
    features: [`${fam.name.replace(/^./, (c) => c.toUpperCase())} bands`, storms.length ? 'Great storms' : 'Cloud belts', ...(atmosphere.aurora ? ['Auroras'] : [])],
    summary: rng.pick([
      `A banded ${fam.name} giant of swirling clouds.`,
      `A vast ${fam.name} world of storms and cloud belts, bigger than any ground to stand on.`,
      `Soft ${fam.name} stripes wrap a giant that could swallow a hundred worlds.`,
    ]),
  };
}

function buildIceGiant(rng: Rng): Built {
  const hue = rng.pick([200, 190, 215, 170, 235]) + rng.range(-8, 8);
  const bands: RGB[] = [];
  for (let i = 0; i < 4; i++) bands.push(hsl(hue + rng.range(-10, 10), rng.range(0.4, 0.65), rng.range(0.35, 0.75)));
  const storms = rng.chance(0.35) ? [{ lat: round(-rng.range(15, 35) * DEG), lon: round(rng.range(-3, 3)), size: round(rng.range(0.07, 0.12), 3), color: mul(bands[2]!, 0.4) }] : undefined;
  const sky = SKIES.blue!;
  const atmosphere: AtmosphereDef = {
    height: round(rng.range(0.04, 0.055), 3),
    scaleHeight: 0.2,
    rayleighDepth: rayleigh(sky, rng.range(0.18, 0.25), rng),
    mieDepth: round(rng.range(0.1, 0.16), 3),
    mieG: 0.72,
    mieColor: [0.82, 0.94, 1],
    absorptionDepth: [0.15, 0.02, 0],
    sunIntensity: round(rng.range(11, 13), 1),
    aurora: auroraFor(rng, sky, 0.3),
  };
  return {
    archetype: 'iceGiant',
    kind: 'gas',
    radiusEarth: rng.range(2.5, 4.5),
    color: bands[1]!,
    gas: { bands, bandFrequency: round(rng.range(5, 9), 1), turbulence: round(rng.range(0.1, 0.4), 2), storms, cloudDeckDepth: 0.02 },
    atmosphere,
    greenhouse: 0,
    atmosphereText: 'Hydrogen, helium and methane',
    type: 'Ice giant',
    features: ['Cyan haze', storms ? 'Dark storm' : 'Fast winds', 'Methane clouds'],
    summary: rng.pick(['A cool blue giant wrapped in methane haze.', 'A calm cyan world of high, fast winds.', 'A deep blue giant, quiet on the outside and violent underneath.']),
  };
}

function buildArchetype(rng: Rng, a: Archetype): Built {
  switch (a) {
    case 'earthlike':
    case 'ocean':
    case 'alien':
      return buildLiving(rng, a);
    case 'desert':
      return buildDesert(rng);
    case 'lava':
      return buildLava(rng);
    case 'ice':
      return buildIce(rng);
    case 'toxic':
      return buildToxic(rng);
    case 'cratered':
      return buildCratered(rng);
    case 'gas':
      return buildGas(rng);
    case 'iceGiant':
      return buildIceGiant(rng);
  }
}

function pickArchetype(rng: Rng, t: number): Archetype {
  // Giants first: they live beyond the snow line.
  const pGiant = t < 0.9 ? 0 : t < 2 ? 0.1 : t < 6 ? 0.45 : 0.4;
  if (rng.chance(pGiant)) return t > 5 && rng.chance(0.5) ? 'iceGiant' : 'gas';
  if (t < 0.45) return rng.weighted({ lava: 0.5, cratered: 0.3, toxic: 0.2 });
  if (t < 0.8) return rng.weighted({ lava: 0.22, toxic: 0.25, desert: 0.2, cratered: 0.25, alien: 0.08 });
  if (t < 1.7) return rng.weighted({ earthlike: 0.3, ocean: 0.17, desert: 0.15, alien: 0.2, toxic: 0.05, cratered: 0.07, ice: 0.06 });
  if (t < 3) return rng.weighted({ desert: 0.2, ice: 0.22, cratered: 0.2, alien: 0.16, earthlike: 0.12, ocean: 0.06, toxic: 0.04 });
  return rng.weighted({ ice: 0.5, cratered: 0.4, desert: 0.1 });
}

// ---------------------------------------------------------------------------------------------
// Moons and rings

type MoonKind = 'cratered' | 'ice' | 'volcanic';

function buildMoon(rng: Rng, kind: MoonKind, name: string, parent: BodyDef, ratio: number, parentMassKg: number): BodyDef {
  const radius = rng.range(3e5, 2.4e6) * (kind === 'cratered' ? 0.8 : 1);
  const a = ratio * parent.physical.radius;
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / (G_CONST * parentMassKg));
  const orbit: OrbitDef = {
    semiMajorAxis: a,
    eccentricity: round(rng.range(0, 0.05), 4),
    inclination: round(rng.range(0, 4) * DEG, 4),
    ascendingNode: round(rng.range(0, Math.PI * 2), 3),
    argPeriapsis: round(rng.range(0, Math.PI * 2), 3),
    meanAnomalyAtEpoch: round(rng.range(0, Math.PI * 2), 3),
    period,
  };
  let terrain: TerrainDef;
  let color: RGB;
  let info: BodyDef['info'];
  const gravity = round(0.165 * (radius / 1.74e6), 4);
  if (kind === 'cratered') {
    const p = rng.pick(ROCK_PALETTES);
    color = p.b;
    terrain = {
      amplitude: 0.02,
      layers: jitterLayers(MOON_LAYERS, rng),
      craters: craters(rng, [1200, 4500], [0.08, 0.12]),
      biomes: [
        { name: 'maria', color: jit(mul(p.a, 0.5), rng, 0.1), maxHeight: -0.1 },
        { name: 'floor', color: jit(p.a, rng, 0.1), maxHeight: 0.0 },
        { name: 'rim', color: mul(p.b, 1.1), minHeight: 0.3 },
        { name: 'highlands', color: jit(p.c, rng, 0.1) },
      ],
      props: [{ kind: 'rock', density: 15, color: mix(p.b, [0.6, 0.6, 0.6], 0.3), minSize: 2, maxSize: 14 }],
    };
    info = {
      type: 'Moon',
      atmosphere: 'None',
      temperature: '',
      features: ['Craters', 'Dark plains'],
      summary: rng.pick(['Grey and silent, scarred by ancient impacts.', `A small ${p.name} moon pocked with craters.`, 'A cold dead stone circling its world.']),
    };
  } else if (kind === 'ice') {
    const t = rng.pick<{ ice: RGB; crack: RGB }>([
      { ice: [0.94, 0.92, 0.88], crack: [0.5, 0.33, 0.2] },
      { ice: [0.9, 0.95, 0.98], crack: [0.35, 0.5, 0.65] },
      { ice: [0.95, 0.92, 0.96], crack: [0.55, 0.4, 0.55] },
    ]);
    color = t.ice;
    terrain = {
      amplitude: 0.004,
      layers: jitterLayers(
        [
          { type: 'fbm', frequency: 1.5, amplitude: 0.5, octaves: 3 },
          { type: 'ridged', frequency: 6, amplitude: 0.5, octaves: 4 },
        ],
        rng,
      ),
      biomes: [
        { name: 'cracks', color: jit(t.crack, rng, 0.06), minHeight: 0.3 },
        { name: 'shadowed ice', color: mul(t.ice, 0.9), maxHeight: -0.1 },
        { name: 'white ice', color: t.ice },
      ],
      props: [{ kind: 'crystal', density: 2, color: [0.85, 0.92, 1], minSize: 4, maxSize: 18 }],
    };
    info = {
      type: 'Moon',
      atmosphere: 'None',
      temperature: '',
      features: ['Ice shell', 'Cracks'],
      summary: rng.pick(['A smooth white moon scored by long cracks.', 'A bright ball of ice with a hidden sea beneath.', 'A pale icy moon that gleams in the starlight.']),
    };
  } else {
    const t = rng.pick<{ base: RGB; hi: RGB; frost: RGB }>([
      { base: [0.95, 0.82, 0.28], hi: [0.82, 0.48, 0.14], frost: [0.92, 0.9, 0.85] },
      { base: [0.75, 0.85, 0.35], hi: [0.4, 0.55, 0.2], frost: [0.9, 0.94, 0.8] },
      { base: [0.8, 0.5, 0.35], hi: [0.5, 0.2, 0.15], frost: [0.9, 0.85, 0.82] },
    ]);
    color = t.base;
    terrain = {
      amplitude: 0.02,
      layers: jitterLayers(
        [
          { type: 'fbm', frequency: 2, amplitude: 0.6, octaves: 5 },
          { type: 'ridged', frequency: 8, amplitude: 0.3, octaves: 3 },
          { type: 'fbm', frequency: 30, amplitude: 0.06, octaves: 4 },
        ],
        rng,
      ),
      features: features(rng, 'volcano', rng.int(2, 4), [0.04, 0.1], [0.3, 0.5]),
      biomes: [
        { name: 'frost', color: t.frost, latitude: [1.2, 1.6] },
        { name: 'dark sulfur', color: t.hi, minHeight: 0.2 },
        { name: 'bright plains', color: t.base },
      ],
      props: [{ kind: 'rock', density: 6, color: mul(t.hi, 0.6), minSize: 3, maxSize: 14 }],
    };
    info = {
      type: 'Moon',
      atmosphere: 'Thin sulfur dioxide',
      temperature: '',
      features: ['Volcanoes', 'Lava lakes'],
      summary: rng.pick(['A restless moon painted in sulfur colors.', 'Volcanoes stain this small moon yellow and orange.', 'A hot little moon, squeezed by its giant parent.']),
    };
  }
  return {
    id: slug(name),
    name,
    kind: 'rocky',
    parentId: parent.id,
    seed: rng.seed(),
    physical: { radius, surfaceGravity: gravity, rotationPeriod: period, axialTilt: 0, tidallyLocked: true },
    orbit,
    visual: { color },
    terrain,
    ...(kind === 'ice'
      ? { effects: [{ kind: 'geyser' as const, intensity: 0.8, size: 0.09, count: 6 }] }
      : kind === 'volcanic'
        ? { effects: [{ kind: 'volcanicPlume' as const, intensity: 1, size: 0.4, color: [0.55, 0.7, 1.0] as const }] }
        : {}),
    info: kind === 'ice' ? { ...info, hazards: ['Ice geysers'] } : kind === 'volcanic' ? { ...info, hazards: ['Erupting volcanoes'] } : info,
  };
}

function buildRings(rng: Rng, base: RGB, faint: boolean, grand = false): RingDef {
  const inner = round(grand ? rng.range(1.25, 1.45) : rng.range(1.2, 1.8), 2);
  return {
    innerRadius: inner,
    outerRadius: round(inner + (grand ? rng.range(1.2, 1.7) : rng.range(0.4, 1.0)), 2),
    color: jit(mix(base, [0.85, 0.8, 0.7], 0.5), rng, 0.08),
    opacity: round(faint ? rng.range(0.15, 0.4) : grand ? rng.range(0.75, 0.92) : rng.range(0.55, 0.9), 2),
    bands: grand ? rng.int(40, 64) : rng.int(14, 44),
  };
}

// ---------------------------------------------------------------------------------------------
// System assembly

/** Default sphere of influence factors for generated planets. Gas giants hold wide moon systems. */
const SOI_ROCKY = 20;
const SOI_GAS = 18;
const GAME_ORBIT_SCALE = 0.001;
const GAME_RADIUS_SCALE = 0.1;
const GAME_STAR_SCALE = 0.005;

export function generateSystem(star: GalaxyStar): StarSystemDef {
  if (star.id === 'sol') return SOLAR_SYSTEM;
  const rng = new Rng(star.seed);
  const spec = STAR_SPECS[star.starClass];
  const planetCountRng = new Rng(star.seed ^ 0x9e3779b9);
  const planetCount = planetCountFor(planetCountRng, star.starClass);
  const starDef = buildStar(rng, star, spec);
  const bodies: BodyDef[] = [starDef];
  const usedNames = new Set<string>([star.name]);
  const uniqueName = (): string => {
    for (let i = 0; i < 40; i++) {
      const n = makeName(rng.r.bind(rng));
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
    const n = `${makeName(rng.r.bind(rng))}${usedNames.size}`;
    usedNames.add(n);
    return n;
  };

  const sqrtL = Math.sqrt(spec.luminosity);
  const starGameRadius = starDef.physical.radius * GAME_STAR_SCALE;
  const starMass = spec.massSolar * SOLAR_MASS;
  const ratio = rng.range(1.4, 2.0);
  let targetA = rng.range(0.3, 0.45) * AU * spec.orbitScale;
  let prevA = 0;
  let prevSoi = 0;
  const planets: { def: BodyDef; built: Built }[] = [];
  let hasLiving = false;

  for (let i = 0; i < planetCount; i++) {
    const t = targetA / AU / sqrtL;
    let archetype = pickArchetype(rng, t);
    // Make exploring rewarding: a system without a living world gets one in its warm zone, most of the time.
    const rockyArch = archetype !== 'gas' && archetype !== 'iceGiant';
    if (!hasLiving && rockyArch && t > 0.7 && t < 2.4 && rng.chance(0.6)) archetype = rng.weighted<'earthlike' | 'ocean' | 'alien'>({ earthlike: 0.4, ocean: 0.2, alien: 0.4 });
    const built = buildArchetype(rng, archetype);
    // Rare beauty: a gigantic ice giant, usually ringed.
    const colossus = built.archetype === 'iceGiant' && rng.chance(0.2);
    if (colossus) built.radiusEarth = rng.range(6.5, 8.5);
    const radius = built.radiusEarth * R_EARTH;
    const gameRadius = radius * GAME_RADIUS_SCALE;
    const soiFactor = built.kind === 'gas' ? SOI_GAS : SOI_ROCKY;
    const soi = soiFactor * gameRadius;
    let a = targetA;
    if (i === 0) a = Math.max(a, (3 * soi + 3 * starGameRadius) / GAME_ORBIT_SCALE);
    else a = Math.max(a, prevA + (2.4 * Math.max(soi, prevSoi)) / GAME_ORBIT_SCALE);
    const dAU = a / AU;
    const tEq = 255 * Math.pow(spec.luminosity, 0.25) / Math.sqrt(dAU) - 273 + built.greenhouse;
    const name = uniqueName();
    const id = slug(name) || `p${i}`;
    const mass = (built.kind === 'gas' ? rng.range(0.9, 2.6) : Math.pow(built.radiusEarth, 0.9) * 0.95) * 9.81 * radius * radius / G_CONST;
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / (G_CONST * starMass));
    const retro = rng.chance(0.05) ? -1 : 1;
    const gravity = built.kind === 'gas' ? round(rng.range(0.9, 2.6), 2) : round(Math.min(2.2, Math.max(0.2, Math.pow(built.radiusEarth, 0.9) * 0.95)), 2);
    const rotationPeriod = (built.kind === 'gas' ? rng.range(8, 18) : rng.range(10, 40)) * 3600 * retro;
    const hasRings = colossus ? rng.chance(0.85) : rng.chance(built.kind === 'gas' ? (built.archetype === 'iceGiant' ? 0.5 : 0.35) : 0.05);
    const living = built.archetype === 'earthlike' || built.archetype === 'ocean' || built.archetype === 'alien';
    // Worlds baked by their star (equilibrium temperature, no extra effects yet) get the scorching sun.
    const baked = built.kind === 'rocky' && tEq - built.greenhouse > 200 && !built.effects?.length;
    const effects = baked
      ? [{ kind: 'heatShimmer' as const, intensity: 0.8 }, { kind: 'scorching' as const, intensity: 0.7 }]
      : built.effects;
    const hazards = baked ? ['Searing heat'] : built.hazards;
    const def: BodyDef = {
      id,
      name,
      kind: built.kind,
      parentId: starDef.id,
      seed: rng.seed(),
      physical: {
        radius,
        surfaceGravity: gravity,
        rotationPeriod,
        axialTilt: round(rng.chance(0.1) ? rng.range(40, 100) * DEG : rng.range(0, 30) * DEG, 3),
      },
      orbit: {
        semiMajorAxis: a,
        eccentricity: round(rng.range(0, 0.07), 4),
        inclination: round(rng.range(0, 3) * DEG, 4),
        ascendingNode: round(rng.range(0, Math.PI * 2), 3),
        argPeriapsis: round(rng.range(0, Math.PI * 2), 3),
        meanAnomalyAtEpoch: round(rng.range(0, Math.PI * 2), 3),
        period,
      },
      visual: { color: built.color, soiFactor },
      ...(built.atmosphere ? { atmosphere: built.atmosphere } : {}),
      ...(built.terrain ? { terrain: built.terrain } : {}),
      ...(built.gas ? { gas: built.gas } : {}),
      ...(effects ? { effects } : {}),
      ...(hasRings ? { rings: buildRings(rng, built.color, built.kind !== 'gas', built.kind === 'gas' && rng.chance(colossus ? 0.8 : 0.25)) } : {}),
      info: {
        type: built.type,
        atmosphere: built.atmosphereText,
        temperature: celsiusText(built.kind === 'gas' ? Math.max(-215, tEq - 20) : surfaceTemp(built.archetype, tEq)),
        features: hasRings ? [...built.features, 'Rings'] : built.features,
        ...(hazards ? { hazards } : {}),
        summary: built.summary,
      },
    };
    if (living) hasLiving = true;
    // Landmarks use their own PRNG stream, so they never shift the draws above or below.
    if (def.kind === 'rocky' && def.terrain) {
      const lw: LandmarkWorld = living ? 'living' : (built.archetype as LandmarkWorld);
      def.landmarks = generateLandmarks(def, lw, radius * GAME_RADIUS_SCALE);
    }
    planets.push({ def, built });
    bodies.push(def);

    // Moons
    const moonCount = built.kind === 'gas' ? rng.int(0, 4) : built.radiusEarth >= 0.9 && rng.chance(0.55) ? rng.int(1, 2) : 0;
    const rMax = built.kind === 'gas' ? 26 : 45;
    let moonRatio = built.kind === 'gas' ? rng.range(4.5, 7) : rng.range(12, 20);
    const style = rng.chance(0.5) ? 'letter' : 'roman';
    for (let m = 0; m < moonCount; m++) {
      if (moonRatio > rMax) break;
      const mk: MoonKind = built.kind === 'gas' ? rng.weighted<MoonKind>({ cratered: 0.35, ice: 0.35, volcanic: 0.3 }) : rng.weighted<MoonKind>({ cratered: 0.6, ice: 0.25, volcanic: 0.15 });
      const moon = buildMoon(rng, mk, moonName(name, m, style), def, moonRatio, mass);
      const dm = living ? 10 : tEq;
      moon.info.temperature = celsiusText(mk === 'volcanic' ? dm + 60 : dm - 15);
      moon.landmarks = generateLandmarks(moon, mk === 'ice' ? 'moonIce' : mk === 'volcanic' ? 'moonVolcanic' : 'cratered', moon.physical.radius * GAME_RADIUS_SCALE);
      bodies.push(moon);
      moonRatio *= rng.range(1.45, 2.0);
    }

    prevA = a;
    prevSoi = soi;
    targetA = Math.max(a, targetA) * ratio * rng.range(0.92, 1.08);
    if (targetA < a * 1.4) targetA = a * 1.4;
  }

  return { id: star.id, name: star.name, seed: star.seed, bodies };
}

/** How interesting a body is as a first view: earthlike, then ocean, then ringed giants. */
export function interestScore(def: BodyDef): number {
  if (def.kind === 'star') return -1;
  const water = def.terrain?.water !== undefined && def.terrain.seaLevel !== undefined;
  const clouds = def.atmosphere?.clouds !== undefined;
  let s = 5;
  if (def.kind === 'gas') s = def.rings ? 60 : 20;
  else if (water && clouds) s = def.terrain!.seaLevel! > 0.45 ? 90 : 100;
  else if (def.atmosphere) s = 30;
  if (def.parentId !== undefined && def.kind === 'rocky' && !def.atmosphere) s = Math.min(s, 3);
  if (def.atmosphere?.aurora) s += 2;
  return s;
}

/** The most interesting planet of a system, preferring planets over moons. */
export function pickFocusBody(system: StarSystemDef): BodyDef {
  const root = system.bodies[0]!;
  let best = system.bodies.find((b) => b.kind !== 'star') ?? root;
  let bestScore = -Infinity;
  for (const b of system.bodies) {
    const s = interestScore(b) - (b.parentId !== undefined && b.parentId !== root.id ? 40 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }
  return best;
}
