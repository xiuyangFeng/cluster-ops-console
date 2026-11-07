// logs-panel.js —— 运维日志面板：source/level 过滤 + 服务端切片 +
// 300 行渲染窗口 + SSE 增量 append。

// 版本查询串必须与 app.js 的导入一致，否则浏览器会实例化第二份模块（token 状态分裂）。
import { getLogs, getLogsSummary } from "./api.js";
import { autoBadgeHtml, escapeHtml, formatClock } from "./store.js";

const MAX_WINDOW = 300;
const FETCH_LIMIT = 500;
// 主动查询时最多展示整份缓存。实时新行在阅读期间只更新有界缓存，回到底部再接上。
const READING_WINDOW = FETCH_LIMIT;

// 渲染窗口切片：最多保留最新 max 条，返回被省略的更早条数。纯函数，便于测试。
export function sliceLogWindow(entries, max = MAX_WINDOW) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= max) return { visible: list.slice(), omitted: 0 };
  return { visible: list.slice(list.length - max), omitted: list.length - max };
}

// 过滤匹配（客户端二次判定，用于 SSE 增量 append）。纯函数，便于测试。
export function matchesFilter(entry, { source, level, q, operationId } = {}) {
  if (!entry) return false;
  if (source && entry.source !== source) return false;
  if (level && entry.level !== level) return false;
  if (operationId && entry.operationId !== operationId) return false;
  if (q && !String(entry.message || "").toLowerCase().includes(String(q).toLowerCase())) return false;
  return true;
}

