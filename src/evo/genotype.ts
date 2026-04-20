import { MAX_LEVEL, SLOT_COUNT } from "../game/config";
import type { StructureKind } from "../game/types";

export type Gene =
  | { kind: "build"; structure: StructureKind }
  | { kind: "upgrade"; target: StructureKind; ordinal: number };

/**
 * A full strategy. `genes` is executed top-down: each gene waits until it is
 * executable (nutrients + slot available), then fires. The generator and
 * mutation operators only produce *reachable* genes — an upgrade always
 * references an ordinal that will exist by the time the gene fires, and
 * total builds never exceed SLOT_COUNT. Runtime skipping in the agent is
 * still a safety net (e.g. max-level reached) but should rarely trigger.
 *
 * Once `genes` is exhausted, the agent idles. This keeps selection pressure on
 * explicit build plans instead of a hard-coded infinite "tail" policy.
 */
export interface Genotype {
  id: string;
  genes: Gene[];
}

export const ALL_KINDS: StructureKind[] = [
  "hyphae",
  "rhizomorph",
  "fruiting",
  "decomposer",
];

type Counts = Record<StructureKind, number>;

function newCounts(): Counts {
  return { hyphae: 0, rhizomorph: 0, fruiting: 0, decomposer: 0 };
}

function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

function pickKind(rng: () => number): StructureKind {
  return ALL_KINDS[randInt(rng, ALL_KINDS.length)];
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomId(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[randInt(rng, ALPHABET.length)];
  return s;
}

/**
 * Generate a gene that is executable in the state produced by everything so
 * far. `counts` = how many of each kind have been built up to this point,
 * `totalBuilds` = sum (capped at SLOT_COUNT). If slots are full the gene will
 * be an upgrade; if nothing has been built yet it will be a build.
 */
function genReachable(
  rng: () => number,
  counts: Counts,
  totalBuilds: number,
): Gene {
  const canBuild = totalBuilds < SLOT_COUNT;
  const hasAnyBuilt = totalBuilds > 0;

  let doBuild: boolean;
  if (!hasAnyBuilt) doBuild = true;
  else if (!canBuild) doBuild = false;
  else doBuild = rng() < 0.6;

  if (doBuild) {
    return { kind: "build", structure: pickKind(rng) };
  }
  const candidates = ALL_KINDS.filter((k) => counts[k] > 0);
  const target = candidates[randInt(rng, candidates.length)];
  // Lower ordinals are more useful (the 1st hyphae will level up further than
  // the 5th before the match ends), so bias toward them.
  const max = counts[target];
  const biased = Math.floor(Math.pow(rng(), 1.5) * max);
  return { kind: "upgrade", target, ordinal: 1 + biased };
}

/** Walk genes left-to-right and drop any that are unreachable given prior genes. */
export function sanitize(genes: Gene[]): Gene[] {
  const counts = newCounts();
  let totalBuilds = 0;
  const out: Gene[] = [];
  for (const g of genes) {
    if (g.kind === "build") {
      if (totalBuilds >= SLOT_COUNT) continue;
      counts[g.structure]++;
      totalBuilds++;
      out.push(g);
    } else {
      if (counts[g.target] < g.ordinal) continue;
      out.push(g);
    }
  }
  return out;
}

function countsUpTo(
  genes: Gene[],
  limit: number,
): { counts: Counts; totalBuilds: number } {
  const counts = newCounts();
  let totalBuilds = 0;
  for (let i = 0; i < limit; i++) {
    const g = genes[i];
    if (g.kind === "build") {
      counts[g.structure]++;
      totalBuilds++;
    }
  }
  return { counts, totalBuilds };
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
  const counts = newCounts();
  let totalBuilds = 0;
  const genes: Gene[] = [];
  for (let i = 0; i < len; i++) {
    const g = genReachable(rng, counts, totalBuilds);
    if (g.kind === "build") {
      counts[g.structure]++;
      totalBuilds++;
    }
    genes.push(g);
  }
  return {
    id: randomId(rng),
    genes,
  };
}

export interface MutateOpts {
  maxGenes?: number;
}

/**
 * One structural edit per call. Replace/insert pick a gene that's reachable
 * *at that position*; delete/swap may make downstream genes unreachable, so
 * we sanitize the result to drop anything orphaned.
 */
export function mutate(
  parent: Genotype,
  rng: () => number,
  opts: MutateOpts = {},
): Genotype {
  const maxGenes = opts.maxGenes ?? 24;
  let genes = parent.genes.slice();

  const roll = rng();
  if (roll < 0.3 && genes.length > 0) {
    const at = randInt(rng, genes.length);
    const { counts, totalBuilds } = countsUpTo(genes, at);
    genes[at] = genReachable(rng, counts, totalBuilds);
  } else if (roll < 0.5 && genes.length < maxGenes) {
    const at = randInt(rng, genes.length + 1);
    const { counts, totalBuilds } = countsUpTo(genes, at);
    genes.splice(at, 0, genReachable(rng, counts, totalBuilds));
  } else if (roll < 0.65 && genes.length > 1) {
    genes.splice(randInt(rng, genes.length), 1);
  } else if (roll < 0.8 && genes.length > 1) {
    const i = randInt(rng, genes.length - 1);
    [genes[i], genes[i + 1]] = [genes[i + 1], genes[i]];
  } else {
    // Fresh random gene insertion (when room permits) helps maintain
    // exploration now that there is no tail policy to mutate.
    if (genes.length < maxGenes) {
      const at = randInt(rng, genes.length + 1);
      const { counts, totalBuilds } = countsUpTo(genes, at);
      genes.splice(at, 0, genReachable(rng, counts, totalBuilds));
    }
  }

  genes = sanitize(genes);

  return {
    id: randomId(rng),
    genes,
  };
}

/** Single-point crossover. Joined sequence is sanitized so the swap can't orphan upgrades. */
export function crossover(
  a: Genotype,
  b: Genotype,
  rng: () => number,
): Genotype {
  const cutA = randInt(rng, a.genes.length + 1);
  const cutB = randInt(rng, b.genes.length + 1);
  const joined = a.genes.slice(0, cutA).concat(b.genes.slice(cutB));
  const genes = sanitize(joined);
  return {
    id: randomId(rng),
    genes,
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
  return body.length > 0 ? body : "(empty)";
}

/** Exported for the agent: used when deciding if an upgrade target is maxed. */
export function isMaxed(level: number): boolean {
  return level >= MAX_LEVEL;
}
