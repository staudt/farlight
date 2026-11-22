import { describe, expect, it } from 'vitest';
import { propGeometry, propGeometryLow } from '../src/render/bodies/props';
import type { PropKind } from '../src/data/types';

const KINDS: [PropKind, number][] = [['tree', 0], ['tree', 1], ['rock', 0], ['spire', 0], ['crystal', 0], ['mesa', 0]];

describe('prop LOD meshes', () => {
  it('low versions are much lighter and cached', () => {
    for (const [k, v] of KINDS) {
      const hi = propGeometry(k, v).getAttribute('position').count / 3;
      const lo = propGeometryLow(k, v).getAttribute('position').count / 3;
      expect(lo).toBeGreaterThan(0);
      expect(lo).toBeLessThanOrEqual(8);
      expect(lo).toBeLessThan(hi);
      expect(propGeometryLow(k, v)).toBe(propGeometryLow(k, v));
    }
  });
});
