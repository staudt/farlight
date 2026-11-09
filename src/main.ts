import { Vector3 } from 'three';
import { config } from './core/config';
import { createGalaxy, generateSystem } from './data/generate';
import { PROGRESS_STORAGE_KEY, type PlayerProgress } from './data/galaxy';
import { AudioEngine } from './audio/audio';
import { Input } from './input/input';
import { detectTouch, TouchControls } from './input/touch';
import { PostStack } from './render/post';
import { createGasGiantView } from './render/bodies';
import { GameRenderer } from './render/renderer';
import { getShake, installShipFx } from './render/fx';
import { createHeightSamplerForBody, createPlanetView, loadTerrainData, terrainPending } from './terrain';
import { auroraSettings, installWeather, lightningSettings, rainSettings, snowSettings } from './render/weather';
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios';
import { World } from './sim/world';
import { DebugPanel } from './ui/debugPanel';
import { Hud } from './ui/hud';
import { SystemMap } from './ui/map';
import { SkyLabels } from './ui/skyLabels';
import { FpsCounter } from './ui/fpsCounter';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

const touchOn = detectTouch(params);
if (touchOn) {
  document.body.classList.add('touch');
  config.render.pixelRatioMax = Math.min(config.render.pixelRatioMax, config.touch.pixelRatioMax); // before GameRenderer
}

// ?system=<id> picks a star from the galaxy; unknown ids fall back to Sol.
const galaxy = createGalaxy();
const galaxyStar = galaxy.stars.find((s) => s.id === params.get('system')) ?? galaxy.stars.find((s) => s.id === galaxy.homeId)!;
const system = generateSystem(galaxyStar);
const inSol = system.id === 'sol';
const world = new World(system, 0);
// Scenarios that name Sol bodies only apply in Sol. Generated systems default to the generic arrival.
const requested = params.get('scenario') ?? (inSol ? DEFAULT_SCENARIO : 'arrival');
const usable = (n: string): boolean => SCENARIOS[n] !== undefined && (inSol || SCENARIOS[n]!.generic === true);
const scenarioName = usable(requested) ? requested : inSol ? DEFAULT_SCENARIO : 'arrival';
const scenario = SCENARIOS[scenarioName]!;
recordVisit(system.id);
world.setHeightProvider((b) => createHeightSamplerForBody(b)); // terrain: before placement queries ground height
await loadTerrainData(world.universe.bodies); // terrain data maps before ground height queries
scenario.apply(world);

const audio = new AudioEngine(world);
const gfx = new GameRenderer(canvas, world, [createPlanetView, createGasGiantView]); // terrain: chunked planets; gas giants + rings
installShipFx(gfx);
gfx.cameraShake = getShake;
const post = new PostStack(gfx);
const weather = installWeather(gfx, post);
weather.lightning.onStrike = (distance) => audio.thunder(distance);
const input = new Input(canvas);
input.touchMode = touchOn;
const touch = touchOn ? new TouchControls(document.getElementById('touch')!, input, world, gfx) : null;
// Title card fades on the first click (or after a while).
const title = document.getElementById('title');
if (!inSol) {
  const tagline = title?.querySelector('p');
  if (tagline) tagline.textContent = `${system.name.toUpperCase()} SYSTEM`;
}
const hideTitle = (): void => title?.classList.add('gone');
canvas.addEventListener('click', hideTitle, { once: true });
if (touchOn) window.addEventListener('pointerdown', hideTitle, { once: true });
setTimeout(hideTitle, 15000);
const debug = new DebugPanel(world, gfx, (name) => SCENARIOS[name]?.apply(world));
if (params.has('debug')) debug.toggle();
const atmoFolder = debug.folder('Atmosphere and post');
atmoFolder.add(post.atmosphere, 'intensity', 0, 3).name('scatter intensity');
atmoFolder.add(post.bloom, 'intensity', 0, 3).name('bloom');
atmoFolder.add(post.clouds, 'coverageBias', -0.5, 0.5).name('cloud coverage');
atmoFolder.add(post.clouds, 'sunIntensity', 0, 5).name('cloud light');
const audioFolder = debug.folder('Audio');
for (const k of Object.keys(audio.tuning) as (keyof typeof audio.tuning)[]) audioFolder.add(audio.tuning, k, 0, 2);
const wxFolder = debug.folder('Weather');
for (const [name, o] of Object.entries({ rain: rainSettings, snow: snowSettings, lightning: lightningSettings, aurora: auroraSettings })) {
  const f = wxFolder.addFolder(name);
  f.add(o, 'enabled');
  f.add(o, 'intensity', 0, 3);
  if ('force' in o) f.add(o, 'force');
}
wxFolder.add({ strike: () => weather.lightning.strikeNow() }, 'strike');

input.on('warpUp', () => world.clock.step(1));
input.on('warpDown', () => world.clock.step(-1));
input.on('camera', () => gfx.shipCamera.toggle());
input.on('debug', () => debug.toggle());
const hud = new Hud(document.getElementById('hud')!, world, gfx, input);
const systemMap = new SystemMap(document.getElementById('map')!, world, input);
const skyLabels = new SkyLabels(document.getElementById('hud')!, world, gfx);
const fpsCounter = new FpsCounter(document.getElementById('hud')!);

const alignDir = new Vector3();
let last = performance.now();
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 60;
let frameCount = 0;

function frame(now: number): void {
  // rAF timestamps can precede the performance.now() taken at load: never go negative.
  const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  touch?.update(realDt);
  const flight = input.poll(realDt);
  if (input.aligning && world.target) {
    alignDir.copy(world.target.position).sub(world.shipWorldPos).normalize();
    flight.alignDir = world.toFrameDir(alignDir, new Vector3());
  }
  const look = input.consumeLook();
  gfx.shipCamera.freeLook = input.rightMouse;
  gfx.shipCamera.lookYaw = clamp(gfx.shipCamera.lookYaw - look.x * 0.004, -Math.PI, Math.PI);
  gfx.shipCamera.lookPitch = clamp(gfx.shipCamera.lookPitch - look.y * 0.004, -1.3, 1.3);

  world.step(realDt, flight);
  audio.update(realDt);
  gfx.render(world, realDt);
  debug.update();
  hud.update(realDt);
  systemMap.update();
  skyLabels.update();
  fpsCounter.update(realDt);

  fpsAcc += realDt;
  fpsFrames++;
  frameCount++;
  if (fpsAcc > 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function recordVisit(id: string): void {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    const progress: PlayerProgress = raw ? (JSON.parse(raw) as PlayerProgress) : { visited: [], surveyed: [] };
    if (!Array.isArray(progress.visited)) progress.visited = [];
    if (!Array.isArray(progress.surveyed)) progress.surveyed = [];
    if (!progress.visited.includes(id)) progress.visited.push(id);
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* storage unavailable: progress is optional */
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Debug and smoke test hook. */
declare global {
  interface Window {
    __game: unknown;
  }
}
window.__game = {
  world,
  audio,
  gfx,
  touch,
  input,
  post,
  config,
  system: { id: system.id, name: system.name },
  scenarios: Object.keys(SCENARIOS),
  getState: () => ({
    scenario: scenarioName,
    frames: frameCount,
    fps,
    body: world.ship.frame.body.name,
    rotatingFrame: world.ship.frame.rotating,
    phase: world.phase,
    altitude: world.env.altitude,
    speed: world.ship.speed,
    warp: world.clock.warp,
    simTime: world.clock.time,
    pending: terrainPending(), // terrain
    ready: frameCount > 10,
  }),
};
