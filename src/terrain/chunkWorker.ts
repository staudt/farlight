/// <reference lib="webworker" />
import { type ChunkRequest, buildChunk } from './chunkBuild';
import { loadTerrainMaps } from './maps';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  if (req.mapBase) await loadTerrainMaps(req.def.terrain?.maps, req.mapBase);
  const res = buildChunk(req);
  ctx.postMessage(res, [res.positions.buffer, res.colors.buffer, res.water.buffer]);
};
