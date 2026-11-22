import GUI from 'lil-gui';
import { config } from '../core/config';
import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';
import { SCENARIOS } from '../scenarios';
import type { PerfStats } from '../render/perf';
import { quality, QUALITY_LEVELS, type QualityPreset } from '../render/quality';

/** F3 tuning panel: live edits to `config`, scenario jumps and state readouts. */
export class DebugPanel {
  readonly gui: GUI;
  private readout = {
    body: '',
    frame: '',
    phase: '',
    altitude: 0,
    speed: 0,
    cap: 0,
    density: 0,
    warp: 1,
  };
  private perf: PerfStats | null = null;
  private perfReadout = { drawCalls: 0, triangles: 0, cpuMs: 0, gpuMs: 0, level: '', profileStages: false, stages: '' };

  constructor(private world: World, gfx: GameRenderer, jump: (name: string) => void) {
    this.gui = new GUI({ title: 'Farlight debug' });
    this.gui.hide();

    const state = this.gui.addFolder('State');
    for (const k of Object.keys(this.readout) as (keyof typeof this.readout)[]) state.add(this.readout, k).listen().disable();

    const sc = { scenario: '' };
    this.gui
      .add(sc, 'scenario', Object.keys(SCENARIOS))
      .name('Jump to')
      .onChange((v: string) => jump(v));

    const flight = this.gui.addFolder('Flight').close();
    flight.add(config.flight, 'impactTime', 0.5, 15);
    flight.add(config.flight, 'minSpeedCap', 40, 2000);
    flight.add(config.flight, 'maxSpeedCap', 4000, 400000);
    flight.add(config.flight, 'boostMultiplier', 1, 5);
    flight.add(config.flight, 'accelTau', 0.1, 5);
    flight.add(config.flight, 'pitchRate', 0.1, 3);
    flight.add(config.flight, 'yawRate', 0.1, 3);
    flight.add(config.flight, 'rollRate', 0.1, 4);
    flight.add(config.flight, 'levelRollRate', 0, 3);
    flight.add(config.flight, 'levelPitchRate', 0, 1);
    flight.add(config.flight, 'bankAngle', 0, 1.2);
    flight.add(config.flight, 'cushionHeight', 20, 1000);
    flight.add(config.flight, 'cushionLead', 0, 1);
    flight.add(config.flight, 'sinkTau', 0.1, 3);
    const land = this.gui.addFolder('Terrain look').close();
    land.add(config.terrain, 'facetValue', 0, 0.5);
    land.add(config.terrain, 'facetHue', 0, 0.3);
    land.add(config.terrain, 'patch', 0, 0.3);
    land.add(config.terrain, 'rockSlope', 0.2, 1.2);
    land.add(config.terrain, 'rock', 0, 1);
    land.add(config.terrain, 'strata', 0, 1);
    land.add(config.terrain, 'strataPeriod', 0.001, 0.03);
    land.add(config.terrain, 'ao', 0, 2);
    land.add(config.terrain, 'ridge', 0, 2);
    land.add(config.terrain, 'rim', 0, 0.4);
    land.add(config.terrain, 'mist', 0, 2);
    land.add(config.terrain, 'mistTop', 0.01, 0.3);
    land.add(config.terrain, 'mistDensity', 0, 3);
    land.add(config.terrain, 'clutter');
    land.add(config.terrain, 'clutterNear', 20, 600);
    land.add(config.terrain, 'clutterFar', 40, 900);
    const props = this.gui.addFolder('Props').close();
    props.add(config.props, 'enabled');
    props.add(config.props, 'fadeNear', 100, 5000);
    props.add(config.props, 'fadeFar', 200, 8000);
    props.add(config.props, 'lodNear', 0, 3000);
    props.add(config.props, 'emissive', 0, 8);
    props.add(config.props, 'nightAmbient', 0, 0.3);
    props.add(config.props, 'nightGlow', 0, 4);
    const night = this.gui.addFolder('Night').close();
    night.add(config.night, 'enabled');
    night.add(config.night, 'moonLight', 0, 3);
    night.add(config.night, 'moonStrength', 0, 0.6);
    night.add(config.night, 'purkinje', 0, 1);
    night.add(config.night, 'moonSky', 0, 3);
    night.add(config.night, 'starWash', 0, 1);
    night.add(config.night, 'milkyWay', 0, 4);
    night.add(config.night, 'twinkle', 0, 2);
    night.add(config.night, 'zodiacal', 0, 3);
    night.add(config.night, 'airglow', 0, 4);
    night.add(config.night, 'twilightBand', 0, 4);
    const rg = this.gui.addFolder('Rings').close();
    rg.add(config.rings, 'detail', 0, 2);
    rg.add(config.rings, 'octaves', 3, 9, 1);
    rg.add(config.rings, 'spokes', 0, 2);
    rg.add(config.rings, 'forward', 0, 3);
    rg.add(config.rings, 'opposition', 0, 3);
    rg.add(config.rings, 'unlit', 0, 3);
    rg.add(config.rings, 'edgePx', 0, 4);
    rg.add(config.rings, 'debris');
    rg.add(config.rings, 'thickness', 20, 2000);
    rg.add(config.rings, 'density', 0, 3);
    rg.add(config.rings, 'sizeScale', 0.2, 4);
    rg.add(config.rings, 'range', 0.3, 2);
    rg.add(config.rings, 'fadeHeight', 1, 60);
    rg.add(config.rings, 'fadeDepth', 0, 1);
    rg.add(config.rings, 'fadeNear', 10, 2000);
    rg.add(config.rings, 'fadeFar', 100, 6000);
    rg.add(config.rings, 'rockBrightness', 0, 3);
    rg.add(config.rings, 'rockAmbient', 0, 0.5);
    const ecl = this.gui.addFolder('Eclipse').close();
    const gg = this.gui.addFolder('Gas giants').close();
    gg.add(config.gasGiant, 'flowSpeed', 0, 5);
    gg.add(config.gasGiant, 'curls', 0, 2);
    gg.add(config.gasGiant, 'subBands', 0, 2);
    gg.add(config.gasGiant, 'ovals', 0, 2);
    gg.add(config.gasGiant, 'polar', 0, 2);
    gg.add(config.gasGiant, 'limbGlow', 0, 1.5);
    gg.add(config.gasGiant, 'terminatorWarm', 0, 1);
    ecl.add(config.eclipse, 'enabled');
    ecl.add(config.eclipse, 'sunSizeScale', 0.1, 1).name('sun size (shadows)');
    ecl.add(config.eclipse, 'maxOccluders', 0, 4, 1);
    ecl.add(config.eclipse, 'umbraStrength', 0, 0.5);
    ecl.addColor(config.eclipse, 'umbraTint');
    ecl.add(config.eclipse, 'penumbraSoft', 0.3, 3);
    ecl.add(config.eclipse, 'discMatch').name('shrink sun disc');
    const lm = this.gui.addFolder('Landmarks').close();
    lm.add(config.landmarks, 'enabled');
    lm.add(config.landmarks, 'discoverRadius', 100, 20000);
    lm.add(config.landmarks, 'discoverAltitude', 100, 50000);
    lm.add(config.landmarks, 'landedRadius', 100, 30000);
    lm.add(config.landmarks, 'markerRange', 10000, 2000000);
    lm.add(config.landmarks, 'buildRange', 5000, 500000);
    lm.add(config.landmarks, 'drawRange', 5000, 600000);
    lm.add(config.landmarks, 'glow', 0, 5);

    const touch = this.gui.addFolder('Touch').close();
    touch.add(config.touch, 'stickRadius', 30, 120);
    touch.add(config.touch, 'deadzone', 0, 0.4);
    touch.add(config.touch, 'spaceRoll', 0, 1);
    touch.add(config.touch, 'invertPitch');
    touch.add(config.touch, 'cardSeconds', 2, 30);
    touch.add(config.touch, 'lookScale', 0.2, 4);
    touch.add(config.touch, 'tiltRange', 8, 45);
    touch.add(config.touch, 'tiltDeadzone', 0, 0.4);
    touch.add(config.touch, 'idleOpacity', 0.1, 1);

    const cam = this.gui.addFolder('Camera').close();
    const pad = this.gui.addFolder('Gamepad and photo');
    pad.add(config.gamepad, 'deadzone', 0, 0.5);
    pad.add(config.gamepad, 'invertPitch');
    pad.add(config.gamepad, 'lookSpeed', 100, 1000);
    pad.add(config.photo, 'orbitSpeed', 0.001, 0.02);
    pad.add(config.photo, 'wheelZoom', 1, 20);
    pad.add(config.photo, 'panSpeed', 0.1, 2);
    pad.add(config.photo, 'panelHide', 0.5, 10);
    cam.add(config.camera, 'fov', 30, 100);
    cam.add(config.camera, 'chaseDistance', 5, 150);
    cam.add(config.camera, 'chaseHeight', 0, 40);
    cam.add(config.camera, 'rotationLag', 0.01, 1);
    cam.add(config.camera, 'horizonUpBlend', 0, 1);

    this.addQualityFolder();
    const render = this.gui.addFolder('Render').close();
    render.add(gfx.renderer, 'toneMappingExposure', 0.1, 4).name('exposure');
    render.add(config.render, 'atmoAdaptive', 0, 2).name('atmo adaptive steps');
  }

