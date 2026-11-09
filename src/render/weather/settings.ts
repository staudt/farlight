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

export const acidRainSettings = {
  enabled: true,
  intensity: 1,
  force: false,
  /** Droplets beading on the camera while inside the rain. */
  lensDrops: true,
};

export const methaneRainSettings = {
  enabled: true,
  intensity: 1,
  force: false,
  dropSize: 1,
};

export const heatShimmerSettings = {
  enabled: true,
  intensity: 1,
  /** Heat haze strength at the horizon over hot ground. */
  haze: 1,
  /** Draw the effect even on a cold, shaded or distant body (debug). */
  force: false,
};

export const scorchSettings = {
  enabled: true,
  intensity: 1,
};

export const plumeSettings = {
  enabled: true,
  intensity: 1,
  /** Scales the plume height. */
  height: 1,
};

export const geyserSettings = {
  enabled: true,
  intensity: 1,
  height: 1,
};

export const dustDevilSettings = {
  enabled: true,
  intensity: 1,
  height: 1,
};

/** Everything the F3 panel lists under Weather. */
export const weatherSettings = {
  rain: rainSettings,
  snow: snowSettings,
  lightning: lightningSettings,
  aurora: auroraSettings,
  acidRain: acidRainSettings,
  methaneRain: methaneRainSettings,
  heatShimmer: heatShimmerSettings,
  scorching: scorchSettings,
  volcanicPlume: plumeSettings,
  geyser: geyserSettings,
  dustDevil: dustDevilSettings,
};
