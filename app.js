"use strict";

const METHOD_INFO = {
  clean: { name: "干净真值", color: "#e2e8f0" },
  noisy: { name: "污染原始", color: "#64748b" },
  bandpass: { name: "带通 0.5–40Hz", color: "#38bdf8" },
  notch: { name: "陷波+带通", color: "#a78bfa" },
  wavelet: { name: "小波软阈值", color: "#fbbf24" },
  ica: { name: "ICA", color: "#34d399" },
  asr: { name: "ASR（简化）", color: "#fb7185" },
};
const DENOISE_METHODS = ["bandpass", "notch", "wavelet", "ica", "asr"];
const ARTIFACT_NAMES = { eog: "眼电", emg: "肌电", line: "工频 50Hz", drift: "漂移", mixed: "混合伪迹" };

const DATASETS = {
  synthetic: {
    label: "合成 EEG",
    summary: "data/summary.json",
    prefix: "",
    badge: "已知真值 · 可复现",
    hint: "4 秒窗口 · µV（合成单位）",
    truth: "干净真值",
    note: "16 导 · 250 Hz · 40 s · 伪迹与 ERP 均为参数合成 · 固定种子 · <code>tools/generate_benchmark.py</code>",
  },
  real: {
    label: "真实背景 EEG",
    summary: "data/real_summary.json",
    prefix: "real_",
    badge: "PhysioNet S001R02 · ODC-BY 1.0",
    hint: "4 秒窗口 · µV（已归一化）",
    truth: "构造真值",
    note: `PhysioNet EEGBCI S001R02（眼闭静息）· 0.5 Hz 高通 + 逐通道归一化 · 160→250 Hz · 仅背景真实，伪迹与 ERP 仍为合成 · <a href="https://physionet.org/content/eegmmidb/1.0.0/" target="_blank" rel="noopener">ODC-BY 1.0</a> · <code>tools/generate_real_benchmark.py</code>`,
  },
};

const state = {
  dataset: "synthetic",
  artifact: "eog",
  snr: -5,
  channel: "Cz",
  selected: new Set(["bandpass", "ica"]),
  scaleWithoutNoisy: false,
  data: null,
  summary: null,
  cache: new Map(),
  recResult: null,
};

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function segmented(id, onChange) {
  const el = $(id);
  el.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    el.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    onChange(btn.dataset.value);
  });
}

function buildChips() {
  const box = $("#method-chips");
  for (const m of DENOISE_METHODS) {
    const btn = document.createElement("button");
    btn.className = "chip" + (state.selected.has(m) ? " active" : "");
    btn.style.color = state.selected.has(m) ? METHOD_INFO[m].color : "";
    btn.dataset.value = m;
    btn.innerHTML = `<span class="dot" style="background:${METHOD_INFO[m].color}"></span>${METHOD_INFO[m].name}`;
    btn.setAttribute("aria-pressed", state.selected.has(m));
    box.appendChild(btn);
  }
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const m = btn.dataset.value;
    if (state.selected.has(m)) {
      if (state.selected.size === 1) return;
      state.selected.delete(m);
    } else {
      state.selected.add(m);
    }
    btn.classList.toggle("active", state.selected.has(m));
    btn.style.color = state.selected.has(m) ? METHOD_INFO[m].color : "";
    btn.setAttribute("aria-pressed", state.selected.has(m));
    renderAll();
  });
}

function conditionFile() {
  return `${DATASETS[state.dataset].prefix}${state.artifact}_${state.snr}.json`;
}

let loadToken = 0;

