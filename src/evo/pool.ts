import type { BalanceSnapshot } from "../game/config";
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
  balance: BalanceSnapshot;
  resolve: (r: PairOutcome) => void;
}

interface InflightJob {
  resolve: (r: PairOutcome) => void;
}

/**
 * Fixed-size pool of Web Workers that each play one `runPair` at a time. Jobs
 * are handed out FIFO; the pool resolves a per-job Promise when the worker
 * responds. Each request carries a balance snapshot that the worker applies
 * before running — workers are stateless from the pool's perspective.
 */
export class WorkerPool {
  private workers: Worker[];
  private idle: Worker[];
  private queue: PendingJob[] = [];
  private inflight = new Map<Worker, InflightJob>();
  private nextId = 1;
  private getBalance: () => BalanceSnapshot;

  constructor(size: number, getBalance: () => BalanceSnapshot) {
    this.getBalance = getBalance;
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
      // Snapshot balance at enqueue time so mid-generation tweaks can't split
      // a run across two configurations.
      this.queue.push({ a, b, balance: this.getBalance(), resolve });
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
      const req: WorkerRequest = {
        id: this.nextId++,
        a: job.a,
        b: job.b,
        balance: job.balance,
      };
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
