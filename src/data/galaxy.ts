/**
 * Galaxy contract shared by the procedural generator, the galaxy map and the boot code.
 *
 * Systems load from the URL (`?system=<id>`), so travelling to another star is: play the
 * hyperspace transition, then navigate to the new URL. `sol` is the hand authored solar system;
 * every other id is generated from its seed by `generateSystem` (src/data/generate.ts).
 */

/** Spectral class drives star color, size and the planets it tends to have. */
export type StarClass = 'M' | 'K' | 'G' | 'F' | 'A' | 'B';

export interface GalaxyStar {
  /** URL safe id: 'sol' or 's' + seed in base 36. */
  id: string;
  seed: number;
  /** Generated proper name (no dashes). */
  name: string;
  starClass: StarClass;
  /** Galactic position in light years, galaxy centre at the origin, disc in the XY plane. */
  x: number;
  y: number;
  /** Small vertical offset from the disc plane, light years. */
  z: number;
  /** Hint for the map before the system is generated: planet count. */
  planetCount: number;
}

export interface GalaxyDef {
  seed: number;
  name: string;
  /** Radius of the disc in light years. */
  radius: number;
  stars: GalaxyStar[];
  /** Id of the star the player starts at. */
  homeId: string;
}

/** Visited systems and survey progress persist per browser (localStorage key below). */
export const PROGRESS_STORAGE_KEY = 'farlight.progress.v1';

export interface PlayerProgress {
  /** Star ids visited at least once. */
  visited: string[];
  /** Body ids (`<systemId>/<bodyId>`) the player has flown close to or landed on. */
  surveyed: string[];
  /** Discovered landmarks (`<systemId>/<bodyId>/<landmarkId>`). Absent in old saves. */
  landmarks?: string[];
}
