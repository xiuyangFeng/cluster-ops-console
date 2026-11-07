// render/timeline-episodes.js —— 状态变更清单按「一阵」归组：一次断开到恢复往往是十来条变更挤在一两分钟里，
// 逐条平铺要一直往下滚。相邻两条相隔不到 gapMs 的算同一阵，每阵一张卡：时间范围、条数、最坏级别、
// 每个对象从头到尾的变化（收起时也看得到），逐条明细默认收起。
// 全是纯函数（Node 可测）；取数、明细行 HTML 与 DOM 写入在 render/diagnostics.js。
//
// 条目：已归一的变更 { ts, key, from, to, reason, layer } 或信号 { type: "signal", ts, severity, category, title }。
import { escapeHtml, formatRelativeTime, isAutoTriggered } from "../store.js";
import { spanText } from "./timeline-swim.js";
import { clockOf, dayKeyOf, monthDay } from "./usage-model.js";

export const EPISODE_GAP_MS = 5 * 60_000;
const TONE_RANK = { ok: 0, idle: 1, warn: 2, error: 3 };

const isSignal = (entry) => entry?.type === "signal";

// 一条的语气：变更看变到了什么，信号看严重度。
export function entryTone(entry) {
  if (isSignal(entry)) return entry.severity === "error" ? "error" : "warn";
  const to = String(entry?.to || "");
  return to === "ok" || to === "warn" || to === "error" ? to : "idle";
}

const worse = (a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a);

// 条目 → 阵列表（最新的一阵在前，阵内也是最新在前）。
// 每阵：{ id, start, end, items, tone（最坏）, outcome, autoCount, objects: [{ key, from, to, tone, count, signal }] }
//   outcome：bad = 结束时仍有对象停在警告 / 故障；recovered = 出过异常、都已回到正常；calm = 没出过异常。
//   objects 按首次出现排序；变更对象记首条的 from 与末条的 to，信号按类别合并计数。
export function groupEpisodes(entries, { gapMs = EPISODE_GAP_MS } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Number.isFinite(Number(e.ts)))
    .sort((a, b) => a.ts - b.ts);
  const episodes = [];
  let cur = null;
  for (const entry of list) {
    if (!cur || entry.ts - cur.end > gapMs) {
      cur = { start: entry.ts, end: entry.ts, items: [] };
      episodes.push(cur);
    }
    cur.end = entry.ts;
    cur.items.push(entry);
  }
  return episodes.reverse().map((ep) => summarizeEpisode(ep));
}

function summarizeEpisode({ start, end, items }) {
  const objects = new Map();
  let tone = "ok";
  let autoCount = 0;
  for (const entry of items) {
    const t = entryTone(entry);
    tone = worse(tone, t);
    if (isAutoTriggered(entry)) autoCount += 1;
    const signal = isSignal(entry);
    const key = signal ? `signal:${entry.category || entry.signalId || "signal"}` : String(entry.key || "");
    const obj = objects.get(key);
    if (!obj) {
      objects.set(key, { key, signal, from: signal ? "" : String(entry.from ?? ""), to: signal ? "" : String(entry.to ?? ""), tone: t, worst: t, count: 1, entry });
    } else {
      obj.count += 1;
      obj.worst = worse(obj.worst, t);
      if (signal) obj.tone = obj.worst;
      else {
        obj.to = String(entry.to ?? "");
        obj.tone = t;
      }
      obj.entry = entry;
    }
  }
  const objs = [...objects.values()];
  const stillBad = objs.some((o) => !o.signal && (o.tone === "warn" || o.tone === "error"));
  const hadBad = tone === "warn" || tone === "error";
  return {
    id: String(start),
    start,
    end,
    items: items.slice().reverse(),
    tone,
    outcome: stillBad ? "bad" : hadBad ? "recovered" : "calm",
    autoCount,
    objects: objs,
  };
}

export const OUTCOME_LABELS = Object.freeze({ bad: "仍有异常", recovered: "已恢复", calm: "常规变更" });

