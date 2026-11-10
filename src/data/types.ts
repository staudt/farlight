/**
 * Data schema for star systems. Everything the game shows comes from these
 * definitions. The hand authored solar system and the future procedural
 * generator both produce a StarSystemDef; no module may special case a body by name.
 *
 * Unit conventions:
 *  - physical.* and orbit.* are REAL values (meters, seconds, radians). The ScaleProfile
 *    converts them to game units. Artistic overrides in `visual` are in GAME meters.
 *  - Atmosphere and terrain heights are FRACTIONS of the body's game radius, so they stay
 *    valid whatever scale profile is used.
 *  - Colors are linear RGB 0..1.
 */

export type RGB = readonly [number, number, number];

export type BodyKind = 'star' | 'rocky' | 'gas';

export interface StarSystemDef {
  id: string;
  name: string;
  seed: number;
  /** Ordered so that parents come before children. The first body is the root star. */
  bodies: BodyDef[];
  /** Asteroid belts around the root star (real AU, scaled like orbits). */
  belts?: BeltDef[];
  /** Comets on eccentric rails around the root star. A separate list: nothing iterates these as bodies. */
  comets?: CometDef[];
  /** Backdrop painted into the sky sphere (nebula and galactic band). */
  sky?: SkyDef;
}

export interface BeltDef {
  name: string;
  /** Real AU from the root star, scaled by the ScaleProfile like planet orbits. */
  innerAU: number;
  outerAU: number;
  /** Dots in the far dusty band. */
  count: number;
  /** Half thickness of the belt as a fraction of its mean radius. */
  thickness: number;
  /** Rock color (linear RGB). */
  color: RGB;
  /** Near rock size range, game meters. Rarer mid and km scale rocks derive from sizeMax. */
  sizeMin: number;
  sizeMax: number;
  seed: number;
}

export interface CometDef {
  id: string;
  name: string;
  seed: number;
  /** Real heliocentric orbit around the root star (very eccentric). */
  orbit: OrbitDef;
  /** Nucleus radius, game meters. */
  nucleusRadius: number;
  /** Full tail length in real AU at peak activity (scaled like orbits). */
  tailAU: number;
  /** Tails and coma develop inside this real distance from the star, AU. */
  activityAU: number;
  ionColor: RGB;
  dustColor: RGB;
}

export interface SkyDef {
  /** Two or three nebula tints, linear RGB 0..1. */
  colors: RGB[];
  /** Cloud brightness, 0..1.5. */
  intensity: number;
  /** Galactic band glow, 0..1.5. */
  band: number;
  /** Cloud feature size multiplier (1 default; bigger = larger clouds). */
  scale: number;
  seed: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  parentId?: string;
  seed: number;
  physical: PhysicalDef;
  orbit?: OrbitDef;
  visual: VisualDef;
  atmosphere?: AtmosphereDef;
  /**
   * Surface and sky effects that do not need an atmosphere (heat shimmer, scorching sun,
   * plumes, geysers). Effects of an atmosphere live in `atmosphere.weather`; both are read
   * through `effectsOf`.
   */
  effects?: WeatherDef[];
  terrain?: TerrainDef;
  gas?: GasDef;
  rings?: RingDef;
  star?: StarDef;
  info: BodyInfo;
}

export interface PhysicalDef {
  /** Real mean radius in meters. */
  radius: number;
  /** Surface gravity in g. */
  surfaceGravity: number;
  /** Sidereal rotation period in seconds. Negative means retrograde. Ignored if tidallyLocked. */
  rotationPeriod: number;
  /** Obliquity in radians. */
  axialTilt: number;
  /** Always shows the same face to its parent. */
  tidallyLocked?: boolean;
}

