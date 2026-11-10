import type { BodyDef, FeatureDef, LandmarkDef, LandmarkKind, RGB, StarSystemDef } from './types';

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
    maps: {
      land: 'maps/earth-land.bin',
      mountains: 'maps/earth-mountains.bin',
      deserts: 'maps/earth-deserts.bin',
      ice: 'maps/earth-ice.bin',
      lights: 'maps/earth-lights.bin',
    },
    nightLights: { color: [1.0, 0.42, 0.1], intensity: 2.1 },
    layers: [
      { type: 'fbm', frequency: 1.5, amplitude: 0.1, octaves: 5, warp: 0.4 },
      { type: 'ridged', frequency: 5, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 16, amplitude: 0.2, octaves: 4, lacunarity: 2.1 },
      { type: 'billow', frequency: 9, amplitude: 0.14, octaves: 3 },
      { type: 'fbm', frequency: 22, amplitude: 0.1, octaves: 3 },
      { type: 'fbm', frequency: 40, amplitude: 0.06, octaves: 4 },
      { type: 'fbm', frequency: 700, amplitude: 0.012, octaves: 3 },
      { type: 'fbm', frequency: 5000, amplitude: 0.004, octaves: 3 },
    ],
    biomes: [
      { name: 'snow', color: [0.5, 0.54, 0.6], minHeight: 1.12 },
      { name: 'ice', color: [0.46, 0.52, 0.6], latitude: [1.3, 1.6] },
      { name: 'rock', color: [0.34, 0.29, 0.24], minHeight: 0.85 },
      { name: 'beach', color: [0.78, 0.68, 0.4], maxHeight: 0.225 },
      { name: 'desert', color: [0.8, 0.52, 0.2], moisture: [0, 0.2], latitude: [0, 0.8] },
      { name: 'tundra', color: [0.36, 0.38, 0.26], latitude: [1.0, 1.3] },
      { name: 'forest', color: [0.03, 0.2, 0.05], moisture: [0.48, 1] },
      { name: 'meadow', color: [0.3, 0.5, 0.08], moisture: [0.2, 0.4] },
      { name: 'grass', color: [0.12, 0.4, 0.06] },
    ],
    water: { color: [0.04, 0.46, 0.58], deepColor: [0.01, 0.1, 0.34] },
    polarCaps: { latitude: 1.32, color: [0.7, 0.75, 0.82] },
    props: [
      { kind: 'tree', density: 750, color: [0.1, 0.3, 0.12], minSize: 14, maxSize: 32, biomes: ['forest'], maxSlope: 0.75 },
      { kind: 'tree', density: 110, color: [0.2, 0.45, 0.1], minSize: 9, maxSize: 22, biomes: ['grass', 'meadow'], maxSlope: 0.6 },
      { kind: 'rock', density: 50, color: [0.5, 0.46, 0.42], minSize: 3, maxSize: 15, biomes: ['rock', 'tundra', 'desert'] },
      { kind: 'mesa', density: 4, color: [0.85, 0.5, 0.3], minSize: 30, maxSize: 90, biomes: ['desert'], maxSlope: 0.5 },
    ],
  },
  life: [
    { kind: 'birds', color: [0.95, 0.95, 0.93], count: 22, minAlt: 40, maxAlt: 1500, biomes: ['coast'], day: true, size: 11 },
    { kind: 'birds', color: [0.09, 0.08, 0.1], count: 16, minAlt: 40, maxAlt: 900, biomes: ['forest'], day: true, size: 9, chance: 0.3 },
    { kind: 'fish', color: [0.1, 0.22, 0.3], count: 60, minAlt: 0, maxAlt: 400, biomes: ['shallows'], latitude: [0, 0.6], day: true, size: 3.4 },
    { kind: 'fireflies', color: [0.7, 1.0, 0.25], count: 14, minAlt: 2, maxAlt: 9, biomes: ['forest', 'grass', 'meadow'], night: true, size: 0.5, glow: 3.2 },
  ],
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
    props: [{ kind: 'rock', density: 140, color: [0.55, 0.55, 0.53], minSize: 2, maxSize: 14 }],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: '-20 °C',
    features: ['Craters', 'Maria', 'Earthrise'],
    summary: 'Grey and silent, scarred by ancient impacts.',
  },
};

const mercury: BodyDef = {
  id: 'mercury',
  name: 'Mercury',
  kind: 'rocky',
  parentId: 'sun',
  seed: 5,
  physical: { radius: 2.4397e6, surfaceGravity: 0.378, rotationPeriod: 58.646 * DAY, axialTilt: 0.034 * DEG },
  orbit: {
    semiMajorAxis: 0.387098 * AU,
    eccentricity: 0.20563,
    inclination: 7.005 * DEG,
    ascendingNode: 48.331 * DEG,
    argPeriapsis: 29.124 * DEG,
    meanAnomalyAtEpoch: 210 * DEG,
    period: 87.969 * DAY,
  },
  visual: { color: [0.5, 0.46, 0.42] },
  effects: [
    { kind: 'heatShimmer', intensity: 0.9 },
    { kind: 'scorching', intensity: 1 },
  ],
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 8, amplitude: 0.2, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.06, octaves: 4 },
    ],
    craters: { count: 700, minRadius: 0.004, maxRadius: 0.1, depth: 0.2, rimHeight: 0.07 },
    biomes: [
      { name: 'dark plains', color: [0.3, 0.27, 0.24], maxHeight: -0.12 },
      { name: 'grey highlands', color: [0.5, 0.48, 0.45] },
      { name: 'brown dust', color: [0.42, 0.34, 0.26] },
    ],
    props: [{ kind: 'rock', density: 100, color: [0.4, 0.38, 0.36], minSize: 2, maxSize: 12 }],
  },
  info: {
    type: 'Terrestrial',
    atmosphere: 'None',
    temperature: 'minus 173 °C to 427 °C',
    features: ['Craters', 'Scarps', 'Plains'],
    hazards: ['Blinding sun', 'Searing heat'],
    summary: 'A small grey world, cratered and airless, that circles closest to the Sun.',
  },
};

