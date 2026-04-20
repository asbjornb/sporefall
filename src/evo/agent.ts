import type { Command } from "../game/commands";
import { canBuild, canMutate } from "../game/sim";
import type {
  ColonyState,
  GameState,
  Side,
  Structure,
  StructureKind,
} from "../game/types";
import { isMaxed, type Gene, type Genotype } from "./genotype";

interface Match {
  structure: Structure;
  idx: number;
}

function findNthOfKind(
  colony: ColonyState,
  kind: StructureKind,
  ordinal: number,
): Match | null {
  let count = 0;
  for (let i = 0; i < colony.slots.length; i++) {
    const s = colony.slots[i];
    if (!s) continue;
    if (s.kind !== kind) continue;
    count++;
    if (count === ordinal) return { structure: s, idx: i };
  }
  return null;
}

function lowestLevelOfKind(
  colony: ColonyState,
  kind: StructureKind,
): Match | null {
  let best: Match | null = null;
  for (let i = 0; i < colony.slots.length; i++) {
    const s = colony.slots[i];
    if (!s || s.kind !== kind) continue;
    if (isMaxed(s.level)) continue;
    if (!best || s.level < best.structure.level) best = { structure: s, idx: i };
  }
  return best;
}

type Decision = Command | "wait" | "skip";

/**
 * Executes a Genotype against the sim. "Always build on the tick you can afford
 * it": each gene waits until executable, then fires. Definitively-unreachable
 * genes (no slots, missing upgrade target, maxed level) are skipped so a
 * misplaced gene doesn't deadlock the player.
 */
export class GenotypeAgent {
  private step = 0;

  constructor(
    private readonly side: Side,
    private readonly genotype: Genotype,
  ) {}

  update(state: GameState, _dt: number): Command | null {
    if (state.winner || state.countdown > 0) return null;
    const colony = state[this.side];

    // Advance through skippable genes until we hit one that can fire or must wait.
    // One command per update() call matches the premise "build as soon as
    // affordable": the match runner calls update() every tick (30 Hz).
    for (let guard = 0; guard < this.genotype.genes.length + 2; guard++) {
      const gene = this.currentGene(colony);
      if (!gene) return null;

      const decision = this.evaluate(state, colony, gene);
      if (decision === "wait") return null;
      if (decision === "skip") {
        if (this.step < this.genotype.genes.length) {
          this.step++;
          continue;
        }
        // Tail skip — nothing useful to do this tick.
        return null;
      }
      if (this.step < this.genotype.genes.length) this.step++;
      return decision;
    }
    return null;
  }

  private currentGene(colony: ColonyState): Gene | null {
    if (this.step < this.genotype.genes.length) {
      return this.genotype.genes[this.step];
    }
    // Tail: prefer building tailBuild when a slot is free; otherwise upgrade
    // the lowest-level tailUpgrade we own.
    const hasEmpty = colony.slots.some((s) => s === null);
    if (hasEmpty) {
      return { kind: "build", structure: this.genotype.tailBuild };
    }
    const target = lowestLevelOfKind(colony, this.genotype.tailUpgrade);
    if (target) {
      // Use slot-index-as-ordinal-lookup indirectly by constructing an upgrade
      // gene. evaluate() will re-find by (kind, ordinal) — compute the ordinal.
      let ordinal = 0;
      for (let i = 0; i <= target.idx; i++) {
        const s = colony.slots[i];
        if (s && s.kind === this.genotype.tailUpgrade) ordinal++;
      }
      return {
        kind: "upgrade",
        target: this.genotype.tailUpgrade,
        ordinal,
      };
    }
    return null;
  }

  private evaluate(
    state: GameState,
    colony: ColonyState,
    gene: Gene,
  ): Decision {
    if (gene.kind === "build") {
      const hasEmpty = colony.slots.some((s) => s === null);
      if (!hasEmpty) return "skip";
      // Only one structure may be "growing" at a time. Wait for it.
      const growing = colony.slots.some((s) => s && s.status === "growing");
      if (growing) return "wait";
      if (canBuild(state, this.side, gene.structure)) {
        return { kind: "build", side: this.side, structure: gene.structure };
      }
      return "wait"; // nutrients pending
    }
    // upgrade
    const found = findNthOfKind(colony, gene.target, gene.ordinal);
    if (!found) return "skip";
    if (isMaxed(found.structure.level)) return "skip";
    if (canMutate(state, this.side, found.idx)) {
      return { kind: "mutate", side: this.side, slotIdx: found.idx };
    }
    // Not executable right now: growing, mutating, disabled, or short nutrients.
    // All are transient — wait.
    return "wait";
  }
}