export interface OrbitDef {
  /** Real semi major axis in meters. */
  semiMajorAxis: number;
  eccentricity: number;
  /** Radians, relative to the parent's reference plane (ecliptic). */
  inclination: number;
  ascendingNode: number;
  argPeriapsis: number;
  /** Mean anomaly at sim time 0, radians. */
  meanAnomalyAtEpoch: number;
  /** Orbital period in seconds. Negative means retrograde. */
  period: number;
}

export interface VisualDef {
  /** Game meters. Overrides the scaled physical radius. */
  radius?: number;
  /** Game meters. Overrides the scaled semi major axis. */
  orbitDistance?: number;
  /** Angular DIAMETER floor in radians. The body never looks smaller than this. */
  minApparentSize?: number;
  /** Dominant color: far glow, map icon, impostor fallback. */
  color: RGB;
  /** Sphere of influence radius as a multiple of the game radius. */
  soiFactor?: number;
}

export interface AtmosphereDef {
  /** Atmosphere thickness as a fraction of the game radius. */
  height: number;
  /** Density scale height as a fraction of the atmosphere thickness (Earth ~0.12). */
  scaleHeight: number;
  /** Zenith Rayleigh optical depth per channel (Earth ~[0.05, 0.11, 0.27]). */
  rayleighDepth: RGB;
  /** Zenith Mie (haze/dust) optical depth. */
  mieDepth: number;
  /** Mie phase anisotropy, 0.7..0.9. */
  mieG: number;
  /** Tint of the Mie scattering, white for water haze, butterscotch for Mars dust. */
  mieColor?: RGB;
  /** Extra absorption optical depth per channel (ozone like). */
  absorptionDepth?: RGB;
  /** Sun light intensity used by the scattering shader. */
  sunIntensity: number;
  /** How strongly the ship is leveled at sea level, 0..1. */
  stabilization?: number;
  clouds?: CloudDef;
  weather?: WeatherDef[];
  aurora?: AuroraDef;
}

export interface CloudDef {
  /** Base altitude as a fraction of atmosphere thickness. */
  altitude: number;
  /** Layer thickness as a fraction of atmosphere thickness. */
  thickness: number;
  /** 0..1 sky coverage. */
  coverage: number;
  color: RGB;
  /** Noise feature size as a fraction of the body radius. */
  scale: number;
  /** Drift speed, game meters per second. */
  speed: number;
}

export type WeatherKind =
  | 'rain'
  | 'snow'
  | 'dust'
  | 'lightning'
  | 'acidRain'
  | 'methaneRain'
  | 'heatShimmer'
  | 'scorching'
  | 'volcanicPlume'
  | 'geyser'
  | 'dustDevil';

export interface WeatherDef {
  kind: WeatherKind;
  /** 0..1 */
  intensity: number;
  color?: RGB;
  /** Absolute latitude band in radians where this weather happens. */
  latitudeBand?: readonly [number, number];
  /** Plumes, geysers and devils: height as a fraction of the body radius. */
  size?: number;
  /** Geysers: how many seeded vents. */
  count?: number;
}

export interface AuroraDef {
  colors: readonly RGB[];
  /** Ring latitude in radians (both poles). */
  latitude: number;
  intensity: number;
}

export interface TerrainDef {
  /** Max relief as a fraction of the game radius. */
  amplitude: number;
  /** Normalized height (-1..1) below which the surface is water. Omit for dry worlds. */
  seaLevel?: number;
  layers: NoiseLayer[];
  craters?: CraterDef;
  features?: FeatureDef[];
  /** Ordered rules. The first matching biome colors the vertex; blending happens at edges. */
  biomes: BiomeDef[];
  water?: { color: RGB; deepColor: RGB };
  polarCaps?: { latitude: number; color: RGB };
  props?: PropDef[];
  /** Optional equirectangular data maps (see terrain/maps.ts). Any body may use them. */
  maps?: TerrainMapsDef;
}