const venus: BodyDef = {
  id: 'venus',
  name: 'Venus',
  kind: 'rocky',
  parentId: 'sun',
  seed: 7,
  physical: { radius: 6.0518e6, surfaceGravity: 0.907, rotationPeriod: -243.025 * DAY, axialTilt: 177.36 * DEG },
  orbit: {
    semiMajorAxis: 0.723332 * AU,
    eccentricity: 0.00677,
    inclination: 3.39458 * DEG,
    ascendingNode: 76.68 * DEG,
    argPeriapsis: 54.85 * DEG,
    meanAnomalyAtEpoch: 75 * DEG,
    period: 224.701 * DAY,
  },
  visual: { color: [0.92, 0.72, 0.4] },
  atmosphere: {
    height: 0.12,
    scaleHeight: 0.8,
    rayleighDepth: [0.04, 0.03, 0.02],
    mieDepth: 0.4,
    mieG: 0.25,
    mieColor: [1.0, 0.9, 0.6],
    absorptionDepth: [0.0, 0.5, 1.5],
    sunIntensity: 20,
    stabilization: 1,
    clouds: { altitude: 0.35, thickness: 0.3, coverage: 0.95, color: [0.9, 0.6, 0.28], scale: 0.05, speed: 60 },
    weather: [
      { kind: 'lightning', intensity: 0.6 },
      { kind: 'acidRain', intensity: 0.9, color: [0.9, 0.78, 0.3] },
      { kind: 'heatShimmer', intensity: 0.8 },
    ],
  },
  terrain: {
    amplitude: 0.015,
    layers: [
      { type: 'fbm', frequency: 1.2, amplitude: 0.8, octaves: 5 },
      { type: 'billow', frequency: 6, amplitude: 0.3, octaves: 4 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
    ],
    features: [
      { kind: 'volcano', name: 'Maat Mons', lat: 0.2 * DEG, lon: -166 * DEG, radius: 0.1, height: 0.8 },
      { kind: 'volcano', name: 'Sapas Mons', lat: 9.3 * DEG, lon: -177 * DEG, radius: 0.07, height: 0.5 },
      { kind: 'volcano', name: 'Ozza Mons', lat: 28.9 * DEG, lon: -134 * DEG, radius: 0.06, height: 0.4 },
    ],
    biomes: [
      { name: 'highlands', color: [0.5, 0.3, 0.16], minHeight: 0.35 },
      { name: 'volcanic plains', color: [0.42, 0.22, 0.09] },
      { name: 'basalt', color: [0.28, 0.14, 0.07], maxHeight: -0.2 },
    ],
  },
  info: {
    type: 'Terrestrial',
    atmosphere: 'Thick carbon dioxide',
    temperature: '464 °C',
    features: ['Volcanoes', 'Lightning', 'Yellow clouds'],
    hazards: ['Acid rain', 'Crushing heat'],
    summary: 'A shrouded yellow world under a crushing, cloud thick sky.',
  },
};

const mars: BodyDef = {
  id: 'mars',
  name: 'Mars',
  kind: 'rocky',
  parentId: 'sun',
  seed: 11,
  physical: { radius: 3.3895e6, surfaceGravity: 0.376, rotationPeriod: 24.6229 * 3600, axialTilt: 25.19 * DEG },
  orbit: {
    semiMajorAxis: 1.523679 * AU,
    eccentricity: 0.0934,
    inclination: 1.85 * DEG,
    ascendingNode: 49.56 * DEG,
    argPeriapsis: 286.5 * DEG,
    meanAnomalyAtEpoch: 260 * DEG,
    period: 686.98 * DAY,
  },
  visual: { color: [0.75, 0.27, 0.12] },
  atmosphere: {
    height: 0.08,
    scaleHeight: 0.3,
    rayleighDepth: [0.12, 0.07, 0.03],
    mieDepth: 0.4,
    mieG: 0.8,
    mieColor: [1.0, 0.4, 0.15],
    sunIntensity: 20,
    stabilization: 0.7,
    clouds: { altitude: 0.5, thickness: 0.2, coverage: 0.15, color: [0.95, 0.9, 0.85], scale: 0.04, speed: 20 },
    weather: [
      { kind: 'dust', intensity: 0.6 },
      { kind: 'dustDevil', intensity: 1, size: 0.002 },
    ],
  },
  terrain: {
    amplitude: 0.03,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 1.0, octaves: 5 },
      { type: 'ridged', frequency: 6, amplitude: 0.6, octaves: 4 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
    ],
    craters: { count: 300, minRadius: 0.005, maxRadius: 0.08, depth: 0.2, rimHeight: 0.06 },
    features: [
      { kind: 'volcano', name: 'Olympus Mons', lat: 18.65 * DEG, lon: -133.8 * DEG, radius: 0.12, height: 1.0 },
      { kind: 'canyon', name: 'Valles Marineris', lat: -8 * DEG, lon: -70 * DEG, radius: 0.25, height: -0.6 },
    ],
    biomes: [
      { name: 'basalt lowlands', color: [0.12, 0.06, 0.05], maxHeight: -0.2 },
      { name: 'ochre highlands', color: [0.6, 0.27, 0.1], minHeight: 0.2 },
      { name: 'orange sand', color: [0.68, 0.19, 0.07] },
      { name: 'red dust', color: [0.44, 0.12, 0.06] },
    ],
    polarCaps: { latitude: 1.3, color: [0.95, 0.95, 0.97] },
    props: [
      { kind: 'rock', density: 120, color: [0.5, 0.28, 0.17], minSize: 3, maxSize: 16, maxSlope: 0.8 },
      { kind: 'mesa', density: 10, color: [0.82, 0.44, 0.24], minSize: 30, maxSize: 90, maxSlope: 0.6 },
    ],
  },
  info: {
    type: 'Terrestrial',
    atmosphere: 'Thin carbon dioxide',
    temperature: 'minus 63 °C',
    features: ['Olympus Mons', 'Valles Marineris', 'Polar caps', 'Dust storms'],
    hazards: ['Dust devils', 'Thin air'],
    summary: 'A cold red desert with butterscotch skies and the tallest volcano known.',
  },
};

const phobos: BodyDef = {
  id: 'phobos',
  name: 'Phobos',
  kind: 'rocky',
  parentId: 'mars',
  seed: 13,
  physical: { radius: 11.267e3, surfaceGravity: 0.00058, rotationPeriod: 0.31891 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 9.376e6,
    eccentricity: 0.0151,
    inclination: 1.08 * DEG,
    ascendingNode: 0,
    argPeriapsis: 150 * DEG,
    meanAnomalyAtEpoch: 40 * DEG,
    period: 0.31891 * DAY,
  },
  visual: { color: [0.42, 0.37, 0.33], radius: 3000 },
  terrain: {
    amplitude: 0.15,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 1.0, octaves: 4 },
      { type: 'ridged', frequency: 6, amplitude: 0.4, octaves: 3 },
    ],
    craters: { count: 300, minRadius: 0.02, maxRadius: 0.2, depth: 0.25, rimHeight: 0.08 },
    biomes: [
      { name: 'grey dust', color: [0.46, 0.43, 0.4] },
      { name: 'brown rock', color: [0.3, 0.25, 0.2] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 40 °C',
    features: ['Craters', 'Lumpy shape'],
    summary: 'A lumpy potato of rock that races around Mars twice a day.',
  },
};

const deimos: BodyDef = {
  id: 'deimos',
  name: 'Deimos',
  kind: 'rocky',
  parentId: 'mars',
  seed: 17,
  physical: { radius: 6.2e3, surfaceGravity: 0.0003, rotationPeriod: 1.26244 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 2.3458e7,
    eccentricity: 0.00033,
    inclination: 1.79 * DEG,
    ascendingNode: 0,
    argPeriapsis: 260 * DEG,
    meanAnomalyAtEpoch: 115 * DEG,
    period: 1.26244 * DAY,
  },
  visual: { color: [0.45, 0.42, 0.38], radius: 2000 },
  terrain: {
    amplitude: 0.15,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 1.0, octaves: 4 },
      { type: 'ridged', frequency: 7, amplitude: 0.4, octaves: 3 },
    ],
    craters: { count: 150, minRadius: 0.02, maxRadius: 0.18, depth: 0.25, rimHeight: 0.08 },
    biomes: [
      { name: 'grey dust', color: [0.5, 0.47, 0.44] },
      { name: 'brown rock', color: [0.34, 0.29, 0.24] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 40 °C',
    features: ['Craters', 'Dusty slopes'],
    summary: 'A small, dusty stone that drifts slowly across the Martian sky.',
  },
};

