import type { GalaxyDef } from '../data/galaxy';
import { generateSystem } from '../data/generate';
import { loadProgress, surveyKey, surveyProgress } from '../sim/survey';
import type { World } from '../sim/world';
import { escapeHtml, noDashes } from './format';
import { STAR_COLORS } from './galaxyPaint';
import './journal.css';

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#5ff2ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l5 5L20 6"/></svg>';

export interface JournalOptions {
  currentId: string;
  /** Tapping another system opens it in the galaxy map. */
  onSelectSystem: (id: string) => void;
  /** Tapping a body of the current system targets it and closes the journal. */
  onTargetBody: () => void;
}

/** Visited systems with survey progress and their bodies. */
export class Journal {
  private readonly scroll: HTMLElement;
  private active = false;

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly galaxy: GalaxyDef,
    private readonly opts: JournalOptions,
  ) {
    root.innerHTML = `<div class="jr-scroll"><div class="jr-col"></div></div>`;
    this.scroll = root.querySelector('.jr-scroll') as HTMLElement;
    root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.scroll.addEventListener('click', (e) => this.onClick(e));
  }

  setActive(v: boolean): void {
    this.active = v;
    if (v) this.render();
  }

  /** Re-render if showing (a body was surveyed while open). */
  refresh(): void {
    if (this.active) this.render();
  }

  private render(): void {
    const progress = loadProgress();
    const cur = this.opts.currentId;
    const ids = [cur, ...progress.visited.filter((id) => id !== cur)];
    const col = this.scroll.querySelector('.jr-col') as HTMLElement;
    const parts: string[] = [];
    for (const id of ids) {
      const star = this.galaxy.stars.find((s) => s.id === id);
      if (!star) continue;
      const here = id === cur;
      const bodies = here ? this.world.universe.bodies.filter((b) => b.kind !== 'star').map((b) => ({ id: b.id, name: b.name })) : generateSystem(star).bodies.filter((b) => b.kind !== 'star').map((b) => ({ id: b.id, name: b.name }));
      const prog = surveyProgress(progress, id, bodies.map((b) => b.id));
      const pct = Math.round(prog.fraction * 100);
      const done = new Set(progress.surveyed);
      parts.push(`
        <section class="jr-sys${here ? ' here' : ''}" data-sys="${escapeHtml(id)}">
          <div class="jr-head" data-sys-head="${escapeHtml(id)}">
            <span class="jr-dot" style="background:${STAR_COLORS[star.starClass]};box-shadow:0 0 10px ${STAR_COLORS[star.starClass]}"></span>
            <div class="jr-title"><b>${escapeHtml(noDashes(star.name).toUpperCase())}</b><span>${here ? 'YOU ARE HERE · ' : ''}CLASS ${star.starClass} · ${star.planetCount} PLANETS</span></div>
            <div class="jr-prog"><div>SURVEYED <b>${prog.done}/${prog.total}</b></div><div class="gm-bar"><i style="width:${pct}%"></i></div></div>
          </div>
          <div class="jr-bodies">${bodies
            .map((b) => {
              const ok = done.has(surveyKey(id, b.id));
              return `<button type="button" class="jr-body${ok ? ' done' : ''}${here ? ' tap' : ''}" ${here ? `data-body="${escapeHtml(b.id)}"` : 'tabindex="-1"'}>${ok ? CHECK : '<i class="box"></i>'}<span>${escapeHtml(noDashes(b.name))}</span></button>`;
            })
            .join('')}</div>
        </section>`);
    }
    col.innerHTML = parts.length ? parts.join('') : `<div class="jr-empty">NOTHING LOGGED YET</div>`;
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const bodyEl = t.closest<HTMLElement>('[data-body]');
    if (bodyEl) {
      const b = this.world.universe.bodies.find((x) => x.id === bodyEl.dataset.body);
      if (b) {
        this.world.target = b;
        this.opts.onTargetBody();
      }
      return;
    }
    const head = t.closest<HTMLElement>('[data-sys-head]');
    if (head) {
      const id = head.dataset.sysHead as string;
      if (id !== this.opts.currentId) this.opts.onSelectSystem(id);
    }
  }
}
