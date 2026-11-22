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
    levels: [1, 2, 3, 4, 10, 100, 1000, 10000, 100000],
    /** Number keys 1 to 6 jump straight to these time multipliers. */
    keyPresets: [1, 2, 3, 4, 100, 1000],
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
    /** First person: only the dash with its light bars by default; the canopy frame, nose and glass are optional. */
    cockpit: { glass: 1, instrumentGlow: 1, frame: false, dash: false },
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
    /** Atmosphere march: sample spacing on short paths, in smaller scale heights (0 = always the full step count). */
    atmoAdaptive: 0.5,
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
    /**
     * Terrain budget per preset: maxChunks caps live chunk nodes per planet (splits are granted by
     * screen space error until it is full), maxInFlight caps queued worker builds (0 = 4 per worker),
     * propRange scales the prop fade distances and propLevels is how many of the finest levels carry props.
     */
    /** Seconds ignored after load before auto adapts. */
    warmup: 4,
    presets: {
      low: { pixelRatioMax: 1, msaa: 0, volScale: 0.4, cloudSteps: 10, cloudLight: 2, atmoSteps: 8, atmoLight: 3, cloudShadows: false, bloom: false, bloomLevels: 3, splitFactor: 0.7, gasOctaves: 2, shimmer: false, godRaySamples: 0, godRayScale: 0.25, lensFlare: true, fxScale: 0.35, maxChunks: 700, maxInFlight: 6, propRange: 0.55, propLevels: 1, nightFx: 1 },
      medium: { pixelRatioMax: 1.25, msaa: 2, volScale: 0.5, cloudSteps: 14, cloudLight: 3, atmoSteps: 10, atmoLight: 4, cloudShadows: true, bloom: true, bloomLevels: 5, splitFactor: 0.85, gasOctaves: 3, shimmer: true, godRaySamples: 20, godRayScale: 0.25, lensFlare: true, fxScale: 0.65, maxChunks: 1400, maxInFlight: 8, propRange: 0.75, propLevels: 1, nightFx: 2 },
      high: { pixelRatioMax: 1.5, msaa: 4, volScale: 0.67, cloudSteps: 20, cloudLight: 3, atmoSteps: 14, atmoLight: 5, cloudShadows: true, bloom: true, bloomLevels: 8, splitFactor: 1, gasOctaves: 4, shimmer: true, godRaySamples: 32, godRayScale: 0.33, lensFlare: true, fxScale: 1, maxChunks: 4500, maxInFlight: 0, propRange: 1, propLevels: 2, nightFx: 2 },
    },
  },
  /** Volumetric clouds (render/clouds, render/volumetricPass.ts). */
  clouds: {
    /** Weather scale structure: latitude bands (ITCZ, dry subtropics, storm tracks), meandering fronts. 0 = old uniform blobs. */
    structure: 1,
    /** Cyclones (spiral storms, up to 4) and their angular radius in radians. */
    cyclones: 3,
    cycloneSize: 0.3,
    /** Temporal accumulation: history weight 0..0.95 (0 = off) and the neighbourhood clip width in standard deviations. */
    taa: 0.85,
    taaClip: 1.3,
    /** Lighting: powder (dark sun facing edges), silver lining strength, bluish grey underside, warm tint at low sun. */
    powder: 0.8,
    silver: 1,
    underside: 0.6,
    warmth: 1,
  },
  /** God rays (screen space light shafts from the sun, render/fx/godRays.ts). */
  godRays: {
    enabled: true,
    /** The player's toggle from the settings screen (also needs `enabled`). */
    user: true,
    /** Overall multiplier on the shaft brightness. */
    intensity: 1,
    /** Brightness of a full strength shaft (HDR, before tone mapping). */
    gain: 1,
    /** How much partly blocked beams darken the air (the contrast that makes the lit ones read). */
    shade: 0.25,
    /** Per ray decay along the march (1 = no decay). */
    decay: 0.965,
    /** Fraction of the sun to pixel distance that is marched (1 = all the way to the sun). */
    length: 0.9,
    /** Screen radius (in screen heights) where the sun's glow weight has fallen to 1/e. */
    sunRadius: 0.9,
    /** Rays below this strength skip the pass entirely. */
    minStrength: 0.01,
    /** Air density baseline for a clear world, plus extra gain for murky air (Mie depth). */
    baseStrength: 0.8,
    hazeGain: 2.5,
    /** Extra strength with the sun low in the sky (sunrise and sunset). */
    lowSunBoost: 1.2,
    /** Debug: ignore air density and sun elevation and force this strength (0 = off). */
    force: 0,
  },
  /** Lens flare (render/fx/lensFlare.ts). */
  lensFlare: {
    enabled: true,
    /** The player's toggle from the settings screen (also needs `enabled`). */
    user: true,
    intensity: 1,
    ghostIntensity: 1,
    haloIntensity: 1,
    streakIntensity: 1,
    starburstIntensity: 1,
    /** Seconds to fade visibility in and out. */
    smoothing: 0.1,
    /** Screen radius (in screen heights) of the sample disc used for the depth occlusion test. */
    sampleRadius: 0.018,
    /** How far past the screen edge (in screens) the flare still shows. */
    edgeMargin: 0.12,
    /** Floor of the dimming when the sun sits on the horizon (0..1). */
    horizonDim: 0.25,
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
    /** Sky reflection strength (Fresnel), from the body's atmosphere colours. */
    reflection: 0.85,
    /** Brightness of the reflected sky. */
    skyGain: 0.75,
    /** Sun glint strength. */
    glint: 1,
    /** Base glint lobe half width as a slope (about 0.1 is a breezy sea). It broadens with distance. */
    glintRoughness: 0.08,
    /** Glint stretch along the sun direction. */
    glintStretch: 1.7,
    /** Twinkle of the glitter path, 0 smooth, 1 full sparkle. */
    sparkle: 1,
    /** Turquoise shallows, 0 off. */
    shallows: 1,
    /** Moon glint on the night sea. */
    moonGlint: 1,
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
    /** Moonlight and starlight on the night side of a body: cool ambient so terrain still reads. */
    nightAmbient: 0.13,
  },
  /** Nights: moonlight, starlight floor, the night sky and the night limb from orbit (render/nightLight.ts, render/sky). */
  night: {
    enabled: true,
    /** Directional light from the biggest moon (or the parent planet for a moon), 1 = a full, close moon. */
    moonLight: 1,
    /** Strength of the moon light in terrain units (sun is about 1.25). */
    moonStrength: 0.28,
    /** Blue tint and desaturation of dark scenes (Purkinje), 0 off. */
    purkinje: 0.8,
    /** Moonlit sky glow in the atmosphere (blue wash) and how much a bright moon washes out stars. */
    moonSky: 1,
    starWash: 0.5,
    /** Milky Way brightness multiplier (baked band and the extra stars). */
    milkyWay: 1,
    /** Star twinkle near the horizon, 0 off. */
    twinkle: 1,
    /** Zodiacal light cone after dusk. */
    zodiacal: 1,
    /** Airglow band above the horizon and the green limb from orbit. */
    airglow: 1,
    /** Orange and red twilight band along the terminator seen from orbit. */
    twilightBand: 1,
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
  /** Gas giant look (read every frame, live in the debug panel). */
  gasGiant: {
    /** Differential rotation speed multiplier (bands and ovals drift, storms spin). */
    flowSpeed: 1,
    /** Kelvin-Helmholtz curls and festoons along band edges. */
    curls: 1,
    /** Fine sub-bands inside the main bands. */
    subBands: 1,
    /** White ovals and dark barges. */
    ovals: 1,
    /** Multiplier on the per body polar strength. */
    polar: 1,
    /** Soft atmospheric limb glow, tinted by the palette. */
    limbGlow: 0.55,
    /** Warm band along the terminator. */
    terminatorWarm: 0.35,
  },
  /** Eclipses and moon shadows: bodies shadow each other from the sun. */
  eclipse: {
    enabled: true,
    /**
     * Shrinks the sun ONLY for shadow math. At game scale the Moon's umbra would not reach Earth
     * (annular eclipses only); 0.45 makes total solar eclipses happen. 1 is the true size.
     */
    sunSizeScale: 0.45,
    /** Occluding spheres per frame (the shader arrays hold at most 4). */
    maxOccluders: 4,
    /** Sunlight colour left inside the shadow of a body with an atmosphere (lunar eclipse copper). */
    umbraTint: [1.0, 0.3, 0.1] as [number, number, number],
    umbraStrength: 0.22,
    /** Penumbra edge shape: 1 smooth, above 1 a tighter core, below 1 a longer tail. */
    penumbraSoft: 1,
    /** The visible sun shrinks to the shadow sun while a body crosses it, so the cover is total. */
    discMatch: true,
  },
  debug: {
    showPanel: false,
  },
};

export type Config = typeof config;
