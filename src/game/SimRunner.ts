import { applyCommand, type Command } from "./commands";
import { step } from "./sim";
import type { GameState } from "./types";

/** Fixed sim tick rate. 30 Hz is plenty for a strategy-paced game and keeps
 *  bandwidth trivial in multiplayer (one input frame per peer per tick). */
export const FIXED_DT = 1 / 30;

/**
 * Advances the simulation in fixed-size steps. In single-player the runner is
 * driven directly by realDt and applies commands as they arrive (build taps,
 * AI). In multiplayer (Phase 4) the runner will gate `advance` on having both
 * peers' input frames for the next tick — same code path, additional waiting.
 */
export class SimRunner {
  state: GameState;
  tick = 0;
  private acc = 0;

  constructor(state: GameState) {
    this.state = state;
  }

  /**
   * Apply a command to the current tick immediately. Used for local taps and
   * the single-player AI. In multiplayer this becomes scheduling for a future
   * tick instead.
   */
  applyNow(cmd: Command): boolean {
    return applyCommand(this.state, cmd);
  }

  /**
   * Advance sim by realDtMs of wall-clock time. `onTick` runs once per fixed
   * tick BEFORE the step — that's where the AI submits its command and the
   * tutorial does its inspection. Multiple ticks may run per call if the
   * frame was long.
   */
  advance(
    realDtMs: number,
    onTick: (state: GameState, tick: number) => void,
  ): void {
    // Clamp to avoid spiral-of-death after a long frame (tab backgrounded).
    this.acc += Math.min(0.25, realDtMs / 1000);
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      onTick(this.state, this.tick);
      step(this.state, FIXED_DT);
      this.tick++;
    }
  }

  /** Replace the underlying state (used by restart / rematch). */
  reset(state: GameState): void {
    this.state = state;
    this.tick = 0;
    this.acc = 0;
  }
}
