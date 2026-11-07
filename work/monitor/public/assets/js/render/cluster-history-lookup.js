// cluster-history-lookup.js —— 「我的历史」按需回查（v2.51；无 DOM，依赖全部注入，Node 可直接测）。
//
// 三件事都并在原历史表里，不另开面板：
//   1. 查询框：作业号（18036 / 13207_5）或日期（10-01 / 2026-09-28~10-01，一次最多 7 天）→ GET /api/jobs/lookup，
//      结果替换表格内容（「回到近 48 小时」恢复默认视图）。
//   2. 「更早…」：每次往前加载一天（48 小时窗口之前的那部分起），每段一次 SSH，段头写明覆盖范围。
//   3. 组内「加载更多」：GET /api/jobs/group，只读后端快照（0 SSH），游标绑定快照标识（live-… / q…）；
//      快照换代（新一轮采集 / 回查结果过期）后端回 409，这里如实说明并按新快照重取。
// 迟到保护：换服务器 / 新查询 / 回到 48 小时都会让 epoch +1，旧请求回来时直接丢弃，不覆盖新查询。
// 回查结果不触发提醒、取证与简报统计（后端 lib/jobs/lookup.mjs 保证）；这里只负责读与展示状态。
import { escapeHtml } from "../store.js";
import { formatCount } from "./cluster-model.js";
import { clockOf, dayKeyOf, monthDay, offsetDay } from "./usage-model.js";

export const LOOKUP_RANGE_DAYS_MAX = 7;
// 组内「加载更多」每次多取的条数与上限（与后端 HISTORY_GROUP_PAGE_MAX 一致）。
export const GROUP_PAGE_STEP = 100;
export const GROUP_PAGE_MAX = 1000;
const JOB_RE = /^\d{1,12}(?:_\d{1,9})?$/;
const HOUR_MS = 3_600_000;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export const LOOKUP_PLACEHOLDER = "作业号或日期，如 18036、10-01、09-28~10-01";
const PARSE_ERROR = "认不出：请输入作业号（如 18036、13207_5）或日期（如 10-01、2026-09-28~10-01）";

function realDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// 一个日期片段 → "YYYY-MM-DD"；省略年份时取今年，落在今天之后就算去年（查的是历史）。
function dateOf(part, today) {
  const text = String(part || "").trim();
  let match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text);
  if (match) return realDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-./](\d{1,2})$/.exec(text);
  if (!match) return null;
  const year = Number(today.slice(0, 4));
  const date = realDate(year, Number(match[1]), Number(match[2]));
  if (!date) return realDate(year - 1, Number(match[1]), Number(match[2]));
  return date > today ? realDate(year - 1, Number(match[1]), Number(match[2])) : date;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// "2026-10-03" → "10.3（周六）"；不是今年的带上年份。
export function dayLabel(day, now = Date.now()) {
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
  const year = day.slice(0, 4) === dayKeyOf(now / 1000).slice(0, 4) ? "" : `${day.slice(0, 4)}.`;
  return `${year}${monthDay(day)}（周${weekday}）`;
}

const rangeLabel = (from, to, now) => (from === to ? dayLabel(from, now) : `${dayLabel(from, now)} – ${dayLabel(to, now)}`);

// 查询框文本 → { kind: "none" } | { kind: "job", job, label } | { kind: "range", from, to, label } | { error }。
export function parseLookupInput(text, { now = Date.now() } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return { kind: "none" };
  if (JOB_RE.test(raw)) return { kind: "job", job: raw, label: `作业 ${raw}` };
  const parts = raw.split(/\s*(?:~|～|至|到|\.\.)\s*/);
  if (parts.length > 2) return { error: PARSE_ERROR };
  const today = dayKeyOf(now / 1000);
  const from = dateOf(parts[0], today);
  const to = parts.length === 2 ? dateOf(parts[1], today) : from;
  if (!from || !to) return { error: PARSE_ERROR };
  if (from > to) return { error: "起始日期晚于结束日期" };
  if (to > today) return { error: "不能查今天之后的日期" };
  if (daysBetween(from, to) + 1 > LOOKUP_RANGE_DAYS_MAX) return { error: `一次最多查 ${LOOKUP_RANGE_DAYS_MAX} 天；可以先查一段，再用「更早…」往前翻` };
  return { kind: "range", from, to, label: rangeLabel(from, to, now) };
}

