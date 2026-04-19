/**
 * Determinism harness.
 *
 * Runs two independent simulations from the same seed, drives both with the
 * same hard-AI agents (also seeded), and asserts their hashed states match
 * every tick. Exits non-zero on first divergence.
 *
 * This is the foundation that makes lockstep multiplayer possible — if it
 * passes, two browsers running the same Command stream will stay bit-identical.
 *
 * Run: npm run determinism-check
 */

import { SimpleAI } from "../src/game/ai";
import { applyCommand, type Command } from "../src/game/commands";
import { hashState, mulberry32 } from "../src/game/rng";
import { createGameState, step } from "../src/game/sim";
import type { GameState } from "../src/game/types";

const FIXED_DT = 1 / 30;
const TICKS = 6000; // 200 seconds of sim time at 30 Hz
const SEEDS = [0xc0ffee, 0xdecade, 0x1337, 0xfeedface, 0xa5a5a5];

interface Sim {
  state: GameState;
  leftAI: SimpleAI;
  rightAI: SimpleAI;
}

function makeSim(matchSeed: number): Sim {
  return {
    state: createGameState(),
    // Per-side seeds are derived deterministically from the match seed so the
    // pair of (state, ai-rng-stream) is identical across instances.
    leftAI: new SimpleAI("left", "hard", mulberry32((matchSeed * 2 + 1) >>> 0)),
    rightAI: new SimpleAI(
      "right",
      "hard",
      mulberry32((matchSeed * 2 + 2) >>> 0),
    ),
  };
}

function tick(sim: Sim): void {
  step(sim.state, FIXED_DT);
  // Order matters: apply both sides' commands in a fixed order so the same
  // input sequence yields the same state regardless of where the sim runs.
  const lcmd: Command | null = sim.leftAI.update(sim.state, FIXED_DT);
  if (lcmd) applyCommand(sim.state, lcmd);
  const rcmd: Command | null = sim.rightAI.update(sim.state, FIXED_DT);
  if (rcmd) applyCommand(sim.state, rcmd);
}

function runOne(seed: number): boolean {
  const a = makeSim(seed);
  const b = makeSim(seed);
  for (let t = 0; t < TICKS; t++) {
    tick(a);
    tick(b);
    const ha = hashState(a.state);
    const hb = hashState(b.state);
    if (ha !== hb) {
      console.log(`FAIL seed=0x${seed.toString(16)} tick=${t}`);
      console.log(`  A: ${ha}`);
      console.log(`  B: ${hb}`);
      return false;
    }
    if (a.state.winner) {
      // Match resolved early — that's fine, just stop comparing.
      break;
    }
  }
  return true;
}

let ok = true;
for (const seed of SEEDS) {
  const passed = runOne(seed);
  const finalHash = hashState(makeSimReplay(seed).state);
  console.log(
    `  seed=0x${seed.toString(16).padStart(8, "0")}  ${passed ? "OK " : "FAIL"}  final=${finalHash.slice(0, 32)}…`,
  );
  if (!passed) ok = false;
}

function makeSimReplay(seed: number): Sim {
  const sim = makeSim(seed);
  for (let t = 0; t < TICKS; t++) {
    tick(sim);
    if (sim.state.winner) break;
  }
  return sim;
}

if (!ok) {
  console.log("\nFAIL: determinism check found a divergence.");
  process.exit(1);
}
console.log(`\nOK: ${SEEDS.length} seeds × ${TICKS} ticks all matched.`);