// 时间范围选择值 → since 毫秒时间戳（"" = 不限）。纯函数，便于测试。
export function timeRangeToSince(rangeValue, now = Date.now()) {
  const table = { "15m": 15 * 60e3, "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3 };
  const span = table[rangeValue];
  return span ? now - span : undefined;
}

// 导出当前条目为 NDJSON 文本。纯函数，便于测试。
export function buildExportText(entries = []) {
  if (!entries.length) return "";
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

// 日志级别 → CSS class（.log-error/.log-warn/.log-ok）。纯函数，便于测试。
const RE_LOG_ERR = /\b(?:error|failed|fatal)\b/i;
const RE_LOG_WARN = /\b(?:warn|repair|auto starting|retry)\b/i;
export function logLevelClass(entry) {
  if (!entry) return "log-ok";
  const level = entry.level || "";
  if (level === "error") return "log-error";
  if (level === "warn") return "log-warn";
  const message = String(entry.message || "");
  if (RE_LOG_ERR.test(message)) return "log-error";
  if (RE_LOG_WARN.test(message)) return "log-warn";
  return "log-ok";
}

const PAD2 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function pad2(n) {
  return n >= 0 && n < 60 ? PAD2[n] : String(n).padStart(2, "0");
}

// 单槽本地日历日缓存：同一天（无夏令时跳变）内的数百条日志共享 YYYY-MM-DD
// 并通过整数算术直接格式化 HH:mm:ss，避免每条日志重复 new Date() 与 Intl 格式化。
let cachedDayStart = -1;
let cachedDayEnd = -1;
let cachedDayTz = null;
let cachedDayKey = "";

const currentTzTag = () => (typeof process !== "undefined" && process?.env?.TZ) || "";

function resolveDaySlot(ms, tz) {
  if (ms >= cachedDayStart && ms < cachedDayEnd && tz === cachedDayTz) {
    return cachedDayKey;
  }
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const key = `${y}-${pad2(m)}-${pad2(day)}`;
  const start = new Date(y, m - 1, day).getTime();
  const end = new Date(y, m - 1, day + 1).getTime();
  if (end - start === 86400000 && ms >= start && ms < end) {
    cachedDayStart = start;
    cachedDayEnd = end;
    cachedDayTz = tz;
    cachedDayKey = key;
  }
  return key;
}

// 固定 24 小时制 "14:03:07"（与系统区域无关）；缺时间戳按当前时刻。常驻日志流（render/log-stream.js）也用它。
export function formatTime(ts) {
  const ms = Number(ts) || Date.now();
  const tz = currentTzTag();
  resolveDaySlot(ms, tz);
  if (ms >= cachedDayStart && ms < cachedDayEnd && tz === cachedDayTz) {
    const sec = Math.floor((ms - cachedDayStart) / 1000);
    return `${PAD2[(sec / 3600) | 0]}:${PAD2[((sec % 3600) / 60) | 0]}:${PAD2[sec % 60]}`;
  }
  return formatClock(ms, { locale: "zh-CN", hour12: false });
}

// 按日志对象缓存单行 HTML 与本地日期 key：全量重渲染（如操作组聚合/展开切换）时，
// 窗口内已渲染过的数百条旧日志直接 O(1) 复用，无需重复跑正则、Date 构造与 HTML 转义。
const entryRenderCache = new WeakMap();

// 单条日志行 HTML（全量渲染与 SSE 增量 append 共用）。纯函数，便于测试。
// source=signal 的条目追加 .log-signal：卡顿信号在流里带左侧锚点，扫日志时可快速定位。
// v2.18：trigger:"auto" / event:"auto-repair" 的条目前缀「自动」徽标，一眼区分
// 策略层自动执行与人工点的一键修复（store.js autoBadgeHtml 统一判定）。
export function buildLogLineHtml(entry) {
  const canCache = Boolean(entry && typeof entry === "object" && entry.ts);
  const tz = canCache ? currentTzTag() : "";
  const rec = canCache ? entryRenderCache.get(entry) : null;
  if (
    rec &&
    rec.html &&
    rec.ts === entry.ts &&
    rec.tz === tz &&
    rec.msg === entry.message &&
    rec.lvl === entry.level &&
    rec.src === entry.source &&
    rec.op === entry.operationId
  ) {
    return rec.html;
  }
  const cls = logLevelClass(entry);
  const signalCls = entry && entry.source === "signal" ? " log-signal" : "";
  const badge = autoBadgeHtml(entry);
  const src = entry?.source ? `[${escapeHtml(entry.source)}] ` : "";
  const extras = [];
  if (entry?.nextAction) extras.push(`nextAction=${entry.nextAction}`);
  if (entry?.reason) extras.push(`reason=${entry.reason}`);
  if (entry?.channelId) extras.push(`channel=${entry.channelId}`);
  const extra = extras.length ? ` ${escapeHtml(extras.join(" "))}` : "";
  const html = `<span class="log-line ${cls}${signalCls}">${escapeHtml(formatTime(entry?.ts))} ${badge}${src}${escapeHtml(entry?.message)}${extra}</span>`;
  if (canCache) {
    const dateKey =
      Number(entry.ts) >= cachedDayStart && Number(entry.ts) < cachedDayEnd && tz === cachedDayTz
        ? cachedDayKey
        : rec?.dateKey || "";
    if (rec && rec.ts === entry.ts && rec.tz === tz) {
      rec.msg = entry.message;
      rec.lvl = entry.level;
      rec.src = entry.source;
      rec.op = entry.operationId;
      if (dateKey) rec.dateKey = dateKey;
      rec.html = html;
    } else {
      entryRenderCache.set(entry, {
        ts: entry.ts,
        tz,
        msg: entry.message,
        lvl: entry.level,
        src: entry.source,
        op: entry.operationId,
        dateKey,
        html,
      });
    }
  }
  return html;
}

// ---- 日期分隔（logs-panel 与 render/log-stream.js 共用）----

// 本地日期 key（跨天判定依据）。纯函数，便于测试。
export function logDateKey(ts) {
  const ms = Number(ts) || Date.now();
  return resolveDaySlot(ms, currentTzTag());
}

function entryDateKey(entry) {
  if (!entry || typeof entry !== "object" || !entry.ts) return logDateKey(entry?.ts);
  const tz = currentTzTag();
  const rec = entryRenderCache.get(entry);
  if (rec && rec.dateKey && rec.ts === entry.ts && rec.tz === tz) return rec.dateKey;
  const dateKey = logDateKey(entry.ts);
  if (rec && rec.ts === entry.ts && rec.tz === tz) {
    rec.dateKey = dateKey;
  } else {
    entryRenderCache.set(entry, {
      ts: entry.ts,
      tz,
      msg: entry.message,
      lvl: entry.level,
      src: entry.source,
      op: entry.operationId,
      dateKey,
      html: "",
    });
  }
  return dateKey;
}

// "—— 8月27日 ——" 式日期分隔行。纯函数，便于测试。
export function buildDateSeparatorHtml(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `<span class="log-date-sep" data-datekey="${logDateKey(ts)}">—— ${d.getMonth() + 1}月${d.getDate()}日 ——</span>`;
}

// 平铺条目 → 行 HTML 数组，跨天处插日期分隔行。startKey 衔接 DOM 尾部的日期上下文
// （"" = 起点，不加前导分隔）；返回的 lastDateKey 供下一批衔接。lineHtml 换掉单行的画法
// （常驻日志流用自己的分栏行）。纯函数，便于测试。
export function buildLineRows(entries, startKey = "", lineHtml = buildLogLineHtml) {
  const rows = [];
  let key = startKey;
  for (const e of entries) {
    const k = entryDateKey(e);
    if (key && k !== key) rows.push(buildDateSeparatorHtml(e?.ts));
    key = k;
    rows.push(lineHtml(e));
  }
  return { rows, lastDateKey: key };
}

export const isDateSep = (node) => !!(node?.className && String(node.className).indexOf("log-date-sep") !== -1);

// 裁剪头部之后清理孤儿日期分隔行：紧跟另一分隔行（当日行已被裁光）或后面已无内容的分隔行。
// remove(node) 由调用方决定怎么删（<pre> 布局要连同其后的 "\n" 文本节点一起删）。
export function removeOrphanDateSeps(container, remove) {
  let child = container.firstElementChild;
  while (child) {
    const next = child.nextElementSibling || null;
    if (isDateSep(child) && (!next || isDateSep(next))) remove(child);
    child = next;
  }
}

// 快照与 SSE 增量的去重 key（日志面板与常驻日志流共用）。
export function entryKey(e) {
  return `${e?.ts}|${e?.source || ""}|${e?.message || ""}`;
}

// ---- 操作分组（纯展示层：过滤/导出/服务端切片不感知分组）----

// 相邻且同 operationId 的条目折叠成操作组；无 operationId 的条目保持平铺。
// "相邻"= 在过滤后的渲染序列里紧挨着：同 operationId 被其他条目隔断时各自成组。
// 带 operationId 的单条也成组（操作首条常先于后续行到达，形态稳定不需事后改写）。
export function groupLogEntries(entries) {
  const units = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const op = entry?.operationId ? String(entry.operationId) : "";
    const last = units[units.length - 1];
    if (op && last && last.type === "group" && last.operationId === op) {
      last.entries.push(entry);
    } else if (op) {
      units.push({ type: "group", operationId: op, entries: [entry] });
    } else {
      units.push({ type: "flat", entry });
    }
  }
  return units;
}

// 操作摘要 + 结果级别。摘要从组内首条 message 提炼（restart/start/stop 等关键词表）；
// 特例：组内同时出现 stop 与 start 关键词判为"重启"——/api/restart 全链路首条日志是
// "stop requested"，只看首条会误判为停止。结果按组内最高 level（error>warn>ok）。
export function summarizeOperation(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const msgs = list.map((e) => String((e?.message) || "").toLowerCase());
  const first = msgs[0] || "";
  const RE_RESTART = /restart|重启/;
  const RE_START = /\bstart|启动/;
  const RE_STOP = /\bstop|停止/;
  let summary = "";
  if (RE_RESTART.test(first) || (msgs.some((m) => RE_STOP.test(m)) && msgs.some((m) => RE_START.test(m)))) {
    summary = "重启通道";
  } else if (RE_START.test(first)) summary = "启动通道";
  else if (RE_STOP.test(first)) summary = "停止通道";
  else if (/probe|探针/.test(first)) summary = "手动探针";
  else if (/bootstrap|向导|引导/.test(first)) summary = "向导步骤";
  else if (/active (server|agent)|切换/.test(first)) summary = "切换配置";
  else if (/repair|修复/.test(first)) summary = "自动修复";
  else {
    const raw = String((list[0]?.message) || "操作");
    summary = raw.length > 32 ? `${raw.slice(0, 32)}…` : raw;
  }
  let level = "ok";
  for (const e of list) {
    const l = (e?.level) || "";
    if (l === "error") { level = "error"; break; }
    if (l === "warn") level = "warn";
  }
  const result = level === "error" ? "失败" : level === "warn" ? "有警告" : "成功";
  return { summary, level, result };
}

// 操作组 HTML：组头（caret 由 CSS ::before 提供，展开/收起纯 class 翻转）+ 明细体。
// 全 inline 结构以适配 <pre> 内 "\n" 分行；明细行以 "\n  " 连接形成两格缩进
// （复制文本时缩进保留）。纯函数，便于测试。
export function buildGroupHtml(unit, expanded = false) {
  const { summary, level, result } = summarizeOperation(unit.entries);
  const firstTs = unit.entries[0]?.ts;
  const head =
    `<span class="log-group-head" role="button" tabindex="0">` +
    `${escapeHtml(summary)} · ${escapeHtml(formatTime(firstTs))} · ${unit.entries.length} 条 · ` +
    `<span class="log-group-result">${result}</span></span>`;
  const body = `<span class="log-group-body">\n  ${unit.entries.map(buildLogLineHtml).join("\n  ")}</span>`;
  return `<span class="log-group log-group-${level}${expanded ? " expanded" : ""}" ` +
    `data-op="${escapeHtml(unit.operationId)}" data-count="${unit.entries.length}">${head}${body}</span>`;
}

// 可见窗口 → 渲染行序列：操作分组 + 跨天处插日期分隔行。prevDateKey 供增量
// 追加路径衔接 DOM 尾部日期上下文（"" = 窗口起点，不加前导分隔）。纯函数，便于测试。
export function buildLogRowsHtml(entries, expandedOps = null, prevDateKey = "") {
  const list = Array.isArray(entries) ? entries : [];
  const rows = [];
  let lastKey = prevDateKey || "";
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const op = entry?.operationId ? String(entry.operationId) : "";
    if (!op) {
      const key = entryDateKey(entry);
      if (lastKey && key !== lastKey) rows.push(buildDateSeparatorHtml(entry?.ts));
      rows.push(buildLogLineHtml(entry));
      lastKey = key;
    } else {
      const groupEntries = [entry];
      while (i + 1 < list.length && list[i + 1]?.operationId && String(list[i + 1].operationId) === op) {
        i += 1;
        groupEntries.push(list[i]);
      }
      const first = groupEntries[0];
      const last = groupEntries[groupEntries.length - 1];
      const firstKey = entryDateKey(first);
      if (lastKey && firstKey !== lastKey) rows.push(buildDateSeparatorHtml(first?.ts));
      rows.push(buildGroupHtml({ type: "group", operationId: op, entries: groupEntries }, !!(expandedOps?.has(op))));
      // 组内跨天不加分隔（组头时间已锚定），但日期上下文推进到组内最后一条。
      lastKey = first === last ? firstKey : entryDateKey(last);
    }
  }
  return { rows, lastDateKey: lastKey };
}

