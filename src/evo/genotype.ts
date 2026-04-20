import { MAX_LEVEL } from "../game/config";
import type { StructureKind } from "../game/types";

export type Gene =
  | { kind: "build"; structure: StructureKind }
  | { kind: "upgrade"; target: StructureKind; ordinal: number };

/**
 * A full strategy. `genes` is executed top-down: each gene waits until it is
 * executable (nutrients + slot available), then fires. If a gene is provably
 * unreachable (slot full forever, upgrade target doesn't exist, maxed), it is
 * skipped. Once the gene list is exhausted, `tail*` describe the steady-state
 * behavior: build `tailBuild` whenever a slot is free, otherwise upgrade the
 * lowest-level `tailUpgrade`.
 */
export interface Genotype {
  id: string;
  genes: Gene[];
  tailBuild: StructureKind;
  tailUpgrade: StructureKind;
}

export const ALL_KINDS: StructureKind[] = [
  "hyphae",
  "rhizomorph",
  "fruiting",
  "decomposer",
];

const MAX_ORDINAL = 5;

function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

function pickKind(rng: () => number): StructureKind {
  return ALL_KINDS[randInt(rng, ALL_KINDS.length)];
}

function randomGene(rng: () => number): Gene {
  if (rng() < 0.65) {
    return { kind: "build", structure: pickKind(rng) };
  }
  return {
    kind: "upgrade",
    target: pickKind(rng),
    // Bias toward lower ordinals — you're much more likely to have a 1st hyphae
    // than a 5th.
    ordinal: 1 + randInt(rng, MAX_ORDINAL),
  };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomId(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[randInt(rng, ALPHABET.length)];
  return s;
}

export interface SeedGenotypeOpts {
  minGenes?: number;
  maxGenes?: number;
}

export function randomGenotype(
  rng: () => number,
  opts: SeedGenotypeOpts = {},
): Genotype {
  const min = opts.minGenes ?? 5;
  const max = opts.maxGenes ?? 10;
  const len = min + randInt(rng, Math.max(1, max - min + 1));
  const genes: Gene[] = [];
  for (let i = 0; i < len; i++) genes.push(randomGene(rng));
  return {
    id: randomId(rng),
    genes,
    tailBuild: pickKind(rng),
    tailUpgrade: pickKind(rng),
  };
}

export interface MutateOpts {
  maxGenes?: number;
}

/**
 * Returns a new genotype. Picks exactly one structural change so parent/child
 * are close in genome-space — GA selection then decides if it was a good move.
 */
export function mutate(
  parent: Genotype,
  rng: () => number,
  opts: MutateOpts = {},
): Genotype {
  const maxGenes = opts.maxGenes ?? 24;
  const genes = parent.genes.slice();
  let tailBuild = parent.tailBuild;
  let tailUpgrade = parent.tailUpgrade;

  const roll = rng();
  if (roll < 0.3 && genes.length > 0) {
    genes[randInt(rng, genes.length)] = randomGene(rng);
  } else if (roll < 0.5 && genes.length < maxGenes) {
    const at = randInt(rng, genes.length + 1);
    genes.splice(at, 0, randomGene(rng));
  } else if (roll < 0.65 && genes.length > 1) {
    genes.splice(randInt(rng, genes.length), 1);
  } else if (roll < 0.8 && genes.length > 1) {
    const i = randInt(rng, genes.length - 1);
    [genes[i], genes[i + 1]] = [genes[i + 1], genes[i]];
  } else if (roll < 0.9) {
    tailBuild = pickKind(rng);
  } else {
    tailUpgrade = pickKind(rng);
  }

  return {
    id: randomId(rng),
    genes,
    tailBuild,
    tailUpgrade,
  };
}

/** Single-point crossover on the gene lists. Tails are picked from one parent. */
export function crossover(
  a: Genotype,
  b: Genotype,
  rng: () => number,
): Genotype {
  const cutA = randInt(rng, a.genes.length + 1);
  const cutB = randInt(rng, b.genes.length + 1);
  const genes = a.genes.slice(0, cutA).concat(b.genes.slice(cutB));
  const useA = rng() < 0.5;
  return {
    id: randomId(rng),
    genes,
    tailBuild: useA ? a.tailBuild : b.tailBuild,
    tailUpgrade: rng() < 0.5 ? a.tailUpgrade : b.tailUpgrade,
  };
}

/** Short kind → 2-char label for compact genome display. */
const KIND_SHORT: Record<StructureKind, string> = {
  hyphae: "Hy",
  rhizomorph: "Rh",
  fruiting: "Fr",
  decomposer: "De",
};

export function describeGene(g: Gene): string {
  if (g.kind === "build") return `+${KIND_SHORT[g.structure]}`;
  return `^${KIND_SHORT[g.target]}${g.ordinal}`;
}

export function describeGenotype(g: Genotype): string {
  const body = g.genes.map(describeGene).join(" ");
  return `${body} | tail +${KIND_SHORT[g.tailBuild]} ^${KIND_SHORT[g.tailUpgrade]}`;
}

/** Exported for the agent: used when deciding if an upgrade target is maxed. */
export function isMaxed(level: number): boolean {
  return level >= MAX_LEVEL;
}
