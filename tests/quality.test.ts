import { describe, expect, it } from 'vitest';
import { AutoAdapter, QualityManager, initialLevel, parseQuality } from '../src/render/quality';

/** Feeds a constant fps for `secs` seconds and returns the first change requested (and when). */
function run(a: AutoAdapter, level: 'low' | 'medium' | 'high', fps: number, secs: number): { step: number; at: number } {
  const dt = 1 / fps;
  for (let t = 0; t < secs; t += dt) {
    const s = a.update(dt, level);
    if (s !== 0) return { step: s, at: t };
  }
  return { step: 0, at: secs };
}

describe('quality presets', () => {
  it('parses the url param and falls back to the config preset', () => {
    expect(parseQuality('low')).toBe('low');
    expect(parseQuality('high')).toBe('high');
    expect(parseQuality('bogus')).toBe('auto');
    expect(parseQuality(null)).toBe('auto');
  });

  it('auto starts from the device class', () => {
    expect(initialLevel('auto', true)).toBe('medium');
    expect(initialLevel('auto', false)).toBe('high');
    expect(initialLevel('low', false)).toBe('low');
  });

  it('manager exposes settings and labels', () => {
    const m = new QualityManager();
    m.init('low', false);
    expect(m.name).toBe('low');
    expect(m.label).toBe('LOW');
    expect(m.settings.msaa).toBe(0);
    m.init(null, false);
    expect(m.label).toBe('AUTO HIGH');
    let seen = '';
    m.onChange((_s, n) => (seen = n));
    m.setLevel('medium');
    expect(seen).toBe('medium');
  });
});

describe('auto adapt', () => {
  it('does nothing during warmup', () => {
    const a = new AutoAdapter();
    expect(run(a, 'high', 10, 3.5).step).toBe(0);
  });

  it('steps down after about 3 s under 45 fps', () => {
    const a = new AutoAdapter();
    run(a, 'high', 60, 5); // warmup
    const r = run(a, 'high', 30, 10);
    expect(r.step).toBe(-1);
    expect(r.at).toBeGreaterThanOrEqual(2.5);
    expect(r.at).toBeLessThan(4);
  });

  it('never steps below low or above high', () => {
    const a = new AutoAdapter();
    run(a, 'low', 60, 5);
    expect(run(a, 'low', 20, 10).step).toBe(0);
    const b = new AutoAdapter();
    run(b, 'high', 60, 5);
    expect(run(b, 'high', 60, 30).step).toBe(0);
  });

  it('steps up after 10 s at full speed', () => {
    const a = new AutoAdapter();
    run(a, 'medium', 60, 5);
    const r = run(a, 'medium', 60, 20);
    expect(r.step).toBe(1);
    expect(r.at).toBeGreaterThanOrEqual(9);
  });

  it('a short dip resets the counters', () => {
    const a = new AutoAdapter();
    run(a, 'high', 60, 5);
    expect(run(a, 'high', 30, 2).step).toBe(0);
    expect(run(a, 'high', 60, 1).step).toBe(0);
    expect(run(a, 'high', 30, 2).step).toBe(0);
  });

  it('waits after a step down and backs off after a bounce', () => {
    const a = new AutoAdapter();
    run(a, 'high', 60, 5);
    expect(run(a, 'high', 30, 10).step).toBe(-1);
    // 60 fps again, but the cooldown (30 s) blocks a step up for a while.
    expect(run(a, 'medium', 60, 20).step).toBe(0);
    const up = run(a, 'medium', 60, 40);
    expect(up.step).toBe(1);
    // Bounce: drops again right away, the next wait doubles.
    expect(run(a, 'high', 30, 10).step).toBe(-1);
    expect(run(a, 'medium', 60, 50).step).toBe(0);
  });
});
