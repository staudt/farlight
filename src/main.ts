import { Vector3 } from 'three';
import { config } from './core/config';
import { createGalaxy, generateSystem } from './data/generate';
import { AudioEngine } from './audio/audio';
import { Input } from './input/input';
import { GamepadControls, type PadMode } from './input/gamepad';
import { detectTouch, TouchControls } from './input/touch';
import { PostStack } from './render/post';
import { quality } from './render/quality';
import { warmUp } from './render/warmup';
import { createGasGiantView } from './render/bodies';
import { GameRenderer } from './render/renderer';
import { getShake, installShipFx } from './render/fx';
import { createHeightSamplerForBody, createPlanetView, loadTerrainData, terrainPending } from './terrain';
import { installWeather, weatherSettings } from './render/weather';
import { lifeSettings } from './render/life/settings';
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios';
import { World } from './sim/world';
import { DebugPanel } from './ui/debugPanel';
import { Hud } from './ui/hud';
import { SystemMap } from './ui/map';
import { GalaxyMap } from './ui/galaxyMap';
import { Journal } from './ui/journal';
import { MapOverlay } from './ui/mapOverlay';
import { clearProgress, DiscoveryTracker, markVisited, SurveyTracker } from './sim/survey';
import { installLandmarks } from './render/landmarks/layer';
import { LandmarkMarkers } from './ui/landmarkMarkers';
import { captureResume, clearResume, loadResume, saveResume } from './sim/resume';
import { SettingsScreen } from './ui/settings';
import { applyConfigSettings, applyDomSettings, settings } from './ui/settingsStore';
import { registerServiceWorker } from './pwa';
import { clearPendingJump, Hyperspace, playArrival, readPendingJump } from './render/fx/hyperspace';
import { buildTravelUrl } from './ui/galaxyMath';
import { SkyLabels } from './ui/skyLabels';
import { FpsCounter } from './ui/fpsCounter';
import { Guide } from './ui/guide';
import { PhotoMode, photoEvents, saveFrame } from './ui/photoMode';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const params = new URLSearchParams(location.search);

// Saved settings first: they feed the renderer, input and audio created below.
applyConfigSettings(settings.value);
applyDomSettings(settings.value);
registerServiceWorker();

const touchOn = detectTouch(params);
if (touchOn) {
  document.body.classList.add('touch');
  config.render.pixelRatioMax = Math.min(config.render.pixelRatioMax, config.touch.pixelRatioMax); // before GameRenderer
}

quality.init(params.get('quality') ?? settings.value.quality, touchOn); // before GameRenderer and PostStack

// A reload during a jump lands at the destination.
const pendingJump = readPendingJump();
if (pendingJump && params.get('system') !== pendingJump) {
  location.replace(buildTravelUrl(location.search, pendingJump, location.pathname));
  await new Promise<never>(() => undefined);
}
const arriving = params.has('arrive');
const releaseArrival = params.has('arrive') ? playArrival() : null;
if (params.has('arrive')) {
  clearPendingJump();
  params.delete('arrive');
  const q = params.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
}

// ?system=<id> picks a star from the galaxy; unknown ids fall back to Sol.
const galaxy = createGalaxy();
// Resume the last flight unless the URL asks for somewhere (a scenario, a jump arrival, another system).
const savedFlight = settings.value.resume && !arriving && !pendingJump && !params.has('scenario') ? loadResume() : null;
const resumeFlight = savedFlight && (!params.has('system') || params.get('system') === savedFlight.systemId) ? savedFlight : null;
const galaxyStar =
  galaxy.stars.find((s) => s.id === (params.get('system') ?? resumeFlight?.systemId)) ?? galaxy.stars.find((s) => s.id === galaxy.homeId)!;
const system = generateSystem(galaxyStar);
const inSol = system.id === 'sol';
const world = new World(system, 0);
// Scenarios that name Sol bodies only apply in Sol. Generated systems default to the generic arrival.
const requested = params.get('scenario') ?? (inSol ? DEFAULT_SCENARIO : 'arrival');
const usable = (n: string): boolean => SCENARIOS[n] !== undefined && (inSol || SCENARIOS[n]!.generic === true);
const scenarioName = usable(requested) ? requested : inSol ? DEFAULT_SCENARIO : 'arrival';
const scenario = SCENARIOS[scenarioName]!;
markVisited(system.id);
if (!params.has('arrive') && pendingJump === system.id) clearPendingJump();
world.setHeightProvider((b) => createHeightSamplerForBody(b)); // terrain: before placement queries ground height
await loadTerrainData(world.universe.bodies); // terrain data maps before ground height queries
const resumed = resumeFlight !== null && resumeFlight.systemId === system.id && world.restore(resumeFlight);
if (!resumed) scenario.apply(world);

