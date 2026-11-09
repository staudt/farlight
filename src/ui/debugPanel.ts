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
  private perfReadout = { drawCalls: 0, triangles: 0, cpuMs: 0, gpuMs: 0, level: '' };

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
    flight.add(config.flight, 'impactTime', 2, 60);
    flight.add(config.flight, 'minSpeedCap', 10, 500);
    flight.add(config.flight, 'maxSpeedCap', 1000, 100000);
    flight.add(config.flight, 'boostMultiplier', 1, 5);
    flight.add(config.flight, 'accelTau', 0.1, 5);
    flight.add(config.flight, 'pitchRate', 0.1, 3);
    flight.add(config.flight, 'yawRate', 0.1, 3);
    flight.add(config.flight, 'rollRate', 0.1, 4);
    flight.add(config.flight, 'levelRollRate', 0, 3);
    flight.add(config.flight, 'levelPitchRate', 0, 1);
    flight.add(config.flight, 'bankAngle', 0, 1.2);
    flight.add(config.flight, 'cushionHeight', 20, 1000);
    const props = this.gui.addFolder('Props').close();
    props.add(config.props, 'enabled');
    props.add(config.props, 'fadeNear', 100, 5000);
    props.add(config.props, 'fadeFar', 200, 8000);
    props.add(config.props, 'emissive', 0, 8);

    const touch = this.gui.addFolder('Touch').close();
    touch.add(config.touch, 'stickRadius', 30, 120);
    touch.add(config.touch, 'deadzone', 0, 0.4);
    touch.add(config.touch, 'spaceRoll', 0, 1);
    touch.add(config.touch, 'invertPitch');
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
    }
    const perf = this.gui.addFolder('Perf').close();
    for (const k of Object.keys(this.perfReadout) as (keyof typeof this.perfReadout)[]) perf.add(this.perfReadout, k).listen().disable();
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
