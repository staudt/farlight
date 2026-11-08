import { Vector3 } from 'three';
import { config } from './core/config';
import { SOLAR_SYSTEM } from './data/solarSystem';
import { AudioEngine } from './audio/audio';
import { Input } from './input/input';
import { PostStack } from './render/post';
import { GameRenderer } from './render/renderer';
import { getShake, installShipFx } from './render/fx';
import { createHeightSamplerForBody, createPlanetView, terrainPending } from './terrain';
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios';
import { World } from './sim/world';
import { DebugPanel } from './ui/debugPanel';
import { Hud } from './ui/hud';
import { SystemMap } from './ui/map';
import { SkyLabels } from './ui/skyLabels';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

const world = new World(SOLAR_SYSTEM, 0);
const scenarioName = params.get('scenario') ?? DEFAULT_SCENARIO;
const scenario = SCENARIOS[scenarioName] ?? SCENARIOS[DEFAULT_SCENARIO]!;
world.setHeightProvider((b) => createHeightSamplerForBody(b)); // terrain: before placement queries ground height
scenario.apply(world);

const audio = new AudioEngine(world);
const gfx = new GameRenderer(canvas, world, [createPlanetView]); // terrain: chunked planets
installShipFx(gfx);
gfx.cameraShake = getShake;
const post = new PostStack(gfx);
const input = new Input(canvas);
const debug = new DebugPanel(world, gfx, (name) => SCENARIOS[name]?.apply(world));
if (params.has('debug')) debug.toggle();
const atmoFolder = debug.folder('Atmosphere and post');
atmoFolder.add(post.atmosphere, 'intensity', 0, 3).name('scatter intensity');
atmoFolder.add(post.bloom, 'intensity', 0, 3).name('bloom');
atmoFolder.add(post.clouds, 'coverageBias', -0.5, 0.5).name('cloud coverage');
atmoFolder.add(post.clouds, 'sunIntensity', 0, 5).name('cloud light');
const audioFolder = debug.folder('Audio');
for (const k of Object.keys(audio.tuning) as (keyof typeof audio.tuning)[]) audioFolder.add(audio.tuning, k, 0, 2);

input.on('warpUp', () => world.clock.step(1));
input.on('warpDown', () => world.clock.step(-1));
input.on('camera', () => gfx.shipCamera.toggle());
input.on('debug', () => debug.toggle());
const hud = new Hud(document.getElementById('hud')!, world, gfx, input);
const systemMap = new SystemMap(document.getElementById('map')!, world, input);
const skyLabels = new SkyLabels(document.getElementById('hud')!, world, gfx);

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
  post,
  config,
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
