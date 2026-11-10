import { hashInts, mulberry32 } from '../core/rng';
import type { GalaxyStar } from './galaxy';
import type { BeltDef, BodyDef, CometDef, RGB, SkyDef, StarSystemDef } from './types';

/**
 * Space scenery for generated systems: asteroid belts, comets, a nebula backdrop and a distant
 * companion star. Every feature draws from its OWN seeded stream (seed xor a salt), so adding or
 * changing any of them never moves a planet or a color elsewhere in the system.
 */

const DEG = Math.PI / 180;
const AU = 1.495978707e11;
const SOLAR_RADIUS = 6.957e8;
/** Same factors as ScaleProfile (planet orbits 0.001, stars 0.005); the companion uses a game meter override. */
const GAME_ORBIT_SCALE = 0.001;
const GAME_STAR_SCALE = 0.005;
/** Keep the companion inside the starfield sphere (1e10). */
const COMPANION_MAX = 7.5e9;
const COMPANION_MIN = 2.0e9;

const round = (x: number, d = 3): number => Math.round(x * 10 ** d) / 10 ** d;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

class Stream {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed >>> 0);
  }
  r(): number {
    return this.next();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  seed(): number {
    return Math.floor(this.next() * 0xffffffff) >>> 0;
  }
}

const SALT_BINARY = 0xb1a27e51;
const SALT_BELTS = 0xbe17b317;
const SALT_COMETS = 0xc0e7c0e7;
const SALT_SKY = 0x5c1e0b01;

/** About 15% of generated stars have a companion. Pure of the seed, so the galaxy map can show it unbuilt. */
export function isBinaryStar(star: { id: string; seed: number }): boolean {
  if (star.id === 'sol') return false;
  return new Stream(hashInts(star.seed, SALT_BINARY)).chance(0.15);
}

/** Nebula tints by galactic region: warm and pink near the core, blue and violet in the arms, teal at the rim. */
export function skyFor(star: GalaxyStar): SkyDef {
  const rng = new Stream(hashInts(star.seed, SALT_SKY));
  const radius = Math.hypot(star.x, star.y);
  const t = clamp01(radius / 40000);
  const palettes: RGB[][] = [
    [[0.9, 0.35, 0.18], [0.75, 0.2, 0.5], [0.3, 0.2, 0.7]],
    [[0.2, 0.4, 0.95], [0.55, 0.25, 0.9], [0.9, 0.3, 0.6]],
    [[0.1, 0.65, 0.8], [0.25, 0.35, 0.95], [0.6, 0.4, 0.9]],
    [[0.95, 0.5, 0.2], [0.9, 0.25, 0.35], [0.2, 0.45, 0.9]],
    [[0.2, 0.8, 0.6], [0.15, 0.5, 0.9], [0.8, 0.35, 0.8]],
  ];
  const warmBias = 1 - t;
  const idx = rng.chance(0.3 + 0.3 * warmBias) ? rng.pick([0, 3]) : rng.pick([1, 2, 4]);
  const colors = palettes[idx]!.map((c) => c.map((v) => round(clamp01(v * rng.range(0.85, 1.12)))) as unknown as RGB);
  return {
    colors,
    intensity: round(rng.range(0.55, 1.25), 2),
    band: round(rng.range(0.6, 1.1), 2),
    scale: round(rng.range(0.8, 1.5), 2),
    seed: rng.seed(),
  };
}

function beltsFor(star: GalaxyStar, planetsAU: number[], frostAU: number): BeltDef[] {
  const rng = new Stream(hashInts(star.seed, SALT_BELTS));
  const out: BeltDef[] = [];
  const rock: RGB[] = [[0.3, 0.27, 0.24], [0.34, 0.26, 0.2], [0.26, 0.26, 0.28], [0.4, 0.34, 0.27]];
  const ice: RGB[] = [[0.5, 0.56, 0.64], [0.45, 0.5, 0.56]];
  // The widest gap between neighbouring planets can hold a belt.
  let bestGap = -1;
  let bestRatio = 1.8;
  for (let i = 0; i + 1 < planetsAU.length; i++) {
    const ratio = planetsAU[i + 1]! / planetsAU[i]!;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestGap = i;
    }
  }
  if (bestGap >= 0 && rng.chance(0.65)) {
    const a = planetsAU[bestGap]!;
    const b = planetsAU[bestGap + 1]!;
    const cold = Math.sqrt(a * b) > frostAU;
    out.push({
      name: 'MAIN BELT',
      innerAU: round(a * Math.pow(bestRatio, 0.3), 2),
      outerAU: round(b / Math.pow(bestRatio, 0.3), 2),
      count: rng.int(3500, 5500),
      thickness: round(rng.range(0.03, 0.08), 3),
      color: cold ? rng.pick(ice) : rng.pick(rock),
      sizeMin: 8,
      sizeMax: round(rng.range(60, 110), 0),
      seed: rng.seed(),
    });
  }
  const outer = planetsAU[planetsAU.length - 1] ?? 3;
  if (rng.chance(0.35)) {
    out.push({
      name: 'OUTER BELT',
      innerAU: round(outer * rng.range(1.9, 2.3), 1),
      outerAU: round(outer * rng.range(3.0, 3.8), 1),
      count: rng.int(1800, 3000),
      thickness: round(rng.range(0.08, 0.16), 3),
      color: rng.pick(ice),
      sizeMin: 10,
      sizeMax: round(rng.range(70, 130), 0),
      seed: rng.seed(),
    });
  }
  return out;
}

