// render/endpoint-starfield.js —— 端点弹层（星空版 / 纸面版）的近 24 小时延迟「星点图」。
//
// 横轴是时间，纵轴是往返耗时（对数刻度：100ms 的日常与 8s 的卡顿同在一张图里都看得清）。
// 每次成功的检测是一颗星，最慢的 5% 换琥珀色；失败画在图底「失败」一道里，是朱砂刻痕。
// 典型耗时是一条「银河」：每档（约 20 分钟）的中位线，带着 25–75 分位的光带；检测断了银河就断开，
// 不会像折线那样一笔拉过没有数据的几个小时。没有检测的时段整块标出「无检测 hh:mm–hh:mm」。
// 最慢的那次和最近一次直接把数写在图上，不用悬停也读得到。
// 纯函数（模型、刻度、几何、SVG、取点）Node 下可直接测；createStarfieldChart 管 DOM、尺寸与悬停。
import { hourTicks, monotonePath, nearestIndex } from "../line-chart.js";
import { escapeHtml } from "../store.js";
import { clockOf, dayKeyOf, monthDay } from "./usage-model.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const STARFIELD_HEIGHT = 262;
const PAD = { l: 58, r: 22, t: 28, b: 56 };
const MIN_WIDTH = 360;
const LANE_GAP = 20; // 失败一道离图底的距离
const LANE_HEIGHT = 8;
const STAR_R = 1.7;
const SLOW_R = 2.2;
const FAIL_SNAP_PX = 12;
const GAP_LABEL_MIN_PX = 120;

const fixed = (v) => v.toFixed(1);

