import type { StructureKind } from "./types";

export const SLOT_COUNT = 10;

export const START_NUTRIENTS = 40;
export const BASE_INCOME = 2; // nutrients / second
export const START_HP = 100;
/** Seconds to show a "get ready" countdown before play begins. */
export const START_COUNTDOWN = 3;

export interface StructureConfig {
  cost: number;
  /** Seconds to establish before the structure goes active. */
  buildTime: number;
  /** Seconds to mutate (upgrade). */
  mutateTime: number;
  mutateCost: number;
  /** Pressure contributed while active at level 1. */
  basePressure: number;
  /** Extra nutrient income while active. Only meaningful for decomposer. */
  incomeBonus: number;
  /** Passive decay per second of a non-zero disable meter. Kind-specific toughness. */
  disableDecay: number;
  label: string;
  short: string;
  color: number;
}

export const STRUCTURES: Record<StructureKind, StructureConfig> = {
  hyphae: {
    cost: 20,
    buildTime: 4,
    mutateTime: 6,
    mutateCost: 25,
    basePressure: 3,
    incomeBonus: 0,
    disableDecay: 3,
    label: "Hyphal Mat",
    short: "Hyphae",
    color: 0x7a8a3a,
  },
  rhizomorph: {
    cost: 40,
    buildTime: 6,
    mutateTime: 8,
    mutateCost: 40,
    basePressure: 4,
    incomeBonus: 0,
    disableDecay: 5,
    label: "Rhizomorph",
    short: "Rhizo",
    color: 0xbfc4c9,
  },
  fruiting: {
    cost: 60,
    buildTime: 10,
    mutateTime: 10,
    mutateCost: 60,
    basePressure: 5,
    incomeBonus: 0,
    disableDecay: 4,
    label: "Fruiting Cluster",
    short: "Fruit",
    color: 0x8a4fa8,
  },
  decomposer: {
    cost: 40,
    buildTime: 16,
    mutateTime: 8,
    mutateCost: 35,
    basePressure: 0,
    incomeBonus: 1.5,
    disableDecay: 4,
    label: "Decomposer",
    short: "Decom",
    color: 0xc08040,
  },
};

/** Upgrade pressure multiplier per level. Level 1 = 1.0. */
export function levelMultiplier(level: number): number {
  return 1 + 0.75 * (level - 1);
}

/** Damage per second applied to an enemy sclerotium when the front is at it. */
export const SCLEROTIUM_DAMAGE = 6;

/** How fast the front moves in normalized-units/second per unit of net pressure. */
export const FRONT_SPEED = 0.008;

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
