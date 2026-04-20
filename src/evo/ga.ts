import { mulberry32 } from "../game/rng";
import {
  crossover,
  mutate,
  randomGenotype,
  type Genotype,
} from "./genotype";
import { assignTiers, computeNashMixture, type TieredEntry } from "./nash";
import type { WorkerPool } from "./pool";

export interface EvoConfig {
  populationSize: number;
  /** Elites kept unchanged across generations. Must be ≥ 2 for breeding. */
  elites: number;
  /** Cap on the Pareto-filtered hall of fame. */
  hallOfFameSize: number;
  /** Tournament size when selecting parents. */
  tournamentSize: number;
  /** Cap on genome length to prevent bloat. */
  maxGenes: number;
  /** How many top performers per generation are considered for HoF admission. */
  hofCandidatesPerGen: number;
}

export const DEFAULT_CONFIG: EvoConfig = {
  populationSize: 24,
  elites: 4,
  hallOfFameSize: 10,
  tournamentSize: 3,
  maxGenes: 24,
  hofCandidatesPerGen: 3,
};

export interface Evaluated {
  genotype: Genotype;
  /** Average win rate across all matches this individual played this generation. */
  score: number;
  games: number;
}

interface PairRecord {
  games: number;
  points: number;
}

export interface TierEntry extends TieredEntry {
  genotype: Genotype;
}

export interface GenerationResult {
  generation: number;
  evaluated: Evaluated[];
  hallOfFame: Genotype[];
  /** Tier assignment for HoF members, derived from a Nash mixture. */
  tiers: TierEntry[];
  /** Row = HoF index, col = HoF index; win rate of row vs. col (0..1). */
  matchupMatrix: number[][];
  pairsPlayed: number;
  pairsCached: number;
}

function cloneGenotype(g: Genotype): Genotype {
  return JSON.parse(JSON.stringify(g));
}

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/**
 * Evolutionary loop. Each generation:
 *   1. Play all intra-population pairs + every (pop × HoF) pair (cached results
 *      are reused — the sim is deterministic, so a given (a,b) only needs to
 *      run once).
 *   2. Score = average win rate, used for selection.
 *   3. HoF admission is Pareto-based: we take the current HoF plus the top
 *      `hofCandidatesPerGen` of this generation, build a win-rate matrix over
 *      them (filling in any missing pairs now), and keep only the non-dominated
 *      members — capped by eviction of the lowest-Nash-weight entry.
 *   4. Nash mixture + tier assignment is computed over the surviving HoF for
 *      UI display.
 *
 * Selection pressure remains scalar (avg win rate). The Nash/Pareto machinery
 * is for surfacing an MtG-style tier list, not for guiding breeding — that
 * would require a fitness change, which we can revisit once there's data.
 */
export class GA {
  private population: Genotype[];
  private hof: Genotype[] = [];
  /** Cumulative win/points per ordered (a, b) pair. Symmetric: we record both halves. */
  private matchups = new Map<string, PairRecord>();
  private readonly rng: () => number;
  public generation = 0;

  constructor(
    public readonly config: EvoConfig,
    private readonly pool: WorkerPool,
    seed: number = Date.now() & 0xffffffff,
  ) {
    this.rng = mulberry32(seed);
    this.population = [];
    for (let i = 0; i < config.populationSize; i++) {
      this.population.push(randomGenotype(this.rng));
    }
  }

  getPopulation(): readonly Genotype[] {
    return this.population;
  }

  getHallOfFame(): readonly Genotype[] {
    return this.hof;
  }

  /** Snapshot the matchup matrix as a plain object for JSON export. */
  exportMatchups(): Array<{ a: string; b: string; games: number; points: number }> {
    const out: Array<{ a: string; b: string; games: number; points: number }> = [];
    for (const [key, rec] of this.matchups) {
      const [a, b] = key.split("|");
      out.push({ a, b, games: rec.games, points: rec.points });
    }
    return out;
  }

