import type { BodyDef, StarSystemDef } from './types';

const DEG = Math.PI / 180;
const DAY = 86400;
const YEAR = 365.256 * DAY;
const AU = 1.495978707e11;

/**
 * Our solar system, as data. Real orbital and physical values are the baseline; `visual`
 * holds artistic overrides. Terrain and atmosphere recipes are tuned for looks.
 */

const sun: BodyDef = {
  id: 'sun',
  name: 'Sun',
  kind: 'star',
  seed: 1,
  physical: { radius: 6.957e8, surfaceGravity: 28, rotationPeriod: 25.4 * DAY, axialTilt: 7.25 * DEG },
  visual: { color: [1.0, 0.92, 0.78], minApparentSize: 0.02 },
  star: { color: [1.0, 0.93, 0.8], intensity: 1.0, coronaSize: 6 },
  info: {
    type: 'Star',
    atmosphere: 'Plasma',
    temperature: '5500 °C',
    features: ['Corona', 'Sunspots'],
    summary: 'A yellow dwarf. Everything here orbits it.',
  },
};

const earth: BodyDef = {
  id: 'earth',
  name: 'Earth',
  kind: 'rocky',
  parentId: 'sun',
  seed: 3,
  physical: { radius: 6.371e6, surfaceGravity: 1, rotationPeriod: 86164, axialTilt: 23.44 * DEG },
  orbit: {
    semiMajorAxis: 1.0 * AU,
    eccentricity: 0.0167,
    inclination: 0,
    ascendingNode: 0,
    argPeriapsis: 102.9 * DEG,
    meanAnomalyAtEpoch: 357.5 * DEG,
    period: YEAR,
  },
  visual: { color: [0.32, 0.52, 0.85] },
  atmosphere: {
    height: 0.094,
    scaleHeight: 0.13,
    rayleighDepth: [0.045, 0.1, 0.25],
    mieDepth: 0.035,
    mieG: 0.78,
    mieColor: [1, 1, 1],
    absorptionDepth: [0.0, 0.012, 0.0],
    sunIntensity: 22,
    stabilization: 1,
    clouds: { altitude: 0.08, thickness: 0.07, coverage: 0.45, color: [1, 1, 1], scale: 0.02, speed: 8 },
    weather: [
      { kind: 'rain', intensity: 0.5, latitudeBand: [0, 0.9] },
      { kind: 'lightning', intensity: 0.3, latitudeBand: [0, 0.6] },
      { kind: 'snow', intensity: 0.6, latitudeBand: [1.0, 1.6] },
    ],
    aurora: { colors: [[0.2, 1.0, 0.5], [0.6, 0.3, 1.0]], latitude: 67 * DEG, intensity: 1 },
  },
  terrain: {
    amplitude: 0.012,
    seaLevel: 0.12,
    layers: [
      { type: 'fbm', frequency: 1.5, amplitude: 1.0, octaves: 5, warp: 0.4 },
      { type: 'ridged', frequency: 5, amplitude: 0.95, octaves: 5, mask: { frequency: 1.8, threshold: 0.05 } },
      { type: 'ridged', frequency: 16, amplitude: 0.25, octaves: 4, lacunarity: 2.1, mask: { frequency: 2.4, threshold: 0.0 } },
      { type: 'billow', frequency: 9, amplitude: 0.1, octaves: 3 },
      { type: 'fbm', frequency: 40, amplitude: 0.06, octaves: 4 },
    ],
    biomes: [
      { name: 'snow', color: [0.8, 0.85, 0.9], minHeight: 0.85 },
      { name: 'ice', color: [0.75, 0.82, 0.9], latitude: [1.15, 1.6] },
      { name: 'rock', color: [0.2, 0.17, 0.15], minHeight: 0.55 },
      { name: 'beach', color: [0.6, 0.52, 0.32], maxHeight: 0.17 },
      { name: 'desert', color: [0.5, 0.34, 0.15], moisture: [0, 0.4], latitude: [0, 0.7] },
      { name: 'tundra', color: [0.26, 0.27, 0.17], latitude: [0.95, 1.15] },
      { name: 'forest', color: [0.04, 0.15, 0.05], moisture: [0.55, 1] },
      { name: 'grass', color: [0.12, 0.3, 0.07] },
    ],
    water: { color: [0.03, 0.17, 0.32], deepColor: [0.01, 0.05, 0.16] },
    polarCaps: { latitude: 1.25, color: [0.8, 0.86, 0.92] },
    props: [
      { kind: 'tree', density: 60, color: [0.14, 0.34, 0.15], minSize: 12, maxSize: 30, biomes: ['forest', 'grass'], maxSlope: 0.5 },
      { kind: 'rock', density: 8, color: [0.45, 0.42, 0.4], minSize: 4, maxSize: 20, biomes: ['rock', 'tundra', 'desert'] },
    ],
  },
  info: {
    type: 'Terrestrial',
    atmosphere: 'Breathable',
    temperature: '15 °C',
    features: ['Oceans', 'Forests', 'Clouds', 'Auroras'],
    summary: 'A blue world with oceans, forests and weather.',
  },
};

const moon: BodyDef = {
  id: 'moon',
  name: 'Moon',
  kind: 'rocky',
  parentId: 'earth',
  seed: 31,
  physical: { radius: 1.7374e6, surfaceGravity: 0.165, rotationPeriod: 27.32 * DAY, axialTilt: 6.7 * DEG, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 3.844e8,
    eccentricity: 0.0549,
    inclination: 5.145 * DEG,
    ascendingNode: 125 * DEG,
    argPeriapsis: 318 * DEG,
    meanAnomalyAtEpoch: 135 * DEG,
    period: 27.32 * DAY,
  },
  visual: { color: [0.72, 0.72, 0.7] },
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 9, amplitude: 0.15, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
    ],
    craters: { count: 900, minRadius: 0.004, maxRadius: 0.11, depth: 0.2, rimHeight: 0.07 },
    biomes: [
      { name: 'maria', color: [0.07, 0.07, 0.07], maxHeight: -0.12 },
      { name: 'highlands', color: [0.22, 0.215, 0.2] },
    ],
    props: [{ kind: 'rock', density: 15, color: [0.6, 0.6, 0.58], minSize: 2, maxSize: 14 }],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: '-20 °C',
    features: ['Craters', 'Maria', 'Earthrise'],
    summary: 'Grey and silent, scarred by ancient impacts.',
  },
};

export const SOLAR_SYSTEM: StarSystemDef = {
  id: 'sol',
  name: 'Sol',
  seed: 1977,
  bodies: [sun, earth, moon],
};