const jupiter: BodyDef = {
  id: 'jupiter',
  name: 'Jupiter',
  kind: 'gas',
  parentId: 'sun',
  seed: 19,
  physical: { radius: 6.9911e7, surfaceGravity: 2.528, rotationPeriod: 9.925 * 3600, axialTilt: 3.13 * DEG },
  orbit: {
    semiMajorAxis: 5.2044 * AU,
    eccentricity: 0.0489,
    inclination: 1.303 * DEG,
    ascendingNode: 100.46 * DEG,
    argPeriapsis: 14.73 * DEG,
    meanAnomalyAtEpoch: 150 * DEG,
    period: 11.862 * YEAR,
  },
  // Ceres is close enough that the default sphere of influence would overlap Jupiter's.
  visual: { color: [0.82, 0.68, 0.48], soiFactor: 24 },
  gas: {
    bands: [
      [0.88, 0.76, 0.52],
      [0.66, 0.42, 0.2],
      [0.45, 0.2, 0.1],
      [0.93, 0.87, 0.72],
    ],
    bandFrequency: 14,
    turbulence: 0.6,
    storms: [{ lat: -22 * DEG, lon: 1.2, size: 0.12, color: [0.6, 0.15, 0.08] }],
    cloudDeckDepth: 0.02,
  },
  atmosphere: {
    height: 0.04,
    scaleHeight: 0.8,
    rayleighDepth: [0.03, 0.045, 0.08],
    mieDepth: 0.07,
    mieG: 0.75,
    mieColor: [1, 0.85, 0.65],
    sunIntensity: 9,
    weather: [{ kind: 'lightning', intensity: 0.8 }],
    aurora: { colors: [[0.6, 0.3, 1.0], [0.3, 0.5, 1.0]], latitude: 75 * DEG, intensity: 1 },
  },
  info: {
    type: 'Gas giant',
    atmosphere: 'Hydrogen and helium',
    temperature: 'minus 110 °C',
    features: ['Great Red Spot', 'Cream bands', 'Storms', 'Auroras'],
    summary: 'A striped giant of swirling clouds, big enough to hold every other planet.',
  },
};

const io: BodyDef = {
  id: 'io',
  name: 'Io',
  kind: 'rocky',
  parentId: 'jupiter',
  seed: 23,
  physical: { radius: 1.8216e6, surfaceGravity: 0.183, rotationPeriod: 1.769138 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 4.217e8,
    eccentricity: 0.0041,
    inclination: 0.04 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 40 * DEG,
    period: 1.769138 * DAY,
  },
  visual: { color: [0.95, 0.8, 0.3] },
  effects: [{ kind: 'volcanicPlume', intensity: 1, size: 0.3, color: [0.35, 0.6, 1.0] }],
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.6, octaves: 5 },
      { type: 'ridged', frequency: 8, amplitude: 0.3, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.06, octaves: 4 },
    ],
    features: [
      { kind: 'volcano', name: 'Pele', lat: 18.7 * DEG, lon: -105 * DEG, radius: 0.06, height: 0.5 },
      { kind: 'volcano', name: 'Loki Patera', lat: -13 * DEG, lon: -50 * DEG, radius: 0.1, height: 0.4 },
      { kind: 'volcano', name: 'Prometheus', lat: -1.2 * DEG, lon: -57 * DEG, radius: 0.04, height: 0.3 },
      { kind: 'volcano', name: 'Tvashtar', lat: 64 * DEG, lon: -120 * DEG, radius: 0.05, height: 0.35 },
    ],
    biomes: [
      { name: 'white frost', color: [0.92, 0.9, 0.85], latitude: [1.2, 1.6] },
      // Molten lakes in the lowest basins and glowing calderas on the volcano summits.
      { name: 'lava lake', color: [0.5, 0.1, 0.03], maxHeight: -0.45, emissive: { color: [1.0, 0.32, 0.05], intensity: 1.4, day: 0.25 } },
      { name: 'caldera', color: [0.6, 0.14, 0.04], minHeight: 0.85, emissive: { color: [1.0, 0.4, 0.06], intensity: 1.6, day: 0.25 } },
      { name: 'orange sulfur', color: [0.82, 0.48, 0.14], minHeight: 0.2 },
      { name: 'sulfur yellow', color: [0.95, 0.82, 0.28] },
    ],
    props: [
      { kind: 'crystal', density: 160, color: [1.0, 0.8, 0.2], minSize: 8, maxSize: 34, biomes: ['orange sulfur', 'sulfur yellow'], maxSlope: 0.7 },
      { kind: 'spire', density: 30, color: [0.9, 0.7, 0.25], minSize: 14, maxSize: 60, biomes: ['orange sulfur', 'sulfur yellow'], maxSlope: 0.7 },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'Thin sulfur dioxide',
    temperature: 'minus 130 °C',
    features: ['Volcanoes', 'Lava lakes', 'Sulfur plains'],
    hazards: ['Erupting volcanoes', 'Radiation'],
    summary: 'The most volcanic body known, painted in sulfur yellow and orange.',
  },
};

