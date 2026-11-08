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
    mieDepth: 0.012,
    mieG: 0.78,
    mieColor: [1, 1, 1],
    absorptionDepth: [0.0, 0.012, 0.0],
    sunIntensity: 14,
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
    seaLevel: 0.2,
    layers: [
      { type: 'fbm', frequency: 1.5, amplitude: 1.0, octaves: 5, warp: 0.4 },
      { type: 'ridged', frequency: 5, amplitude: 0.95, octaves: 5, mask: { frequency: 1.8, threshold: 0.05 } },
      { type: 'ridged', frequency: 16, amplitude: 0.25, octaves: 4, lacunarity: 2.1, mask: { frequency: 2.4, threshold: 0.0 } },
      { type: 'billow', frequency: 9, amplitude: 0.2, octaves: 3 },
      { type: 'fbm', frequency: 22, amplitude: 0.11, octaves: 3 },
      { type: 'fbm', frequency: 40, amplitude: 0.06, octaves: 4 },
      { type: 'fbm', frequency: 700, amplitude: 0.012, octaves: 3 },
      { type: 'fbm', frequency: 5000, amplitude: 0.004, octaves: 3 },
    ],
    biomes: [
      { name: 'snow', color: [0.88, 0.92, 0.96], minHeight: 1.0 },
      { name: 'ice', color: [0.8, 0.87, 0.94], latitude: [1.2, 1.6] },
      { name: 'rock', color: [0.3, 0.26, 0.22], minHeight: 0.75 },
      { name: 'beach', color: [0.72, 0.62, 0.36], maxHeight: 0.21 },
      { name: 'desert', color: [0.66, 0.4, 0.15], moisture: [0, 0.36], latitude: [0, 0.75] },
      { name: 'tundra', color: [0.3, 0.32, 0.2], latitude: [0.98, 1.2] },
      { name: 'forest', color: [0.02, 0.14, 0.04], moisture: [0.56, 1] },
      { name: 'meadow', color: [0.28, 0.46, 0.07], moisture: [0.2, 0.46] },
      { name: 'grass', color: [0.1, 0.35, 0.05] },
    ],
    water: { color: [0.05, 0.42, 0.5], deepColor: [0.008, 0.07, 0.25] },
    polarCaps: { latitude: 1.28, color: [0.88, 0.92, 0.96] },
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
      { type: 'fbm', frequency: 2, amplitude: 0.3, octaves: 5 },
      { type: 'ridged', frequency: 9, amplitude: 0.09, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
      { type: 'fbm', frequency: 900, amplitude: 0.0018, octaves: 3 },
    ],
    craters: { count: 4500, minRadius: 0.0015, maxRadius: 0.1, depth: 0.32, rimHeight: 0.16 },
    biomes: [
      { name: 'maria', color: [0.055, 0.055, 0.06], maxHeight: -0.1 },
      { name: 'floor', color: [0.15, 0.148, 0.142], maxHeight: 0.0 },
      { name: 'rim', color: [0.42, 0.415, 0.4], minHeight: 0.3 },
      { name: 'highlands', color: [0.27, 0.265, 0.25] },
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
