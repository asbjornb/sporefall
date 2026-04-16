import type { StructureKind } from "./types";

export const SLOT_COUNT = 10;

export const START_NUTRIENTS = 40;
export const BASE_INCOME = 2; // nutrients / second
export const START_HP = 100;

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
    basePressure: 5,
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
