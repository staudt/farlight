import { hashInts } from '../core/rng';
import type { GalaxyStar } from './galaxy';
import {
  type Archetype,
  type Built,
  type Flora,
  type MoonKind,
  FLORAS,
  Rng,
  SKIES,
  WATERS,
  buildDesert,
  buildMoon,
  celsiusText,
  clamp01,
  features,
  jit,
  jitterLayers,
  EARTH_LAYERS,
  lifeFor,
  livingBiomes,
  livingProps,
  mix,
  mul,
  round,
  skyAtmosphere,
} from './generate';
import { type LandmarkWorld, generateLandmarks } from './landmarkGen';
import { moonName, slug } from './names';
import type { AtmosphereDef, BiomeDef, BodyDef, NoiseLayer, PropDef, RGB, RingDef, TerrainDef, WeatherDef } from './types';

/**
 * Rare world archetypes and moon variety, applied to a finished system.
 *
 * Everything here draws from its OWN seeded stream (star seed xor a salt, then body seeds), and
 * only rewrites planets after the main generator is done. No draw of `generateSystem` moves, so
 * every world that is not picked keeps exactly the look it had before.
 *
 * Rough rarity per system: eyeball worlds (around red dwarfs) 8%, ring worlds 8%, archipelagos 6%,
 * canyon worlds 6%, mesa worlds 6%, crystal worlds 6%, a huge moon 7%, twin moons 7%.
 */

const DEG = Math.PI / 180;
const AU = 1.495978707e11;
const G_CONST = 6.674e-11;

export type VarietyKind = 'eyeball' | 'rings' | 'archipelago' | 'canyon' | 'mesa' | 'crystal' | 'hugeMoon' | 'twinMoons';

export interface VarietyPlanet {
  def: BodyDef;
  built: Built;
}

const ROCKY_NON_LAVA = (p: VarietyPlanet): boolean => p.def.kind === 'rocky' && p.built.archetype !== 'lava';

/** Writes a finished surface onto a planet: terrain, sky, colour, summary and landmarks. */
function reskin(def: BodyDef, w: { terrain: TerrainDef; atmosphere?: AtmosphereDef; color: RGB; type?: string; atmosphereText?: string; features: string[]; summary: string; temperature?: string; effects?: WeatherDef[]; hazards?: string[]; life?: BodyDef['life'] }, world: LandmarkWorld): void {
  def.terrain = w.terrain;
  if (w.atmosphere) def.atmosphere = w.atmosphere;
  else delete def.atmosphere;
  def.visual = { ...def.visual, color: w.color };
  if (w.effects?.length) def.effects = w.effects;
  else delete def.effects;
  if (w.life?.length) def.life = w.life;
  else delete def.life;
  def.info = {
    ...def.info,
    type: w.type ?? def.info.type,
    atmosphere: w.atmosphereText ?? def.info.atmosphere,
    temperature: w.temperature ?? def.info.temperature,
    features: def.rings ? [...w.features, 'Rings'] : w.features,
    summary: w.summary,
  };
  if (w.hazards?.length) def.info.hazards = w.hazards;
  else delete def.info.hazards;
  def.landmarks = generateLandmarks(def, world, def.physical.radius * 0.1);
}

// ---------------------------------------------------------------------------------------------
// Eyeball worlds: tidally locked, fire on one side, ice on the other, life along the terminator.

const DUSK_FLORA: Flora = {
  forest: [0.1, 0.02, 0.16], grass: [0.26, 0.1, 0.4], meadow: [0.55, 0.28, 0.6], desert: [0.7, 0.3, 0.2], tundra: [0.4, 0.34, 0.5],
  sand: [0.6, 0.5, 0.4], rock: [0.3, 0.24, 0.3], trunk: [0.55, 0.18, 0.6], words: 'violet forests',
};
const CRIMSON_FLORA: Flora = {
  forest: [0.2, 0.02, 0.04], grass: [0.45, 0.07, 0.07], meadow: [0.75, 0.25, 0.12], desert: [0.7, 0.35, 0.18], tundra: [0.42, 0.3, 0.28],
  sand: [0.7, 0.55, 0.4], rock: [0.28, 0.22, 0.2], trunk: [0.7, 0.14, 0.12], words: 'crimson forests',
};

