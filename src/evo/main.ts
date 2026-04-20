import {
  defaultBalance,
  resetBalance,
  setBalance,
  snapshotBalance,
  type BalanceSnapshot,
  type StructureTunables,
} from "../game/config";
import type { StructureKind } from "../game/types";
import {
  DEFAULT_CONFIG,
  GA,
  type Evaluated,
  type GenerationResult,
  type TierEntry,
} from "./ga";
import { describeGenotype } from "./genotype";
import { WorkerPool } from "./pool";

const workerCount = Math.max(
  2,
  Math.min(8, (navigator.hardwareConcurrency || 4) - 1),
);

function qs<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing: ${sel}`);
  return el as T;
}

const els = {
  status: qs<HTMLDivElement>("#status"),
  startBtn: qs<HTMLButtonElement>("#start-btn"),
  stopBtn: qs<HTMLButtonElement>("#stop-btn"),
  resetBtn: qs<HTMLButtonElement>("#reset-btn"),
  downloadBtn: qs<HTMLButtonElement>("#download-btn"),
  downloadSummaryBtn: qs<HTMLButtonElement>("#download-summary-btn"),
  progress: qs<HTMLProgressElement>("#progress"),
  gen: qs<HTMLSpanElement>("#gen-num"),
  workers: qs<HTMLSpanElement>("#worker-count"),
  leaderboard: qs<HTMLDivElement>("#leaderboard"),
  tiers: qs<HTMLDivElement>("#tiers"),
  log: qs<HTMLDivElement>("#log"),
  chart: qs<HTMLCanvasElement>("#chart"),
  genesHist: qs<HTMLDivElement>("#genes-hist"),
  matrix: qs<HTMLDivElement>("#matrix"),
  balancePanel: qs<HTMLDivElement>("#balance-fields"),
  balanceApply: qs<HTMLButtonElement>("#balance-apply-btn"),
  balanceReset: qs<HTMLButtonElement>("#balance-reset-btn"),
  balanceDirty: qs<HTMLSpanElement>("#balance-dirty"),
};

els.workers.textContent = String(workerCount);

interface HistoryPoint {
  generation: number;
  bestScore: number;
  meanScore: number;
  tier1Count: number;
}

let pool: WorkerPool | null = null;
let ga: GA | null = null;
let running = false;
let history: HistoryPoint[] = [];
let lastResult: GenerationResult | null = null;
/** Edited-but-not-yet-applied balance values, keyed by field path. */
let balanceDraft: BalanceSnapshot = snapshotBalance();

function ensurePool(): WorkerPool {
  if (!pool) pool = new WorkerPool(workerCount, () => snapshotBalance());
  return pool;
}

function log(line: string): void {
  const now = new Date().toLocaleTimeString();
  const p = document.createElement("div");
  p.textContent = `[${now}] ${line}`;
  els.log.prepend(p);
  while (els.log.children.length > 100) els.log.lastChild?.remove();
}

function renderLeaderboard(evaluated: Evaluated[]): void {
  els.leaderboard.innerHTML = "";
  const top = evaluated.slice(0, 10);
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const row = document.createElement("div");
    row.className = "row";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = `#${i + 1}`;
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = (e.score * 100).toFixed(1) + "%";
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = e.genotype.id;
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = describeGenotype(e.genotype);
    row.append(rank, score, id, body);
    els.leaderboard.appendChild(row);
  }
}

function renderTiers(tiers: TierEntry[]): void {
  els.tiers.innerHTML = "";
  let currentTier = -1;
  for (const t of tiers) {
    if (t.tier !== currentTier) {
      currentTier = t.tier;
      const header = document.createElement("div");
      header.className = `tier-header tier-${t.tier}`;
      const label = document.createElement("span");
      label.className = "tier-label";
      label.textContent = `Tier ${t.tier}`;
      const caption = document.createElement("span");
      caption.className = "tier-caption";
      caption.textContent =
        t.tier === 1
          ? "— core meta (Nash support)"
          : t.tier === 2
            ? "— viable counter (wins vs. meta)"
            : "— fringe / dominated";
      header.append(label, caption);
      els.tiers.appendChild(header);
    }
    const row = document.createElement("div");
    row.className = "row";
    const weight = document.createElement("span");
    weight.className = "score";
    weight.textContent = (t.nashWeight * 100).toFixed(1) + "%";
    const vsn = document.createElement("span");
    vsn.className = "score dim";
    vsn.textContent = (t.scoreVsNash * 100).toFixed(0) + "%";
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = t.genotype.id;
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = describeGenotype(t.genotype);
    row.append(weight, vsn, id, body);
    els.tiers.appendChild(row);
  }
}