// 近 48 小时视图的窗口起点（毫秒）：采集时刻往前 windowHours 小时；没有快照 → null。
export function liveWindowStart(liveData) {
  if (liveData?.state !== "ok" || !Number.isFinite(liveData.checkedAt)) return null;
  const hours = Number.isFinite(liveData.windowHours) && liveData.windowHours > 0 ? liveData.windowHours : 48;
  return liveData.checkedAt - hours * HOUR_MS;
}

// 「更早…」的下一段（纯函数）：{ key, params, label } | null（作业号查询 / 还没有 48 小时数据时没有）。
//   48 小时视图：先补窗口起点那一天在窗口之前的部分（endBefore = 窗口起点），之后每次一整天。
//   日期查询：从查询起始日的前一天开始，每次一整天。
export function nextEarlierSegment({ query = null, segments = [], liveData = null, now = Date.now() } = {}) {
  const last = segments.length ? segments[segments.length - 1] : null;
  let day = null;
  let endBefore = null;
  if (query?.kind === "job") return null;
  if (last?.params?.from) day = offsetDay(last.params.from, -1);
  else if (query?.kind === "range") day = offsetDay(query.from, -1);
  else {
    const start = liveWindowStart(liveData);
    if (start == null) return null;
    day = dayKeyOf(start / 1000);
    endBefore = start;
  }
  const label = endBefore == null ? dayLabel(day, now) : `${dayLabel(day, now)} ${clockOf(endBefore / 1000)} 之前`;
  return { key: `d:${day}${endBefore == null ? "" : `:${endBefore}`}`, params: { from: day, to: day, endBefore }, label };
}

function lookupUrl(serverId, params) {
  const base = `/api/jobs/lookup?serverId=${encodeURIComponent(serverId)}`;
  if (params.job) return `${base}&job=${encodeURIComponent(params.job)}`;
  return `${base}&from=${params.from}&to=${params.to}${Number.isFinite(params.endBefore) ? `&endBefore=${Math.floor(params.endBefore)}` : ""}`;
}

const extraKey = (snapshotId, groupKey) => `${snapshotId}\u0000${groupKey}`;
const errorText = (err) => err?.serverMessage || err?.message || "未知错误";