const europa: BodyDef = {
  id: 'europa',
  name: 'Europa',
  kind: 'rocky',
  parentId: 'jupiter',
  seed: 29,
  physical: { radius: 1.5608e6, surfaceGravity: 0.134, rotationPeriod: 3.551181 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 6.71034e8,
    eccentricity: 0.0094,
    inclination: 0.47 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 120 * DEG,
    period: 3.551181 * DAY,
  },
  visual: { color: [0.9, 0.87, 0.8] },
  effects: [{ kind: 'geyser', intensity: 1, size: 0.17, count: 6 }],
  terrain: {
    amplitude: 0.004,
    layers: [
      { type: 'fbm', frequency: 1.5, amplitude: 0.5, octaves: 3 },
      { type: 'ridged', frequency: 6, amplitude: 0.5, octaves: 4 },
    ],
    biomes: [
      { name: 'brown cracks', color: [0.5, 0.33, 0.2], minHeight: 0.3 },
      { name: 'cream ice', color: [0.86, 0.8, 0.7], maxHeight: -0.1 },
      { name: 'white ice', color: [0.94, 0.92, 0.88] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'Thin oxygen',
    temperature: 'minus 160 °C',
    features: ['Ice shell', 'Cracks', 'Hidden ocean'],
    hazards: ['Ice geysers', 'Radiation'],
    summary: 'A smooth white moon scored by brown cracks over a possible ocean.',
  },
};

const ganymede: BodyDef = {
  id: 'ganymede',
  name: 'Ganymede',
  kind: 'rocky',
  parentId: 'jupiter',
  seed: 37,
  physical: { radius: 2.6341e6, surfaceGravity: 0.146, rotationPeriod: 7.154553 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.0704e9,
    eccentricity: 0.0013,
    inclination: 0.2 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 200 * DEG,
    period: 7.154553 * DAY,
  },
  visual: { color: [0.55, 0.5, 0.45] },
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 10, amplitude: 0.25, octaves: 4 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
    ],
    craters: { count: 700, minRadius: 0.005, maxRadius: 0.1, depth: 0.2, rimHeight: 0.06 },
    biomes: [
      { name: 'dark terrain', color: [0.3, 0.27, 0.25], maxHeight: -0.1 },
      { name: 'grooved terrain', color: [0.55, 0.52, 0.48] },
      { name: 'brown ice', color: [0.42, 0.32, 0.22] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'Trace oxygen',
    temperature: 'minus 160 °C',
    features: ['Grooves', 'Craters', 'Magnetic field'],
    summary: 'The largest moon in the system, grey and brown and grooved like old paper.',
  },
};

const callisto: BodyDef = {
  id: 'callisto',
  name: 'Callisto',
  kind: 'rocky',
  parentId: 'jupiter',
  seed: 41,
  physical: { radius: 2.4103e6, surfaceGravity: 0.126, rotationPeriod: 16.689018 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.8827e9,
    eccentricity: 0.0074,
    inclination: 0.19 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 300 * DEG,
    period: 16.689018 * DAY,
  },
  visual: { color: [0.3, 0.27, 0.24] },
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 9, amplitude: 0.15, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 4 },
    ],
    craters: { count: 1200, minRadius: 0.004, maxRadius: 0.12, depth: 0.2, rimHeight: 0.07 },
    biomes: [
      { name: 'dark ice', color: [0.2, 0.18, 0.16] },
      { name: 'grey crust', color: [0.35, 0.33, 0.3] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 139 °C',
    features: ['Craters', 'Dark ice', 'Multi ring basins'],
    summary: 'A dark and ancient moon, so heavily cratered that it looks like an old battlefield.',
  },
};

const saturn: BodyDef = {
  id: 'saturn',
  name: 'Saturn',
  kind: 'gas',
  parentId: 'sun',
  seed: 43,
  physical: { radius: 5.8232e7, surfaceGravity: 1.065, rotationPeriod: 10.656 * 3600, axialTilt: 26.73 * DEG },
  orbit: {
    semiMajorAxis: 9.5826 * AU,
    eccentricity: 0.0565,
    inclination: 2.485 * DEG,
    ascendingNode: 113.72 * DEG,
    argPeriapsis: 92.43 * DEG,
    meanAnomalyAtEpoch: 290 * DEG,
    period: 29.4571 * YEAR,
  },
  visual: { color: [0.9, 0.8, 0.55] },
  gas: {
    bands: [
      [0.92, 0.82, 0.6],
      [0.85, 0.7, 0.45],
      [0.78, 0.6, 0.38],
      [0.95, 0.88, 0.7],
    ],
    bandFrequency: 18,
    turbulence: 0.3,
    cloudDeckDepth: 0.02,
  },
  rings: {
    innerRadius: 1.24,
    outerRadius: 2.27,
    color: [0.85, 0.78, 0.62],
    opacity: 0.85,
    bands: 40,
  },
  atmosphere: {
    height: 0.04,
    scaleHeight: 0.8,
    rayleighDepth: [0.05, 0.07, 0.12],
    mieDepth: 0.4,
    mieG: 0.75,
    mieColor: [1, 0.95, 0.85],
    sunIntensity: 20,
  },
  info: {
    type: 'Gas giant',
    atmosphere: 'Hydrogen and helium',
    temperature: 'minus 178 °C',
    features: ['Rings', 'Golden bands', 'Storms'],
    summary: 'A pale golden giant wrapped in a wide, glittering ring system.',
  },
};

const titan: BodyDef = {
  id: 'titan',
  name: 'Titan',
  kind: 'rocky',
  parentId: 'saturn',
  seed: 47,
  physical: { radius: 2.5747e6, surfaceGravity: 0.138, rotationPeriod: 15.945 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.22187e9,
    eccentricity: 0.0288,
    inclination: 0.33 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 220 * DEG,
    period: 15.945 * DAY,
  },
  visual: { color: [0.84, 0.56, 0.26] },
  atmosphere: {
    height: 0.25,
    scaleHeight: 0.25,
    rayleighDepth: [0.09, 0.05, 0.018],
    mieDepth: 0.35,
    mieG: 0.25,
    mieColor: [1.0, 0.7, 0.35],
    sunIntensity: 18,
    stabilization: 1,
    clouds: { altitude: 0.3, thickness: 0.2, coverage: 0.5, color: [1.0, 0.85, 0.6], scale: 0.12, speed: 15 },
    weather: [{ kind: 'methaneRain', intensity: 0.8, color: [1.0, 0.62, 0.22] }],
  },
  terrain: {
    amplitude: 0.02,
    seaLevel: -0.35,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.6, octaves: 5 },
      { type: 'ridged', frequency: 8, amplitude: 0.3, octaves: 4 },
      { type: 'billow', frequency: 25, amplitude: 0.08, octaves: 3 },
    ],
    biomes: [
      { name: 'dark dunes', color: [0.2, 0.14, 0.09], maxHeight: 0.1 },
      { name: 'bright highlands', color: [0.55, 0.38, 0.2] },
    ],
    water: { color: [0.08, 0.06, 0.04], deepColor: [0.04, 0.03, 0.02] },
    props: [{ kind: 'rock', density: 70, color: [0.42, 0.28, 0.16], minSize: 3, maxSize: 16, maxSlope: 0.8 }],
  },
  info: {
    type: 'Moon',
    atmosphere: 'Thick nitrogen haze',
    temperature: 'minus 179 °C',
    features: ['Dunes', 'Methane lakes', 'Orange haze'],
    hazards: ['Methane rain', 'Deep cold'],
    summary: 'A hazy orange moon with dark dunes and lakes of liquid methane.',
  },
};

const uranus: BodyDef = {
  id: 'uranus',
  name: 'Uranus',
  kind: 'gas',
  parentId: 'sun',
  seed: 53,
  physical: { radius: 2.5362e7, surfaceGravity: 0.889, rotationPeriod: -17.24 * 3600, axialTilt: 97.77 * DEG },
  orbit: {
    semiMajorAxis: 19.2184 * AU,
    eccentricity: 0.0473,
    inclination: 0.773 * DEG,
    ascendingNode: 74.0 * DEG,
    argPeriapsis: 170.96 * DEG,
    meanAnomalyAtEpoch: 45 * DEG,
    period: 84.016846 * YEAR,
  },
  visual: { color: [0.6, 0.85, 0.88] },
  gas: {
    bands: [
      [0.7, 0.9, 0.92],
      [0.6, 0.82, 0.86],
      [0.55, 0.78, 0.82],
      [0.78, 0.94, 0.95],
    ],
    bandFrequency: 6,
    turbulence: 0.1,
    cloudDeckDepth: 0.02,
  },
  rings: {
    innerRadius: 1.7,
    outerRadius: 2.0,
    color: [0.3, 0.3, 0.32],
    opacity: 0.15,
    bands: 10,
  },
  atmosphere: {
    height: 0.05,
    scaleHeight: 0.8,
    rayleighDepth: [0.06, 0.13, 0.2],
    mieDepth: 0.1,
    mieG: 0.25,
    mieColor: [0.8, 0.95, 1],
    absorptionDepth: [0.2, 0.02, 0.0],
    sunIntensity: 12,
  },
  info: {
    type: 'Ice giant',
    atmosphere: 'Hydrogen, helium and methane',
    temperature: 'minus 224 °C',
    features: ['Tilted axis', 'Faint rings', 'Cyan haze'],
    summary: 'A pale cyan giant that rolls around the Sun on its side.',
  },
};

