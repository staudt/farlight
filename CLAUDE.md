# Farlight

## What it is
Farlight is a relaxed solar system glider (working title was Space Glider 3D). Launch from a planet, glide through its atmosphere, look at the sky and the other bodies, and use time warp for distance. Feel beats accuracy. The ship is an assisted glider, not a simulator. This is the successor to `staudt/spaceglider` (Canvas 2D). The approved plan, with milestones and the feel checklist, is at `/home/ricardo/.claude/plans/let-s-plan-a-space-floofy-pebble.md`.

**Stack:** Vite, TypeScript (strict), Three.js (WebGLRenderer with custom GLSL ShaderMaterials), pmndrs `postprocessing`, `lil-gui`, Rajdhani via `@fontsource`, procedural Web Audio, Web Workers for terrain, vitest, eslint, and playwright-core for the smoke test. Deploys to GitHub Pages.

## Commands
- `npm run dev`: Vite dev server.
- `npm run check`: typecheck, lint (`--max-warnings=0`), vitest, build. Must pass before a stop.
- `npm test`: vitest only. `npm run typecheck`, `npm run lint`, `npm run build`, `npm run preview` do what they say.
- `npm run smoke`: builds, then loads each scenario in headless Chromium and checks it. Pass flags after `--`:
  - Scenario names as positional args. None means all of them.
  - `--no-build`: skip the vite build and use the existing `dist`.
  - `--wait=ms`: settle time after the game reports ready (default 2500).
  - Example: `npm run smoke -- earth-orbit --no-build --wait=4000`
  - Output: `artifacts/smoke/<scenario>.png` and `artifacts/smoke/summary.json`. Exit code 1 on failure.
  - Checks: no console or page errors, frame not black and not uniform, loop running (more than 20 frames), no pending async content after 20 s, and any `expect` problems the game reports.
- URL params: `?scenario=name` starts from a preset in `src/scenarios.ts`. `?debug` is the debug mode. **F3** toggles the debug panel (lil-gui).
- Scenarios: `earth-low-morning` (default), `earth-surface-day`, `earth-surface-night`, `earth-sunset`, `atmo-entry`, `earth-orbit`, `moon-surface-earthrise`, `deep-space-warp`.

## Quick reference
- **Controls:** mouse joystick for pitch and yaw. A / D roll. W / S and wheel throttle. Shift boost. X stop. `,` / `.` warp down and up. C camera toggle (chase and cockpit). M system map. T cycle targets. H hide HUD. F3 debug panel. Hold F to align to target.
- **Flight:** the ship flies where it points. Throttle sets a target speed as a fraction of a speed cap (distance to the nearest surface / `impactTime` 8 s, floor 160 m/s, ceiling 1000 km/s); boost multiplies it by 4. Feel targets (asserted in `tests/travel.test.ts`): Earth orbit to the Moon in about 30 s boosted, a quarter of Earth in about 85 s cruising at 25 km, low flight under 1 km/s. In air, attitude and velocity are carried around the curvature so level flight holds altitude at any speed.
- **Atmosphere assist:** strength scales with density. The ship auto-levels roll and gently pitches to level without input. Soft gravity, and drag bleeds speed toward the local cap.
- **Ground cushion:** below about 200 m the cushion pushes up while keeping tangential speed. The ship never crashes. Landing happens at low speed near the ground.
- **Warp rules:** space warp drops automatically when the ETA to an atmosphere or SOI boundary gets short. In atmosphere, max 4×. Landed or parked, up to 10k× for sunsets and moonrises.
- **Render stack:** scene render with log depth, then the atmosphere post pass (single scattering against the depth buffer, `scene × transmittance + inscatter`), then the postprocessing stack (HDR, ACES, selective bloom, grading, vignette). Every effect is data-driven per body, has a quality toggle, and gets its own lil-gui section.
- **Terrain:** cube-sphere quadtree chunked LOD, 16×16 or 32×32 chunks with skirts against cracks. Workers build heights from `heightfield.ts`. Flat-shaded biome colours. Every chunk is vertex-relative to its own centre.

