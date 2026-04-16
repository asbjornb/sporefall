import {
  BASE_INCOME,
  FRONT_SPEED,
  SCLEROTIUM_DAMAGE,
  SLOT_COUNT,
  START_COUNTDOWN,
  STRUCTURES,
  START_HP,
  START_NUTRIENTS,
  levelMultiplier,
} from "./config";
import type {
  ColonyState,
  GameState,
  Side,
  Structure,
  StructureKind,
} from "./types";

function makeColony(side: Side): ColonyState {
  return {
    side,
    nutrients: START_NUTRIENTS,
    income: BASE_INCOME,
    hp: START_HP,
    maxHp: START_HP,
    slots: new Array(SLOT_COUNT).fill(null),
  };
}

export function createGameState(): GameState {
  return {
    time: 0,
    countdown: START_COUNTDOWN,
    front: 0.5,
    left: makeColony("left"),
    right: makeColony("right"),
    winner: null,
    nextStructureId: 1,
  };
}

function colonyPressure(colony: ColonyState): number {
  let p = 0;
  for (const slot of colony.slots) {
    if (slot && slot.status === "active") {
      p += STRUCTURES[slot.kind].basePressure * levelMultiplier(slot.level);
    }
  }
  return p;
}

function recomputeIncome(colony: ColonyState): void {
  let bonus = 0;
  for (const slot of colony.slots) {
    if (slot && slot.status === "active") {
      bonus += STRUCTURES[slot.kind].incomeBonus * levelMultiplier(slot.level);
    }
  }
  colony.income = BASE_INCOME + bonus;
}

export function canBuild(
  state: GameState,
  side: Side,
  kind: StructureKind,
): boolean {
  if (state.winner) return false;
  if (state.countdown > 0) return false;
  const colony = state[side];
  const cfg = STRUCTURES[kind];
  if (colony.nutrients < cfg.cost) return false;
  return colony.slots.some((s) => s === null);
}

export function build(
  state: GameState,
  side: Side,
  kind: StructureKind,
): boolean {
  if (!canBuild(state, side, kind)) return false;
  const colony = state[side];
  const cfg = STRUCTURES[kind];
  const slotIdx = colony.slots.findIndex((s) => s === null);
  if (slotIdx === -1) return false;
  colony.nutrients -= cfg.cost;
  const structure: Structure = {
    id: state.nextStructureId++,
    kind,
    level: 1,
    status: "growing",
    timer: cfg.buildTime,
  };
  colony.slots[slotIdx] = structure;
  return true;
}

export function canMutate(
  state: GameState,
  side: Side,
  slotIdx: number,
): boolean {
  if (state.winner) return false;
  if (state.countdown > 0) return false;
  const colony = state[side];
  const s = colony.slots[slotIdx];
  if (!s || s.status !== "active") return false;
  const cfg = STRUCTURES[s.kind];
  return colony.nutrients >= cfg.mutateCost;
}

export function mutate(
  state: GameState,
  side: Side,
  slotIdx: number,
): boolean {
  if (!canMutate(state, side, slotIdx)) return false;
  const colony = state[side];
  const s = colony.slots[slotIdx]!;
  const cfg = STRUCTURES[s.kind];
  colony.nutrients -= cfg.mutateCost;
  s.status = "mutating";
  s.timer = cfg.mutateTime;
  recomputeIncome(colony);
  return true;
}

function advanceStructures(colony: ColonyState, dt: number): void {
  let changed = false;
  for (const s of colony.slots) {
    if (!s) continue;
    if (s.status === "growing") {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.status = "active";
        s.timer = 0;
        changed = true;
      }
    } else if (s.status === "mutating") {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.status = "active";
        s.level += 1;
        s.timer = 0;
        changed = true;
      }
    }
  }
  if (changed) recomputeIncome(colony);
}

/** Advance the simulation by dt seconds. */
export function step(state: GameState, dt: number): void {
  if (state.winner) return;
  if (state.countdown > 0) {
    state.countdown = Math.max(0, state.countdown - dt);
    return;
  }
  state.time += dt;

  advanceStructures(state.left, dt);
  advanceStructures(state.right, dt);

  state.left.nutrients += state.left.income * dt;
  state.right.nutrients += state.right.income * dt;

  const pL = colonyPressure(state.left);
  const pR = colonyPressure(state.right);
  const net = pL - pR; // positive → left pushes right
  state.front = Math.max(0, Math.min(1, state.front + net * FRONT_SPEED * dt));

  // Damage on contact with the enemy sclerotium.
  if (state.front >= 0.98 && pL > 0) {
    state.right.hp -= SCLEROTIUM_DAMAGE * dt;
  }
  if (state.front <= 0.02 && pR > 0) {
    state.left.hp -= SCLEROTIUM_DAMAGE * dt;
  }

  if (state.left.hp <= 0) {
    state.left.hp = 0;
    state.winner = "right";
  } else if (state.right.hp <= 0) {
    state.right.hp = 0;
    state.winner = "left";
  }
}

export function pressureOf(state: GameState, side: Side): number {
  return colonyPressure(state[side]);
}
