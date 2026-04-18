import {
  BASE_INCOME,
  DISABLE_DURATION,
  DISABLE_THRESHOLD,
  FRONT_SPEED,
  RHIZO_DISSOLVE_RATE,
  SCLEROTIUM_DAMAGE,
  SLOT_COUNT,
  START_COUNTDOWN,
  STRUCTURES,
  START_HP,
  START_NUTRIENTS,
  SURGE_BURST_DAMAGE,
  SURGE_BURST_PRESSURE_MULT,
  SURGE_BURST_VISUAL_DURATION,
  SURGE_CHARGE_RATE,
  SURGE_SLOW_MAX,
  SURGE_THRESHOLD,
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

/** True if the structure is currently producing pressure / applying its effect. */
function isOperational(s: Structure): boolean {
  return s.status === "active";
}

/** Effective pressure of a single structure right now. */
function structurePressure(s: Structure): number {
  if (!isOperational(s)) return 0;
  const cfg = STRUCTURES[s.kind];
  const base = cfg.basePressure * levelMultiplier(s.level);
  if (s.kind === "fruiting" && (s.surgeTimer ?? 0) > 0) {
    return base * SURGE_BURST_PRESSURE_MULT;
  }
  return base;
}

function colonyPressure(colony: ColonyState): number {
  let p = 0;
  for (const slot of colony.slots) {
    if (slot) p += structurePressure(slot);
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
  if (colony.slots.some((s) => s && s.status === "growing")) return false;
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
    disableMeter: 0,
    disableTimer: 0,
  };
  if (kind === "fruiting") {
    structure.surgeCharge = 0;
    structure.surgeTimer = 0;
    structure.surgeTargetId = null;
  } else if (kind === "rhizomorph") {
    structure.rhizoTargetId = null;
  }
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
  if (!s) return false;
  if (s.status === "disabled") return false;
  if (s.status !== "active") return false;
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

function advanceLifecycle(colony: ColonyState, dt: number): void {
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
    } else if (s.status === "disabled") {
      s.disableTimer -= dt;
      if (s.disableTimer <= 0) {
        s.status = "active";
        s.disableTimer = 0;
        s.disableMeter = 0;
        changed = true;
      }
    }
    if (s.kind === "fruiting" && (s.surgeTimer ?? 0) > 0) {
      s.surgeTimer = Math.max(0, (s.surgeTimer ?? 0) - dt);
      if ((s.surgeTimer ?? 0) <= 0) s.surgeTargetId = null;
    }
  }
  if (changed) recomputeIncome(colony);
}

function decayDisableMeter(colony: ColonyState, dt: number): void {
  for (const s of colony.slots) {
    if (!s) continue;
    if (s.status === "disabled") continue;
    if (s.disableMeter <= 0) continue;
    const decay = STRUCTURES[s.kind].disableDecay;
    s.disableMeter = Math.max(0, s.disableMeter - decay * dt);
  }
}

/** Add disable damage to a target. Returns true if the hit pushed it into disabled. */
function damageDisable(target: Structure, amount: number): boolean {
  if (target.status === "disabled") return false;
  target.disableMeter = Math.min(
    DISABLE_THRESHOLD,
    target.disableMeter + amount,
  );
  if (target.disableMeter >= DISABLE_THRESHOLD) {
    target.status = "disabled";
    target.disableMeter = 0;
    target.disableTimer = DISABLE_DURATION;
    if (target.kind === "fruiting") {
      // Surges pause while disabled; meter is preserved (per spec: "frozen").
      target.surgeTimer = 0;
    }
    if (target.kind === "rhizomorph") {
      target.rhizoTargetId = null;
    }
    return true;
  }
  return false;
}

/**
 * Rough invested-nutrient value of a structure: base cost plus each mutation.
 * Used to prioritize high-value enemy targets so Rhizo's single-target disable
 * is naturally more efficient against expensive structures than cheap swarms.
 */
function structureValue(s: Structure): number {
  const cfg = STRUCTURES[s.kind];
  return cfg.cost + cfg.mutateCost * (s.level - 1);
}

