import { autoBadgeHtml, escapeHtml } from "../store.js";
import { explainDoctorAdvice } from "../doctor-advisories.js";
import { getTimeline, getHistoryDays, getHistoryDay, getJson, postJson } from "../api.js";
import { createElementLookup, morphInnerHtml } from "../dom-utils.js";
import {
  buildSwimModel, createViewResolver, LAYER_LABELS, layerOfKey, LEVEL_LABELS, objectLabel, reasonLabel, SWIM_ENTRY_TYPES, swimHtml,
} from "./timeline-swim.js";
import { episodeHtml, episodesBarText, episodeStripHtml, groupEpisodes } from "./timeline-episodes.js";
import { SELF_UPDATE_CHANGED_EVENT } from "./update-banner.js";
import { clockOf, offsetDay } from "./usage-model.js";

// DOM 引用惰性获取（dom-utils.createElementLookup：无 document 时返回 null，纯函数可在 Node 测试中导入）
const getEl = createElementLookup();

export function formatDoctorOutput(text) {
  if (!text || text === "-") return "-";
  return text
    .split("\n")
    .map((line) => {
      // 标记优先：codex doctor 真实输出用 [!!]=警告、[xx]=失败、[up]=更新提示、[ok]=通过。
      // 此前只认 [fail]/[warn] 字面量，导致真正的警告行（[!!] threads ...）从未被高亮，
      // 用户"点开也看不到具体警告内容"。带方括号标记的行按标记分类；无标记的行才走
      // 宽松词匹配兜底（并排除 "0 fail" 这类计数行的误染色）。
      let type = "";
      if (/\[(xx|fail)\]/i.test(line)) {
        type = "fail";
      } else if (/\[(!!|warn)\]/i.test(line)) {
        const match = line.match(/^\s*\[(?:!!|warn)\]\s+(\S+)\s+(.*?)\s*$/i);
        type = match && explainDoctorAdvice({ name: match[1], text: match[2] }).maintenance ? "info" : "warn";
      } else if (/\[(ok|up)\]/i.test(line)) {
        type = "ok";
      } else if (!/\[[^\]]{1,8}\]/.test(line)) {
        if (/\b(fail|failed)\b/i.test(line) && !/\b0\s+fail\b/i.test(line)) type = "fail";
        else if (/\b(warn|warning)\b/i.test(line) && !/\b0\s+warn\b/i.test(line)) type = "warn";
        else if (/\bok\b/i.test(line)) type = "ok";
      }
      return `<span class="doc-line ${type}">${escapeHtml(line)}</span>`;
    })
    .join("");
}

// ---- 状态变更时间线 ----
// 泳道图的还原、以及级别 / 层 / 对象 / 原因的界面用名在 timeline-swim.js（纯函数）；这里负责取数与写 DOM。
const SIGNAL_CATEGORY_LABELS = { account: "账号", request: "请求", gateway: "网关", connect: "代理连接", sampling: "采样" };
const DAY_MS = 24 * 3600_000;
// 复盘某一天要的条目：迁移 + 基线 + 信号（逐分钟的采样用不上）
const HISTORY_ENTRY_TYPES = `${SWIM_ENTRY_TYPES},signal`;
// 最近一次渲染拿到的 /api/status：取界面用名（服务器短名、Agent 显示名）与当前查看的服务器。
let latestStatus = null;
// 可复盘的日期（日期下拉刷新时记下），读相邻日文件前先看有没有
let knownDays = [];

// ---- v2.16 历史复盘（按天回放 + 统计摘要）----
// 纯函数（normalize/summarize/format/row-html）供 history-view.test.mjs 在 Node 下直测。

// 历史迁移条目归一化：优先取结构化字段（history-store 落盘的 transition 原样携带
// key/from/to/reason/layer）；兼容仅有消息体的旧条目（"channel: ok -> error reason=..."）。
export function normalizeHistoryTransition(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.key === "string" && entry.from != null && entry.to != null) {
    return {
      ts: entry.ts,
      key: entry.key,
      from: String(entry.from),
      to: String(entry.to),
      reason: entry.reason || "",
      layer: entry.layer || layerOfKey(entry.key),
    };
  }
  const m = /^([^:\s]+):\s*(\S+)\s*->\s*(\S+)/.exec(String(entry.message || ""));
  if (!m) return null;
  const reasonMatch = /\breason=(.*)$/.exec(String(entry.message));
  return {
    ts: entry.ts,
    key: m[1],
    from: m[2],
    to: m[3],
    reason: entry.reason || (reasonMatch ? reasonMatch[1] : ""),
    layer: entry.layer || layerOfKey(m[1]),
  };
}