async function loadCondition() {
  const token = ++loadToken;
  const file = conditionFile();
  const key = `${state.dataset}:${file}`;
  $("#status-line").classList.remove("error");
  $("#status-line").textContent = "加载基准数据中…";
  try {
    if (!state.cache.has(key)) {
      const resp = await fetch(`data/${file}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.cache.set(key, await resp.json());
    }
    if (token !== loadToken) return;
    state.data = state.cache.get(key);
    const set = DATASETS[state.dataset];
    $("#status-line").textContent =
      `当前场景：${set.label} · ${ARTIFACT_NAMES[state.artifact]}伪迹 · 注入 SNR ${state.snr} dB · 16 导 250 Hz · 与${set.truth}逐点对比`;
    renderAll();
  } catch (err) {
    if (token !== loadToken) return;
    $("#status-line").classList.add("error");
    $("#status-line").textContent = `基准数据加载失败：${err.message}。请确认通过 HTTP 服务访问本页。`;
  }
}

function applyDatasetUI() {
  const set = DATASETS[state.dataset];
  $("#header-badge").textContent = `${set.label} · 离线真实计算`;
  $("#dataset-badge").textContent = set.badge;
  $("#dataset-note").innerHTML = set.note;
  $("#wave-hint").textContent = set.hint;
  $("#metrics-hint").textContent = `与${set.truth}对比，越接近理想值越好`;
  document.querySelectorAll("#dataset-options .dataset-card").forEach((btn) => {
    const on = btn.dataset.value === state.dataset;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  });
}

let datasetToken = 0;

async function loadDataset(name) {
  if (!DATASETS[name]) return;
  const token = ++datasetToken;
  state.dataset = name;
  applyDatasetUI();
  try {
    const resp = await fetch(DATASETS[name].summary);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const summary = await resp.json();
    if (token !== datasetToken) return;
    state.summary = summary;
    recommend();
  } catch (err) {
    if (token !== datasetToken) return;
    state.summary = null;
    $("#rec-text").textContent = `推荐器数据不可用：${err.message}`;
  }
  if (token === datasetToken) await loadCondition();
}

function activeSeries() {
  return ["noisy", ...DENOISE_METHODS.filter((m) => state.selected.has(m))];
}

const CHART_HEIGHTS = { "wave-canvas": 260, "psd-canvas": 220, "erp-canvas": 220 };

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = CHART_HEIGHTS[canvas.id] || 220;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

const AXES = { left: 52, right: 12, top: 12, bottom: 46 };

function drawFrame(ctx, width, height, xLabel, yLabel) {
  const styles = getComputedStyle(document.documentElement);
  ctx.strokeStyle = styles.getPropertyValue("--site-border");
  ctx.fillStyle = styles.getPropertyValue("--site-muted");
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const x0 = AXES.left, y0 = AXES.top;
  const x1 = width - AXES.right, y1 = height - AXES.bottom;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.textAlign = "center";
  ctx.fillText(xLabel, (x0 + x1) / 2, height - 7);
  ctx.save();
  ctx.translate(13, (y0 + y1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
  return { x0, y0, x1, y1 };
}

function plotLine(ctx, values, box, xMin, xMax, yMin, yMax, color, dashed = false) {
  const n = values.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 1.4 : 1.7;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = box.x0 + ((i / (n - 1)) * (box.x1 - box.x0));
    const v = clamp(values[i], yMin, yMax);
    const y = box.y1 - ((v - yMin) / (yMax - yMin)) * (box.y1 - box.y0);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function yTicks(ctx, box, yMin, yMax, fmt) {
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--site-muted");
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    const y = box.y1 - ((i / 4) * (box.y1 - box.y0));
    ctx.fillText(fmt(v), box.x0 - 6, y + 4);
    ctx.strokeStyle = "rgba(120,140,170,0.12)";
    ctx.beginPath();
    ctx.moveTo(box.x0, y);
    ctx.lineTo(box.x1, y);
    ctx.stroke();
  }
}

function rangeOf(seriesList, getter) {
  let lo = Infinity, hi = -Infinity;
  for (const s of seriesList) {
    for (const v of getter(s)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

function drawWave() {
  const { ctx, width, height } = setupCanvas($("#wave-canvas"));
  const d = state.data;
  const ch = state.channel;
  let series = activeSeries();
  const scaleSeries = state.scaleWithoutNoisy ? series.filter((s) => s !== "noisy") : series;
  const [yMin, yMax] = rangeOf([...scaleSeries, "clean"], (s) => d.waveforms[s][ch]);
  const box = drawFrame(ctx, width, height, "时间（s，窗口 6–10s）", "幅值（µV）");
  yTicks(ctx, box, yMin, yMax, (v) => v.toFixed(0));
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--site-muted");
  ctx.textAlign = "center";
  for (let t = 6; t <= 10; t++) {
    const x = box.x0 + ((t - 6) / 4) * (box.x1 - box.x0);
    ctx.fillText(String(t), x, box.y1 + 15);
  }
  for (const s of ["noisy", ...DENOISE_METHODS.filter((m) => state.selected.has(m)), "clean"]) {
    plotLine(ctx, d.waveforms[s][ch], box, 0, 1, yMin, yMax, METHOD_INFO[s].color, s === "clean");
  }
}

function drawPsd() {
  const { ctx, width, height } = setupCanvas($("#psd-canvas"));
  const d = state.data;
  const series = [...activeSeries(), "clean"];
  const [yMin, yMax] = rangeOf(series, (s) => d.psd[s]);
  const box = drawFrame(ctx, width, height, "频率（Hz）", "功率（dB）");
  yTicks(ctx, box, yMin, yMax, (v) => v.toFixed(0));
  const freqs = d.psd_freqs;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--site-muted");
  ctx.textAlign = "center";
  for (const f of [0, 10, 20, 30, 40, 50, 60]) {
    const x = box.x0 + (f / 60) * (box.x1 - box.x0);
    ctx.fillText(String(f), x, box.y1 + 15);
  }
  for (const s of series) {
    const decimated = [];
    for (let i = 0; i < freqs.length; i += 2) decimated.push(d.psd[s][i]);
    plotLine(ctx, decimated, box, 0, 60, yMin, yMax, METHOD_INFO[s].color, s === "clean");
  }
}

function drawErp() {
  const { ctx, width, height } = setupCanvas($("#erp-canvas"));
  const d = state.data;
  const series = [...activeSeries(), "clean"];
  const [yMin, yMax] = rangeOf(series, (s) => d.erp[s]);
  const box = drawFrame(ctx, width, height, "时间（s，0 = 刺激 onset）", "幅值（µV）");
  const t0 = d.erp_times[0], t1 = d.erp_times[d.erp_times.length - 1];
  const xOf = (t) => box.x0 + ((t - t0) / (t1 - t0)) * (box.x1 - box.x0);
  ctx.fillStyle = "rgba(56,189,248,0.08)";
  ctx.fillRect(xOf(0.2), box.y0, xOf(0.5) - xOf(0.2), box.y1 - box.y0);
  yTicks(ctx, box, yMin, yMax, (v) => v.toFixed(1));
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--site-muted");
  ctx.textAlign = "center";
  for (const t of [-0.2, 0, 0.2, 0.4, 0.6, 0.8]) ctx.fillText(t.toFixed(1), xOf(t), box.y1 + 15);
  ctx.strokeStyle = "rgba(140,160,190,0.4)";
  ctx.beginPath();
  const yZero = box.y1 - ((0 - yMin) / (yMax - yMin)) * (box.y1 - box.y0);
  ctx.moveTo(box.x0, yZero); ctx.lineTo(box.x1, yZero); ctx.stroke();
  for (const s of series) {
    plotLine(ctx, d.erp[s], box, t0, t1, yMin, yMax, METHOD_INFO[s].color, s === "clean");
  }
}

function renderLegend() {
  const box = $("#wave-legend");
  box.innerHTML = "";
  for (const s of [...activeSeries(), "clean"]) {
    const item = document.createElement("span");
    item.className = "item";
    item.innerHTML = `<span class="swatch ${s === "clean" ? "dashed" : ""}" style="background:${s === "clean" ? "" : METHOD_INFO[s].color};color:${METHOD_INFO[s].color}"></span>${METHOD_INFO[s].name}`;
    box.appendChild(item);
  }
  const opt = document.createElement("label");
  opt.className = "scale-option";
  opt.innerHTML = `<input type="checkbox" id="scale-toggle" ${state.scaleWithoutNoisy ? "checked" : ""}> 幅度标尺排除污染原始（原始波形可能被截断）`;
  box.appendChild(opt);
  opt.querySelector("input").addEventListener("change", (ev) => {
    state.scaleWithoutNoisy = ev.target.checked;
    drawWave();
  });
}

function composite(m) {
  const s = {
    corr: clamp(m.corr),
    snr: clamp((m.snr_improvement + 2) / 14),
    alpha: clamp(1 - Math.abs(1 - m.alpha_ratio)),
    beta: clamp(1 - Math.abs(1 - m.beta_ratio)),
    erp: clamp(1 - Math.abs(1 - m.erp_peak_ratio)),
    lat: clamp(1 - m.erp_latency_shift_ms / 60),
  };
  return 100 * (0.25 * s.corr + 0.15 * s.snr + 0.1 * s.alpha + 0.1 * s.beta + 0.25 * s.erp + 0.15 * s.lat);
}

const METRIC_COLUMNS = [
  { key: "snr_improvement", better: "max", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2) },
  { key: "corr", better: "max", fmt: (v) => v.toFixed(3) },
  { key: "rrmse", better: "min", fmt: (v) => v.toFixed(3) },
  { key: "alpha_ratio", better: "near1", fmt: (v) => v.toFixed(2) },
  { key: "beta_ratio", better: "near1", fmt: (v) => v.toFixed(2) },
  { key: "erp_peak_ratio", better: "near1", fmt: (v) => v.toFixed(2) },
  { key: "erp_latency_shift_ms", better: "min", fmt: (v) => v.toFixed(0) },
];

function renderMetrics() {
  const tbody = $("#metrics-table tbody");
  tbody.innerHTML = "";
  const metrics = state.data.metrics;
  const bestPerCol = {};
  for (const col of METRIC_COLUMNS) {
    let best = null, bestVal = Infinity;
    for (const m of DENOISE_METHODS) {
      const v = metrics[m][col.key];
      const cost = col.better === "near1" ? Math.abs(1 - v) : col.better === "max" ? -v : v;
      if (cost < bestVal) { bestVal = cost; best = m; }
    }
    bestPerCol[col.key] = best;
  }
  for (const m of ["noisy", ...DENOISE_METHODS]) {
    const tr = document.createElement("tr");
    if (m === "noisy") tr.className = "noisy-row";
    let html = `<td class="method-name" style="color:${METHOD_INFO[m].color}">${METHOD_INFO[m].name}</td>`;
    for (const col of METRIC_COLUMNS) {
      const isBest = m !== "noisy" && bestPerCol[col.key] === m;
      html += `<td class="${isBest ? "best" : ""}">${col.fmt(metrics[m][col.key])}</td>`;
    }
    tr.innerHTML = html;
    tbody.appendChild(tr);
  }
}

function renderConclusion() {
  const metrics = state.data.metrics;
  const scores = DENOISE_METHODS.map((m) => ({ m, score: composite(metrics[m]) }));
  scores.sort((a, b) => {
    const d = b.score - a.score;
    if (Math.abs(d) > 0.5) return d;
    if (a.m === "bandpass" && b.m === "notch") return -1;
    if (a.m === "notch" && b.m === "bandpass") return 1;
    return d;
  });
  const top = scores[0];
  const tm = metrics[top.m];
  const box = $("#conclusion-body");
  let html = `<p class="verdict">综合信号保真与 ERP 保留，本场景（${DATASETS[state.dataset].label} · ${ARTIFACT_NAMES[state.artifact]} · ${state.snr} dB）推荐
    <strong>${METHOD_INFO[top.m].name}</strong>：SNR ${tm.snr_improvement > 0 ? "+" : ""}${tm.snr_improvement.toFixed(1)} dB，
    波形相关 ${tm.corr.toFixed(2)}，N400 峰值保留 ${(tm.erp_peak_ratio * 100).toFixed(0)}%，潜伏期偏移 ${tm.erp_latency_shift_ms.toFixed(0)} ms。</p>`;
  html += `<div class="scores">${scores.map((s, i) =>
    `<span class="score-pill ${i === 0 ? "top" : ""}">${METHOD_INFO[s.m].name} ${s.score.toFixed(0)} 分</span>`).join("")}</div>`;
  const warnings = [];
  for (const m of DENOISE_METHODS) {
    const mm = metrics[m];
    if (m !== top.m && mm.snr_improvement > tm.snr_improvement + 1 && mm.corr < tm.corr - 0.05) {
      warnings.push(`${METHOD_INFO[m].name} 的 SNR 提升更高（+${mm.snr_improvement.toFixed(1)} dB），但波形相关只有 ${mm.corr.toFixed(2)}——SNR 高不代表信号留住了。`);
    }
    if (mm.erp_peak_ratio < 0.7) {
      warnings.push(`${METHOD_INFO[m].name} 使 N400 峰值仅剩 ${(mm.erp_peak_ratio * 100).toFixed(0)}%，ERP/语义实验慎用。`);
    }
    if (mm.alpha_ratio < 0.6 || mm.beta_ratio < 0.6) {
      warnings.push(`${METHOD_INFO[m].name} 显著削弱节律功率（α ${mm.alpha_ratio.toFixed(2)}，β ${mm.beta_ratio.toFixed(2)}）。`);
    }
  }
  if (tm.corr < 0.8) {
    warnings.unshift(`当前推荐更侧重 ERP 保真：${METHOD_INFO[top.m].name} 的波形相关仅 ${tm.corr.toFixed(2)}，伪迹仍有残留，请结合波形与下游任务判断。`);
  }
  for (const w of warnings.slice(0, 3)) html += `<p class="warn">⚠ ${w}</p>`;
  html += `<p class="hint">评分权重：波形相关 25%、N400 峰值 25%、潜伏期 15%、SNR 15%、α/β 各 10%。换权重结论可能不同，请结合上方原始指标判断。</p>`;
  box.innerHTML = html;
}

function renderAll() {
  if (!state.data) return;
  renderLegend();
  drawWave();
  drawPsd();
  drawErp();
  renderMetrics();
  renderConclusion();
}

/* ---------- 选型推荐器 ---------- */

function averageMetrics(pred) {
  const acc = {};
  for (const m of DENOISE_METHODS) acc[m] = [];
  for (const cond of state.summary.conditions) {
    if (!pred(cond)) continue;
    for (const m of DENOISE_METHODS) acc[m].push(composite(cond.metrics[m]));
  }
  const out = {};
  for (const m of DENOISE_METHODS) {
    out[m] = acc[m].length ? acc[m].reduce((a, b) => a + b, 0) / acc[m].length : 0;
  }
  return out;
}

function recommend() {
  const channels = Number($("#rec-channels").value);
  const artifact = $("#rec-artifact").value;
  const needErp = $("#rec-erp").value === "yes";
  const pred = artifact === "mixed" ? () => true : (c) => c.artifact === artifact;
  const avg = averageMetrics(pred);
  const notes = [];
  const candidates = DENOISE_METHODS.filter(
    (m) => !(m === "notch" && (artifact === "eog" || artifact === "emg" || artifact === "drift"))
  );
  const ranked = candidates.map((m) => {
    let score = avg[m];
    if (m === "ica" && channels < 16) { score -= 25; notes.push("通道数少于 16 时 ICA 成分不稳定，排名已下调；"); }
    if (m === "asr" && channels < 16) score -= 10;
    if (needErp && (m === "wavelet")) { score -= 10; }
    return { m, score };
  }).sort((a, b) => b.score - a.score);
  const top = ranked[0].m;
  const alt = ranked[1].m;
  if (artifact === "line") notes.push("本基准的带通上限 40 Hz 已覆盖 50 Hz，因此工频场景下带通与陷波几乎等价；若你的流程不做低通，陷波才是必需项，成本最低、可解释性最强；");
  if (artifact === "eog") notes.push("眼电场景要同时看波形与 ERP：ICA 去眼电更强但可能连带削弱 ERP，带通则更保真但残留更多；");
  if (artifact === "mixed") notes.push("混合伪迹建议按本页逐类对比验证，通用方法（ICA/ASR）通常更稳，但要检查 ERP；");
  if (needErp) notes.push("你的实验依赖 ERP，任何方法都请先核对 N400/P300 峰值比与潜伏期再用于正式分析；");
  else notes.push("不看 ERP 时可更侧重 SNR 与节律保留，评分权重可相应调整；");
  state.recResult = { top, alt, artifact, needErp, channels, sfreq: Number($("#rec-sfreq").value) };
  $("#rec-text").innerHTML = `
    <p class="rec-main">推荐 <strong>${METHOD_INFO[top].name}</strong>，备选 <strong>${METHOD_INFO[alt].name}</strong>
    <span class="muted">（依据：${DATASETS[state.dataset].label} 基准中 ${artifact === "mixed" ? "全部场景" : ARTIFACT_NAMES[artifact] + "场景"} 三档 SNR 的平均综合分）</span></p>
    <p class="muted">${notes.join("")}</p>`;
}

function mneScript() {
  const r = state.recResult;
  const chNames = "raw.ch_names";
  const header = `# DenoiseLab 生成 · ${ARTIFACT_NAMES[r.artifact]}场景 · 推荐 ${METHOD_INFO[r.top].name}
# 依赖：mne numpy scipy${r.top === "wavelet" ? " pywavelets" : ""}${r.top === "asr" ? " asrpy" : ""}
import mne
import numpy as np

raw = mne.io.read_raw_edf("your_raw.edf", preload=True)  # 换成你的文件与读取函数
raw.pick_types(eeg=True)
sfreq = raw.info["sfreq"]  # 当前设定 ${r.sfreq} Hz，脚本按文件实际采样率执行

`;
  const body = {
    bandpass: `# 零相位 Butterworth 带通：对漂移/慢波有效，对眼电与肌电能力有限
raw.filter(l_freq=0.5, h_freq=40.0, method="iir",
           iir_params=dict(order=4, ftype="butter"))
`,
    notch: `# 先陷波再带通：工频场景的最小成本方案
raw.notch_filter(freqs=[50, 100], method="iir",
                 iir_params=dict(order=4, ftype="butter"))
raw.filter(l_freq=0.5, h_freq=40.0, method="iir",
           iir_params=dict(order=4, ftype="butter"))
`,
    wavelet: `# db4 小波 6 层通用软阈值：对瞬态伪迹有效，但可能削弱节律与 ERP，务必验证
import pywt

data = raw.get_data()
for ch in range(data.shape[0]):
    coeffs = pywt.wavedec(data[ch], "db4", level=6)
    sigma = np.median(np.abs(coeffs[-1])) / 0.6745
    thr = sigma * np.sqrt(2 * np.log(data.shape[1]))
    coeffs[1:] = [pywt.threshold(c, thr, mode="soft") for c in coeffs[1:]]
    data[ch] = pywt.waverec(coeffs, "db4")[: data.shape[1]]
raw = mne.io.RawArray(data, raw.info)
`,
    ica: `# FastICA + 成分剔除：通道数建议 >=16；下列自动识别仅作起点，请人工核对成分
from mne.preprocessing import ICA

ica = ICA(max_iter=600, random_state=7)
ica.fit(raw)
# 眼电：用额极通道作代理；其他伪迹请改用 ica.plot_sources(raw) 人工选择
try:
    inds, scores = ica.find_bads_eog(raw, ch_name=${chNames}[0])
    ica.exclude = inds
except Exception as exc:
    print("自动识别失败，改为人工检查：", exc)
    ica.plot_sources(raw)
raw = ica.apply(raw)
`,
    asr: `# ASR：通用突发伪迹处理。这里使用 asrpy 的完整实现（pip install asrpy），
# 与 DenoiseLab 网页中的简化演示实现不同，参数请以真实数据校准
from asrpy import ASR

asr = ASR(sfreq=sfreq, cutoff=15)
asr.fit(raw)
raw = asr.transform(raw)
raw.filter(l_freq=0.5, h_freq=40.0, method="iir",
           iir_params=dict(order=4, ftype="butter"))
`,
  };
  const footer = `
# 验证（不要省）：去噪前后各平均一次 ERP，检查峰值比与潜伏期
# epochs = mne.Epochs(raw, events, event_id, tmin=-0.2, tmax=0.8, baseline=(-0.2, 0))
# evoked = epochs.average(); evoked.plot()
raw.save("cleaned_raw.fif", overwrite=True)
`;
  return header + body[r.top] + footer;
}

function methodsParagraph() {
  const r = state.recResult;
  const text = {
    bandpass: `脑电数据经零相位四阶 Butterworth 带通滤波（0.5–40 Hz）以抑制低频漂移与高频肌电成分，随后按实验范式分段并进行基线校正。`,
    notch: `首先采用 IIR 陷波滤波器抑制 50 Hz 及其二次谐波（100 Hz）工频干扰，随后经零相位四阶 Butterworth 带通滤波（0.5–40 Hz），再进行分段与基线校正。`,
    wavelet: `采用 db4 小波对每导联信号进行 6 层分解，细节系数按通用软阈值（阈值由最细层系数的中位数绝对偏差估计）处理后重构，以抑制瞬态伪迹；为确认节律与诱发响应未受损，对去噪前后信号进行了频带功率与 ERP 峰值比对。`,
    ica: `采用快速独立成分分析（FastICA）将多导联信号分解为独立成分，依据成分与额极代理通道的相关性及地形图特征识别并剔除伪迹成分后重构信号；所有成分剔除均经人工核对。`,
    asr: `采用伪迹子空间重构（ASR，cutoff=15）以低活动段为校准参考，对超过阈值的子空间进行衰减重构，随后经 0.5–40 Hz 零相位带通滤波；该方法面向突发性大幅伪迹。`,
  };
  return `【Methods 草稿（请按实际执行修改）】\n\n${text[r.top]}\n\n备选方案：${METHOD_INFO[r.alt].name}。去噪有效性通过以下指标核查：与去噪前相比的信噪比变化、8–13 Hz 与 13–30 Hz 频带功率保留率，以及 N400/P300 峰值幅度与潜伏期偏移。`;
}

function currentReport() {
  const d = state.data;
  const set = DATASETS[state.dataset];
  const lines = [];
  lines.push(`# DenoiseLab 对比报告`);
  lines.push(`\n生成时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push(`\n## 场景\n- 数据源：${set.label}\n- 来源：${d.dataset === "real" ? `${d.source}（${d.license}）` : "参数化合成基准"}\n- 伪迹：${ARTIFACT_NAMES[state.artifact]}\n- 注入 SNR：${state.snr} dB\n- 数据：16 导 250 Hz，40 s，20 次 N400/P100 事件`);
  if (d.background) lines.push(`- 背景处理：${d.background}`);
  lines.push(`\n## 指标（与${set.truth}对比）\n`);
  lines.push(`| 方法 | SNR 提升 dB | 相关 | RRMSE | α 保留 | β 保留 | ERP 峰值比 | 潜伏期偏移 ms |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const m of ["noisy", ...DENOISE_METHODS]) {
    const v = d.metrics[m];
    lines.push(`| ${METHOD_INFO[m].name} | ${v.snr_improvement} | ${v.corr} | ${v.rrmse} | ${v.alpha_ratio} | ${v.beta_ratio} | ${v.erp_peak_ratio} | ${v.erp_latency_shift_ms} |`);
  }
  lines.push(`\n## 结论\n${$("#conclusion-body").innerText}`);
  if (state.recResult) lines.push(`\n## 选型推荐\n${$("#rec-text").innerText}`);
  lines.push(`\n## 边界\n${d.dataset === "real" ? "真实背景仅提供真实 1/f 与节律结构，伪迹与 ERP 仍为注入，真值是构造的；" : "数据为参数化合成，真值由构造过程给出；"}ASR 为简化实现；结论用于理解方法特性，不能直接外推到真实被试数据。复现：${d.dataset === "real" ? "python tools/generate_real_benchmark.py" : "python tools/generate_benchmark.py"}`);
  return lines.join("\n");
}

let currentCode = { text: "", filename: "denoiselab.py" };

function showCode(text, filename) {
  currentCode = { text, filename };
  const pre = $("#rec-code");
  pre.hidden = false;
  pre.textContent = text;
  $("#code-actions").hidden = false;
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function bindRecommender() {
  for (const id of ["#rec-channels", "#rec-sfreq", "#rec-artifact", "#rec-erp"]) {
    $(id).addEventListener("change", recommend);
  }
  $("#btn-script").addEventListener("click", () => showCode(mneScript(), "denoiselab_pipeline.py"));
  $("#btn-methods").addEventListener("click", () => showCode(methodsParagraph(), "methods_draft.md"));
  $("#btn-report").addEventListener("click", () => downloadText(currentReport(), "denoiselab_report.md"));
  $("#btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentCode.text);
      $("#btn-copy").textContent = "已复制";
      setTimeout(() => ($("#btn-copy").textContent = "复制"), 1500);
    } catch {
      downloadText(currentCode.text, currentCode.filename);
    }
  });
  $("#btn-download").addEventListener("click", () => downloadText(currentCode.text, currentCode.filename));
}

async function init() {
  buildChips();
  applyDatasetUI();
  $("#dataset-options").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".dataset-card");
    if (!btn || btn.dataset.value === state.dataset) return;
    loadDataset(btn.dataset.value);
  });
  segmented("#artifact-group", (v) => { state.artifact = v; loadCondition(); });
  segmented("#snr-group", (v) => { state.snr = Number(v); loadCondition(); });
  segmented("#channel-group", (v) => { state.channel = v; drawWave(); });
  bindRecommender();
  window.addEventListener("resize", () => { if (state.data) { drawWave(); drawPsd(); drawErp(); } });
  await loadDataset(state.dataset);
}

init();