## Architecture map (`src/`)
- `main.ts`: game loop, fixed-step sim and variable-rate render. Keep edits here minimal (wiring only).
- `core/`: `config.ts` (every tunable), `rng.ts`, `noise.ts`, `vec.ts` (double-precision helpers).
- `data/`: `types.ts` (StarSystemDef, BodyDef schema), `solarSystem.ts` (hand-authored data), `scale.ts` (ScaleProfile and conversions).
- `sim/`: `clock.ts` (sim time and warp levels), `ephemeris.ts` (orbits on rails), `frames.ts` (reference frames, `transferState`), `soi.ts` (sphere of influence), `ship.ts` (flight model), `warp.ts` (warp limits), `universe.ts` (bodies), `world.ts` (owns the sim: step, place, frame management).
- `terrain/`: `heightfield.ts` (shared `heightAt`), `biomes.ts`, `features.ts`, `chunkWorker.ts`, `api.ts`. Pure code shared by the main thread and workers.
- `render/`: `renderer.ts` (GameRenderer, floating origin), `context.ts` (FrameContext, `placeRelative`, apparent size), `bodies/` (quadtree LOD, sun, gas giant, rings), `atmosphere/` (post pass), `weather/`, `camera/` (ship camera), `ship/` (ship model and view), `sky/` (starfield), `fx/` (effects), `dust.ts`.
- `ui/`: `hud.ts` (DOM overlay), `map.ts` (system map), `debugPanel.ts`.
- `input/`: `input.ts` (pointer lock, keys, virtual joystick with deadzone).
- `audio/`: `audio.ts` (procedural engine, wind and drone; starts on first user gesture).
- `tests/`: `*.test.ts` (vitest). `scripts/smoke.mjs`: the headless smoke harness.

## Hard engine rules
- **Floating origin.** The camera always sits at the origin. Each object's render position is `worldPos - cameraWorld`, computed in float64 by `placeRelative` (`render/context.ts`), then handed to float32. Never put a raw world position into a Three object.
- **Sim precision.** The sim is float64 numbers in meters and seconds. Float32 happens only at the render boundary.
- **Log depth.** The renderer uses `logarithmicDepthBuffer: true`. Every custom ShaderMaterial must include the logdepthbuf chunks (vertex and fragment). The atmosphere post pass must linearize log depth with its helper.
- **Ship convention.** Forward is -Z, up is +Y in ship local space. Models, cameras and `lookAt` calls follow this.
- **Reference frames.** `ship.frame` is `{ body, rotating }`:
  - Inertial (`rotating: false`) in deep space and inside a body's sphere of influence.
  - Body-fixed rotating inside the near zone of a body, so parked ships and terrain don't slide at high warp.
  - Frame changes go through `World` frame management, which calls `transferState` in `frames.ts`. It converts velocity as `v_rot = v_inertial - ω×r`. Never change the frame without it, or the ship will jump.
- **Time.** Rotation (turning, attitude) uses real dt, so steering feels the same at any warp. Translation uses sim dt, so warp moves you. Warp levels are `config.warp.levels` (1, 2, 4, 10, 100, 1k, 10k, 100k). Warp limits come from `allowedWarp(phase, eta)` in `warp.ts`.
- **Config.** All tunables live in `src/core/config.ts`. Read them at use time (`config.x.y` inside the function), never copied into a module-level constant, so lil-gui edits apply live. Scale and speed numbers also live in `ScaleProfile`.
- **Tuning is live.** Every new tunable should show up in the debug panel.

## Data rules
- **Every body comes from `StarSystemDef` / `BodyDef`.** Sim and render consume only scaled `BodyDef`s. Never special-case a body by id or name. Behaviour comes from fields (`kind`, `atmosphere`, `terrain`, `gas`, `rings`, `star`). Scenario placements may name ids because they are data.
- **Procedural-ready.** `generateSystem(seed)` must later produce the same shape. Don't add fields that only hand-authored data would use.
- **Real values plus artistic overrides.**
  - `physical` and `orbit` hold real values: meters, seconds, radians.
  - `visual` holds game-meter overrides (`radius`, `orbitDistance`, `soiFactor`). Overrides always win over the scaled value.
  - Colours are linear RGB 0..1.
- **Fractions, not meters.** Atmosphere height, terrain amplitude, cloud altitude and thickness, and feature sizes are fractions of the body's game radius. Ring radii are multiples of the planet radius. This keeps them valid under any scale profile.
- **Scale profile** (`data/scale.ts`, `DEFAULT_SCALE`): planet and moon radius ×0.1, Sun radius ×0.005, planet orbits ×0.001, moon orbits compressed in parent radii (linear up to 4, then exponent 0.7). Fix proportions here or in config, not with per-body hacks.
- **Minimum apparent size.** Every body has an angular size floor that scales with its radius (`minApparentSizeFor` in `scale.ts`: 0.7° for Earth, bigger for gas giants, smaller for moons; `visual.minApparentSize` overrides). Below it, draw a shaded impostor disc with colour, phase and halo. Blend into the true mesh as the body grows.

