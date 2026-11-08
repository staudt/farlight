/** Live tunables for the weather effects (lil-gui friendly). */
export const rainSettings = {
  enabled: true,
  /** Multiplies the weather intensity. */
  intensity: 1,
  /** Forces full strength regardless of the weather cell (debug). */
  force: false,
  streakLength: 1,
};

export const snowSettings = {
  enabled: true,
  intensity: 1,
  force: false,
  flakeSize: 1,
};

export const lightningSettings = {
  enabled: true,
  intensity: 1,
  /** Draw the visible bolt mesh. */
  bolts: true,
  /** Chance that a strike draws a visible bolt. */
  boltChance: 0.6,
  flashStrength: 1,
};

export const auroraSettings = {
  enabled: true,
  intensity: 1,
  /** Curtain height as a fraction of the body radius. */
  height: 0.16,
};