// 按天聚合复盘统计：断开次数（通道进入 error 的故障段数——error→warn→error 属同一段）、
// 最长恢复耗时（进入 error 到回到 ok），以及卡顿信号条数（history 只落 warn/error 信号）。
export function summarizeHistoryEntries(entries = []) {
  const sorted = entries.slice().sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
  let disconnects = 0;
  let maxRecoveryMs = null;
  let signals = 0;
  let downSince = null;
  for (const raw of sorted) {
    if (raw && raw.type === "signal") {
      if (raw.severity !== "info") signals += 1;
      continue;
    }
    // 采样与状态基线（levels）不是迁移，不参与断开 / 恢复统计
    if (raw && (raw.type === "sample" || raw.type === "levels")) continue;
    const t = normalizeHistoryTransition(raw);
    if (t?.key !== "channel") continue;
    if (t.to === "error") {
      if (downSince == null) {
        disconnects += 1;
        downSince = t.ts;
      }
    } else if (t.to === "ok" && downSince != null) {
      const recoveryMs = t.ts - downSince;
      if (maxRecoveryMs == null || recoveryMs > maxRecoveryMs) maxRecoveryMs = recoveryMs;
      downSince = null;
    }
  }
  return { disconnects, maxRecoveryMs, signals, unrecovered: downSince != null };
}

// 摘要一行文案："N 次断开 · 最长恢复 X 分钟 · 卡顿信号 M 次"。
// 无已恢复故障段时省略中段；当日收尾仍未恢复则明示。分钟一位小数（<0.1 归 0.1）。
export function formatHistorySummary({ disconnects = 0, maxRecoveryMs = null, signals = 0, unrecovered = false } = {}) {
  const parts = [`${disconnects} 次断开`];
  if (maxRecoveryMs != null) {
    const minutes = Math.max(0.1, Math.round(maxRecoveryMs / 6000) / 10);
    parts.push(`最长恢复 ${minutes} 分钟`);
  }
  if (unrecovered) parts.push("当日未恢复");
  parts.push(`卡顿信号 ${signals} 次`);
  return parts.join(" · ");
}

// 复盘视图单行 HTML（复用实时时间线的样式类；时间显示当日绝对时刻而非相对时间，
// 按北京时间的 24 小时制，与本机时区、系统区域无关——与泳道的时间轴同一口径）。
// v2.18：自动修复策略触发的条目（trigger:"auto" / event:"auto-repair"）前缀「自动」
// 徽标——徽标取自**原始条目**，normalizeHistoryTransition 的输出形状不变（其结果被
// 既有测试逐字断言）。
// context：{ status, viewAt }——取界面用名；viewAt(ts) 给出那一刻查看的是哪台服务器（channel 行用）。
// 状态基线（levels）等不是迁移也不是信号的条目返回空串。
export function buildHistoryRowHtml(entry, context = {}) {
  const ts = Number(entry?.ts);
  const time = entry?.ts != null && Number.isFinite(ts) ? clockOf(ts / 1000, { seconds: true }) : "--:--:--";
  const badge = autoBadgeHtml(entry);
  if (entry && entry.type === "signal") {
    const dot = entry.severity === "error" ? "error" : "warn";
    const category = entry.category || entry.signalId || "signal";
    return `<li class="timeline-item">
      <span class="timeline-dot state-${dot}"></span>
      ${badge}
      <span class="timeline-layer">信号</span>
      <span class="timeline-key" title="${escapeHtml(category)}">${escapeHtml(SIGNAL_CATEGORY_LABELS[category] || category)}</span>
      <span class="timeline-transition">${escapeHtml(entry.title || "")}</span>
      <span class="timeline-time">${escapeHtml(time)}</span>
    </li>`;
  }
  const t = normalizeHistoryTransition(entry);
  if (!t) return "";
  return `<li class="timeline-item">${transitionRowBodyHtml(t, badge, `<span class="timeline-time">${escapeHtml(time)}</span>`, context)}</li>`;
}