// onLiveExpired()：48 小时快照已换代（组内分页 409）时调用，由面板立即重读一次历史（读本机快照，不发 SSH）。
export function createLookupLoader({ getJson = null, onChange = null, onLiveExpired = null, now = () => Date.now() } = {}) {
  let serverId = null;
  let epoch = 0;
  let query = null; // null = 近 48 小时视图
  let segments = []; // [{ key, params, label, data, loading, error }]
  let extras = new Map(); // extraKey -> { snapshotId, key, limit, children, more, total, loading, error }
  let revision = 0;

  const bump = () => {
    revision += 1;
    onChange?.();
  };

  async function fetchSegment(segment) {
    if (!serverId || typeof getJson !== "function") return;
    const mine = epoch;
    const target = serverId;
    segment.loading = true;
    segment.error = "";
    bump();
    let res = null;
    let failure = "";
    try {
      res = await getJson(lookupUrl(target, segment.params));
    } catch (err) {
      failure = errorText(err);
    }
    // 等待期间换了服务器 / 发了新查询 / 回到了 48 小时：这份结果不要了。
    if (mine !== epoch || target !== serverId || !segments.includes(segment)) return;
    segment.loading = false;
    if (res?.disabled) segment.error = "「我的 Slurm 作业」监控已关闭";
    else if (res && typeof res === "object" && Array.isArray(res.rows)) segment.data = res;
    else segment.error = failure || "响应为空";
    bump();
  }

  // 去掉回查快照上的组内分页（新查询 / 回到 48 小时后它们不再显示）；48 小时快照上的保留。
  function dropLookupExtras() {
    for (const [key, entry] of extras) if (!entry.snapshotId.startsWith("live-")) extras.delete(key);
  }

  async function loadGroup(snapshotId, groupKey, limit) {
    if (!serverId || typeof getJson !== "function" || !snapshotId) return;
    const cache = extras;
    const mine = epoch;
    const live = snapshotId.startsWith("live-");
    const key = extraKey(snapshotId, groupKey);
    const prev = cache.get(key);
    if (prev?.loading) return;
    const want = Math.max(1, Math.min(GROUP_PAGE_MAX, Math.floor(limit) || GROUP_PAGE_STEP));
    cache.set(key, { ...(prev || { children: null, more: 0, total: 0 }), snapshotId, key: groupKey, limit: want, loading: true, error: "" });
    bump();
    let entry;
    try {
      const res = await getJson(`/api/jobs/group?serverId=${encodeURIComponent(serverId)}&snapshot=${encodeURIComponent(snapshotId)}&key=${encodeURIComponent(groupKey)}&limit=${want}`);
      entry = Array.isArray(res?.children)
        ? { snapshotId, key: groupKey, limit: want, children: res.children, more: Number(res.more) || 0, total: Number(res.total) || 0, loading: false, error: "" }
        : { ...(prev || {}), snapshotId, key: groupKey, limit: want, loading: false, error: res?.disabled ? "「我的 Slurm 作业」监控已关闭" : "响应为空" };
    } catch (err) {
      const expired = err?.status === 409;
      entry = {
        ...(prev || { children: null, more: 0, total: 0 }),
        snapshotId,
        key: groupKey,
        limit: want,
        loading: false,
        expired,
        error: expired ? (live ? "列表已随新一轮采集刷新，正在按新数据重新读取…" : "查询结果已过期，请重新查询") : errorText(err),
      };
    }
    // 换了服务器（缓存整份换掉）/ 回查快照所属的查询已被取代：不要了。
    if (cache !== extras || (!live && mine !== epoch)) return;
    cache.set(key, entry);
    bump();
    if (entry.expired && live) onLiveExpired?.();
  }

  return {
    setServer(id) {
      const next = id || null;
      if (next === serverId) return;
      serverId = next;
      epoch += 1;
      query = null;
      segments = [];
      extras = new Map();
    },
    // 查询框提交（parsed 来自 parseLookupInput，kind 为 job / range）。
    search(parsed) {
      if (!parsed || (parsed.kind !== "job" && parsed.kind !== "range")) return Promise.resolve();
      epoch += 1;
      dropLookupExtras();
      query = parsed;
      const segment = {
        key: parsed.kind === "job" ? `j:${parsed.job}` : `r:${parsed.from}:${parsed.to}`,
        params: parsed.kind === "job" ? { job: parsed.job } : { from: parsed.from, to: parsed.to, endBefore: null },
        label: parsed.label,
        data: null,
        loading: false,
        error: "",
      };
      segments = [segment];
      return fetchSegment(segment);
    },
    backToLive() {
      if (!query && !segments.length) return;
      epoch += 1;
      query = null;
      segments = [];
      dropLookupExtras();
      bump();
    },
    // 「更早…」：有段在加载时不叠加新的一段。
    loadEarlier(liveData) {
      if (segments.some((s) => s.loading)) return Promise.resolve();
      const next = nextEarlierSegment({ query, segments: query ? segments.slice(1) : segments, liveData, now: now() });
      if (!next) return Promise.resolve();
      const segment = { ...next, data: null, loading: false, error: "" };
      segments = [...segments, segment];
      return fetchSegment(segment);
    },
    retry(segmentKey) {
      const segment = segments.find((s) => s.key === segmentKey);
      if (segment && !segment.loading) return fetchSegment(segment);
      return Promise.resolve();
    },
    // 48 小时窗口已随采集后移：把「窗口之前」那一段的上界挪到新的窗口起点重查（一次 SSH，用户点了才做）。
    refillGap(liveData) {
      const start = liveWindowStart(liveData);
      const first = !query ? segments[0] : null;
      if (start == null || !first || !Number.isFinite(first.params.endBefore) || first.loading) return Promise.resolve();
      const day = dayKeyOf(start / 1000);
      const next = { from: day, to: day, endBefore: start };
      first.params = next;
      first.key = `d:${day}:${start}`;
      first.label = `${dayLabel(day, now())} ${clockOf(start / 1000)} 之前`;
      first.data = null;
      return fetchSegment(first);
    },
    loadGroup,
    // 48 小时快照换代：旧快照上展开过的组内分页按新快照、同样条数重取（只读本机，0 SSH）。
    syncLive(snapshotId) {
      for (const [key, entry] of [...extras]) {
        if (!entry.snapshotId.startsWith("live-") || entry.snapshotId === snapshotId) continue;
        extras.delete(key);
        if (snapshotId && (entry.expired || Array.isArray(entry.children))) loadGroup(snapshotId, entry.key, entry.limit);
      }
    },
    state: () => ({ serverId, query, segments, extras, revision }),
  };
}

