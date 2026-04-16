export type Side = "left" | "right";

export type StructureKind =
  | "hyphae"
  | "rhizomorph"
  | "fruiting"
  | "decomposer";

export type StructureStatus = "growing" | "active" | "mutating";

export interface Structure {
  id: number;
  kind: StructureKind;
  level: number;
  status: StructureStatus;
  /** Seconds remaining until the current lifecycle stage completes. */
  timer: number;
}

export interface ColonyState {
  side: Side;
  nutrients: number;
  income: number;
  hp: number;
  maxHp: number;
  /** Fixed slots near the sclerotium. A null slot is empty and buildable. */
  slots: (Structure | null)[];
}

export interface GameState {
  /** Seconds elapsed. */
  time: number;
  /** Seconds remaining before the match begins. 0 once play starts. */
  countdown: number;
  /** Front position along the log, 0..1 (0 = left sclerotium, 1 = right). */
  front: number;
  left: ColonyState;
  right: ColonyState;
  /** null while in progress, otherwise the winner. */
  winner: Side | null;
  nextStructureId: number;
}