  async runGeneration(
    onProgress?: (done: number, total: number) => void,
  ): Promise<GenerationResult> {
    this.generation++;
    const pop = this.population;

    // Build pair list. Skip any pair we've already played (sim is deterministic,
    // so re-running adds no information).
    interface Pair {
      a: Genotype;
      b: Genotype;
    }
    const pairs: Pair[] = [];
    let pairsCached = 0;

    const addPair = (a: Genotype, b: Genotype) => {
      if (a.id === b.id) return;
      if (this.matchups.has(pairKey(a.id, b.id))) {
        pairsCached++;
        return;
      }
      pairs.push({ a, b });
    };

    for (let i = 0; i < pop.length; i++) {
      for (let j = i + 1; j < pop.length; j++) addPair(pop[i], pop[j]);
    }
    for (const p of pop) {
      for (const h of this.hof) addPair(p, h);
    }

    const total = pairs.length;
    let done = 0;
    onProgress?.(0, total);

    await Promise.all(
      pairs.map(async (p) => {
        const r = await this.pool.runPair(p.a, p.b);
        this.recordPair(p.a.id, p.b.id, r.aScore, r.bScore, r.games);
        done++;
        onProgress?.(done, total);
      }),
    );

    // Score each member of the population: average win rate across all games
    // they played this generation (pop-pop + pop-HoF). Using this-gen data
    // only keeps the fitness signal consistent across runs.
    const evaluated = this.scorePopulation(pop);

    // Update HoF via Pareto front over (current HoF + top candidates of this gen).
    const candidates: Genotype[] = [
      ...this.hof,
      ...evaluated
        .slice(0, Math.min(this.config.hofCandidatesPerGen, evaluated.length))
        .map((e) => cloneGenotype(e.genotype)),
    ];
    // Fill in any missing pairs among candidates before the Pareto check —
    // dominance needs every pairwise comparison.
    const fillAdded = await this.fillMissingPairs(candidates);
    pairsCached += candidates.length * candidates.length - fillAdded;

    const M = this.buildMatrix(candidates);
    const paretoIdx = paretoFront(M);
    let keep = paretoIdx.map((i) => candidates[i]);

    // Cap HoF size. Beyond the cap, evict the lowest-Nash-weight member so we
    // preserve the strategies that actually anchor the meta.
    if (keep.length > this.config.hallOfFameSize) {
      const subM = submatrix(M, paretoIdx);
      const nash = computeNashMixture(subM);
      const ranked = keep
        .map((g, i) => ({ g, nash: nash[i] }))
        .sort((a, b) => b.nash - a.nash);
      keep = ranked.slice(0, this.config.hallOfFameSize).map((r) => r.g);
    }

    this.hof = keep;

    // Recompute matrix + Nash over the final HoF for the UI.
    const hofMatrix = this.buildMatrix(this.hof);
    const hofNash = computeNashMixture(hofMatrix);
    const tiers = assignTiers(hofMatrix, hofNash).map<TierEntry>((t) => ({
      ...t,
      genotype: this.hof[t.index],
    }));

    // Breed next generation.
    this.population = this.breed(evaluated);

    return {
      generation: this.generation,
      evaluated,
      hallOfFame: this.hof.slice(),
      tiers,
      matchupMatrix: hofMatrix,
      pairsPlayed: total + fillAdded,
      pairsCached,
    };
  }

  private recordPair(
    aId: string,
    bId: string,
    aScore: number,
    bScore: number,
    games: number,
  ): void {
    const ab = this.matchups.get(pairKey(aId, bId)) ?? { games: 0, points: 0 };
    ab.games += games;
    ab.points += aScore;
    this.matchups.set(pairKey(aId, bId), ab);
    const ba = this.matchups.get(pairKey(bId, aId)) ?? { games: 0, points: 0 };
    ba.games += games;
    ba.points += bScore;
    this.matchups.set(pairKey(bId, aId), ba);
  }