export interface TerrainMapsDef {
  /** Signed distance to coast (positive inland), Uint8 with a tiny header; decoded to base height. */
  land?: string;
  /** Mountain range mask 0..1: raises the base and strengthens ridged layers. */
  mountains?: string;
  /** Desert mask 0..1: pushes biome moisture low. */
  deserts?: string;
  /** Ice mask 0..1 (glaciers, ice sheets): white biome. */
  ice?: string;
  /** Distance covered by the full Uint8 range of the land map, in km (default 600). */
  landRangeKm?: number;
  /** Body radius used to convert km to angles, km (default 6371). */
  radiusKm?: number;
  /** Overall strength of the maps over the procedural layers, 0..1 (default 1). */
  influence?: number;
}

export type NoiseType = 'fbm' | 'ridged' | 'billow';

export interface NoiseLayer {
  type: NoiseType;
  /** Base frequency in cycles across the unit sphere. */
  frequency: number;
  /** Contribution to the normalized height. */
  amplitude: number;
  octaves: number;
  lacunarity?: number;
  gain?: number;
  /** Domain warp strength, 0 for none. */
  warp?: number;
  /** Optional low frequency mask: the layer only shows where the mask noise > threshold. */
  mask?: { frequency: number; threshold: number };
}

export interface CraterDef {
  count: number;
  /** Fractions of the radius. */
  minRadius: number;
  maxRadius: number;
  /** Bowl depth relative to crater radius. */
  depth: number;
  /** Rim height relative to crater radius. */
  rimHeight: number;
}

export type FeatureKind = 'volcano' | 'canyon' | 'spires' | 'mesa';

export interface FeatureDef {
  kind: FeatureKind;
  name?: string;
  /** Radians. */
  lat: number;
  lon: number;
  /** Fraction of the radius. */
  radius: number;
  /** Normalized height contribution. */
  height: number;
}

export interface BiomeDef {
  name: string;
  color: RGB;
  /** Normalized height range (-1..1). */
  minHeight?: number;
  maxHeight?: number;
  /** Max slope, 0 flat .. 1 vertical. */
  maxSlope?: number;
  /** Absolute latitude range in radians. */
  latitude?: readonly [number, number];
  /** Moisture noise range 0..1. */
  moisture?: readonly [number, number];
}

export type PropKind = 'tree' | 'rock' | 'spire' | 'crystal' | 'mesa';

export interface PropDef {
  kind: PropKind;
  /** Instances per square kilometer. */
  density: number;
  color: RGB;
  /** Game meters. */
  minSize: number;
  maxSize: number;
  minHeight?: number;
  maxHeight?: number;
  maxSlope?: number;
  biomes?: string[];
}

export interface GasDef {
  bands: readonly RGB[];
  bandFrequency: number;
  turbulence: number;
  storms?: { lat: number; lon: number; size: number; color: RGB }[];
  /** Depth below the cloud tops where the pressure floor pushes back, fraction of radius. */
  cloudDeckDepth: number;
}

export interface RingDef {
  /** Multiples of the planet radius. */
  innerRadius: number;
  outerRadius: number;
  color: RGB;
  opacity: number;
  bands: number;
}

export interface StarDef {
  color: RGB;
  intensity: number;
  /** Glow sprite size as a multiple of the radius. */
  coronaSize: number;
}

export interface BodyInfo {
  /** Short labels for the HUD card. */
  type: string;
  atmosphere: string;
  temperature: string;
  features: string[];
  /** Short danger labels, no dashes: 'Acid rain', 'Searing heat'. */
  hazards?: string[];
  summary: string;
}

/** Every weather and surface effect a body has, atmosphere weather first. */
export function effectsOf(def: BodyDef): readonly WeatherDef[] {
  const w = def.atmosphere?.weather;
  if (!w) return def.effects ?? [];
  return def.effects ? [...w, ...def.effects] : w;
}

export function findEffect(def: BodyDef, kind: WeatherKind): WeatherDef | undefined {
  return def.atmosphere?.weather?.find((d) => d.kind === kind) ?? def.effects?.find((d) => d.kind === kind);
}
