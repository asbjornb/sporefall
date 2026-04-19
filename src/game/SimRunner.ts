import { applyCommand, type Command } from "./commands";
import { step } from "./sim";
import type { GameState, Side } from "./types";

/** Fixed sim tick rate. 30 Hz is plenty for a strategy-paced game and keeps
 *  bandwidth trivial in multiplayer (one input frame per peer per tick). */
export const FIXED_DT = 1 / 30;

/** Ticks of input delay in lockstep mode. ≈ 100 ms at 30 Hz — enough to
 *  hide typical peer-to-peer RTT without visible lag when tapping a build
 *  button. Also determines how many empty frames are pre-seeded at match
 *  start so the sim can roll forward immediately. */
export const DEFAULT_INPUT_DELAY = 3;

interface LockstepConfig {
  ourSide: Side;
  inputDelay: number;
  /** Called once per fixed tick as we commit the local input frame for
   *  `emitTick`. The caller is expected to send `{t:"input", tick, cmds}`
   *  over the transport. */
  onEmitInput: (emitTick: number, cmds: Command[]) => void;
}

type FrameBuf = { left?: Command[]; right?: Command[] };

/**
 * Advances the simulation in fixed-size steps. Supports two modes:
 *
 *  - Single-player: `advance` is driven by realDt and a per-tick callback
 *    runs (AI / tutorial) before each step.
 *  - Lockstep MP: `advance` only progresses when both sides' input frames
 *    for the next tick have arrived. Local commands are captured via
 *    `submitLocalCommand` and scheduled for `currentTick + INPUT_DELAY`.
 *    Even with no taps the runner emits an empty frame every tick so the
 *    remote always has something to apply (heartbeat).
 */
export class SimRunner {
  state: GameState;
  tick = 0;
  private acc = 0;

  private lockstep: LockstepConfig | null = null;
  private inputBuffers: Map<number, FrameBuf> = new Map();
  private localPending: Command[] = [];
  private lastEmittedTick = -1;
  /** Seconds since we've been able to advance — used for the stall overlay. */
  stalledFor = 0;

  constructor(state: GameState) {
    this.state = state;
  }

  /**
   * Switch the runner into lockstep mode. Pre-seeds empty input frames for
   * the first INPUT_DELAY ticks for both sides so the sim can roll forward
   * immediately while real inputs queue up.
   */
  enableLockstep(cfg: LockstepConfig): void {
    this.lockstep = cfg;
    for (let t = 0; t < cfg.inputDelay; t++) {
      this.inputBuffers.set(t, { left: [], right: [] });
    }
  }

  /** Inject a remote input frame for the opposite side at `tick`. */
  submitRemoteInput(tick: number, cmds: Command[]): void {
    if (!this.lockstep) return;
    const remoteSide = this.lockstep.ourSide === "left" ? "right" : "left";
    const buf = this.inputBuffers.get(tick) ?? {};
    buf[remoteSide] = cmds;
    this.inputBuffers.set(tick, buf);
  }

  /**
   * Record a local command to be emitted in the NEXT input frame. In SP
   * this just applies immediately via `applyNow` — the lockstep scheduler
   * isn't active, so there's no frame to bundle into.
   */
  submitLocalCommand(cmd: Command): boolean {
    if (!this.lockstep) {
      return applyCommand(this.state, cmd);
    }
    this.localPending.push(cmd);
    return true;
  }

  /** Apply a command to the current tick immediately (SP path). */
  applyNow(cmd: Command): boolean {
    return applyCommand(this.state, cmd);
  }

  /**
   * Drive sim forward in fixed steps. `onTick` runs once per tick BEFORE
   * the step — used for per-tick hooks (AI in SP, tutorial). In lockstep
   * mode `onTick` still runs so callers have a place to hook into, but
   * the AI must be disabled by the caller.
   */
  advance(
    realDtMs: number,
    onTick: (state: GameState, tick: number) => void,
  ): void {
    // Clamp to avoid spiral-of-death after a long frame (tab backgrounded).
    this.acc += Math.min(0.25, realDtMs / 1000);

    if (!this.lockstep) {
      while (this.acc >= FIXED_DT) {
        this.acc -= FIXED_DT;
        onTick(this.state, this.tick);
        step(this.state, FIXED_DT);
        this.tick++;
      }
      return;
    }

    const ls = this.lockstep;
    // Emit every local input frame we can, up to currentTick + inputDelay.
    // This is the "heartbeat" — we always tell the remote which tick we're
    // committing for, even if there are no commands to send.
    while (this.lastEmittedTick < this.tick + ls.inputDelay - 1) {
      const emitTick = this.lastEmittedTick + 1;
      const cmds = this.localPending;
      this.localPending = [];
      const buf = this.inputBuffers.get(emitTick) ?? {};
      buf[ls.ourSide] = cmds;
      this.inputBuffers.set(emitTick, buf);
      ls.onEmitInput(emitTick, cmds);
      this.lastEmittedTick = emitTick;
    }

    let advanced = false;
    while (this.acc >= FIXED_DT) {
      const buf = this.inputBuffers.get(this.tick);
      if (!buf || !buf.left || !buf.right) {
        // Stall — remote hasn't sent their frame for this tick yet.
        break;
      }
      this.acc -= FIXED_DT;
      onTick(this.state, this.tick);
      // Apply in a deterministic order regardless of which client we are.
      for (const c of buf.left) applyCommand(this.state, c);
      for (const c of buf.right) applyCommand(this.state, c);
      step(this.state, FIXED_DT);
      this.inputBuffers.delete(this.tick);
      this.tick++;
      advanced = true;
    }

    if (advanced) {
      this.stalledFor = 0;
    } else {
      this.stalledFor += realDtMs / 1000;
    }
  }

  /** Replace the underlying state (used by restart / rematch). */
  reset(state: GameState): void {
    this.state = state;
    this.tick = 0;
    this.acc = 0;
    this.inputBuffers.clear();
    this.localPending = [];
    this.lastEmittedTick = -1;
    this.stalledFor = 0;
    if (this.lockstep) {
      for (let t = 0; t < this.lockstep.inputDelay; t++) {
        this.inputBuffers.set(t, { left: [], right: [] });
      }
    }
  }
}