const neptune: BodyDef = {
  id: 'neptune',
  name: 'Neptune',
  kind: 'gas',
  parentId: 'sun',
  seed: 59,
  physical: { radius: 2.4622e7, surfaceGravity: 1.14, rotationPeriod: 16.11 * 3600, axialTilt: 28.32 * DEG },
  orbit: {
    semiMajorAxis: 30.11 * AU,
    eccentricity: 0.008678,
    inclination: 1.77 * DEG,
    ascendingNode: 131.78 * DEG,
    argPeriapsis: 44.97 * DEG,
    meanAnomalyAtEpoch: 330 * DEG,
    period: 164.79 * YEAR,
  },
  visual: { color: [0.18, 0.3, 0.8] },
  gas: {
    bands: [
      [0.15, 0.25, 0.7],
      [0.2, 0.35, 0.85],
      [0.1, 0.18, 0.55],
      [0.3, 0.45, 0.9],
    ],
    bandFrequency: 8,
    turbulence: 0.35,
    storms: [{ lat: -28 * DEG, lon: 0.6, size: 0.1, color: [0.05, 0.08, 0.25] }],
    cloudDeckDepth: 0.02,
  },
  atmosphere: {
    height: 0.05,
    scaleHeight: 0.8,
    rayleighDepth: [0.06, 0.12, 0.25],
    mieDepth: 0.4,
    mieG: 0.75,
    mieColor: [0.85, 0.92, 1],
    sunIntensity: 12,
  },
  info: {
    type: 'Ice giant',
    atmosphere: 'Hydrogen, helium and methane',
    temperature: 'minus 200 °C',
    features: ['Deep blue bands', 'Dark storm', 'Fast winds'],
    summary: 'A deep blue giant lashed by the fastest winds in the solar system.',
  },
};

// ---------------------------------------------------------------------------------------------
// More worlds: Saturn, Uranus and Neptune moons and two dwarf planets.
// ---------------------------------------------------------------------------------------------

/** A chain of overlapping plateaus along a great circle of latitude 0 (Iapetus ridge). */
function ridgeChain(fromLon: number, toLon: number, step: number, radius: number, height: number): FeatureDef[] {
  const out: FeatureDef[] = [];
  for (let lon = fromLon; lon <= toLon + 1e-9; lon += step) {
    out.push({ kind: 'mesa', name: 'Equatorial Ridge', lat: 0, lon: lon * DEG, radius, height });
  }
  return out;
}

const enceladus: BodyDef = {
  id: 'enceladus',
  name: 'Enceladus',
  kind: 'rocky',
  parentId: 'saturn',
  // Seed chosen so the geyser vents all sit on the southern hemisphere, like the real fissures.
  seed: 62246,
  physical: { radius: 2.521e5, surfaceGravity: 0.0115, rotationPeriod: 1.370218 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 2.38037e8,
    eccentricity: 0.0047,
    inclination: 0.009 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 75 * DEG,
    period: 1.370218 * DAY,
  },
  visual: { color: [0.96, 0.98, 1.0] },
  effects: [{ kind: 'geyser', intensity: 1, size: 0.28, count: 6, color: [0.94, 0.97, 1.0] }],
  terrain: {
    amplitude: 0.012,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 4 },
      { type: 'ridged', frequency: 7, amplitude: 0.3, octaves: 4, mask: { frequency: 2, threshold: 0.45 } },
      { type: 'fbm', frequency: 26, amplitude: 0.05, octaves: 3 },
    ],
    craters: { count: 160, minRadius: 0.01, maxRadius: 0.14, depth: 0.16, rimHeight: 0.05 },
    features: [
      { kind: 'canyon', name: 'Tiger Stripes', lat: -77 * DEG, lon: 20 * DEG, radius: 0.3, height: -0.8 },
      { kind: 'canyon', name: 'Tiger Stripes', lat: -83 * DEG, lon: -40 * DEG, radius: 0.28, height: -0.8 },
      { kind: 'canyon', name: 'Tiger Stripes', lat: -80 * DEG, lon: 150 * DEG, radius: 0.3, height: -0.8 },
    ],
    biomes: [
      { name: 'tiger stripes', color: [0.28, 0.56, 0.82], latitude: [1.22, 1.6], hemisphere: 'south', moisture: [0.36, 0.6] },
      { name: 'old cratered ice', color: [0.82, 0.86, 0.9], maxHeight: -0.15 },
      { name: 'fresh snow', color: [0.97, 0.98, 1.0] },
    ],
    polarCaps: { latitude: 1.3, color: [0.9, 0.95, 1.0] },
  },
  info: {
    type: 'Moon',
    atmosphere: 'Water vapour plumes',
    temperature: 'minus 198 °C',
    features: ['Tiger Stripes', 'Ice geysers', 'Brightest world', 'Hidden ocean'],
    hazards: ['Ice geysers', 'Deep cold'],
    summary: 'A snow white moon whose blue cracked south pole breathes plumes of ice into space.',
  },
};

const mimas: BodyDef = {
  id: 'mimas',
  name: 'Mimas',
  kind: 'rocky',
  parentId: 'saturn',
  seed: 67,
  physical: { radius: 1.982e5, surfaceGravity: 0.0064, rotationPeriod: 0.942422 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.8552e8,
    eccentricity: 0.0196,
    inclination: 1.57 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 200 * DEG,
    period: 0.942422 * DAY,
  },
  visual: { color: [0.62, 0.61, 0.6] },
  terrain: {
    amplitude: 0.02,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 4 },
      { type: 'ridged', frequency: 9, amplitude: 0.12, octaves: 3 },
      { type: 'fbm', frequency: 30, amplitude: 0.05, octaves: 3 },
    ],
    craters: { count: 900, minRadius: 0.006, maxRadius: 0.16, depth: 0.22, rimHeight: 0.08 },
    // The central peak of Herschel.
    features: [{ kind: 'mesa', name: 'Herschel Peak', lat: 0, lon: -100 * DEG, radius: 0.04, height: 2.2 }],
    biomes: [
      { name: 'dark ice', color: [0.38, 0.38, 0.4], maxHeight: -0.2 },
      { name: 'grey ice', color: [0.66, 0.66, 0.67] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 200 °C',
    features: ['Herschel crater', 'Central peak', 'Heavy cratering'],
    hazards: ['Deep cold'],
    summary: 'A small grey ice ball scarred by one impact so big it nearly broke it.',
  },
};

const iapetus: BodyDef = {
  id: 'iapetus',
  name: 'Iapetus',
  kind: 'rocky',
  parentId: 'saturn',
  seed: 71,
  physical: { radius: 7.345e5, surfaceGravity: 0.0223, rotationPeriod: 79.3215 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 3.5613e9,
    eccentricity: 0.0286,
    inclination: 8 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 20 * DEG,
    period: 79.3215 * DAY,
  },
  visual: { color: [0.5, 0.46, 0.42] },
  terrain: {
    amplitude: 0.05,
    // Dark leading hemisphere (+Z of the locked frame), bright trailing one.
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.45, octaves: 5 },
      { type: 'ridged', frequency: 8, amplitude: 0.2, octaves: 4 },
      { type: 'fbm', frequency: 28, amplitude: 0.05, octaves: 3 },
    ],
    craters: { count: 600, minRadius: 0.004, maxRadius: 0.1, depth: 0.2, rimHeight: 0.07 },
    features: ridgeChain(-72, 72, 9, 0.09, 1.1),
    biomes: [
      { name: 'ridge rock', color: [0.26, 0.22, 0.2], maxSlope: 0.12, minHeight: 0.9 },
      { name: 'dark cap', color: [0.035, 0.027, 0.022], direction: { axis: [0, 0, 1], minDot: 0.25, softness: 0.1 }, latitude: [0, 1.1] },
      { name: 'dusty margin', color: [0.34, 0.27, 0.2], direction: { axis: [0, 0, 1], minDot: -0.05, softness: 0.12 } },
      { name: 'bright ice', color: [0.92, 0.9, 0.86] },
    ],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 143 °C',
    features: ['Two tone faces', 'Equatorial ridge', 'Dark cap'],
    hazards: ['Deep cold'],
    summary: 'A moon painted half coal and half snow, with a mountain wall running around its waist.',
  },
};

