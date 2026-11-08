/**
 * Every tunable lives here. The debug panel edits this object live, so code must read
 * values at use time instead of caching them.
 */
export const config = {
  flight: {
    /** Speed cap = distance to nearest surface / impactTime. Time warp does the distance work. */
    impactTime: 20,
    minSpeedCap: 90,
    maxSpeedCap: 30000,
    boostMultiplier: 2.2,
    /** Seconds to approach the target velocity. */
    accelTau: 1.4,
    /** Angular rates at full input, rad/s. */
    pitchRate: 1.0,
    yawRate: 0.6,
    rollRate: 1.8,
    angularTau: 0.22,
    /** Speed at which wings fully support the ship in dense air, m/s. */
    liftSpeed: 70,
    cushionHeight: 220,
    gearHeight: 3,
    landSpeed: 14,
    /** Max auto leveling rates at sea level density, rad/s. */
    levelRollRate: 0.9,
    levelPitchRate: 0.18,
    /** Only near level flight is pulled to level, so deliberate climbs are kept. */
    levelPitchWindow: 0.45,
    /** Bank angle (rad) when yawing in atmosphere. */
    bankAngle: 0.55,
    alignRate: 1.2,
    throttleRate: 0.6,
  },
  warp: {
    levels: [1, 2, 4, 10, 100, 1000, 10000, 100000],
    atmosphereMax: 4,
    landedMax: 10000,
    /** Warp drops so that a boundary is never less than this many real seconds away. */
    minRealEta: 4,
  },
  camera: {
    fov: 62,
    fovBoost: 10,
    chaseDistance: 34,
    chaseHeight: 8,
    lookAheadHeight: 3,
    positionLag: 0.1,
    rotationLag: 0.16,
    horizonUpBlend: 0.85,
    cockpitOffset: [0, 1.1, -3.2] as [number, number, number],
  },
  render: {
    near: 0.5,
    far: 1e11,
    pixelRatioMax: 1.5,
  },
  debug: {
    showPanel: false,
  },
};

export type Config = typeof config;