// 阵卡片 HTML。options：
//   open(ep) 是否展开；objectName(obj) 对象的界面用名；levelLabel(level) 级别用名；
//   rowHtml(entry) 明细一行（<li>）；live 实时视图（时刻带日期、附「x 分钟前」）；now 当前时刻；
//   maxChips 收起时最多列几个对象，其余写「+N」。
export function episodeHtml(ep, { open = false, objectName = (o) => o.key, levelLabel = (l) => l, rowHtml = () => "", live = false, now = Date.now(), maxChips = 6 } = {}) {
  const stamp = (ts) => {
    const sec = Math.floor(ts / 1000);
    return live && dayKeyOf(sec) !== dayKeyOf(Math.floor(now / 1000)) ? `${monthDay(dayKeyOf(sec))} ${clockOf(sec, { seconds: true })}` : clockOf(sec, { seconds: true });
  };
  const single = ep.end === ep.start;
  const when = single
    ? `<b>${escapeHtml(stamp(ep.start))}</b>`
    : `<b>${escapeHtml(stamp(ep.start))}</b><span class="tl-ep-dash">–</span>${escapeHtml(clockOf(Math.floor(ep.end / 1000), { seconds: true }))}`;
  const meta = [`${ep.items.length} 条`];
  if (!single) meta.push(`历时 ${spanText(ep.end - ep.start)}`);
  if (ep.autoCount) meta.push(`自动修复 ${ep.autoCount}`);
  const ago = live ? `<span class="tl-ep-ago">${escapeHtml(formatRelativeTime(ep.end, now))}</span>` : "";
  const chips = ep.objects.slice(0, maxChips).map((obj) => {
    const name = escapeHtml(objectName(obj));
    const change = obj.signal
      ? `<span class="tl-chip-to">${obj.count > 1 ? `× ${obj.count}` : "信号"}</span>`
      : `${obj.from && obj.from !== obj.to ? `<span class="tl-chip-from">${escapeHtml(levelLabel(obj.from))}</span><span class="tl-chip-arrow">→</span>` : ""}<span class="tl-chip-to">${escapeHtml(levelLabel(obj.to))}</span>`;
    // 中途坏过、最后好了：圆点用最坏的颜色描边，一眼看出「这里出过事」
    const dipped = !obj.signal && obj.worst !== obj.tone && TONE_RANK[obj.worst] >= TONE_RANK.warn;
    return `<span class="tl-chip" data-tone="${obj.tone}"${dipped ? ` data-dip="${obj.worst}"` : ""} title="${escapeHtml(obj.key)}"><i class="tl-chip-dot"></i><span class="tl-chip-name">${name}</span>${change}</span>`;
  });
  const more = ep.objects.length > maxChips ? `<span class="tl-chip tl-chip-more">+${ep.objects.length - maxChips}</span>` : "";
  return `<li class="tl-ep" data-tone="${ep.tone}" data-outcome="${ep.outcome}">
    <span class="tl-ep-node" aria-hidden="true"></span>
    <details class="tl-ep-card" data-ep="${escapeHtml(ep.id)}"${open ? " open" : ""}>
      <summary class="tl-ep-head">
        <span class="tl-ep-line">
          <span class="tl-ep-when">${when}</span>${ago}
          <span class="tl-ep-outcome">${OUTCOME_LABELS[ep.outcome]}</span>
          <span class="tl-ep-meta">${escapeHtml(meta.join(" · "))}</span>
          <span class="tl-ep-chev" aria-hidden="true"></span>
        </span>
        <span class="tl-ep-chips">${chips.join("")}${more}</span>
      </summary>
      <ul class="tl-ep-items">${ep.items.map((e) => rowHtml(e)).join("")}</ul>
    </details>
  </li>`;
}

// 列表上方的一行概况。
export function episodesBarText(episodes, { shown = episodes.length } = {}) {
  const total = episodes.reduce((n, ep) => n + ep.items.length, 0);
  const bad = episodes.filter((ep) => ep.outcome === "bad").length;
  const parts = [`${total} 条变更归为 ${episodes.length} 段`];
  if (bad) parts.push(`${bad} 段仍有异常`);
  if (shown !== episodes.length) parts.push(`显示 ${shown} 段`);
  return parts.join(" · ");
}

// 段落时间轴：窗口 [start, end] 里每段一个标记（位置 = 开始时刻，宽度 = 历时，至少一个点），点击跳到那张卡。
export function episodeStripHtml(episodes, { start, end }) {
  const span = Math.max(1, end - start);
  const marks = episodes
    .filter((ep) => ep.end >= start && ep.start <= end)
    .map((ep) => {
      const left = Math.max(0, Math.min(100, ((ep.start - start) / span) * 100));
      const width = Math.max(0, Math.min(100 - left, ((ep.end - ep.start) / span) * 100));
      const label = `${clockOf(Math.floor(ep.start / 1000))} · ${OUTCOME_LABELS[ep.outcome]} · ${ep.items.length} 条`;
      return `<button type="button" class="tl-strip-mark" data-tone="${ep.tone}" data-ep-jump="${escapeHtml(ep.id)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></button>`;
    });
  const edge = (ts) => (ts >= Date.now() - 60_000 ? "现在" : clockOf(Math.floor(ts / 1000)));
  return `<span class="tl-strip-label">${escapeHtml(clockOf(Math.floor(start / 1000)))}</span><span class="tl-strip-track">${marks.join("")}</span><span class="tl-strip-label">${escapeHtml(edge(end))}</span>`;
}
