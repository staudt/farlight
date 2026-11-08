import GUI from 'lil-gui';
import { config } from '../core/config';
import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';
import { SCENARIOS } from '../scenarios';

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

  constructor(private world: World, gfx: GameRenderer, jump: (name: string) => void) {
    this.gui = new GUI({ title: 'Space Glider debug' });
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

    const cam = this.gui.addFolder('Camera').close();
    cam.add(config.camera, 'fov', 30, 100);
    cam.add(config.camera, 'chaseDistance', 5, 150);
    cam.add(config.camera, 'chaseHeight', 0, 40);
    cam.add(config.camera, 'rotationLag', 0.01, 1);
    cam.add(config.camera, 'horizonUpBlend', 0, 1);

    const render = this.gui.addFolder('Render').close();
    render.add(gfx.renderer, 'toneMappingExposure', 0.1, 4).name('exposure');
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
