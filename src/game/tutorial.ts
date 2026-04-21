import { build } from "./sim";
import type { GameState } from "./types";

export interface TutorialStep {
  id: string;
  hint: string;
  /** Runs once when the step first becomes current. */
  setup?: (state: GameState) => void;
  /** If provided, the step auto-advances when this returns true. */
  isComplete?: (
    state: GameState,
    ctx: { tapped: boolean; timeInStep: number },
  ) => boolean;
}

function hasAnyPlayerStructure(state: GameState): boolean {
  return state.left.slots.some((s) => s != null);
}

function hasActivePlayerStructure(state: GameState): boolean {
  return state.left.slots.some((s) => s != null && s.status === "active");
}

function hasUpgradedPlayerStructure(state: GameState): boolean {
  return state.left.slots.some(
    (s) => s != null && (s.status === "mutating" || s.level > 1),
  );
}

// Info-heavy steps wait a beat before accepting the advance tap, so a stray
// tap from the previous step can't skip the text before it's even readable.
const MIN_READ_TIME = 1.5;
const TAP_HINT = "\n\nTap anywhere to continue.";

function hasPlayerRhizomorph(state: GameState): boolean {
  return state.left.slots.some((s) => s != null && s.kind === "rhizomorph");
}

const STEPS: TutorialStep[] = [
  {
    id: "goal",
    hint:
      "GOAL  Destroy the orange heart on the right.\nProtect your green heart on the left." +
      TAP_HINT,
    isComplete: (_s, c) => c.tapped,
  },
  {
    id: "build",
    hint:
      "BUILD  Tap the Hyphal Mat button on the left\nto grow your first structure (25 nutrients).",
    isComplete: hasAnyPlayerStructure,
  },
  {
    id: "wait-active",
    hint:
      "Your Hyphae is growing. The ring fills as it matures,\nthen it goes active and starts pushing the front.",
    isComplete: hasActivePlayerStructure,
  },
  {
    id: "upgrade",
    hint:
      "UPGRADE  Tap your active Hyphae, then press Upgrade\nto make it stronger (more pressure per tick).",
    isComplete: hasUpgradedPlayerStructure,
  },
  {
    id: "counters-intro",
    hint:
      "FRUITING  The enemy just grew a Fruiting Cluster.\nIt charges a big AoE surge that disables your active\nstructures for a few seconds. Cheap Hyphae are the\nbudget answer — pile on pressure while it's charging." +
      TAP_HINT,
    setup: (state) => {
      build(state, "right", "fruiting");
      const spawned = state.right.slots.find((s) => s?.kind === "fruiting");
      if (spawned) spawned.timer = 0.5;
    },
    isComplete: (_s, c) => c.timeInStep > MIN_READ_TIME && c.tapped,
  },
  {
    id: "rhizo-build",
    hint:
      "RHIZOMORPH  Rhizo locks onto the enemy's most\nvaluable combat structure and dissolves it —\nstrongest against Fruiting and other Rhizos.\nBuild a Rhizomorph (40 nutrients).",
    setup: (state) => {
      // Clear enemy slots so the previous Fruiting doesn't surge mid-lesson,
      // then spawn a fresh Fruiting for Rhizo to target: highest-value enemy
      // means the dissolve arc points at a Fruiting, matching the lesson.
      for (let i = 0; i < state.right.slots.length; i++) {
        state.right.slots[i] = null;
      }
      build(state, "right", "fruiting");
      const spawned = state.right.slots.find((s) => s?.kind === "fruiting");
      if (spawned) spawned.timer = 0.5;
    },
    isComplete: hasPlayerRhizomorph,
  },
  {
    id: "rps-closeout",
    hint:
      "COUNTERS\n\u2022 Hyphae: cheap raw pressure\n\u2022 Rhizo: single-target dissolve on high-value enemies\n\u2022 Fruiting: AoE disable burst + pressure spike\nCounter whatever the enemy leans on." +
      TAP_HINT,
    isComplete: (_s, c) => c.timeInStep > MIN_READ_TIME && c.tapped,
  },
  {
    id: "done",
    hint:
      "SUMMARY\n\u2022 Build structures to push the front\n\u2022 Only one construction at a time\n\u2022 Upgrade pauses pressure\n\u2022 Don't get overrun\n\nTap anywhere to return to the menu.",
    isComplete: (_s, c) => c.timeInStep > MIN_READ_TIME && c.tapped,
  },
];

export class TutorialDirector {
  readonly active: boolean;
  private stepIdx = 0;
  private timeInStep = 0;
  private pendingTap = false;
  private didSetup = false;

  constructor(active: boolean) {
    this.active = active;
  }

  get finished(): boolean {
    return this.stepIdx >= STEPS.length;
  }

  currentHint(): string {
    if (!this.active) return "";
    const step = STEPS[this.stepIdx];
    return step ? step.hint : "";
  }

  registerTap(): void {
    this.pendingTap = true;
  }

  update(state: GameState, dt: number): void {
    if (!this.active) return;
    if (this.stepIdx >= STEPS.length) return;
    const step = STEPS[this.stepIdx];
    if (!this.didSetup) {
      step.setup?.(state);
      this.didSetup = true;
    }
    this.timeInStep += dt;
    const tapped = this.pendingTap;
    this.pendingTap = false;
    if (
      step.isComplete &&
      step.isComplete(state, { tapped, timeInStep: this.timeInStep })
    ) {
      this.stepIdx += 1;
      this.timeInStep = 0;
      this.didSetup = false;
    }
  }
}