const miranda: BodyDef = {
  id: 'miranda',
  name: 'Miranda',
  kind: 'rocky',
  parentId: 'uranus',
  seed: 73,
  physical: { radius: 2.357e5, surfaceGravity: 0.0079, rotationPeriod: 1.413479 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.2939e8,
    eccentricity: 0.0013,
    inclination: 4.34 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 140 * DEG,
    period: 1.413479 * DAY,
  },
  visual: { color: [0.62, 0.62, 0.64] },
  terrain: {
    amplitude: 0.08,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.45, octaves: 4 },
      { type: 'ridged', frequency: 5, amplitude: 0.5, octaves: 4, warp: 0.5, terraces: 5 },
      { type: 'billow', frequency: 3, amplitude: 0.3, octaves: 3, mask: { frequency: 2.5, threshold: 0.5 } },
      { type: 'fbm', frequency: 24, amplitude: 0.04, octaves: 3 },
    ],
    craters: { count: 220, minRadius: 0.01, maxRadius: 0.14, depth: 0.2, rimHeight: 0.06 },
    // Verona Rupes: a sheer wall, raised ground to the south of it.
    features: [{ kind: 'cliff', name: 'Verona Rupes', lat: -20 * DEG, lon: -13 * DEG, radius: 0.34, height: 1.4 }],
    biomes: [
      { name: 'dark grooves', color: [0.3, 0.3, 0.33], maxHeight: -0.25 },
      { name: 'bright scarps', color: [0.88, 0.89, 0.92], minHeight: 0.4 },
      { name: 'patchwork ice', color: [0.58, 0.58, 0.6], moisture: [0.55, 1] },
      { name: 'grey ice', color: [0.7, 0.7, 0.72] },
    ],
    props: [{ kind: 'rock', density: 40, color: [0.7, 0.7, 0.72], minSize: 3, maxSize: 14, maxSlope: 0.9 }],
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 187 °C',
    features: ['Verona Rupes', 'Patchwork terrain', 'Giant canyons'],
    hazards: ['Sheer drops', 'Deep cold'],
    summary: 'A moon that looks as if it was broken and glued back together, with the tallest cliff known.',
  },
};

const triton: BodyDef = {
  id: 'triton',
  name: 'Triton',
  kind: 'rocky',
  parentId: 'neptune',
  // Seed chosen so the geyser vents cluster in the southern cap.
  seed: 38226,
  physical: { radius: 1.3534e6, surfaceGravity: 0.0797, rotationPeriod: 5.876854 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 3.54759e8,
    eccentricity: 0.000016,
    inclination: 23 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 250 * DEG,
    // Triton circles Neptune backwards.
    period: -5.876854 * DAY,
  },
  visual: { color: [0.8, 0.58, 0.55] },
  effects: [{ kind: 'geyser', intensity: 1, size: 0.13, count: 6, color: [0.1, 0.09, 0.09] }],
  terrain: {
    amplitude: 0.012,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.4, octaves: 4 },
      { type: 'billow', frequency: 38, amplitude: 0.22, octaves: 3, mask: { frequency: 3, threshold: 0.4 } },
      { type: 'ridged', frequency: 9, amplitude: 0.14, octaves: 3 },
    ],
    craters: { count: 40, minRadius: 0.01, maxRadius: 0.06, depth: 0.12, rimHeight: 0.04 },
    biomes: [
      { name: 'dark streaks', color: [0.3, 0.2, 0.2], moisture: [0.7, 1], latitude: [0, 1.3] },
      { name: 'cantaloupe', color: [0.5, 0.33, 0.32], maxHeight: -0.05 },
      { name: 'nitrogen frost', color: [0.78, 0.5, 0.48] },
    ],
    polarCaps: { latitude: 1.0, color: [0.88, 0.68, 0.66] },
  },
  info: {
    type: 'Moon',
    atmosphere: 'Wisp of nitrogen',
    temperature: 'minus 235 °C',
    features: ['Pink nitrogen ice', 'Dark geysers', 'Cantaloupe terrain', 'Backward orbit'],
    hazards: ['Nitrogen geysers', 'Extreme cold'],
    summary: 'A pink frozen moon that circles Neptune backwards and streaks its ice with dark geyser smoke.',
  },
};

const ceres: BodyDef = {
  id: 'ceres',
  name: 'Ceres',
  kind: 'rocky',
  parentId: 'sun',
  seed: 79,
  physical: { radius: 4.73e5, surfaceGravity: 0.029, rotationPeriod: 9.074 * 3600, axialTilt: 4 * DEG },
  orbit: {
    semiMajorAxis: 2.7675 * AU,
    eccentricity: 0.0758,
    inclination: 10.59 * DEG,
    ascendingNode: 80.3 * DEG,
    argPeriapsis: 73.6 * DEG,
    meanAnomalyAtEpoch: 100 * DEG,
    period: 4.6 * YEAR,
  },
  visual: { color: [0.22, 0.21, 0.2] },
  terrain: {
    amplitude: 0.025,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.5, octaves: 5 },
      { type: 'ridged', frequency: 8, amplitude: 0.14, octaves: 3 },
      { type: 'fbm', frequency: 28, amplitude: 0.05, octaves: 3 },
    ],
    craters: { count: 700, minRadius: 0.005, maxRadius: 0.09, depth: 0.2, rimHeight: 0.07 },
    features: [
      { kind: 'volcano', name: 'Ahuna Mons', lat: -10 * DEG, lon: -316 * DEG, radius: 0.07, height: 1.4 },
      // A bright dome in the heart of Occator.
      { kind: 'mesa', name: 'Cerealia Facula', lat: 19.8 * DEG, lon: -121 * DEG, radius: 0.025, height: 0.5 },
    ],
    biomes: [
      { name: 'bright salt', color: [0.95, 0.93, 0.88], minHeight: 0.62, maxSlope: 0.5 },
      { name: 'dark clay', color: [0.11, 0.105, 0.1], maxHeight: -0.05 },
      { name: 'grey regolith', color: [0.2, 0.19, 0.175] },
    ],
    props: [{ kind: 'rock', density: 60, color: [0.3, 0.28, 0.26], minSize: 2, maxSize: 14, maxSlope: 0.9 }],
  },
  info: {
    type: 'Dwarf planet',
    atmosphere: 'None',
    temperature: 'minus 105 °C',
    features: ['Occator bright spots', 'Ahuna Mons', 'Salt deposits', 'Main belt giant'],
    hazards: ['Deep cold'],
    summary: 'The largest rock of the main belt, dark and quiet, except for dazzling white salt in one crater.',
  },
};