// 状态迁移行正文（实时时间线与历史复盘共用）。时间片段由调用方给：实时是带 data-ts 的
// 相对时间（每轮原地刷新），复盘是当日绝对时刻；badge 取自原始条目。
// 层名、对象名、原因都换成界面用语；内部键与原因原文留在 title 里，排查时还能对上日志。
function transitionRowBodyHtml(t, badge, timeHtml, { status = null, viewAt = null } = {}) {
  const object = objectLabel(t.key, { status, view: viewAt ? viewAt(t.ts) : "" });
  const reason = reasonLabel(t.reason);
  return `
    <span class="timeline-dot state-${escapeHtml(t.to)}"></span>
    ${badge}
    <span class="timeline-layer">${escapeHtml(LAYER_LABELS[t.layer] || t.layer)}</span>
    ${object ? `<span class="timeline-key" title="${escapeHtml(t.key)}">${escapeHtml(object)}</span>` : ""}
    <span class="timeline-transition">${escapeHtml(LEVEL_LABELS[t.from] || t.from)} → ${escapeHtml(LEVEL_LABELS[t.to] || t.to)}</span>
    ${timeHtml}
    ${reason ? `<span class="timeline-reason" title="${escapeHtml(t.reason)}">${escapeHtml(reason)}</span>` : ""}
  `;
}

// ---- 泳道图：清单上方，一行一个对象 ----
function renderSwim(entries, options) {
  const el = getEl("timelineSwim");
  if (!el) return;
  morphInnerHtml(el, swimHtml(buildSwimModel(entries, { status: latestStatus, ...options })));
  el.hidden = false;
}

// 实时模式（近 24 小时）的泳道数据：最近两天的历史文件，只取迁移与基线两类条目。
// 浮层开着时最多每分钟重拉一次；清单里冒出新的变更时立刻重拉。
const SWIM_REFRESH_MS = 60_000;
const liveSwim = { entries: null, viewAt: () => "", fetchedAt: 0, newestTs: null, inFlight: false };

function renderLiveSwim() {
  if (!liveSwim.entries) return;
  const now = Date.now();
  renderSwim(liveSwim.entries, { start: now - DAY_MS, end: now, live: true });
}

async function refreshLiveSwim(newestTs) {
  if (liveSwim.inFlight) return;
  const fresh = Date.now() - liveSwim.fetchedAt < SWIM_REFRESH_MS && newestTs === liveSwim.newestTs;
  if (liveSwim.entries && fresh) return;
  liveSwim.inFlight = true;
  try {
    const { days } = await getHistoryDays();
    // listDays 新日期在前。按北京时间分桶时最近两个日文件就盖得住近 24 小时；旧版本按本地时区
    // 分桶留下的文件日界可能偏几个小时，多读一个
    const recent = (Array.isArray(days) ? days : []).slice(0, 3);
    const parts = await Promise.all(recent.map((day) => getHistoryDay(day, { types: SWIM_ENTRY_TYPES }).then((data) => (Array.isArray(data?.entries) ? data.entries : []))));
    // 与按天复盘同一口径：旧格式（只有文案的）变迁先规范化，基线条目原样保留。
    liveSwim.entries = parts.flat().map((e) => (e?.type === "levels" ? e : normalizeHistoryTransition(e))).filter(Boolean);
    liveSwim.viewAt = createViewResolver(liveSwim.entries);
    liveSwim.fetchedAt = Date.now();
    liveSwim.newestTs = newestTs;
    if (timelineDate !== "live") return; // 加载期间用户切到了历史某天
    renderLiveSwim();
    renderLiveList(); // 「通道」行写哪台服务器，要等基线到了才知道
  } catch {
    // 历史接口不可用不影响清单
  } finally {
    liveSwim.inFlight = false;
  }
}

// 视图状态："live" 保持既有实时行为；选中日期后时间线静态展示该日回放。
let timelineDate = "live";