const audio = new AudioEngine(world);
if (arriving) audio.arrival();
photoEvents.onShutter = () => audio.shutter();
const gfx = new GameRenderer(canvas, world, [createPlanetView, createGasGiantView]); // terrain: chunked planets; gas giants + rings
installShipFx(gfx);
installLandmarks(gfx);
if (resumed) gfx.shipCamera.mode = resumeFlight.cameraMode;
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
debug.addPerf(post.perf);
if (params.has('debug')) debug.toggle();
const atmoFolder = debug.folder('Atmosphere and post');
atmoFolder.add(post.atmosphere, 'intensity', 0, 3).name('scatter intensity');
atmoFolder.add(post.bloom, 'intensity', 0, 3).name('bloom');
atmoFolder.add(post.clouds, 'coverageBias', -0.5, 0.5).name('cloud coverage');
atmoFolder.add(post.clouds, 'sunIntensity', 0, 5).name('cloud light');
gfx.space.addDebug(debug.folder('Space'));
const audioFolder = debug.folder('Audio');
for (const k of Object.keys(audio.tuning) as (keyof typeof audio.tuning)[]) audioFolder.add(audio.tuning, k, 0, 2);
const wxFolder = debug.folder('Weather');
for (const [name, o] of Object.entries(weatherSettings)) {
  const f = wxFolder.addFolder(name);
  f.add(o, 'enabled');
  f.add(o, 'intensity', 0, 3);
  if ('force' in o) f.add(o, 'force');
  for (const [k, v] of Object.entries(o)) {
    if (k === 'enabled' || k === 'intensity' || k === 'force') continue;
    if (typeof v === 'boolean') f.add(o, k as never);
    else if (typeof v === 'number') f.add(o, k as never, 0, 3);
  }
}
wxFolder.add({ strike: () => weather.lightning.strikeNow() }, 'strike');

const lifeFolder = debug.folder('Life');
for (const [k, v] of Object.entries(lifeSettings)) {
  if (typeof v === 'boolean') lifeFolder.add(lifeSettings, k as never);
  else lifeFolder.add(lifeSettings, k as never, 0, k === 'scatterRadius' ? 600 : 3);
}

const photo = new PhotoMode(world, gfx, post, input, system.id);
input.on('warpUp', () => !photo.active && world.clock.step(1));
input.on('warpDown', () => !photo.active && world.clock.step(-1));
input.on('warpSet', () => {
  if (!photo.active) world.clock.warpIndex = world.clock.indexFor(input.warpRequest);
});
input.on('camera', () => !photo.active && gfx.shipCamera.toggle());
input.on('debug', () => debug.toggle());
input.throttleNow = () => world.ship.throttle;
const hud = new Hud(document.getElementById('hud')!, world, gfx, input);
input.on('snapshot', () => {
  if (photo.active) return;
  saveFrame(gfx, world, system.id);
  hud.notify('SNAPSHOT SAVED', '');
});
const overlay = new MapOverlay(document.getElementById('map')!, input);
input.on('back', () => overlay.close());
const padMode = (): PadMode => (photo.active ? 'photo' : overlay.isOpen || settingsScreen.isOpen ? 'overlay' : 'flight');
const gamepad = new GamepadControls(input, { mode: padMode, notify: (a, b) => hud.notify(a, b) });
const systemMap = new SystemMap(overlay.pane('system'), world);
const hyper = new Hyperspace(gfx, input);
hyper.onStart = (seconds) => audio.hyperspaceStart(seconds);
hud.onNotify = (a, b) => audio.onNotify(a, b);
const galaxyMap = new GalaxyMap(overlay.pane('galaxy'), galaxy, {
  currentId: system.id,
  onTravel: (star, _factor, seconds) => {
    overlay.close();
    overlay.locked = true;
    hyper.start(star, seconds);
  },
});
const journal = new Journal(overlay.pane('journal'), world, galaxy, {
  currentId: system.id,
  onSelectSystem: (id) => {
    overlay.open('galaxy');
    galaxyMap.select(id);
    const star = galaxy.stars.find((s) => s.id === id);
    if (star) galaxyMap.centerOn(star, 3);
  },
  onTargetBody: () => overlay.close(),
});
overlay.bind('system', { onShow: () => systemMap.setActive(true), onHide: () => systemMap.setActive(false) });
overlay.bind('galaxy', { onShow: () => galaxyMap.setActive(true), onHide: () => galaxyMap.setActive(false) });
overlay.bind('journal', { onShow: () => journal.setActive(true), onHide: () => journal.setActive(false) });
const survey = new SurveyTracker(world, system.id);
survey.onSurveyed = (body) => {
  hud.notify(body.name, 'SURVEYED');
  journal.refresh();
};
const discovery = new DiscoveryTracker(world);
discovery.onDiscovered = (l) => {
  hud.notify(l.def.name, 'DISCOVERED', l.def.description);
  journal.refresh();
};
const landmarkMarkers = new LandmarkMarkers(document.getElementById('hud')!, world, gfx);
const settingsScreen = new SettingsScreen({
  input,
  audio,
  touchOn,
  onResetProgress: () => {
    clearProgress();
    clearResume();
    survey.reset();
    discovery.reload();
    journal.refresh();
  },
});
// Remember where the ship is: every 5 s, and when the page goes away.
const saveFlight = (): void => {
  if (!settings.value.resume || hyper.active || overlay.locked || photo.active) return;
  saveResume(captureResume(world, system.id, gfx.shipCamera.mode));
};
setInterval(saveFlight, 5000);
window.addEventListener('pagehide', saveFlight);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveFlight();
});
const skyLabels = new SkyLabels(document.getElementById('hud')!, world, gfx);
const fpsCounter = new FpsCounter(document.getElementById('hud')!);