function buildEyeball(rng: Rng): Parameters<typeof reskin>[1] {
  const flora = rng.weighted({ terran: 0.35, crimson: 0.3, dusk: 0.35 }) === 'terran' ? FLORAS.terran! : rng.chance(0.5) ? CRIMSON_FLORA : DUSK_FLORA;
  const water = rng.pick([WATERS.blue!, WATERS.turquoise!, WATERS.green!]);
  const seaLevel = round(rng.range(0.14, 0.26));
  const j = (c: RGB): RGB => jit(c, rng, 0.06);
  const scorch: RGB = rng.pick<RGB>([[0.2, 0.07, 0.04], [0.26, 0.12, 0.06], [0.16, 0.1, 0.1]]);
  const biomes: BiomeDef[] = [
    { name: 'snow', color: [0.88, 0.92, 0.96], minHeight: 1.0, latitude: [0.6, 2] },
    // The dark side: a frozen shell down to the shore.
    { name: 'night ice', color: [0.8, 0.88, 0.96], latitude: [1.2, 2] },
    { name: 'scorched', color: j(scorch), latitude: [0, 0.4], emissive: { color: [1.0, 0.4, 0.12], intensity: 0.05, day: 0.1 } },
    { name: 'rock', color: j(flora.rock), minHeight: 0.75 },
    { name: 'beach', color: j(flora.sand), maxHeight: round(seaLevel + 0.01) },
    { name: 'desert', color: j(flora.desert), moisture: [0, 0.55], latitude: [0.25, 0.65] },
    { name: 'tundra', color: j(flora.tundra), latitude: [0.98, 1.25] },
    { name: 'forest', color: j(flora.forest), moisture: [0.48, 1], latitude: [0.55, 1.3] },
    { name: 'meadow', color: j(flora.meadow), moisture: [0.2, 0.46], latitude: [0.55, 1.3] },
    { name: 'grass', color: j(flora.grass), latitude: [0.6, 1.3] },
    { name: 'badlands', color: j(mix(flora.desert, scorch, 0.5)) },
  ];
  const props: PropDef[] = [
    ...livingProps(flora, rng, false),
    { kind: 'spire', density: 5, color: mul(scorch, 1.6), minSize: 25, maxSize: 90, biomes: ['scorched', 'desert', 'badlands'], maxSlope: 0.7 },
    { kind: 'crystal', density: 26, color: [1.0, 0.55, 0.25], minSize: 8, maxSize: 40, biomes: ['scorched'] },
    { kind: 'rock', density: 22, color: [0.8, 0.9, 1.0], minSize: 4, maxSize: 20, biomes: ['night ice', 'tundra'] },
  ];
  const sky = rng.chance(0.6) ? SKIES.blue! : SKIES.teal!;
  const atmosphere = skyAtmosphere(rng, sky, { height: [0.08, 0.13], depth: [0.22, 0.3], mie: [0.02, 0.05], sun: [13, 16], coverage: [0.55, 0.75] });
  atmosphere.weather = [{ kind: 'rain', intensity: 0.4 }, { kind: 'lightning', intensity: 0.25 }];
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.011, 0.016), 4),
    seaLevel,
    biomeAxis: 'substellar',
    layers: jitterLayers(EARTH_LAYERS, rng),
    // The day side stands up out of the sea as a vast dry plateau; the sea fills the terminator.
    features: [{ kind: 'mesa', lat: 0, lon: 0, radius: 1.2, height: round(rng.range(0.3, 0.42)) }],
    biomes,
    water: { color: jit(water.color, rng, 0.05), deepColor: jit(water.deepColor, rng, 0.06) },
    polarCaps: { latitude: 1.02, color: [0.9, 0.94, 0.98] },
    props,
  };
  return {
    terrain,
    atmosphere,
    color: mix(water.color, mix(flora.grass, [0.9, 0.95, 1], 0.4), 0.45),
    atmosphereText: 'Breathable',
    features: ['Eternal sunset', 'Fire and ice', 'Terminator seas', flora.words.replace(/^./, (c) => c.toUpperCase())],
    temperature: celsiusText(5),
    summary: rng.pick([
      'One face burns, one face freezes, and a ring of living twilight runs between.',
      'A world that never turns: a sun fixed on the horizon, green seas along the dusk line.',
      `${flora.words.replace(/^./, (c) => c.toUpperCase())} and calm seas hug the line between eternal day and night.`,
    ]),
    life: undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Ring worlds

function ringsFor(rng: Rng): { ring: RingDef; word: string } {
  const style = rng.weighted({ ice: 0.45, dust: 0.3, gold: 0.25 });
  const color: RGB = style === 'ice' ? [0.9, 0.95, 1.0] : style === 'dust' ? [0.66, 0.3, 0.2] : [0.88, 0.74, 0.5];
  const inner = round(rng.range(1.3, 1.55), 2);
  return {
    ring: {
      innerRadius: inner,
      outerRadius: round(inner + rng.range(1.3, 2.1), 2),
      color: jit(color, rng, 0.05),
      opacity: round(rng.range(0.82, 0.94), 2),
      bands: rng.int(36, 62),
    },
    word: style === 'ice' ? 'icy' : style === 'dust' ? 'red dust' : 'golden',
  };
}

// ---------------------------------------------------------------------------------------------
// Archipelago worlds

function buildArchipelago(rng: Rng): Parameters<typeof reskin>[1] {
  const flora = FLORAS.terran!;
  const seaLevel = round(rng.range(0.045, 0.065));
  const layers: NoiseLayer[] = [
    // Low swell keeps the high frequency islands from vanishing over open sea, see layersHeight.
    { type: 'fbm', frequency: 1.4, amplitude: 0.1, octaves: 3 },
    { type: 'fbm', frequency: round(rng.range(70, 90), 1), amplitude: 0.75, octaves: 3, warp: 0.3 },
    { type: 'ridged', frequency: 200, amplitude: 0.25, octaves: 3 },
    { type: 'billow', frequency: 450, amplitude: 0.05, octaves: 3 },
    { type: 'fbm', frequency: 700, amplitude: 0.012, octaves: 3 },
    { type: 'fbm', frequency: 5000, amplitude: 0.004, octaves: 3 },
  ];
  const lagoon = rng.pick([WATERS.turquoise!, WATERS.jade!, WATERS.blue!]);
  const biomes = livingBiomes(rng, flora, seaLevel, true);
  const sky = SKIES.blue!;
  const atmosphere = skyAtmosphere(rng, sky, { height: [0.08, 0.13], depth: [0.22, 0.32], mie: [0.008, 0.03], sun: [13, 16], coverage: [0.3, 0.5] });
  atmosphere.weather = [{ kind: 'rain', intensity: 0.5 }, { kind: 'lightning', intensity: 0.3 }];
  const props = livingProps(flora, rng, false);
  for (const p of props) if (p.kind === 'tree') p.density = Math.round(p.density * 1.1);
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.008, 0.012), 4),
    seaLevel,
    layers,
    biomes,
    water: { color: jit(lagoon.color, rng, 0.05), deepColor: jit(lagoon.deepColor, rng, 0.06) },
    polarCaps: { latitude: round(rng.range(1.3, 1.45)), color: [0.88, 0.92, 0.96] },
    props,
  };
  return {
    terrain,
    atmosphere,
    color: mix(lagoon.color, flora.grass, 0.22),
    atmosphereText: 'Humid nitrogen',
    features: ['Thousands of islands', 'Lagoons', 'Reefs', 'Storms'],
    summary: rng.pick([
      'A scatter of ten thousand green islands in a warm, shallow sea.',
      'Palm green islands strung like beads across bright lagoons.',
      'A drowned world of small islands, each ringed by pale shallows.',
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Canyon and mesa worlds. Both start from a desert build for the sky and palette.

/** Layered rock palettes (linear RGB), cycled top to bottom: a light cap, then bands. */
const STRATA: { name: string; bands: RGB[]; floor: RGB }[] = [
  { name: 'red', bands: [[0.52, 0.16, 0.07], [0.74, 0.36, 0.12], [0.84, 0.66, 0.4], [0.3, 0.11, 0.06]], floor: [0.5, 0.3, 0.18] },
  { name: 'violet', bands: [[0.36, 0.18, 0.46], [0.62, 0.36, 0.62], [0.82, 0.68, 0.8], [0.2, 0.1, 0.28]], floor: [0.4, 0.28, 0.42] },
  { name: 'ochre', bands: [[0.56, 0.4, 0.14], [0.2, 0.46, 0.4], [0.82, 0.7, 0.4], [0.3, 0.25, 0.1]], floor: [0.5, 0.42, 0.22] },
];

function strata(rng: Rng, pal: (typeof STRATA)[number], top: number, step: number, count: number, tag: string): BiomeDef[] {
  const out: BiomeDef[] = [{ name: `${tag} cap`, color: jit(mix(pal.bands[2]!, [1, 0.95, 0.85], 0.25), rng, 0.04), minHeight: round(top) }];
  for (let i = 0; i < count; i++) {
    out.push({ name: `${tag} strata ${i + 1}`, color: jit(pal.bands[i % pal.bands.length]!, rng, 0.05), minHeight: round(top - step * (i + 1)) });
  }
  out.push({ name: `${tag} floor`, color: jit(pal.floor, rng, 0.05) });
  return out;
}

function buildCanyon(rng: Rng): Parameters<typeof reskin>[1] {
  const d = buildDesert(rng);
  const pal = rng.pick(STRATA);
  const layers: NoiseLayer[] = [
    { type: 'fbm', frequency: 1.6, amplitude: 0.3, octaves: 4 },
    // Inverted ridged noise: the ridge lines become a branching network of trenches.
    { type: 'ridged', frequency: round(rng.range(5, 7), 2), amplitude: -0.95, octaves: 4, warp: 0.45, terraces: 6 },
    { type: 'ridged', frequency: round(rng.range(16, 22), 1), amplitude: -0.22, octaves: 3, warp: 0.3, terraces: 3 },
    { type: 'fbm', frequency: 30, amplitude: 0.03, octaves: 4 },
    { type: 'fbm', frequency: 900, amplitude: 0.004, octaves: 3 },
  ];
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.012, 0.017), 4),
    layers,
    biomes: strata(rng, pal, 0.05, 0.158, 7, 'canyon'),
    polarCaps: d.terrain!.polarCaps,
    props: [
      { kind: 'rock', density: 14, color: mul(pal.bands[0]!, 0.7), minSize: 4, maxSize: 26 },
      { kind: 'spire', density: 3, color: mul(pal.bands[1]!, 0.8), minSize: 25, maxSize: 90, maxSlope: 0.8 },
    ],
  };
  return {
    terrain,
    atmosphere: d.atmosphere,
    color: mix(pal.bands[1]!, pal.floor, 0.5),
    atmosphereText: d.atmosphereText,
    features: ['Branching canyons', 'Layered cliffs', 'Dust storms'],
    effects: d.effects,
    hazards: d.hazards,
    summary: rng.pick([
      'A land cut to ribbons by a thousand branching canyons, each wall banded red and gold.',
      'Dry plateaus split by gorges so deep their floors lie in shadow at noon.',
      'Stepped cliffs fall away in layers into a maze of winding gorges.',
    ]),
  };
}

