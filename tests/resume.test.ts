import { describe, expect, test } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { SOLAR_SYSTEM } from '../src/data/solarSystem';
import { World } from '../src/sim/world';
import {
  captureResume,
  deserializeResume,
  loadResume,
  parseResume,
  RESUME_KEY,
  saveResume,
  serializeResume,
} from '../src/sim/resume';
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsStore } from '../src/ui/settingsStore';

function mem(): { data: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function flown(): World {
  const w = new World(SOLAR_SYSTEM, 0);
  w.place({ body: 'earth', lat: 20, lon: 40, altitude: 3000, heading: 70, pitch: 5, throttle: 0.6, time: 5000 });
  return w;
}

describe('resume', () => {
  test('serialise and deserialise', () => {
    const w = flown();
    const s = captureResume(w, 'sol', 'chase');
    const back = deserializeResume(serializeResume(s))!;
    expect(back).toEqual(s);
  });

  test('restore round trips the world position within 1 m', () => {
    for (const mk of [
      () => flown(),
      () => {
        const w = new World(SOLAR_SYSTEM, 0);
        w.placeInSpace('earth', w.universe.get('earth').radius * 6);
        return w;
      },
    ]) {
      const a = mk();
      const state = deserializeResume(serializeResume(captureResume(a, 'sol', 'cockpit')))!;
      const b = new World(SOLAR_SYSTEM, 0);
      expect(b.restore(state)).toBe(true);
      expect(b.shipWorldPos.distanceTo(a.shipWorldPos)).toBeLessThan(1);
      expect(b.shipWorldVel.distanceTo(a.shipWorldVel)).toBeLessThan(0.01);
      expect(b.clock.time).toBe(a.clock.time);
      expect(b.ship.frame.body.id).toBe(a.ship.frame.body.id);
      expect(b.ship.frame.rotating).toBe(a.ship.frame.rotating);
      expect(b.ship.throttle).toBeCloseTo(a.ship.throttle, 9);
      const dq = new Quaternion().copy(b.shipWorldQuat).invert().multiply(a.shipWorldQuat);
      expect(Math.abs(dq.w)).toBeGreaterThan(0.99999);
    }
  });

  test('landed state survives', () => {
    const a = new World(SOLAR_SYSTEM, 0);
    a.place({ body: 'moon', lat: 0, lon: 10, altitude: 0, landed: true });
    const b = new World(SOLAR_SYSTEM, 0);
    b.restore(captureResume(a, 'sol', 'cockpit'));
    expect(b.ship.landed).toBe(true);
    expect(b.phase).toBe('landed');
    expect(b.shipWorldPos.distanceTo(a.shipWorldPos)).toBeLessThan(1);
  });

  test('unknown frame body leaves the world alone', () => {
    const w = new World(SOLAR_SYSTEM, 0);
    const before = new Vector3().copy(w.shipWorldPos);
    const s = captureResume(flown(), 'sol', 'cockpit');
    expect(w.restore({ ...s, frameBodyId: 'nope' })).toBe(false);
    expect(w.shipWorldPos.distanceTo(before)).toBe(0);
  });

  test('bad data is rejected', () => {
    const good = captureResume(flown(), 'sol', 'cockpit');
    expect(parseResume(null)).toBeNull();
    expect(parseResume({ ...good, pos: [1, 2] })).toBeNull();
    expect(parseResume({ ...good, pos: [NaN, 0, 1] })).toBeNull();
    expect(parseResume({ ...good, quat: [0, 0, 0, 0] })).toBeNull();
    expect(parseResume({ ...good, cameraMode: 'x' })).toBeNull();
    expect(parseResume({ ...good, v: 2 })).toBeNull();
    expect(deserializeResume('{oops')).toBeNull();
  });

  test('storage round trip', () => {
    const st = mem();
    expect(loadResume(st)).toBeNull();
    const s = captureResume(flown(), 'sol', 'chase');
    saveResume(s, st);
    expect(st.data.has(RESUME_KEY)).toBe(true);
    expect(loadResume(st)).toEqual(s);
  });
});

describe('settings store', () => {
  test('defaults, persistence and sanitising', () => {
    const st = mem();
    const a = new SettingsStore(st);
    expect(a.value).toEqual(DEFAULT_SETTINGS);
    a.set('mouseSens', 99);
    a.set('quality', 'low');
    const b = new SettingsStore(st);
    expect(b.get('mouseSens')).toBe(3);
    expect(b.get('quality')).toBe('low');
  });

  test('broken storage falls back to defaults', () => {
    const st = mem();
    st.setItem(SETTINGS_KEY, '{nope');
    expect(new SettingsStore(st).value).toEqual(DEFAULT_SETTINGS);
  });

  test('old invert keys migrate', () => {
    const st = mem();
    st.setItem('farlight.invertStick', '1');
    st.setItem('farlight.padInvertPitch', '1');
    const s = new SettingsStore(st);
    expect(s.get('invertStick')).toBe(true);
    expect(s.get('invertPad')).toBe(true);
  });
});
