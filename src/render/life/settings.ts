/** Live tunables for the creatures (lil-gui friendly). */
export const lifeSettings = {
  enabled: true,
  /** Multiplies how many groups live around the camera. */
  density: 1,
  birds: true,
  skyWhales: true,
  fish: true,
  fireflies: true,
  /** Birds scatter when the ship is closer than this, game meters. */
  scatterRadius: 150,
  birdSpeed: 1,
  whaleSpeed: 1,
  /** Night glow gain for whales and fireflies. */
  glow: 1,
};

export interface LifeBudget {
  /** Most bird flocks alive at once. */
  flocks: number;
  /** Most birds in one flock. */
  birdsPerFlock: number;
  pods: number;
  whalesPerPod: number;
  schools: number;
  fishPerSchool: number;
  swarms: number;
  motesPerSwarm: number;
}

/**
 * Group caps from the quality preset's `fxScale` (1 high, 0.65 medium, 0.35 low) and the density
 * slider. Low keeps a few birds and whales; fish and fireflies need medium or better.
 */
export function lifeBudget(fxScale: number, density = 1): LifeBudget {
  const k = Math.max(0, fxScale) * Math.max(0, density);
  const rich = fxScale >= 0.5;
  return {
    flocks: Math.min(20, Math.floor(10 * k)),
    birdsPerFlock: Math.round(30 * Math.min(1, Math.max(0.4, fxScale))),
    pods: density > 0 ? Math.min(4, Math.max(1, Math.round(3 * k))) : 0,
    whalesPerPod: 3,
    schools: rich ? Math.min(13, Math.round(8 * k)) : 0,
    fishPerSchool: 48,
    swarms: rich ? Math.min(57, Math.round(24 * k)) : 0,
    motesPerSwarm: 14,
  };
}

/** The most instances each layer can ever draw for a budget. */
export function maxInstances(b: LifeBudget): { birds: number; whales: number; fish: number; motes: number } {
  return { birds: b.flocks * b.birdsPerFlock, whales: b.pods * b.whalesPerPod, fish: b.schools * b.fishPerSchool, motes: b.swarms * b.motesPerSwarm };
}
