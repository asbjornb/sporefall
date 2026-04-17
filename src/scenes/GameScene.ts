import Phaser from "phaser";
import { SimpleAI, type AIDifficulty } from "../game/ai";
import {
  DISABLE_DURATION,
  DISABLE_THRESHOLD,
  HYPHAE_SMOTHER_RATE,
  SLOT_COUNT,
  STRUCTURES,
  SURGE_THRESHOLD,
  levelMultiplier,
} from "../game/config";
import {
  build,
  canBuild,
  canMutate,
  createGameState,
  mutate,
  pressureOf,
  step,
} from "../game/sim";
import { TutorialDirector } from "../game/tutorial";
import type { GameState, Side, Structure, StructureKind } from "../game/types";

export interface GameSceneData {
  tutorial?: boolean;
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
  buildBtns: BuildBtnRect[];
  pauseBtn: ControlBtnRect;
  restartBtn: ControlBtnRect;
  tutorialBtn: ControlBtnRect;
  difficultyBtn: DifficultyBtnRect;
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
  // landscape (~800x380) this lands around 0.5, which matches what the old FIT
  // scaling used to render — keeping fonts/buttons/slots readable but compact.
  const uiScale = Math.max(0.55, Math.min(1.2, Math.min(W / 1280, H / 720)));
  const s = (n: number) => Math.round(n * uiScale);

  const topBarH = s(80);
  const bottomPad = s(14);

  // Slots region (2 rows) sits near the bottom, where the build bar used to be.
  const slotRadius = s(32);
  const slotRowGap = s(70);
  const slotAreaBottom = H - bottomPad;
  const slotAreaTop = slotAreaBottom - slotRowGap * 2 + (slotRowGap - slotRadius * 2) / 2;
  const row0Y = slotAreaTop + slotRadius + s(4);
  const row1Y = row0Y + slotRowGap;

  // Build buttons stacked vertically along the left edge, aligned with the log.
  const buildBarTop = topBarH + s(30);
  const buildBarBottom = slotAreaTop - s(14);
  const buildBarH = buildBarBottom - buildBarTop;
  const btnGap = s(16);
  const btnH = Math.max(s(64), Math.min(s(150), Math.floor((buildBarH - btnGap * 3) / 4)));
  const btnW = Math.max(s(140), Math.min(s(220), Math.round(W * 0.14)));
  const leftPad = s(14);
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
  const heartRadius = Math.max(s(28), Math.min(s(48), Math.round(H * 0.055)));
  const rightMargin = Math.max(s(48), Math.min(s(120), Math.round(W * 0.05)));
  const logLeft = buildBarX + btnW + s(20);
  const logRight = W - rightMargin;
  const logTop = buildBarTop;
  const logBottom = buildBarBottom;
  const logW = logRight - logLeft;
  const logH = Math.max(s(120), logBottom - logTop);

  const leftHeartX = logLeft + heartRadius * 0.55;
  const rightHeartX = logRight - heartRadius * 0.55;
  const heartY = logTop + logH / 2;

  // Slot columns start one spacing inward from each sclerotium.
  const innerHalf = Math.max(0, (rightHeartX - leftHeartX) / 2 - s(40));
  const slotSpacing = Math.max(s(60), Math.min(s(110), innerHalf / 5));
  const leftSlots: SlotSpec[] = [];
  const rightSlots: SlotSpec[] = [];
  for (let row = 0; row < 2; row++) {
    const y = row === 0 ? row0Y : row1Y;
    for (let col = 0; col < 5; col++) {
      leftSlots.push({ x: leftHeartX + slotSpacing * (col + 1), y });
      rightSlots.push({ x: rightHeartX - slotSpacing * (col + 1), y });
    }
  }

  // Top-right control buttons.
  const ctrlSize = s(60);
  const ctrlGap = s(12);
  const ctrlMargin = s(14);
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
  const diffW = s(110);
  const difficultyBtn: DifficultyBtnRect = {
    x: pauseBtn.x - diffW - ctrlGap,
    y: ctrlMargin,
    w: diffW,
    h: ctrlSize,
  };
  const tutorialBtn: ControlBtnRect = {
    x: difficultyBtn.x - ctrlSize - ctrlGap,
    y: ctrlMargin,
    size: ctrlSize,
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
    buildBtns,
    pauseBtn,
    restartBtn,
    tutorialBtn,
    difficultyBtn,
  };
}

