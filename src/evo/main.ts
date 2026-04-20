import {
  DEFAULT_CONFIG,
  GA,
  type Evaluated,
  type GenerationResult,
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
  progress: qs<HTMLProgressElement>("#progress"),
  gen: qs<HTMLSpanElement>("#gen-num"),
  workers: qs<HTMLSpanElement>("#worker-count"),
  leaderboard: qs<HTMLDivElement>("#leaderboard"),
  hof: qs<HTMLDivElement>("#hof"),
  log: qs<HTMLDivElement>("#log"),
  chart: qs<HTMLCanvasElement>("#chart"),
  genesHist: qs<HTMLDivElement>("#genes-hist"),
};

els.workers.textContent = String(workerCount);

interface HistoryPoint {
  generation: number;
  bestScore: number;
  meanScore: number;
}

let pool: WorkerPool | null = null;
let ga: GA | null = null;
let running = false;
let history: HistoryPoint[] = [];
let allResults: GenerationResult[] = [];

function ensurePool(): WorkerPool {
  if (!pool) pool = new WorkerPool(workerCount);
  return pool;
}

function log(line: string): void {
  const now = new Date().toLocaleTimeString();
  const p = document.createElement("div");
  p.textContent = `[${now}] ${line}`;
  els.log.prepend(p);
  // Cap log length so memory doesn't creep on long runs.
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

function renderHof(hof: readonly Evaluated[]): void {
  els.hof.innerHTML = "";
  for (const e of hof) {
    const row = document.createElement("div");
    row.className = "row";
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = (e.score * 100).toFixed(1) + "%";
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = e.genotype.id;
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = describeGenotype(e.genotype);
    row.append(score, id, body);
    els.hof.appendChild(row);
  }
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
  // Distribution of build-kind usage in the top half of the population,
  // weighted by score. Gives a feel for which structures are being favored.
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
  history.push({ generation: result.generation, bestScore: best, meanScore: mean });
  allResults.push(result);
  // Cap retained full results so memory doesn't grow indefinitely; the history
  // array holds just the summary points for the chart.
  if (allResults.length > 10) allResults.shift();

  els.gen.textContent = String(result.generation);
  renderLeaderboard(result.evaluated);
  renderHof(result.hallOfFame);
  renderChart();
  renderGenesHist(result.evaluated);
  log(
    `gen ${result.generation}: best=${(best * 100).toFixed(1)}% mean=${(mean * 100).toFixed(1)}% (${result.pairsPlayed} pairs)`,
  );
}

async function runLoop(): Promise<void> {
  if (!ga) return;
  while (running) {
    try {
      const result = await ga.runGeneration((done, total) => {
        els.progress.max = total;
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
      `init: pop=${DEFAULT_CONFIG.populationSize} elites=${DEFAULT_CONFIG.elites} hof=${DEFAULT_CONFIG.hallOfFameSize} workers=${workerCount}`,
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
  allResults = [];
  els.gen.textContent = "0";
  els.leaderboard.innerHTML = "";
  els.hof.innerHTML = "";
  els.genesHist.innerHTML = "";
  els.log.innerHTML = "";
  renderChart();
  els.status.textContent = "reset — press start";
}

function download(): void {
  const data = {
    generation: ga?.generation ?? 0,
    config: DEFAULT_CONFIG,
    workerCount,
    history,
    recentGenerations: allResults,
    hallOfFame: ga?.getHallOfFame() ?? [],
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sporefall-evo-gen${data.generation}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function updateButtons(): void {
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.resetBtn.disabled = running;
}

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.resetBtn.addEventListener("click", reset);
els.downloadBtn.addEventListener("click", download);

window.addEventListener("beforeunload", () => {
  if (pool) pool.terminate();
});

els.status.textContent = `ready — ${workerCount} workers`;
updateButtons();
renderChart();
