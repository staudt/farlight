import type { BodyDef, FeatureDef, LandmarkDef, LandmarkKind, RGB, TerrainDef } from './types';

/** Landmark helpers shared by data, generator, sim and UI. Pure: no Three, no DOM. */

/** Noun added to a generated name: "The Vylos Arch". */
export const LANDMARK_NOUN: Record<LandmarkKind, string> = {
  arch: 'Arch',
  monolith: 'Monolith',
  crystalCanyon: 'Crystal Canyon',
  waterfall: 'Falls',
  craterLake: 'Lake',
  ruins: 'Ruins',
  giantTree: 'Tree',
  iceSpire: 'Spires',
  geyserField: 'Geysers',
  glowingPool: 'Pool',
  canyon: 'Canyon',
  summit: 'Summit',
  mesa: 'Mesa',
  crater: 'Basin',
  lander: 'Lander',
};

export const DESCRIPTIONS: Record<LandmarkKind, readonly string[]> = {
  arch: ['Wind carved a doorway through the stone, and nobody came to close it.', 'A bridge of rock hangs over nothing, patient and old.'],
  monolith: ['A black slab stands alone, and it hums when you are not looking.', 'Smooth, dark and perfectly upright. Something made this.'],
  crystalCanyon: ['The canyon floor is a field of glowing crystals.', 'Light moves inside the walls like slow lightning.'],
  waterfall: ['A river leaps off the world and turns to mist.', 'White water falls for a long time before it lands.'],
  craterLake: ['An old wound in the ground, filled with still water.', 'A round lake rests inside the crater, mirroring the sky.'],
  ruins: ['A ring of broken pillars, older than the weather.', 'Standing stones circle a floor swept clean by the wind.'],
  giantTree: ['One tree, taller than the clouds should allow.', 'A single enormous tree, alone on the plain.'],
  iceSpire: ['Blue needles of ice crowd together and catch the light.', 'A forest of ice spires, sharp and silent.'],
  geyserField: ['The ground breathes out in tall white columns.', 'Vents hiss and throw steam high into the cold air.'],
  glowingPool: ['A pool that glows from below and never cools.', 'Soft light rises from a pool of unknown depth.'],
  canyon: ['A long scar in the land, walls falling away into shadow.'],
  summit: ['A small cairn marks the top of the world.'],
  mesa: ['A dome of red stone rises alone from the flat land.'],
  crater: ['A vast basin, ringed by hills and hushed by its own size.'],
  lander: ['A small lander and a flag, left exactly as they were.'],
};

/** Default tint per kind (linear RGB), used when a landmark has no `color`. */
export const LANDMARK_COLOR: Record<LandmarkKind, RGB> = {
  arch: [0.5, 0.3, 0.17],
  monolith: [0.02, 0.02, 0.025],
  crystalCanyon: [0.35, 0.8, 1.0],
  waterfall: [0.9, 0.97, 1.0],
  craterLake: [0.08, 0.3, 0.55],
  ruins: [0.45, 0.4, 0.34],
  giantTree: [0.1, 0.4, 0.14],
  iceSpire: [0.6, 0.85, 1.0],
  geyserField: [0.92, 0.94, 0.98],
  glowingPool: [0.2, 0.9, 0.7],
  canyon: [0.5, 0.3, 0.2],
  summit: [0.5, 0.48, 0.45],
  mesa: [0.55, 0.2, 0.09],
  crater: [0.4, 0.38, 0.36],
  lander: [0.8, 0.7, 0.4],
};

export function landmarkKey(systemId: string, bodyId: string, landmarkId: string): string {
  return `${systemId}/${bodyId}/${landmarkId}`;
}

/** Footprint radius in game meters. */
export function landmarkRadiusMeters(lm: LandmarkDef, bodyRadius: number): number {
  return lm.radius * bodyRadius;
}

/** Vertical size in game meters (a per kind default from the footprint when `height` is omitted). */
export function landmarkHeightMeters(lm: LandmarkDef, bodyRadius: number): number {
  if (lm.height !== undefined) return lm.height * bodyRadius;
  return lm.radius * bodyRadius * 0.5;
}

/**
 * Terrain stamps for a landmark. `height` is a fraction of the body radius, FeatureDef.height is
 * normalized to the terrain amplitude, so it is divided by the amplitude here.
 */
export function landmarkStamps(lm: LandmarkDef, terrain: TerrainDef): FeatureDef[] {
  if (lm.noStamp) return [];
  const amp = Math.max(1e-6, terrain.amplitude);
  const h = (lm.height ?? lm.radius * 0.5) / amp;
  const base = { name: lm.name, lat: lm.lat, lon: lm.lon };
  switch (lm.kind) {
    case 'canyon':
    case 'crystalCanyon':
      return [{ ...base, kind: 'canyon', radius: lm.radius, height: -h }];
    case 'waterfall':
      return [{ ...base, kind: 'cliff', radius: lm.radius, height: h }];
    case 'craterLake':
    case 'glowingPool':
    case 'crater':
      return [{ ...base, kind: 'crater', radius: lm.radius, height: -h }];
    case 'iceSpire':
      return [{ ...base, kind: 'spires', radius: lm.radius * 1.6, height: h * 0.8 }];
    default:
      return [];
  }
}

export function landmarksOf(def: Pick<BodyDef, 'landmarks'>): readonly LandmarkDef[] {
  return def.landmarks ?? [];
}
