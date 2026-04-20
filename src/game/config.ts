import type { StructureKind } from "./types";

export const SLOT_COUNT = 10;

export const START_NUTRIENTS = 40;
export const BASE_INCOME = 2; // nutrients / second
export const START_HP = 100;
/** Seconds to show a "get ready" countdown before play begins. */
export const START_COUNTDOWN = 3;

/**
 * Per-step upgrade entry. Index 0 describes the level 1→2 upgrade,
 * index 1 the 2→3 upgrade, and so on. The array length determines
 * how many upgrades a structure has; MAX_LEVEL is derived from it.
 */
export interface UpgradeStep {
  /** Nutrient cost paid to start this upgrade. */
  cost: number;
  /** Seconds the structure spends mutating. */
  time: number;
  /** Pressure multiplier applied at the resulting level (level 1 = 1.0). */
  pressureMult: number;
  /** Effect multiplier applied at the resulting level (level 1 = 1.0).
   *  Effects: rhizo dissolve, fruiting surge charge / burst,
   *  decomposer income bonus. */
  effectMult: number;
}

export interface StructureConfig {
  cost: number;
  /** Seconds to establish before the structure goes active. */
  buildTime: number;
  /** Pressure contributed while active at level 1. */
  basePressure: number;
  /** Extra nutrient income while active at level 1. Only meaningful for decomposer. */
  incomeBonus: number;
  /** Passive decay per second of a non-zero disable meter. Kind-specific toughness. */
  disableDecay: number;
  /** Upgrade table. 5 entries → max level 6 (5 upgrades). */
  upgrades: UpgradeStep[];
  label: string;
  short: string;
  color: number;
}

/**
 * Upgrade tables. Tune each row freely; entries are independent.
 *
 * Convention: the first upgrade costs the same as the build cost.
 * Subsequent upgrades cost more and grant a bigger jump in both
 * pressure and effect, so investing in a single structure feels
 * progressively more meaningful (and committal).
 */
export const STRUCTURES: Record<StructureKind, StructureConfig> = {
  hyphae: {
    cost: 25,
    buildTime: 4,
    basePressure: 3,
    incomeBonus: 0,
    disableDecay: 3,
    label: "Hyphal Mat",
    short: "Hyphae",
    color: 0x7a8a3a,
    // build cost 25 → upgrades: 20, 35, 55, 80, 110 (total 300n to max)
    upgrades: [
      { cost: 20, time: 6, pressureMult: 1.5, effectMult: 1.4 },
      { cost: 35, time: 8, pressureMult: 2.1, effectMult: 1.9 },
      { cost: 55, time: 10, pressureMult: 2.9, effectMult: 2.6 },
      { cost: 80, time: 12, pressureMult: 4.0, effectMult: 3.5 },
      { cost: 110, time: 14, pressureMult: 5.5, effectMult: 4.7 },
    ],
  },
  rhizomorph: {
    cost: 40,
    buildTime: 6,
    basePressure: 4,
    incomeBonus: 0,
    disableDecay: 5,
    label: "Rhizomorph",
    short: "Rhizo",
    color: 0xbfc4c9,
    // build cost 40 → upgrades: 40, 70, 110, 160, 220 (total 600n to max)
    upgrades: [
      { cost: 40, time: 8, pressureMult: 1.5, effectMult: 1.5 },
      { cost: 70, time: 10, pressureMult: 2.1, effectMult: 2.1 },
      { cost: 110, time: 12, pressureMult: 2.9, effectMult: 2.9 },
      { cost: 160, time: 14, pressureMult: 4.0, effectMult: 4.0 },
      { cost: 220, time: 16, pressureMult: 5.5, effectMult: 5.5 },
    ],
  },
  fruiting: {
    cost: 60,
    buildTime: 10,
    basePressure: 5,
    incomeBonus: 0,
    disableDecay: 4,
    label: "Fruiting Cluster",
    short: "Fruit",
    color: 0x8a4fa8,
    // build cost 60 → upgrades: 60, 105, 165, 240, 330 (total 900n to max)
    upgrades: [
      { cost: 60, time: 10, pressureMult: 1.5, effectMult: 1.5 },
      { cost: 105, time: 12, pressureMult: 2.1, effectMult: 2.1 },
      { cost: 165, time: 14, pressureMult: 2.9, effectMult: 2.9 },
      { cost: 240, time: 16, pressureMult: 4.0, effectMult: 4.0 },
      { cost: 330, time: 18, pressureMult: 5.5, effectMult: 5.5 },
    ],
  },
  decomposer: {
    cost: 40,
    buildTime: 16,
    basePressure: 0,
    incomeBonus: 1.5,
    disableDecay: 4,
    label: "Decomposer",
    short: "Decom",
    color: 0xc08040,
    // Decomposer has no pressure, so pressureMult is unused — kept for symmetry.
    // build cost 40 → upgrades: 40, 70, 110, 160, 220 (total 600n to max)
    upgrades: [
      { cost: 40, time: 8, pressureMult: 1.0, effectMult: 1.5 },
      { cost: 70, time: 10, pressureMult: 1.0, effectMult: 2.1 },
      { cost: 110, time: 12, pressureMult: 1.0, effectMult: 2.9 },
      { cost: 160, time: 14, pressureMult: 1.0, effectMult: 4.0 },
      { cost: 220, time: 16, pressureMult: 1.0, effectMult: 5.5 },
    ],
  },
};