export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private ai!: SimpleAI;
  private paused = false;
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
    icon: Phaser.GameObjects.Text;
  };
  private tutorialBtnZone!: Phaser.GameObjects.Zone;
  private tutorial!: TutorialDirector;
  private hintText!: Phaser.GameObjects.Text;
  private difficultyBtn!: {
    bg: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  };
  private difficultyBtnZone!: Phaser.GameObjects.Zone;
  private difficulty: AIDifficulty = "hard";
  private slotHit: Phaser.GameObjects.Arc[] = [];
  private selectedSlotIdx: number | null = null;
  /** Per-slot shake timer for the player's side, used to flash a denied tap on disabled. */
  private slotShake: number[] = new Array(SLOT_COUNT).fill(0);
  private rpsLegend!: Phaser.GameObjects.Text;
  private upgradeBtnBg!: Phaser.GameObjects.Graphics;
  private upgradeBtnLabel!: Phaser.GameObjects.Text;
  private upgradeBtnZone!: Phaser.GameObjects.Zone;
  private buildBtnZones: Phaser.GameObjects.Zone[] = [];
  private pauseBtnZone!: Phaser.GameObjects.Zone;
  private restartBtnZone!: Phaser.GameObjects.Zone;
  private bgZone!: Phaser.GameObjects.Zone;
  private layout!: Layout;

  constructor() {
    super("game");
  }

  init(data: GameSceneData): void {
    this.tutorial = new TutorialDirector(!!data?.tutorial);
  }

  create(): void {
    this.difficulty = loadDifficulty();
    this.state = createGameState();
    this.ai = new SimpleAI("right", this.difficulty);
    this.layout = computeLayout(this.scale.width, this.scale.height);

    if (this.tutorial.active) {
      // Tutorial mode: skip countdown, grant ample nutrients, keep enemy passive.
      this.state.countdown = 0;
      this.state.left.nutrients = 200;
    }

    this.bg = this.add.graphics();
    this.fx = this.add.graphics();

    this.topText = this.add.text(24, 14, "", {
      fontSize: "26px",
      color: "#e8d7b6",
      fontFamily: "system-ui, sans-serif",
    });

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
    this.createRpsLegend();
    this.applyLayout();

    this.scale.on("resize", this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onResize, this);
    });

    this.input.keyboard?.on("keydown-R", () => this.restart());
    this.input.keyboard?.on("keydown-P", () => this.togglePause());
    this.input.keyboard?.on("keydown-SPACE", () => this.togglePause());
    // Any tap/click after the game is over restarts — mobile-friendly.
    this.input.on("pointerdown", () => {
      if (this.state.winner) this.restart();
      if (this.tutorial.active) this.tutorial.registerTap();
    });
  }

  private onResize(gameSize: Phaser.Structs.Size): void {
    this.layout = computeLayout(gameSize.width, gameSize.height);
    this.applyLayout();
  }

  private applyLayout(): void {
    const L = this.layout;
    const sc = L.uiScale;
    const px = (n: number) => `${Math.max(10, Math.round(n * sc))}px`;

    this.topText.setPosition(Math.round(24 * sc), Math.round(14 * sc));
    this.topText.setFontSize(px(26));

    this.winText.setPosition(L.W / 2, L.H / 2);
    this.winText.setFontSize(px(76));

    this.countdownText.setPosition(L.W / 2, L.H / 2);
    this.countdownText.setFontSize(px(180));

    this.pausedText.setPosition(L.W / 2, L.H / 2 - Math.round(140 * sc));
    this.pausedText.setFontSize(px(64));

    if (this.rpsLegend) {
      const rb = L.restartBtn;
      this.rpsLegend.setPosition(rb.x + rb.size, rb.y + rb.size + Math.round(6 * sc));
      this.rpsLegend.setFontSize(px(14));
    }

    this.bgZone.setPosition(L.W / 2, L.H / 2).setSize(L.W, L.H);

    this.buildBtns.forEach((entry, i) => {
      const rect = L.buildBtns[i];
      entry.container.setData("x", rect.x);
      entry.container.setData("y", rect.y);
      entry.container.setData("w", rect.w);
      entry.container.setData("h", rect.h);
      entry.title.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.25);
      entry.title.setFontSize(px(22));
      entry.detail.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.68);
      entry.detail.setFontSize(px(18));
      const zone = this.buildBtnZones[i];
      zone.setPosition(rect.x + rect.w / 2, rect.y + rect.h / 2);
      zone.setSize(rect.w, rect.h);
    });

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
    this.tutorialBtn.bg.setData("x", tb.x).setData("y", tb.y).setData("size", tb.size);
    this.tutorialBtn.icon.setPosition(tb.x + tb.size / 2, tb.y + tb.size / 2);
    this.tutorialBtn.icon.setFontSize(px(34));
    this.tutorialBtnZone
      .setPosition(tb.x + tb.size / 2, tb.y + tb.size / 2)
      .setSize(tb.size, tb.size);

    const db = L.difficultyBtn;
    this.difficultyBtn.bg
      .setData("x", db.x)
      .setData("y", db.y)
      .setData("w", db.w)
      .setData("h", db.h);
    this.difficultyBtn.label.setPosition(db.x + db.w / 2, db.y + db.h / 2);
    this.difficultyBtn.label.setFontSize(px(20));
    this.difficultyBtnZone
      .setPosition(db.x + db.w / 2, db.y + db.h / 2)
      .setSize(db.w, db.h);

    this.upgradeBtnLabel.setFontSize(px(18));
  }

  update(_time: number, deltaMs: number): void {
    const dt = Math.min(0.1, deltaMs / 1000);
    if (!this.state.winner && !this.paused) {
      step(this.state, dt);
      if (this.tutorial.active) {
        this.tutorial.update(this.state, dt);
      } else {
        this.ai.update(this.state, dt);
      }
    }
    for (let i = 0; i < this.slotShake.length; i++) {
      if (this.slotShake[i] > 0) {
        this.slotShake[i] = Math.max(0, this.slotShake[i] - dt);
      }
    }
    this.render();
  }

  // ---------- rendering ----------

  private render(): void {
    this.bg.clear();
    this.fx.clear();
    this.drawLog();
    this.drawSclerotia();
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
  }

  private slotPosFor(side: Side, slotIdx: number): SlotSpec {
    return side === "left"
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

  private smotherRateOf(side: Side): number {
    let rate = 0;
    for (const s of this.state[side].slots) {
      if (s && s.kind === "hyphae" && s.status === "active") {
        rate += HYPHAE_SMOTHER_RATE * levelMultiplier(s.level);
      }
    }
    return rate;
  }

  private drawLog(): void {
    const L = this.layout;
    // Log body (bark)
    this.bg.fillStyle(LOG_BARK, 1);
    this.bg.fillRoundedRect(L.logLeft - 10, L.logTop - 10, L.logW + 20, L.logH + 20, 16);
    this.bg.fillStyle(LOG_BODY, 1);
    this.bg.fillRoundedRect(L.logLeft, L.logTop, L.logW, L.logH, 12);

    // Grain lines
    this.bg.lineStyle(1, 0x2a1a0a, 0.4);
    for (let i = 1; i < 5; i++) {
      const y = L.logTop + (L.logH * i) / 5;
      this.bg.beginPath();
      this.bg.moveTo(L.logLeft + 8, y);
      this.bg.lineTo(L.logRight - 8, y);
      this.bg.strokePath();
    }

    const frontX = L.logLeft + L.logW * this.state.front;

    // Left colony color flow
    this.bg.fillStyle(LEFT_TINT, 0.45);
    this.bg.fillRect(L.logLeft, L.logTop, frontX - L.logLeft, L.logH);

    // Right colony color flow
    this.bg.fillStyle(RIGHT_TINT, 0.45);
    this.bg.fillRect(frontX, L.logTop, L.logRight - frontX, L.logH);

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

    // Net pressure glow
    const pL = pressureOf(this.state, "left");
    const pR = pressureOf(this.state, "right");
    const net = pL - pR;
    if (Math.abs(net) > 0.1) {
      const tint = net > 0 ? LEFT_TINT : RIGHT_TINT;
      const dir = net > 0 ? 1 : -1;
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
    this.drawHeart("left", L.leftHeartX, L.heartY);
    this.drawHeart("right", L.rightHeartX, L.heartY);
  }

  private drawHeart(side: Side, x: number, y: number): void {
    const colony = this.state[side];
    const color = side === "left" ? LEFT_TINT : RIGHT_TINT;
    const r = this.layout.heartRadius;
    // outer glow
    this.bg.fillStyle(color, 0.25);
    this.bg.fillCircle(x, y, r * 1.7);
    // core
    this.bg.fillStyle(color, 1);
    this.bg.fillCircle(x, y, r);
    this.bg.fillStyle(0xf5e8c8, 0.8);
    this.bg.fillCircle(x, y, r * 0.38);

    // HP bar above the log so it never sits on bark
    const sc = this.layout.uiScale;
    const hpW = Math.round(140 * sc);
    const hpH = Math.max(6, Math.round(14 * sc));
    const hpX = x - hpW / 2;
    const hpY = this.layout.logTop - Math.round(26 * sc);
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
    const positions = side === "left" ? this.layout.leftSlots : this.layout.rightSlots;
    const r = this.layout.slotRadius;
    const enemySide: Side = side === "left" ? "right" : "left";
    const enemySmother = this.smotherRateOf(enemySide);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const basePos = positions[i];
      const s = colony.slots[i];

      // Shake offset for player-side denied taps on disabled slots.
      let shakeDx = 0;
      let shakeDy = 0;
      if (side === "left" && this.slotShake[i] > 0) {
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
      this.bg.fillStyle(fillColor, alpha);
      this.bg.fillCircle(x, y + droop, r - 4);

      // Ring (level indicator)
      if (s.level > 1) {
        this.bg.lineStyle(3, 0xf5e8c8, disabled ? 0.4 : 0.9);
        this.bg.strokeCircle(x, y + droop, r - 4);
      }

      // Progress arc while growing/mutating.
      if (s.status === "growing" || s.status === "mutating") {
        const cfgTime =
          s.status === "growing" ? cfg.buildTime : cfg.mutateTime;
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
        // Smother haze — green wash if any enemy hyphae are smothering this fruiting.
        if (enemySmother > 0) {
          const intensity = Math.min(0.45, 0.12 + enemySmother / 60);
          this.fx.fillStyle(0x9bd45a, intensity);
          this.fx.fillCircle(x, y, r + 6);
        }
      }
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
        this.fx.lineStyle(2, 0xdfe4ec, pulse);
        this.fx.beginPath();
        this.fx.moveTo(fromPos.x, fromPos.y);
        this.fx.lineTo(tp.x, tp.y);
        this.fx.strokePath();
        // Small dot at the impact point.
        this.fx.fillStyle(0xdfe4ec, pulse);
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
        this.fx.lineStyle(4, 0xc080ff, 0.85);
        this.fx.beginPath();
        this.fx.moveTo(fromPos.x, fromPos.y);
        this.fx.lineTo(headX, headY);
        this.fx.strokePath();
        this.fx.fillStyle(0xe8c0ff, 1);
        this.fx.fillCircle(headX, headY, 6);
      }
    }
  }

  private updateHud(): void {
    const l = this.state.left;
    const r = this.state.right;
    const pL = pressureOf(this.state, "left").toFixed(1);
    const pR = pressureOf(this.state, "right").toFixed(1);
    this.topText.setText(
      [
        `YOU   nutrients ${Math.floor(l.nutrients)}   +${l.income.toFixed(1)}/s   pressure ${pL}   HP ${Math.ceil(l.hp)}`,
        `ENEMY nutrients ${Math.floor(r.nutrients)}   +${r.income.toFixed(1)}/s   pressure ${pR}   HP ${Math.ceil(r.hp)}`,
      ].join("\n"),
    );
  }

  private updateWinBanner(): void {
    if (!this.state.winner) {
      this.winText.setText("");
      return;
    }
    const msg = this.state.winner === "left" ? "VICTORY" : "DEFEAT";
    this.winText.setText(`${msg}\ntap to restart`);
  }

  private updateCountdown(): void {
    if (this.state.winner) {
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
    for (const { kind, container, title, detail, bg } of this.buildBtns) {
      const x = container.getData("x") as number;
      const y = container.getData("y") as number;
      const w = container.getData("w") as number;
      const h = container.getData("h") as number;
      const cfg = STRUCTURES[kind];
      const can = canBuild(this.state, "left", kind);

      bg.clear();
      bg.fillStyle(can ? 0x3a2a18 : 0x241a10, 1);
      bg.fillRoundedRect(x, y, w, h, 10);
      bg.lineStyle(3, can ? cfg.color : 0x4a3420, 1);
      bg.strokeRoundedRect(x, y, w, h, 10);

      const info =
        kind === "decomposer"
          ? `+${cfg.incomeBonus}/s income`
          : `${cfg.basePressure} pressure`;
      title.setText(cfg.label);
      title.setColor(can ? "#f8ecc8" : "#9a8a70");
      detail.setText(`${cfg.cost}n · ${cfg.buildTime}s\n${info}`);
      detail.setColor(can ? "#f0e2bc" : "#8a7a60");
    }
  }

  private onBuildTap(kind: StructureKind): void {
    if (this.state.winner || this.paused) return;
    build(this.state, "left", kind);
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
      this.restart();
    });
    this.restartBtn = { bg: restartBg, icon: restartIcon };
    this.restartBtnZone = restartZone;

    const tutorialBg = this.add.graphics().setDepth(15);
    const tutorialIcon = this.add
      .text(0, 0, "?", {
        fontSize: "34px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(0.5)
      .setDepth(16);
    const tutorialZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(16);
    tutorialZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      this.startTutorial();
    });
    this.tutorialBtn = { bg: tutorialBg, icon: tutorialIcon };
    this.tutorialBtnZone = tutorialZone;

    const diffBg = this.add.graphics().setDepth(15);
    const diffLabel = this.add
      .text(0, 0, "", {
        fontSize: "20px",
        color: "#f8ecc8",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(16);
    const diffZone = this.add
      .zone(0, 0, 10, 10)
      .setInteractive({ useHandCursor: true })
      .setDepth(16);
    diffZone.on("pointerdown", (_p: unknown, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      e.stopPropagation?.();
      this.cycleDifficulty();
    });
    this.difficultyBtn = { bg: diffBg, label: diffLabel };
    this.difficultyBtnZone = diffZone;
  }

  private updateControlButtons(): void {
    this.drawControlButton(this.pauseBtn, this.paused ? 0x3a5a28 : 0x3a2a18);
    this.pauseBtn.icon.setText(this.paused ? "\u25B6" : "\u23F8");
    this.drawControlButton(this.restartBtn, 0x3a2a18);
    this.drawControlButton(this.tutorialBtn, this.tutorial.active ? 0x3a5a28 : 0x3a2a18);
    this.drawDifficultyButton();
  }

  private drawDifficultyButton(): void {
    const x = this.difficultyBtn.bg.getData("x") as number;
    const y = this.difficultyBtn.bg.getData("y") as number;
    const w = this.difficultyBtn.bg.getData("w") as number;
    const h = this.difficultyBtn.bg.getData("h") as number;
    const fill = this.difficulty === "hard" ? 0x6a2a18 : 0x2a3a28;
    this.difficultyBtn.bg.clear();
    this.difficultyBtn.bg.fillStyle(fill, 0.9);
    this.difficultyBtn.bg.fillRoundedRect(x, y, w, h, 10);
    this.difficultyBtn.bg.lineStyle(2, 0xf5e8c8, 0.8);
    this.difficultyBtn.bg.strokeRoundedRect(x, y, w, h, 10);
    this.difficultyBtn.label.setText(
      this.difficulty === "hard" ? "AI: Hard" : "AI: Easy",
    );
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

  private createRpsLegend(): void {
    this.rpsLegend = this.add
      .text(0, 0, "Hyphae \u25B6 Fruiting \u25B6 Rhizo \u25B6 Hyphae", {
        fontSize: "14px",
        color: "#cdb98a",
        fontFamily: "system-ui, sans-serif",
      })
      .setOrigin(1, 0)
      .setDepth(5);
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
    const s = this.state.left.slots[idx];
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
    if (canMutate(this.state, "left", idx)) {
      mutate(this.state, "left", idx);
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
    const s = this.state.left.slots[idx];
    if (!s) {
      this.selectedSlotIdx = null;
      this.upgradeBtnLabel.setVisible(false);
      this.upgradeBtnZone.setPosition(-9999, -9999);
      return;
    }
    const cfg = STRUCTURES[s.kind];
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

    const can = canMutate(this.state, "left", idx);
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
    } else if (can) {
      text = `Upgrade → Lv${s.level + 1}\n${cfg.mutateCost}n`;
      textColor = "#f5e8c8";
      borderColor = cfg.color;
      fillColor = 0x3a2a18;
    } else {
      const need = cfg.mutateCost;
      const have = Math.floor(this.state.left.nutrients);
      text = `Upgrade → Lv${s.level + 1}\n${have}/${need}n`;
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
    this.scene.restart({} satisfies GameSceneData);
  }

  private cycleDifficulty(): void {
    this.difficulty = this.difficulty === "easy" ? "hard" : "easy";
    saveDifficulty(this.difficulty);
    this.restart();
  }
}

const DIFFICULTY_STORAGE_KEY = "sporefall.difficulty";

function loadDifficulty(): AIDifficulty {
  try {
    const v = window.localStorage?.getItem(DIFFICULTY_STORAGE_KEY);
    if (v === "easy" || v === "hard") return v;
  } catch {
    // ignore (e.g. SSR / privacy mode)
  }
  return "hard";
}

function saveDifficulty(d: AIDifficulty): void {
  try {
    window.localStorage?.setItem(DIFFICULTY_STORAGE_KEY, d);
  } catch {
    // ignore
  }
}