## Testing loop
- **PostToolUse** (`.claude/hooks/post-edit.sh`, on Edit, Write and MultiEdit of `.ts` or `.mjs`): incremental `tsc --noEmit`, and eslint for files in `src/` and `tests/`. Errors go straight back to the editing agent (exit 2).
- **Stop and SubagentStop** (`.claude/hooks/stop-check.sh`):
  - If `src`, `tests`, `scripts`, `index.html` or `package.json` changed, runs `npm run check`.
  - If `src/render`, `src/terrain`, `src/main.ts` or `src/scenarios.ts` changed, also runs the smoke test on a core set of 8 scenarios (300 s timeout). Run your feature's scenarios yourself, and `npm run smoke` for everything. Screenshot names replace `-` with `_`.
  - Failure blocks the stop (exit 2) with the tail of the output.
  - **Loop guard:** after 3 consecutive failures the stop is let through with a warning. Stamp files live in `.claude/hooks/.state/`.
- **Look at the screenshots.** After a render change, open `artifacts/smoke/*.png` and check them yourself. The non-black and non-uniform checks catch blank frames, not wrong looks. Read `summary.json` for the state of each scenario.
- **New visual features need a scenario.** Add a preset to `src/scenarios.ts` that frames the feature, with a clear `description`. Existing names are asserted by the smoke test, so keep them stable.
- **Unit tests** (vitest) cover the pure logic: scale conversion, ephemeris at known times, frame round trips with no velocity jump, heightfield determinism between worker and main, and the warp rule state machine.
- **Feel checklist** (M1 exit): on Earth by day the Moon shows in a blue sky, and at night stars appear. A full-boost climb to space takes about 30 to 60 s with a clear colour transition. From orbit Earth shows curvature and a blue rim. The Moon is reached in about 30 s at 1k warp. Parking on the Moon at warp shows Earth rising.

## Agent workflow
- **Opus** orchestrates and reviews. It writes the schema, interfaces and briefs, reviews every agent diff, and personally writes the hardest core: atmosphere and cloud shaders, frame transitions, the floating origin.
- **Sonnet** implements most modules, one brief per module. Each brief has the interface contract (types), the files it owns, the acceptance tests and a do-not-touch list. Independent modules run in parallel, in separate worktrees when they touch shared files.
- **Haiku** does trivial work: scaffolding, config files, body data entry, boilerplate tests, docs and lint fixes.
- Two agents never edit the same file. Keep `main.ts` edits minimal. Put logic in its module and wire it in.

## Common pitfalls
- **Jitter at the surface:** usually a raw world position reaching a Three object, or a chunk built with absolute coordinates. Route it through `placeRelative` and chunk-local vertices.
- **Terrain cracks:** check the skirts before blaming the LOD split.
- **Log depth bugs:** a custom shader missing the logdepth chunks shows up as depth fighting or objects drawn through each other. Check the chunks first.
- **Warp overshoot:** an approach at high warp that misses the target means the ETA drop or the sweep collision is wrong, not the feel numbers.
- **Worker and main thread disagree:** terrain heights must come from the same `heightAt` code. A seed mismatch is a bug, so the determinism test should fail.
- **Edits that break `check` silently:** the Stop hook only runs `check` when files in its list changed. After touching `package.json` or `index.html`, run `npm run check` yourself.

## Project rules (carried over from spaceglider)
- **No dashes in UI text.** Keep on-screen text minimal. Less text is better.
- **Small, clean commits.** One concern per commit. Commit only when asked.
- **Config first.** Add the tunable to `config.ts` before the code that uses it.
- **Simplicity and feel over accuracy.** Proportions, speeds and timings are tuned for the feel.
- **No complex systems unless the illusion needs them.** Prefer a cheap trick that reads well over a faithful simulation.

## Atmosphere pass notes
- `src/render/atmosphere/` is a post effect reading the RAW log depth (`texture2D(depthBuffer, uv).r`, decoded with `uLogFar`), not postprocessing's converted depth (which loses precision at far = 1e11).
- Unproject view rays at the NEAR plane; the far plane overflows float32.
- One NaN pixel turns the whole frame black through bloom. If the smoke test reports a black frame with no console errors, suspect NaN in a post shader.
- Smoke tests pick a free port; never hardcode preview ports (parallel agents collide).
- Effects merged into one EffectPass share a shader: prefix every #define (ATMO_, CLOUD_).
