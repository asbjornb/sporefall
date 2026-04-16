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

const WIDTH = 1280;
const HEIGHT = 720;
const LOG_LEFT = 80;
const LOG_RIGHT = 1200;
const LOG_TOP = 110;
const LOG_H = 260;
const LOG_BOTTOM = LOG_TOP + LOG_H;
const LOG_W = LOG_RIGHT - LOG_LEFT;

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

function slotPositions(side: Side): SlotSpec[] {
  // 2x2 grid just inward from each sclerotium.
  const baseX = side === "left" ? 180 : 1100;
  const dx = side === "left" ? 80 : -80;
  const positions: SlotSpec[] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      positions.push({
        x: baseX + dx * col,
        y: LOG_BOTTOM + 55 + row * 70,
      });
    }
  }
  return positions;
}

const LEFT_SLOTS = slotPositions("left");
const RIGHT_SLOTS = slotPositions("right");

export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private ai!: SimpleAI;
  private bg!: Phaser.GameObjects.Graphics;
  private fx!: Phaser.GameObjects.Graphics;
  private topText!: Phaser.GameObjects.Text;
  private winText!: Phaser.GameObjects.Text;
  private buildBtns: {
    kind: StructureKind;
    container: Phaser.GameObjects.Container;
    label: Phaser.GameObjects.Text;
    bg: Phaser.GameObjects.Graphics;
  }[] = [];
  private slotHit: Phaser.GameObjects.Arc[] = [];

  constructor() {
    super("game");
  }

  create(): void {
    this.state = createGameState();
    this.ai = new SimpleAI("right");

    this.bg = this.add.graphics();
    this.fx = this.add.graphics();

    this.topText = this.add.text(24, 14, "", {
      fontSize: "26px",
      color: "#e8d7b6",
      fontFamily: "system-ui, sans-serif",
    });

    this.winText = this.add
      .text(WIDTH / 2, HEIGHT / 2, "", {
        fontSize: "76px",
        color: "#f8e8c0",
        fontStyle: "bold",
        fontFamily: "system-ui, sans-serif",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.createBuildButtons();
    this.createSlotHitAreas();

    this.input.keyboard?.on("keydown-R", () => this.restart());
    // Any tap/click after the game is over restarts — mobile-friendly.
    this.input.on("pointerdown", () => {
      if (this.state.winner) this.restart();
    });
  }

  update(_time: number, deltaMs: number): void {
    const dt = Math.min(0.1, deltaMs / 1000);
    if (!this.state.winner) {
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
    this.updateWinBanner();
  }

  private drawLog(): void {
    // Log body (bark)
    this.bg.fillStyle(LOG_BARK, 1);
    this.bg.fillRoundedRect(LOG_LEFT - 10, LOG_TOP - 10, LOG_W + 20, LOG_H + 20, 16);
    this.bg.fillStyle(LOG_BODY, 1);
    this.bg.fillRoundedRect(LOG_LEFT, LOG_TOP, LOG_W, LOG_H, 12);

    // Grain lines
    this.bg.lineStyle(1, 0x2a1a0a, 0.4);
    for (let i = 1; i < 5; i++) {
      const y = LOG_TOP + (LOG_H * i) / 5;
      this.bg.beginPath();
      this.bg.moveTo(LOG_LEFT + 8, y);
      this.bg.lineTo(LOG_RIGHT - 8, y);
      this.bg.strokePath();
    }

    const frontX = LOG_LEFT + LOG_W * this.state.front;

    // Left colony color flow
    this.bg.fillStyle(LEFT_TINT, 0.45);
    this.bg.fillRect(LOG_LEFT, LOG_TOP, frontX - LOG_LEFT, LOG_H);

    // Right colony color flow
    this.bg.fillStyle(RIGHT_TINT, 0.45);
    this.bg.fillRect(frontX, LOG_TOP, LOG_RIGHT - frontX, LOG_H);

    // Contested seam — silvery shimmer
    const pulse = 0.55 + 0.25 * Math.sin(this.state.time * 6);
    this.fx.fillStyle(0xcfd6ea, pulse);
    this.fx.fillRect(frontX - 4, LOG_TOP - 4, 8, LOG_H + 8);

    // Net pressure glow
    const pL = pressureOf(this.state, "left");
    const pR = pressureOf(this.state, "right");
    const net = pL - pR;
    if (Math.abs(net) > 0.1) {
      const tint = net > 0 ? LEFT_TINT : RIGHT_TINT;
      const dir = net > 0 ? 1 : -1;
      const glowX = frontX + dir * 36;
      this.fx.fillStyle(tint, 0.25);
      this.fx.fillCircle(glowX, LOG_TOP + LOG_H / 2, 48);
    }
  }

  private drawSclerotia(): void {
    this.drawHeart("left", 100, LOG_TOP + LOG_H / 2);
    this.drawHeart("right", 1180, LOG_TOP + LOG_H / 2);
  }

  private drawHeart(side: Side, x: number, y: number): void {
    const colony = this.state[side];
    const color = side === "left" ? LEFT_TINT : RIGHT_TINT;
    // outer glow
    this.bg.fillStyle(color, 0.25);
    this.bg.fillCircle(x, y, 64);
    // core
    this.bg.fillStyle(color, 1);
    this.bg.fillCircle(x, y, 38);
    this.bg.fillStyle(0xf5e8c8, 0.8);
    this.bg.fillCircle(x, y, 14);

    // HP bar above the log so it never sits on bark
    const hpW = 140;
    const hpH = 14;
    const hpX = x - hpW / 2;
    const hpY = LOG_TOP - 26;
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
    const positions = side === "left" ? LEFT_SLOTS : RIGHT_SLOTS;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const pos = positions[i];
      const s = colony.slots[i];

      // Slot frame
      this.bg.lineStyle(2, 0x6a4a30, 0.6);
      this.bg.strokeCircle(pos.x, pos.y, 32);

      if (!s) continue;
      const cfg = STRUCTURES[s.kind];

      // Fill by kind with alpha by status
      const alpha = s.status === "active" ? 1 : 0.45;
      this.bg.fillStyle(cfg.color, alpha);
      this.bg.fillCircle(pos.x, pos.y, 28);

      // Ring (level indicator)
      if (s.level > 1) {
        this.bg.lineStyle(3, 0xf5e8c8, 0.9);
        this.bg.strokeCircle(pos.x, pos.y, 28);
      }

      // Progress arc while growing/mutating
      if (s.status !== "active") {
        const cfgTime =
          s.status === "growing" ? cfg.buildTime : cfg.mutateTime;
        const prog = 1 - s.timer / cfgTime;
        const end = -Math.PI / 2 + prog * Math.PI * 2;
        this.fx.lineStyle(4, 0xf5e8c8, 0.95);
        this.fx.beginPath();
        this.fx.arc(pos.x, pos.y, 34, -Math.PI / 2, end, false);
        this.fx.strokePath();
      }

      // Pressure wave (active structures only, periodic pulse)
      if (s.status === "active" && cfg.basePressure > 0) {
        const phase = (this.state.time * 0.8 + s.id * 0.37) % 1;
        const r = 28 + phase * 32;
        this.fx.lineStyle(2, cfg.color, 1 - phase);
        this.fx.strokeCircle(pos.x, pos.y, r);
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

  // ---------- UI: build buttons ----------

  private createBuildButtons(): void {
    const btnW = 280;
    const btnH = 130;
    const gap = 24;
    const total = btnW * 4 + gap * 3;
    const startX = (WIDTH - total) / 2;
    const y = 560;

    KINDS.forEach((kind, i) => {
      const x = startX + i * (btnW + gap);
      const bg = this.add.graphics();
      const label = this.add
        .text(x + btnW / 2, y + btnH / 2, "", {
          fontSize: "22px",
          color: "#f5e8c8",
          align: "center",
          fontFamily: "system-ui, sans-serif",
        })
        .setOrigin(0.5);
      const container = this.add.container(0, 0, [bg, label]);
      const zone = this.add
        .zone(x + btnW / 2, y + btnH / 2, btnW, btnH)
        .setInteractive({ useHandCursor: true });
      zone.on("pointerdown", () => this.onBuildTap(kind));
      container.setData("x", x);
      container.setData("y", y);
      container.setData("w", btnW);
      container.setData("h", btnH);
      this.buildBtns.push({ kind, container, label, bg });
    });
  }

  private updateBuildButtons(): void {
    for (const { kind, container, label, bg } of this.buildBtns) {
      const x = container.getData("x") as number;
      const y = container.getData("y") as number;
      const w = container.getData("w") as number;
      const h = container.getData("h") as number;
      const cfg = STRUCTURES[kind];
      const can = canBuild(this.state, "left", kind);

      bg.clear();
      bg.fillStyle(can ? 0x3a2a18 : 0x241a10, 1);
      bg.fillRoundedRect(x, y, w, h, 10);
      bg.lineStyle(2, can ? cfg.color : 0x4a3420, 1);
      bg.strokeRoundedRect(x, y, w, h, 10);

      const info =
        kind === "decomposer"
          ? `+${cfg.incomeBonus}/s income`
          : `pressure ${cfg.basePressure}`;
      label.setText(`${cfg.label}\n${cfg.cost}n   ${cfg.buildTime}s\n${info}`);
      label.setColor(can ? "#f5e8c8" : "#8a7a60");
    }
  }

  private onBuildTap(kind: StructureKind): void {
    if (this.state.winner) return;
    build(this.state, "left", kind);
  }

  // ---------- UI: slot interactions ----------

  private createSlotHitAreas(): void {
    LEFT_SLOTS.forEach((pos, idx) => {
      const hit = this.add
        .circle(pos.x, pos.y, 34, 0x000000, 0)
        .setInteractive({ useHandCursor: true });
      hit.on("pointerdown", () => this.onSlotTap(idx));
      this.slotHit.push(hit);
    });
  }

  private onSlotTap(idx: number): void {
    if (this.state.winner) return;
    if (canMutate(this.state, "left", idx)) {
      mutate(this.state, "left", idx);
    }
  }

  private restart(): void {
    this.state = createGameState();
    this.ai = new SimpleAI("right");
  }
}
