import { mulberry32 } from '../core/rng';

/** Seeded, pronounceable names for stars and planets. No dashes, ever. */

const ONSET = ['', '', 'k', 'v', 's', 'th', 'l', 'm', 'n', 'r', 'z', 'd', 'b', 't', 'h', 'g', 'f', 'kr', 'st', 'tr', 'vy', 'el'];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ae', 'io', 'y'];
const CODA = ['', 'n', 'r', 's', 'l', 'x', 'th', 'm', 'ra', 'la', 'na', 'ros', 'ron', 'lis', 'dor', 'ria', 'pra'];
const ENDINGS = ['os', 'on', 'a', 'is', 'ar', 'ion', 'ea', 'us', 'ia', 'or', 'ix', 'ara'];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]!;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A pretty two or three syllable name such as Asteron, Vylos or Kepra. */
export function makeName(rng: () => number): string {
  for (let tries = 0; tries < 20; tries++) {
    const syl = 1 + Math.floor(rng() * 2); // 1 or 2 body syllables, plus an ending
    let s = '';
    for (let i = 0; i < syl; i++) {
      s += pick(rng, ONSET) + pick(rng, VOWEL);
      if (i < syl - 1 && rng() < 0.4) s += pick(rng, ['n', 'r', 's', 'l', 'k', 't']);
    }
    s += rng() < 0.6 ? pick(rng, ENDINGS) : pick(rng, CODA);
    s = s.replace(/(.)\1\1+/g, '$1$1').replace(/[aeiouy]{3,}/g, (m) => m.slice(0, 2));
    if (s.length >= 4 && s.length <= 9 && /[aeiouy]/.test(s)) return cap(s);
  }
  return 'Aldera';
}

/** Names for a whole set of stars, unique within the set. */
export function makeUniqueNames(seed: number, count: number, reserved: string[] = []): string[] {
  const rng = mulberry32(seed ^ 0x5eed);
  const used = new Set(reserved);
  const out: string[] = [];
  while (out.length < count) {
    let n = makeName(rng);
    let guard = 0;
    while (used.has(n) && guard++ < 50) n = makeName(rng);
    if (used.has(n)) n = `${n}${ROMAN[out.length % ROMAN.length]}`;
    used.add(n);
    out.push(n);
  }
  return out;
}

/** Moon names: the planet name plus a lowercase letter ("Vylos b") or a roman numeral. */
export function moonName(planetName: string, index: number, style: 'letter' | 'roman'): string {
  return style === 'letter' ? `${planetName} ${String.fromCharCode(98 + index)}` : `${planetName} ${ROMAN[index] ?? index + 1}`;
}

/** Stable URL safe id piece for a body name. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
