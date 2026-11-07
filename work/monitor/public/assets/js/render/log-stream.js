// 常驻实时日志流(live tail):初始 seed + SSE 追加,DOM 行数上限裁剪。
// append 走 250ms 合批(与 logs-panel.js 的 appendEntry 节流一致):一批内
// isAtBottom 只读一次、多行拼一次 insertAdjacentHTML、trim 一次完成，
// 避免 restart 时几十行日志逐条落 DOM(每条 2 次强制布局)造成卡顿。
// 跨天处插入日期分隔行:分隔行不计入 maxLines 名额,裁剪时连带清理孤儿分隔行。
// 一行都还没有时显示「等待第一条日志」空状态,第一行到达(seed 或 SSE 合批)即被替换。
import { buildLineRows, entryKey, formatTime, isDateSep, logLevelClass, removeOrphanDateSeps } from "../logs-panel.js";
import { getLogs } from "../api.js";
import { emptyStateHtml } from "../empty-state.js";
import { autoBadgeHtml, escapeHtml } from "../store.js";

const FLUSH_DELAY_MS = 250;

// ---- 单行画法：时刻 · 来源标签 · 正文三栏（日志浮层里的 <pre> 原文行不受影响）----
const SOURCE_LABELS = Object.freeze({
  timeline: "状态", ops: "运维", supervisor: "守护", bootstrap: "向导", signal: "信号",
  desktop: "桌面", renderer: "页面", launcher: "启动", repair: "修复",
});
const STATE_LEVEL = { ok: "ok", ready: "ok", warn: "warn", degraded: "warn", waiting: "warn", error: "error", down: "error" };
// 键里可以带冒号（res:validation:server-01），以「冒号 + 空白」收尾
const RE_TRANSITION = /^(\S+?):\s+(\S+)\s*->\s*(\S+)(.*)$/;
const RE_UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_KV = /(^|\s)([a-zA-Z][\w-]*)=([^\s]+)/g;

// 级别：状态变更按「变到了什么」算（「故障 → 正常」是恢复，不该整行标红）；其余看 level，再看文案。
export function streamLevel(entry) {
  const m = RE_TRANSITION.exec(String(entry?.message || ""));
  if (m) return STATE_LEVEL[m[3]] || "info";
  const cls = logLevelClass(entry);
  return cls === "log-error" ? "error" : cls === "log-warn" ? "warn" : "info";
}

// 已转义的文本：长 UUID 缩成前 8 位（悬停看全），key=value 的键名弱化
function decorate(escaped) {
  // 先标键值（这时还没有带属性的标签可误配），再缩 UUID
  return escaped
    .replace(RE_KV, (_m, lead, k, v) => `${lead}<span class="ls-kv"><i>${k}=</i>${v}</span>`)
    .replace(RE_UUID, (full, head) => `<span class="ls-id" title="${full}">${head}</span>`);
}

// 正文末尾的 reason=… 摘出来另起一段弱化显示
function splitReason(text) {
  const at = text.search(/\sreason=/);
  return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at).replace(/^\s*reason=/, "")];
}

export function buildStreamLineHtml(entry) {
  const message = String(entry?.message ?? "");
  const level = streamLevel(entry);
  const source = String(entry?.source || "");
  const extras = [];
  if (entry?.nextAction) extras.push(`下一步 ${entry.nextAction}`);
  if (entry?.channelId) extras.push(`channel=${entry.channelId}`);
  let body;
  let reason = "";
  const m = RE_TRANSITION.exec(message);
  if (m) {
    const [, key, from, to, rest] = m;
    reason = splitReason(rest)[1] || rest.trim();
    body = `<span class="ls-key">${escapeHtml(key)}</span><span class="ls-state" data-level="${STATE_LEVEL[from] || "info"}">${escapeHtml(from)}</span><span class="ls-arrow">→</span><span class="ls-state" data-level="${STATE_LEVEL[to] || "info"}">${escapeHtml(to)}</span>`;
  } else {
    const [head, tail] = splitReason(message);
    reason = tail;
    body = decorate(escapeHtml(head));
  }
  if (entry?.reason) reason = reason ? `${reason}；${entry.reason}` : String(entry.reason);
  const tail = [reason, ...extras].filter(Boolean).join(" · ");
  const full = [message, entry?.reason ? `reason=${entry.reason}` : "", ...extras].filter(Boolean).join(" ");
  const srcTag = source ? `<span class="ls-src" data-src="${escapeHtml(source)}" title="${escapeHtml(source)}">${escapeHtml(SOURCE_LABELS[source] || source)}</span>` : '<span class="ls-src"></span>';
  return `<span class="log-line ls-row" data-level="${level}" title="${escapeHtml(full)}"><span class="ls-time">${escapeHtml(formatTime(entry?.ts))}</span>${srcTag}<span class="ls-msg">${autoBadgeHtml(entry)}${body}${tail ? `<span class="ls-reason">${escapeHtml(tail)}</span>` : ""}</span></span>`;
}

// 日志只记变化(状态迁移、隧道断开 / 重连、修复动作、日志信号),不是每轮检查都写一行。
export const LOG_STREAM_WAITING_HTML = emptyStateHtml({
  tone: "wait",
  icon: "wave",
  title: "等待第一条日志",
  body: "链路状态变化、隧道断开与重连、修复动作都会在这里写一行；连接刚建立时可能要等几秒。",
});