/** Highest level any structure can reach. Derived from the upgrade tables. */
export const MAX_LEVEL = 1 + STRUCTURES.hyphae.upgrades.length;

/** Pressure multiplier for a structure at the given level. Level 1 = 1.0. */
export function levelPressureMult(kind: StructureKind, level: number): number {
  if (level <= 1) return 1;
  const step = STRUCTURES[kind].upgrades[level - 2];
  return step ? step.pressureMult : 1;
}

/** Effect multiplier for a structure at the given level. Level 1 = 1.0. */
export function levelEffectMult(kind: StructureKind, level: number): number {
  if (level <= 1) return 1;
  const step = STRUCTURES[kind].upgrades[level - 2];
  return step ? step.effectMult : 1;
}

/** Cost of the next upgrade for a structure at the given level, or null if maxed. */
export function nextUpgradeCost(
  kind: StructureKind,
  level: number,
): number | null {
  const step = STRUCTURES[kind].upgrades[level - 1];
  return step ? step.cost : null;
}

/** Time the next upgrade takes for a structure at the given level, or null if maxed. */
export function nextUpgradeTime(
  kind: StructureKind,
  level: number,
): number | null {
  const step = STRUCTURES[kind].upgrades[level - 1];
  return step ? step.time : null;
}

/** Damage per second applied to an enemy sclerotium when the front is at it. */
export const SCLEROTIUM_DAMAGE = 6;

/** How fast the front moves in normalized-units/second per unit of net pressure. */
export const FRONT_SPEED = 0.006;

// ---------- RPS / disable system ----------

/** Common cap on every structure's disable meter. */
export const DISABLE_THRESHOLD = 100;
/** Seconds a disabled structure stays offline before recovering to active. */
export const DISABLE_DURATION = 6;

/** Rhizomorph dissolve rate (disable damage / second) at level 1. Applies to any target. */
export const RHIZO_DISSOLVE_RATE = 10;

/** Fruiting surge meter threshold. */
export const SURGE_THRESHOLD = 100;
/** Base surge charge rate at level 1, per second. */
export const SURGE_CHARGE_RATE = 12;
/** Per-target disable damage on burst, level 1. Burst is AoE — hits every active enemy (except decomposer). */
export const SURGE_BURST_DAMAGE = 60;
/** Seconds the burst-fired visual state lasts (animation only, no gameplay effect). */
export const SURGE_BURST_VISUAL_DURATION = 1.0;

/**
 * Max proportional slow on a fruiting's own surge charge when its disable meter is full.
 * Applies regardless of the meter's source — any pressure on the fruiting delays its burst.
 */
export const SURGE_SLOW_MAX = 0.85;

/**
 * Pressure multiplier on a fruiting while its burst window is open.
 * The burst is both a disable AoE and a brief pressure spike — simulates
 * spore cloud shoving the front while it disables nearby enemies.
 */
export const SURGE_BURST_PRESSURE_MULT = 5;
