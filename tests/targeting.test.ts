import { describe, expect, test } from 'vitest';
import { Vector3 } from 'three';
import { AimCycler, orderByAim } from '../src/sim/targeting';

const cam = new Vector3(0, 0, 0);
const fwd = new Vector3(0, 0, -1);
const t = (name: string, x: number, y: number, z: number) => ({ name, position: new Vector3(x, y, z) });

describe('aim based targeting', () => {
  const ahead = t('ahead', 1, 0, -100); // almost on the crosshair, far away
  const near = t('near', 50, 0, -10); // close but well off the crosshair
  const behind = t('behind', 0, 0, 5);
  const cands = [behind, near, ahead];

  test('orders by angle from the crosshair, not distance', () => {
    expect(orderByAim(cands, cam, fwd).map((c) => c.name)).toEqual(['ahead', 'near', 'behind']);
  });

  test('a fresh press picks what is under the crosshair', () => {
    const c = new AimCycler<(typeof cands)[number]>();
    expect(c.next(0, cands, cam, fwd, null)?.name).toBe('ahead');
  });

  test('quick repeated presses step outward', () => {
    const c = new AimCycler<(typeof cands)[number]>();
    expect(c.next(0, cands, cam, fwd, null)?.name).toBe('ahead');
    expect(c.next(0.5, cands, cam, fwd, ahead)?.name).toBe('near');
    expect(c.next(1, cands, cam, fwd, near)?.name).toBe('behind');
  });

  test('a fresh press when the aimed body is already targeted moves to the next', () => {
    const c = new AimCycler<(typeof cands)[number]>();
    expect(c.next(10, cands, cam, fwd, ahead)?.name).toBe('near');
  });
});
