import type { World } from './world';

export const RESUME_KEY = 'farlight.resume.v1';

export type ResumeCamera = 'chase' | 'cockpit';

type V3 = [number, number, number];

/** Where the ship was, in its own reference frame. Enough to put it back exactly. */
export interface ResumeState {
  v: 1;
  systemId: string;
  frameBodyId: string;
  rotating: boolean;
  pos: V3;
  vel: V3;
  quat: [number, number, number, number];
  throttle: number;
  simTime: number;
  landed: boolean;
  cameraMode: ResumeCamera;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function captureResume(world: World, systemId: string, cameraMode: ResumeCamera): ResumeState {
  const s = world.ship;
  return {
    v: 1,
    systemId,
    frameBodyId: s.frame.body.id,
    rotating: s.frame.rotating,
    pos: [s.pos.x, s.pos.y, s.pos.z],
    vel: [s.vel.x, s.vel.y, s.vel.z],
    quat: [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
    throttle: s.throttle,
    simTime: world.clock.time,
    landed: s.landed,
    cameraMode,
  };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

/** Returns a clean state or null when anything is off. */
export function parseResume(raw: unknown): ResumeState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.systemId !== 'string' || typeof r.frameBodyId !== 'string') return null;
  if (typeof r.rotating !== 'boolean' || typeof r.landed !== 'boolean') return null;
  if (!vec(r.pos, 3) || !vec(r.vel, 3) || !vec(r.quat, 4)) return null;
  if (!finite(r.throttle) || !finite(r.simTime)) return null;
  if (r.cameraMode !== 'chase' && r.cameraMode !== 'cockpit') return null;
  const q = r.quat as number[];
  const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  if (len < 0.5 || len > 2) return null;
  const pos = r.pos as number[];
  if (Math.hypot(pos[0]!, pos[1]!, pos[2]!) === 0) return null;
  return {
    v: 1,
    systemId: r.systemId,
    frameBodyId: r.frameBodyId,
    rotating: r.rotating,
    pos: [pos[0]!, pos[1]!, pos[2]!],
    vel: r.vel as V3,
    quat: Math.abs(len - 1) < 1e-9 ? [q[0]!, q[1]!, q[2]!, q[3]!] : [q[0]! / len, q[1]! / len, q[2]! / len, q[3]! / len],
    throttle: Math.min(1, Math.max(0, r.throttle)),
    simTime: r.simTime,
    landed: r.landed,
    cameraMode: r.cameraMode,
  };
}

export function serializeResume(s: ResumeState): string {
  return JSON.stringify(s);
}

export function deserializeResume(text: string | null): ResumeState | null {
  if (!text) return null;
  try {
    return parseResume(JSON.parse(text));
  } catch {
    return null;
  }
}

export function saveResume(s: ResumeState, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(RESUME_KEY, serializeResume(s));
  } catch {
    /* storage unavailable: resume is optional */
  }
}

export function loadResume(storage: StorageLike | null = defaultStorage()): ResumeState | null {
  try {
    return deserializeResume(storage?.getItem(RESUME_KEY) ?? null);
  } catch {
    return null;
  }
}

export function clearResume(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem?.(RESUME_KEY);
  } catch {
    /* ignore */
  }
}