  private addQualityFolder(): void {
    const f = this.gui.addFolder('Quality').close();
    const state = { preset: quality.preset as QualityPreset };
    f.add(state, 'preset', ['auto', ...QUALITY_LEVELS]).onChange((v: QualityPreset) => quality.setPreset(v, document.body.classList.contains('touch')));
    f.add(config.quality, 'downFps', 20, 60).name('auto down fps');
    f.add(config.quality, 'upFps', 40, 120).name('auto up fps');
    for (const name of QUALITY_LEVELS) {
      const p = f.addFolder(name).close();
      const s = config.quality.presets[name];
      const apply = (): void => quality.notify();
      p.add(s, 'pixelRatioMax', 0.5, 2).onChange(apply);
      p.add(s, 'msaa', [0, 2, 4]).onChange(apply);
      p.add(s, 'fxaa').onChange(apply);
      p.add(s, 'volScale', 0.25, 1).onChange(apply);
      p.add(s, 'cloudSteps', 8, 30, 1).onChange(apply);
      p.add(s, 'cloudLight', 1, 3, 1).onChange(apply);
      p.add(s, 'atmoSteps', 4, 14, 1).onChange(apply);
      p.add(s, 'atmoLight', 1, 5, 1).onChange(apply);
      p.add(s, 'cloudShadows').onChange(apply);
      p.add(s, 'bloom').onChange(apply);
      p.add(s, 'bloomLevels', 1, 8, 1).onChange(apply);
      p.add(s, 'splitFactor', 0.4, 1.5).onChange(apply);
      p.add(s, 'gasOctaves', 1, 4, 1).onChange(apply);
      p.add(s, 'maxChunks', 200, 6000, 50).onChange(apply);
      p.add(s, 'maxInFlight', 0, 24, 1).onChange(apply);
      p.add(s, 'propRange', 0.2, 1.5).onChange(apply);
      p.add(s, 'propLevels', 1, 3, 1).onChange(apply);
      p.add(s, 'shimmer').onChange(apply);
      p.add(s, 'godRaySamples', 0, 48, 1).onChange(apply);
      p.add(s, 'godRayScale', 0.15, 0.6).onChange(apply);
      p.add(s, 'lensFlare').onChange(apply);
      p.add(s, 'fxScale', 0, 1).onChange(apply);
    }
    const perf = this.gui.addFolder('Perf').close();
    for (const k of ['drawCalls', 'triangles', 'cpuMs', 'gpuMs', 'level'] as const) perf.add(this.perfReadout, k).listen().disable();
    perf.add(this.perfReadout, 'profileStages').name('per stage timing').onChange((v: boolean) => this.perf?.setProfile(v));
    perf.add(this.perfReadout, 'stages').listen().disable();
  }

