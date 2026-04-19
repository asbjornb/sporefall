import type { GameState, Structure } from "./types";

/**
 * Deterministic PRNG. Same seed → identical stream across browsers/Node.
 * Used by sim consumers (AI, future sim randomness) so two clients in lockstep
 * stay bit-identical.
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function structurePart(s: Structure | null): string {
  if (!s) return "_";
  return [
    s.id,
    s.kind,
    s.level,
    s.status,
    s.timer.toFixed(6),
    s.disableMeter.toFixed(6),
    s.disableTimer.toFixed(6),
    s.surgeCharge !== undefined ? s.surgeCharge.toFixed(6) : "-",
    s.surgeTimer !== undefined ? s.surgeTimer.toFixed(6) : "-",
    s.surgeTargetId ?? "-",
    s.rhizoTargetId ?? "-",
  ].join(":");
}

/**
 * Stable digest of all state that affects future ticks. Used by the determinism
 * harness and by live multiplayer for desync detection. Cosmetic-only fields
 * (e.g. surgeTimer is here because it gates surgeTargetId clearing) are kept;
 * pure render state is not part of GameState so it can't leak in.
 */
export function hashState(state: GameState): string {
  const parts: string[] = [
    state.time.toFixed(6),
    state.countdown.toFixed(6),
    state.front.toFixed(6),
    state.winner ?? "-",
    String(state.nextStructureId),
  ];
  for (const side of ["left", "right"] as const) {
    const c = state[side];
    parts.push(
      side,
      c.nutrients.toFixed(6),
      c.income.toFixed(6),
      c.hp.toFixed(6),
      c.maxHp.toFixed(6),
    );
    for (const slot of c.slots) parts.push(structurePart(slot));
  }
  return parts.join("|");
}
