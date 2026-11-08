/// <reference lib="webworker" />
import { type ChunkRequest, buildChunk } from './chunkBuild';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const res = buildChunk(e.data);
  ctx.postMessage(res, [res.positions.buffer, res.colors.buffer, res.water.buffer]);
};