const pluto: BodyDef = {
  id: 'pluto',
  name: 'Pluto',
  kind: 'rocky',
  parentId: 'sun',
  seed: 83,
  // Pluto and Charon face each other: the spin matches the orbit of Charon and both lean 119.6 degrees.
  physical: { radius: 1.1883e6, surfaceGravity: 0.063, rotationPeriod: 6.387 * DAY, axialTilt: 119.6 * DEG },
  orbit: {
    semiMajorAxis: 39.482 * AU,
    eccentricity: 0.2488,
    inclination: 17.16 * DEG,
    ascendingNode: 110.3 * DEG,
    argPeriapsis: 113.8 * DEG,
    meanAnomalyAtEpoch: 15 * DEG,
    period: 247.9 * YEAR,
  },
  visual: { color: [0.74, 0.6, 0.5] },
  atmosphere: {
    height: 0.09,
    scaleHeight: 0.3,
    rayleighDepth: [0.004, 0.012, 0.04],
    mieDepth: 0.04,
    mieG: 0.7,
    mieColor: [0.55, 0.7, 1.0],
    sunIntensity: 10,
    stabilization: 0.5,
  },
  terrain: {
    amplitude: 0.03,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.22, octaves: 5 },
      { type: 'ridged', frequency: 7, amplitude: 0.45, octaves: 4, mask: { frequency: 3, threshold: 0.52 } },
      { type: 'fbm', frequency: 22, amplitude: 0.04, octaves: 3 },
    ],
    craters: { count: 160, minRadius: 0.006, maxRadius: 0.06, depth: 0.1, rimHeight: 0.04 },
    // Sputnik Planitia: two overlapping lobes and a tapering tip make the heart.
    features: [
      { kind: 'plain', name: 'Sputnik Planitia', lat: 29 * DEG, lon: 166 * DEG, radius: 0.3, height: -0.5 },
      { kind: 'plain', name: 'Sputnik Planitia', lat: 29 * DEG, lon: 188 * DEG, radius: 0.3, height: -0.5 },
      { kind: 'plain', name: 'Sputnik Planitia', lat: 14 * DEG, lon: 177 * DEG, radius: 0.22, height: -0.5 },
      { kind: 'plain', name: 'Sputnik Planitia', lat: 4 * DEG, lon: 177 * DEG, radius: 0.12, height: -0.5 },
    ],
    biomes: [
      { name: 'nitrogen plain', color: [1.0, 0.97, 0.9], maxHeight: -0.3 },
      { name: 'water ice mountains', color: [0.8, 0.86, 0.94], minHeight: 0.28 },
            { name: 'tholin plains', color: [0.4, 0.17, 0.1], moisture: [0, 0.5] },
      { name: 'tan plains', color: [0.58, 0.36, 0.25] },
    ],
    props: [{ kind: 'rock', density: 50, color: [0.5, 0.4, 0.34], minSize: 3, maxSize: 16, maxSlope: 0.9 }],
  },
  info: {
    type: 'Dwarf planet',
    atmosphere: 'Thin nitrogen haze',
    temperature: 'minus 229 °C',
    features: ['Sputnik Planitia', 'Water ice mountains', 'Blue haze', 'Charon overhead'],
    hazards: ['Extreme cold'],
    summary: 'A pale red world with a great white heart, where mountains of ice rise under a blue haze.',
  },
};

const charon: BodyDef = {
  id: 'charon',
  name: 'Charon',
  kind: 'rocky',
  parentId: 'pluto',
  seed: 89,
  physical: { radius: 6.06e5, surfaceGravity: 0.0288, rotationPeriod: 6.387 * DAY, axialTilt: 0, tidallyLocked: true },
  orbit: {
    semiMajorAxis: 1.9591e7,
    eccentricity: 0.0002,
    // In Pluto's equatorial plane, so it hangs over one spot of Pluto.
    inclination: 119.6 * DEG,
    ascendingNode: 0,
    argPeriapsis: 0,
    meanAnomalyAtEpoch: 0,
    period: 6.387 * DAY,
  },
  visual: { color: [0.52, 0.5, 0.5] },
  terrain: {
    amplitude: 0.025,
    layers: [
      { type: 'fbm', frequency: 2, amplitude: 0.45, octaves: 5 },
      { type: 'ridged', frequency: 6, amplitude: 0.22, octaves: 4 },
      { type: 'fbm', frequency: 24, amplitude: 0.05, octaves: 3 },
    ],
    craters: { count: 380, minRadius: 0.005, maxRadius: 0.09, depth: 0.2, rimHeight: 0.07 },
    biomes: [
      { name: 'grey ice', color: [0.55, 0.54, 0.54], maxHeight: -0.2 },
      { name: 'pale plains', color: [0.7, 0.69, 0.68] },
    ],
    polarCaps: { latitude: 1.15, color: [0.4, 0.17, 0.1] },
  },
  info: {
    type: 'Moon',
    atmosphere: 'None',
    temperature: 'minus 220 °C',
    features: ['Red polar cap', 'Serenity Chasma', 'Locked to Pluto'],
    hazards: ['Extreme cold'],
    summary: 'A grey ice world so big that it and Pluto circle each other, always face to face.',
  },
};

// ---------------------------------------------------------------------------------------------
// Landmarks: real places (and a few plausible ones), authored in meters, stored as fractions.

interface LandmarkSpec {
  id: string;
  name: string;
  kind: LandmarkKind;
  /** Degrees. */
  lat: number;
  lon: number;
  /** Footprint radius and vertical size, game meters. */
  r: number;
  h: number;
  description: string;
  color?: RGB;
  noStamp?: boolean;
}

function landmarks(def: BodyDef, specs: LandmarkSpec[]): void {
  const R = def.visual.radius ?? def.physical.radius * 0.1;
  def.landmarks = specs.map(
    (s): LandmarkDef => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      lat: s.lat * DEG,
      lon: s.lon * DEG,
      radius: s.r / R,
      height: s.h / R,
      description: s.description,
      ...(s.color ? { color: s.color } : {}),
      ...(s.noStamp ? { noStamp: true } : {}),
    }),
  );
}

