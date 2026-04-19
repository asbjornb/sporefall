import { build, mutate } from "./sim";
import type { GameState, Side, StructureKind } from "./types";

export type Command =
  | { kind: "noop" }
  | { kind: "build"; side: Side; structure: StructureKind }
  | { kind: "mutate"; side: Side; slotIdx: number };

/**
 * Single funnel for state mutation outside of `step`. In multiplayer the
 * tick scheduler hands the same Command list to both clients so they stay in
 * sync. Commands that fail validation are silently dropped — the sim is the
 * authority on what's legal at the moment of application.
 */
export function applyCommand(state: GameState, cmd: Command): boolean {
  switch (cmd.kind) {
    case "noop":
      return true;
    case "build":
      return build(state, cmd.side, cmd.structure);
    case "mutate":
      return mutate(state, cmd.side, cmd.slotIdx);
  }
}