export const groupExtraOf = (extras, snapshotId, groupKey) => (extras instanceof Map && snapshotId ? extras.get(extraKey(snapshotId, groupKey)) || null : null);

// ---- HTML 片段（纯字符串；动态文案一律 escapeHtml） ----

// 段头：「10.3（周六）· 916 个已结束 · 3 失败 / 超时 · 2 取消」；加载中 / 失败也写在这一行。
export function buildSegmentRowHtml(row, columns) {
  const retry = row.retry ? ` <button type="button" class="text-btn" data-cl-lookup-retry="${escapeHtml(row.key)}">重试</button>` : "";
  return `<tr class="cl-hist-seg" data-segment="${escapeHtml(row.key)}"><td class="cl-hist-seg-cell" colspan="${columns}">` +
    `<span class="cl-hist-seg-label">${escapeHtml(row.label)}</span>` +
    (row.text ? `<span class="cl-hist-seg-text">${escapeHtml(row.text)}</span>` : "") +
    retry +
    "</td></tr>";
}

// 组内「还有 N 个」：能继续加载时带按钮（data-cl-group-more = 快照标识 + 组 key + 条数）。
export function buildMoreRowHtml(row, columns) {
  const action = row.action
    ? ` <button type="button" class="text-btn cl-group-more-btn" data-cl-group-more="${escapeHtml(row.action.snapshot)}" data-cl-group-key="${escapeHtml(row.action.group)}" data-cl-group-limit="${escapeHtml(String(row.action.limit))}"${row.loading ? " disabled" : ""}>${row.loading ? "加载中…" : escapeHtml(row.action.label)}</button>`
    : "";
  return `<tr class="cl-group-child cl-group-more" data-kind="${escapeHtml(row.rowKind)}" data-parent="${escapeHtml(row.parent)}"><td class="cl-group-more-cell" colspan="${columns}">${escapeHtml(row.text)}${action}${row.error ? ` <span class="cl-diag-muted">${escapeHtml(row.error)}</span>` : ""}</td></tr>`;
}

// 表格下方的覆盖范围与「更早…」（模型见 cluster-history-model.js 的 lookupBar）。
export function buildLookupBarHtml(bar) {
  if (!bar?.visible) return "";
  return [
    bar.text ? `<span class="cl-hist-cover">${escapeHtml(bar.text)}</span>` : "",
    bar.gap ? `<span class="cl-hist-cover">${escapeHtml(bar.gap)}</span><button type="button" class="text-btn" data-cl-lookup-refill="1">补齐</button>` : "",
    bar.earlier ? `<button type="button" class="text-btn cl-hist-earlier" data-cl-lookup-earlier="1" title="${escapeHtml(bar.earlier.title)}"${bar.earlier.disabled ? " disabled" : ""}>${escapeHtml(bar.earlier.label)}</button>` : "",
  ].join("");
}

// 段 / 查询的一行合计文字（纯函数，模型与测试共用）。
export function segmentSummaryText(data) {
  const s = data?.summary || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const plus = data?.truncated ? "+" : "";
  const parts = [`${formatCount(n(s.ended))}${plus} 个已结束`];
  if (n(s.failed)) parts.push(`${formatCount(n(s.failed))}${plus} 失败 / 超时`);
  if (n(s.cancelled)) parts.push(`${formatCount(n(s.cancelled))}${plus} 取消`);
  return parts.join(" · ");
}