function renderMatrix(result: GenerationResult): void {
  const M = result.matchupMatrix;
  const hof = result.hallOfFame;
  els.matrix.innerHTML = "";
  if (M.length === 0) return;
  const table = document.createElement("table");
  table.className = "matrix-table";
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const g of hof) {
    const th = document.createElement("th");
    th.textContent = g.id;
    headRow.appendChild(th);
  }
  table.appendChild(headRow);
  for (let i = 0; i < M.length; i++) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = hof[i].id;
    tr.appendChild(th);
    for (let j = 0; j < M[i].length; j++) {
      const td = document.createElement("td");
      const v = M[i][j];
      td.textContent = i === j ? "–" : (v * 100).toFixed(0);
      // Green tint for wins (>50%), red for losses. Opacity = confidence of advantage.
      if (i !== j) {
        const bias = (v - 0.5) * 2; // -1..1
        const a = Math.min(0.8, Math.abs(bias));
        const color =
          bias >= 0
            ? `rgba(122, 138, 58, ${a.toFixed(2)})`
            : `rgba(200, 90, 60, ${a.toFixed(2)})`;
        td.style.background = color;
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  els.matrix.appendChild(table);
}

function renderChart(): void {
  const c = els.chart;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const w = c.width;
  const h = c.height;
  ctx.fillStyle = "#1b120a";
  ctx.fillRect(0, 0, w, h);
  if (history.length === 0) return;

  const pad = 24;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;
  const xMax = Math.max(1, history.length - 1);

  ctx.strokeStyle = "rgba(232, 215, 182, 0.15)";
  ctx.lineWidth = 1;
  for (let y = 0; y <= 4; y++) {
    const yy = pad + (plotH * y) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, yy);
    ctx.lineTo(pad + plotW, yy);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(232, 215, 182, 0.4)";
  ctx.font = "10px ui-monospace, Menlo, monospace";
  for (let y = 0; y <= 4; y++) {
    const frac = 1 - y / 4;
    const yy = pad + (plotH * y) / 4;
    ctx.fillText((frac * 100).toFixed(0) + "%", 2, yy + 3);
  }

  const plot = (key: "bestScore" | "meanScore", color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = pad + (plotW * i) / xMax;
      const y = pad + plotH * (1 - history[i][key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  plot("meanScore", "#7a8a3a");
  plot("bestScore", "#d9b24a");

  ctx.fillStyle = "#d9b24a";
  ctx.fillText("best", pad + 4, pad + 12);
  ctx.fillStyle = "#7a8a3a";
  ctx.fillText("mean", pad + 4, pad + 26);
}

function renderGenesHist(evaluated: Evaluated[]): void {
  els.genesHist.innerHTML = "";
  const counts: Record<string, number> = {
    hyphae: 0,
    rhizomorph: 0,
    fruiting: 0,
    decomposer: 0,
  };
  const half = evaluated.slice(0, Math.max(1, Math.ceil(evaluated.length / 2)));
  let total = 0;
  for (const e of half) {
    const w = Math.max(0.01, e.score);
    for (const g of e.genotype.genes) {
      if (g.kind === "build") {
        counts[g.structure] += w;
        total += w;
      }
    }
    counts[e.genotype.tailBuild] += w * 2;
    total += w * 2;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries) {
    const pct = total > 0 ? (v / total) * 100 : 0;
    const row = document.createElement("div");
    row.className = "bar-row";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = k;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = pct.toFixed(1) + "%";
    bar.appendChild(fill);
    const val = document.createElement("span");
    val.className = "bar-val";
    val.textContent = pct.toFixed(0) + "%";
    row.append(label, bar, val);
    els.genesHist.appendChild(row);
  }
}

function onGenerationDone(result: GenerationResult): void {
  const best = result.evaluated[0]?.score ?? 0;
  const mean =
    result.evaluated.reduce((s, e) => s + e.score, 0) /
    Math.max(1, result.evaluated.length);
  const tier1Count = result.tiers.filter((t) => t.tier === 1).length;
  history.push({
    generation: result.generation,
    bestScore: best,
    meanScore: mean,
    tier1Count,
  });
  lastResult = result;

  els.gen.textContent = String(result.generation);
  renderLeaderboard(result.evaluated);
  renderTiers(result.tiers);
  renderMatrix(result);
  renderChart();
  renderGenesHist(result.evaluated);
  log(
    `gen ${result.generation}: best=${(best * 100).toFixed(1)}% mean=${(mean * 100).toFixed(1)}% | ` +
      `HoF=${result.hallOfFame.length} Tier1=${tier1Count} | ${result.pairsPlayed} played, ${result.pairsCached} cached`,
  );
}

async function runLoop(): Promise<void> {
  if (!ga) return;
  while (running) {
    try {
      const result = await ga.runGeneration((done, total) => {
        els.progress.max = Math.max(1, total);
        els.progress.value = done;
        els.status.textContent = `gen ${ga!.generation} — ${done}/${total} pairs`;
      });
      onGenerationDone(result);
      els.progress.value = 0;
      els.status.textContent = `idle — gen ${result.generation} complete`;
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      running = false;
      break;
    }
  }
  updateButtons();
}

function start(): void {
  if (running) return;
  if (!ga) {
    ga = new GA(DEFAULT_CONFIG, ensurePool());
    log(
      `init: pop=${DEFAULT_CONFIG.populationSize} elites=${DEFAULT_CONFIG.elites} ` +
        `hof=${DEFAULT_CONFIG.hallOfFameSize} workers=${workerCount}`,
    );
  }
  running = true;
  updateButtons();
  runLoop();
}

function stop(): void {
  running = false;
  els.status.textContent = "stopping after current generation…";
  updateButtons();
}

function reset(): void {
  if (running) return;
  if (pool) {
    pool.terminate();
    pool = null;
  }
  ga = null;
  history = [];
  lastResult = null;
  els.gen.textContent = "0";
  els.leaderboard.innerHTML = "";
  els.tiers.innerHTML = "";
  els.matrix.innerHTML = "";
  els.genesHist.innerHTML = "";
  els.log.innerHTML = "";
  renderChart();
  els.status.textContent = "reset — press start";
}

function saveJson(data: unknown, suffix: string): void {
  const gen = ga?.generation ?? 0;
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sporefall-evo-gen${gen}-${suffix}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function download(): void {
  saveJson(
    {
      generation: ga?.generation ?? 0,
      config: DEFAULT_CONFIG,
      balance: snapshotBalance(),
      workerCount,
      history,
      lastResult,
      // Full cumulative matchup matrix — useful for offline post-hoc analysis
      // (Elo, alternate Nash solvers, clustering etc.).
      matchups: ga?.exportMatchups() ?? [],
      exportedAt: new Date().toISOString(),
    },
    "full",
  );
}

function downloadSummary(): void {
  const result = lastResult;
  // HoF + tiers + top leaderboard + matrix, all with human-readable genome
  // strings instead of full gene arrays. Target size: a few KB regardless of
  // how long the run has gone.
  const summary = {
    generation: ga?.generation ?? 0,
    exportedAt: new Date().toISOString(),
    config: DEFAULT_CONFIG,
    balance: snapshotBalance(),
    workerCount,
    history, // tiny — one row per generation
    hallOfFame: result
      ? result.hallOfFame.map((g) => ({
          id: g.id,
          genome: describeGenotype(g),
        }))
      : [],
    tiers: result
      ? result.tiers.map((t) => ({
          tier: t.tier,
          id: t.genotype.id,
          nashWeight: Number(t.nashWeight.toFixed(4)),
          scoreVsNash: Number(t.scoreVsNash.toFixed(4)),
          genome: describeGenotype(t.genotype),
        }))
      : [],
    topLeaderboard: result
      ? result.evaluated.slice(0, 5).map((e) => ({
          id: e.genotype.id,
          score: Number(e.score.toFixed(4)),
          games: e.games,
          genome: describeGenotype(e.genotype),
        }))
      : [],
    matchupMatrix: result
      ? {
          ids: result.hallOfFame.map((g) => g.id),
          rows: result.matchupMatrix.map((r) =>
            r.map((v) => Number(v.toFixed(3))),
          ),
        }
      : null,
  };
  saveJson(summary, "summary");
}

interface BalanceField {
  path: string; // dotted path within BalanceSnapshot
  label: string;
  step: number;
  min?: number;
}

const GLOBAL_FIELDS: BalanceField[] = [
  { path: "frontSpeed", label: "Front speed", step: 0.001, min: 0 },
  { path: "sclerotiumDamage", label: "Sclerotium damage/s", step: 0.5, min: 0 },
  { path: "startHp", label: "Start HP", step: 10, min: 1 },
  { path: "startNutrients", label: "Start nutrients", step: 5, min: 0 },
  { path: "baseIncome", label: "Base income/s", step: 0.5, min: 0 },
];

const COMBAT_FIELDS: BalanceField[] = [
  { path: "disableThreshold", label: "Disable threshold", step: 10, min: 1 },
  { path: "disableDuration", label: "Disable duration (s)", step: 1, min: 0 },
  { path: "rhizoDissolveRate", label: "Rhizo dissolve rate/s", step: 1, min: 0 },
  { path: "surgeThreshold", label: "Surge threshold", step: 10, min: 1 },
  { path: "surgeChargeRate", label: "Surge charge rate/s", step: 1, min: 0 },
  { path: "surgeBurstDamage", label: "Surge burst damage", step: 5, min: 0 },
  {
    path: "surgeBurstPressureMult",
    label: "Surge burst pressure ×",
    step: 0.5,
    min: 1,
  },
];

const STRUCTURE_KINDS: StructureKind[] = [
  "hyphae",
  "rhizomorph",
  "fruiting",
  "decomposer",
];

const STRUCTURE_FIELDS: Array<keyof StructureTunables> = [
  "cost",
  "buildTime",
  "basePressure",
  "incomeBonus",
  "disableDecay",
];

const STRUCTURE_FIELD_STEPS: Record<keyof StructureTunables, number> = {
  cost: 5,
  buildTime: 0.5,
  basePressure: 0.25,
  incomeBonus: 0.25,
  disableDecay: 0.5,
};

function getField(snap: BalanceSnapshot, path: string): number {
  const parts = path.split(".");
  let v: unknown = snap;
  for (const p of parts) v = (v as Record<string, unknown>)[p];
  return v as number;
}

function setField(snap: BalanceSnapshot, path: string, value: number): void {
  const parts = path.split(".");
  let v: Record<string, unknown> = snap as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    v = v[parts[i]] as Record<string, unknown>;
  }
  v[parts[parts.length - 1]] = value;
}

function makeFieldRow(f: BalanceField, defaults: BalanceSnapshot): HTMLElement {
  const row = document.createElement("label");
  row.className = "balance-row";
  const label = document.createElement("span");
  label.className = "balance-label";
  label.textContent = f.label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(f.step);
  if (f.min !== undefined) input.min = String(f.min);
  input.value = String(getField(balanceDraft, f.path));
  input.dataset.path = f.path;
  input.className = "balance-input";
  input.addEventListener("input", () => {
    const n = Number(input.value);
    if (!Number.isFinite(n)) return;
    setField(balanceDraft, f.path, n);
    updateBalanceDirty();
  });
  const def = document.createElement("span");
  def.className = "balance-default";
  def.textContent = `(${getField(defaults, f.path)})`;
  row.append(label, input, def);
  return row;
}

function renderBalancePanel(): void {
  const defaults = defaultBalance();
  const parent = els.balancePanel;
  parent.innerHTML = "";

  const mkSection = (title: string, fields: BalanceField[]) => {
    const group = document.createElement("div");
    group.className = "balance-group";
    const h = document.createElement("div");
    h.className = "balance-group-title";
    h.textContent = title;
    group.appendChild(h);
    for (const f of fields) group.appendChild(makeFieldRow(f, defaults));
    parent.appendChild(group);
  };

  mkSection("Global", GLOBAL_FIELDS);
  mkSection("Combat / disable / surge", COMBAT_FIELDS);
  for (const kind of STRUCTURE_KINDS) {
    const perKind: BalanceField[] = STRUCTURE_FIELDS.map((f) => ({
      path: `${kind}.${f}`,
      label: f,
      step: STRUCTURE_FIELD_STEPS[f],
      min: 0,
    }));
    mkSection(kind.charAt(0).toUpperCase() + kind.slice(1), perKind);
  }
  updateBalanceDirty();
}

function balanceIsDirty(): boolean {
  const live = snapshotBalance();
  return JSON.stringify(live) !== JSON.stringify(balanceDraft);
}

function updateBalanceDirty(): void {
  const dirty = balanceIsDirty();
  els.balanceDirty.textContent = dirty ? "(unsaved changes)" : "";
  els.balanceApply.disabled = !dirty || running;
}

function applyBalance(): void {
  if (running) return;
  setBalance(balanceDraft);
  // Invalidate any cached matchups — they were computed at the old balance.
  if (pool) {
    pool.terminate();
    pool = null;
  }
  ga = null;
  history = [];
  lastResult = null;
  els.gen.textContent = "0";
  els.leaderboard.innerHTML = "";
  els.tiers.innerHTML = "";
  els.matrix.innerHTML = "";
  els.genesHist.innerHTML = "";
  renderChart();
  log("balance applied — GA reset, press Start");
  els.status.textContent = "balance applied — press Start";
  updateBalanceDirty();
  updateButtons();
}

function resetBalanceToDefaults(): void {
  if (running) return;
  resetBalance();
  balanceDraft = snapshotBalance();
  renderBalancePanel();
  log("balance reset to defaults");
}

function updateButtons(): void {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.resetBtn.disabled = running;
  els.balanceApply.disabled = running || !balanceIsDirty();
  els.balanceReset.disabled = running;
}

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.resetBtn.addEventListener("click", reset);
els.downloadBtn.addEventListener("click", download);
els.downloadSummaryBtn.addEventListener("click", downloadSummary);
els.balanceApply.addEventListener("click", applyBalance);
els.balanceReset.addEventListener("click", resetBalanceToDefaults);

renderBalancePanel();

window.addEventListener("beforeunload", () => {
  if (pool) pool.terminate();
});

els.status.textContent = `ready — ${workerCount} workers`;
updateButtons();
renderChart();
