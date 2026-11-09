import type { Input } from '../input/input';
import './mapOverlay.css';

export type MapTab = 'galaxy' | 'system' | 'journal';

const TABS: { id: MapTab; label: string }[] = [
  { id: 'galaxy', label: 'GALAXY' },
  { id: 'system', label: 'SYSTEM' },
  { id: 'journal', label: 'JOURNAL' },
];

export interface TabHandlers {
  onShow(): void;
  onHide(): void;
}

/**
 * Shared full screen overlay with header tabs: GALAXY, SYSTEM, JOURNAL.
 * Owns the `#map` element (touch controls look at its display), the key actions, Escape
 * and pointer lock release. The sim keeps running while it is open.
 */
export class MapOverlay {
  private current: MapTab | null = null;
  private readonly panes = {} as Record<MapTab, HTMLElement>;
  private readonly tabButtons = {} as Record<MapTab, HTMLElement>;
  private readonly handlers: Partial<Record<MapTab, TabHandlers>> = {};
  /** Set while something (hyperspace) wants the overlay shut. */
  locked = false;

  constructor(
    private readonly root: HTMLElement,
    input: Input,
  ) {
    root.classList.add('map-overlay');
    root.innerHTML = `
      <div class="mo-head">
        <div class="mo-brand">FARLIGHT</div>
        <div class="mo-tabs">${TABS.map((t) => `<button type="button" class="mo-tab" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
        <button type="button" class="mo-close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`;
    for (const t of TABS) {
      const pane = document.createElement('div');
      pane.className = 'map-pane';
      pane.dataset.tab = t.id;
      root.insertBefore(pane, root.firstChild);
      this.panes[t.id] = pane;
      this.tabButtons[t.id] = root.querySelector(`.mo-tab[data-tab="${t.id}"]`) as HTMLElement;
      this.tabButtons[t.id].addEventListener('click', () => this.open(t.id));
    }
    const head = root.querySelector('.mo-head') as HTMLElement;
    head.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    (root.querySelector('.mo-close') as HTMLElement).addEventListener('click', () => this.close());

    input.on('map', () => this.toggle('system'));
    input.on('galaxy', () => this.toggle('galaxy'));
    input.on('journal', () => this.toggle('journal'));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.current) this.close();
    });
  }

  pane(tab: MapTab): HTMLElement {
    return this.panes[tab];
  }

  bind(tab: MapTab, h: TabHandlers): void {
    this.handlers[tab] = h;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  get tab(): MapTab | null {
    return this.current;
  }

  toggle(tab: MapTab): void {
    if (this.current === tab) this.close();
    else this.open(tab);
  }

  open(tab: MapTab): void {
    if (this.locked) return;
    if (this.current === tab) return;
    if (this.current) this.handlers[this.current]?.onHide();
    this.current = tab;
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.style.display = 'block';
    for (const t of TABS) {
      this.panes[t.id].classList.toggle('on', t.id === tab);
      this.tabButtons[t.id].classList.toggle('on', t.id === tab);
    }
    this.handlers[tab]?.onShow();
  }

  close(): void {
    if (!this.current) return;
    this.handlers[this.current]?.onHide();
    this.current = null;
    this.root.style.display = 'none';
  }
}
