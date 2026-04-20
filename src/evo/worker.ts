import { setBalance, type BalanceSnapshot } from "../game/config";
import { runPair } from "./match";
import type { Genotype } from "./genotype";

export interface WorkerRequest {
  id: number;
  a: Genotype;
  b: Genotype;
  /** Balance override applied to this worker's sim before running the match. */
  balance: BalanceSnapshot;
}

export interface WorkerResponse {
  id: number;
  aScore: number;
  bScore: number;
  games: number;
}

self.addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
  const { id, a, b, balance } = ev.data;
  // Apply the balance on every request. The sim is deterministic and reads from
  // BALANCE each tick, so this guarantees the match uses the exact snapshot the
  // main thread intended regardless of how many requests this worker has seen.
  setBalance(balance);
  const { aScore, bScore, games } = runPair(a, b);
  const res: WorkerResponse = { id, aScore, bScore, games };
  (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage(res);
});