  /** Hooks up the render stats readout (frame time split uses GPU timer queries when available). */
  addPerf(perf: PerfStats): void {
    this.perf = perf;
  }

  /** Lets other modules add their own tuning folders. */
  folder(name: string): GUI {
    return this.gui.addFolder(name).close();
  }

  toggle(): void {
    if (this.gui._hidden) this.gui.show();
    else this.gui.hide();
  }

  update(): void {
    if (this.gui._hidden) return;
    if (this.perf) {
      const pr = this.perfReadout;
      pr.drawCalls = this.perf.calls;
      pr.triangles = this.perf.triangles;
      pr.cpuMs = Number(this.perf.cpuMs.toFixed(2));
      pr.gpuMs = this.perf.gpuSupported ? Number(this.perf.gpuMs.toFixed(2)) : -1;
      pr.level = quality.label;
      if (this.perf.profile) {
        pr.stages = Object.entries(this.perf.passes)
          .filter(([, v]) => v.ms > 0)
          .map(([k, v]) => `${k} ${v.ms.toFixed(1)}`)
          .join(' ');
      }
    }
    const w = this.world;
    const r = this.readout;
    r.body = w.ship.frame.body.name;
    r.frame = w.ship.frame.rotating ? 'rotating' : 'inertial';
    r.phase = w.phase;
    r.altitude = Math.round(w.env.altitude);
    r.speed = Math.round(w.ship.speed);
    r.cap = Math.round(w.ship.speedCap);
    r.density = Number(w.env.density.toFixed(4));
    r.warp = w.clock.warp;
  }
}
