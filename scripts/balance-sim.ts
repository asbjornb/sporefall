/**
 * Balance simulation harness.
 *
 * Plays many headless matches between fixed strategies to surface obvious
 * balance problems (e.g. "hyphae rush always wins"). This is a stochastic
 * report, not a strict pass/fail suite — but a few hard-coded sanity bounds
 * exit non-zero so CI can catch catastrophic regressions.
 *
 * Run: npm run balance
 */

import { SimpleAI } from "../src/game/ai";
import { STRUCTURES } from "../src/game/config";
import {
  build,
  canBuild,
  canMutate,
  createGameState,
  mutate,
  step,
} from "../src/game/sim";
import type { GameState, Side, StructureKind } from "../src/game/types";

// ---------- RNG ----------

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Agents ----------

interface Agent {
  update(state: GameState, dt: number): void;
}

interface Strategy {
  name: string;
  make(side: Side, rng: () => number): Agent;
}

/**
 * Picks a single kind and only builds that. `upgrade` toggles whether it
 * also spends on mutations — a "rush" variant leaves upgrade off and just
 * fills slots with the cheapest unit as fast as possible.
 */
class MonoAgent implements Agent {
  private cooldown = 0;
  constructor(
    private readonly side: Side,
    private readonly kind: StructureKind,
    private readonly upgrade: boolean,
  ) {}

  update(state: GameState, dt: number): void {
    if (state.winner || state.countdown > 0) return;
    this.cooldown -= dt;
    if (this.cooldown > 0) return;

    const colony = state[this.side];
    // Don't queue more work while something is establishing.
    if (colony.slots.some((s) => s && s.status === "growing")) return;

    if (canBuild(state, this.side, this.kind)) {
      if (build(state, this.side, this.kind)) {
        this.cooldown = 0.4;
        return;
      }
    }

    if (!this.upgrade) return;

    // Upgrade the lowest-level matching slot we can afford.
    let bestIdx: number | null = null;
    let bestLevel = Infinity;
    for (let i = 0; i < colony.slots.length; i++) {
      const s = colony.slots[i];
      if (!s || s.kind !== this.kind) continue;
      if (!canMutate(state, this.side, i)) continue;
      if (s.level < bestLevel) {
        bestLevel = s.level;
        bestIdx = i;
      }
    }
    if (bestIdx !== null && mutate(state, this.side, bestIdx)) {
      this.cooldown = 0.4;
    }
  }
}

// ---------- Strategies ----------

const MONO_KINDS: StructureKind[] = [
  "hyphae",
  "rhizomorph",
  "fruiting",
  "decomposer",
];

const STRATEGIES: Strategy[] = [
  ...MONO_KINDS.map<Strategy>((k) => ({
    name: `mono-${k}`,
    make: (side) => new MonoAgent(side, k, true),
  })),
  {
    name: "hyphae-rush",
    make: (side) => new MonoAgent(side, "hyphae", false),
  },
  {
    name: "hard-ai",
    make: (side, rng) => new SimpleAI(side, "hard", rng),
  },
];

// ---------- Match runner ----------

const TICK_DT = 1 / 30;
const MAX_MATCH_SECONDS = 300; // 5 minutes of sim time — draws past this

type Outcome = "left" | "right" | "draw";

function runMatch(
  left: Strategy,
  right: Strategy,
  seed: number,
): { winner: Outcome; seconds: number } {
  const state = createGameState();
  const leftAgent = left.make("left", mulberry32(seed * 2 + 1));
  const rightAgent = right.make("right", mulberry32(seed * 2 + 2));
  while (!state.winner && state.time < MAX_MATCH_SECONDS) {
    step(state, TICK_DT);
    leftAgent.update(state, TICK_DT);
    rightAgent.update(state, TICK_DT);
  }
  return {
    winner: state.winner ?? "draw",
    seconds: state.time,
  };
}

interface SeriesResult {
  aWins: number;
  bWins: number;
  draws: number;
  games: number;
  avgSeconds: number;
}

/** Play `games` matches, swapping sides each pair so side bias cancels. */
function runSeries(a: Strategy, b: Strategy, games: number, seedBase: number): SeriesResult {
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let totalSeconds = 0;
  for (let i = 0; i < games; i++) {
    const swap = i % 2 === 1;
    const left = swap ? b : a;
    const right = swap ? a : b;
    const result = runMatch(left, right, seedBase + i);
    totalSeconds += result.seconds;
    if (result.winner === "draw") {
      draws++;
    } else {
      const winnerIsA = (result.winner === "left" && !swap) ||
        (result.winner === "right" && swap);
      if (winnerIsA) aWins++;
      else bWins++;
    }
  }
  return { aWins, bWins, draws, games, avgSeconds: totalSeconds / games };
}

// ---------- Report ----------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}

