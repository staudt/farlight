/**
 * Every tunable lives here. The debug panel edits this object live, so code must read
 * values at use time instead of caching them.
 */
export const config = {
  flight: {
    /**
     * Speed cap = distance to nearest surface / impactTime. Feel over realism: a boosted trip
     * from Earth to the Moon takes about half a minute, and a planet can be crossed in minutes.
     */
    impactTime: 2,
    minSpeedCap: 640,
    maxSpeedCap: 4000000,
    boostMultiplier: 4,
    /** Seconds to approach the target velocity. */
    accelTau: 0.5,
    /** Slowing down is quicker than speeding up, so arrivals brake in time. */
    decelTau: 0.2,
    /** Angular rates at full input, rad/s. */
    pitchRate: 1.0,
    yawRate: 0.6,
    rollRate: 1.8,
    angularTau: 0.22,
    /** Speed at which wings fully support the ship in dense air, m/s. */
    liftSpeed: 70,
    /** Descent rate (m/s at 1 g) when the wings have too little airspeed to hold the ship. */
    sinkRate: 30,
    /** Seconds for the descent to settle on the sink rate (kept short against decelTau). */
    sinkTau: 0.5,
    /** Re-entry stress per unit of speed above the local cap (in air). */
    entryStressGain: 2.5,
    cushionHeight: 220,
    /** Extra cushion height per m/s of horizontal speed (s), so fast flight clears hills sooner. */
    cushionLead: 0.25,
    /** Seconds ahead where the terrain is sampled for the cushion. */
    lookAheadTimes: [0.15, 0.5, 1.2, 2.5] as number[],
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
    /** Cockpit overlay: glass reflection strength and HDR strength of the instrument lights. */
    cockpit: { glass: 1, instrumentGlow: 1 },
    /** Look mode: radians per mouse pixel, pitch limit (85 deg), orbit zoom range as a multiple of the chase distance. */
    lookSensitivity: 0.004,
    lookPitchMax: 1.4835,
    lookZoomMin: 0.5,
    lookZoomMax: 8,
    /** Seconds for the orbit to settle back behind the ship when look mode ends. */
    lookReturnTau: 0.3,
  },
  render: {
    near: 0.5,
    far: 1e11,
    pixelRatioMax: 1.5,
  },
  /** Render quality presets and the auto adapt rules (see render/quality.ts). */
  quality: {
    /** 'auto' picks from the device and adapts at runtime. */
    preset: 'auto' as 'auto' | 'low' | 'medium' | 'high',
    /** Auto: step down when fps stays under `downFps` for `downSecs`. */
    downFps: 45,
    downSecs: 3,
    /** Auto: step up when fps stays at `upFps` or more for `upSecs`. */
    upFps: 57,
    upSecs: 10,
    /** Auto: after a step down, wait at least this long before stepping up (doubles on a bounce). */
    upCooldown: 30,
    /** Seconds ignored after load before auto adapts. */
    warmup: 4,
    presets: {
      low: { pixelRatioMax: 1, msaa: 0, volScale: 0.4, cloudSteps: 14, cloudLight: 2, atmoSteps: 8, atmoLight: 3, cloudShadows: false, bloom: false, bloomLevels: 3, splitFactor: 0.7, gasOctaves: 2, shimmer: false, fxScale: 0.35 },
      medium: { pixelRatioMax: 1.25, msaa: 2, volScale: 0.5, cloudSteps: 22, cloudLight: 3, atmoSteps: 10, atmoLight: 4, cloudShadows: true, bloom: true, bloomLevels: 5, splitFactor: 0.85, gasOctaves: 3, shimmer: true, fxScale: 0.65 },
      high: { pixelRatioMax: 1.5, msaa: 4, volScale: 0.67, cloudSteps: 30, cloudLight: 3, atmoSteps: 14, atmoLight: 5, cloudShadows: true, bloom: true, bloomLevels: 8, splitFactor: 1, gasOctaves: 4, shimmer: true, fxScale: 1 },
    },
  },
  /** Touch controls (phones). */
  touch: {
    /** Pixel ratio cap on touch devices, read at startup. */
    pixelRatioMax: 1.25,
    /** Floating stick travel in CSS px. */
    stickRadius: 60,
    deadzone: 0.08,
    /** Roll fed from stick x in space, for coordinated turns. */
    spaceRoll: 0.4,
    /** False: push the stick up for nose up. True: push down for nose up. */
    invertPitch: false,
    /** Seconds the planet info card stays up after it is summoned or a body is entered. */
    cardSeconds: 8,
    /** Free look drag, mouse pixel equivalents per touch pixel. */
    lookScale: 1.6,
    /** Tilt for full deflection, degrees. */
    tiltRange: 22,
    tiltDeadzone: 0.1,
    idleOpacity: 0.35,
  },
  /** Gamepad (standard mapping). */
  gamepad: {
    deadzone: 0.16,
    invertPitch: false,
    /** Free look speed at full right stick, mouse pixel equivalents per second. */
    lookSpeed: 420,
    /** Seconds View/Back must be held to save a snapshot (a tap opens the map). */
    snapshotHold: 0.6,
  },
  /** Photo mode. */
  photo: {
    fov: 55,
    fovMin: 15,
    fovMax: 100,
    /** Orbit distance limits, game meters. */
    distMin: 5,
    distMax: 50000,
    /** Radians per pixel dragged. */
    orbitSpeed: 0.005,
    /** Zoom e-folds per wheel notch (wheel unit is 0.08). */
    wheelZoom: 3,
    /** Pan speed in orbit distances per second. */
    panSpeed: 0.6,
    rollSpeed: 0.8,
    /** Seconds of inactivity before the panel hides. */
    panelHide: 2,
  },
  /** Oceans: animated waves, shore foam and the low flight wake. */
  water: {
    enabled: true,
    /** Global multipliers on top of each body's `terrain.water.waves`. */
    waveAmplitude: 1,
    waveSpeed: 1,
    foam: 1,
    /** Shore foam band width multiplier (1 is about 110 m, wider on coarse terrain). */
    foamWidth: 1,
    /** Wake: below this height over water the ship throws spray, meters. */
    wakeAltitude: 60,
    /** Wake: speed (m/s) where the spray starts and where it is full. */
    wakeSpeedMin: 25,
    wakeSpeedFull: 110,
    /** Seconds the surface foam trail lasts. */
    wakeLife: 6,
    /** Spray particles at fxScale 1. */
    sprayMax: 2400,
    spraySize: 1,
  },
  /** Surface props (trees, rocks, spires, crystals, mesas). */
  props: {
    enabled: true,
    /** Props shrink to nothing between these camera distances, game meters. */
    fadeNear: 900,
    fadeFar: 1900,
    /** HDR strength of crystal glow. */
    emissive: 2.2,
    /** Global scale of night glow: city lights, lava, bioluminescence. */
    nightGlow: 1,
  },
  /** Space scenery: asteroid belts, comets and the nebula backdrop. */
  space: {
    enabled: true,
    /** Near rock density multiplier (0 hides the rocks, the far band stays). */
    rockDensity: 1,
    /** Far dusty band brightness. */
    beltDust: 1,
    /** Comet coma and tail brightness. */
    cometGlow: 1,
    /** Comet tail length multiplier. */
    cometTail: 1,
    /** Nebula backdrop brightness. */
    nebula: 1,
  },
  /** Landmarks and discoveries. */
  landmarks: {
    enabled: true,
    /** A landmark is discovered within this horizontal distance (game meters) and altitude. */
    discoverRadius: 3000,
    discoverAltitude: 5000,
    /** Landed this close (horizontal) also discovers it. */
    landedRadius: 8000,
    /** Undiscovered markers show within this distance (game meters). */
    markerRange: 300000,
    /** Meshes are built when the camera is closer than this, and drawn within drawRange. */
    buildRange: 90000,
    drawRange: 120000,
    /** HDR strength of landmark glows (pools, monolith, crystals). */
    glow: 1,
  },
  debug: {
    showPanel: false,
  },
};

export type Config = typeof config;
