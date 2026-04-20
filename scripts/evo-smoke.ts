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
  tailBuild: "hyphae",
  tailUpgrade: "hyphae",
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
  tailBuild: "fruiting",
  tailUpgrade: "fruiting",
};

const unreachable: Genotype = {
  id: "bad",
  genes: [
    // Upgrade that references a structure that'll never exist.
    { kind: "upgrade", target: "rhizomorph", ordinal: 3 },
    { kind: "build", structure: "hyphae" },
    { kind: "build", structure: "hyphae" },
  ],
  tailBuild: "hyphae",
  tailUpgrade: "hyphae",
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

console.log("\nOK");
