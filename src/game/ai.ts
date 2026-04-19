import type { Command } from "./commands";
import { STRUCTURES } from "./config";
import { canBuild, canMutate } from "./sim";
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

/** Fruiting beats hyphae, hyphae beats rhizo, rhizo beats fruiting. */
function chooseCounter(
  enemyHyphae: number,
  enemyFruiting: number,
  enemyRhizo: number,
): StructureKind {
  const max = Math.max(enemyHyphae, enemyFruiting, enemyRhizo);
  if (max === 0) return "hyphae";
  if (enemyHyphae === max) return "fruiting";
  if (enemyRhizo === max) return "hyphae";
  return "rhizomorph";
}

export class SimpleAI {
  private goal: Goal | null = null;
  private cooldown = 0;
  constructor(
    private readonly side: Side,
    private readonly difficulty: AIDifficulty,
    private readonly rng: () => number,
  ) {}

  /**
   * Returns the command the AI wants to play this tick, or null. The caller
   * is responsible for applying it (typically via `applyCommand`). Pure w.r.t.
   * `state` — never mutates it. Internal cooldown/goal advance only when a
   * command is returned, so a dropped command lets the AI try again next tick.
   */
  update(state: GameState, dt: number): Command | null {
    if (state.winner) return null;
    if (state.countdown > 0) return null;
    this.cooldown -= dt;
    if (this.cooldown > 0) return null;

    if (this.difficulty === "hard") {
      return this.updateHard(state);
    }
    return this.updateEasy(state);
  }

  // ---------- easy (legacy) ----------

  private updateEasy(state: GameState): Command | null {
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
        return null;
      }
      this.goal = null;
      this.cooldown = 0.5;
      return { kind: "build", side: this.side, structure: kind };
    }

    const candidates: number[] = [];
    for (let i = 0; i < colony.slots.length; i++) {
      if (canMutate(state, this.side, i)) candidates.push(i);
    }
    if (candidates.length === 0) {
      if (this.cooldown <= 0) {
        this.goal = { kind: "build", structure: "hyphae" };
      }
      return null;
    }
    const pick = candidates[Math.floor(this.rng() * candidates.length)];
    this.goal = null;
    this.cooldown = 0.5;
    return { kind: "mutate", side: this.side, slotIdx: pick };
  }

  // ---------- hard ----------

  private updateHard(state: GameState): Command | null {
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

      if (
        colony.nutrients >= STRUCTURES[primary].cost &&
        canBuild(state, this.side, primary)
      ) {
        this.cooldown = 0.6;
        return { kind: "build", side: this.side, structure: primary };
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
        this.cooldown = 0.6;
        return { kind: "build", side: this.side, structure: alt };
      }
      // Otherwise keep saving for the primary target.
      return null;
    }

    // ---- No free slot (or something growing): consider upgrading ----
    if (underAttack) return null; // don't sink nutrients into upgrades while losing
    const slotIdx = this.bestUpgradeSlot(state, colony);
    if (slotIdx !== null) {
      this.cooldown = 0.6;
      return { kind: "mutate", side: this.side, slotIdx };
    }
    return null;
  }

  private pickBuildTarget(
    state: GameState,
    counter: StructureKind,
    underAttack: boolean,
    safe: boolean,
    decomposerCount: number,
    combatCount: number,
  ): StructureKind {
    // Forced opener: the first 2 builds are always hyphae — cheap early pressure
    // is the correct opener regardless of what the enemy is doing.
    const colony = state[this.side];
    let ownHyphae = 0;
    for (const s of colony.slots) {
      if (s && s.kind === "hyphae") ownHyphae++;
    }
    if (ownHyphae < 2 && state.time < 30) {
      return "hyphae";
    }
    // Decomposer only after the hyphae opener is down and we have ≥2 combat
    // structures — never at 0 combat, so the enemy can't walk the front in
    // uncontested while the decomposer establishes.
    if (
      !underAttack &&
      decomposerCount === 0 &&
      combatCount >= 2 &&
      state.time < 40
    ) {
      return "decomposer";
    }
    // Midgame: a second decomposer only when genuinely safe.
    if (safe && decomposerCount === 1 && state.time > 35 && state.time < 80) {
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
