import { Vector3 } from 'three';
import { config } from './core/config';
import { SOLAR_SYSTEM } from './data/solarSystem';
import { Input } from './input/input';
import { GameRenderer } from './render/renderer';
import { installShipFx } from './render/fx';
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios';
import { World } from './sim/world';
import { DebugPanel } from './ui/debugPanel';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

const world = new World(SOLAR_SYSTEM, 0);
const scenarioName = params.get('scenario') ?? DEFAULT_SCENARIO;
const scenario = SCENARIOS[scenarioName] ?? SCENARIOS[DEFAULT_SCENARIO]!;
scenario.apply(world);

const gfx = new GameRenderer(canvas, world);
installShipFx(gfx);
const input = new Input(canvas);
const debug = new DebugPanel(world, gfx, (name) => SCENARIOS[name]?.apply(world));
if (params.has('debug')) debug.toggle();

input.on('warpUp', () => world.clock.step(1));
input.on('warpDown', () => world.clock.step(-1));
input.on('camera', () => gfx.shipCamera.toggle());
input.on('debug', () => debug.toggle());
input.on('target', () => {
  const bodies = world.universe.bodies;
  const idx = world.target ? bodies.indexOf(world.target) : -1;
  world.target = bodies[(idx + 1) % bodies.length] ?? null;
});

const alignDir = new Vector3();
let last = performance.now();
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 60;
let frameCount = 0;

function frame(now: number): void {
  const realDt = Math.min(0.1, (now - last) / 1000);
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
  gfx.render(world, realDt);
  debug.update();

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
  gfx,
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
    ready: frameCount > 10,
  }),
};
