import { STRUCTURES } from "./config";
import { build, canBuild, canMutate, mutate } from "./sim";
import type { GameState, Side, StructureKind } from "./types";

type Goal =
  | { kind: "build"; structure: StructureKind }
  | { kind: "mutate" };

const BUILD_WEIGHTS: { structure: StructureKind; weight: number }[] = [
  { structure: "hyphae", weight: 4 },
  { structure: "rhizomorph", weight: 3 },
  { structure: "fruiting", weight: 2 },
  { structure: "decomposer", weight: 2 },
];

function pickGoal(rng: () => number): Goal {
  // ~20% chance to try to upgrade something, otherwise pick a structure.
  if (rng() < 0.2) return { kind: "mutate" };
  const total = BUILD_WEIGHTS.reduce((a, b) => a + b.weight, 0);
  let r = rng() * total;
  for (const g of BUILD_WEIGHTS) {
    r -= g.weight;
    if (r <= 0) return { kind: "build", structure: g.structure };
  }
  return { kind: "build", structure: "hyphae" };
}

export class SimpleAI {
  private goal: Goal | null = null;
  private cooldown = 0;
  constructor(
    private readonly side: Side,
    private readonly rng: () => number = Math.random,
  ) {}

  update(state: GameState, dt: number): void {
    if (state.winner) return;
    if (state.countdown > 0) return;
    this.cooldown -= dt;
    if (!this.goal) this.goal = pickGoal(this.rng);

    const colony = state[this.side];

    if (this.goal.kind === "build") {
      const kind = this.goal.structure;
      if (!canBuild(state, this.side, kind)) {
        // No empty slot? Switch to mutate goal.
        if (!colony.slots.some((s) => s === null)) {
          this.goal = { kind: "mutate" };
        } else if (colony.nutrients >= STRUCTURES[kind].cost * 0.99) {
          // Affordable but failed for some other reason (shouldn't happen).
          this.goal = null;
        }
        // Else: keep waiting for nutrients.
        return;
      }
      if (build(state, this.side, kind)) {
        this.goal = null;
        this.cooldown = 0.5;
      }
      return;
    }

    // mutate goal: try to upgrade any active structure we can afford
    const candidates: number[] = [];
    for (let i = 0; i < colony.slots.length; i++) {
      if (canMutate(state, this.side, i)) candidates.push(i);
    }
    if (candidates.length === 0) {
      // No active structures yet — fall back to building something cheap.
      if (this.cooldown <= 0) {
        this.goal = { kind: "build", structure: "hyphae" };
      }
      return;
    }
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    if (mutate(state, this.side, pick)) {
      this.goal = null;
      this.cooldown = 0.5;
    }
  }
}
