import { mulberry32 } from "../game/rng";
import {
  crossover,
  mutate,
  randomGenotype,
  type Genotype,
} from "./genotype";
import type { WorkerPool } from "./pool";

export interface EvoConfig {
  populationSize: number;
  /** Elites kept unchanged across generations. Must be ≥ 2 for breeding. */
  elites: number;
  /** How many of the best-ever individuals are used as gauntlet opponents. */
  hallOfFameSize: number;
  /** Tournament size when selecting parents. */
  tournamentSize: number;
  /** Cap on genome length to prevent bloat. */
  maxGenes: number;
}

export const DEFAULT_CONFIG: EvoConfig = {
  populationSize: 24,
  elites: 4,
  hallOfFameSize: 6,
  tournamentSize: 3,
  maxGenes: 24,
};

export interface Evaluated {
  genotype: Genotype;
  score: number;
  games: number;
}

export interface GenerationResult {
  generation: number;
  evaluated: Evaluated[];
  hallOfFame: Evaluated[];
  /** Number of (a,b) pair evaluations played this generation. */
  pairsPlayed: number;
}

/** Deep-clone via JSON. Genotypes are plain data so this is safe and cheap. */
function cloneGenotype(g: Genotype): Genotype {
  return JSON.parse(JSON.stringify(g));
}

/**
 * Evolutionary loop. Each generation:
 *   1. Round-robin the current population (1 pair per unordered combination).
 *   2. Every individual also plays each hall-of-famer.
 *   3. Score = total points / total games.
 *   4. Carry the top `elites` forward, breed the rest via tournament-selected
 *      crossover + one mutation.
 *   5. Merge the generation's best into the hall of fame (dedup + cap).
 */
export class GA {
  private population: Genotype[];
  private hallOfFame: Evaluated[] = [];
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

  getHallOfFame(): readonly Evaluated[] {
    return this.hallOfFame;
  }

  /**
   * Runs one full generation. `onProgress` (if provided) is called with a
   * 0..1 fraction as pair results land — useful for a UI progress bar.
   */
  async runGeneration(
    onProgress?: (done: number, total: number) => void,
  ): Promise<GenerationResult> {
    this.generation++;
    const pop = this.population;
    const scores = new Map<string, { points: number; games: number }>();
    for (const g of pop) scores.set(g.id, { points: 0, games: 0 });
    for (const hof of this.hallOfFame) {
      if (!scores.has(hof.genotype.id)) {
        scores.set(hof.genotype.id, { points: 0, games: 0 });
      }
    }

    // Build pair list: all (i<j) intra-population pairs, plus (pop × hof).
    interface Pair {
      aId: string;
      bId: string;
      a: Genotype;
      b: Genotype;
    }
    const pairs: Pair[] = [];
    for (let i = 0; i < pop.length; i++) {
      for (let j = i + 1; j < pop.length; j++) {
        pairs.push({
          aId: pop[i].id,
          bId: pop[j].id,
          a: pop[i],
          b: pop[j],
        });
      }
    }
    for (const popMember of pop) {
      for (const hof of this.hallOfFame) {
        if (hof.genotype.id === popMember.id) continue;
        pairs.push({
          aId: popMember.id,
          bId: hof.genotype.id,
          a: popMember,
          b: hof.genotype,
        });
      }
    }

    let done = 0;
    const total = pairs.length;
    onProgress?.(0, total);

    // Dispatch all pairs concurrently — the pool queues excess.
    await Promise.all(
      pairs.map(async (p) => {
        const r = await this.pool.runPair(p.a, p.b);
        const aRec = scores.get(p.aId);
        const bRec = scores.get(p.bId);
        if (aRec) {
          aRec.points += r.aScore;
          aRec.games += r.games;
        }
        if (bRec) {
          bRec.points += r.bScore;
          bRec.games += r.games;
        }
        done++;
        onProgress?.(done, total);
      }),
    );

    const evaluated: Evaluated[] = pop
      .map((g) => {
        const rec = scores.get(g.id)!;
        return {
          genotype: g,
          score: rec.games > 0 ? rec.points / rec.games : 0,
          games: rec.games,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Update hall of fame: add top of current gen, dedup by id, keep best N.
    const hofCandidates = [
      ...this.hallOfFame,
      ...evaluated.slice(0, Math.min(3, evaluated.length)).map((e) => ({
        genotype: cloneGenotype(e.genotype),
        score: e.score,
        games: e.games,
      })),
    ];
    // Re-score HoF using this gen's score is wrong across generations — keep
    // their most recent score purely as a tiebreak for eviction.
    const seen = new Set<string>();
    const dedup: Evaluated[] = [];
    for (const c of hofCandidates) {
      if (seen.has(c.genotype.id)) continue;
      seen.add(c.genotype.id);
      dedup.push(c);
    }
    dedup.sort((a, b) => b.score - a.score);
    this.hallOfFame = dedup.slice(0, this.config.hallOfFameSize);

    // Breed next generation.
    this.population = this.breed(evaluated);

    return {
      generation: this.generation,
      evaluated,
      hallOfFame: this.hallOfFame.slice(),
      pairsPlayed: total,
    };
  }

  private breed(evaluated: Evaluated[]): Genotype[] {
    const cfg = this.config;
    const next: Genotype[] = [];
    // Elitism — carry the top-k untouched so we never lose ground.
    for (let i = 0; i < cfg.elites && i < evaluated.length; i++) {
      next.push(cloneGenotype(evaluated[i].genotype));
    }
    while (next.length < cfg.populationSize) {
      const p1 = this.tournament(evaluated);
      const p2 = this.tournament(evaluated);
      const child = crossover(p1.genotype, p2.genotype, this.rng);
      // Always mutate — mutate() picks a single structural change internally.
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