function printMatrix(
  strategies: Strategy[],
  matrix: Map<string, SeriesResult>,
): void {
  const nameW = Math.max(...strategies.map((s) => s.name.length), 10);
  const header = pad("", nameW) + "  " +
    strategies.map((s) => pad(s.name, 12)).join(" ");
  console.log(header);
  for (const row of strategies) {
    const cells: string[] = [];
    for (const col of strategies) {
      if (row === col) {
        cells.push(pad("  --  ", 12));
        continue;
      }
      const key = `${row.name}|${col.name}`;
      const r = matrix.get(key);
      if (!r) {
        cells.push(pad("   ?   ", 12));
        continue;
      }
      const wr = r.aWins / r.games;
      cells.push(pad(pct(wr), 12));
    }
    console.log(pad(row.name, nameW) + "  " + cells.join(" "));
  }
  console.log("\n(cell = row's win rate when playing against column)");
}

// ---------- Main ----------

const GAMES_PER_PAIRING = 40;
const BASE_SEED = 0xc0ffee;

// SimpleAI hard must crush single-note strategies by this margin, or something
// is badly out of tune. 80% per the design spec.
const MIN_HARD_VS_MONO = 0.8;
// Mirrors should be roughly even — any wider than this probably means side
// bias in the sim (e.g. a rule that only fires on one side).
const MAX_MIRROR_DEVIATION = 0.15;

console.log(
  `Balance sim: ${GAMES_PER_PAIRING} games per pairing, ` +
    `max ${MAX_MATCH_SECONDS}s each, seed=${BASE_SEED.toString(16)}`,
);
console.log("Structure costs:");
for (const k of MONO_KINDS) {
  const c = STRUCTURES[k];
  console.log(
    `  ${pad(k, 12)} cost=${c.cost}  pressure=${c.basePressure}  income+=${c.incomeBonus}`,
  );
}
console.log();

const matrix = new Map<string, SeriesResult>();
let pairingIdx = 0;
for (let i = 0; i < STRATEGIES.length; i++) {
  for (let j = 0; j < STRATEGIES.length; j++) {
    if (i === j) continue; // skip self — mirrors handled below with more games
    const a = STRATEGIES[i];
    const b = STRATEGIES[j];
    // Reuse the same seedBase for (a,b) and (b,a) so results are symmetric
    // (the cross is the same set of games viewed from the other side).
    const seedBase = BASE_SEED + Math.min(i, j) * 10000 + Math.max(i, j) * 17;
    const result = runSeries(a, b, GAMES_PER_PAIRING, seedBase);
    matrix.set(`${a.name}|${b.name}`, result);
    pairingIdx++;
  }
}

console.log("Win-rate matrix:");
printMatrix(STRATEGIES, matrix);
console.log();

// Avg match length (using hard-ai vs hard-ai as a baseline)
console.log("Sample match lengths (avg seconds):");
for (const s of STRATEGIES) {
  const other = STRATEGIES.find((x) => x.name === "hard-ai")!;
  if (s === other) continue;
  const r = matrix.get(`${s.name}|${other.name}`);
  if (r) {
    console.log(
      `  ${pad(s.name, 14)} vs hard-ai:  ${r.avgSeconds.toFixed(1)}s ` +
        `(${r.aWins}W/${r.bWins}L/${r.draws}D)`,
    );
  }
}
console.log();

// Mirror matches — run separately so we can sanity-check side balance.
console.log("Mirror matches (should be near 50%):");
const mirrorFailures: string[] = [];
for (const s of STRATEGIES) {
  const r = runSeries(s, s, GAMES_PER_PAIRING, BASE_SEED + 99999);
  const played = r.aWins + r.bWins;
  const wr = played === 0 ? 0.5 : r.aWins / played;
  const dev = Math.abs(wr - 0.5);
  const flag = dev > MAX_MIRROR_DEVIATION ? "  <-- SKEWED" : "";
  console.log(
    `  ${pad(s.name, 14)}  A=${pct(wr)}  draws=${r.draws}/${r.games}  avg=${r.avgSeconds.toFixed(1)}s${flag}`,
  );
  if (played > 0 && dev > MAX_MIRROR_DEVIATION) {
    mirrorFailures.push(`${s.name}: A-side ${pct(wr)}`);
  }
}
console.log();

// Assertions
const failures: string[] = [];
const hard = STRATEGIES.find((s) => s.name === "hard-ai")!;
for (const s of STRATEGIES) {
  if (s === hard) continue;
  const r = matrix.get(`${hard.name}|${s.name}`);
  if (!r) continue;
  const wr = r.aWins / r.games;
  if (wr < MIN_HARD_VS_MONO) {
    failures.push(
      `hard-ai only ${pct(wr)} vs ${s.name} (need >=${pct(MIN_HARD_VS_MONO)})`,
    );
  }
}
failures.push(...mirrorFailures.map((m) => `mirror skew: ${m}`));

if (failures.length > 0) {
  console.log("FAIL: balance regressions detected:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log("OK: no balance regressions detected.");
}
