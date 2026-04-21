import Phaser from "phaser";
import { createAI, type Agent, type AIDifficulty } from "../game/ai";
import { type AudioManager, getAudio } from "../game/audio";
import { type Command } from "../game/commands";
import {
  DISABLE_DURATION,
  DISABLE_THRESHOLD,
  MAX_LEVEL,
  SLOT_COUNT,
  START_COUNTDOWN,
  STRUCTURES,
  SURGE_THRESHOLD,
  nextUpgradeCost,
  nextUpgradeTime,
} from "../game/config";
import { hashState, mulberry32 } from "../game/rng";
import { DEFAULT_INPUT_DELAY, FIXED_DT, SimRunner } from "../game/SimRunner";
import {
  canBuild,
  canMutate,
  createGameState,
  pressureOf,
} from "../game/sim";
import { TutorialDirector } from "../game/tutorial";
import type {
  GameState,
  Side,
  Structure,
  StructureKind,
  StructureStatus,
} from "../game/types";
import type { NetMessage, Transport } from "../net/Transport";

export interface MpSceneConfig {
  transport: Transport;
  seed: number;
  ourSide: Side;
  firstTick: number;
}

export interface GameSceneData {
  tutorial?: boolean;
  /** When true, skip the pre-game menu (used by Restart). */
  skipMenu?: boolean;
  /** Present for multiplayer matches. Null/undefined means single-player. */
  mp?: MpSceneConfig;
}

const LEFT_TINT = 0x9bb04a;
const RIGHT_TINT = 0xc46a3a;
const LOG_BODY = 0x5a3a20;
const LOG_BARK = 0x3a2612;

const KINDS: StructureKind[] = [
  "hyphae",
  "rhizomorph",
  "fruiting",
  "decomposer",
];

interface SlotSpec {
  x: number;
  y: number;
}

interface BuildBtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ControlBtnRect {
  x: number;
  y: number;
  size: number;
}

interface DifficultyBtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  W: number;
  H: number;
  uiScale: number;
  logLeft: number;
  logRight: number;
  logTop: number;
  logBottom: number;
  logW: number;
  logH: number;
  heartRadius: number;
  leftHeartX: number;
  rightHeartX: number;
  heartY: number;
  leftSlots: SlotSpec[];
  rightSlots: SlotSpec[];
  slotRadius: number;
  /** Midpoint X of the slot row — used to draw a divider between sides. */
  slotDividerX: number;
  /** Top/bottom Y of the slot area — used for the divider line. */
  slotAreaTop: number;
  slotAreaBottom: number;
  buildBtns: BuildBtnRect[];
  pauseBtn: ControlBtnRect;
  restartBtn: ControlBtnRect;
  /** Tutorial "How to Play" button — lives inside the menu panel. */
  tutorialBtn: DifficultyBtnRect;
  /** AI difficulty toggle — lives inside the menu panel. */
  difficultyBtn: DifficultyBtnRect;
  hpBarOffsetAboveLog: number;
  /** Center position for the pre-game title (inside the menu panel). */
  titleX: number;
  titleY: number;
  /** Y position of the pre-game subtitle. */
  subtitleY: number;
  /** Pre-game "Spread" start button rect. */
  spreadBtn: BuildBtnRect;
  /** Pre-game modal panel rect (backdrop + frame). */
  menuPanel: BuildBtnRect;
}