const guide = new Guide(document.getElementById('hud')!, world, {
  blocked: () => overlay.isOpen || overlay.locked || settingsScreen.isOpen || photo.active || hyper.active || hud.hintsVisible,
  device: () => (touchOn ? 'touch' : gamepad.connected ? 'gamepad' : 'keyboard'),
  undiscoveredMarker: () => landmarkMarkers.undiscoveredShown,
});

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
  gamepad.update(realDt);
  const flight = input.poll(realDt);
  if (input.aligning && world.target) {
    alignDir.copy(world.target.position).sub(world.shipWorldPos).normalize();
    flight.alignDir = world.toFrameDir(alignDir, new Vector3());
  }
  const look = input.consumeLook();
  const zoom = input.consumeZoom();
  const cam = gfx.shipCamera;
  cam.lookMode = input.lookMode;
  if (input.lookMode) {
    cam.freeLook = false;
    cam.orbit(look.x, look.y, zoom);
  } else {
    cam.freeLook = input.rightMouse || input.external.pad.look;
    cam.lookYaw = clamp(cam.lookYaw - look.x * 0.004, -Math.PI, Math.PI);
    cam.lookPitch = clamp(cam.lookPitch - look.y * 0.004, -1.3, 1.3);
  }

  photo.tick(realDt, gamepad.frame);
  if (!photo.active) world.step(realDt, flight);
  audio.cockpit = gfx.shipCamera.mode === 'cockpit' && !photo.active;
  audio.setUiOpen(overlay.isOpen || settingsScreen.isOpen);
  audio.update(realDt);
  gfx.render(world, realDt);
  debug.update();
  hud.update(realDt);
  survey.update();
  discovery.update();
  landmarkMarkers.update();
  hyper.update(realDt);
  systemMap.update();
  galaxyMap.update();
  skyLabels.update();
  fpsCounter.update(realDt);
  guide.update(realDt);

  fpsAcc += realDt;
  fpsFrames++;
  frameCount++;
  if (frameCount === 12) releaseArrival?.();
  if (frameCount === 4) void warmUp(gfx, post); // shader warm-up while the title card is up
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
  touch,
  input,
  gamepad,
  photo,
  post,
  quality,
  config,
  system: { id: system.id, name: system.name },
  overlay,
  settings: settingsScreen,
  galaxyMap,
  guide,
  hyper,
  scenarios: Object.keys(SCENARIOS),
  /** Soak test hook: applies a named scenario in place. */
  applyScenario: (name: string) => SCENARIOS[name]?.apply(world),
  galaxy,
  getState: () => ({
    contextLost: gfx.contextLost,
    scenario: resumed ? 'resume' : scenarioName,
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