function setTimelineSummary(text) {
  const el = getEl("timelineSummary");
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

// 日期下拉刷新（对话框打开时调用）：保持当前选择；已消失的日期回退"实时"。
export async function refreshTimelineDays() {
  const sel = getEl("timelineDateSelect");
  if (!sel) return;
  try {
    const { days } = await getHistoryDays();
    const list = Array.isArray(days) ? days : [];
    knownDays = list;
    const current = sel.value || "live";
    sel.innerHTML = ['<option value="live">实时</option>']
      .concat(list.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`))
      .join("");
    sel.value = current !== "live" && list.includes(current) ? current : "live";
    if (sel.value === "live" && timelineDate !== "live") {
      timelineDate = "live";
      setTimelineSummary(null);
    }
  } catch {
    // 历史接口不可用不影响实时时间线
  }
}

// 复盘某一天要读的条目。日期指北京时间的自然日；日文件现在也按北京时间分桶，但 v2.44 及更早
// 按进程的本地时区分（应用从别的时区环境启动时日界会偏几个小时），所以前后两天的文件一起读，
// 由调用方按这一天的时间范围筛。前一天的条目同时是泳道的起点依据。
async function loadHistoryAround(date) {
  const neighbors = [offsetDay(date, -1), offsetDay(date, 1)].filter((day) => !knownDays.length || knownDays.includes(day));
  const read = (day) => getHistoryDay(day, { types: HISTORY_ENTRY_TYPES }).then((data) => (Array.isArray(data?.entries) ? data.entries : []));
  const [own, ...others] = await Promise.all([read(date), ...neighbors.map((day) => read(day).catch(() => []))]);
  return [...own, ...others.flat()];
}

let historyInFlight = false;
async function renderHistoryDay(date) {
  const listEl = getEl("timelineList");
  if (!listEl || historyInFlight) return;
  historyInFlight = true;
  try {
    const around = await loadHistoryAround(date);
    if (timelineDate !== date) return; // 加载期间用户已切走
    // 这一天（北京时间 0 点到 24 点）：摘要与清单只算这段时间里的条目；泳道今天还没过完就画到现在
    const start = Date.parse(`${date}T00:00:00+08:00`);
    const all = around.filter((e) => e && Number.isFinite(e.ts) && e.ts >= start && e.ts < start + DAY_MS);
    setTimelineSummary(formatHistorySummary(summarizeHistoryEntries(all)));
    const swimEntries = around.map((e) => (e?.type === "levels" ? e : normalizeHistoryTransition(e))).filter(Boolean);
    renderSwim(swimEntries, { start, end: Math.max(start + 1, Math.min(Date.now(), start + DAY_MS)), day: date });
    const context = { status: latestStatus, viewAt: createViewResolver(around) };
    // 采样只进摘要、基线只进泳道，都不进清单；变更先归一（旧格式只有文案），原始字段（自动徽标）保留
    const items = all
      .filter((e) => e.type !== "sample" && e.type !== "levels")
      .map((e) => {
        if (e.type === "signal") return e;
        const t = normalizeHistoryTransition(e);
        return t ? { ...e, ...t } : null;
      })
      .filter(Boolean);
    renderEpisodes(items, { live: false, context, emptyText: "该日无历史记录", range: { start, end: start + DAY_MS } });
  } catch (err) {
    if (timelineDate === date) {
      setTimelineSummary(null);
      const swimEl = getEl("timelineSwim");
      if (swimEl) swimEl.hidden = true;
      setEpisodeBar(null);
      const strip = getEl("timelineEpisodeStrip");
      if (strip) strip.hidden = true;
      listEl.innerHTML = `<li class="timeline-empty">历史加载失败: ${escapeHtml(err.message)}</li>`;
    }
  } finally {
    historyInFlight = false;
    // 加载期间又换了一天：那次切换被上面的 inFlight 挡掉了，这里补上
    if (timelineDate !== date && timelineDate !== "live") renderHistoryDay(timelineDate);
  }
}

// 下拉切换接线（bootstrap 时调用一次）。切回"实时"清空列表让 refreshTimeline 全量重建。
export function initTimelineHistory() {
  bindEpisodeControls();
  const sel = getEl("timelineDateSelect");
  if (!sel) return;
  sel.addEventListener("change", () => {
    timelineDate = sel.value || "live";
    episodeOpen.clear();
    const listEl = getEl("timelineList");
    if (listEl) listEl.innerHTML = "";
    if (timelineDate === "live") {
      setTimelineSummary(null);
      renderLiveSwim(); // 先用手头的数据画回近 24 小时，随后重拉
      liveSwim.fetchedAt = 0;
      refreshTimeline();
    } else {
      renderHistoryDay(timelineDate);
    }
  });
}

// ---- 清单：相隔不到 5 分钟的变更归成一段（render/timeline-episodes.js），每段一张可展开的卡 ----
// episodeOpen：用户亲手展开 / 收起过的段（id → 是否展开），每轮重画都按它来；没动过的段走默认规则。
const episodeOpen = new Map();
let onlyBadEpisodes = false;
let lastEpisodeRender = null;

function episodeObjectName(obj, { status, viewAt }) {
  const e = obj.entry || {};
  if (obj.signal) {
    const category = e.category || e.signalId || "signal";
    return `信号 · ${SIGNAL_CATEGORY_LABELS[category] || category}`;
  }
  const layer = LAYER_LABELS[e.layer || layerOfKey(obj.key)] || "";
  const name = objectLabel(obj.key, { status, view: viewAt ? viewAt(e.ts) : "" });
  return name ? `${layer} · ${name}` : layer || obj.key;
}

function setEpisodeBar(text) {
  const bar = getEl("timelineEpisodeBar");
  if (!bar) return;
  bar.hidden = !text;
  const label = bar.querySelector("[data-ep-summary]");
  if (label) label.textContent = text || "";
  const toggle = bar.querySelector("[data-ep-only-bad]");
  if (toggle) toggle.setAttribute("aria-pressed", String(onlyBadEpisodes));
}

// range：段落时间轴的窗口（实时 = 近 24 小时，复盘 = 那一天）
function renderEpisodes(items, { live, context, emptyText, range }) {
  lastEpisodeRender = { items, live, context, emptyText, range };
  const listEl = getEl("timelineList");
  if (!listEl) return;
  const episodes = groupEpisodes(items);
  const shown = onlyBadEpisodes ? episodes.filter((ep) => ep.tone === "warn" || ep.tone === "error") : episodes;
  setEpisodeBar(episodes.length ? episodesBarText(episodes, { shown: shown.length }) : null);
  const strip = getEl("timelineEpisodeStrip");
  if (strip) {
    const span = range || { start: Date.now() - DAY_MS, end: Date.now() };
    strip.hidden = !shown.length;
    if (shown.length) morphInnerHtml(strip, episodeStripHtml(shown, span));
  }
  if (!shown.length) {
    const text = episodes.length ? "这段时间没有出过警告或故障" : emptyText;
    morphInnerHtml(listEl, `<li class="timeline-empty">${escapeHtml(text)}</li>`);
    return;
  }
  const now = Date.now();
  const html = shown.map((ep, index) => episodeHtml(ep, {
    // 默认：只有一段，或最新那段还没恢复时展开它；其余收起
    open: episodeOpen.has(ep.id) ? episodeOpen.get(ep.id) : shown.length === 1 || (index === 0 && ep.outcome === "bad"),
    objectName: (obj) => episodeObjectName(obj, context),
    levelLabel: (level) => LEVEL_LABELS[level] || level,
    rowHtml: (entry) => buildHistoryRowHtml(entry, context),
    live,
    now,
  })).join("");
  morphInnerHtml(listEl, html);
}

function rerenderEpisodes() {
  if (lastEpisodeRender) renderEpisodes(lastEpisodeRender.items, lastEpisodeRender);
}

function bindEpisodeControls() {
  const listEl = getEl("timelineList");
  // toggle 不冒泡，捕获阶段接
  listEl?.addEventListener("toggle", (event) => {
    const id = event.target?.dataset?.ep;
    if (id) episodeOpen.set(id, event.target.open);
  }, true);
  getEl("timelineEpisodeStrip")?.addEventListener("click", (event) => {
    const id = event.target?.closest?.("[data-ep-jump]")?.dataset.epJump;
    if (!id) return;
    episodeOpen.set(id, true);
    rerenderEpisodes();
    const card = [...(listEl?.querySelectorAll(".tl-ep-card") || [])].find((el) => el.dataset.ep === id);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card?.querySelector("summary")?.focus({ preventScroll: true });
  });
  const bar = getEl("timelineEpisodeBar");
  bar?.addEventListener("click", (event) => {
    const btn = event.target?.closest?.("button");
    if (!btn) return;
    if (btn.hasAttribute("data-ep-only-bad")) {
      onlyBadEpisodes = !onlyBadEpisodes;
    } else if (btn.hasAttribute("data-ep-expand")) {
      const open = btn.dataset.epExpand === "all";
      for (const card of listEl?.querySelectorAll(".tl-ep-card") || []) episodeOpen.set(card.dataset.ep, open);
    } else {
      return;
    }
    rerenderEpisodes();
  });
}

// 实时清单（最近 50 条变更）。对象名要用到 status 与基线里的查看视角，两者到了都会重画。
let liveEvents = [];
function renderLiveList() {
  const status = latestStatus;
  // 基线还没拉到时先按当前查看的服务器写「通道」行；拉到之后以基线为准（切换过视角的那几条才对得上）
  const viewAt = liveSwim.entries ? liveSwim.viewAt : () => status?.activeServerId || "";
  renderEpisodes(liveEvents, { live: true, context: { status, viewAt }, emptyText: "暂无状态变更记录" });
}

// status 由渲染管线每轮带进来（取界面用名）；浮层打开时的那次调用不带参数，沿用上一轮的。
let timelineInFlight = false;
export async function refreshTimeline(status) {
  if (status) latestStatus = status;
  const listEl = getEl("timelineList");
  if (!listEl || !document.getElementById("dlgTimeline")?.open) return;
  // 历史复盘模式下静态展示选中日，实时轮询不得覆写列表。
  if (timelineDate !== "live") return;
  if (timelineInFlight) return;
  timelineInFlight = true;
  try {
    const { events } = await getTimeline({ limit: 50 });
    if (timelineDate !== "live") return; // 请求期间用户切到了历史某天
    liveEvents = Array.isArray(events) ? events : [];
    renderLiveList();
    refreshLiveSwim(liveEvents[0]?.ts ?? 0); // /api/timeline 最新在前
  } catch (err) {
    console.error("时间线刷新失败:", err.message);
  } finally {
    timelineInFlight = false;
  }
}

// ==========================================================================
// 更新日志与修复记录系统 (ES Module)
// ==========================================================================

// changelog-data 是前端最大的纯文案模块（~21KB），只有用户点版本徽章时才用得上。
// 首屏静态 import 会让每个访问者都付出一次解析成本，改为首次点击时动态 import：
// 浏览器模块缓存保证只加载/解析一次，后续点击直接命中 Promise 缓存。
let changelogDataPromise = null;
function loadChangelogData() {
  if (!changelogDataPromise) {
    changelogDataPromise = import("../changelog-data.js").then((m) => m.changelogData);
  }
  return changelogDataPromise;
}

// ---- T05 版本详情：运行 / 磁盘 / 前端 / supervisor 四个来源的区分视图 ----

// ---- 自更新（v2.59）：源码安装从 GitHub 取新版本。版本详情里多一行现状 + 「检查更新」 ----

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// 纯函数：GET /api/self-update 的载荷 → 一句现状。
export function describeSelfUpdate(su) {
  if (!su) return "";
  if (su.supported === false) return su.unsupportedReason || "当前安装方式不支持自动更新";
  if (su.applying) return "正在更新…";
  if (su.checking) return "正在检查…";
  const local = su.localVersion ? `v${su.localVersion}` : "版本未知";
  if (su.available && su.remoteVersion) {
    return su.canApply
      ? `有新版本 v${su.remoteVersion}（当前 ${local}）：点页面顶部横幅上的「更新」`
      : `有新版本 v${su.remoteVersion}（当前 ${local}）：${su.blockers?.[0]?.message || "现在不能自动更新"}`;
  }
  if (su.error?.message) return su.error.message;
  if (su.checkedAt) return `已是最新（${local}）· ${hhmm(su.checkedAt)} 检查过`;
  return `当前 ${local}，还没检查过`;
}

// 纯函数：版本详情里的「更新」一行。打包安装（发布方自己的 App）与取不到状态时不出这一行。
// 「检查更新」只在不是 git 仓库（只能重新 clone）时不给；其余不能更新的情况——git 不信任目录归属、
// 没有 origin、找不到 git、这一次没读出状态——处理完点它就能接上，不用重启工作台。
export function buildSelfUpdateRowHtml(su) {
  if (!su || su.kind === "packaged" || (su.supported == null && !su.error?.message)) return "";
  const deadEnd = su.supported === false && su.kind === "plain";
  const button = deadEnd ? "" : ' <button type="button" class="btn btn-secondary" id="selfUpdateCheckBtn">检查更新</button>';
  // 跟的是哪个分支写在下面「更新通道」那一行，这里不重复。
  const note = deadEnd
    ? "自动更新只支持 git clone 出来的安装目录"
    : `从 GitHub 取新版本${su.remote ? `（${su.remote}）` : ""}；发现新版本只提示，点了才更新，更新时隧道不断`;
  return `
          <li class="changelog-change-item">
            <span class="changelog-tag tag-feat">更新</span>
            <span class="changelog-change-text"><span id="selfUpdateStatus">${escapeHtml(describeSelfUpdate(su))}</span>${button}<br><small>${escapeHtml(note)}</small></span>
          </li>`;
}

// ---- 更新通道（v2.62）：通道就是安装目录所在的分支（后端 lib/self-update/channel.mjs）。界面只显示，换通道在终端里做 ----

// 纯函数：GET /api/self-update 的载荷 → 「更新通道」一行的 { value, note, command }；不出这一行 → null。
// command：接在说明后面的那条终端命令（单独给出，画的时候整条不折行、一点就全选）；没有就是空串。
// stable 稳定版（发布方手动推进之后才收到）/ main 开发版（发布方每次推送都收到）；在别的分支上不自动更新，如实写出来。
// 不是能自更新的 git 安装、或载荷里没有 channel 字段（更旧的后端）时不出这一行。
export function describeUpdateChannel(su) {
  if (su?.kind !== "git" || su.supported !== true || !Object.hasOwn(su, "channel")) return null;
  if (su.channel === "stable") return { value: "稳定版（stable）", note: "发布方确认过一个版本、推进稳定版之后才会收到更新", command: "" };
  if (su.channel === "main") {
    return {
      value: "开发版（main，发布方每次推送都会收到）",
      // 远端有稳定版分支才提：没有的时候这条命令切不过去。
      note: su.stableAvailable === true ? "想只收发布方确认过的版本：在终端进安装目录执行" : "",
      command: su.stableAvailable === true ? "npm run update -- --channel stable" : "",
    };
  }
  if (su.channel != null) return null;
  return {
    value: `不在任何通道上（${su.branch ? `当前在 ${su.branch} 分支上` : "当前在游离的提交上"}，不自动更新）`,
    note: `切回 ${su.stableAvailable === true ? "stable 或 main" : "main"} 分支后恢复`,
    command: "",
  };
}

export const UPDATE_CHANNEL_ROW_ID = "selfUpdateChannelRow";

// 纯函数：版本详情里的「更新通道」一行；没有可说的 → 空串。
export function buildUpdateChannelRowHtml(su) {
  const channel = describeUpdateChannel(su);
  if (!channel) return "";
  return `
          <li class="changelog-change-item" id="${UPDATE_CHANNEL_ROW_ID}">
            <span class="changelog-tag tag-feat">更新通道</span>
            <span class="changelog-change-text">${escapeHtml(channel.value)}${channel.note ? `<br><small>${escapeHtml(channel.note)}${channel.command ? ` <code>${escapeHtml(channel.command)}</code>` : ""}</small>` : ""}</span>
          </li>`;
}

// 纯函数：/api/build-info 响应 → 版本详情区块 HTML。缺失字段如实显示"未知"，
// 不用磁盘版本顶替运行版本；建议动作按 reasons 逐条给出（多原因可并存）。
export function buildVersionDetailsHtml(info, { clientBuild = "", selfUpdate = null } = {}) {
  const src = info && typeof info === "object" ? info : {};
  const monitor = src.monitorRunning || {};
  const bundle = src.bundleOnDisk || {};
  const supervisor = src.supervisorRunning || null;
  const compat = src.compatibility || { state: "unknown", reasons: [] };
  const fmtBuild = (b, unknown) => {
    if (!b || (!b.version && !b.gitCommit)) return unknown || "未知";
    return [b.version || "版本未知", b.gitCommit ? `commit ${String(b.gitCommit).slice(0, 10)}` : "", b.builtAt ? `构建于 ${b.builtAt}` : ""].filter(Boolean).join(" · ");
  };
  const rows = [
    ["前端已加载", clientBuild || "未知", "本次页面实际加载的前端版本（页面自报）"],
    ["monitor 运行中", fmtBuild(monitor.build, "未知"), monitor.mode === "packaged" ? "打包运行" : "源代码运行（版本取自 package.json）"],
    ["磁盘安装包", bundle.unknown ? "未知" : fmtBuild(bundle), "同一应用根的当前磁盘元信息"],
    ["supervisor 运行中", supervisor ? `${fmtBuild(supervisor.build)} · 控制协议 v${Number(supervisor.capabilities?.controlProtocol ?? 0)}` : "未知（无有效运行快照）", supervisor ? `实例 ${String(supervisor.instanceId || "").slice(0, 8)}` : "旧版本守护进程或未运行"],
  ];
  const suggestions = {
    "restart-monitor": "磁盘上的安装包比当前运行的 monitor 新：点顶部横幅或托盘菜单的「重启界面（隧道不中断）」即可生效——只重启控制台与监控服务，守护进程、本地代理与 SSH 隧道保持运行。",
    "supervisor-older": "运行中的 supervisor 是旧版本（可能缺少单隧道操作等新能力）。它只随应用重启更新，本工具不会为升级协议而自动重启它。",
    "reload-ui": "当前页面加载的前端资源比磁盘旧：刷新页面即可加载新界面。",
    "versions-unknown": "读不到版本信息，无法比对运行中与磁盘上的版本。",
    "supervisor-unknown": "未读到 supervisor 运行快照，无法判断其版本。",
  };
  const reasonList = Array.isArray(compat.reasons) ? compat.reasons : [];
  const suggestionHtml = reasonList.length
    ? reasonList.map((r) => `<li>${escapeHtml(suggestions[r] || r)}</li>`).join("")
    : "<li>运行版本与磁盘版本一致。</li>";
  const stateLabels = { aligned: "一致", "restart-monitor": "monitor 需重启", "supervisor-older": "supervisor 较旧", unknown: "版本未知" };
  return `
    <div class="changelog-version-block version-details">
      <div class="changelog-version-header">
        <span class="changelog-version-title">版本详情</span>
        <span class="changelog-version-date">${escapeHtml(stateLabels[compat.state] || compat.state)}</span>
      </div>
      <ul class="changelog-changes-list">
        ${rows.map(([label, value, note]) => `
          <li class="changelog-change-item">
            <span class="changelog-tag tag-perf">${escapeHtml(label)}</span>
            <span class="changelog-change-text">${escapeHtml(value)}<br><small>${escapeHtml(note)}</small></span>
          </li>`).join("")}${buildSelfUpdateRowHtml(selfUpdate)}${buildUpdateChannelRowHtml(selfUpdate)}
        <li class="changelog-change-item">
          <span class="changelog-tag tag-fix">建议</span>
          <span class="changelog-change-text"><ul>${suggestionHtml}</ul></span>
        </li>
      </ul>
    </div>`;
}

export function initChangelog() {
  async function renderChangelog() {
    const container = document.getElementById("changelogBody");
    if (!container) return;

    let data;
    try {
      data = await loadChangelogData();
    } catch (err) {
      container.innerHTML = `<div class="changelog-timeline"><div class="timeline-empty">更新日志加载失败: ${escapeHtml(err.message)}</div></div>`;
      return;
    }

    let html = '<div class="changelog-timeline">';
    // T05：版本详情区块——客户端自报版本只用于本次 reload-ui 比较，不当成可信事实。
    let versionDetailsHtml = "";
    try {
      const clientBuild = (data?.[0]?.version) || "";
      const info = await getJson(`/api/build-info${clientBuild ? `?clientBuild=${encodeURIComponent(clientBuild)}` : ""}`);
      // 自更新现状：旧后端 / fixture 模式没有这个接口 → 不出「更新」那一行。
      const selfUpdate = await getJson("/api/self-update").catch(() => null);
      versionDetailsHtml = buildVersionDetailsHtml(info, { clientBuild, selfUpdate });
    } catch {
      versionDetailsHtml = "";
    }
    html += versionDetailsHtml;
    (data || []).forEach((item) => {
      html += `
        <div class="changelog-version-block">
          <div class="changelog-version-header">
            <span class="changelog-version-title">${item.version}</span>
            <span class="changelog-version-date">${item.date}</span>
          </div>
          <ul class="changelog-changes-list">
      `;
      item.changes.forEach((change) => {
        const typeLabels = { feat: "新增", perf: "优化", fix: "修复" };
        html += `
          <li class="changelog-change-item">
            <span class="changelog-tag tag-${change.type}">${typeLabels[change.type] || "更新"}</span>
            <span class="changelog-change-text">${escapeHtml(change.text)}</span>
          </li>
        `;
      });
      html += `
          </ul>
        </div>
      `;
    });
    html += "</div>";
    container.innerHTML = html;
    bindSelfUpdateCheck(container);
  }

  // 「更新通道」那一行跟着最新的状态走：在终端里换了通道之后点一下「检查更新」，这里随即是新的。
  // 行可能原来没有（之前不在 git 安装的结论里）或不再该有，所以按整行换 / 补 / 撤。
  function syncUpdateChannelRow(container, statusEl, selfUpdate) {
    const html = buildUpdateChannelRowHtml(selfUpdate);
    const row = container.querySelector(`#${UPDATE_CHANNEL_ROW_ID}`);
    if (row) row.outerHTML = html;
    else if (html) statusEl.closest("li")?.insertAdjacentHTML("afterend", html);
  }

  // 「检查更新」：立刻 git fetch 一次，把结论写回这一行，并让顶部横幅跟着刷新。
  function bindSelfUpdateCheck(container) {
    const button = container.querySelector("#selfUpdateCheckBtn");
    const statusEl = container.querySelector("#selfUpdateStatus");
    if (!button || !statusEl) return;
    button.addEventListener("click", async () => {
      button.disabled = true;
      statusEl.textContent = "正在检查…";
      try {
        const selfUpdate = await postJson("/api/self-update/check", {});
        statusEl.textContent = describeSelfUpdate(selfUpdate);
        syncUpdateChannelRow(container, statusEl, selfUpdate);
      } catch (err) {
        statusEl.textContent = err?.serverMessage || err?.message || "检查更新失败";
      } finally {
        button.disabled = false;
      }
      document.dispatchEvent(new CustomEvent(SELF_UPDATE_CHANGED_EVENT));
    });
  }

  const changelogModal = document.getElementById("changelogModal");
  const versionBadge = document.getElementById("versionBadge");
  const changelogCloseBtn = document.getElementById("changelogCloseBtn");

  if (versionBadge && changelogModal) {
    versionBadge.addEventListener("click", () => {
      renderChangelog();
      changelogModal.showModal();
    });
  }

  function hideChangelog() {
    if (changelogModal) changelogModal.close();
  }

  if (changelogCloseBtn) changelogCloseBtn.addEventListener("click", hideChangelog);
}
