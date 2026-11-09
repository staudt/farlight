/// <reference lib="webworker" />
import { type ChunkRequest, buildChunk } from './chunkBuild';
import { loadTerrainMaps } from './maps';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  if (req.mapBase) await loadTerrainMaps(req.def.terrain?.maps, req.mapBase);
  const res = buildChunk(req);
  const transfer: ArrayBuffer[] = [res.positions.buffer as ArrayBuffer, res.colors.buffer as ArrayBuffer, res.water.buffer as ArrayBuffer];
  for (const b of res.props) transfer.push(b.matrices.buffer as ArrayBuffer, b.colors.buffer as ArrayBuffer);
  ctx.postMessage(res, transfer);
};
