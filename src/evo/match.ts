import { applyCommand } from "../game/commands";
import { createGameState, step } from "../game/sim";
import { GenotypeAgent } from "./agent";
import type { Genotype } from "./genotype";

const TICK_DT = 1 / 30;
const MAX_MATCH_SECONDS = 300;

export type Outcome = "left" | "right" | "draw";

export interface MatchResult {
  outcome: Outcome;
  seconds: number;
}

export function runMatch(
  leftGeno: Genotype,
  rightGeno: Genotype,
): MatchResult {
  const state = createGameState();
  const leftAgent = new GenotypeAgent("left", leftGeno);
  const rightAgent = new GenotypeAgent("right", rightGeno);
  while (!state.winner && state.time < MAX_MATCH_SECONDS) {
    step(state, TICK_DT);
    const lcmd = leftAgent.update(state, TICK_DT);
    if (lcmd) applyCommand(state, lcmd);
    const rcmd = rightAgent.update(state, TICK_DT);
    if (rcmd) applyCommand(state, rcmd);
  }
  return {
    outcome: state.winner ?? "draw",
    seconds: state.time,
  };
}

/**
 * Plays two games, one with each side swap, so first-move advantage cancels.
 * Scores are from `a`'s perspective: win = 1, draw = 0.5, loss = 0.
 */
export function runPair(a: Genotype, b: Genotype): { aScore: number; bScore: number; games: 2 } {
  let aScore = 0;
  let bScore = 0;
  for (let i = 0; i < 2; i++) {
    const swap = i === 1;
    const left = swap ? b : a;
    const right = swap ? a : b;
    const res = runMatch(left, right);
    if (res.outcome === "draw") {
      aScore += 0.5;
      bScore += 0.5;
    } else {
      const aWon =
        (res.outcome === "left" && !swap) ||
        (res.outcome === "right" && swap);
      if (aWon) aScore++;
      else bScore++;
    }
  }
  return { aScore, bScore, games: 2 };
}
