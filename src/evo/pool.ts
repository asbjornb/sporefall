import type { Genotype } from "./genotype";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface PairOutcome {
  aScore: number;
  bScore: number;
  games: number;
}

interface PendingJob {
  a: Genotype;
  b: Genotype;
  resolve: (r: PairOutcome) => void;
}

interface InflightJob {
  resolve: (r: PairOutcome) => void;
}

/**
 * Fixed-size pool of Web Workers that each play one `runPair` at a time. Jobs
 * are handed out FIFO; the pool resolves a per-job Promise when the worker
 * responds. Nothing fancier — generations are small and bursty, so fairness and
 * backpressure from the caller are enough.
 */
export class WorkerPool {
  private workers: Worker[];
  private idle: Worker[];
  private queue: PendingJob[] = [];
  private inflight = new Map<Worker, InflightJob>();
  private nextId = 1;

  constructor(size: number) {
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      w.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
        this.onMessage(w, ev.data);
      });
      this.workers.push(w);
    }
    this.idle = this.workers.slice();
  }

  get size(): number {
    return this.workers.length;
  }

  runPair(a: Genotype, b: Genotype): Promise<PairOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ a, b, resolve });
      this.pump();
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.inflight.clear();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.inflight.set(w, { resolve: job.resolve });
      const req: WorkerRequest = { id: this.nextId++, a: job.a, b: job.b };
      w.postMessage(req);
    }
  }

  private onMessage(w: Worker, msg: WorkerResponse): void {
    const job = this.inflight.get(w);
    if (!job) return;
    this.inflight.delete(w);
    this.idle.push(w);
    job.resolve({ aScore: msg.aScore, bScore: msg.bScore, games: msg.games });
    this.pump();
  }
}