// 对数轴的边界与刻度都落在 1 / 2 / 3 / 5 × 10^n 上。
const STEPS = [1, 2, 3, 5];
function ladder(lo, hi, steps) {
  const out = [];
  for (let p = Math.floor(Math.log10(lo)) - 1; p <= Math.ceil(Math.log10(hi)) + 1; p += 1) {
    for (const s of steps) {
      const v = Number((s * 10 ** p).toPrecision(6));
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

// 纵轴量程与刻度：上下各留一点余量后落到 1-2-3-5 上，至少跨 4 倍；刻度优先 1-3（100ms / 300ms / 1s …），
// 太少换 1-2-5，再少用 1-2-3-5。没有读数（全失败）给 100ms–1s。
export function latencyScale(values) {
  const finite = (values || []).filter((v) => Number.isFinite(v) && v > 0);
  let lo = 100;
  let hi = 1000;
  if (finite.length) {
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const all = ladder(1, 1e7, STEPS);
    lo = [...all].reverse().find((v) => v <= Math.max(1, min / 1.15)) ?? 1;
    hi = all.find((v) => v >= max * 1.15) ?? 1e7;
    while (hi < lo * 4) hi = all.find((v) => v > hi) ?? hi * 2;
  }
  let ticks = ladder(lo, hi, [1, 3]);
  if (ticks.length < 3) ticks = ladder(lo, hi, [1, 2, 5]);
  if (ticks.length < 3) ticks = ladder(lo, hi, STEPS);
  return { lo, hi, ticks };
}

// 47ms / 300ms / 1s / 2.5s：轴标签用，比 formatMs 更短。
export function axisLabel(ms) {
  return ms >= 1000 ? `${Number((ms / 1000).toPrecision(3))}s` : `${Math.round(ms)}ms`;
}

// 失败连成段：相邻两次失败隔得不超过 max(4 分钟, 2.5 个检测间隔) 就算同一段（连续失败画成一条，不是一排刻痕）。
export function failureSpans(failures, intervalMs) {
  const join = Math.max(4 * MIN, 2.5 * (Number(intervalMs) || 0));
  const spans = [];
  for (const f of failures) {
    const last = spans[spans.length - 1];
    if (last && f.ts - last.to <= join) {
      last.to = f.ts;
      last.count += 1;
    } else spans.push({ from: f.ts, to: f.ts, count: 1 });
  }
  return spans;
}

// 银河一档多长：约 20 分钟，检测稀的时候放宽到每档至少能落 6 次，最长 2 小时。
export function bucketSizeOf(intervalMs) {
  const base = 20 * MIN;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return base;
  return Math.min(2 * HOUR, Math.max(base, Math.ceil((intervalMs * 6) / (10 * MIN)) * 10 * MIN));
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];

// trend（endpoint-panel 的 buildEndpointTrend）→ 画图要的一切。没有 trend 返回 null。
export function buildStarfieldModel(trend) {
  if (!trend || !Array.isArray(trend.points)) return null;
  const { t0, t1 } = trend;
  const all = trend.points.filter((p) => p.ts >= t0 && p.ts <= t1).sort((a, b) => a.ts - b.ts);
  const ok = all.filter((p) => p.ok && Number.isFinite(p.value) && p.value > 0);
  const failures = all.filter((p) => !p.ok);
  const scale = latencyScale(ok.map((p) => p.value));
  // 「最慢的 5%」至少要有 20 次成功的检测才分得出来
  const slowAbove = ok.length >= 20 && Number.isFinite(trend.p95) ? trend.p95 : Number.POSITIVE_INFINITY;
  const stars = ok.map((p) => ({ ts: p.ts, value: p.value, slow: p.value > slowAbove }));

  // 银河：按档取 25 / 50 / 75 分位，至少 3 次成功才算一档；相邻档连成一段
  const bucketMs = bucketSizeOf(trend.intervalMs);
  const byBucket = new Map();
  for (const p of ok) {
    const key = Math.floor(p.ts / bucketMs);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(p.value);
  }
  const runs = [];
  let run = null;
  let prevKey = null;
  for (const key of [...byBucket.keys()].sort((a, b) => a - b)) {
    const values = byBucket.get(key).sort((a, b) => a - b);
    if (values.length < 3) {
      run = null;
      prevKey = null;
      continue;
    }
    const center = Math.min(t1, Math.max(t0, (key + 0.5) * bucketMs));
    const cell = { ts: center, p25: quantile(values, 0.25), p50: quantile(values, 0.5), p75: quantile(values, 0.75) };
    if (!run || prevKey !== key - 1) {
      run = [];
      runs.push(run);
    }
    run.push(cell);
    prevKey = key;
  }

  // 无检测的时段：相邻两次检测（含窗口两端）隔得比平时久得多
  const gapMs = Math.max(10 * MIN, 4 * (Number(trend.intervalMs) || 0));
  const gaps = [];
  const edges = [t0, ...all.map((p) => p.ts), t1];
  for (let i = 1; i < edges.length; i += 1) if (edges[i] - edges[i - 1] > gapMs) gaps.push({ from: edges[i - 1], to: edges[i] });

  let slowest = null;
  for (const p of ok) if (!slowest || p.value > slowest.value) slowest = p;
  return {
    t0, t1, ...scale, stars, runs, failures, gaps, bucketMs,
    all,
    slowest,
    latest: all.length ? all[all.length - 1] : null,
    intervalMs: trend.intervalMs,
  };
}

export function starfieldGeometry(model, width) {
  const W = Math.max(MIN_WIDTH, Math.round(width) || MIN_WIDTH);
  const H = STARFIELD_HEIGHT;
  const plotBottom = H - PAD.b;
  const laneY = plotBottom + LANE_GAP;
  const span = Math.max(1, model.t1 - model.t0);
  const logLo = Math.log(model.lo);
  const logSpan = Math.max(1e-9, Math.log(model.hi) - logLo);
  const x = (ts) => PAD.l + ((ts - model.t0) / span) * (W - PAD.l - PAD.r);
  const y = (v) => {
    const clamped = Math.min(model.hi, Math.max(model.lo, v));
    return plotBottom - ((Math.log(clamped) - logLo) / logSpan) * (plotBottom - PAD.t);
  };
  return { W, H, pad: PAD, plotBottom, laneY, laneH: LANE_HEIGHT, x, y };
}

const circle = (cx, cy, r) => `M${fixed(cx - r)},${fixed(cy)}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
// 四角星（与用量趋势图的峰值星同一画法）
const sparkle = (cx, cy, s) => `M${fixed(cx)},${fixed(cy - s)}L${fixed(cx + s * 0.22)},${fixed(cy - s * 0.22)}L${fixed(cx + s)},${fixed(cy)}L${fixed(cx + s * 0.22)},${fixed(cy + s * 0.22)}L${fixed(cx)},${fixed(cy + s)}L${fixed(cx - s * 0.22)},${fixed(cy + s * 0.22)}L${fixed(cx - s)},${fixed(cy)}L${fixed(cx - s * 0.22)},${fixed(cy - s * 0.22)}Z`;
const clock = (ts) => clockOf(Math.floor(ts / 1000));

// 标签放在点的左边；离左边太近就放右边。返回 { x, anchor }。
function labelAt(geo, px) {
  return px - 10 < geo.pad.l + 90 ? { x: px + 10, anchor: "start" } : { x: px - 10, anchor: "end" };
}

export function buildStarfieldSvg(model, width, { formatMs = axisLabel } = {}) {
  const geo = starfieldGeometry(model, width);
  const { W, H, pad, plotBottom, laneY, laneH, x, y } = geo;
  const right = W - pad.r;
  const parts = [];

  // 纵轴刻度（点状网格）与时间刻度
  for (const v of model.ticks) {
    const ty = fixed(y(v));
    parts.push(`<line class="sf-grid" x1="${pad.l}" x2="${right}" y1="${ty}" y2="${ty}"/>`);
    parts.push(`<text class="sf-axis" x="${pad.l - 10}" y="${fixed(y(v) + 3.5)}" text-anchor="end">${axisLabel(v)}</text>`);
  }
  const step = W < 560 ? 6 : W < 820 ? 4 : 3;
  for (const tick of hourTicks(model.t0, model.t1 - 1.2 * HOUR, step)) {
    const tx = fixed(x(tick.t));
    parts.push(`<line class="sf-grid is-v" x1="${tx}" x2="${tx}" y1="${pad.t}" y2="${plotBottom}"/>`);
    parts.push(`<text class="sf-axis${tick.strong ? " is-strong" : ""}" x="${tx}" y="${H - 14}" text-anchor="middle">${tick.label}</text>`);
  }
  parts.push(`<line class="sf-now" x1="${fixed(right)}" x2="${fixed(right)}" y1="${pad.t - 6}" y2="${laneY + laneH + 4}"/>`);
  parts.push(`<text class="sf-axis is-now" x="${fixed(right)}" y="${H - 14}" text-anchor="end">现在</text>`);

  // 失败一道
  parts.push(`<rect class="sf-lane" x="${pad.l}" y="${laneY}" width="${fixed(right - pad.l)}" height="${laneH}" rx="${laneH / 2}"/>`);
  parts.push(`<text class="sf-axis" x="${pad.l - 10}" y="${laneY + laneH - 0.5}" text-anchor="end">失败</text>`);

  // 无检测的时段（盖住图与失败一道）
  for (const gap of model.gaps) {
    const x0 = x(gap.from) + 3;
    const x1 = x(gap.to) - 3;
    if (x1 - x0 < 2) continue;
    // 很窄的缝不描边：两条虚线挨在一起像网格
    parts.push(`<rect class="sf-gap${x1 - x0 < 16 ? " is-narrow" : ""}" x="${fixed(x0)}" y="${pad.t}" width="${fixed(x1 - x0)}" height="${laneY + laneH - pad.t}" rx="${x1 - x0 < 16 ? 2 : 6}"/>`);
    if (x1 - x0 >= GAP_LABEL_MIN_PX) {
      parts.push(`<text class="sf-gap-label" x="${fixed((x0 + x1) / 2)}" y="${fixed((pad.t + plotBottom) / 2 + 4)}" text-anchor="middle">无检测 ${clock(gap.from)}–${gap.to >= model.t1 ? "现在" : clock(gap.to)}</text>`);
    }
  }

  // 银河：25–75 分位光带 + 中位线
  for (const run of model.runs) {
    if (run.length === 1) {
      const [c] = run;
      const half = Math.max(3, (x(c.ts + model.bucketMs / 2) - x(c.ts - model.bucketMs / 2)) / 2);
      parts.push(`<path class="sf-median" d="M${fixed(x(c.ts) - half)},${fixed(y(c.p50))}H${fixed(x(c.ts) + half)}"/>`);
      continue;
    }
    const upper = monotonePath(run.map((c) => [x(c.ts), y(c.p75)]));
    const lower = monotonePath([...run].reverse().map((c) => [x(c.ts), y(c.p25)])).replace(/^M/, "L");
    parts.push(`<path class="sf-band" d="${upper}${lower}Z"/>`);
    parts.push(`<path class="sf-median" d="${monotonePath(run.map((c) => [x(c.ts), y(c.p50)]))}"/>`);
  }

  // 星点：普通 / 最慢 5% 各一条路径（几百次检测也只有两个元素）
  let calm = "";
  let slow = "";
  for (const s of model.stars) {
    if (s.slow) slow += circle(x(s.ts), y(s.value), SLOW_R);
    else calm += circle(x(s.ts), y(s.value), STAR_R);
  }
  if (calm) parts.push(`<path class="sf-star" d="${calm}"/>`);
  if (slow) parts.push(`<path class="sf-star is-slow" d="${slow}"/>`);
  for (const span of failureSpans(model.failures, model.intervalMs)) {
    const x0 = x(span.from) - 1.2;
    const w = Math.max(2.4, x(span.to) - x(span.from) + 2.4);
    parts.push(`<rect class="sf-fail" x="${fixed(x0)}" y="${laneY - 1}" width="${fixed(w)}" height="${laneH + 2}" rx="1.2"/>`);
  }

  // 直接写在图上的两个数：最慢那次、最近一次
  const latest = model.latest;
  const slowest = model.slowest;
  let latestBox = null;
  if (latest) {
    const lx = x(latest.ts);
    const ly = latest.ok && latest.value > 0 ? y(latest.value) : laneY + laneH / 2;
    const at = labelAt(geo, lx);
    const same = slowest && slowest.ts === latest.ts;
    const text = latest.ok
      ? `最近 ${formatMs(latest.value)}${same ? "（最慢）" : ""}`
      : "最近一次失败";
    const ty = latest.ok ? Math.max(pad.t + 4, ly - 9) : laneY - 6;
    parts.push(`<path class="sf-latest${latest.ok ? "" : " is-fail"}" d="${sparkle(lx, ly, 6.5)}"/>`);
    parts.push(`<text class="sf-note is-latest${latest.ok ? "" : " is-fail"}" x="${fixed(at.x)}" y="${fixed(ty)}" text-anchor="${at.anchor}">${escapeHtml(text)}</text>`);
    latestBox = { x: at.x, y: ty, anchor: at.anchor };
  }
  if (slowest && !(latest && slowest.ts === latest.ts)) {
    const sx = x(slowest.ts);
    const sy = y(slowest.value);
    const at = labelAt(geo, sx);
    const ty = Math.max(pad.t - 8, sy - 8);
    const clash = latestBox && Math.abs(latestBox.y - ty) < 14 && Math.abs(latestBox.x - at.x) < 110;
    parts.push(`<circle class="sf-ring" cx="${fixed(sx)}" cy="${fixed(sy)}" r="4.5"/>`);
    if (!clash) parts.push(`<text class="sf-note" x="${fixed(at.x)}" y="${fixed(ty)}" text-anchor="${at.anchor}">最慢 ${escapeHtml(formatMs(slowest.value))}</text>`);
  }

  // 悬停：竖线 + 高亮点 + 接指针的透明层
  parts.push(`<line class="sf-cross" x1="0" x2="0" y1="${pad.t}" y2="${laneY + laneH}" visibility="hidden"/>`);
  parts.push('<circle class="sf-dot" r="3.6" visibility="hidden"/>');
  parts.push(`<rect class="sf-hit" x="${pad.l}" y="${pad.t - 8}" width="${fixed(right - pad.l)}" height="${laneY + laneH + 8 - (pad.t - 8)}"/>`);
  return { markup: parts.join(""), geo };
}

// 指针 → 哪次检测。落在失败一道上时吸到最近的失败刻痕；否则取横向最近的一次检测，
// 离得比 max(6 分钟, 3 个检测间隔) 还远（落在无检测的时段里）就不算。
export function pickStar(model, geo, px, py) {
  if (!model?.all?.length) return null;
  const span = geo.W - geo.pad.l - geo.pad.r;
  const t = model.t0 + ((px - geo.pad.l) / span) * (model.t1 - model.t0);
  if (py >= geo.laneY - 4 && model.failures.length) {
    const fails = model.failures;
    const hit = fails[nearestIndex(fails.map((f) => f.ts), t)];
    if (Math.abs(geo.x(hit.ts) - px) <= FAIL_SNAP_PX) return hit;
  }
  const hit = model.all[nearestIndex(model.all.map((p) => p.ts), t)];
  const reach = Math.max(6 * MIN, 3 * (Number(model.intervalMs) || 0));
  return Math.abs(hit.ts - t) <= reach ? hit : null;
}

// 悬停提示：{ title, rows: [{ label, value, tone? }] }。
export function starTip(point, metricName, formatMs) {
  const sec = Math.floor(point.ts / 1000);
  const title = `${monthDay(dayKeyOf(sec))} ${clockOf(sec, { seconds: true })}`;
  if (!point.ok) return { title, rows: [{ tone: "fail", label: "检测失败", value: Number.isFinite(point.value) ? `等了 ${formatMs(point.value)}` : "" }] };
  return { title, rows: [{ label: metricName, value: formatMs(point.value) }] };
}

export function createStarfieldChart(host) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  let opts = null;
  let geo = null;
  let drawnWidth = 0;
  let frame = 0;
  let pending = null;

  host.classList.add("sf");
  host.innerHTML = '<svg class="sf-svg" role="img"></svg><div class="lc-tip sf-tip" hidden></div>';
  const svg = host.firstElementChild;
  const tip = host.lastElementChild;

  function draw() {
    if (!opts?.model) return false;
    const measured = Math.round(host.clientWidth);
    if (!measured) return false;
    const built = buildStarfieldSvg(opts.model, measured, { formatMs: opts.formatMs });
    geo = built.geo;
    drawnWidth = measured;
    svg.setAttribute("viewBox", `0 0 ${geo.W} ${geo.H}`);
    svg.setAttribute("height", String(geo.H));
    svg.setAttribute("aria-label", opts.label || "");
    svg.innerHTML = built.markup;
    tip.hidden = true;
    return true;
  }

  function clear() {
    tip.hidden = true;
    svg.querySelector(".sf-dot")?.setAttribute("visibility", "hidden");
    svg.querySelector(".sf-cross")?.setAttribute("visibility", "hidden");
  }

  function showTip(point) {
    if (!point) {
      clear();
      return;
    }
    const cx = geo.x(point.ts);
    const cy = point.ok ? geo.y(point.value) : geo.laneY + geo.laneH / 2;
    const dot = svg.querySelector(".sf-dot");
    const cross = svg.querySelector(".sf-cross");
    dot.setAttribute("cx", fixed(cx));
    dot.setAttribute("cy", fixed(cy));
    dot.classList.toggle("is-fail", !point.ok);
    dot.setAttribute("visibility", "visible");
    cross.setAttribute("x1", fixed(cx));
    cross.setAttribute("x2", fixed(cx));
    cross.setAttribute("visibility", "visible");
    const content = starTip(point, opts.metricName || "延迟", opts.formatMs || axisLabel);
    tip.textContent = "";
    const title = doc.createElement("strong");
    title.textContent = content.title;
    tip.append(title);
    for (const row of content.rows) {
      const p = doc.createElement("p");
      if (row.tone) p.dataset.tone = row.tone;
      const label = doc.createElement("span");
      label.textContent = row.label;
      const value = doc.createElement("span");
      value.textContent = row.value;
      p.append(label, value);
      tip.append(p);
    }
    tip.hidden = false;
    const width = host.clientWidth || geo.W;
    const scale = width / geo.W;
    const left = cx * scale;
    const flip = left > width - tip.offsetWidth - 24;
    tip.style.left = `${Math.max(0, flip ? left - tip.offsetWidth - 14 : left + 14)}px`;
    tip.style.top = `${Math.max(0, cy * scale - tip.offsetHeight - 12)}px`;
  }

  function onMove(event) {
    if (!geo || !event.target.closest?.(".sf-hit")) {
      onLeave();
      return;
    }
    pending = { x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (!pending || !geo) return;
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const px = ((pending.x - box.left) / box.width) * geo.W;
      const py = ((pending.y - box.top) / box.height) * geo.H;
      pending = null;
      showTip(pickStar(opts.model, geo, px, py));
    });
  }

  function onLeave() {
    pending = null;
    clear();
  }

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  let observer = null;
  if (typeof win?.ResizeObserver === "function") {
    observer = new win.ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1].contentRect.width);
      if (width > 0 && width !== drawnWidth) draw();
    });
    observer.observe(host);
  }

  function update(options) {
    opts = options;
    return draw();
  }

  function destroy() {
    observer?.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    svg.removeEventListener("pointermove", onMove);
    svg.removeEventListener("pointerleave", onLeave);
    host.classList.remove("sf");
    host.textContent = "";
  }

  return { update, clear, destroy };
}