  private scorePopulation(pop: Genotype[]): Evaluated[] {
    const opponents: Genotype[] = [...pop, ...this.hof];
    const evaluated: Evaluated[] = [];
    for (const g of pop) {
      let points = 0;
      let games = 0;
      for (const o of opponents) {
        if (o.id === g.id) continue;
        const rec = this.matchups.get(pairKey(g.id, o.id));
        if (!rec) continue;
        points += rec.points;
        games += rec.games;
      }
      evaluated.push({
        genotype: g,
        score: games > 0 ? points / games : 0,
        games,
      });
    }
    evaluated.sort((a, b) => b.score - a.score);
    return evaluated;
  }

  private async fillMissingPairs(genotypes: Genotype[]): Promise<number> {
    const missing: Array<{ a: Genotype; b: Genotype }> = [];
    for (let i = 0; i < genotypes.length; i++) {
      for (let j = i + 1; j < genotypes.length; j++) {
        const a = genotypes[i];
        const b = genotypes[j];
        if (a.id === b.id) continue;
        if (!this.matchups.has(pairKey(a.id, b.id))) {
          missing.push({ a, b });
        }
      }
    }
    await Promise.all(
      missing.map(async ({ a, b }) => {
        const r = await this.pool.runPair(a, b);
        this.recordPair(a.id, b.id, r.aScore, r.bScore, r.games);
      }),
    );
    return missing.length;
  }

  private buildMatrix(genotypes: Genotype[]): number[][] {
    const n = genotypes.length;
    const M: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) {
          row.push(0.5);
          continue;
        }
        const rec = this.matchups.get(pairKey(genotypes[i].id, genotypes[j].id));
        row.push(rec && rec.games > 0 ? rec.points / rec.games : 0.5);
      }
      M.push(row);
    }
    return M;
  }

  private breed(evaluated: Evaluated[]): Genotype[] {
    const cfg = this.config;
    const next: Genotype[] = [];
    for (let i = 0; i < cfg.elites && i < evaluated.length; i++) {
      next.push(cloneGenotype(evaluated[i].genotype));
    }
    while (next.length < cfg.populationSize) {
      const p1 = this.tournament(evaluated);
      const p2 = this.tournament(evaluated);
      const child = crossover(p1.genotype, p2.genotype, this.rng);
      next.push(mutate(child, this.rng, { maxGenes: cfg.maxGenes }));
    }
    return next;
  }

  private tournament(evaluated: Evaluated[]): Evaluated {
    let best: Evaluated | null = null;
    const k = Math.min(this.config.tournamentSize, evaluated.length);
    for (let i = 0; i < k; i++) {
      const pick = evaluated[Math.floor(this.rng() * evaluated.length)];
      if (!best || pick.score > best.score) best = pick;
    }
    return best!;
  }
}

/**
 * Indices of the Pareto front: row `i` is dominated if some row `k` ≠ i has
 * `M[k][j] >= M[i][j]` for every `j` with at least one strict inequality. The
 * kept rows are non-dominated — each brings some matchup nobody else matches.
 */
function paretoFront(M: number[][]): number[] {
  const n = M.length;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    let dominated = false;
    for (let k = 0; k < n && !dominated; k++) {
      if (k === i) continue;
      let everyGe = true;
      let someGt = false;
      for (let j = 0; j < n; j++) {
        const diff = M[k][j] - M[i][j];
        // Small epsilon so near-duplicates don't both survive.
        if (diff < -1e-6) {
          everyGe = false;
          break;
        }
        if (diff > 1e-6) someGt = true;
      }
      if (everyGe && someGt) dominated = true;
    }
    if (!dominated) keep.push(i);
  }
  return keep;
}

function submatrix(M: number[][], idx: number[]): number[][] {
  return idx.map((i) => idx.map((j) => M[i][j]));
}
