import { describe, expect, test } from 'vitest';
import { createGalaxy, generateSystem } from '../src/data/generate';
import type { BodyDef, TerrainDef } from '../src/data/types';
import { Universe } from '../src/sim/universe';
import { biomeNameAt } from '../src/terrain/biomes';
import { createHeightSampler, makeSample } from '../src/terrain/heightfield';
import { expectValidLayout } from './layoutCheck';

const galaxy = createGalaxy();
const systems = galaxy.stars.filter((s) => s.id !== 'sol').map((s) => generateSystem(s));
const bodies = systems.flatMap((s) => s.bodies);
const has = (b: BodyDef, f: string): boolean => b.info.features.includes(f);

function fakeWorld(terrain: TerrainDef): BodyDef {
  return {
    id: 'w',
    name: 'W',
    kind: 'rocky',
    seed: 11,
    physical: { radius: 6e6, surfaceGravity: 9, rotationPeriod: 1e5, axialTilt: 0 },
    visual: { color: [0.5, 0.5, 0.5] },
    terrain,
    info: { type: '', atmosphere: '', temperature: '', features: [], summary: '' },
  };
}

describe('biomeAxis substellar', () => {
  const terrain: TerrainDef = {
    amplitude: 0.01,
    layers: [{ type: 'fbm', frequency: 2, amplitude: 0.3, octaves: 2 }],
    biomeAxis: 'substellar',
    biomes: [
      { name: 'hot', color: [1, 0, 0], latitude: [0, 0.3] },
      { name: 'mild', color: [0, 1, 0], latitude: [0.5, 1.0] },
      { name: 'cold', color: [0, 0, 1] },
    ],
  };
  test('latitude is measured from +X, not from the spin axis', () => {
    const s = createHeightSampler(fakeWorld(terrain), 6e6);
    const out = makeSample();
    s.sample(1, 0, 0, out);
    expect(out.lat).toBeCloseTo(0, 6);
    s.sample(0, 0, 1, out);
    expect(out.lat).toBeCloseTo(Math.PI / 4, 6);
    s.sample(0, 1, 0, out);
    expect(out.lat).toBeCloseTo(Math.PI / 4, 6); // the spin pole is on the terminator
    s.sample(-1, 0, 0, out);
    expect(out.lat).toBeCloseTo(Math.PI / 2, 6);
    expect(biomeNameAt(terrain, { ...makeSample(), x: 1, y: 0, z: 0, lat: 0.15, moisture: 0.5 }, 0)).toBe('hot');
    expect(biomeNameAt(terrain, { ...makeSample(), x: -1, y: 0, z: 0, lat: Math.PI / 2, moisture: 0.5 }, 0)).toBe('cold');
  });
  test('default axis is the pole', () => {
    const s = createHeightSampler(fakeWorld({ ...terrain, biomeAxis: undefined }), 6e6);
    const out = makeSample();
    s.sample(0, 1, 0, out);
    expect(out.lat).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('noise layer terraces', () => {
  test('quantises a layer into flat treads', () => {
    const mk = (terraces?: number): TerrainDef => ({
      amplitude: 0.01,
      layers: [{ type: 'fbm', frequency: 3, amplitude: 1, octaves: 2, terraces }],
      biomes: [{ name: 'a', color: [1, 1, 1] }],
    });
    const plain = createHeightSampler(fakeWorld(mk()), 6e6);
    const stepped = createHeightSampler(fakeWorld(mk(4)), 6e6);
    const outP = makeSample();
    const outS = makeSample();
    let flat = 0;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const a = i * 0.37;
      const b = i * 0.11;
      const d: [number, number, number] = [Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)];
      plain.sample(...d, outP);
      stepped.sample(...d, outS);
      expect(Number.isFinite(outS.n)).toBe(true);
      // Within a quarter step of the plain value.
      expect(Math.abs(outS.n - outP.n)).toBeLessThan(0.3);
      // Most samples sit on a tread: near a multiple of 1/4.
      const f = outS.n * 4 - Math.floor(outS.n * 4);
      if (f < 0.05 || f > 0.95) flat++;
      n++;
    }
    expect(flat / n).toBeGreaterThan(0.45);
  });
});

describe('rare archetypes', () => {
  test('each appears in about 4 to 14 percent of systems', () => {
    const per = (f: (b: BodyDef) => boolean): number => systems.filter((s) => s.bodies.some(f)).length / systems.length;
    const table: [string, number][] = [
      ['eyeball', per((b) => b.terrain?.biomeAxis === 'substellar')],
      ['rings', per((b) => b.kind === 'rocky' && has(b, 'Great rings'))],
      ['archipelago', per((b) => has(b, 'Thousands of islands'))],
      ['canyon', per((b) => has(b, 'Branching canyons'))],
      ['mesa', per((b) => has(b, 'Terraced mesas'))],
      ['crystal', per((b) => has(b, 'Crystal plains'))],
      ['huge moon', per((b) => b.info.summary.includes('fills the sky'))],
    ];
    for (const [name, p] of table) {
      expect(p, name).toBeGreaterThan(0.04);
      expect(p, name).toBeLessThan(0.14);
    }
  });

  test('eyeball worlds are tidally locked to a star and keep a lit temperate ring', () => {
    const eyes = bodies.filter((b) => b.terrain?.biomeAxis === 'substellar');
    expect(eyes.length).toBeGreaterThan(5);
    for (const e of eyes) {
      expect(e.physical.tidallyLocked).toBe(true);
      expect(e.physical.rotationPeriod).toBe(e.orbit!.period);
      expect(e.terrain!.biomes.some((b) => b.name === 'night ice')).toBe(true);
      expect(e.terrain!.biomes.some((b) => b.name === 'scorched')).toBe(true);
      expect(e.terrain!.water).toBeDefined();
    }
    // Locked to the star: the body-fixed +X axis points at it.
    const sys = systems.find((s) => s.bodies.some((b) => b.terrain?.biomeAxis === 'substellar'))!;
    const u = new Universe(sys);
    u.update(98765);
    const eye = u.get(sys.bodies.find((b) => b.terrain?.biomeAxis === 'substellar')!.id);
    const toStar = u.root.position.clone().sub(eye.position).normalize();
    const plusX = new (eye.rotation.constructor as typeof import('three').Quaternion)().copy(eye.rotation);
    const x = toStar.clone().set(1, 0, 0).applyQuaternion(plusX);
    expect(x.dot(toStar)).toBeGreaterThan(0.999);
  });

  test('ring worlds carry real rings, some tilt and an atmosphere or craters', () => {
    const rings = bodies.filter((b) => b.kind === 'rocky' && has(b, 'Great rings'));
    expect(rings.length).toBeGreaterThan(5);
    for (const r of rings) {
      expect(r.rings!.outerRadius).toBeGreaterThan(r.rings!.innerRadius + 1);
      expect(r.rings!.opacity).toBeGreaterThan(0.7);
      expect(r.physical.axialTilt).toBeGreaterThan(0.2);
    }
  });

  test('big and twin moons orbit above the air and inside the system layout rules', () => {
    for (const s of systems) expectValidLayout(s);
    let huge = 0;
    for (const sys of systems) {
      for (const m of sys.bodies.filter((b) => b.info.summary.includes('fills the sky'))) {
        const parent = sys.bodies.find((b) => b.id === m.parentId)!;
        huge++;
        expect(m.physical.radius / parent.physical.radius).toBeGreaterThan(0.25);
        expect(m.physical.radius / parent.physical.radius).toBeLessThanOrEqual(0.5);
      }
    }
    expect(huge).toBeGreaterThan(5);
    const twins = systems.filter((s) => s.bodies.some((b) => b.parentId !== undefined && b.parentId !== s.bodies[0]!.id && s.bodies.filter((o) => o.parentId === b.parentId).length >= 2));
    expect(twins.length).toBeGreaterThan(5);
  });

  test('canyon and mesa worlds use inverted ridged noise and terraces', () => {
    const canyon = bodies.find((b) => has(b, 'Branching canyons'))!;
    expect(canyon.terrain!.layers.some((l) => l.type === 'ridged' && l.amplitude < 0)).toBe(true);
    expect(canyon.terrain!.layers.some((l) => (l.terraces ?? 0) > 1)).toBe(true);
    const mesa = bodies.find((b) => has(b, 'Terraced mesas'))!;
    expect(mesa.terrain!.layers.some((l) => (l.terraces ?? 0) > 1)).toBe(true);
  });

  test('archipelago worlds have thousands of islands: a small share of land in small blobs', () => {
    const arch = bodies.find((b) => has(b, 'Thousands of islands'))!;
    const sampler = createHeightSampler(arch, 6.4e5);
    const out = makeSample();
    let land = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const a = i * 2.399963;
      const z = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - z * z);
      sampler.sample(r * Math.cos(a), z, r * Math.sin(a), out);
      if (!out.water) land++;
    }
    expect(land / n).toBeGreaterThan(0.04);
    expect(land / n).toBeLessThan(0.4);
  });

  test('crystal worlds are crowded with crystal props', () => {
    const c = bodies.find((b) => has(b, 'Crystal plains'))!;
    const crystals = c.terrain!.props!.filter((p) => p.kind === 'crystal');
    expect(crystals.reduce((a, p) => a + p.density, 0)).toBeGreaterThan(150);
  });

  test('generation stays deterministic', () => {
    const star = galaxy.stars.find((s) => s.id === 's15fm9jh')!;
    expect(generateSystem(star)).toEqual(generateSystem(star));
  });
});

describe('biome hemisphere and direction rules', () => {
  const terrain: TerrainDef = {
    amplitude: 0.01,
    layers: [{ type: 'fbm', frequency: 2, amplitude: 0.1, octaves: 2 }],
    biomes: [
      { name: 'south', color: [0, 0, 1], hemisphere: 'south', latitude: [1.0, 1.6] },
      { name: 'lead', color: [0, 0, 0], direction: { axis: [0, 0, 1], minDot: 0.25 } },
      { name: 'rest', color: [1, 1, 1] },
    ],
  };
  const at = (x: number, y: number, z: number): string => {
    const s = createHeightSampler(fakeWorld(terrain), 6e6);
    const out = makeSample();
    s.sample(x, y, z, out);
    out.n = 0;
    return biomeNameAt(terrain, out, 0);
  };
  test('hemisphere keeps a polar biome to one pole', () => {
    expect(at(0, -1, 0)).toBe('south');
    expect(at(0, 1, 0)).toBe('rest');
  });
  test('direction splits the surface by a half space', () => {
    expect(at(0, 0, 1)).toBe('lead');
    expect(at(0, 0, -1)).toBe('rest');
    expect(at(1, 0, 0)).toBe('rest');
  });
});
