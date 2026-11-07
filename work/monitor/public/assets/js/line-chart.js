// line-chart.js —— 通用折线图：取整刻度、单调插值、十字线 + 提示框。
// 用量页「分开」小图与端点延迟图共用；资源趋势（charts.js）是另一套就地更新的 sparkline，不走这里。
//
// 约定：线 2px 圆头，面积只铺一层很淡的同色，网格 / 基线是实线细线；颜色全部走 CSS
// （charts.css 的 data-tone），主题切换不用重画。纯函数部分（取整上限 / 刻度 / 路径 / 最近点）
// 不碰 DOM，Node 下可直接测；createLineChart 负责画、悬停与随宽度重画。
import { TZ_OFFSET_SEC } from "./render/usage-model.js";
import { escapeHtml } from "./store.js";

// 向上取整到 1 / 2 / 2.5 / 5 / 10 × 10^n：纵轴上限落在好读的数上。非正数与非法值给 1。
export function niceCeil(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(v));
  const fraction = v / power;
  // 留一点容差：0.3 / 0.1 这类除法会得到 2.9999999999999996
  const step = [1, 2, 2.5, 5, 10].find((m) => fraction <= m * (1 + 1e-9)) ?? 10;
  return Number((step * power).toPrecision(12));
}

// 0 … max 均分 count 段的刻度值（含两端）。
export function linearTicks(max, count = 4) {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n + 1 }, (_, i) => Number(((max / n) * i).toPrecision(12)));
}

const fixed = (v) => v.toFixed(1);

// 折线路径：points = [[x, y], …]（SVG 坐标）。
export function linePath(points) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${fixed(x)},${fixed(y)}`).join("");
}

// 单调三次插值（Fritsch–Carlson）：曲线圆滑但不越过相邻数据点（不会画出低于 0 的弧）。
// 返回每段的三次贝塞尔命令，segments[i] 连接 i → i+1。
export function monotoneSegments(points) {
  const n = points.length;
  if (n < 2) return [];
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push(dx[i] === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); tangent[i] = t * a * slope[i]; tangent[i + 1] = t * b * slope[i]; }
  }
  return Array.from({ length: n - 1 }, (_, i) => {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const d = dx[i] / 3;
    return `C${fixed(x0 + d)},${fixed(y0 + tangent[i] * d)} ${fixed(x1 - d)},${fixed(y1 - tangent[i + 1] * d)} ${fixed(x1)},${fixed(y1)}`;
  });
}

// 单调插值的整条路径（不足两个点时只有起点）。
export function monotonePath(points) {
  if (!points.length) return "";
  return `M${fixed(points[0][0])},${fixed(points[0][1])}${monotoneSegments(points).join("")}`;
}

// 升序数组里离 target 最近的下标（并列取靠前的）；空数组返回 -1。
export function nearestIndex(xs, target) {
  const n = xs?.length ?? 0;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && target - xs[lo - 1] <= xs[lo] - target ? lo - 1 : lo;
}

// 时间轴的整点刻度：每 stepHours 小时一格，0 点单独标出（strong）。界面上的时刻一律按北京时间
// （UTC+8，无夏令时；偏移量取 usage-model.js 那一份），offsetMs 留给测试与别的时区口径。
export function hourTicks(t0, t1, stepHours, offsetMs = TZ_OFFSET_SEC * 1000) {
  const step = Math.max(1, stepHours) * 3600_000;
  const ticks = [];
  for (let t = Math.ceil((t0 + offsetMs) / step) * step - offsetMs; t <= t1; t += step) {
    const hour = new Date(t + offsetMs).getUTCHours();
    ticks.push({ t, label: hour === 0 ? "0 点" : `${String(hour).padStart(2, "0")}:00`, strong: hour === 0 });
  }
  return ticks;
}

const DEFAULT_PAD = { l: 44, r: 14, t: 10, b: 22 };
const MIN_WIDTH = 240;
const toneAttr = (tone) => (tone ? ` data-tone="${escapeHtml(tone)}"` : "");

// 一张图的 SVG 内容（纯函数，Node 可测）：返回 { markup, ctx }，ctx = { W, H, pad, x, y } 是坐标系。
// options 见 createLineChart；width 是容器实测宽度。标签类文本全部转义。
export function buildChartSvg(options, width) {
  const W = Math.max(MIN_WIDTH, Math.round(width));
  const H = options.height;
  const pad = { ...DEFAULT_PAD, ...(options.pad || {}) };
  const [x0, x1] = options.x;
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (t) => pad.l + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * plotW;
  const y = (v) => H - pad.b - Math.max(0, Math.min(1, v / options.yMax)) * plotH;
  const ctx = { W, H, pad, x, y };
  let s = "";
  for (const v of options.yTicks || []) {
    const gy = Math.round(y(v)) + 0.5; // 落在半像素上，1px 的线才不发虚
    s += `<line class="lc-grid${v === 0 ? " is-base" : ""}" x1="${pad.l}" x2="${W - pad.r}" y1="${gy}" y2="${gy}"/>`;
    s += `<text class="lc-axis" x="${pad.l - 7}" y="${gy + 3}" text-anchor="end">${escapeHtml(options.yFormat ? options.yFormat(v) : v)}</text>`;
  }
  for (const tick of options.xTicks || []) {
    const px = x(tick.t);
    if (px < pad.l - 1 || px > W - pad.r + 1) continue;
    const anchor = tick.anchor === "end" || tick.anchor === "start" ? tick.anchor : "middle";
    s += `<text class="lc-axis${tick.strong ? " is-strong" : ""}" x="${fixed(px)}" y="${H - 6}" text-anchor="${anchor}">${escapeHtml(tick.label)}</text>`;
    if (tick.strong) s += `<line class="lc-rule" x1="${fixed(px)}" x2="${fixed(px)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
  }
  for (const series of options.series || []) {
    const pts = series.points.map(([t, v]) => [x(t), y(v)]);
    if (!pts.length) continue;
    const tone = toneAttr(series.tone);
    const thin = series.thin ? " is-thin" : "";
    const last = pts[pts.length - 1];
    if (pts.length > 1) {
      const toPath = series.smooth ? monotonePath : linePath;
      const dashFrom = Number.isInteger(series.dashFrom) && series.dashFrom >= 0 && series.dashFrom < pts.length - 1 ? series.dashFrom : null;
      if (series.area !== false) s += `<path class="lc-area"${tone} d="${toPath(pts)}L${fixed(last[0])},${fixed(y(0))}L${fixed(pts[0][0])},${fixed(y(0))}Z"/>`;
      const solid = dashFrom == null ? pts : pts.slice(0, dashFrom + 1);
      if (solid.length > 1) s += `<path class="lc-line${thin}"${tone} d="${toPath(solid)}"/>`;
      if (dashFrom != null) s += `<path class="lc-line is-partial${thin}"${tone} d="${linePath(pts.slice(dashFrom))}"/>`;
    }
    if (series.endDot !== false) s += `<circle class="lc-end"${tone} cx="${fixed(last[0])}" cy="${fixed(last[1])}" r="${pts.length > 1 ? 3.5 : 4}"/>`;
  }
  if (options.extra) s += options.extra(ctx);
  s += `<line class="lc-cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/><g class="lc-dots"></g>`;
  if (options.hover) s += `<rect class="lc-hit${options.hover.onPick ? " is-pickable" : ""}" x="${pad.l}" y="0" width="${Math.max(1, plotW)}" height="${H}"/>`;
  return { markup: s, ctx };
}

