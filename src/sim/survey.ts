import { PROGRESS_STORAGE_KEY, type PlayerProgress } from '../data/galaxy';
import type { Body } from './universe';
import type { World } from './world';

/** Sim seconds inside a body's near zone before it counts as surveyed. */
export const SURVEY_SECONDS = 5;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emptyProgress(): PlayerProgress {
  return { visited: [], surveyed: [] };
}

export function surveyKey(systemId: string, bodyId: string): string {
  return `${systemId}/${bodyId}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads progress, tolerating missing, broken or hostile data. */
export function loadProgress(storage: StorageLike | null = defaultStorage()): PlayerProgress {
  try {
    const raw = storage?.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) return emptyProgress();
    const p = JSON.parse(raw) as Partial<PlayerProgress>;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { visited: strs(p.visited), surveyed: strs(p.surveyed) };
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(progress: PlayerProgress, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* storage unavailable: progress is optional */
  }
}

/** Returns true when the id was new. */
export function markVisited(systemId: string, storage: StorageLike | null = defaultStorage()): boolean {
  const p = loadProgress(storage);
  if (p.visited.includes(systemId)) return false;
  p.visited.push(systemId);
  saveProgress(p, storage);
  return true;
}

/** Returns true when the body was new. */
export function markSurveyed(systemId: string, bodyId: string, storage: StorageLike | null = defaultStorage()): boolean {
  const p = loadProgress(storage);
  const key = surveyKey(systemId, bodyId);
  if (p.surveyed.includes(key)) return false;
  p.surveyed.push(key);
  saveProgress(p, storage);
  return true;
}

export interface SurveyProgress {
  done: number;
  total: number;
  /** 0..1 */
  fraction: number;
}

/** Surveyed share of a system's bodies (pass the ids of every body except the star). */
export function surveyProgress(progress: PlayerProgress, systemId: string, bodyIds: readonly string[]): SurveyProgress {
  const set = new Set(progress.surveyed);
  let done = 0;
  for (const id of bodyIds) if (set.has(surveyKey(systemId, id))) done++;
  const total = bodyIds.length;
  return { done, total, fraction: total > 0 ? done / total : 0 };
}

/**
 * Counts sim seconds spent inside a body's near zone (the rotating frame) and fires once per
 * body when it reaches SURVEY_SECONDS, or immediately on landing.
 */
export class SurveyTracker {
  private readonly time = new Map<string, number>();
  private readonly done: Set<string>;
  private lastSim: number;
  /** Called the first time a body is surveyed. */
  onSurveyed: ((body: Body) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly systemId: string,
    private readonly storage: StorageLike | null = defaultStorage(),
  ) {
    this.lastSim = world.clock.time;
    this.done = new Set(loadProgress(storage).surveyed);
  }

  update(): void {
    const w = this.world;
    const now = w.clock.time;
    const dt = Math.min(Math.max(0, now - this.lastSim), 60);
    this.lastSim = now;
    const f = w.ship.frame;
    if (!f.rotating || f.body.kind === 'star') return;
    const body = f.body;
    const key = surveyKey(this.systemId, body.id);
    if (this.done.has(key)) return;
    const t = (this.time.get(key) ?? 0) + dt;
    this.time.set(key, t);
    if (t >= SURVEY_SECONDS || w.ship.landed) {
      this.done.add(key);
      markSurveyed(this.systemId, body.id, this.storage);
      this.onSurveyed?.(body);
    }
  }
}
