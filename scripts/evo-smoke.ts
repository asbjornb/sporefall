/**
 * Smoke test for the evolutionary sim's core: pick a few hand-rolled genotypes,
 * run matches, confirm the agent doesn't deadlock and produces a winner.
 * Run: npx tsx scripts/evo-smoke.ts
 */

import { runMatch, runPair } from "../src/evo/match";
import { describeGenotype, type Genotype } from "../src/evo/genotype";

const hyphaeRush: Genotype = {
  id: "hyp-rush",
  genes: [
    { kind: "build", structure: "hyphae" },
    { kind: "build", structure: "hyphae" },
    { kind: "build", structure: "hyphae" },
    { kind: "upgrade", target: "hyphae", ordinal: 1 },
    { kind: "build", structure: "hyphae" },
    { kind: "upgrade", target: "hyphae", ordinal: 2 },
  ],
};

const decomEco: Genotype = {
  id: "dec-eco",
  genes: [
    { kind: "build", structure: "hyphae" },
    { kind: "build", structure: "decomposer" },
    { kind: "build", structure: "decomposer" },
    { kind: "build", structure: "fruiting" },
    { kind: "upgrade", target: "fruiting", ordinal: 1 },
  ],
};

const unreachable: Genotype = {
  id: "bad",
  genes: [
    // Upgrade that references a structure that'll never exist.
    { kind: "upgrade", target: "rhizomorph", ordinal: 3 },
    { kind: "build", structure: "hyphae" },
    { kind: "build", structure: "hyphae" },
  ],
};

console.log("single match:", describeGenotype(hyphaeRush));
console.log("                vs ", describeGenotype(decomEco));
const m1 = runMatch(hyphaeRush, decomEco);
console.log(`  → ${m1.outcome} in ${m1.seconds.toFixed(1)}s`);

console.log("\npair (swapped sides):");
const p1 = runPair(hyphaeRush, decomEco);
console.log(`  rush=${p1.aScore} eco=${p1.bScore} games=${p1.games}`);

console.log("\nunreachable-gene agent should still play, not hang:");
const m2 = runMatch(unreachable, hyphaeRush);
console.log(`  → ${m2.outcome} in ${m2.seconds.toFixed(1)}s`);

console.log("\nmirror (should be ~50/50 over enough games):");
const p2 = runPair(hyphaeRush, hyphaeRush);
console.log(`  L=${p2.aScore} R=${p2.bScore}`);

// Sanity-check Nash + tiering on a canonical rock-paper-scissors matrix —
// the mixture should converge to ~1/3 each, and all three should end up Tier 1.
import { assignTiers, computeNashMixture } from "../src/evo/nash";

const rps = [
  [0.5, 1.0, 0.0],
  [0.0, 0.5, 1.0],
  [1.0, 0.0, 0.5],
];
const nash = computeNashMixture(rps);
const tiers = assignTiers(rps, nash);
console.log("\nRPS Nash mix:", nash.map((x) => x.toFixed(3)).join(", "));
console.log("Tiers:");
for (const t of tiers) {
  console.log(
    `  row ${t.index}: tier=${t.tier} nash=${(t.nashWeight * 100).toFixed(1)}% vs-nash=${(t.scoreVsNash * 100).toFixed(1)}%`,
  );
}

// Dominance case: row 0 strictly beats everyone else. Nash should put all weight on row 0,
// and rows 1 & 2 should be Tier 3.
const dom = [
  [0.5, 0.9, 0.8],
  [0.1, 0.5, 0.6],
  [0.2, 0.4, 0.5],
];
const domNash = computeNashMixture(dom);
const domTiers = assignTiers(dom, domNash);
console.log("\nDominance Nash mix:", domNash.map((x) => x.toFixed(3)).join(", "));
console.log("Tiers:");
for (const t of domTiers) {
  console.log(
    `  row ${t.index}: tier=${t.tier} nash=${(t.nashWeight * 100).toFixed(1)}%`,
  );
}

console.log("\nOK");