landmarks(earth, [
  { id: 'grand_canyon', name: 'Grand Canyon', kind: 'canyon', lat: 36.1, lon: -112.1, r: 12000, h: 450, description: 'Layers of red stone fall away to a river of shadow.', color: [0.1, 0.3, 0.45] },
  { id: 'victoria_falls', name: 'Victoria Falls', kind: 'waterfall', lat: -17.92, lon: 25.86, r: 2200, h: 220, description: 'The smoke that thunders: a whole river steps off the land.' },
  { id: 'uluru', name: 'Uluru', kind: 'mesa', lat: -25.34, lon: 131.04, r: 900, h: 330, description: 'A single red stone, awake before the sun.', color: [0.62, 0.17, 0.06] },
  { id: 'everest', name: 'Everest Summit', kind: 'summit', lat: 27.99, lon: 86.93, r: 60, h: 45, description: 'The highest ground there is, and the wind never rests.' },
  { id: 'delicate_arch', name: 'Delicate Arch', kind: 'arch', lat: 38.74, lon: -109.5, r: 150, h: 120, description: 'A door of sandstone, framing nothing but sky.' },
  { id: 'yellowstone', name: 'Yellowstone Geysers', kind: 'geyserField', lat: 44.46, lon: -110.83, r: 500, h: 220, description: 'The ground breathes out in tall white columns.' },
]);
landmarks(moon, [
  { id: 'tranquility', name: 'Tranquility Base', kind: 'lander', lat: 0.67, lon: 23.47, r: 12, h: 8, description: 'A small lander and a flag, left exactly as they were.' },
  { id: 'tycho_monolith', name: 'Tycho Monolith', kind: 'monolith', lat: -43.3, lon: -11.2, r: 34, h: 320, description: 'A black slab buried in the crater floor, waiting to be found.' },
  { id: 'shackleton', name: 'Shackleton Crater', kind: 'craterLake', lat: -89.5, lon: 129, r: 1800, h: 150, description: 'Ice that has never seen the sun, deep in a bowl of night.', color: [0.62, 0.8, 0.95] },
]);
landmarks(mercury, [
  { id: 'caloris', name: 'Caloris Basin', kind: 'crater', lat: 30.5, lon: -170.3, r: 6000, h: 500, description: 'A scar of the first great impact, ringed by broken hills.' },
]);
landmarks(mars, [
  { id: 'olympus_caldera', name: 'Olympus Mons Caldera', kind: 'summit', lat: 18.65, lon: -133.8, r: 60, h: 45, description: 'You are higher than any mountain should let you be.', noStamp: true },
  { id: 'valles_floor', name: 'Valles Marineris Floor', kind: 'crystalCanyon', lat: -6.3, lon: -70, r: 3500, h: 200, description: 'Rust walls rise for miles around a floor strewn with glass.', color: [1.0, 0.55, 0.3], noStamp: true },
  { id: 'cydonia', name: 'Cydonia Ruins', kind: 'ruins', lat: 40.75, lon: -9.46, r: 220, h: 60, description: 'A ring of broken pillars, older than the weather.' },
]);
landmarks(io, [
  { id: 'loki_patera', name: 'Loki Patera', kind: 'glowingPool', lat: -13, lon: -50, r: 2000, h: 250, description: 'A lake of molten rock that breathes light into the dark.', color: [1.0, 0.42, 0.08], noStamp: true },
]);
landmarks(europa, [
  { id: 'conamara', name: 'Conamara Chaos', kind: 'iceSpire', lat: 9.5, lon: -85.5, r: 1000, h: 350, description: 'Blue needles of ice crowd together and catch the light.' },
]);
landmarks(titan, [
  { id: 'kraken_mare', name: 'Kraken Mare Shore', kind: 'craterLake', lat: 68, lon: -35, r: 2000, h: 120, description: 'A still methane sea under an orange sky.', color: [0.2, 0.15, 0.06] },
]);
landmarks(enceladus, [
  { id: 'tiger_stripes', name: 'Tiger Stripes', kind: 'canyon', lat: -82, lon: 0, r: 4800, h: 600, description: 'Four blue scars slice the south pole, and white plumes rise from their floors.', color: [0.25, 0.55, 0.85] },
]);
landmarks(mimas, [
  { id: 'herschel', name: 'Herschel Crater', kind: 'crater', lat: 0, lon: -100, r: 3800, h: 1100, description: 'One impact left a bowl a third as wide as the whole moon, with a mountain at its heart.' },
]);
landmarks(iapetus, [
  { id: 'equatorial_ridge', name: 'Equatorial Ridge', kind: 'summit', lat: 0, lon: 0, r: 900, h: 700, description: 'A wall of mountains circles the moon at its waist, black at the base and white at the crest.', noStamp: true },
]);
landmarks(miranda, [
  { id: 'verona_rupes', name: 'Verona Rupes', kind: 'summit', lat: -21.6, lon: -13, r: 500, h: 400, description: 'The tallest cliff known. A dropped stone would fall for minutes.', noStamp: true },
]);
landmarks(triton, [
  { id: 'akupara', name: 'Akupara Maculae', kind: 'geyserField', lat: -45, lon: 30, r: 2500, h: 1200, description: 'Dark plumes lean on the thin wind and paint long streaks across the pink ice.', color: [0.38, 0.3, 0.3] },
]);
landmarks(ceres, [
  { id: 'occator', name: 'Occator Crater', kind: 'crater', lat: 19.8, lon: -121, r: 4600, h: 500, description: 'A dark crater whose floor is dotted with patches of salt as white as snow.', color: [0.82, 0.8, 0.72] },
  { id: 'vinalia', name: 'Vinalia Faculae', kind: 'glowingPool', lat: 20.9, lon: -119.6, r: 900, h: 90, description: 'Salt left by briny water, bright as a lamp.', color: [0.85, 0.82, 0.74] },
  { id: 'occator_west', name: 'Occator Salt', kind: 'glowingPool', lat: 18.9, lon: -122.1, r: 650, h: 70, description: 'A smaller patch of white salt on the dark floor.', color: [0.85, 0.82, 0.74] },
  { id: 'occator_south', name: 'Occator Salt', kind: 'glowingPool', lat: 20.3, lon: -123, r: 520, h: 60, description: 'A tiny patch of white salt on the dark floor.', color: [0.85, 0.82, 0.74] },
]);
landmarks(pluto, [
  { id: 'sputnik_planitia', name: 'Sputnik Planitia', kind: 'crater', lat: 22, lon: 177, r: 16600, h: 300, noStamp: true, description: 'A heart of smooth white ice, the size of a country, with nothing to disturb it.', color: [0.95, 0.92, 0.84] },
  { id: 'tenzing', name: 'Tenzing Montes', kind: 'summit', lat: 12, lon: 140, r: 500, h: 400, description: 'Mountains of water ice, hard as rock in the deep cold.' },
]);
landmarks(charon, [
  { id: 'serenity', name: 'Serenity Chasma', kind: 'canyon', lat: -5, lon: 90, r: 11000, h: 1600, description: 'A canyon far deeper than the Grand Canyon, cut across the grey ice.', color: [0.4, 0.4, 0.42] },
]);

export const SOLAR_SYSTEM: StarSystemDef = {
  id: 'sol',
  name: 'Sol',
  seed: 1977,
  bodies: [sun, mercury, venus, earth, moon, mars, phobos, deimos, ceres, jupiter, io, europa, ganymede, callisto, saturn, titan, enceladus, mimas, iapetus, uranus, miranda, neptune, triton, pluto, charon],
};

// Space scenery: belts, a bright comet inbound near Earth's orbit, and the Milky Way backdrop.
SOLAR_SYSTEM.belts = [
  { name: 'MAIN BELT', innerAU: 2.2, outerAU: 3.2, count: 5200, thickness: 0.07, color: [0.34, 0.29, 0.25], sizeMin: 8, sizeMax: 90, seed: 4242 },
  { name: 'KUIPER BELT', innerAU: 32, outerAU: 50, count: 2400, thickness: 0.14, color: [0.5, 0.56, 0.64], sizeMin: 10, sizeMax: 110, seed: 9191 },
];
SOLAR_SYSTEM.comets = [
  {
    id: 'comet',
    name: 'Comet Aurelia',
    seed: 77,
    orbit: {
      semiMajorAxis: 8 * AU,
      eccentricity: 0.92,
      inclination: 12 * DEG,
      ascendingNode: 40 * DEG,
      argPeriapsis: 230 * DEG,
      meanAnomalyAtEpoch: -0.064,
      period: Math.pow(8, 1.5) * YEAR,
    },
    nucleusRadius: 7000,
    tailAU: 0.45,
    activityAU: 3.2,
    ionColor: [0.35, 0.62, 1.0],
    dustColor: [1.0, 0.95, 0.85],
  },
];
SOLAR_SYSTEM.sky = { colors: [[0.35, 0.3, 0.8], [0.8, 0.35, 0.5], [0.25, 0.5, 0.9]], intensity: 0.45, band: 0.8, scale: 1.2, seed: 1977 };
