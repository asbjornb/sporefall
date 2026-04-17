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
    label: "Hyphal Mat",
    short: "Hyphae",
    color: 0x7a8a3a,
  },
  rhizomorph: {
    cost: 35,
    buildTime: 6,
    mutateTime: 8,
    mutateCost: 40,
    basePressure: 4,
    incomeBonus: 0,
    label: "Rhizomorph",
    short: "Rhizo",
    color: 0xbfc4c9,
  },
  fruiting: {
    cost: 60,
    buildTime: 10,
    mutateTime: 10,
    mutateCost: 60,
    basePressure: 8,
    incomeBonus: 0,
    label: "Fruiting Cluster",
    short: "Fruit",
    color: 0x8a4fa8,
  },
  decomposer: {
    cost: 30,
    buildTime: 8,
    mutateTime: 8,
    mutateCost: 35,
    basePressure: 0,
    incomeBonus: 1.5,
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
/** Passive decay of any non-zero disable meter per second. Keeps brief exposure from accumulating forever. */
export const DISABLE_METER_DECAY = 6;

/** Hyphae smother: per-active-hyphae disable rate applied to every active enemy fruiting per second. */
export const HYPHAE_SMOTHER_RATE = 9;
/**
 * Maximum proportional slow on a fruiting's surge charge from its own smother meter.
 * 1.0 = full halt at meter == threshold; 0 = no slow.
 */
export const HYPHAE_SMOTHER_SURGE_SLOW = 0.85;

/** Rhizomorph dissolve rate (disable damage / second) at level 1 against non-hyphae targets. */
export const RHIZO_DISSOLVE_RATE = 6;
/** Multiplier vs hyphae targets. */
export const RHIZO_DISSOLVE_VS_HYPHAE = 3;

/** Fruiting surge meter threshold. */
export const SURGE_THRESHOLD = 100;
/** Base surge charge rate at level 1, per second. */
export const SURGE_CHARGE_RATE = 12;
/** Disable damage delivered by a single fruiting burst at level 1. ~one-shots a level-1 rhizo. */
export const SURGE_BURST_DAMAGE = 110;
/** Seconds the post-burst pressure spike lasts. */
export const SURGE_BURST_DURATION = 1.6;
/** Pressure multiplier on the bursting fruiting while surgeTimer > 0. */
export const SURGE_BURST_PRESSURE_MULT = 6;
/** Residual pressure multiplier on a fruiting outside its burst window. */
export const FRUITING_RESIDUAL_PRESSURE_MULT = 0.25;
