import Phaser from "phaser";
import { SimpleAI } from "../game/ai";
import { SLOT_COUNT, STRUCTURES } from "../game/config";
import {
  build,
  canBuild,
  canMutate,
  createGameState,
  mutate,
  pressureOf,
  step,
} from "../game/sim";
import type { GameState, Side, StructureKind } from "../game/types";

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

interface Layout {
  W: number;
  H: number;
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
}

function computeLayout(W: number, H: number): Layout {
  const topBarH = 80;
  const bottomPad = 14;

  // Slots region (2 rows) sits near the bottom, where the build bar used to be.
  const slotRadius = 32;
  const slotRowGap = 70;
  const slotAreaBottom = H - bottomPad;
  const slotAreaTop = slotAreaBottom - slotRowGap * 2 + (slotRowGap - slotRadius * 2) / 2;
  const row0Y = slotAreaTop + slotRadius + 4;
  const row1Y = row0Y + slotRowGap;

  // Build buttons stacked vertically along the left edge, aligned with the log.
  const buildBarTop = topBarH + 30;
  const buildBarBottom = slotAreaTop - 14;
  const buildBarH = buildBarBottom - buildBarTop;
  const btnGap = 16;
  const btnH = Math.max(80, Math.min(150, Math.floor((buildBarH - btnGap * 3) / 4)));
  const btnW = Math.max(160, Math.min(220, Math.round(W * 0.14)));
  const leftPad = 14;
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
  const heartRadius = Math.max(34, Math.min(48, Math.round(H * 0.055)));
  const rightMargin = Math.max(56, Math.min(120, Math.round(W * 0.05)));
  const logLeft = buildBarX + btnW + 20;
  const logRight = W - rightMargin;
  const logTop = buildBarTop;
  const logBottom = buildBarBottom;
  const logW = logRight - logLeft;
  const logH = Math.max(120, logBottom - logTop);

  const leftHeartX = logLeft + heartRadius * 0.55;
  const rightHeartX = logRight - heartRadius * 0.55;
  const heartY = logTop + logH / 2;

  // Slot columns start one spacing inward from each sclerotium.
  const innerHalf = Math.max(0, (rightHeartX - leftHeartX) / 2 - 40);
  const slotSpacing = Math.max(70, Math.min(110, innerHalf / 5));
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
  const ctrlSize = 60;
  const ctrlGap = 12;
  const ctrlMargin = 14;
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

  return {
    W,
    H,
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
  private slotHit: Phaser.GameObjects.Arc[] = [];
  private selectedSlotIdx: number | null = null;
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

  create(): void {
    this.state = createGameState();
    this.ai = new SimpleAI("right");
    this.layout = computeLayout(this.scale.width, this.scale.height);

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

    this.createBackgroundZone();
    this.createBuildButtons();
    this.createSlotHitAreas();
    this.createUpgradeButton();
    this.createControlButtons();
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
    });
  }

  private onResize(gameSize: Phaser.Structs.Size): void {
    this.layout = computeLayout(gameSize.width, gameSize.height);
    this.applyLayout();
  }

  private applyLayout(): void {
    const L = this.layout;
    this.winText.setPosition(L.W / 2, L.H / 2);
    this.countdownText.setPosition(L.W / 2, L.H / 2);
    this.pausedText.setPosition(L.W / 2, L.H / 2 - 140);

    this.bgZone.setPosition(L.W / 2, L.H / 2).setSize(L.W, L.H);

    this.buildBtns.forEach((entry, i) => {
      const rect = L.buildBtns[i];
      entry.container.setData("x", rect.x);
      entry.container.setData("y", rect.y);
      entry.container.setData("w", rect.w);
      entry.container.setData("h", rect.h);
      entry.title.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.25);
      entry.detail.setPosition(rect.x + rect.w / 2, rect.y + rect.h * 0.68);
      const zone = this.buildBtnZones[i];
      zone.setPosition(rect.x + rect.w / 2, rect.y + rect.h / 2);
      zone.setSize(rect.w, rect.h);
    });

    this.slotHit.forEach((hit, i) => {
      const pos = L.leftSlots[i];
      hit.setPosition(pos.x, pos.y);
    });

    const pb = L.pauseBtn;
    this.pauseBtn.bg.setData("x", pb.x).setData("y", pb.y).setData("size", pb.size);
    this.pauseBtn.icon.setPosition(pb.x + pb.size / 2, pb.y + pb.size / 2);
    this.pauseBtnZone
      .setPosition(pb.x + pb.size / 2, pb.y + pb.size / 2)
      .setSize(pb.size, pb.size);

    const rb = L.restartBtn;
    this.restartBtn.bg.setData("x", rb.x).setData("y", rb.y).setData("size", rb.size);
    this.restartBtn.icon.setPosition(rb.x + rb.size / 2, rb.y + rb.size / 2);
    this.restartBtnZone
      .setPosition(rb.x + rb.size / 2, rb.y + rb.size / 2)
      .setSize(rb.size, rb.size);
  }

  update(_time: number, deltaMs: number): void {
    const dt = Math.min(0.1, deltaMs / 1000);
    if (!this.state.winner && !this.paused) {
      step(this.state, dt);
      this.ai.update(this.state, dt);
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
    this.updateHud();
    this.updateBuildButtons();
    this.updateUpgradeButton();
    this.updateWinBanner();
    this.updateCountdown();
    this.updatePausedOverlay();
    this.updateControlButtons();
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

    // Contested seam — silvery shimmer
    const pulse = 0.55 + 0.25 * Math.sin(this.state.time * 6);
    this.fx.fillStyle(0xcfd6ea, pulse);
    this.fx.fillRect(frontX - 4, L.logTop - 4, 8, L.logH + 8);

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
    const hpW = 140;
    const hpH = 14;
    const hpX = x - hpW / 2;
    const hpY = this.layout.logTop - 26;
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
    for (let i = 0; i < SLOT_COUNT; i++) {
      const pos = positions[i];
      const s = colony.slots[i];

      // Slot frame
      this.bg.lineStyle(2, 0x6a4a30, 0.6);
      this.bg.strokeCircle(pos.x, pos.y, r);

      if (!s) continue;
      const cfg = STRUCTURES[s.kind];

      // Fill by kind with alpha by status
      const alpha = s.status === "active" ? 1 : 0.45;
      this.bg.fillStyle(cfg.color, alpha);
      this.bg.fillCircle(pos.x, pos.y, r - 4);

      // Ring (level indicator)
      if (s.level > 1) {
        this.bg.lineStyle(3, 0xf5e8c8, 0.9);
        this.bg.strokeCircle(pos.x, pos.y, r - 4);
      }

      // Progress arc while growing/mutating
      if (s.status !== "active") {
        const cfgTime =
          s.status === "growing" ? cfg.buildTime : cfg.mutateTime;
        const prog = 1 - s.timer / cfgTime;
        const end = -Math.PI / 2 + prog * Math.PI * 2;
        this.fx.lineStyle(4, 0xf5e8c8, 0.95);
        this.fx.beginPath();
        this.fx.arc(pos.x, pos.y, r + 2, -Math.PI / 2, end, false);
        this.fx.strokePath();
      }

      // Pressure wave (active structures only, periodic pulse)
      if (s.status === "active" && cfg.basePressure > 0) {
        const phase = (this.state.time * 0.8 + s.id * 0.37) % 1;
        const pr = r - 4 + phase * 32;
        this.fx.lineStyle(2, cfg.color, 1 - phase);
        this.fx.strokeCircle(pos.x, pos.y, pr);
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
  }

  private updateControlButtons(): void {
    this.drawControlButton(this.pauseBtn, this.paused ? 0x3a5a28 : 0x3a2a18);
    this.pauseBtn.icon.setText(this.paused ? "\u25B6" : "\u23F8");
    this.drawControlButton(this.restartBtn, 0x3a2a18);
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
    const pulse = 0.7 + 0.3 * Math.sin(this.state.time * 6);
    this.upgradeBtnBg.lineStyle(3, 0xfff2c0, pulse);
    this.upgradeBtnBg.strokeCircle(pos.x, pos.y, 38);

    // Button floats above the slot. Clamp to stay on screen.
    const btnW = 170;
    const btnH = 56;
    const btnX = pos.x;
    const btnY = Math.max(btnH / 2 + 4, pos.y - 68);

    const can = canMutate(this.state, "left", idx);
    const isBusy = s.status !== "active";

    let text: string;
    let textColor: string;
    let borderColor: number;
    let fillColor: number;
    if (s.status === "growing") {
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
    this.state = createGameState();
    this.ai = new SimpleAI("right");
    this.paused = false;
    this.selectedSlotIdx = null;
  }
}