function desaturate(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c: number) => Math.round(c + (gray - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

function computeLayout(W: number, H: number): Layout {
  // Uniform UI scale relative to the original 1280x720 design. On a phone in
  // landscape (~800x380) this drops to ~0.45, packing fonts/buttons tighter so
  // there's room for proper spacing between rows and a mid-gap between sides.
  const uiScale = Math.max(0.45, Math.min(1.2, Math.min(W / 1280, H / 720)));
  const s = (n: number) => Math.round(n * uiScale);
  // Canvas is rendered at DPR × the CSS viewport (see main.ts), so game-pixel
  // sizes shrink visibly by 1/DPR on phones. `cssPx(n)` gives a game-pixel
  // size that reads as `n` CSS pixels — useful for enforcing readable text
  // and touch-friendly minimum hit sizes.
  const dpr = Math.max(
    1,
    Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
  );
  const cssPx = (n: number) => Math.round(n * dpr);

  const topBarH = s(76);
  // Leave real breathing room under the bottom slot row so the circles
  // don't visually touch the screen edge on phones.
  const bottomPad = s(22);

  // Slots region (2 rows) sits near the bottom, where the build bar used to be.
  const slotRadius = s(28);
  const slotRowGap = s(58);
  const slotAreaBottom = H - bottomPad;
  const slotAreaTop = slotAreaBottom - slotRowGap * 2 + (slotRowGap - slotRadius * 2) / 2;
  const row0Y = slotAreaTop + slotRadius + s(4);
  const row1Y = row0Y + slotRowGap;

  // Headroom above the log: the HP bar sits just above it.
  const hpBarOffsetAboveLog = s(16);
  const hpBarH = Math.max(6, Math.round(12 * uiScale));
  const headroom = hpBarOffsetAboveLog + hpBarH + s(4);

  // Build buttons stacked vertically along the left edge, aligned with the log.
  // Leave a visible gap between the last button and the slot row so the
  // bottom button's text isn't flush against the slot circles.
  const buildBarTop = topBarH + headroom;
  const buildBarBottom = slotAreaTop - s(22);
  const buildBarH = buildBarBottom - buildBarTop;
  const btnGap = s(20);
  const btnH = Math.max(s(72), Math.min(s(150), Math.floor((buildBarH - btnGap * 3) / 4)));
  const btnW = Math.max(s(130), Math.min(s(210), Math.round(W * 0.14)));
  const leftPad = s(12);
  const buildBarX = leftPad;
  const buildBtns: BuildBtnRect[] = [];
  for (let i = 0; i < 4; i++) {
    buildBtns.push({
      x: buildBarX,
      y: buildBarTop + i * (btnH + btnGap),
      w: btnW,
      h: btnH,
    });
  }

  // Log spans between the HUD strip and the slots, starting right of the build column.
  const heartRadius = Math.max(s(26), Math.min(s(44), Math.round(H * 0.05)));
  const rightMargin = Math.max(s(40), Math.min(s(110), Math.round(W * 0.045)));
  const logLeft = buildBarX + btnW + s(18);
  const logRight = W - rightMargin;
  const logTop = buildBarTop;
  // Shrink the log a bit vertically so the slot area can breathe.
  const logBottom = Math.min(buildBarBottom, logTop + Math.round(H * 0.46));
  const logW = logRight - logLeft;
  const logH = Math.max(s(110), logBottom - logTop);

  const leftHeartX = logLeft + heartRadius * 0.55;
  const rightHeartX = logRight - heartRadius * 0.55;
  const heartY = logTop + logH / 2;

  // Slot columns start one spacing inward from each sclerotium and leave a clear
  // gap in the middle so the player's and enemy's buildings don't visually merge.
  const midGap = Math.max(s(40), Math.round(W * 0.04));
  const halfSpan = Math.max(0, (rightHeartX - leftHeartX) / 2 - midGap / 2);
  const slotSpacing = Math.max(s(54), Math.min(s(100), halfSpan / 5));
  const leftAnchor = leftHeartX;
  const rightAnchor = rightHeartX;
  const slotDividerX = (leftHeartX + rightHeartX) / 2;
  const leftSlots: SlotSpec[] = [];
  const rightSlots: SlotSpec[] = [];
  for (let row = 0; row < 2; row++) {
    const y = row === 0 ? row0Y : row1Y;
    for (let col = 0; col < 5; col++) {
      leftSlots.push({ x: leftAnchor + slotSpacing * (col + 1), y });
      rightSlots.push({ x: rightAnchor - slotSpacing * (col + 1), y });
    }
  }

  // Top-right in-game controls: pause + restart only. Tutorial & difficulty
  // live inside the pre-game modal (see menuPanel below) and are hidden during
  // play so the HUD stays uncluttered.
  const ctrlSize = s(56);
  const ctrlGap = s(10);
  // Keep a visible gap from the screen edges even on small phones where
  // s(n) shrinks aggressively — otherwise the buttons kiss the corner.
  const ctrlMargin = Math.max(16, s(16));
  const restartBtn: ControlBtnRect = {
    x: W - ctrlSize - ctrlMargin,
    y: ctrlMargin,
    size: ctrlSize,
  };
  const pauseBtn: ControlBtnRect = {
    x: restartBtn.x - ctrlSize - ctrlGap,
    y: ctrlMargin,
    size: ctrlSize,
  };

  // Pre-game modal: centered panel that houses the title, Spread CTA, and
  // the tutorial/difficulty controls. The game world dims behind it. Use
  // DPR-aware CSS-pixel minimums so the panel doesn't collapse to a postage
  // stamp on high-DPI phones where uiScale floors near 0.45.
  const panelMaxW = Math.max(s(560), cssPx(340));
  const panelMaxH = Math.max(s(520), cssPx(420));
  const panelW = Math.min(W - s(32), panelMaxW);
  const panelH = Math.min(H - s(32), panelMaxH);
  const panelX = Math.round(W / 2 - panelW / 2);
  const panelY = Math.round(H / 2 - panelH / 2);
  const menuPanel: BuildBtnRect = { x: panelX, y: panelY, w: panelW, h: panelH };

  const titleX = W / 2;
  const titleY = Math.round(panelY + panelH * 0.18);
  const subtitleY = Math.round(panelY + panelH * 0.32);

  const spreadW = Math.max(cssPx(200), Math.min(Math.round(panelW * 0.7), s(320)));
  const spreadH = Math.max(cssPx(56), Math.min(s(110), Math.round(panelH * 0.22)));
  const spreadBtn: BuildBtnRect = {
    x: Math.round(W / 2 - spreadW / 2),
    y: Math.round(panelY + panelH * 0.55 - spreadH / 2),
    w: spreadW,
    h: spreadH,
  };

  // Bottom row inside the panel: "How to Play" on the left, difficulty toggle
  // on the right. Enforce Material's 48dp (~48 CSS px) minimum hit target so
  // they're tappable on phones, not just dense pixel rows.
  const menuBtnH = Math.max(s(60), cssPx(48));
  const menuBtnGap = s(16);
  const menuRowAvail = panelW - s(32);
  const menuBtnW = Math.min(
    Math.max(cssPx(130), s(200)),
    Math.floor((menuRowAvail - menuBtnGap) / 2),
  );
  const menuRowW = menuBtnW * 2 + menuBtnGap;
  const menuRowX = Math.round(W / 2 - menuRowW / 2);
  const menuRowY = Math.round(panelY + panelH - menuBtnH - s(28));
  const tutorialBtn: DifficultyBtnRect = {
    x: menuRowX,
    y: menuRowY,
    w: menuBtnW,
    h: menuBtnH,
  };
  const difficultyBtn: DifficultyBtnRect = {
    x: menuRowX + menuBtnW + menuBtnGap,
    y: menuRowY,
    w: menuBtnW,
    h: menuBtnH,
  };

  return {
    W,
    H,
    uiScale,
    logLeft,
    logRight,
    logTop,
    logBottom,
    logW,
    logH,
    heartRadius,
    leftHeartX,
    rightHeartX,
    heartY,
    leftSlots,
    rightSlots,
    slotRadius,
    slotDividerX,
    slotAreaTop,
    slotAreaBottom,
    buildBtns,
    pauseBtn,
    restartBtn,
    tutorialBtn,
    difficultyBtn,
    hpBarOffsetAboveLog,
    titleX,
    titleY,
    subtitleY,
    spreadBtn,
    menuPanel,
  };
}

type Phase = "menu" | "playing";

export class GameScene extends Phaser.Scene {
  private runner!: SimRunner;
  private state!: GameState;
  private ai!: Agent;
  private ourSide: Side = "left";
  private mp: MpSceneConfig | null = null;
  private mpListenerCleanup: (() => void) | null = null;
  private mpRematchOverlay: {
    backdrop: Phaser.GameObjects.Graphics;
    panel: Phaser.GameObjects.Graphics;
    result: Phaser.GameObjects.Text;
    title: Phaser.GameObjects.Text;
    yesBg: Phaser.GameObjects.Graphics;
    yes: Phaser.GameObjects.Text;
    yesZone: Phaser.GameObjects.Zone;
    noBg: Phaser.GameObjects.Graphics;
    no: Phaser.GameObjects.Text;
    noZone: Phaser.GameObjects.Zone;
    status: Phaser.GameObjects.Text;
  } | null = null;
  private mpWeAcceptedRematch = false;
  private mpRemoteAcceptedRematch = false;
  private mpPendingRematchSeed: number | null = null;
  private mpStallOverlay: Phaser.GameObjects.Text | null = null;
  private paused = false;
  private phase: Phase = "menu";
  private titleText!: Phaser.GameObjects.Text;
  /** Native HTML <button> — sits above the Phaser canvas so fullscreen
   * requests fire inside the real user gesture (Phaser queues pointer events
   * which puts them outside the gesture by the time the handler runs). */
  private spreadEl: HTMLButtonElement | null = null;
  private bg!: Phaser.GameObjects.Graphics;
  private fx!: Phaser.GameObjects.Graphics;
  private topText!: Phaser.GameObjects.Text;
  private winText!: Phaser.GameObjects.Text;
  private countdownText!: Phaser.GameObjects.Text;
  private pausedText!: Phaser.GameObjects.Text;
  private buildBtns: {
    kind: StructureKind;
    container: Phaser.GameObjects.Container;
    title: Phaser.GameObjects.Text;
    detail: Phaser.GameObjects.Text;
    bg: Phaser.GameObjects.Graphics;
  }[] = [];
  private pauseBtn!: {
    bg: Phaser.GameObjects.Graphics;
    icon: Phaser.GameObjects.Text;
  };
  private restartBtn!: {
    bg: Phaser.GameObjects.Graphics;
    icon: Phaser.GameObjects.Text;
  };
  private tutorialBtn!: {
    bg: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  };
  private tutorialBtnZone!: Phaser.GameObjects.Zone;
  private menuBg!: Phaser.GameObjects.Graphics;
  private subtitleText!: Phaser.GameObjects.Text;
  private tutorial!: TutorialDirector;
  private hintText!: Phaser.GameObjects.Text;
  private summaryBg!: Phaser.GameObjects.Graphics;
  private summaryText!: Phaser.GameObjects.Text;
  private summaryStartBtn!: {
    bg: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  };
  private summaryStartZone!: Phaser.GameObjects.Zone;
  private summaryBackdropZone!: Phaser.GameObjects.Zone;
  private summaryVisible = false;
  private difficultyBtn!: {
    bg: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  };
  private difficultyBtnZone!: Phaser.GameObjects.Zone;
  private difficulty: AIDifficulty = "medium";
  private slotHit: Phaser.GameObjects.Arc[] = [];
  private selectedSlotIdx: number | null = null;
  /** Per-slot shake timer for the player's side, used to flash a denied tap on disabled. */
  private slotShake: number[] = new Array(SLOT_COUNT).fill(0);
  private upgradeBtnBg!: Phaser.GameObjects.Graphics;
  private upgradeBtnLabel!: Phaser.GameObjects.Text;
  private upgradeBtnZone!: Phaser.GameObjects.Zone;
  private buildBtnZones: Phaser.GameObjects.Zone[] = [];
  private pauseBtnZone!: Phaser.GameObjects.Zone;
  private restartBtnZone!: Phaser.GameObjects.Zone;
  private bgZone!: Phaser.GameObjects.Zone;
  private layout!: Layout;
  private audio!: AudioManager;
  /** Per-side map of structure id -> last-seen status, used to detect
   *  growing→active, mutating→active, and *→disabled transitions for SFX. */
  private prevStatuses: Record<Side, Map<number, StructureStatus>> = {
    left: new Map(),
    right: new Map(),
  };
  /** Per-side map of structure id -> last-seen surgeTimer, so we can fire
   *  the surge whoosh on the 0→>0 edge. */
  private prevSurge: Record<Side, Map<number, number>> = {
    left: new Map(),
    right: new Map(),
  };
  /** Floor of the last-seen countdown, for per-second tick / GO cues. */
  private prevCountdownFloor = -1;
  /** Last-seen winner so we fire win/lose stings exactly once. */
  private prevWinner: Side | null = null;

  constructor() {
    super("game");
  }

  init(data: GameSceneData): void {
    this.tutorial = new TutorialDirector(!!data?.tutorial);
    // Phaser's scene.restart reuses the same Scene instance, so class-field
    // initializers don't re-run. Any array/state we push into from create()
    // must be reset here or it will accumulate stale entries after a restart.
    this.buildBtns = [];
    this.buildBtnZones = [];
    this.slotHit = [];
    this.slotShake = new Array(SLOT_COUNT).fill(0);
    this.selectedSlotIdx = null;
    this.paused = false;
    this.summaryVisible = false;
    this.mp = data?.mp ?? null;
    this.ourSide = this.mp ? this.mp.ourSide : "left";
    this.mpWeAcceptedRematch = false;
    this.mpRemoteAcceptedRematch = false;
    this.mpPendingRematchSeed = null;
    // Tutorials skip the menu and go straight to play; a fresh match (or
    // restart via the in-game button) also jumps back into play. Only the
    // very first load — triggered from BootScene — lands on the menu.
    // Multiplayer also goes straight to playing once the lobby handshake is done.
    this.phase =
      data?.tutorial || data?.skipMenu || this.mp ? "playing" : "menu";
    // Reset transition snapshots on every (re)init so a freshly-built state
    // doesn't fire phantom "structure completed" SFX on the first tick.
    this.prevStatuses = { left: new Map(), right: new Map() };
    this.prevSurge = { left: new Map(), right: new Map() };
    this.prevCountdownFloor = -1;
    this.prevWinner = null;
    this.audio = getAudio();
  }

  create(): void {
    this.difficulty = loadDifficulty();
    this.runner = new SimRunner(createGameState());
    this.state = this.runner.state;
    // The AI is constructed in every mode so tutorial-to-menu transitions can
    // still reset it; in MP we simply never tick it.
    this.ai = createAI("right", this.difficulty, mulberry32(aiSeed()));
    this.layout = computeLayout(this.scale.width, this.scale.height);
    emitPhase(this.phase);
    if (this.mp) {
      this.setupMultiplayer(this.mp);
    }

    if (this.tutorial.active) {
      // Tutorial mode: skip countdown, grant ample nutrients, keep enemy passive.
      this.state.countdown = 0;
      this.state.left.nutrients = 200;
    }

    this.bg = this.add.graphics();
    this.fx = this.add.graphics();

    this.topText = this.add
      .text(0, 14, "", {
        fontSize: "26px",
        color: "#e8d7b6",
        fontFamily: "system-ui, sans-serif",
        align: "center",
        lineSpacing: 2,
      })
      .setOrigin(0.5, 0);

    this.winText = this.add
      .text(0, 0, "", {
        fontSize: "76px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.countdownText = this.add
      .text(0, 0, "", {
        fontSize: "180px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.pausedText = this.add
      .text(0, 0, "", {
        fontSize: "64px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.hintText = this.add
      .text(0, 0, "", {
        fontSize: "22px",
        color: "#f5e8c8",
        fontFamily: "system-ui, sans-serif",
        align: "center",
        stroke: "#1b120a",
        strokeThickness: 4,
        backgroundColor: "rgba(27,18,10,0.75)",
        padding: { x: 14, y: 10 },
        lineSpacing: 4,
      })
      .setOrigin(0.5, 0)
      .setDepth(18)
      .setVisible(false);

    this.createBackgroundZone();
    this.createBuildButtons();
    this.createSlotHitAreas();
    this.createUpgradeButton();
    this.createControlButtons();
    this.createMenuOverlay();
    this.createSummaryOverlay();
    this.applyLayout();

    this.scale.on("resize", this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onResize, this);
    });

    this.input.keyboard?.on("keydown-R", () => this.handleRestartTap());
    this.input.keyboard?.on("keydown-P", () => this.togglePause());
    this.input.keyboard?.on("keydown-SPACE", () => this.togglePause());
    // Any tap/click after the game is over drops back to the menu so the
    // player can pick difficulty or retry the tutorial before the next match.
    // In MP we route through `leaveMatch` so the transport gets closed; the
    // rematch overlay handles the in-game post-win flow on its own.
    this.input.on("pointerdown", () => {
      // Browsers gate audio behind a real user gesture — piggyback on any
      // pointer input inside the canvas to unlock the context.
      this.audio.resume();
      if (this.state.winner && !this.mp) this.backToMenu();
      if (this.tutorial.active) this.tutorial.registerTap();
    });

    // Seed the transition snapshot so we don't fire SFX for state that
    // already existed when the scene started (e.g. during a restart).
    this.captureAudioSnapshot();
    this.prevWinner = this.state.winner;
    this.prevCountdownFloor = Math.ceil(this.state.countdown);

    // If we're starting already in "playing" (tutorial / mp / skipMenu),
    // kick the ambient bed immediately; `startPlay()` handles the menu path.
    if (this.phase === "playing") {
      this.audio.resume();
      this.audio.startAmbient();
    }
  }

  private captureAudioSnapshot(): void {
    for (const side of ["left", "right"] as Side[]) {
      const statuses = new Map<number, StructureStatus>();
      const surges = new Map<number, number>();
      for (const s of this.state[side].slots) {
        if (!s) continue;
        statuses.set(s.id, s.status);
        if (s.kind === "fruiting") surges.set(s.id, s.surgeTimer ?? 0);
      }
      this.prevStatuses[side] = statuses;
      this.prevSurge[side] = surges;
    }
  }

  private onResize(gameSize: Phaser.Structs.Size): void {
    this.layout = computeLayout(gameSize.width, gameSize.height);
    this.applyLayout();
  }

  private applyLayout(): void {
    const L = this.layout;
    const sc = L.uiScale;
    const px = (n: number) => `${Math.max(10, Math.round(n * sc))}px`;
    // Menu text is drawn on the backing canvas (game px), then CSS-scaled to
    // 1/DPR. On high-DPR phones that makes uiScale-only sizes read as ~6 CSS
    // px. Force at least ~18 CSS px for menu labels by floor-ing at cssPx * DPR.
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const readablePx = (cssPx: number, scaled: number): string =>
      `${Math.max(Math.round(cssPx * dpr), scaled)}px`;

    this.topText.setPosition(
      L.W / 2,
      Math.max(10, Math.round(10 * sc)),
    );
    this.topText.setFontSize(readablePx(14, Math.round(22 * sc)));

    this.winText.setPosition(L.W / 2, L.H / 2);
    this.winText.setFontSize(px(76));

    this.countdownText.setPosition(L.W / 2, L.H / 2);
    this.countdownText.setFontSize(px(180));

    this.pausedText.setPosition(L.W / 2, L.H / 2 - Math.round(140 * sc));
    this.pausedText.setFontSize(px(64));

    this.bgZone.setPosition(L.W / 2, L.H / 2).setSize(L.W, L.H);

    this.buildBtns.forEach((entry, i) => {
      const rect = L.buildBtns[i];
      entry.container.setData("x", rect.x);
      entry.container.setData("y", rect.y);
      entry.container.setData("w", rect.w);
      entry.container.setData("h", rect.h);
      entry.title.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.22);
      entry.title.setFontSize(px(22));
      entry.detail.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.63);
      entry.detail.setFontSize(px(18));
      const zone = this.buildBtnZones[i];
      zone.setPosition(rect.x + rect.w / 2, rect.y + rect.h / 2);
      zone.setSize(rect.w, rect.h);
    });

    // Our slots always render on the view-left — the renderer mirrors the
    // board for the joiner so both players feel they're on the left.
    this.slotHit.forEach((hit, i) => {
      const pos = L.leftSlots[i];
      hit.setPosition(pos.x, pos.y);
      hit.setRadius(Math.max(18, L.slotRadius + Math.round(3 * sc)));
    });

    const pb = L.pauseBtn;
    this.pauseBtn.bg.setData("x", pb.x).setData("y", pb.y).setData("size", pb.size);
    this.pauseBtn.icon.setPosition(pb.x + pb.size / 2, pb.y + pb.size / 2);
    this.pauseBtn.icon.setFontSize(px(34));
    this.pauseBtnZone
      .setPosition(pb.x + pb.size / 2, pb.y + pb.size / 2)
      .setSize(pb.size, pb.size);

    const rb = L.restartBtn;
    this.restartBtn.bg.setData("x", rb.x).setData("y", rb.y).setData("size", rb.size);
    this.restartBtn.icon.setPosition(rb.x + rb.size / 2, rb.y + rb.size / 2);
    this.restartBtn.icon.setFontSize(px(40));
    this.restartBtnZone
      .setPosition(rb.x + rb.size / 2, rb.y + rb.size / 2)
      .setSize(rb.size, rb.size);

    const tb = L.tutorialBtn;
    this.tutorialBtn.bg
      .setData("x", tb.x)
      .setData("y", tb.y)
      .setData("w", tb.w)
      .setData("h", tb.h);
    this.tutorialBtn.label.setPosition(tb.x + tb.w / 2, tb.y + tb.h / 2);
    this.tutorialBtn.label.setFontSize(readablePx(18, Math.round(22 * sc)));
    this.tutorialBtnZone
      .setPosition(tb.x + tb.w / 2, tb.y + tb.h / 2)
      .setSize(tb.w, tb.h);

    const db = L.difficultyBtn;
    this.difficultyBtn.bg
      .setData("x", db.x)
      .setData("y", db.y)
      .setData("w", db.w)
      .setData("h", db.h);
    this.difficultyBtn.label.setPosition(db.x + db.w / 2, db.y + db.h / 2);
    this.difficultyBtn.label.setFontSize(readablePx(18, Math.round(22 * sc)));
    this.difficultyBtnZone
      .setPosition(db.x + db.w / 2, db.y + db.h / 2)
      .setSize(db.w, db.h);

    this.upgradeBtnLabel.setFontSize(px(18));

    if (this.titleText) {
      this.titleText.setPosition(L.titleX, L.titleY);
      this.titleText.setFontSize(readablePx(48, Math.round(72 * sc)));
    }
    if (this.subtitleText) {
      this.subtitleText.setPosition(L.titleX, L.subtitleY);
      this.subtitleText.setFontSize(readablePx(15, Math.round(20 * sc)));
    }
    if (this.spreadEl) {
      // Canvas backing store is rendered at DPR times the CSS viewport so
      // everything reads crisp on high-DPI screens (see main.ts). The native
      // <button> lives in CSS pixels, so convert game-pixel layout coords back.
      const cssScale = window.innerWidth / L.W;
      const sb = L.spreadBtn;
      this.spreadEl.style.left = `${sb.x * cssScale}px`;
      this.spreadEl.style.top = `${sb.y * cssScale}px`;
      this.spreadEl.style.width = `${sb.w * cssScale}px`;
      this.spreadEl.style.height = `${sb.h * cssScale}px`;
      this.spreadEl.style.fontSize = `${Math.max(26, Math.round(40 * sc * cssScale))}px`;
    }
  }

  update(_time: number, deltaMs: number): void {
    const dt = Math.min(0.1, deltaMs / 1000);
    if (this.phase === "playing" && !this.state.winner && !this.paused) {
      this.runner.advance(deltaMs, (state) => {
        if (this.mp) {
          // Multiplayer: no local AI, no tutorial. Remote commands arrive via
          // the transport and get applied as part of the tick's input frame
          // inside the runner itself.
          return;
        }
        if (this.tutorial.active) {
          this.tutorial.update(state, FIXED_DT);
        } else {
          const cmd = this.ai.update(state, FIXED_DT);
          if (cmd) this.runner.applyNow(cmd);
        }
      });
      if (this.mp) this.updateMultiplayer();
      if (this.tutorial.active && this.tutorial.finished) {
        this.backToMenu();
        return;
      }
    } else if (this.phase === "menu") {
      // Keep a ticking clock so the menu's subtle pulse has something to ride on,
      // but never advance the match clock (countdown, front, pressure stay still).
      this.state.time += dt;
    }
    for (let i = 0; i < this.slotShake.length; i++) {
      if (this.slotShake[i] > 0) {
        this.slotShake[i] = Math.max(0, this.slotShake[i] - dt);
      }
    }
    this.emitAudioEvents();
    this.render();
  }

  /**
   * Observe sim-state transitions (post-tick) and fire the matching SFX.
   * We snapshot rather than hook into `sim.ts` because the sim must stay pure
   * for deterministic lockstep; audio is a local side-effect.
   */
  private emitAudioEvents(): void {
    // Countdown ticks + GO sting.
    if (this.phase === "playing" && !this.state.winner) {
      const cd = this.state.countdown;
      if (cd > 0) {
        const floor = Math.ceil(cd);
        if (this.prevCountdownFloor !== -1 && floor < this.prevCountdownFloor) {
          this.audio.playCountdownTick();
        }
        this.prevCountdownFloor = floor;
      } else if (this.prevCountdownFloor > 0) {
        this.audio.playCountdownGo();
        this.prevCountdownFloor = 0;
      }
    }

    // Structure-level transitions for both sides.
    for (const side of ["left", "right"] as Side[]) {
      const prev = this.prevStatuses[side];
      const prevSurge = this.prevSurge[side];
      const nextStatuses = new Map<number, StructureStatus>();
      const nextSurge = new Map<number, number>();
      const isOurs = side === this.ourSide;

      for (const s of this.state[side].slots) {
        if (!s) continue;
        nextStatuses.set(s.id, s.status);
        const prevStatus = prev.get(s.id);

        if (prevStatus && prevStatus !== s.status) {
          if (prevStatus === "growing" && s.status === "active" && isOurs) {
            this.audio.playBuildComplete();
          } else if (
            prevStatus === "mutating" &&
            s.status === "active" &&
            isOurs
          ) {
            this.audio.playMutateComplete();
          } else if (s.status === "disabled") {
            this.audio.playDisable();
          }
        }

        if (s.kind === "fruiting") {
          const curr = s.surgeTimer ?? 0;
          const previous = prevSurge.get(s.id) ?? 0;
          if (previous <= 0 && curr > 0) {
            this.audio.playSurge();
          }
          nextSurge.set(s.id, curr);
        }
      }
      this.prevStatuses[side] = nextStatuses;
      this.prevSurge[side] = nextSurge;
    }

    // Win / lose sting fires once on the winner transition.
    if (!this.prevWinner && this.state.winner) {
      if (this.state.winner === this.ourSide) {
        this.audio.playWin();
      } else {
        this.audio.playLose();
      }
      // The match is over — let the ambient bed breathe out.
      this.audio.stopAmbient();
    }
    this.prevWinner = this.state.winner;
  }

  // ---------- rendering ----------

  private render(): void {
    this.bg.clear();
    this.fx.clear();
    this.drawLog();
    this.drawSclerotia();
    this.drawSlotDivider();
    this.drawStructures("left");
    this.drawStructures("right");
    this.drawCombatLines("left");
    this.drawCombatLines("right");
    this.updateHud();
    this.updateBuildButtons();
    this.updateUpgradeButton();
    this.updateWinBanner();
    this.updateCountdown();
    this.updatePausedOverlay();
    this.updateControlButtons();
    this.updateTutorialHint();
    this.updateMenuOverlay();
    this.updateSummaryOverlay();
  }

  private drawSlotDivider(): void {
    const L = this.layout;
    const x = L.slotDividerX;
    // Soft vertical line that visually separates the player's slots (left)
    // from the enemy's slots (right). Drawn under structures so it never
    // covers a circle.
    this.bg.lineStyle(1, 0x6a4a30, 0.55);
    this.bg.beginPath();
    this.bg.moveTo(x, L.slotAreaTop);
    this.bg.lineTo(x, L.slotAreaBottom);
    this.bg.strokePath();
    // Tiny end caps so the line reads as intentional, not glitchy.
    this.bg.fillStyle(0x6a4a30, 0.55);
    this.bg.fillCircle(x, L.slotAreaTop, 2);
    this.bg.fillCircle(x, L.slotAreaBottom, 2);
  }

  /** Map a sim side to its view side. Our colony always occupies view-left so
   *  both players feel they're on the same edge of the board; the enemy sits
   *  on view-right. Sim semantics (state.left = host, state.right = guest)
   *  stay absolute — this is purely a rendering concern. */
  private viewSideOf(side: Side): Side {
    return side === this.ourSide ? "left" : "right";
  }

  private slotPosFor(side: Side, slotIdx: number): SlotSpec {
    return this.viewSideOf(side) === "left"
      ? this.layout.leftSlots[slotIdx]
      : this.layout.rightSlots[slotIdx];
  }

  private findStructurePos(
    side: Side,
    id: number,
  ): { pos: SlotSpec; structure: Structure } | null {
    const colony = this.state[side];
    for (let i = 0; i < colony.slots.length; i++) {
      const s = colony.slots[i];
      if (s && s.id === id) {
        return { pos: this.slotPosFor(side, i), structure: s };
      }
    }
    return null;
  }

  private drawLog(): void {
    const L = this.layout;

    // Soft elliptical vignette behind the log — stacked translucent ellipses
    // fake a radial falloff, since Phaser Graphics has no gradient fill.
    const cx = L.logLeft + L.logW / 2;
    const cy = L.logTop + L.logH / 2;
    for (let i = 0; i < 4; i++) {
      const t = 1 - i / 4;
      this.bg.fillStyle(0x2a1a0e, 0.06 * t);
      this.bg.fillEllipse(cx, cy, L.logW * (1.4 - i * 0.12), L.logH * (2.0 - i * 0.18));
    }

    // Log body (bark)
    this.bg.fillStyle(LOG_BARK, 1);
    this.bg.fillRoundedRect(L.logLeft - 10, L.logTop - 10, L.logW + 20, L.logH + 20, 16);
    this.bg.fillStyle(LOG_BODY, 1);
    this.bg.fillRoundedRect(L.logLeft, L.logTop, L.logW, L.logH, 12);

    // Inner top-edge highlight — thin sunlit band along the top of the log.
    this.bg.fillStyle(0x7a5232, 0.35);
    this.bg.fillRoundedRect(L.logLeft + 4, L.logTop + 3, L.logW - 8, 4, 2);
    // Inner bottom-edge shadow — rim of moisture / shade.
    this.bg.fillStyle(0x1a0e06, 0.35);
    this.bg.fillRoundedRect(L.logLeft + 4, L.logTop + L.logH - 6, L.logW - 8, 3, 2);

    // Grain lines — wavy, staggered, varying alpha for a lived-in feel.
    const grainLines = 7;
    for (let i = 1; i < grainLines; i++) {
      const yBase = L.logTop + (L.logH * i) / grainLines;
      const amp = 1.5 + ((i * 37) % 4);
      const period = 60 + ((i * 53) % 40);
      const phase = (i * 1.7) % (Math.PI * 2);
      const alpha = 0.25 + 0.15 * ((i * 31) % 4) / 3;
      this.bg.lineStyle(1, 0x2a1a0a, alpha);
      this.bg.beginPath();
      const steps = Math.max(12, Math.round(L.logW / 18));
      for (let s = 0; s <= steps; s++) {
        const x = L.logLeft + 8 + ((L.logW - 16) * s) / steps;
        const y = yBase + Math.sin(phase + (x / period) * Math.PI * 2) * amp;
        if (s === 0) this.bg.moveTo(x, y);
        else this.bg.lineTo(x, y);
      }
      this.bg.strokePath();
    }

    // Knots — a few dark elliptical eyes along the bark at stable positions.
    const knotCount = 3 + Math.floor(L.logW / 420);
    for (let k = 0; k < knotCount; k++) {
      const fx = 0.12 + (k * 0.2743) % 0.76; // evenly-ish distributed
      const fy = 0.25 + ((k * 0.5119) % 1) * 0.5;
      const x = L.logLeft + L.logW * fx;
      const y = L.logTop + L.logH * fy;
      const rw = 6 + (k % 3) * 2;
      const rh = 4 + (k % 2) * 2;
      this.bg.fillStyle(0x1a0e06, 0.8);
      this.bg.fillEllipse(x, y, rw * 2.2, rh * 2.2);
      this.bg.fillStyle(0x0e0704, 1);
      this.bg.fillEllipse(x, y, rw * 1.4, rh * 1.4);
      this.bg.fillStyle(0x3a2412, 1);
      this.bg.fillEllipse(x - rw * 0.15, y - rh * 0.2, rw * 0.5, rh * 0.4);
    }

    // Moss tufts along the top edge — soft clumps of cool green.
    const mossCount = 4 + Math.floor(L.logW / 360);
    for (let m = 0; m < mossCount; m++) {
      const fx = 0.08 + ((m * 0.1913) + 0.07) % 0.88;
      const x = L.logLeft + L.logW * fx;
      const y = L.logTop + 2 + ((m * 5) % 3);
      this.bg.fillStyle(0x3d5a24, 0.75);
      this.bg.fillEllipse(x, y, 26 + (m % 3) * 6, 6);
      this.bg.fillStyle(0x6b8a3a, 0.7);
      this.bg.fillEllipse(x - 3, y - 1, 18 + (m % 2) * 4, 4);
      this.bg.fillStyle(0x8da84a, 0.55);
      this.bg.fillEllipse(x + 2, y - 2, 10, 3);
    }

    // Tints follow view sides, not sim sides, so the joiner's colony color
    // fills their view-left (and the host's fills their view-right).
    const viewLeftTint = this.ourSide === "left" ? LEFT_TINT : RIGHT_TINT;
    const viewRightTint = this.ourSide === "left" ? RIGHT_TINT : LEFT_TINT;
    // Sim `front` is absolute (0 = sim-left heart, 1 = sim-right heart). For
    // the joiner we mirror it so their pressure always pushes rightward on
    // screen, matching the mirrored colony layout.
    const viewFront = this.ourSide === "left" ? this.state.front : 1 - this.state.front;
    const frontX = L.logLeft + L.logW * viewFront;

    // View-left colony color flow
    this.bg.fillStyle(viewLeftTint, 0.45);
    this.bg.fillRect(L.logLeft, L.logTop, frontX - L.logLeft, L.logH);

    // View-right colony color flow
    this.bg.fillStyle(viewRightTint, 0.45);
    this.bg.fillRect(frontX, L.logTop, L.logRight - frontX, L.logH);

    // Feathered seam — stacked translucent bands blend the hard split into a
    // soft territorial gradient on each side of the front.
    for (let i = 1; i <= 4; i++) {
      const step = i * 5;
      const a = 0.09 / i;
      this.fx.fillStyle(viewLeftTint, a);
      this.fx.fillRect(frontX, L.logTop, step, L.logH);
      this.fx.fillStyle(viewRightTint, a);
      this.fx.fillRect(frontX - step, L.logTop, step, L.logH);
    }

    // Contested seam — silvery shimmer. Widens during any active fruiting burst.
    const burstingSides = this.activeBurstStrength();
    const seamWidth = 4 + burstingSides * 6;
    const pulse = 0.55 + 0.25 * Math.sin(this.state.time * 6);
    if (burstingSides > 0) {
      this.fx.fillStyle(0xd9b8ff, 0.35 * burstingSides);
      this.fx.fillRect(
        frontX - seamWidth - 6,
        L.logTop - 8,
        seamWidth * 2 + 12,
        L.logH + 16,
      );
    }
    this.fx.fillStyle(0xcfd6ea, pulse);
    this.fx.fillRect(frontX - seamWidth, L.logTop - 4, seamWidth * 2, L.logH + 8);

    // Net pressure glow — expressed in view terms so "winner pushes forward"
    // reads consistently regardless of which sim side we are.
    const enemy: Side = this.ourSide === "left" ? "right" : "left";
    const myP = pressureOf(this.state, this.ourSide);
    const theirP = pressureOf(this.state, enemy);
    const netView = myP - theirP;
    if (Math.abs(netView) > 0.1) {
      const tint = netView > 0 ? viewLeftTint : viewRightTint;
      const dir = netView > 0 ? 1 : -1;
      const glowX = frontX + dir * 36;
      this.fx.fillStyle(tint, 0.25);
      this.fx.fillCircle(glowX, L.logTop + L.logH / 2, 48);
    }
  }

  /** Returns 0..2 — sum of "burst intensity" across both sides for seam emphasis. */
  private activeBurstStrength(): number {
    let total = 0;
    for (const side of ["left", "right"] as Side[]) {
      let sideStrength = 0;
      for (const s of this.state[side].slots) {
        if (!s || s.kind !== "fruiting") continue;
        if ((s.surgeTimer ?? 0) > 0) {
          sideStrength = Math.max(sideStrength, 1);
        }
      }
      total += sideStrength;
    }
    return total;
  }

  private drawSclerotia(): void {
    const L = this.layout;
    const enemy: Side = this.ourSide === "left" ? "right" : "left";
    // Our colony sits at the view-left heart; enemy at the view-right heart.
    // For the host this is a no-op; for the joiner this mirrors the board.
    this.drawHeart(this.ourSide, L.leftHeartX, L.heartY);
    this.drawHeart(enemy, L.rightHeartX, L.heartY);
  }

  private drawHeart(side: Side, x: number, y: number): void {
    const colony = this.state[side];
    const color = side === "left" ? LEFT_TINT : RIGHT_TINT;
    const r = this.layout.heartRadius;
    // Continuous breathing pulse — subtler during play, stronger in menu so
    // the idle state feels alive.
    const breathAmp = this.phase === "menu" ? 0.07 : 0.035;
    const breath = 1 + breathAmp * Math.sin(this.state.time * 1.6 + (side === "left" ? 0 : Math.PI / 2));

    // Radiating tendrils — fine mycelial threads fanning from the heart into
    // its half of the log. Deterministic angles keyed off a per-side seed so
    // they don't jitter between frames, but lengths breathe with the pulse.
    const seed = side === "left" ? 0.13 : 0.41;
    // Tendril fan direction follows screen position, not sim side, so a
    // joiner's heart rendered at view-left still fans into the log's middle.
    const inward = x < this.layout.W / 2 ? 1 : -1;
    const tendrilCount = 9;
    this.bg.lineStyle(1, color, 0.55);
    for (let i = 0; i < tendrilCount; i++) {
      const ang = (-Math.PI / 2) + (i / (tendrilCount - 1) - 0.5) * Math.PI * 1.4;
      const dirAng = ang * inward + (inward < 0 ? Math.PI : 0);
      const jitter = Math.sin((i * 1.7 + seed * 10) + this.state.time * 0.8) * 0.1;
      const theta = dirAng + jitter;
      const len = r * (2.2 + 0.6 * Math.sin(i * 2.1 + this.state.time * 1.2 + seed * 6));
      const steps = 6;
      this.bg.beginPath();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const curve = Math.sin(t * Math.PI) * r * 0.25 * Math.sin(i * 1.3 + seed * 5);
        const px = x + Math.cos(theta) * len * t + Math.cos(theta + Math.PI / 2) * curve;
        const py = y + Math.sin(theta) * len * t + Math.sin(theta + Math.PI / 2) * curve;
        if (s === 0) this.bg.moveTo(px, py);
        else this.bg.lineTo(px, py);
      }
      this.bg.strokePath();
    }

    // Outer halo — two layered translucent glows for depth.
    this.bg.fillStyle(color, 0.12);
    this.bg.fillCircle(x, y, r * 2.1 * breath);
    this.bg.fillStyle(color, 0.25);
    this.bg.fillCircle(x, y, r * 1.55 * breath);

    // Core body with a subtle inner gradient (stacked circles).
    this.bg.fillStyle(0x2a1810, 1);
    this.bg.fillCircle(x, y, r * 1.08);
    this.bg.fillStyle(color, 1);
    this.bg.fillCircle(x, y, r);
    // Rim shading on the lower-right and a warm highlight on the upper-left.
    this.bg.fillStyle(0x1a0e06, 0.25);
    this.bg.fillCircle(x + r * 0.25, y + r * 0.3, r * 0.7);
    this.bg.fillStyle(0xf5e8c8, 0.35);
    this.bg.fillCircle(x - r * 0.25, y - r * 0.3, r * 0.55);
    // Bright core
    this.bg.fillStyle(0xf5e8c8, 0.9);
    this.bg.fillCircle(x, y, r * 0.36 * breath);
    this.bg.fillStyle(0xfff3d0, 0.9);
    this.bg.fillCircle(x - r * 0.1, y - r * 0.1, r * 0.18);

    // Drifting spore motes — rise upward from the heart and fade out.
    // Positions are time-based so they animate, but each mote is keyed to a
    // stable offset so the swarm doesn't flicker between frames.
    const moteCount = 5;
    const driftHeight = r * 4;
    for (let i = 0; i < moteCount; i++) {
      const offset = (i / moteCount) + seed;
      const t = ((this.state.time * 0.22 + offset) % 1);
      const mx = x + Math.sin(t * Math.PI * 2 + i) * r * 0.6;
      const my = y - t * driftHeight;
      const alpha = Math.sin(t * Math.PI) * 0.6;
      const rad = 1.5 + Math.sin(t * Math.PI) * 2;
      this.fx.fillStyle(color, alpha * 0.4);
      this.fx.fillCircle(mx, my, rad * 1.8);
      this.fx.fillStyle(0xf5e8c8, alpha);
      this.fx.fillCircle(mx, my, rad);
    }

    // HP bar is part of the in-game HUD — hide it in the pre-game menu.
    if (this.phase !== "playing") return;

    // HP bar above the log so it never sits on bark, positioned in the gap
    // reserved by computeLayout so it can't collide with the HUD text.
    const sc = this.layout.uiScale;
    const hpW = Math.round(120 * sc);
    const hpH = Math.max(6, Math.round(12 * sc));
    const hpX = x - hpW / 2;
    const hpY = this.layout.logTop - this.layout.hpBarOffsetAboveLog;
    this.fx.fillStyle(0x000000, 0.5);
    this.fx.fillRect(hpX - 2, hpY - 2, hpW + 4, hpH + 4);
    this.fx.fillStyle(0x3a1a12, 1);
    this.fx.fillRect(hpX, hpY, hpW, hpH);
    const frac = Math.max(0, colony.hp / colony.maxHp);
    this.fx.fillStyle(frac > 0.3 ? 0x9bd45a : 0xd85a3a, 1);
    this.fx.fillRect(hpX, hpY, hpW * frac, hpH);
  }

  private drawStructures(side: Side): void {
    const colony = this.state[side];
    const positions =
      this.viewSideOf(side) === "left"
        ? this.layout.leftSlots
        : this.layout.rightSlots;
    const r = this.layout.slotRadius;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const basePos = positions[i];
      const s = colony.slots[i];

      // Shake offset for player-side denied taps on disabled slots.
      let shakeDx = 0;
      let shakeDy = 0;
      if (side === this.ourSide && this.slotShake[i] > 0) {
        const t = this.slotShake[i];
        shakeDx = Math.sin(t * 60) * 4;
      }
      const x = basePos.x + shakeDx;
      const y = basePos.y + shakeDy;

      // Slot frame
      this.bg.lineStyle(2, 0x6a4a30, 0.6);
      this.bg.strokeCircle(basePos.x, basePos.y, r);

      if (!s) continue;
      const cfg = STRUCTURES[s.kind];
      const disabled = s.status === "disabled";

      // Fill by kind. Disabled = desaturated (greyed) and droopy.
      let fillColor = cfg.color;
      let alpha: number;
      if (disabled) {
        fillColor = desaturate(cfg.color, 0.6);
        alpha = 0.55;
      } else if (s.status === "active") {
        alpha = 1;
      } else {
        alpha = 0.45;
      }
      const droop = disabled ? 4 : 0;

      // Soft glow behind structure — reads the structure's territory before
      // the shape itself renders. Stronger on active, faint while growing.
      const glowAlpha = s.status === "active" && !disabled ? 0.22 : 0.1;
      this.bg.fillStyle(fillColor, glowAlpha);
      this.bg.fillCircle(x, y + droop, r + 2);

      // Kind-specific shape fills the slot footprint.
      this.drawStructureShape(s.kind, x, y + droop, r - 4, fillColor, alpha, s.id);

      // Ring (level indicator) — now a warm rim rather than a hard circle.
      if (s.level > 1) {
        this.bg.lineStyle(3, 0xf5e8c8, disabled ? 0.4 : 0.9);
        this.bg.strokeCircle(x, y + droop, r - 2);
        // Inner tick accents to differentiate L2 vs L3+.
        if (s.level >= 3) {
          this.bg.lineStyle(1.5, 0xf5e8c8, disabled ? 0.3 : 0.7);
          this.bg.strokeCircle(x, y + droop, r - 7);
        }
      }

      // Progress arc while growing/mutating.
      if (s.status === "growing" || s.status === "mutating") {
        const cfgTime =
          s.status === "growing"
            ? cfg.buildTime
            : (nextUpgradeTime(s.kind, s.level) ?? cfg.buildTime);
        const prog = 1 - s.timer / cfgTime;
        const end = -Math.PI / 2 + prog * Math.PI * 2;
        this.fx.lineStyle(4, 0xf5e8c8, 0.95);
        this.fx.beginPath();
        this.fx.arc(x, y, r + 2, -Math.PI / 2, end, false);
        this.fx.strokePath();
      }

      // Disable countdown ring while disabled.
      if (disabled) {
        const remaining = s.disableTimer / DISABLE_DURATION;
        const end = -Math.PI / 2 + remaining * Math.PI * 2;
        this.fx.lineStyle(4, 0xff6a4a, 0.85);
        this.fx.beginPath();
        this.fx.arc(x, y, r + 4, -Math.PI / 2, end, false);
        this.fx.strokePath();
        // "Z" / Z-like wisp to read as offline.
        this.fx.lineStyle(2, 0xffd0a0, 0.8);
        this.fx.strokeCircle(x, y - r - 8, 3);
      }

      // Pressure wave (active structures only, periodic pulse). Skip pure-residual fruiting
      // so the visual reflects when it's actually surging.
      if (s.status === "active" && cfg.basePressure > 0) {
        const showPulse = s.kind !== "fruiting" || (s.surgeTimer ?? 0) > 0;
        if (showPulse) {
          const phase = (this.state.time * 0.8 + s.id * 0.37) % 1;
          const pr = r - 4 + phase * 32;
          this.fx.lineStyle(2, cfg.color, 1 - phase);
          this.fx.strokeCircle(x, y, pr);
        }
      }

      // Disable meter — thin horizontal bar under any structure with disableMeter > 0.
      if (s.disableMeter > 0 && !disabled) {
        const barW = (r - 4) * 2;
        const barH = 4;
        const barX = x - barW / 2;
        const barY = y + r + 4;
        const fill = s.disableMeter / DISABLE_THRESHOLD;
        const alphaBar = Math.min(1, 0.3 + fill);
        this.fx.fillStyle(0x000000, 0.5 * alphaBar);
        this.fx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
        this.fx.fillStyle(0x2a1810, alphaBar);
        this.fx.fillRect(barX, barY, barW, barH);
        this.fx.fillStyle(0xff6a4a, alphaBar);
        this.fx.fillRect(barX, barY, barW * fill, barH);
      }

      // Fruiting: vertical surge meter + smother haze.
      if (s.kind === "fruiting" && !disabled && s.status === "active") {
        const charge = (s.surgeCharge ?? 0) / SURGE_THRESHOLD;
        const meterH = (r - 4) * 2;
        const meterW = 5;
        const meterX = x + r + 2;
        const meterY = y - meterH / 2;
        this.fx.fillStyle(0x000000, 0.5);
        this.fx.fillRect(meterX - 1, meterY - 1, meterW + 2, meterH + 2);
        this.fx.fillStyle(0x2a1830, 1);
        this.fx.fillRect(meterX, meterY, meterW, meterH);
        this.fx.fillStyle(0xc080ff, 1);
        const fillH = meterH * charge;
        this.fx.fillRect(meterX, meterY + (meterH - fillH), meterW, fillH);
        // Suppression haze — purple wash when this fruiting has disable pressure on it.
        // Any source that fills the meter also slows the surge, so this reflects both.
        if (s.disableMeter > 0) {
          const fill = s.disableMeter / DISABLE_THRESHOLD;
          const intensity = Math.min(0.45, 0.12 + fill * 0.4);
          this.fx.fillStyle(0xb080d8, intensity);
          this.fx.fillCircle(x, y, r + 6);
        }
      }
    }
  }

  private drawStructureShape(
    kind: StructureKind,
    x: number,
    y: number,
    r: number,
    color: number,
    alpha: number,
    id: number,
  ): void {
    switch (kind) {
      case "hyphae":
        this.drawHyphaeShape(x, y, r, color, alpha, id);
        break;
      case "rhizomorph":
        this.drawRhizomorphShape(x, y, r, color, alpha, id);
        break;
      case "fruiting":
        this.drawFruitingShape(x, y, r, color, alpha, id);
        break;
      case "decomposer":
        this.drawDecomposerShape(x, y, r, color, alpha, id);
        break;
    }
  }

  /** Hyphal mat: dense tufted center with radial threads feathering outward. */
  private drawHyphaeShape(
    x: number,
    y: number,
    r: number,
    color: number,
    alpha: number,
    id: number,
  ): void {
    // Base mat — slightly darker outer disc, warmer inner core.
    this.bg.fillStyle(0x2a1810, alpha * 0.6);
    this.bg.fillCircle(x, y, r);
    this.bg.fillStyle(color, alpha * 0.7);
    this.bg.fillCircle(x, y, r * 0.92);
    this.bg.fillStyle(color, alpha);
    this.bg.fillCircle(x, y, r * 0.55);
    // Radial threads — many thin lines from center out past the disc edge.
    const threads = 14;
    this.bg.lineStyle(1, color, alpha * 0.8);
    for (let i = 0; i < threads; i++) {
      const ang = (i / threads) * Math.PI * 2 + (id * 0.173);
      const len = r * (1.05 + 0.22 * Math.sin(i * 1.7 + id));
      this.bg.beginPath();
      this.bg.moveTo(x + Math.cos(ang) * r * 0.3, y + Math.sin(ang) * r * 0.3);
      this.bg.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      this.bg.strokePath();
    }
    // Central highlight tuft.
    this.bg.fillStyle(0xf5e8c8, alpha * 0.35);
    this.bg.fillCircle(x - r * 0.1, y - r * 0.1, r * 0.25);
  }

  /** Rhizomorph: braided cord coiled into a tight spiral rosette. */
  private drawRhizomorphShape(
    x: number,
    y: number,
    r: number,
    color: number,
    alpha: number,
    id: number,
  ): void {
    // Dark backing pad so the coil reads against the slot frame.
    this.bg.fillStyle(0x2a2428, alpha * 0.55);
    this.bg.fillCircle(x, y, r);
    // Two interleaved spirals that evoke a braided cord.
    const turns = 2.4;
    const steps = 48;
    const outer = r * 0.95;
    const drawSpiral = (
      phaseOff: number,
      width: number,
      shade: number,
      a: number,
    ) => {
      this.bg.lineStyle(width, shade, a);
      this.bg.beginPath();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const radius = outer * (1 - t * 0.9);
        const ang = phaseOff + t * Math.PI * 2 * turns + id * 0.31;
        const px = x + Math.cos(ang) * radius;
        const py = y + Math.sin(ang) * radius;
        if (s === 0) this.bg.moveTo(px, py);
        else this.bg.lineTo(px, py);
      }
      this.bg.strokePath();
    };
    drawSpiral(0, 5, 0x4a4048, alpha * 0.9);
    drawSpiral(Math.PI, 5, 0x4a4048, alpha * 0.9);
    drawSpiral(0, 3, color, alpha);
    drawSpiral(Math.PI, 3, color, alpha);
    // Bright highlight specks along the ridge on the upper-left.
    this.bg.fillStyle(0xf5e8c8, alpha * 0.6);
    for (let i = 0; i < 3; i++) {
      const ang = Math.PI * 0.75 + i * 0.6 + id * 0.11;
      const rad = r * (0.25 + i * 0.2);
      this.bg.fillCircle(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad, 1.4);
    }
  }

  /** Fruiting cluster: three mushroom silhouettes rising out of the slot. */
  private drawFruitingShape(
    x: number,
    y: number,
    r: number,
    color: number,
    alpha: number,
    id: number,
  ): void {
    // Dark wet base — a little pool of substrate under the cluster.
    this.bg.fillStyle(0x2a1820, alpha * 0.7);
    this.bg.fillEllipse(x, y + r * 0.55, r * 1.7, r * 0.55);

    // Three mushrooms — stable offsets per id so the cluster doesn't jitter.
    const caps: { dx: number; dy: number; capR: number; stemH: number; scale: number }[] = [
      { dx: -r * 0.5, dy: r * 0.05, capR: r * 0.48, stemH: r * 0.55, scale: 1.0 },
      { dx: r * 0.05, dy: -r * 0.15, capR: r * 0.6, stemH: r * 0.85, scale: 1.1 },
      { dx: r * 0.55, dy: r * 0.15, capR: r * 0.4, stemH: r * 0.5, scale: 0.85 },
    ];
    const stemColor = 0xe8d9b0;
    const stemShade = 0xa89878;
    // Sort back-to-front by dy so nearer mushrooms overlap farther ones.
    const order = [0, 1, 2].sort((a, b) => caps[a].dy - caps[b].dy);
    for (const idx of order) {
      const m = caps[idx];
      const cx = x + m.dx;
      const stemBase = y + r * 0.5;
      const stemTop = stemBase - m.stemH;
      const stemW = m.capR * 0.34;
      // Stem (slightly curved with a hint of shadow)
      this.bg.fillStyle(stemShade, alpha);
      this.bg.fillRoundedRect(cx - stemW / 2, stemTop, stemW, m.stemH, stemW / 2);
      this.bg.fillStyle(stemColor, alpha);
      this.bg.fillRoundedRect(
        cx - stemW / 2 + 1,
        stemTop,
        stemW - 2,
        m.stemH,
        (stemW - 2) / 2,
      );
      // Cap shadow underside (gill band).
      this.bg.fillStyle(0x3a2830, alpha);
      this.bg.fillEllipse(cx, stemTop + 2, m.capR * 1.9, m.capR * 0.6);
      // Cap body.
      this.bg.fillStyle(color, alpha);
      this.bg.fillEllipse(cx, stemTop - m.capR * 0.15, m.capR * 2.0, m.capR * 1.3);
      // Cap highlight.
      this.bg.fillStyle(0xf0c8ff, alpha * 0.5);
      this.bg.fillEllipse(
        cx - m.capR * 0.3,
        stemTop - m.capR * 0.4,
        m.capR * 0.8,
        m.capR * 0.35,
      );
      // A couple of light spots on the cap (fairy-tale speckle).
      this.bg.fillStyle(0xf5e8c8, alpha * 0.65);
      this.bg.fillCircle(cx + m.capR * 0.35, stemTop - m.capR * 0.25, 1.6);
      this.bg.fillCircle(cx - m.capR * 0.2, stemTop - m.capR * 0.05, 1.2);
    }
    void id;
  }

  /** Decomposer: ragged rot patch staining the bark with ochre colonies. */
  private drawDecomposerShape(
    x: number,
    y: number,
    r: number,
    color: number,
    alpha: number,
    id: number,
  ): void {
    // Five overlapping irregular blobs give the rot its broken-down feel.
    const blobs = 5;
    this.bg.fillStyle(0x3a2410, alpha * 0.7);
    for (let i = 0; i < blobs; i++) {
      const ang = (i / blobs) * Math.PI * 2 + id * 0.21;
      const dist = r * 0.45 * ((i * 0.37) % 1);
      this.bg.fillCircle(
        x + Math.cos(ang) * dist,
        y + Math.sin(ang) * dist,
        r * (0.55 + ((i * 0.29) % 0.3)),
      );
    }
    // Main ochre layer.
    this.bg.fillStyle(color, alpha * 0.9);
    for (let i = 0; i < blobs; i++) {
      const ang = (i / blobs) * Math.PI * 2 + id * 0.21 + 0.7;
      const dist = r * 0.35 * ((i * 0.41) % 1);
      this.bg.fillCircle(
        x + Math.cos(ang) * dist,
        y + Math.sin(ang) * dist,
        r * (0.45 + ((i * 0.19) % 0.25)),
      );
    }
    // Wet dark center.
    this.bg.fillStyle(0x5a2a10, alpha * 0.85);
    this.bg.fillCircle(x + r * 0.05, y + r * 0.05, r * 0.3);
    // Cream spore flecks around the rim.
    this.bg.fillStyle(0xf5e8c8, alpha * 0.7);
    for (let i = 0; i < 6; i++) {
      const ang = i * 1.04 + id * 0.17;
      const dist = r * (0.65 + (i % 2) * 0.15);
      this.bg.fillCircle(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, 1.2);
    }
  }

  private drawCombatLines(side: Side): void {
    const colony = this.state[side];
    const enemy: Side = side === "left" ? "right" : "left";
    for (let i = 0; i < colony.slots.length; i++) {
      const s = colony.slots[i];
      if (!s || s.status !== "active") continue;
      const fromPos = this.slotPosFor(side, i);

      if (s.kind === "rhizomorph" && s.rhizoTargetId != null) {
        const targetInfo = this.findStructurePos(enemy, s.rhizoTargetId);
        if (!targetInfo) continue;
        const tp = targetInfo.pos;
        const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.state.time * 8 + s.id));
        // Paired braided threads — two sinusoidal strands offset perpendicular
        // to the attack line read as a living mycelial cord rather than a laser.
        const dx = tp.x - fromPos.x;
        const dy = tp.y - fromPos.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const steps = 16;
        const amp = 4;
        for (const strand of [-1, 1]) {
          this.fx.lineStyle(strand === -1 ? 2.5 : 1.5, 0xdfe4ec, pulse);
          this.fx.beginPath();
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const wobble =
              Math.sin(t * Math.PI * 2.4 + this.state.time * 6 + s.id + strand) *
              amp *
              Math.sin(t * Math.PI);
            const px = fromPos.x + dx * t + nx * wobble * strand;
            const py = fromPos.y + dy * t + ny * wobble * strand;
            if (k === 0) this.fx.moveTo(px, py);
            else this.fx.lineTo(px, py);
          }
          this.fx.strokePath();
        }
        // Impact ripple at the target.
        const ripple = (this.state.time * 2 + s.id * 0.13) % 1;
        this.fx.lineStyle(1.5, 0xdfe4ec, (1 - ripple) * pulse);
        this.fx.strokeCircle(tp.x, tp.y, 4 + ripple * 10);
        this.fx.fillStyle(0xf5e8c8, pulse);
        this.fx.fillCircle(tp.x, tp.y, 3);
      }

      if (s.kind === "fruiting" && (s.surgeTimer ?? 0) > 0 && s.surgeTargetId != null) {
        const targetInfo = this.findStructurePos(enemy, s.surgeTargetId);
        if (!targetInfo) continue;
        const tp = targetInfo.pos;
        // Pulse races toward target during the burst window.
        const cfgDur = 1; // visual lifetime of the streak
        const t = 1 - Math.min(1, (s.surgeTimer ?? 0) / cfgDur);
        const headX = fromPos.x + (tp.x - fromPos.x) * t;
        const headY = fromPos.y + (tp.y - fromPos.y) * t;
        // Tapered streak — draw as two overlaid lines with a soft outer glow.
        this.fx.lineStyle(8, 0xc080ff, 0.25);
        this.fx.beginPath();
        this.fx.moveTo(fromPos.x, fromPos.y);
        this.fx.lineTo(headX, headY);
        this.fx.strokePath();
        this.fx.lineStyle(4, 0xc080ff, 0.85);
        this.fx.beginPath();
        this.fx.moveTo(fromPos.x, fromPos.y);
        this.fx.lineTo(headX, headY);
        this.fx.strokePath();
        // Leading spore cloud head (halo + bright core).
        this.fx.fillStyle(0xc080ff, 0.45);
        this.fx.fillCircle(headX, headY, 11);
        this.fx.fillStyle(0xe8c0ff, 1);
        this.fx.fillCircle(headX, headY, 6);
        // Impact splash — expanding rings + scattered motes once the head
        // nears the target. Fades out over the back half of the burst.
        const proximity = Math.min(1, t);
        if (proximity > 0.4) {
          const splashT = (proximity - 0.4) / 0.6;
          const splashAlpha = (1 - splashT) * 0.9;
          this.fx.lineStyle(2, 0xe8c0ff, splashAlpha);
          this.fx.strokeCircle(tp.x, tp.y, 6 + splashT * 22);
          this.fx.lineStyle(1, 0xc080ff, splashAlpha * 0.6);
          this.fx.strokeCircle(tp.x, tp.y, 10 + splashT * 32);
          // Scatter a few spore motes around the impact.
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2 + s.id * 0.23;
            const dist = (6 + splashT * 22) * (0.7 + ((k * 0.29) % 0.3));
            this.fx.fillStyle(0xe8c0ff, splashAlpha);
            this.fx.fillCircle(tp.x + Math.cos(ang) * dist, tp.y + Math.sin(ang) * dist, 2);
          }
        }
      }
    }
  }

  private updateHud(): void {
    if (this.phase === "menu") {
      this.topText.setText("");
      return;
    }
    const enemy: Side = this.ourSide === "left" ? "right" : "left";
    const me = this.state[this.ourSide];
    const them = this.state[enemy];
    const myP = pressureOf(this.state, this.ourSide).toFixed(1);
    const theirP = pressureOf(this.state, enemy).toFixed(1);
    // Icon-based, centered HUD so it doesn't butt up against the top-left
    // (vs Friend) or top-right (pause/restart) controls. 🍂 nutrients,
    // 💥 pressure, ❤ HP — all BMP / emoji codepoints that fall back to the
    // system emoji font via the canvas text stack.
    this.topText.setText(
      [
        `YOU    🍂 ${Math.floor(me.nutrients)} (+${me.income.toFixed(1)}/s)    💥 ${myP}    ❤ ${Math.ceil(me.hp)}`,
        `ENEMY  🍂 ${Math.floor(them.nutrients)} (+${them.income.toFixed(1)}/s)    💥 ${theirP}    ❤ ${Math.ceil(them.hp)}`,
      ].join("\n"),
    );
  }

  private updateWinBanner(): void {
    if (!this.state.winner) {
      this.winText.setText("");
      return;
    }
    // In multiplayer the rematch overlay owns the end-of-match UI (showing
    // the result alongside Rematch/Leave), so leave the banner blank to
    // avoid a visual clash with the modal.
    if (this.mp) {
      this.winText.setText("");
      return;
    }
    const msg = this.state.winner === this.ourSide ? "VICTORY" : "DEFEAT";
    this.winText.setText(`${msg}\ntap for menu`);
  }

  private updateCountdown(): void {
    if (this.phase !== "playing" || this.state.winner) {
      this.countdownText.setText("");
      return;
    }
    if (this.state.countdown > 0) {
      this.countdownText.setText(String(Math.ceil(this.state.countdown)));
    } else if (this.state.time < 0.6) {
      this.countdownText.setText("GO!");
    } else {
      this.countdownText.setText("");
    }
  }

  // ---------- UI: build buttons ----------

  private createBuildButtons(): void {
    KINDS.forEach((kind) => {
      const bg = this.add.graphics();
      const title = this.add
        .text(0, 0, "", {
          fontSize: "22px",
          color: "#f8ecc8",
          fontStyle: "bold",
          align: "center",
          fontFamily: "system-ui, sans-serif",
          stroke: "#1b120a",
          strokeThickness: 3,
        })
        .setOrigin(0.5);
      const detail = this.add
        .text(0, 0, "", {
          fontSize: "18px",
          color: "#f0e2bc",
          align: "center",
          fontFamily: "system-ui, sans-serif",
          stroke: "#1b120a",
          strokeThickness: 2,
          lineSpacing: 4,
        })
        .setOrigin(0.5);
      const container = this.add.container(0, 0, [bg, title, detail]);
      const zone = this.add.zone(0, 0, 10, 10).setInteractive({ useHandCursor: true });
      zone.on("pointerdown", () => this.onBuildTap(kind));
      this.buildBtns.push({ kind, container, title, detail, bg });
      this.buildBtnZones.push(zone);
    });
  }

  private updateBuildButtons(): void {
    const show = this.phase === "playing";
    for (let i = 0; i < this.buildBtns.length; i++) {
      const { kind, container, title, detail, bg } = this.buildBtns[i];
      bg.clear();
      const zone = this.buildBtnZones[i];
      if (!show) {
        title.setText("");
        detail.setText("");
        if (zone.input?.enabled) zone.disableInteractive();
        continue;
      }
      if (!zone.input?.enabled) zone.setInteractive({ useHandCursor: true });
      const x = container.getData("x") as number;
      const y = container.getData("y") as number;
      const w = container.getData("w") as number;
      const h = container.getData("h") as number;
      const cfg = STRUCTURES[kind];
      const can = canBuild(this.state, this.ourSide, kind);

      bg.fillStyle(can ? 0x3a2a18 : 0x241a10, 1);
      bg.fillRoundedRect(x, y, w, h, 10);
      bg.lineStyle(3, can ? cfg.color : 0x4a3420, 1);
      bg.strokeRoundedRect(x, y, w, h, 10);

      const info =
        kind === "decomposer"
          ? `+🍂 ${cfg.incomeBonus}/s`
          : `💥 ${cfg.basePressure}`;
      title.setText(cfg.label);
      title.setColor(can ? "#f8ecc8" : "#9a8a70");
      detail.setText(`🍂 ${cfg.cost} · ${cfg.buildTime}s\n${info}`);
      detail.setColor(can ? "#f0e2bc" : "#8a7a60");
    }
  }

  private onBuildTap(kind: StructureKind): void {
    if (this.state.winner || this.paused) return;
    // Play the placement "tok" immediately (before the command is queued in
    // MP) — gives the player instant tactile feedback even when the lockstep
    // input-delay means the sim-level placement is a few ticks away.
    if (canBuild(this.state, this.ourSide, kind)) {
      this.audio.resume();
      this.audio.playBuildStart();
    }
    this.runner.submitLocalCommand({
      kind: "build",
      side: this.ourSide,
      structure: kind,
    });
  }

  // ---------- UI: pause/restart controls ----------

  private createControlButtons(): void {
    const pauseBg = this.add.graphics().setDepth(15);
    const pauseIcon = this.add
      .text(0, 0, "", {
        fontSize: "34px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(16);
    const pauseZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(16);
    pauseZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      this.togglePause();
    });
    this.pauseBtn = { bg: pauseBg, icon: pauseIcon };
    this.pauseBtnZone = pauseZone;

    const restartBg = this.add.graphics().setDepth(15);
    const restartIcon = this.add
      .text(0, 0, "\u21BB", {
        fontSize: "40px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(16);
    const restartZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(16);
    restartZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      this.handleRestartTap();
    });
    this.restartBtn = { bg: restartBg, icon: restartIcon };
    this.restartBtnZone = restartZone;

    // Tutorial & difficulty buttons live inside the menu modal (depth 27+)
    // and are hidden while a match is underway.
    const tutorialBg = this.add.graphics().setDepth(27);
    const tutorialLabel = this.add
      .text(0, 0, "How to Play", {
        fontSize: "20px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(28);
    const tutorialZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(28);
    tutorialZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      if (this.tutorial.active) {
        this.startTutorial();
        return;
      }
      this.summaryVisible = !this.summaryVisible;
    });
    this.tutorialBtn = { bg: tutorialBg, label: tutorialLabel };
    this.tutorialBtnZone = tutorialZone;

    const diffBg = this.add.graphics().setDepth(27);
    const diffLabel = this.add
      .text(0, 0, "", {
        fontSize: "20px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(28);
    const diffZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(28);
    diffZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      this.cycleDifficulty();
    });
    this.difficultyBtn = { bg: diffBg, label: diffLabel };
    this.difficultyBtnZone = diffZone;
  }

  private updateControlButtons(): void {
    const inMenu = this.phase === "menu";
    // Pause & Restart belong to the active match — keep them out of the menu.
    this.setBtnVisible(this.pauseBtn, this.pauseBtnZone, !inMenu);
    this.setBtnVisible(this.restartBtn, this.restartBtnZone, !inMenu);
    if (!inMenu) {
      this.drawControlButton(this.pauseBtn, this.paused ? 0x3a5a28 : 0x3a2a18);
      this.pauseBtn.icon.setText(this.paused ? "\u25B6" : "\u23F8");
      this.drawControlButton(this.restartBtn, 0x3a2a18);
      // In MP a unilateral restart would desync, so the same button leaves
      // the match instead. Swap the glyph so the affordance is obvious.
      this.restartBtn.icon.setText(this.mp ? "\u2715" : "\u21BB");
    }
    // Tutorial + difficulty live inside the pre-game modal. Hide them once
    // the match begins, and while the HOW TO PLAY modal is open on top.
    const showMenuBtns = inMenu && !this.summaryVisible;
    this.setLabeledBtnVisible(this.tutorialBtn, this.tutorialBtnZone, showMenuBtns);
    this.setLabeledBtnVisible(this.difficultyBtn, this.difficultyBtnZone, showMenuBtns);
    if (showMenuBtns) {
      this.drawTutorialButton();
      this.drawDifficultyButton();
    }
  }

  private setBtnVisible(
    btn: { bg: Phaser.GameObjects.Graphics; icon: Phaser.GameObjects.Text },
    zone: Phaser.GameObjects.Zone,
    visible: boolean,
  ): void {
    btn.bg.setVisible(visible);
    btn.icon.setVisible(visible);
    if (visible) {
      if (!zone.input?.enabled) zone.setInteractive({ useHandCursor: true });
    } else {
      btn.bg.clear();
      if (zone.input?.enabled) zone.disableInteractive();
    }
  }

  private setLabeledBtnVisible(
    btn: { bg: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text },
    zone: Phaser.GameObjects.Zone,
    visible: boolean,
  ): void {
    btn.bg.setVisible(visible);
    btn.label.setVisible(visible);
    if (visible) {
      if (!zone.input?.enabled) zone.setInteractive({ useHandCursor: true });
    } else {
      btn.bg.clear();
      if (zone.input?.enabled) zone.disableInteractive();
    }
  }

  private drawTutorialButton(): void {
    const x = this.tutorialBtn.bg.getData("x") as number;
    const y = this.tutorialBtn.bg.getData("y") as number;
    const w = this.tutorialBtn.bg.getData("w") as number;
    const h = this.tutorialBtn.bg.getData("h") as number;
    this.tutorialBtn.bg.clear();
    this.tutorialBtn.bg.fillStyle(0x3a2a18, 0.95);
    this.tutorialBtn.bg.fillRoundedRect(x, y, w, h, 10);
    this.tutorialBtn.bg.lineStyle(2, 0xf5e8c8, 0.8);
    this.tutorialBtn.bg.strokeRoundedRect(x, y, w, h, 10);
  }

  private drawDifficultyButton(): void {
    const x = this.difficultyBtn.bg.getData("x") as number;
    const y = this.difficultyBtn.bg.getData("y") as number;
    const w = this.difficultyBtn.bg.getData("w") as number;
    const h = this.difficultyBtn.bg.getData("h") as number;
    const fill =
      this.difficulty === "hard"
        ? 0x6a2a18
        : this.difficulty === "medium"
          ? 0x6a4a18
          : 0x2a3a28;
    const label =
      this.difficulty === "hard"
        ? "AI: Hard"
        : this.difficulty === "medium"
          ? "AI: Medium"
          : "AI: Easy";
    this.difficultyBtn.bg.clear();
    this.difficultyBtn.bg.fillStyle(fill, 0.95);
    this.difficultyBtn.bg.fillRoundedRect(x, y, w, h, 10);
    this.difficultyBtn.bg.lineStyle(2, 0xf5e8c8, 0.8);
    this.difficultyBtn.bg.strokeRoundedRect(x, y, w, h, 10);
    this.difficultyBtn.label.setText(label);
  }

  private updateTutorialHint(): void {
    if (!this.tutorial.active) {
      this.hintText.setVisible(false);
      return;
    }
    const msg = this.tutorial.currentHint();
    if (!msg) {
      this.hintText.setVisible(false);
      return;
    }
    const L = this.layout;
    const sc = L.uiScale;
    this.hintText
      .setVisible(true)
      .setText(msg)
      .setFontSize(`${Math.max(14, Math.round(20 * sc))}px`)
      .setPosition(L.W / 2, Math.round(90 * sc));
  }

  private startTutorial(): void {
    this.scene.restart({ tutorial: true } satisfies GameSceneData);
  }

  private drawControlButton(
    btn: { bg: Phaser.GameObjects.Graphics; icon: Phaser.GameObjects.Text },
    fill: number,
  ): void {
    const x = btn.bg.getData("x") as number;
    const y = btn.bg.getData("y") as number;
    const size = btn.bg.getData("size") as number;
    btn.bg.clear();
    btn.bg.fillStyle(fill, 0.9);
    btn.bg.fillRoundedRect(x, y, size, size, 10);
    btn.bg.lineStyle(2, 0xf5e8c8, 0.8);
    btn.bg.strokeRoundedRect(x, y, size, size, 10);
  }

  // ---------- UI: pre-game menu ----------

  private createMenuOverlay(): void {
    // Full-screen dim + panel frame. Sits above the game but below the menu
    // widgets so the title/Spread/buttons read as foreground.
    this.menuBg = this.add.graphics().setDepth(24);

    this.titleText = this.add
      .text(0, 0, "Sporefall", {
        fontSize: "72px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
        stroke: "#1b120a",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(26);

    this.subtitleText = this.add
      .text(0, 0, "Spread the colony. Push the front.", {
        fontSize: "20px",
        color: "#cdb98a",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(26);

    // Native button: fullscreen/orientation requests need a live user gesture,
    // so we let the browser dispatch the click directly rather than routing
    // through Phaser's queued input (see spreadEl comment for details).
    this.spreadEl = document.getElementById("spread-btn") as HTMLButtonElement | null;
    const onStart = (): void => this.startPlay();
    const onStartMp = (ev: Event): void => {
      const detail = (ev as CustomEvent<MpSceneConfig>).detail;
      if (!detail) return;
      this.scene.restart({ mp: detail } satisfies GameSceneData);
    };
    window.addEventListener("sporefall:start", onStart);
    window.addEventListener("sporefall:start-mp", onStartMp);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("sporefall:start", onStart);
      window.removeEventListener("sporefall:start-mp", onStartMp);
    });
  }

  private updateMenuOverlay(): void {
    // Hide the pre-game panel while the HOW TO PLAY modal is open so its
    // title/Spread/CTA row don't bleed through the summary.
    const show = this.phase === "menu" && !this.summaryVisible;
    this.menuBg.setVisible(show);
    this.titleText.setVisible(show);
    this.subtitleText.setVisible(show);
    if (this.spreadEl) {
      this.spreadEl.classList.toggle("visible", show);
    }
    if (!show) {
      this.menuBg.clear();
      return;
    }
    const L = this.layout;

    // Modal backdrop: dim the whole screen, then draw a framed panel.
    this.menuBg.clear();
    this.menuBg.fillStyle(0x1b120a, 0.72);
    this.menuBg.fillRect(0, 0, L.W, L.H);
    const panel = L.menuPanel;
    this.menuBg.fillStyle(0x2a1c10, 0.96);
    this.menuBg.fillRoundedRect(panel.x, panel.y, panel.w, panel.h, 16);
    this.menuBg.lineStyle(2, 0xf5e8c8, 0.55);
    this.menuBg.strokeRoundedRect(panel.x, panel.y, panel.w, panel.h, 16);
  }

  private startPlay(): void {
    if (this.phase === "playing") return;
    this.phase = "playing";
    // Countdown starts fresh from the config default now that the player has tapped.
    this.state.countdown = START_COUNTDOWN;
    this.state.time = 0;
    this.prevCountdownFloor = Math.ceil(this.state.countdown);
    // Re-position anything that depends on per-phase visibility.
    this.applyLayout();
    // Fires synchronously inside the Spread pointer handler so main.ts can
    // kick off fullscreen+landscape as part of the same user gesture.
    emitPhase(this.phase);
    this.audio.resume();
    this.audio.startAmbient();
  }

  // ---------- UI: tutorial summary overlay (toggled via the "?" button) ----------

  private createSummaryOverlay(): void {
    // Summary sits above the menu modal (depth 24-28) so it reads as a
    // foreground popup layered on top of the pre-game panel.
    this.summaryBg = this.add.graphics().setDepth(30).setVisible(false);

    // Backdrop zone: blocks taps on underlying UI and dismisses the panel
    // when the player taps outside the Start button.
    this.summaryBackdropZone = this.add.zone(0, 0, 10, 10).setDepth(30);
    this.summaryBackdropZone.on(
      "pointerdown",
      (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
        e.stopPropagation?.();
        this.summaryVisible = false;
      },
    );

    this.summaryText = this.add
      .text(
        0,
        0,
        "HOW TO PLAY\n\n\u2022 Build structures to push the front\n\u2022 Only one construction at a time\n\u2022 Upgrade pauses pressure\n\u2022 Don't get overrun",
        {
          fontSize: "22px",
          color: "#f5e8c8",
          fontFamily: "system-ui, sans-serif",
          align: "center",
          stroke: "#1b120a",
          strokeThickness: 3,
          lineSpacing: 6,
        },
      )
      .setOrigin(0.5)
      .setDepth(31)
      .setVisible(false);

    const bg = this.add.graphics().setDepth(31).setVisible(false);
    const label = this.add
      .text(0, 0, "Start Tutorial", {
        fontSize: "28px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(32)
      .setVisible(false);
    const zone = this.add
      .zone(0, 0, 10, 10)
      .setDepth(32);
    zone.on(
      "pointerdown",
      (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
        e.stopPropagation?.();
        this.summaryVisible = false;
        this.startTutorial();
      },
    );
    this.summaryStartBtn = { bg, label };
    this.summaryStartZone = zone;
  }

  private updateSummaryOverlay(): void {
    const show = this.summaryVisible && !this.tutorial.active;
    this.summaryBg.setVisible(show);
    this.summaryText.setVisible(show);
    this.summaryStartBtn.bg.setVisible(show);
    this.summaryStartBtn.label.setVisible(show);
    if (!show) {
      if (this.summaryStartZone.input?.enabled) {
        this.summaryStartZone.disableInteractive();
      }
      if (this.summaryBackdropZone.input?.enabled) {
        this.summaryBackdropZone.disableInteractive();
      }
      this.summaryBg.clear();
      this.summaryStartBtn.bg.clear();
      return;
    }
    if (!this.summaryStartZone.input?.enabled) {
      this.summaryStartZone.setInteractive({ useHandCursor: true });
    }
    const L = this.layout;
    const sc = L.uiScale;
    const px = (n: number) => `${Math.max(12, Math.round(n * sc))}px`;

    // Full-screen backdrop catches taps outside the button so they dismiss
    // the panel instead of hitting build/pause/restart buttons beneath it.
    this.summaryBackdropZone
      .setPosition(L.W / 2, L.H / 2)
      .setSize(L.W, L.H);
    if (!this.summaryBackdropZone.input?.enabled) {
      this.summaryBackdropZone.setInteractive();
    }

    // Dim the whole screen so the panel reads as modal.
    this.summaryBg.clear();
    this.summaryBg.fillStyle(0x1b120a, 0.72);
    this.summaryBg.fillRect(0, 0, L.W, L.H);

    const panelW = Math.min(L.W - Math.round(40 * sc), Math.round(620 * sc));
    const panelH = Math.round(360 * sc);
    const panelX = Math.round(L.W / 2 - panelW / 2);
    const panelY = Math.round(L.H / 2 - panelH / 2);
    this.summaryBg.fillStyle(0x2a1c10, 0.96);
    this.summaryBg.fillRoundedRect(panelX, panelY, panelW, panelH, 14);
    this.summaryBg.lineStyle(2, 0xf5e8c8, 0.6);
    this.summaryBg.strokeRoundedRect(panelX, panelY, panelW, panelH, 14);

    this.summaryText.setPosition(L.W / 2, panelY + Math.round(panelH * 0.42));
    this.summaryText.setFontSize(px(20));

    const btnW = Math.round(panelW * 0.55);
    const btnH = Math.round(56 * sc);
    const btnX = Math.round(L.W / 2 - btnW / 2);
    const btnY = Math.round(panelY + panelH - btnH - Math.round(24 * sc));
    this.summaryStartBtn.bg.clear();
    this.summaryStartBtn.bg.fillStyle(0x3a5a28, 0.95);
    this.summaryStartBtn.bg.fillRoundedRect(btnX, btnY, btnW, btnH, 10);
    this.summaryStartBtn.bg.lineStyle(2, 0xf5e8c8, 0.8);
    this.summaryStartBtn.bg.strokeRoundedRect(btnX, btnY, btnW, btnH, 10);
    this.summaryStartBtn.label.setPosition(btnX + btnW / 2, btnY + btnH / 2);
    this.summaryStartBtn.label.setFontSize(px(24));
    this.summaryStartZone
      .setPosition(btnX + btnW / 2, btnY + btnH / 2)
      .setSize(btnW, btnH);
  }

  private togglePause(): void {
    if (this.state.winner) return;
    if (this.state.countdown > 0) return;
    this.paused = !this.paused;
  }

  private updatePausedOverlay(): void {
    this.pausedText.setText(this.paused && !this.state.winner ? "PAUSED" : "");
  }

  // ---------- UI: slot interactions ----------

  private createSlotHitAreas(): void {
    for (let idx = 0; idx < SLOT_COUNT; idx++) {
      const hit = this.add
        .circle(0, 0, 35, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      hit.on("pointerdown", () => this.onSlotTap(idx));
      this.slotHit.push(hit);
    }
  }

  private onSlotTap(idx: number): void {
    if (this.state.winner) return;
    const s = this.state[this.ourSide].slots[idx];
    // Only selectable slots with a structure. Empty slots use the build bar.
    if (!s) {
      this.selectedSlotIdx = null;
      return;
    }
    if (s.status === "disabled") {
      // Reject the selection visibly — flash + shake. Keep current selection.
      this.slotShake[idx] = 0.35;
      return;
    }
    this.selectedSlotIdx = idx;
  }

  // ---------- UI: upgrade button ----------

  private createBackgroundZone(): void {
    const zone = this.add.zone(0, 0, 10, 10).setInteractive();
    zone.setDepth(-1000);
    zone.on("pointerdown", () => {
      this.selectedSlotIdx = null;
    });
    this.bgZone = zone;
  }

  private createUpgradeButton(): void {
    this.upgradeBtnBg = this.add.graphics().setDepth(10);
    this.upgradeBtnLabel = this.add
      .text(0, 0, "", {
        fontSize: "18px",
        color: "#f5e8c8",
        align: "center",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(11);
    this.upgradeBtnZone = this.add
      .zone(-9999, -9999, 160, 56)
      .setInteractive({ useHandCursor: true });
    this.upgradeBtnZone.setDepth(11);
    this.upgradeBtnZone.on("pointerdown", () => this.onUpgradeTap());
    this.upgradeBtnLabel.setVisible(false);
  }

  private onUpgradeTap(): void {
    if (this.paused) return;
    const idx = this.selectedSlotIdx;
    if (idx === null) return;
    if (canMutate(this.state, this.ourSide, idx)) {
      this.runner.submitLocalCommand({
        kind: "mutate",
        side: this.ourSide,
        slotIdx: idx,
      });
    }
  }

  private updateUpgradeButton(): void {
    this.upgradeBtnBg.clear();
    const idx = this.selectedSlotIdx;
    if (idx === null || this.state.winner) {
      this.upgradeBtnLabel.setVisible(false);
      this.upgradeBtnZone.setPosition(-9999, -9999);
      return;
    }
    const s = this.state[this.ourSide].slots[idx];
    if (!s) {
      this.selectedSlotIdx = null;
      this.upgradeBtnLabel.setVisible(false);
      this.upgradeBtnZone.setPosition(-9999, -9999);
      return;
    }
    const cfg = STRUCTURES[s.kind];
    // Our side is always rendered on the view-left (see viewSideOf), so the
    // upgrade button always pins to the view-left slot positions.
    const pos = this.layout.leftSlots[idx];

    // Selection ring on the selected slot.
    const sc = this.layout.uiScale;
    const pulse = 0.7 + 0.3 * Math.sin(this.state.time * 6);
    this.upgradeBtnBg.lineStyle(3, 0xfff2c0, pulse);
    this.upgradeBtnBg.strokeCircle(pos.x, pos.y, this.layout.slotRadius + Math.round(6 * sc));

    // Button floats above the slot. Clamp to stay on screen.
    const btnW = Math.round(170 * sc);
    const btnH = Math.round(56 * sc);
    const btnX = pos.x;
    const btnY = Math.max(btnH / 2 + 4, pos.y - Math.round(68 * sc));

    const can = canMutate(this.state, this.ourSide, idx);
    const isBusy = s.status !== "active";

    let text: string;
    let textColor: string;
    let borderColor: number;
    let fillColor: number;
    if (s.status === "disabled") {
      text = `Disabled\n${s.disableTimer.toFixed(1)}s`;
      textColor = "#ff9a7a";
      borderColor = 0xff6a4a;
      fillColor = 0x2a1410;
    } else if (s.status === "growing") {
      text = `Growing…\n${s.timer.toFixed(1)}s`;
      textColor = "#8a7a60";
      borderColor = 0x4a3420;
      fillColor = 0x241a10;
    } else if (s.status === "mutating") {
      text = `Upgrading → Lv${s.level + 1}\n${s.timer.toFixed(1)}s`;
      textColor = "#8a7a60";
      borderColor = 0x4a3420;
      fillColor = 0x241a10;
    } else if (s.level >= MAX_LEVEL) {
      text = `Max Level\nLv${s.level}`;
      textColor = "#8a7a60";
      borderColor = 0x4a3420;
      fillColor = 0x241a10;
    } else if (can) {
      const need = nextUpgradeCost(s.kind, s.level) ?? 0;
      text = `Upgrade → Lv${s.level + 1}\n🍂 ${need}`;
      textColor = "#f5e8c8";
      borderColor = cfg.color;
      fillColor = 0x3a2a18;
    } else {
      const need = nextUpgradeCost(s.kind, s.level) ?? 0;
      const have = Math.floor(this.state[this.ourSide].nutrients);
      text = `Upgrade → Lv${s.level + 1}\n🍂 ${have}/${need}`;
      textColor = "#8a7a60";
      borderColor = 0x4a3420;
      fillColor = 0x241a10;
    }

    this.upgradeBtnBg.fillStyle(fillColor, 0.96);
    this.upgradeBtnBg.fillRoundedRect(
      btnX - btnW / 2,
      btnY - btnH / 2,
      btnW,
      btnH,
      10,
    );
    this.upgradeBtnBg.lineStyle(2, borderColor, 1);
    this.upgradeBtnBg.strokeRoundedRect(
      btnX - btnW / 2,
      btnY - btnH / 2,
      btnW,
      btnH,
      10,
    );

    this.upgradeBtnLabel
      .setVisible(true)
      .setPosition(btnX, btnY)
      .setText(text)
      .setColor(textColor);

    // Keep the zone active only when the button actually does something.
    if (isBusy) {
      this.upgradeBtnZone.setPosition(-9999, -9999);
    } else {
      this.upgradeBtnZone.setPosition(btnX, btnY);
      this.upgradeBtnZone.setSize(btnW, btnH);
    }
  }

  private restart(): void {
    // Restart via the scene lifecycle so tutorial mode is fully exited
    // (init data defaults to a normal match); difficulty is re-read from storage.
    // The explicit restart path always jumps straight back into play so the
    // player doesn't bounce through the menu mid-session.
    this.scene.restart({ skipMenu: true } satisfies GameSceneData);
  }

  /** Restart button & 'R' shortcut entry point: in single-player this resets
   *  the round; in multiplayer it leaves the match (a unilateral restart
   *  would desync the lockstep state). */
  private handleRestartTap(): void {
    if (this.mp) {
      this.leaveMatch();
      return;
    }
    this.restart();
  }

  private backToMenu(): void {
    // Fresh scene on the menu — re-reads difficulty and clears tutorial state.
    this.scene.restart({} satisfies GameSceneData);
  }

  private cycleDifficulty(): void {
    this.difficulty = nextDifficulty(this.difficulty);
    saveDifficulty(this.difficulty);
    // On the menu, just re-label the toggle — no match to restart yet.
    if (this.phase === "menu") {
      this.ai = createAI("right", this.difficulty, mulberry32(aiSeed()));
      return;
    }
    this.restart();
  }

  // ---------- multiplayer ----------

  private setupMultiplayer(cfg: MpSceneConfig): void {
    this.runner.enableLockstep({
      ourSide: cfg.ourSide,
      inputDelay: DEFAULT_INPUT_DELAY,
      onEmitInput: (tick, cmds) => {
        this.sendMp({ t: "input", tick, cmds });
      },
    });
    const onMsg = (msg: NetMessage): void => this.handleMpMessage(msg);
    const onDisc = (): void => this.handleMpDisconnect();
    cfg.transport.onMessage(onMsg);
    cfg.transport.onPeerDisconnect(onDisc);
    // No clean "off" exists on the transport; Shutdown leaves the room which
    // drops all listeners on its side. We still null-out our scene refs so
    // late messages don't push into a dead scene.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.mpListenerCleanup?.();
      this.mpListenerCleanup = null;
    });
    this.mpListenerCleanup = () => {
      this.mp = null;
    };
  }

  private sendMp(msg: NetMessage): void {
    if (!this.mp) return;
    this.mp.transport.send(msg);
  }

  private lastHashTick = -1;
  private lastHashValue = "";
  private readonly HASH_EVERY = 30;

  private updateMultiplayer(): void {
    if (!this.mp) return;
    // Periodic state-hash exchange for desync detection. Runs on the tick we
    // just committed, after `advance` has returned. We snapshot the hash
    // alongside the tick so a remote message that arrives a few ticks later
    // is compared against the same state we hashed, not a freshly-advanced one.
    const t = this.runner.tick - 1;
    if (t >= 0 && t !== this.lastHashTick && t % this.HASH_EVERY === 0) {
      this.lastHashTick = t;
      this.lastHashValue = hashState(this.state);
      this.sendMp({ t: "hash", tick: t, hash: this.lastHashValue });
      this.checkHashes();
    }
    this.updateStallOverlay();
    this.updateRematchOverlay();
  }

  private handleMpMessage(msg: NetMessage): void {
    if (!this.mp) return;
    switch (msg.t) {
      case "input":
        this.runner.submitRemoteInput(msg.tick, msg.cmds as Command[]);
        return;
      case "hash":
        this.handleRemoteHash(msg.tick, msg.hash);
        return;
      case "rematch":
        this.handleRematchMsg(msg.accept, msg.seed);
        return;
      default:
        return;
    }
  }

  private pendingRemoteHashes: Map<number, string> = new Map();

  private handleRemoteHash(tick: number, hash: string): void {
    // Stash and compare once we've reached the same tick locally and have
    // our own snapshot to compare against.
    this.pendingRemoteHashes.set(tick, hash);
    this.checkHashes();
  }

  private checkHashes(): void {
    if (!this.mp) return;
    // We can only validate ticks we've also hashed locally. Compare against
    // the snapshot we recorded in `updateMultiplayer`, not a fresh hash of
    // the current state — by the time the remote message arrives we may have
    // advanced past `lastHashTick`, which would produce a false mismatch.
    for (const [tick, remote] of this.pendingRemoteHashes) {
      if (tick > this.lastHashTick) continue; // wait for our own snapshot
      if (tick === this.lastHashTick) {
        if (this.lastHashValue && this.lastHashValue !== remote) {
          // Log only — the desync warning has been intentionally hidden from
          // players for now (it fires too often to be useful UI). Re-introduce
          // a user-facing notice with a "Resync / new match" affordance once
          // we've shaken out false positives.
          console.warn(
            "[sporefall] MP hash mismatch at tick",
            tick,
            "local",
            this.lastHashValue,
            "remote",
            remote,
          );
        }
      }
      // Whether matched or stale, we're done with this entry.
      this.pendingRemoteHashes.delete(tick);
    }
  }

  private mpPeerLost = false;

  private handleMpDisconnect(): void {
    if (!this.mp) return;
    this.mpPeerLost = true;
    this.showStallMessage("Opponent disconnected.", { showLeave: true });
  }

  private updateStallOverlay(): void {
    if (!this.mp) return;
    // Once the peer is gone we keep the disconnect notice up — there's no
    // path back to gameplay, so don't flicker it back to "waiting".
    if (this.mpPeerLost) return;
    if (this.runner.stalledFor > 1.5 && !this.state.winner) {
      this.showStallMessage("Waiting for opponent…", { showLeave: true });
    } else {
      this.hideStallMessage();
    }
  }

  private showStallMessage(
    text: string,
    opts: { showLeave?: boolean } = {},
  ): void {
    if (!this.mpStallOverlay) {
      this.mpStallOverlay = this.add
        .text(this.scale.width / 2, Math.round(this.scale.height * 0.22), text, {
          fontSize: "20px",
          color: "#f0e2bc",
          backgroundColor: "rgba(27, 18, 10, 0.85)",
          padding: { x: 16, y: 8 },
          fontFamily: "system-ui, sans-serif",
        })
        .setOrigin(0.5)
        .setDepth(40);
    }
    this.mpStallOverlay.setText(text).setVisible(true);
    if (opts.showLeave) {
      this.showStallLeaveButton();
    } else {
      this.hideStallLeaveButton();
    }
  }

  private mpStallLeaveBtn: Phaser.GameObjects.Text | null = null;

  private showStallLeaveButton(): void {
    if (!this.mpStallOverlay) return;
    if (!this.mpStallLeaveBtn) {
      this.mpStallLeaveBtn = this.add
        .text(0, 0, "Leave match", {
          fontSize: "18px",
          color: "#f8ecc8",
          backgroundColor: "rgba(58, 42, 24, 0.95)",
          padding: { x: 18, y: 10 },
          fontFamily: "system-ui, sans-serif",
          fontStyle: "bold",
        })
        .setOrigin(0.5)
        .setDepth(40)
        .setInteractive({ useHandCursor: true });
      this.mpStallLeaveBtn.on("pointerdown", () => this.leaveMatch());
    }
    const overlay = this.mpStallOverlay;
    const y = overlay.y + overlay.displayHeight / 2 + 28;
    this.mpStallLeaveBtn.setPosition(this.scale.width / 2, y).setVisible(true);
  }

  private hideStallLeaveButton(): void {
    this.mpStallLeaveBtn?.setVisible(false);
  }

  private hideStallMessage(): void {
    this.mpStallOverlay?.setVisible(false);
    this.hideStallLeaveButton();
  }

  /** Hard-exit the active multiplayer match: drop the transport, clear all
   *  MP scene state, and bounce back to the menu so the player can host /
   *  join a new match or play single-player. Safe to call from disconnect,
   *  desync, or a player tap. */
  private leaveMatch(): void {
    if (this.mp) {
      try {
        this.mp.transport.close();
      } catch {
        /* already closed */
      }
    }
    this.mp = null;
    this.mpPeerLost = false;
    this.backToMenu();
  }

  // ---------- rematch ----------

  private updateRematchOverlay(): void {
    if (!this.mp) return;
    if (!this.state.winner) {
      this.disposeRematchOverlay();
      return;
    }
    if (!this.mpRematchOverlay) {
      this.createRematchOverlay();
    }
    const o = this.mpRematchOverlay!;
    const won = this.state.winner === this.ourSide;
    o.result.setText(won ? "VICTORY" : "DEFEAT");
    o.result.setColor(won ? "#f8e8c0" : "#e8b098");
    let status = "";
    if (this.mpWeAcceptedRematch && !this.mpRemoteAcceptedRematch) {
      status = "Waiting for opponent to accept…";
    } else if (!this.mpWeAcceptedRematch && this.mpRemoteAcceptedRematch) {
      status = "Opponent is ready for a rematch.";
    }
    o.status.setText(status);
    this.layoutRematchOverlay();
  }

  private createRematchOverlay(): void {
    const backdrop = this.add.graphics().setDepth(35);
    const panel = this.add.graphics().setDepth(36);
    const result = this.add
      .text(0, 0, "", {
        fontSize: "56px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
        stroke: "#1b120a",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(37);
    const title = this.add
      .text(0, 0, "Play again?", {
        fontSize: "24px",
        color: "#e8d7b6",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(37);

    const yesBg = this.add.graphics().setDepth(36);
    const yes = this.add
      .text(0, 0, "Rematch", {
        fontSize: "22px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(38);
    const yesZone = this.add.zone(0, 0, 10, 10).setDepth(38);
    yesZone.on("pointerdown", () => {
      if (this.mpWeAcceptedRematch) return;
      this.mpWeAcceptedRematch = true;
      this.sendMp({
        t: "rematch",
        accept: true,
        seed:
          this.ourSide === "left"
            ? (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0)
            : undefined,
      });
      this.tryStartRematch();
    });

    const noBg = this.add.graphics().setDepth(36);
    const no = this.add
      .text(0, 0, "Leave", {
        fontSize: "22px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(38);
    const noZone = this.add.zone(0, 0, 10, 10).setDepth(38);
    noZone.on("pointerdown", () => {
      this.sendMp({ t: "rematch", accept: false });
      this.backToMenu();
    });

    const status = this.add
      .text(0, 0, "", {
        fontSize: "18px",
        color: "#c9b98b",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(37);

    this.mpRematchOverlay = {
      backdrop,
      panel,
      result,
      title,
      yesBg,
      yes,
      yesZone,
      noBg,
      no,
      noZone,
      status,
    };
  }

  private layoutRematchOverlay(): void {
    const o = this.mpRematchOverlay;
    if (!o) return;
    const L = this.layout;
    const W = L.W;
    const H = L.H;
    const sc = L.uiScale;
    const px = (n: number) => `${Math.max(12, Math.round(n * sc))}px`;

    // Subtle full-screen dim so the match state behind stays visible but
    // recedes.
    o.backdrop.clear();
    o.backdrop.fillStyle(0x0a0704, 0.55);
    o.backdrop.fillRect(0, 0, W, H);

    // Centered panel card.
    const panelW = Math.min(W - Math.round(40 * sc), Math.round(520 * sc));
    const panelH = Math.round(340 * sc);
    const panelX = Math.round(W / 2 - panelW / 2);
    const panelY = Math.round(H / 2 - panelH / 2);
    o.panel.clear();
    o.panel.fillStyle(0x2a1c10, 0.96);
    o.panel.fillRoundedRect(panelX, panelY, panelW, panelH, 14);
    o.panel.lineStyle(2, 0xf5e8c8, 0.6);
    o.panel.strokeRoundedRect(panelX, panelY, panelW, panelH, 14);

    // Result headline.
    o.result.setFontSize(px(56));
    o.result.setPosition(W / 2, panelY + Math.round(panelH * 0.26));

    // "Play again?" subtitle below the result.
    o.title.setFontSize(px(24));
    o.title.setPosition(W / 2, panelY + Math.round(panelH * 0.5));

    // Buttons: side-by-side, horizontally centered.
    const btnW = Math.round(Math.min(panelW * 0.4, 180 * sc));
    const btnH = Math.round(52 * sc);
    const gap = Math.round(20 * sc);
    const btnY = panelY + Math.round(panelH * 0.7);
    const yesX = Math.round(W / 2 - btnW - gap / 2);
    const noX = Math.round(W / 2 + gap / 2);

    o.yesBg.clear();
    o.yesBg.fillStyle(0x3a5a28, 0.95);
    o.yesBg.fillRoundedRect(yesX, btnY, btnW, btnH, 10);
    o.yesBg.lineStyle(2, 0xf5e8c8, 0.8);
    o.yesBg.strokeRoundedRect(yesX, btnY, btnW, btnH, 10);
    o.yes.setFontSize(px(22));
    o.yes.setPosition(yesX + btnW / 2, btnY + btnH / 2);
    o.yesZone.setPosition(yesX + btnW / 2, btnY + btnH / 2).setSize(btnW, btnH);
    if (!o.yesZone.input?.enabled) {
      o.yesZone.setInteractive({ useHandCursor: true });
    }

    o.noBg.clear();
    o.noBg.fillStyle(0x5a2820, 0.92);
    o.noBg.fillRoundedRect(noX, btnY, btnW, btnH, 10);
    o.noBg.lineStyle(2, 0xf5e8c8, 0.8);
    o.noBg.strokeRoundedRect(noX, btnY, btnW, btnH, 10);
    o.no.setFontSize(px(22));
    o.no.setPosition(noX + btnW / 2, btnY + btnH / 2);
    o.noZone.setPosition(noX + btnW / 2, btnY + btnH / 2).setSize(btnW, btnH);
    if (!o.noZone.input?.enabled) {
      o.noZone.setInteractive({ useHandCursor: true });
    }

    // Status text pinned just inside the bottom of the panel.
    o.status.setFontSize(px(18));
    o.status.setPosition(W / 2, panelY + panelH - Math.round(22 * sc));
  }

  private disposeRematchOverlay(): void {
    if (!this.mpRematchOverlay) return;
    const o = this.mpRematchOverlay;
    o.backdrop.destroy();
    o.panel.destroy();
    o.result.destroy();
    o.title.destroy();
    o.yesBg.destroy();
    o.yes.destroy();
    o.yesZone.destroy();
    o.noBg.destroy();
    o.no.destroy();
    o.noZone.destroy();
    o.status.destroy();
    this.mpRematchOverlay = null;
  }

  private handleRematchMsg(accept: boolean, seed?: number): void {
    if (!accept) {
      this.showStallMessage("Opponent left the match.");
      return;
    }
    this.mpRemoteAcceptedRematch = true;
    // The host is the source of truth for the new seed. Guests stash the
    // host's seed if it arrives early; host stashes their own.
    if (seed !== undefined) this.mpPendingRematchSeed = seed;
    this.tryStartRematch();
  }

  private tryStartRematch(): void {
    if (!this.mp) return;
    if (!this.mpWeAcceptedRematch || !this.mpRemoteAcceptedRematch) return;
    // Only the host has a seed to offer. The guest's local seed comes from
    // the host's rematch message.
    if (this.mpPendingRematchSeed === null) {
      // Guest waiting for host's seed.
      if (this.ourSide === "left") {
        // Shouldn't happen — host sent their seed in their own accept.
        this.mpPendingRematchSeed =
          crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
      } else {
        return;
      }
    }
    const seed = this.mpPendingRematchSeed;
    // Keep the same transport; hand it back to a fresh scene restart.
    const transport = this.mp.transport;
    const ourSide = this.ourSide;
    this.scene.restart({
      mp: { transport, seed, ourSide, firstTick: 0 },
    } satisfies GameSceneData);
  }
}

function aiSeed(): number {
  // Single-player AI seed: any 32-bit unsigned int. Non-deterministic by design
  // here — multiplayer uses the agreed match seed instead.
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
  }
  return (Math.random() * 0x100000000) >>> 0;
}

function emitPhase(phase: Phase): void {
  window.dispatchEvent(
    new CustomEvent<Phase>("sporefall:phase", { detail: phase }),
  );
}

const DIFFICULTY_STORAGE_KEY = "sporefall.difficulty";

function loadDifficulty(): AIDifficulty {
  try {
    const v = window.localStorage?.getItem(DIFFICULTY_STORAGE_KEY);
    if (v === "easy" || v === "medium" || v === "hard") {
      // Legacy "hard" was the rule-based reactive AI — that's now "medium".
      // Remap so existing players keep the opponent they were used to and can
      // opt into the new (stronger, evo-script) Hard explicitly.
      if (v === "hard") return "medium";
      return v;
    }
  } catch {
    // ignore (e.g. SSR / privacy mode)
  }
  return "medium";
}

function saveDifficulty(d: AIDifficulty): void {
  try {
    window.localStorage?.setItem(DIFFICULTY_STORAGE_KEY, d);
  } catch {
    // ignore
  }
}

function nextDifficulty(d: AIDifficulty): AIDifficulty {
  if (d === "easy") return "medium";
  if (d === "medium") return "hard";
  return "easy";
}