// 通用折线图。host 是定位容器（宽度由布局决定，高度由 options.height 定）。options：
//   label    无障碍标签
//   height   像素高；pad { l, r, t, b }
//   x        [x0, x1] 横轴取值范围（时间戳或序号都行）
//   yMax     纵轴上限（超出的点压在上沿，调用方自己决定是否另画标记）
//   yTicks   刻度值数组；yFormat(v) → 刻度文字
//   xTicks   [{ t, label, strong, anchor }]，strong 的那格加粗并画一条竖线
//   series   [{ tone, points: [[t, v], …], smooth, area, thin, dashFrom, endDot }]
//            dashFrom：从第几个点起画成虚线（还没过完的一档）；area / endDot 默认开
//   extra    (ctx) → 追加的 SVG 片段（调用方保证里面没有不可信文本）
//   hover    { xs: 升序的横轴取值,
//              tip(i) → { title, rows: [{ label, value, swatch, tone }] }（全部按文本写入）,
//              dots(i) → [{ tone, v }],
//              resolve({ t, px, py, ctx }) → 下标（可选，覆盖「最近的点」）,
//              onIndex(i | null) 悬停位置变化（给并排的图同步十字线）,
//              onPick(i) 点击 }
//   tipTop   提示框距容器顶部的像素
// 返回 { update(options), redraw(), mark(i), clear(), showTip(i), destroy() }：
//   mark / clear 只动十字线与高亮点、不弹提示框；容器宽度变化或从隐藏变可见时自动重画。
export function createLineChart(host, initialOptions = null) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  let opts = null;
  let ctx = null; // 最近一次画出来的坐标系 { W, H, pad, x, y }
  let active = null; // 十字线所在的下标
  let tipIndex = null; // 提示框当前显示的下标
  let drawnWidth = 0;
  let frame = 0;
  let pending = null;

  host.classList.add("lc");
  host.innerHTML = '<svg class="lc-svg" role="img"></svg><div class="lc-tip" hidden></div>';
  const svg = host.firstElementChild;
  const tip = host.lastElementChild;

  function draw() {
    if (!opts) return false;
    const measured = Math.round(host.clientWidth);
    if (!measured) return false; // 隐藏中：等变可见时由 ResizeObserver 补画
    const built = buildChartSvg(opts, measured);
    ctx = built.ctx;
    drawnWidth = measured;
    svg.setAttribute("viewBox", `0 0 ${ctx.W} ${ctx.H}`);
    svg.setAttribute("height", String(ctx.H));
    svg.setAttribute("aria-label", opts.label || "");
    svg.innerHTML = built.markup;
    // 重画后十字线回到原位（轮询刷新时悬停不闪）；数据变短导致下标越界就收起
    const keep = active;
    const keepTip = tipIndex != null;
    active = null;
    tipIndex = null;
    if (keep != null && keep < (opts.hover?.xs.length ?? 0)) showAt(keep, keepTip);
    else tip.hidden = true;
    return true;
  }

  function fillTip(index) {
    const content = opts.hover.tip?.(index);
    if (!content) return false;
    tip.textContent = "";
    const title = doc.createElement("strong");
    title.textContent = content.title ?? "";
    tip.append(title);
    for (const row of content.rows || []) {
      const p = doc.createElement("p");
      if (row.tone) p.dataset.tone = row.tone;
      const label = doc.createElement("span");
      if (row.swatch) {
        const key = doc.createElement("i");
        key.className = "lc-key";
        key.dataset.tone = row.swatch;
        label.append(key);
      }
      label.append(String(row.label ?? ""));
      const value = doc.createElement("span");
      value.textContent = row.value ?? "";
      p.append(label, value);
      tip.append(p);
    }
    return true;
  }

  // 在第 index 个位置画十字线与高亮点；withTip 时同时显示提示框。
  function showAt(index, withTip) {
    const hover = opts?.hover;
    if (!hover || !ctx || !Number.isInteger(index) || index < 0 || index >= hover.xs.length) return;
    const cx = ctx.x(hover.xs[index]);
    if (active !== index) {
      active = index;
      const cross = svg.querySelector(".lc-cross");
      cross.setAttribute("x1", fixed(cx));
      cross.setAttribute("x2", fixed(cx));
      cross.setAttribute("visibility", "visible");
      svg.querySelector(".lc-dots").innerHTML = (hover.dots?.(index) || [])
        .filter((dot) => Number.isFinite(dot?.v))
        .map((dot) => `<circle class="lc-hover-dot"${toneAttr(dot.tone)} cx="${fixed(cx)}" cy="${fixed(ctx.y(dot.v))}" r="4"/>`)
        .join("");
    }
    if (!withTip) return;
    if (tipIndex !== index) {
      if (!fillTip(index)) {
        tip.hidden = true;
        tipIndex = null;
        return;
      }
      tipIndex = index;
    }
    tip.hidden = false;
    const width = host.clientWidth || ctx.W;
    const left = (cx / ctx.W) * width;
    const flip = left > width - tip.offsetWidth - 24;
    tip.style.left = `${Math.max(0, flip ? left - tip.offsetWidth - 12 : left + 12)}px`;
    tip.style.top = `${opts.tipTop ?? 6}px`;
  }

  function clear() {
    active = null;
    tipIndex = null;
    tip.hidden = true;
    svg.querySelector(".lc-cross")?.setAttribute("visibility", "hidden");
    const dots = svg.querySelector(".lc-dots");
    if (dots) dots.innerHTML = "";
  }

  function indexAt(clientX, clientY) {
    const hover = opts?.hover;
    if (!hover?.xs.length || !ctx) return -1;
    const box = svg.getBoundingClientRect();
    if (!box.width) return -1;
    const px = ((clientX - box.left) / box.width) * ctx.W;
    const py = ((clientY - box.top) / box.height) * ctx.H;
    const [x0, x1] = opts.x;
    const t = x0 + ((px - ctx.pad.l) / Math.max(1, ctx.W - ctx.pad.l - ctx.pad.r)) * (x1 - x0);
    const custom = hover.resolve?.({ t, px, py, ctx });
    return Number.isInteger(custom) ? custom : nearestIndex(hover.xs, t);
  }

  // pointermove 是 60~120Hz：每帧最多处理一次。
  function onMove(event) {
    if (!opts?.hover) return;
    if (!event.target.closest?.(".lc-hit")) {
      onLeave();
      return;
    }
    pending = { x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const index = indexAt(pending.x, pending.y);
      pending = null;
      if (index < 0) return;
      const changed = index !== active;
      showAt(index, true);
      if (changed) opts.hover.onIndex?.(index);
    });
  }

  function onLeave() {
    pending = null;
    if (active == null && tip.hidden) return;
    clear();
    opts?.hover?.onIndex?.(null);
  }

  function onClick(event) {
    if (!opts?.hover?.onPick || !event.target.closest?.(".lc-hit")) return;
    const index = indexAt(event.clientX, event.clientY);
    if (index >= 0) opts.hover.onPick(index);
  }

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);
  svg.addEventListener("click", onClick);

  let observer = null;
  if (typeof win?.ResizeObserver === "function") {
    observer = new win.ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1].contentRect.width);
      // 宽度没变不重画；从隐藏变可见（0 → 有宽度）走的也是这条
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
    svg.removeEventListener("click", onClick);
    host.classList.remove("lc");
    host.textContent = "";
  }

  if (initialOptions) update(initialOptions);
  return { update, redraw: draw, mark: (index) => showAt(index, false), clear, showTip: (index) => showAt(index, true), destroy };
}
