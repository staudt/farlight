import { describe, expect, test } from 'vitest';
import { GUIDE, GuideLogic, type GuideSnapshot, tipSegments, tipText, type TipId } from '../src/ui/guide';
import { SettingsStore } from '../src/ui/settingsStore';

const base: GuideSnapshot = {
  dt: 1,
  blocked: false,
  phase: 'atmosphere',
  atmosphereDepth: 0.8,
  warp: 1,
  throttle: 0.5,
  hasTarget: false,
  undiscoveredMarker: false,
  discovered: 0,
  nightLights: false,
};

/** Runs the logic for `seconds` and returns the tips that started, in order. */
function run(g: GuideLogic, seconds: number, over: Partial<GuideSnapshot> = {}): TipId[] {
  const out: TipId[] = [];
  for (let i = 0; i < seconds; i++) {
    const t = g.update({ ...base, ...over });
    if (t) out.push(t);
  }
  return out;
}

describe('guide logic', () => {
  test('throttle tip after 6 s of flight, once', () => {
    const g = new GuideLogic();
    expect(run(g, GUIDE.flightDelay - 1)).toEqual([]);
    expect(run(g, 2)).toEqual(['throttle']);
    expect(run(g, 200)).not.toContain('throttle');
  });

  test('tips are spaced', () => {
    const g = new GuideLogic();
    run(g, GUIDE.flightDelay + 1);
    // Atmosphere for 25 s makes the space tip ready, but spacing holds it back.
    expect(run(g, GUIDE.spacing - 10)).toEqual([]);
    expect(run(g, 15)).toEqual(['space']);
  });

  test('a tip fades after its time', () => {
    const g = new GuideLogic();
    run(g, 7);
    expect(g.current).toBe('throttle');
    run(g, GUIDE.showSeconds + 1);
    expect(g.current).toBeNull();
  });

  test('a tip ends when the action happens', () => {
    const g = new GuideLogic();
    run(g, 7);
    g.update({ ...base, throttle: 0.9 });
    expect(g.current).toBeNull();
  });

  test('the space tip needs time in atmosphere, the speed up tip needs space', () => {
    const g = new GuideLogic();
    g.seen.add('throttle');
    expect(run(g, 20)).toEqual([]);
    expect(run(g, 10)).toEqual(['space']);
    const shown = run(g, GUIDE.spacing + 5, { phase: 'space', atmosphereDepth: 0 });
    expect(shown).toEqual(['speedup']);
  });

  test('no target tip needs 20 s in space and no target', () => {
    const g = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup'] as const) g.seen.add(id);
    expect(run(g, 15, { phase: 'space', warp: 100, hasTarget: true })).toEqual([]);
    expect(run(g, 19, { phase: 'space', warp: 100 })).toEqual([]);
    expect(run(g, 8, { phase: 'space', warp: 100 })).toEqual(['target']);
  });

  test('land tip on first approach after space, sunset tip after landing', () => {
    const g = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup', 'target'] as const) g.seen.add(id);
    expect(run(g, 3, { phase: 'atmosphere' })).toEqual([]); // never been to space: no approach
    run(g, 2, { phase: 'space' });
    expect(run(g, 1, { phase: 'atmosphere' })).toEqual(['land']);
    expect(run(g, GUIDE.spacing + 1, { phase: 'landed' })).toEqual(['sunset']);
  });

  test('landmark tip when an undiscovered marker shows', () => {
    const g = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup', 'target', 'land', 'sunset'] as const) g.seen.add(id);
    expect(run(g, 5)).toEqual([]);
    expect(run(g, 1, { undiscoveredMarker: true })).toEqual(['landmark']);
  });

  test('maps tip after a discovery or 6 minutes, look tip after 10', () => {
    const a = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup', 'target', 'land', 'sunset', 'landmark'] as const) a.seen.add(id);
    run(a, 3);
    expect(run(a, 1, { discovered: 1 })).toEqual(['maps']);

    const b = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup', 'target', 'land', 'sunset', 'landmark'] as const) b.seen.add(id);
    const tips = run(b, 601);
    expect(tips).toEqual(['maps', 'look']);
  });

  test('glow tip needs night lights and depth', () => {
    const g = new GuideLogic();
    for (const id of ['throttle', 'space', 'speedup', 'target', 'land', 'sunset', 'landmark', 'maps', 'look'] as const) g.seen.add(id);
    expect(run(g, 3, { nightLights: false })).toEqual([]);
    expect(run(g, 1, { nightLights: true, atmosphereDepth: 0.3 })).toEqual([]);
    expect(run(g, 1, { nightLights: true })).toEqual(['glow']);
  });

  test('overlays suppress tips and hide the current one', () => {
    const g = new GuideLogic();
    expect(run(g, 30, { blocked: true })).toEqual([]);
    expect(run(g, 7)).toEqual(['throttle']);
    g.update({ ...base, blocked: true });
    expect(g.current).toBeNull();
  });

  test('disabled shows nothing', () => {
    const g = new GuideLogic();
    g.enabled = false;
    expect(run(g, 100)).toEqual([]);
  });
});

describe('guide phrasing', () => {
  test('keys differ per device', () => {
    expect(tipText('throttle', 'keyboard')).toContain('{W} {S}');
    expect(tipText('throttle', 'touch')).toContain('RIGHT SLIDER');
    expect(tipText('throttle', 'gamepad')).toContain('{RT}');
    expect(tipText('speedup', 'keyboard')).toBe('PRESS {.} TO SPEED UP TIME');
    expect(tipText('speedup', 'touch')).toContain('BESIDE TIME');
    expect(tipText('space', 'touch')).toBe('HOLD {BOOST} AND PULL BACK');
  });

  test('no dashes in any text', () => {
    for (const id of ['throttle', 'space', 'speedup', 'target', 'land', 'sunset', 'landmark', 'maps', 'look', 'glow'] as const) {
      for (const d of ['keyboard', 'touch', 'gamepad'] as const) expect(tipText(id, d)).not.toMatch(/[-–—]/);
    }
  });

  test('segments mark keys', () => {
    expect(tipSegments('PRESS {T} NOW')).toEqual([
      { text: 'PRESS ', key: false },
      { text: 'T', key: true },
      { text: ' NOW', key: false },
    ]);
  });
});

describe('guide settings', () => {
  test('seen tips persist and reset', () => {
    const data = new Map<string, string>();
    const mem = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const a = new SettingsStore(mem);
    expect(a.get('showTips')).toBe(true);
    a.set('tipsSeen', ['throttle', 'space']);
    expect(new SettingsStore(mem).get('tipsSeen')).toEqual(['throttle', 'space']);
    a.set('tipsSeen', []);
    expect(new SettingsStore(mem).get('tipsSeen')).toEqual([]);
  });
});
