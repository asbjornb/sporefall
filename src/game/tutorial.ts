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

const STEPS: TutorialStep[] = [
  {
    id: "goal",
    hint:
      "GOAL  Destroy the orange heart on the right.\nProtect your green heart on the left.\n\nTap anywhere to continue.",
    isComplete: (_s, c) => c.tapped,
  },
  {
    id: "build",
    hint:
      "BUILD  Tap the Hyphal Mat button on the left\nto grow your first structure (20 nutrients).",
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
      "COUNTERS  Hyphae smother Fruiting.\nRhizomorph dissolve Hyphae.\nFruiting burst Rhizomorph.\n\nWatch — the enemy just grew a Fruiting body.",
    setup: (state) => {
      build(state, "right", "fruiting");
      const spawned = state.right.slots.find((s) => s?.kind === "fruiting");
      if (spawned) spawned.timer = 0.5;
    },
    isComplete: (_s, c) => c.timeInStep > 5,
  },
  {
    id: "counters-demo",
    hint:
      "See the green haze on the enemy Fruiting?\nYour Hyphae are smothering it — its surge meter\ncharges slower and it can be shut down.",
    isComplete: (_s, c) => c.timeInStep > 8,
  },
  {
    id: "done",
    hint:
      "That's the core loop: build, upgrade, counter.\nTap the restart button (top-right) to start a real match.",
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
