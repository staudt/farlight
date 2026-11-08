import type { Body } from '../../sim/universe';
import type { BodyView } from '../context';
import { createGasGiantViewFor } from './gasGiantView';

/** Procedural banded view (with rings, if any) for gas giants. */
export function createGasGiantView(body: Body): BodyView | null {
  if (body.kind !== 'gas' || !body.def.gas) return null;
  return createGasGiantViewFor(body);
}
