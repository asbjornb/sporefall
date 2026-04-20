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
    // Both agents decide from the same pre-command state, then both commands
    // apply. Commands only touch their own colony's resources, so application
    // order doesn't affect outcomes — this removes the first-mover advantage
    // that previously required a side-swap to cancel.
    const lcmd = leftAgent.update(state, TICK_DT);
    const rcmd = rightAgent.update(state, TICK_DT);
    if (lcmd) applyCommand(state, lcmd);
    if (rcmd) applyCommand(state, rcmd);
  }
  return {
    outcome: state.winner ?? "draw",
    seconds: state.time,
  };
}

/**
 * One game per pair: `runMatch` is side-symmetric, so a single game is a fair
 * measurement. Scores are from `a`'s perspective: win = 1, draw = 0.5, loss = 0.
 */
export function runPair(a: Genotype, b: Genotype): { aScore: number; bScore: number; games: 1 } {
  const res = runMatch(a, b);
  let aScore = 0;
  let bScore = 0;
  if (res.outcome === "draw") {
    aScore = 0.5;
    bScore = 0.5;
  } else if (res.outcome === "left") {
    aScore = 1;
  } else {
    bScore = 1;
  }
  return { aScore, bScore, games: 1 };
}