const isPlaceholder = (node) => Boolean(node?.classList?.contains("empty-state"));

export function trimToMax(el, maxLines) {
  // maxLines 只约束真实日志行:日期分隔行不占名额(否则跨天分隔会挤掉日志行本身)。
  let lines = 0;
  for (const child of el.children) if (!isDateSep(child)) lines += 1;
  while (lines > maxLines) {
    let node = el.firstElementChild;
    while (node && isDateSep(node)) node = node.nextElementSibling || null;
    if (!node) break;
    el.removeChild(node);
    lines -= 1;
  }
  removeOrphanDateSeps(el, (node) => el.removeChild(node));
}

export function createLogStream({ streamEl, maxLines = 80, flushDelayMs = FLUSH_DELAY_MS } = {}) {
  let pending = [];
  let flushTimer = null;
  let readingDeferred = false;
  let snapshotDeferred = false;
  let refreshSeq = 0;
  let streamedDuringFetch = null;
  // DOM 尾部最后一行的本地日期 key:合批/seed 路径据此判断跨天批次是否需插分隔行。
  let lastDateKey = "";
  if (streamEl && !streamEl.firstElementChild) streamEl.innerHTML = LOG_STREAM_WAITING_HTML;

  function isAtBottom() {
    return streamEl.scrollHeight - streamEl.clientHeight <= streamEl.scrollTop + 12;
  }

  const hasContent = () => streamEl.firstElementChild && !isPlaceholder(streamEl.firstElementChild);

  function flush() {
    flushTimer = null;
    if (!streamEl || !pending.length) return;
    const atBottom = isAtBottom(); // 一批只读一次布局
    // 阅读中冻结已有 DOM，而非让窗口继续从头裁剪（那会删掉正在读的行）。
    // pending 仍按 maxLines 封顶；回到底部再接上最新日志，内存与 DOM 都不增长。
    if (!atBottom && hasContent()) {
      readingDeferred = true;
      return;
    }
    readingDeferred = false;
    const batch = pending.length > maxLines ? pending.slice(-maxLines) : pending;
    pending = [];
    const { rows, lastDateKey: lastKey } = buildLineRows(batch, lastDateKey, buildStreamLineHtml);
    // 第一行到了:先拿掉「等待第一条日志」占位(它不算日志行,也不该留在行上方)。
    if (isPlaceholder(streamEl.firstElementChild)) streamEl.removeChild(streamEl.firstElementChild);
    streamEl.insertAdjacentHTML("beforeend", rows.join(""));
    lastDateKey = lastKey;
    trimToMax(streamEl, maxLines); // 一批只裁一次
    if (atBottom) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function append(entry) {
    if (!streamEl || !entry) return;
    pending.push(entry);
    if (streamedDuringFetch) {
      streamedDuringFetch.push(entry);
      if (streamedDuringFetch.length > maxLines) streamedDuringFetch.shift();
    }
    // 缓冲自身也按 maxLines 封顶：突发刷入几十行时，只保留最终会留在 DOM 的尾部。
    if (pending.length >= maxLines * 2) pending = pending.slice(-maxLines);
    if (readingDeferred || flushTimer) return;
    flushTimer = setTimeout(flush, flushDelayMs);
  }

  async function refresh() {
    if (!streamEl) return;
    const seq = ++refreshSeq;
    // HTTP 回包之前 flush 也可能已跑完；单看 pending 会让这些新行被旧快照抹掉。
    const streamed = pending.slice();
    streamedDuringFetch = streamed;
    try {
      const { entries } = await getLogs({ limit: 50 });
      if (seq !== refreshSeq) return;
      // 断线后快照可能已不含正在读的旧行：此时不能重建后退回贴底。
      // 回到底部再补拉一次，届时仍按原有路径与 SSE 缓冲去重。
      if (!isAtBottom() && hasContent()) {
        readingDeferred = true;
        snapshotDeferred = true;
        return;
      }
      readingDeferred = false;
      snapshotDeferred = false;
      const fetched = Array.isArray(entries) ? entries : [];
      const seen = new Set(fetched.map(entryKey));
      const tail = streamed.filter((entry) => {
        const key = entryKey(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // 暂缓期间的 pending 可能早于快照最旧一行；先排时序，不能把它接到最新行之后。
      const list = fetched.concat(tail).sort((a, b) => a.ts - b.ts).slice(-maxLines);
      const { rows, lastDateKey: lastKey } = buildLineRows(list, "", buildStreamLineHtml);
      streamEl.innerHTML = rows.join("") || LOG_STREAM_WAITING_HTML;
      lastDateKey = lastKey;
      streamEl.scrollTop = streamEl.scrollHeight;
      // 这批已经一并落地，不再由既有 flush 定时器重复追加。
      pending = [];
    } catch { /* 断连时保留旧内容,SSE 恢复后由 onOpen 再刷 */ }
    finally { if (seq === refreshSeq) streamedDuringFetch = null; }
  }

  streamEl?.addEventListener?.("scroll", () => {
    if (!isAtBottom()) {
      if (!readingDeferred && hasContent()) {
        readingDeferred = true;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      }
      return;
    }
    readingDeferred = false;
    if (pending.length && !flushTimer) flushTimer = setTimeout(flush, flushDelayMs);
    if (snapshotDeferred) {
      snapshotDeferred = false;
      refresh();
    }
  }, { passive: true });

  return { append, refresh };
}
