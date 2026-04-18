import { STRUCTURES } from "./config";
import { build, canBuild, canMutate, mutate } from "./sim";
import type { ColonyState, GameState, Side, StructureKind } from "./types";

export type AIDifficulty = "easy" | "hard";

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

/** Hyphae beat fruiting, fruiting beats rhizo, rhizo beats hyphae. */
function chooseCounter(
  enemyHyphae: number,
  enemyFruiting: number,
  enemyRhizo: number,
): StructureKind {
  const max = Math.max(enemyHyphae, enemyFruiting, enemyRhizo);
  if (max === 0) return "rhizomorph";
  if (enemyFruiting === max) return "hyphae";
  if (enemyRhizo === max) return "fruiting";
  return "rhizomorph";
}

export class SimpleAI {
  private goal: Goal | null = null;
  private cooldown = 0;
  constructor(
    private readonly side: Side,
    private readonly difficulty: AIDifficulty = "easy",
    private readonly rng: () => number = Math.random,
  ) {}

  update(state: GameState, dt: number): void {
    if (state.winner) return;
    if (state.countdown > 0) return;
    this.cooldown -= dt;
    if (this.cooldown > 0) return;

    if (this.difficulty === "hard") {
      this.updateHard(state);
    } else {
      this.updateEasy(state);
    }
  }

  // ---------- easy (legacy) ----------

  private updateEasy(state: GameState): void {
    if (!this.goal) this.goal = pickGoal(this.rng);
    const colony = state[this.side];

    if (this.goal.kind === "build") {
      const kind = this.goal.structure;
      if (!canBuild(state, this.side, kind)) {
        if (!colony.slots.some((s) => s === null)) {
          this.goal = { kind: "mutate" };
        } else if (colony.nutrients >= STRUCTURES[kind].cost * 0.99) {
          this.goal = null;
        }
        return;
      }
      if (build(state, this.side, kind)) {
        this.goal = null;
        this.cooldown = 0.5;
      }
      return;
    }

    const candidates: number[] = [];
    for (let i = 0; i < colony.slots.length; i++) {
      if (canMutate(state, this.side, i)) candidates.push(i);
    }
    if (candidates.length === 0) {
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

  // ---------- hard ----------

  private updateHard(state: GameState): void {
    const colony = state[this.side];
    const enemy = state[this.side === "left" ? "right" : "left"];

    // 0 = front on enemy side (safe for us), 1 = front at our sclerotium (lethal).
    const frontDanger = this.side === "right" ? state.front : 1 - state.front;
    const hpFrac = colony.hp / Math.max(1, colony.maxHp);
    const underAttack = frontDanger > 0.55 || hpFrac < 0.6;
    const safe = frontDanger < 0.4 && hpFrac > 0.85;

    // Our inventory
    let decomposerCount = 0;
    let combatCount = 0;
    let hasEmptySlot = false;
    let hasGrowing = false;
    for (const s of colony.slots) {
      if (s === null) hasEmptySlot = true;
      else {
        if (s.kind === "decomposer") decomposerCount++;
        else combatCount++;
        if (s.status === "growing") hasGrowing = true;
      }
    }

    // Enemy inventory — active-ish structures count more than growing ones.
    let eHyphae = 0,
      eFruiting = 0,
      eRhizo = 0;
    for (const s of enemy.slots) {
      if (!s) continue;
      const weight = s.status === "active" ? 2 : 1;
      if (s.kind === "hyphae") eHyphae += weight;
      else if (s.kind === "fruiting") eFruiting += weight;
      else if (s.kind === "rhizomorph") eRhizo += weight;
    }
    const counter = chooseCounter(eHyphae, eFruiting, eRhizo);

    // ---- Try to build ----
    if (hasEmptySlot && !hasGrowing) {
      const primary = this.pickBuildTarget(
        state,
        counter,
        underAttack,
        safe,
        decomposerCount,
        combatCount,
      );

      if (colony.nutrients >= STRUCTURES[primary].cost) {
        if (build(state, this.side, primary)) {
          this.cooldown = 0.6;
          return;
        }
      }

      // Don't over-save. If we can already afford a useful non-economy
      // structure (counter first, then strongest affordable), and the
      // primary target is more expensive, buy the alternative.
      const alt = this.pickAffordableFallback(
        colony,
        primary,
        counter,
        underAttack,
      );
      if (alt && canBuild(state, this.side, alt)) {
        if (build(state, this.side, alt)) {
          this.cooldown = 0.6;
          return;
        }
      }
      // Otherwise keep saving for the primary target.
      return;
    }

    // ---- No free slot (or something growing): consider upgrading ----
    if (underAttack) return; // don't sink nutrients into upgrades while losing
    const slotIdx = this.bestUpgradeSlot(state, colony);
    if (slotIdx !== null && mutate(state, this.side, slotIdx)) {
      this.cooldown = 0.6;
    }
  }

  private pickBuildTarget(
    state: GameState,
    counter: StructureKind,
    underAttack: boolean,
    safe: boolean,
    decomposerCount: number,
    combatCount: number,
  ): StructureKind {
    // Never open with the decomposer: it costs 40 and takes 16s with 0
    // pressure, so the enemy walks the front in uncontested. Instead, build
    // a first decomposer only once we already have a couple of combat
    // structures to upgrade while it establishes.
    if (
      !underAttack &&
      decomposerCount === 0 &&
      combatCount >= 2 &&
      state.time < 40
    ) {
      return "decomposer";
    }
    // Midgame: a second decomposer only when genuinely safe.
    if (safe && decomposerCount === 1 && state.time > 25 && state.time < 70) {
      return "decomposer";
    }
    // Otherwise, counter the enemy's current composition.
    return counter;
  }

  private pickAffordableFallback(
    colony: ColonyState,
    primary: StructureKind,
    counter: StructureKind,
    underAttack: boolean,
  ): StructureKind | null {
    // If the counter is already affordable and primary is something else
    // (e.g. we wanted a decomposer), buy the counter right now.
    if (
      counter !== primary &&
      colony.nutrients >= STRUCTURES[counter].cost
    ) {
      return counter;
    }
    // Under attack: never sit on nutrients — buy the strongest affordable
    // combat structure rather than saving for the pricey ideal.
    if (underAttack) {
      const order: StructureKind[] = ["fruiting", "rhizomorph", "hyphae"];
      for (const k of order) {
        if (colony.nutrients >= STRUCTURES[k].cost) return k;
      }
    }
    return null;
  }

  private bestUpgradeSlot(state: GameState, colony: ColonyState): number | null {
    let bestIdx: number | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < colony.slots.length; i++) {
      if (!canMutate(state, this.side, i)) continue;
      const s = colony.slots[i]!;
      let score = 0;
      if (s.kind === "fruiting") score += 4;
      else if (s.kind === "rhizomorph") score += 3;
      else if (s.kind === "hyphae") score += 2;
      else if (s.kind === "decomposer") {
        // A single level-2 decomposer is fine; anything beyond is wasteful.
        if (s.level >= 2) continue;
        score += 1;
      }
      // Prefer lower-level structures first — more value per upgrade.
      score -= s.level * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}
