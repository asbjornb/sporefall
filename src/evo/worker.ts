import { runPair } from "./match";
import type { Genotype } from "./genotype";

export interface WorkerRequest {
  id: number;
  a: Genotype;
  b: Genotype;
}

export interface WorkerResponse {
  id: number;
  aScore: number;
  bScore: number;
  games: number;
}

self.addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
  const { id, a, b } = ev.data;
  const { aScore, bScore, games } = runPair(a, b);
  const res: WorkerResponse = { id, aScore, bScore, games };
  (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage(res);
});