// ---- DOM 绑定层 ----

export function createLogsPanel({ logEl, logBox, sourceSelect, levelSelect, searchInput, rangeSelect, summaryEl, exportBtn, opFilterChip, isActive } = {}) {
  let entries = [];
  let selectedOperationId = "";

  // ---- 收起期省电（perf）----
  // 面板在 dlgLogs 浮层里：浮层关着时，状态刷新/SSE onOpen/可见性恢复触发的
  // refresh() 不再拉 500 条日志 + 摘要并重建 DOM，SSE 逐条 append 也不再渲染——
  // 只记脏（dirty），浮层打开时补一次全量刷新（openDialog 显式 refresh；其余直接
  // showModal 的入口由下面的 open 属性观察兜底）。内联布局（无宿主 dialog）恒为活跃。
  let hostDialog;
  function getHostDialog() {
    if (hostDialog === undefined) {
      const host = logBox || logEl;
      hostDialog = (host && typeof host.closest === "function" && host.closest("dialog")) || null;
    }
    return hostDialog;
  }
  function panelActive() {
    if (typeof isActive === "function") return Boolean(isActive());
    const dlg = getHostDialog();
    return !dlg || Boolean(dlg.open);
  }
  let dirty = true;
  if (typeof MutationObserver !== "undefined") {
    const dlg = getHostDialog();
    if (dlg && typeof dlg.nodeType === "number") {
      new MutationObserver(() => {
        if (dirty && panelActive()) refresh({ force: true });
      }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
    }
  }

  // 操作过滤指示 chip：openOperation 设置过滤时出现，点击清除（否则该隐藏
  // 过滤会一直叠加在 source/level 等可见过滤器之上，用户无法察觉也无法解除）。
  function updateOpFilterChip() {
    if (!opFilterChip) return;
    opFilterChip.style.display = selectedOperationId ? "" : "none";
  }
  if (opFilterChip) opFilterChip.addEventListener("click", () => openOperation(""));

  function currentFilter() {
    return {
      source: sourceSelect ? sourceSelect.value || "" : "",
      level: levelSelect ? levelSelect.value || "" : "",
      q: searchInput ? searchInput.value.trim() : "",
      operationId: selectedOperationId,
    };
  }

  function matchesCurrentFilter(entry) {
    if (!entry) return false;
    if (selectedOperationId && entry.operationId !== selectedOperationId) return false;
    const source = sourceSelect ? sourceSelect.value : "";
    if (source && entry.source !== source) return false;
    const level = levelSelect ? levelSelect.value : "";
    if (level && entry.level !== level) return false;
    const rawQ = searchInput ? searchInput.value : "";
    if (rawQ) {
      const q = rawQ.trim().toLowerCase();
      if (q && !String(entry.message || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }

  // DOM 增量状态：当前 DOM 中的日志行数（分组明细按条数计、分隔行不计）、
  // 省略计数、尾部日期上下文（全量 render 时重置）。
  let domLines = 0;
  let omittedTotal = 0;
  let domLastDateKey = "";
  let pendingAppend = [];
  let readingDeferred = false;
  let snapshotDeferred = false;
  // 操作组展开状态：按 operationId 记忆，增量/全量渲染间保持。
  const expandedOps = new Set();

  function isAtBottom() {
    if (!logBox) return true;
    if (domLines === 0 && logBox.nodeType === 1) return true;
    return logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 12;
  }

  // ---- 阅读位置（翻旧日志时不跳）----
  // #log 是 <pre> 里的行内排版，浏览器自带的滚动锚定找不到行级锚点：头部裁剪 / 整块重绘时由这里按
  // 「视口顶部那一行」手动对齐。只在用户不在底部时做（在底部时照旧贴底）。
  // 收起的操作组里的明细行不渲染（量出来全是 0），不算候选，否则二分查找的单调性会被打破。
  const LINE_SELECTOR = ":scope > .log-line, .log-group-head, .log-group.expanded .log-line";
  function captureAnchor() {
    if (!logBox || typeof logBox.getBoundingClientRect !== "function" || typeof logEl.querySelectorAll !== "function") return null;
    const top = logBox.getBoundingClientRect().top;
    const lines = logEl.querySelectorAll(LINE_SELECTOR);
    // 行按文档顺序自上而下排列：二分找第一条底边越过视口顶部的行（只量十来次，不逐行量）。
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].getBoundingClientRect().bottom > top + 1) hi = mid;
      else lo = mid + 1;
    }
    if (lo >= lines.length) return null;
    const text = lines[lo].textContent;
    let nth = 0; // 同文的行（极少见）按出现次序区分
    for (let j = 0; j < lo; j += 1) if (lines[j].textContent === text) nth += 1;
    return { text, nth, index: lo, offset: lines[lo].getBoundingClientRect().top - top };
  }
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const lines = logEl.querySelectorAll(LINE_SELECTOR);
    if (anchor.index < lines.length && lines[anchor.index].textContent === anchor.text && anchor.nth === 0) {
      const delta = lines[anchor.index].getBoundingClientRect().top - logBox.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) >= 1) logBox.scrollTop += delta;
      return;
    }
    let nth = anchor.nth;
    for (const line of lines) {
      if (line.textContent !== anchor.text || nth-- > 0) continue;
      const delta = line.getBoundingClientRect().top - logBox.getBoundingClientRect().top - anchor.offset;
      if (Math.abs(delta) >= 1) logBox.scrollTop += delta;
      return;
    }
  }

  function render({ preserveScrollOnly = false } = {}) {
    if (!logEl) return;
    readingDeferred = false;
    pendingAppend = [];
    const atBottom = isAtBottom();
    const { visible, omitted } = sliceLogWindow(
      entries.length > FETCH_LIMIT ? entries.slice(-FETCH_LIMIT) : entries,
      atBottom ? MAX_WINDOW : READING_WINDOW,
    );
    const keepTopWithoutReflow = !atBottom && preserveScrollOnly && omitted === omittedTotal;
    const anchor = atBottom || keepTopWithoutReflow ? null : captureAnchor();
    const rows = [];
    if (omitted > 0) {
      rows.push(`<span class="log-omitted">已省略更早 ${omitted} 条日志</span>`);
    }
    const { rows: bodyRows, lastDateKey } = buildLogRowsHtml(visible, expandedOps);
    rows.push(...bodyRows);
    logEl.innerHTML = rows.join("\n") || "暂无匹配日志";
    domLines = visible.length;
    omittedTotal = omitted;
    domLastDateKey = lastDateKey;
    if (atBottom && logBox) logBox.scrollTop = logBox.scrollHeight;
    else if (!keepTopWithoutReflow) restoreAnchor(anchor);
  }

  const hasClass = (node, cls) =>
    !!(node?.className && String(node.className).indexOf(cls) !== -1);

  // 头部超窗裁剪：按"单位"（平铺行=1 条、操作组=data-count 条）整体移除，
  // 分隔行不占行数名额；随后清理不再需要的分隔行（紧跟另一分隔行或已无后续内容）。
  function trimHeadUnits(limit = MAX_WINDOW) {
    while (domLines > limit) {
      let node = logEl.firstElementChild;
      while (node && (hasClass(node, "log-omitted") || hasClass(node, "log-date-sep"))) {
        node = node.nextElementSibling || null;
      }
      if (!node) break;
      const count = hasClass(node, "log-group")
        ? Math.max(1, parseInt(node.getAttribute?.("data-count"), 10) || 1)
        : 1;
      // 行间以 "\n" 文本节点分隔（pre-wrap 下可见）：随单位一并移除，否则头部空行堆积。
      const sep = node.nextSibling;
      node.remove();
      if (sep && sep.nodeType === 3) sep.remove();
      domLines -= count;
      omittedTotal += count;
    }
    removeOrphanDateSeps(logEl, (sepNode) => {
      const tail = sepNode.nextSibling;
      sepNode.remove();
      if (tail && tail.nodeType === 3) tail.remove();
    });
  }

  // SSE 尾部追加的增量路径：常态流（timeline/probe/signal 等无 operationId）只插入
  // 新行并裁剪头部超窗单位，避免每 250ms 全量 innerHTML 重建（选区丢失、300 节点
  // reflow 抖动）。批内含 operationId 时退回全量渲染：新行可能新建/跨批延续操作组，
  // 组头计数、结果级别与展开态由 render() 统一重算——操作是点击级低频突发，
  // 短暂全量不影响常态流的快路径。
  function renderAppend(newEntries) {
    if (!logEl) return;
    // 保留正在看的节点和文字选区：不仅避免裁剪，操作组也不能触发整窗重建。
    if (domLines > 0 && !isAtBottom()) {
      readingDeferred = true;
      return;
    }
    if (domLines === 0) {
      // DOM 里还是占位文案（或被 clear 过），退回全量重建。
      render();
      return;
    }
    if (newEntries.some((e) => e?.operationId)) {
      const prevTail = entries[entries.length - newEntries.length - 1];
      render({ preserveScrollOnly: !prevTail?.operationId });
      return;
    }
    const atBottom = isAtBottom();
    const { rows, lastDateKey } = buildLineRows(newEntries, domLastDateKey);
    logEl.insertAdjacentHTML("beforeend", `\n${rows.join("\n")}`);
    domLastDateKey = lastDateKey;
    domLines += newEntries.length;
    // 尾部追加不影响视口里的内容；仅当触发头部超窗裁剪时才会改变上方高度，
    // 未超窗时不读 scrollHeight，避免在 insertAdjacentHTML 后触发强制同步重排。
    const limit = atBottom ? MAX_WINDOW : READING_WINDOW;
    const willTrim = domLines > limit;
    if (willTrim) {
      const heightBefore = !atBottom && logBox ? logBox.scrollHeight : 0;
      trimHeadUnits(limit);
      if (omittedTotal > 0) {
        let label = logEl.querySelector(".log-omitted");
        if (!label) {
          logEl.insertAdjacentHTML("afterbegin", `<span class="log-omitted"></span>\n`);
          label = logEl.querySelector(".log-omitted");
        }
        const text = `已省略更早 ${omittedTotal} 条日志`;
        if (label.textContent !== text) label.textContent = text;
      }
      if (!atBottom && logBox) {
        const shrink = heightBefore - logBox.scrollHeight;
        if (shrink) logBox.scrollTop -= shrink;
      }
    }
    if (atBottom && logBox) logBox.scrollTop = logBox.scrollHeight;
  }

  // 拉取往返期间经 SSE 到达的新行缓冲：快照落地时按 key 去重后拼到尾部，
  // 否则重连瞬间到达的日志会被更旧的服务端快照覆盖而永久丢失。
  let streamedDuringFetch = null;
  let refreshSeq = 0;

  async function refresh({ force = false } = {}) {
    if (!force && !panelActive()) {
      dirty = true;
      return;
    }
    if (!force && domLines > 0 && !isAtBottom()) {
      snapshotDeferred = true;
      return;
    }
    snapshotDeferred = false;
    dirty = false;
    const { source, level, q, operationId } = currentFilter();
    const since = rangeSelect ? timeRangeToSince(rangeSelect.value) : undefined;
    const seq = ++refreshSeq;
    const streamed = [];
    streamedDuringFetch = streamed;
    try {
      const { entries: fetched } = await getLogs({ source, level, q, operationId, since, limit: FETCH_LIMIT });
      // 往返期间又发起了更新的查询（改了筛选 / 搜索）：这份是旧条件的结果，不落地。
      // 此前两份共用一个缓冲，先回来的把它置空，后回来的（才是当前条件）在 filter 上抛错被吞掉，
      // 面板就停在旧条件的结果上。
      if (seq !== refreshSeq) return;
      const fetchedList = Array.isArray(fetched) ? fetched : [];
      const seen = new Set(fetchedList.slice(-80).map(entryKey));
      const tail = streamed.filter((e) => !seen.has(entryKey(e)));
      entries = fetchedList.concat(tail).slice(-FETCH_LIMIT);
      // 请求期间用户也可能开始向上阅读。筛选/手动刷新仍立即生效，后台快照等回到底部。
      if (!force && domLines > 0 && !isAtBottom()) readingDeferred = true;
      else render();
    } catch {
      // 拉取失败时保留上一批日志。
    }
    if (seq !== refreshSeq) return;
    streamedDuringFetch = null;
    refreshSummary();
  }

  // 异常摘要卡：1h 窗口逐源 error/warn 计数，点击直达对应筛选。
  async function refreshSummary() {
    if (!summaryEl) return;
    try {
      const { windows } = await getLogsSummary();
      const win = windows?.[0];
      const chips = [];
      for (const [src, counts] of Object.entries(win ? win.bySource : {})) {
        if (!counts.error && !counts.warn) continue;
        const level = counts.error ? "error" : "warn";
        const parts = [
          counts.error ? `${counts.error} 错误` : "",
          counts.warn ? `${counts.warn} 警告` : "",
        ].filter(Boolean).join(" / ");
        chips.push(`<button class="summary-chip chip-${level}" data-source="${escapeHtml(src)}" data-level="${level}">${escapeHtml(src)}：过去 1h ${parts}</button>`);
      }
      summaryEl.innerHTML = chips.join("") || `<span class="summary-quiet">过去 1h 无异常日志</span>`;
    } catch {
      // 摘要不可用不影响日志列表
    }
  }

  // SSE log 事件增量 append（渲染节流 ≤4 次/秒，节流窗口内的新行合并为一次 DOM 追加）。
  let renderTimer = null;
  logBox?.addEventListener?.("scroll", () => {
    if (!panelActive()) return;
    if (!isAtBottom()) {
      if (domLines > 0 && !readingDeferred) {
        readingDeferred = true;
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        pendingAppend = [];
      }
      return;
    }
    if (readingDeferred) render();
    if (snapshotDeferred) refresh();
  }, { passive: true });

  function bufferStreamed(entry) {
    if (!streamedDuringFetch) return;
    streamedDuringFetch.push(entry);
    if (streamedDuringFetch.length > FETCH_LIMIT) streamedDuringFetch.shift();
  }

  function appendEntry(entry) {
    if (!matchesCurrentFilter(entry)) return;
    if (!panelActive()) {
      // 浮层关着：不缓冲不渲染，打开时整批从服务端重拉（与 SSE onOpen 同一路径）。
      // 拉取往返中到达的行仍要进去重缓冲，否则快照落地时会丢。
      bufferStreamed(entry);
      dirty = true;
      return;
    }
    entries.push(entry);
    if (entries.length >= FETCH_LIMIT * 2) entries = entries.slice(-FETCH_LIMIT);
    bufferStreamed(entry);
    // 读旧内容时无需反复唤醒定时器、构建 HTML 或查询布局；entries 已保存最新的 500 行。
    if (readingDeferred) return;
    pendingAppend.push(entry);
    if (pendingAppend.length > FETCH_LIMIT) pendingAppend = pendingAppend.slice(-FETCH_LIMIT);
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      const batch = pendingAppend;
      pendingAppend = [];
      if (!panelActive()) { dirty = true; return; }
      if (batch.length) renderAppend(batch);
    }, 250);
  }

  // 导出当前筛选结果为 NDJSON 文件（客户端 Blob 下载）。
  function exportLogs() {
    const windowEntries = entries.length > FETCH_LIMIT ? entries.slice(-FETCH_LIMIT) : entries;
    const blob = new Blob([buildExportText(windowEntries)], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ops-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clear() {
    refreshSeq += 1; // 清空前发出的快照不能随后把已清掉的内容填回来。
    streamedDuringFetch = null;
    clearTimeout(renderTimer);
    renderTimer = null;
    readingDeferred = false;
    snapshotDeferred = false;
    entries = [];
    pendingAppend = [];
    domLines = 0;
    omittedTotal = 0;
    domLastDateKey = "";
    if (logEl) logEl.textContent = "操作日志已手动清空。";
  }

  // 操作组展开/收起：容器级事件委托（行 DOM 会被增量重建，不能挂行级监听）。
  // 纯 class 翻转 + expandedOps 记忆，caret 箭头由 CSS ::before 跟随 .expanded 切换。
  function toggleGroupFromEvent(e) {
    const target = e?.target;
    const head = target?.closest ? target.closest(".log-group-head") : null;
    if (!head) return false;
    const group = head.closest ? head.closest(".log-group") : null;
    if (!group?.classList) return false;
    const expanded = group.classList.toggle("expanded");
    const op = (group.getAttribute?.("data-op")) || "";
    if (op) {
      if (expanded) expandedOps.add(op);
      else expandedOps.delete(op);
      // 长会话防膨胀：只记最近 200 个操作的展开状态。
      if (expandedOps.size > 200) expandedOps.delete(expandedOps.values().next().value);
    }
    return true;
  }
  if (logEl && typeof logEl.addEventListener === "function") {
    logEl.addEventListener("click", toggleGroupFromEvent);
    logEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (toggleGroupFromEvent(e) && typeof e.preventDefault === "function") e.preventDefault();
    });
  }

  // 联动过滤（console:filter-logs）：把 source 过滤器设为事件值并走现有 apply 路径。
  // source 以日志条目实际 entry.source 为准；select 里没有的未知值安全忽略。
  function applySourceFilter(source) {
    const value = String(source == null ? "" : source);
    if (!sourceSelect) return false;
    const options = sourceSelect.options ? Array.from(sourceSelect.options) : [];
    if (value && options.length && !options.some((o) => o && o.value === value)) return false;
    sourceSelect.value = value;
    refresh({ force: true });
    // 让日志面板进入视口：面板在 dlgLogs 浮层内时打开浮层；内联布局时滚动到可见。
    const host = logBox || logEl;
    const dlg = host?.closest ? host.closest("dialog") : null;
    if (dlg && !dlg.open && typeof dlg.showModal === "function") dlg.showModal();
    else if (host && typeof host.scrollIntoView === "function") {
      host.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    return true;
  }
  // Node 测试环境无 document：与 toast.js 相同的 typeof 守卫模式。
  if (typeof document !== "undefined") {
    document.addEventListener("console:filter-logs", (e) => {
      const detail = e?.detail;
      if (!detail || typeof detail.source === "undefined") return;
      applySourceFilter(detail.source);
    });
  }

  const forceRefresh = () => refresh({ force: true });
  if (sourceSelect) sourceSelect.addEventListener("change", forceRefresh);
  if (levelSelect) levelSelect.addEventListener("change", forceRefresh);
  if (rangeSelect) rangeSelect.addEventListener("change", forceRefresh);
  if (exportBtn) exportBtn.addEventListener("click", exportLogs);
  if (searchInput) {
    let debounce = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(forceRefresh, 300);
    });
  }
  if (summaryEl) {
    summaryEl.addEventListener("click", (e) => {
      const chip = e.target.closest(".summary-chip");
      if (!chip) return;
      if (sourceSelect) sourceSelect.value = chip.dataset.source || "";
      if (levelSelect) levelSelect.value = chip.dataset.level || "";
      forceRefresh();
    });
  }

  // 按操作回看（runbook「查看本次操作日志」/ 事件「查看处置日志」）：一次操作的日志分散在
  // ops / timeline 等多个来源，且可能早于当前时间范围——先清掉来源/级别/关键词/时间范围，
  // 否则残留的可见过滤会把这次操作的行整批滤掉，只剩"暂无匹配日志"。清除操作过滤时不动它们。
  function openOperation(operationId) {
    selectedOperationId = String(operationId || "");
    if (selectedOperationId) {
      for (const input of [sourceSelect, levelSelect, searchInput, rangeSelect]) if (input) input.value = "";
    }
    updateOpFilterChip();
    // 调用方随后才 showModal：此刻浮层可能还关着，必须强制拉取。
    return refresh({ force: true });
  }

  return { refresh, appendEntry, clear, render, openOperation, applySourceFilter, isDirty: () => dirty };
}