function findRhizoTarget(enemyColony: ColonyState): Structure | null {
  // Most-expensive active enemy (excluding decomposer — economy, not combat).
  // Tiebreak: higher level, then lower slot index.
  let best: { s: Structure; value: number; idx: number } | null = null;
  for (let i = 0; i < enemyColony.slots.length; i++) {
    const s = enemyColony.slots[i];
    if (!s) continue;
    if (s.kind === "decomposer") continue;
    if (s.status !== "active") continue;
    const value = structureValue(s);
    if (
      !best ||
      value > best.value ||
      (value === best.value && s.level > best.s.level) ||
      (value === best.value && s.level === best.s.level && i < best.idx)
    ) {
      best = { s, value, idx: i };
    }
  }
  return best ? best.s : null;
}

function findStructureById(
  colony: ColonyState,
  id: number,
): Structure | null {
  for (const s of colony.slots) {
    if (s && s.id === id) return s;
  }
  return null;
}

function applyEffects(
  ownColony: ColonyState,
  enemyColony: ColonyState,
  dt: number,
): void {
  // Rhizomorph dissolve: each active rhizo locks a single high-value enemy target
  // and ticks a flat dissolve rate into it. Re-evaluates target when the current
  // one is disabled or gone. No type-specific multipliers — the value-weighted
  // targeting alone makes disabling expensive structures more impactful.
  for (const r of ownColony.slots) {
    if (!r || r.status !== "active" || r.kind !== "rhizomorph") continue;
    let target: Structure | null = null;
    if (r.rhizoTargetId != null) {
      const candidate = findStructureById(enemyColony, r.rhizoTargetId);
      if (candidate && candidate.status === "active") target = candidate;
    }
    if (!target) {
      target = findRhizoTarget(enemyColony);
      r.rhizoTargetId = target ? target.id : null;
    }
    if (!target) continue;
    const rate = RHIZO_DISSOLVE_RATE * levelMultiplier(r.level);
    const becameDisabled = damageDisable(target, rate * dt);
    if (becameDisabled) r.rhizoTargetId = null;
  }

  // Fruiting surge: charges over time, but slows proportionally to its own disable
  // meter (any incoming pressure delays the burst). On burst, splash disable damage
  // hits every active enemy combat structure (decomposers are not hit).
  for (const f of ownColony.slots) {
    if (!f || f.kind !== "fruiting") continue;
    if (f.status !== "active") continue;
    const meterFill = f.disableMeter / DISABLE_THRESHOLD;
    const slow = SURGE_SLOW_MAX * meterFill;
    const rate = SURGE_CHARGE_RATE * levelMultiplier(f.level) * (1 - slow);
    f.surgeCharge = Math.min(
      SURGE_THRESHOLD,
      (f.surgeCharge ?? 0) + Math.max(0, rate) * dt,
    );
    if ((f.surgeCharge ?? 0) >= SURGE_THRESHOLD) {
      const damage = SURGE_BURST_DAMAGE * levelMultiplier(f.level);
      let firstTargetId: number | null = null;
      for (const e of enemyColony.slots) {
        if (!e) continue;
        if (e.status !== "active") continue;
        if (e.kind === "decomposer") continue;
        damageDisable(e, damage);
        if (firstTargetId === null) firstTargetId = e.id;
      }
      f.surgeCharge = 0;
      f.surgeTimer = SURGE_BURST_VISUAL_DURATION;
      f.surgeTargetId = firstTargetId;
    }
  }
}

/** Advance the simulation by dt seconds. */
export function step(state: GameState, dt: number): void {
  if (state.winner) return;
  if (state.countdown > 0) {
    state.countdown = Math.max(0, state.countdown - dt);
    return;
  }
  state.time += dt;

  advanceLifecycle(state.left, dt);
  advanceLifecycle(state.right, dt);

  state.left.nutrients += state.left.income * dt;
  state.right.nutrients += state.right.income * dt;

  // Per-type effects (smother, dissolve, surge) — apply both sides' attacks before decay
  // so a tick's incoming damage isn't immediately erased.
  applyEffects(state.left, state.right, dt);
  applyEffects(state.right, state.left, dt);

  decayDisableMeter(state.left, dt);
  decayDisableMeter(state.right, dt);

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
