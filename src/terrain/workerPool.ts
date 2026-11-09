import type { ChunkRequest, ChunkResult } from './chunkBuild';

type Job = { req: ChunkRequest; cb: (r: ChunkResult) => void };

/** Small pool of module workers building terrain chunks. */
export class ChunkWorkerPool {
  readonly size: number;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private running = new Map<Worker, Job>();

  constructor() {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.size = Math.max(1, Math.min(4, hc - 1));
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<ChunkResult>) => {
        const job = this.running.get(w);
        this.running.delete(w);
        this.idle.push(w);
        job?.cb(e.data);
        this.pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  request(req: ChunkRequest, cb: (r: ChunkResult) => void): void {
    req.mapBase ??= typeof document !== 'undefined' ? document.baseURI : undefined;
    this.queue.push({ req, cb });
    this.pump();
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.running.set(w, job);
      w.postMessage(job.req);
    }
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
  }
}

let shared: ChunkWorkerPool | null = null;
export function getWorkerPool(): ChunkWorkerPool {
  shared ??= new ChunkWorkerPool();
  return shared;
}
