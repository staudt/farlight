import type { BodyView } from '../render/context';
import { createPlanetViewFor, totalPending } from '../render/bodies/planetView';
import type { Body } from '../sim/universe';
import type { HeightSampler } from './api';
import { createHeightSampler } from './heightfield';

/** Height sampler for the sim (null when the body has no terrain). */
export function createHeightSamplerForBody(body: Body): HeightSampler | null {
  if (!body.def.terrain) return null;
  return createHeightSampler(body.def, body.radius);
}

/** Chunked LOD view for rocky bodies with terrain. */
export function createPlanetView(body: Body): BodyView | null {
  if (body.kind !== 'rocky' || !body.def.terrain) return null;
  return createPlanetViewFor(body);
}

/** Chunks queued or building, across all planets. */
export function terrainPending(): number {
  return totalPending();
}
