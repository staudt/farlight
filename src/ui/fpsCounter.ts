/** Small frame rate readout in the top left corner. Lives in the HUD root, so H hides it too. */
export class FpsCounter {
  private readonly el: HTMLElement;
  private acc = 0;
  private frames = 0;
  private worst = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'absolute',
      top: '10px',
      left: '14px',
      font: '500 11px Rajdhani, sans-serif',
      letterSpacing: '0.22em',
      color: 'rgba(150, 230, 255, 0.7)',
      pointerEvents: 'none',
      fontVariantNumeric: 'tabular-nums',
    });
    root.appendChild(this.el);
  }

  /** Call once per frame with the real frame time in seconds. */
  update(realDt: number): void {
    if (!(realDt > 0)) return;
    this.acc += realDt;
    this.frames++;
    this.worst = Math.max(this.worst, realDt);
    if (this.acc < 0.5) return;
    const fps = this.frames / this.acc;
    const low = 1 / this.worst;
    this.el.textContent = `${Math.round(fps)} FPS  ·  LOW ${Math.round(low)}`;
    this.el.style.color = fps >= 50 ? 'rgba(150, 230, 255, 0.7)' : fps >= 30 ? 'rgba(255, 220, 140, 0.8)' : 'rgba(255, 140, 120, 0.85)';
    this.acc = 0;
    this.frames = 0;
    this.worst = 0;
  }
}
