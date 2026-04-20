/**
 * Nash mixture + tier assignment for a symmetric zero-sum win-rate matrix.
 *
 * For non-transitive games (rock-paper-scissors ecology), a scalar "average
 * win rate" is misleading — a strategy can beat everyone on average yet be
 * hard-countered by one specific build that nobody in the pool plays. The
 * Nash mixture is the mixed strategy a self-aware player would use if the
 * opponent also played optimally; strategies with non-trivial weight in that
 * mix are the real "Tier 1" meta.
 */

export interface TieredEntry {
  index: number;
  nashWeight: number;
  /** Win rate vs. the Nash mixture. */
  scoreVsNash: number;
  tier: 1 | 2 | 3;
}

/**
 * Fictitious play on a symmetric zero-sum matrix `M` where M[i][j] is the
 * row player's expected score against column j (points/games, 0..1).
 *
 * Returns a probability vector `p` such that every row's expected score
 * against `p` is at most `v` (the value of the game). Works well in practice
 * for small matrices (O(iterations × n²)).
 */
export function computeNashMixture(M: number[][], iterations = 4000): number[] {
  const n = M.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const p = new Array<number>(n).fill(1 / n);
  for (let t = 1; t <= iterations; t++) {
    // Best row response against current mixture p.
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
      let val = 0;
      for (let j = 0; j < n; j++) val += M[i][j] * p[j];
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const scale = t / (t + 1);
    for (let i = 0; i < n; i++) p[i] *= scale;
    p[bestIdx] += 1 / (t + 1);
  }
  return p;
}

/**
 * Tier assignment:
 *   1: appears in the Nash mix with weight ≥ `metaThreshold` — core meta.
 *   2: not in the mix, but wins ≥ `viableThreshold` vs. the mix — viable counter.
 *   3: worse than viable — fringe.
 */
export function assignTiers(
  M: number[][],
  nash: number[],
  opts: { metaThreshold?: number; viableThreshold?: number } = {},
): TieredEntry[] {
  const metaThreshold = opts.metaThreshold ?? 0.05;
  const viableThreshold = opts.viableThreshold ?? 0.45;
  const n = M.length;
  const out: TieredEntry[] = [];
  for (let i = 0; i < n; i++) {
    let scoreVsNash = 0;
    for (let j = 0; j < n; j++) scoreVsNash += M[i][j] * nash[j];
    let tier: 1 | 2 | 3;
    if (nash[i] >= metaThreshold) tier = 1;
    else if (scoreVsNash >= viableThreshold) tier = 2;
    else tier = 3;
    out.push({ index: i, nashWeight: nash[i], scoreVsNash, tier });
  }
  // Stable sort: Tier 1 first (by Nash weight desc), then Tier 2 (by scoreVsNash desc),
  // then Tier 3 (by scoreVsNash desc).
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1) return b.nashWeight - a.nashWeight;
    return b.scoreVsNash - a.scoreVsNash;
  });
  return out;
}