function buildMesa(rng: Rng): Parameters<typeof reskin>[1] {
  const d = buildDesert(rng);
  const pal = rng.pick(STRATA);
  const layers: NoiseLayer[] = [
    { type: 'fbm', frequency: 1.5, amplitude: 0.25, octaves: 4 },
    { type: 'fbm', frequency: round(rng.range(28, 40), 1), amplitude: 0.85, octaves: 2, warp: 0.3, terraces: 3 },
    { type: 'fbm', frequency: round(rng.range(90, 120), 1), amplitude: 0.3, octaves: 2, warp: 0.2, terraces: 2, mask: { frequency: 3, threshold: -0.1 } },
    { type: 'fbm', frequency: 40, amplitude: 0.025, octaves: 4 },
    { type: 'fbm', frequency: 900, amplitude: 0.004, octaves: 3 },
  ];
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.012, 0.018), 4),
    layers,
    biomes: strata(rng, pal, 0.3, 0.2, 5, 'mesa'),
    polarCaps: d.terrain!.polarCaps,
    props: [
      { kind: 'rock', density: 16, color: mul(pal.bands[0]!, 0.7), minSize: 4, maxSize: 24 },
      { kind: 'mesa', density: 1.2, color: pal.bands[1]!, minSize: 40, maxSize: 130 },
    ],
  };
  return {
    terrain,
    atmosphere: d.atmosphere,
    color: mix(pal.bands[1]!, pal.floor, 0.5),
    atmosphereText: d.atmosphereText,
    features: ['Terraced mesas', 'Flat plateaus', 'Banded rock'],
    effects: d.effects,
    hazards: d.hazards,
    summary: rng.pick([
      'Flat topped mesas stand in rows like the steps of a giant stair.',
      'A terraced land of tables and buttes, each ledge a different shade of red.',
      'Wide plains broken by sheer sided plateaus, stacked in layers.',
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Crystal and glass worlds

const GEMS: { name: string; ground: RGB; crystal: RGB; deep: RGB; sky: string }[] = [
  { name: 'amethyst', ground: [0.52, 0.34, 0.78], crystal: [0.85, 0.55, 1.0], deep: [0.16, 0.08, 0.3], sky: 'violet' },
  { name: 'aquamarine', ground: [0.32, 0.78, 0.88], crystal: [0.5, 1.0, 0.95], deep: [0.04, 0.18, 0.28], sky: 'teal' },
  { name: 'rose quartz', ground: [0.9, 0.58, 0.7], crystal: [1.0, 0.76, 0.86], deep: [0.3, 0.1, 0.18], sky: 'magenta' },
  { name: 'citrine', ground: [0.95, 0.78, 0.34], crystal: [1.0, 0.9, 0.5], deep: [0.36, 0.2, 0.04], sky: 'amber' },
];

function buildCrystal(rng: Rng): Parameters<typeof reskin>[1] {
  const g = rng.pick(GEMS);
  const j = (c: RGB): RGB => jit(c, rng, 0.06);
  const glow = rng.chance(0.5);
  const layers: NoiseLayer[] = [
    { type: 'fbm', frequency: 1.8, amplitude: 0.5, octaves: 4 },
    { type: 'ridged', frequency: 7, amplitude: 0.4, octaves: 4, warp: 0.2 },
    // Faceting: stepped little plates over the plains.
    { type: 'billow', frequency: 22, amplitude: 0.1, octaves: 2, terraces: 3 },
    { type: 'fbm', frequency: 60, amplitude: 0.02, octaves: 3 },
  ];
  const biomes: BiomeDef[] = [
    { name: 'prism ridge', color: j(mix(g.crystal, [1, 1, 1], 0.3)), minHeight: 0.35 },
    { name: 'geode floor', color: j(g.deep), maxHeight: -0.15, ...(glow ? { emissive: { color: g.crystal, intensity: 0.25 } } : {}) },
    { name: 'glass flats', color: j(mix(g.ground, [1, 1, 1], 0.12)), moisture: [0, 0.45] },
    { name: 'crystal plain', color: j(mul(g.ground, 0.72)) },
  ];
  const props: PropDef[] = [
    { kind: 'crystal', density: round(rng.range(160, 240), 0), color: mul(g.crystal, 0.8), minSize: 8, maxSize: 60, biomes: ['crystal plain', 'glass flats'], glow: 0.6 },
    { kind: 'crystal', density: 40, color: mix(g.crystal, [1, 1, 1], 0.4), minSize: 50, maxSize: 170, biomes: ['prism ridge', 'geode floor'], glow: 0.9 },
    { kind: 'spire', density: 5, color: mix(g.crystal, [1, 1, 1], 0.6), minSize: 40, maxSize: 130, biomes: ['prism ridge', 'crystal plain'], maxSlope: 0.8 },
  ];
  const sky = SKIES[g.sky]!;
  const atmosphere = skyAtmosphere(rng, sky, { height: [0.07, 0.1], depth: [0.12, 0.2], mie: [0.015, 0.04], sun: [12, 14.5], coverage: [0.03, 0.12], cloudAlt: 0.1 });
  atmosphere.aurora = { colors: [g.crystal, mix(g.crystal, [0.3, 0.6, 1], 0.5)], latitude: round(rng.range(60, 74) * DEG), intensity: 1.0 };
  const terrain: TerrainDef = {
    amplitude: round(rng.range(0.01, 0.015), 4),
    layers,
    features: features(rng, 'spires', rng.int(3, 6), [0.04, 0.08], [0.3, 0.6]),
    biomes,
    props,
  };
  return {
    terrain,
    atmosphere,
    color: mix(g.ground, g.crystal, 0.4),
    atmosphereText: 'Thin silicate haze',
    features: ['Crystal plains', `${g.name.replace(/^./, (c) => c.toUpperCase())} forests`, 'Glittering ridges', 'Auroras'],
    summary: rng.pick([
      `A world of ${g.name} glass: crystal spires crowd every plain and flash in the sun.`,
      `Shining ${g.name} flats under a quiet sky, bristling with crystal.`,
      `Forests of faceted ${g.name} cover a land that glitters from orbit.`,
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Moons

function orbitFor(rng: Rng, parent: BodyDef, ratio: number): BodyDef['orbit'] {
  const mass = (parent.physical.surfaceGravity * 9.81 * parent.physical.radius * parent.physical.radius) / G_CONST;
  const a = ratio * parent.physical.radius;
  return {
    semiMajorAxis: a,
    eccentricity: round(rng.range(0, 0.03), 4),
    inclination: round(rng.range(0, 3) * DEG, 4),
    ascendingNode: round(rng.range(0, Math.PI * 2), 3),
    argPeriapsis: round(rng.range(0, Math.PI * 2), 3),
    meanAnomalyAtEpoch: round(rng.range(0, Math.PI * 2), 3),
    period: 2 * Math.PI * Math.sqrt((a * a * a) / (G_CONST * mass)),
  };
}

function addMoon(rng: Rng, bodies: BodyDef[], planet: BodyDef, ratio: number, radius: number, kind: MoonKind, tempC: number): BodyDef {
  const existing = bodies.filter((b) => b.parentId === planet.id);
  const style = existing.some((b) => /\s[a-z]$/.test(b.name)) ? 'letter' : existing.length > 0 ? 'roman' : rng.chance(0.5) ? 'letter' : 'roman';
  let name = moonName(planet.name, existing.length, style);
  while (bodies.some((b) => b.id === slug(name))) name += 'x';
  const moon = buildMoon(rng, kind, name, planet, ratio, 5.97e24);
  const orbit = orbitFor(rng, planet, ratio);
  moon.orbit = orbit;
  moon.physical = { ...moon.physical, radius, surfaceGravity: round(0.165 * (radius / 1.74e6), 4), rotationPeriod: orbit!.period };
  moon.info.temperature = celsiusText(kind === 'volcanic' ? tempC + 60 : tempC - 15);
  moon.landmarks = generateLandmarks(moon, kind === 'ice' ? 'moonIce' : kind === 'volcanic' ? 'moonVolcanic' : 'cratered', radius * 0.1);
  bodies.push(moon);
  return moon;
}

// ---------------------------------------------------------------------------------------------
// Assembly

/**
 * Applies rare archetypes to a generated system, in place. `planets` are the star's direct
 * children with the archetype the generator built for them.
 */
export function applyVariety(bodies: BodyDef[], planets: VarietyPlanet[], star: GalaxyStar, luminosity: number): void {
  const rng = new Rng(hashInts(star.seed, 0x7a1e5) >>> 0);
  const used = new Set<BodyDef>();
  const tEq = (p: VarietyPlanet): number => 255 * Math.pow(luminosity, 0.25) / Math.sqrt(p.def.orbit!.semiMajorAxis / AU) - 273;
  const pickOf = (list: VarietyPlanet[]): VarietyPlanet | undefined => (list.length ? list[Math.floor(rng.r() * list.length)] : undefined);
  const free = (f: (p: VarietyPlanet) => boolean): VarietyPlanet[] => planets.filter((p) => !used.has(p.def) && f(p));
  const isA = (...a: Archetype[]) => (p: VarietyPlanet): boolean => a.includes(p.built.archetype);

  // Eyeball world: the rocky planet nearest to a mild temperature, around red dwarfs (rarely orange ones).
  const eyeChance = star.starClass === 'M' ? 0.2 : star.starClass === 'K' ? 0.03 : 0;
  const eyeRoll = rng.r();
  const eyeSeed = rng.seed();
  if (eyeRoll < eyeChance) {
    const cands = free((p) => ROCKY_NON_LAVA(p) && p.built.radiusEarth >= 0.55 && p.built.radiusEarth <= 1.6).sort((a, b) => Math.abs(tEq(a) - 20) - Math.abs(tEq(b) - 20));
    const pick = cands[0];
    if (pick) {
      const def = pick.def;
      const r = new Rng(eyeSeed);
      const w = buildEyeball(r);
      def.physical = { ...def.physical, tidallyLocked: true, rotationPeriod: def.orbit!.period, axialTilt: 0 };
      reskin(def, w, 'living');
      const life = lifeFor('earthlike', def);
      if (life) def.life = life;
      used.add(def);
    }
  }

  // Ring world: any rocky planet gets great rings and enough tilt to see them arch overhead.
  const ringRoll = rng.r();
  const ringSeed = rng.seed();
  if (ringRoll < 0.09) {
    const pick = pickOf(planets.filter((p) => p.def.kind === 'rocky' && !p.def.physical.tidallyLocked && (p.def.atmosphere !== undefined || p.built.archetype === 'cratered')));
    if (pick) {
      const r = new Rng(ringSeed);
      const { ring, word } = ringsFor(r);
      const def = pick.def;
      def.rings = ring;
      def.physical = { ...def.physical, axialTilt: round(r.range(14, 30) * DEG, 3) };
      const feats = def.info.features.filter((f) => f !== 'Rings');
      def.info = { ...def.info, features: [...feats, 'Great rings'], summary: `${def.info.summary} ${word.replace(/^./, (c) => c.toUpperCase())} rings arch across its sky.` };
    }
  }

  // Archipelago: a living water world re-drawn as thousands of small islands.
  const archRoll = rng.r();
  const archSeed = rng.seed();
  if (archRoll < 0.18) {
    const pick = pickOf(free(isA('earthlike', 'ocean')));
    if (pick) {
      const def = pick.def;
      reskin(def, buildArchipelago(new Rng(archSeed)), 'living');
      const life = lifeFor('ocean', def);
      if (life) def.life = life;
      used.add(def);
    }
  }

  // Canyon, mesa and crystal worlds take dry rocky planets.
  const dry = isA('desert', 'cratered', 'ice');
  for (const kind of ['canyon', 'mesa', 'crystal'] as const) {
    const roll = rng.r();
    const seed = rng.seed();
    const chance = kind === 'crystal' ? 0.12 : 0.18;
    if (roll >= chance) continue;
    const pick = pickOf(free(kind === 'crystal' ? isA('desert', 'cratered', 'ice', 'toxic') : (p) => dry(p) && tEq(p) > -90 && tEq(p) < 80));
    if (!pick) continue;
    const def = pick.def;
    const r = new Rng(seed);
    const w = kind === 'canyon' ? buildCanyon(r) : kind === 'mesa' ? buildMesa(r) : buildCrystal(r);
    // Keep the original temperature text for crystal worlds, set a dry one for the rest.
    reskin(def, w, kind === 'crystal' ? 'ice' : 'desert');
    used.add(def);
  }

  // Huge moon: big enough to fill a quarter of the sky of a world with air.
  const hugeRoll = rng.r();
  const hugeSeed = rng.seed();
  if (hugeRoll < 0.1) {
    const pick = pickOf(planets.filter((p) => p.def.kind === 'rocky' && p.def.atmosphere !== undefined && !p.def.physical.tidallyLocked && p.built.radiusEarth >= 0.7));
    if (pick) {
      const r = new Rng(hugeSeed);
      const def = pick.def;
      const radius = Math.min(3.4e6, Math.max(1.7e6, def.physical.radius * r.range(0.28, 0.5)));
      const kind = r.weighted<MoonKind>({ cratered: 0.55, ice: 0.3, volcanic: 0.15 });
      const t = Math.max(-150, tEq(pick) + (pick.built.greenhouse ?? 0));
      const moon = addMoon(r, bodies, def, round(r.range(5.5, 9.5), 2), radius, kind, t);
      moon.info.summary = `${moon.info.summary} It fills the sky of ${def.name}.`;
    }
  }

  // Twin moons: two good sized moons that dance around each other's phases.
  const twinRoll = rng.r();
  const twinSeed = rng.seed();
  if (twinRoll < 0.1) {
    const pick = pickOf(planets.filter((p) => p.def.kind === 'rocky' && p.def.atmosphere !== undefined && !p.def.physical.tidallyLocked && p.built.radiusEarth >= 0.7 && !bodies.some((b) => b.parentId === p.def.id && b.orbit!.semiMajorAxis < 10 * p.def.physical.radius)));
    if (pick) {
      const r = new Rng(twinSeed);
      const def = pick.def;
      const first = round(r.range(6.5, 8.5), 2);
      const t = Math.max(-150, tEq(pick) + (pick.built.greenhouse ?? 0));
      for (const ratio of [first, round(first * r.range(1.28, 1.45), 2)]) {
        const kind = r.weighted<MoonKind>({ cratered: 0.6, ice: 0.3, volcanic: 0.1 });
        addMoon(r, bodies, def, ratio, r.range(8e5, 1.5e6), kind, t);
      }
    }
  }

  // Keep the colour channel promise even if a palette mix strayed.
  for (const p of planets) p.def.visual.color = p.def.visual.color.map(clamp01) as unknown as RGB;
}