function cometsFor(star: GalaxyStar, planetsAU: number[], luminosity: number): CometDef[] {
  const rng = new Stream(hashInts(star.seed, SALT_COMETS));
  const count = rng.chance(0.45) ? (rng.chance(0.3) ? 2 : 1) : 0;
  const out: CometDef[] = [];
  const reach = Math.max(2, planetsAU[planetsAU.length - 1] ?? 3);
  for (let i = 0; i < count; i++) {
    const aAU = reach * rng.range(1.5, 3.5);
    const e = rng.range(0.9, 0.975);
    const q = aAU * (1 - e);
    const a = aAU * AU;
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / (6.674e-11 * 1.989e30 * Math.max(0.2, Math.sqrt(luminosity))));
    out.push({
      id: `comet${i + 1}`,
      name: `Comet ${String.fromCharCode(65 + Math.floor(rng.r() * 26))}${rng.int(10, 99)}`,
      seed: rng.seed(),
      orbit: {
        semiMajorAxis: a,
        eccentricity: round(e, 4),
        inclination: round(rng.range(0, 60) * DEG, 4),
        ascendingNode: round(rng.range(0, Math.PI * 2), 3),
        argPeriapsis: round(rng.range(0, Math.PI * 2), 3),
        // Inbound: a small negative mean anomaly.
        meanAnomalyAtEpoch: round(-rng.range(0.03, 0.25), 3),
        period: period * (rng.chance(0.15) ? -1 : 1),
      },
      nucleusRadius: round(rng.range(4000, 9000), 0),
      tailAU: round(Math.max(0.2, Math.min(0.6, 0.5 * Math.sqrt(luminosity) + 0.1)) * rng.range(0.8, 1.2), 2),
      activityAU: round(Math.max(1.5, q * 4 + 1.2 * Math.sqrt(luminosity)), 2),
      ionColor: rng.chance(0.2) ? [0.5, 1.0, 0.65] : [0.35, 0.62, 1.0],
      dustColor: rng.chance(0.3) ? [1.0, 0.8, 0.6] : [1.0, 0.96, 0.88],
    });
  }
  return out;
}

function companionFor(star: GalaxyStar, primary: BodyDef, outerPlanetAU: number): BodyDef | null {
  if (!isBinaryStar(star)) return null;
  const rng = new Stream(hashInts(star.seed, SALT_BINARY, 0x77));
  const ps = primary.star!;
  const outerGame = outerPlanetAU * AU * GAME_ORBIT_SCALE;
  const distance = Math.max(COMPANION_MIN, outerGame * rng.range(2.4, 3.2));
  if (distance > COMPANION_MAX) return null;
  // A different star: cooler and redder, or sometimes a small hot white dwarf.
  const hot = rng.chance(0.25);
  const color: RGB = hot
    ? [round(0.82 + rng.range(0, 0.1)), round(0.9 + rng.range(0, 0.07)), 1]
    : [1, round(rng.range(0.62, 0.8)), round(rng.range(0.38, 0.55))];
  const radius = (hot ? rng.range(0.012, 0.03) : rng.range(0.35, 0.9)) * SOLAR_RADIUS;
  // Game size stays sun like for the eye whatever the real radius.
  const visualRadius = Math.max(radius * GAME_STAR_SCALE, hot ? 1.4e6 : 2.0e6);
  const realA = distance / GAME_ORBIT_SCALE;
  const period = 2 * Math.PI * Math.sqrt((realA * realA * realA) / (6.674e-11 * 2.4e30));
  return {
    id: 'starb',
    name: `${primary.name} B`,
    kind: 'star',
    parentId: primary.id,
    seed: rng.seed(),
    physical: { radius, surfaceGravity: hot ? 120 : 20, rotationPeriod: rng.range(5, 30) * 86400, axialTilt: 0 },
    orbit: {
      semiMajorAxis: realA,
      eccentricity: round(rng.range(0.05, 0.3), 3),
      inclination: round(rng.range(0, 20) * DEG, 4),
      ascendingNode: round(rng.range(0, Math.PI * 2), 3),
      argPeriapsis: round(rng.range(0, Math.PI * 2), 3),
      meanAnomalyAtEpoch: round(rng.range(0, Math.PI * 2), 3),
      period,
    },
    visual: { color, radius: visualRadius, orbitDistance: distance, soiFactor: 6, minApparentSize: 0.02 },
    star: { color, intensity: round(ps.intensity * (hot ? 0.8 : rng.range(0.25, 0.6)), 2), coronaSize: hot ? 7.5 : 6.5 },
    info: {
      type: hot ? 'White dwarf companion' : 'Companion star',
      atmosphere: 'Plasma',
      temperature: hot ? '9000 °C' : '3500 °C',
      features: ['Second sun', 'Long orbit'],
      summary: `A second sun that circles ${primary.name} far beyond the planets.`,
    },
  };
}

/** Adds belts, comets, sky and the optional companion to a freshly generated system. */
export function addSpaceScenery(sys: StarSystemDef, star: GalaxyStar, luminosity: number): StarSystemDef {
  const primary = sys.bodies[0]!;
  const planetsAU = sys.bodies
    .filter((b) => b.parentId === primary.id && b.orbit && b.kind !== 'star')
    .map((b) => b.orbit!.semiMajorAxis / AU)
    .sort((a, b) => a - b);
  const frostAU = 2.7 * Math.sqrt(luminosity);
  const belts = beltsFor(star, planetsAU, frostAU);
  const comets = cometsFor(star, planetsAU, luminosity);
  const companion = companionFor(star, primary, planetsAU[planetsAU.length - 1] ?? 3);
  return {
    ...sys,
    bodies: companion ? [...sys.bodies, companion] : sys.bodies,
    ...(belts.length ? { belts } : {}),
    ...(comets.length ? { comets } : {}),
    sky: skyFor(star),
  };
}
