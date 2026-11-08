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
    seaLevel: 0.0,
    layers: [
      { type: 'fbm', frequency: 1.6, amplitude: 1.0, octaves: 5, warp: 0.35 },
      { type: 'ridged', frequency: 6, amplitude: 0.65, octaves: 5, mask: { frequency: 2.2, threshold: 0.1 } },
      { type: 'fbm', frequency: 40, amplitude: 0.06, octaves: 4 },
    ],
    biomes: [
      { name: 'snow', color: [0.93, 0.95, 0.98], minHeight: 0.55 },
      { name: 'ice', color: [0.88, 0.92, 0.97], latitude: [1.15, 1.6] },
      { name: 'rock', color: [0.42, 0.38, 0.35], maxSlope: 1, minHeight: 0.35 },
      { name: 'beach', color: [0.86, 0.8, 0.6], maxHeight: 0.025 },
      { name: 'desert', color: [0.85, 0.68, 0.42], moisture: [0, 0.32], latitude: [0, 0.65] },
      { name: 'tundra', color: [0.55, 0.55, 0.42], latitude: [0.95, 1.15] },
      { name: 'forest', color: [0.16, 0.38, 0.17], moisture: [0.55, 1] },
      { name: 'grass', color: [0.36, 0.58, 0.24] },
    ],
    water: { color: [0.1, 0.38, 0.6], deepColor: [0.03, 0.12, 0.32] },
    polarCaps: { latitude: 1.2, color: [0.92, 0.95, 0.99] },
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
    ],
    craters: { count: 260, minRadius: 0.004, maxRadius: 0.11, depth: 0.22, rimHeight: 0.07 },
    biomes: [
      { name: 'maria', color: [0.38, 0.38, 0.37], maxHeight: -0.15 },
      { name: 'highlands', color: [0.72, 0.71, 0.69] },
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
