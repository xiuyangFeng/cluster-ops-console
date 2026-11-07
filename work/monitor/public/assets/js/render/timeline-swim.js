// render/timeline-swim.js —— 状态变更时间线：泳道图的还原与绘制，以及清单 / 泳道共用的界面用名。
// 全是纯函数（Node 可测）；取数与 DOM 写入在 render/diagnostics.js。
//
// 数据：/api/history 的条目。
//   transition { ts, key, from, to, reason }：某个对象的级别变了；
//   levels { ts, cause, view, levels }：全量级别基线（lib/history-store.mjs）。
// 还原口径（键的含义见 lib/state/transitions.mjs）：
//   - 查看中的服务器不单列 tunnel:<id>，它的隧道状态由 channel 代表。这里按基线里的 view 把
//     channel 归到「那台服务器」那一行：切换查看视角之后各服务器的行仍然连续，不会出现一行里
//     混着两台服务器、另一行半路断掉的情况。
//   - 基线是全量快照：不在基线里的键从那一刻起就不再跟踪，画成无记录，不把旧状态延续下去。
//   - stop 标记到下一份基线之间是无记录（进程没在运行）。
//   - 第一份基线之前（旧版本留下的记录）只有变更：按「变更之前是 from」往回推到起点；没有发生过
//     变更的对象还原不出来；到了第一份基线却不在其中的键，最后一次变更之后那段不可信——
//     都画成无记录。
import { agentDisplayName, serverShortName } from "../display-names.js";
import { hourTicks } from "../line-chart.js";
import { escapeHtml } from "../store.js";
import { clockOf, dateLabel, dayKeyOf, monthDay } from "./usage-model.js";

const HOUR_MS = 3600_000;
const AGENT_PREFIX = "agent:";
const TUNNEL_PREFIX = "tunnel:";
const VALIDATION_PREFIX = "res:validation:";
const RESOURCE_PREFIX = "res:";
// 基线与触发它的那批变更同时落盘（基线取到的已经是变更之后的状态）：这么近的变更算同一批
const BATCH_MS = 2000;

// 泳道只需要这两类条目（/api/history?types=）
export const SWIM_ENTRY_TYPES = "transition,levels";

export const LEVEL_LABELS = Object.freeze({ ok: "正常", error: "故障", warn: "警告", waiting: "等待", skipped: "跳过", stopped: "停止", unknown: "未知" });
export const LAYER_LABELS = Object.freeze({ channel: "通道", agents: "Agent", resources: "资源", tunnels: "隧道" });
const REASON_LABELS = Object.freeze({
  ready: "就绪",
  degraded: "降级",
  "auth-required": "需登录",
  missing: "未安装",
  revoked: "设备已解绑",
  banned: "账号被封禁",
  waiting: "等待检测",
  "probe disabled": "检测已停用",
});
const TONE_LABELS = { ok: "正常", warn: "警告", error: "故障" };

// 变更原因 → 界面用语。后端的原因有三种：状态码（ready / degraded …）、探针报错（timeout after …）
// 与已经写成中文的句子；凭证过期提示会用「；」接在状态码后面。认不出的原样返回。
export function reasonLabel(reason) {
  const text = String(reason || "");
  if (!text) return "";
  const [head, ...rest] = text.split("；");
  const timeout = /^timeout after (\d+)ms$/.exec(head);
  const label = REASON_LABELS[head] || (timeout ? `检测超时（${Math.round(Number(timeout[1]) / 1000)} 秒）` : head);
  return [label, ...rest].join("；");
}

// 状态键 → 清单里的对象名。view：这条变更发生时查看的是哪台服务器（channel 才用得上，
// 不知道就留空——层名已经写了「通道」）。
export function objectLabel(key, { status, view = "" } = {}) {
  const k = String(key || "");
  if (k === "channel") return view ? serverShortName(status, view) : "";
  if (k.startsWith(AGENT_PREFIX)) return agentDisplayName(status, k.slice(AGENT_PREFIX.length));
  if (k.startsWith(TUNNEL_PREFIX)) return serverShortName(status, k.slice(TUNNEL_PREFIX.length));
  if (k.startsWith(VALIDATION_PREFIX)) return `环境校验 · ${serverShortName(status, k.slice(VALIDATION_PREFIX.length))}`;
  if (k.startsWith(RESOURCE_PREFIX)) return serverShortName(status, k.slice(RESOURCE_PREFIX.length));
  return k;
}

export function layerOfKey(key) {
  const k = String(key || "");
  if (k === "channel") return "channel";
  if (k.startsWith(AGENT_PREFIX)) return "agents";
  if (k.startsWith(TUNNEL_PREFIX)) return "tunnels";
  return "resources";
}

const isBaseline = (entry) => entry.type === "levels" && entry.levels && typeof entry.levels === "object";
const isTransition = (entry) => entry.type !== "levels" && typeof entry.key === "string" && entry.to != null;

// 基线序列 → 「某一时刻查看的是哪台服务器」。没有基线覆盖的时刻返回空串。
export function createViewResolver(entries) {
  const marks = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Number.isFinite(e.ts) && isBaseline(e) && e.cause !== "stop" && e.view)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({ ts: e.ts, view: String(e.view) }));
  return (ts) => {
    let view = "";
    for (const mark of marks) {
      if (mark.ts > ts) break;
      view = mark.view;
    }
    return view;
  };
}

// 条目 → 每个对象的状态变化点。返回 { lanes: Map<key, [{ t, level, reason }]>, baselineAt, extended }：
//   level 为 null 表示无记录；键已经归一（channel → tunnel:<当时查看的服务器>）。
//   start：要还原的时间范围起点；end：终点（之后的条目忽略）；currentView：没有任何基线时
//   把 channel 归给哪台（当前查看的服务器）。
//   baselineAt：第一份基线的时刻（没有为 null）；extended：它是否已往回补到起点。
export function reconstructLanes(entries, { start, end, currentView = "" } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Number.isFinite(e.ts) && e.ts <= end && (isBaseline(e) || isTransition(e)))
    .sort((a, b) => a.ts - b.ts);
  const firstBaseline = list.find((e) => isBaseline(e) && e.cause !== "stop") || null;
  const legacyView = String(firstBaseline?.view || currentView || "");
  const rangeStart = Math.min(start, list.length ? list[0].ts : start);
  const lanes = new Map();
  let view = legacyView;
  let anchored = false;

  const put = (key, t, level, reason = "") => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = [];
      lanes.set(key, lane);
    }
    // 同一时刻的后一条覆盖前一条（基线与同批变更、连续翻转）
    if (lane.length && lane[lane.length - 1].t === t) lane.pop();
    const last = lane[lane.length - 1];
    if (last && last.level === level) return;
    lane.push({ t, level, reason });
  };
  const canonical = (key, at) => (key === "channel" && at ? `${TUNNEL_PREFIX}${at}` : key);

  list.forEach((entry, index) => {
    if (isBaseline(entry)) {
      if (entry.cause === "stop") {
        for (const key of lanes.keys()) put(key, entry.ts, null);
        return;
      }
      const at = String(entry.view || "");
      const levels = new Map();
      for (const [key, level] of Object.entries(entry.levels)) {
        if (typeof level === "string" && level) levels.set(canonical(key, at), level);
      }
      if (!anchored) {
        if (entry.cause === "day") {
          // 跨天基线：进程一直在跑，零点到这份基线之间没有别的记录，状态就是基线里的样子——
          // 除了与基线同一批落盘的变更（基线取到的已是变更之后的状态），那些键此前是 from。
          const before = new Map();
          for (let i = index + 1; i < list.length && list[i].ts - entry.ts <= BATCH_MS; i += 1) {
            const next = list[i];
            if (!isTransition(next) || next.from == null) continue;
            const key = canonical(next.key, at);
            if (!before.has(key)) before.set(key, String(next.from));
          }
          for (const [key, level] of levels) {
            if (!lanes.has(key)) put(key, rangeStart, before.get(key) ?? level);
          }
        }
        // 旧记录里有、基线里没有的键：不知道它是什么时候停止跟踪的
        for (const [key, lane] of lanes) {
          if (levels.has(key) || !lane.length) continue;
          const tail = lane.pop();
          const prev = lane[lane.length - 1];
          if (!prev || prev.level !== null) lane.push({ t: tail.t, level: null, reason: "" });
        }
      }
      anchored = true;
      view = at;
      for (const key of new Set([...lanes.keys(), ...levels.keys()])) put(key, entry.ts, levels.get(key) ?? null);
      return;
    }
    // 查看中的那台不该有单列的隧道键（它由 channel 代表）：与归属冲突的旧记录不参与还原
    if (view && entry.key === `${TUNNEL_PREFIX}${view}`) return;
    const key = canonical(entry.key, view);
    if (!anchored && !lanes.has(key) && entry.from != null) put(key, rangeStart, String(entry.from));
    put(key, entry.ts, String(entry.to), String(entry.reason || ""));
  });
  return {
    lanes,
    baselineAt: firstBaseline ? firstBaseline.ts : null,
    extended: Boolean(firstBaseline && firstBaseline.cause === "day"),
  };
}

// 变化点 → 窗口内首尾相接的段 [{ from, to, level, reason }]（level null = 无记录）。
export function laneSegments(points, start, end) {
  const segments = [];
  const push = (from, to, level, reason) => {
    if (!(to > from)) return;
    const last = segments[segments.length - 1];
    if (last && last.level === level) last.to = to;
    else segments.push({ from, to, level, reason });
  };
  if (!points.length || points[0].t > start) push(start, Math.min(end, points.length ? points[0].t : end), null, "");
  points.forEach((point, index) => {
    push(Math.max(start, point.t), Math.min(end, index + 1 < points.length ? points[index + 1].t : end), point.level, point.reason);
  });
  return segments;
}

export function toneOfLevel(level) {
  if (level == null) return "none";
  return level === "ok" || level === "warn" || level === "error" ? level : "idle";
}

// 一行的统计：异常（警告 / 故障）连在一起算一段。
export function laneStats(segments) {
  const stats = { runs: 0, badMs: 0, okMs: 0, idleMs: 0, noneMs: 0 };
  let inRun = false;
  for (const seg of segments) {
    const tone = toneOfLevel(seg.level);
    const ms = seg.to - seg.from;
    if (tone === "warn" || tone === "error") {
      stats.badMs += ms;
      if (!inRun) stats.runs += 1;
      inRun = true;
      continue;
    }
    inRun = false;
    if (tone === "ok") stats.okMs += ms;
    else if (tone === "idle") stats.idleMs += ms;
    else stats.noneMs += ms;
  }
  return stats;
}

// 45 秒 / 24 分 / 3 小时 5 分
export function spanText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes / 60} 小时`;
}

export function laneStatText(stats) {
  if (stats.runs) return `异常 ${stats.runs} 段 · 共 ${spanText(stats.badMs)}`;
  if (!stats.idleMs && !stats.noneMs) return "全程正常";
  if (!stats.okMs) return stats.idleMs ? "全程跳过" : "无记录";
  return "无异常";
}

// 泳道的行：隧道（查看中的那台叫「通道」，排最前）→ 各 Agent → 资源采集 → 环境校验；
// 配置里已经没有、记录里还有的对象排在最后。
export function laneDefs(status, keys = []) {
  const view = String(status?.activeServerId || "");
  const serverIds = Object.keys(status?.serversBrief || {});
  const agentIds = (Array.isArray(status?.agents) ? status.agents : []).map((agent) => agent?.id).filter(Boolean);
  const defs = [];
  const seen = new Set();
  const add = (key, name) => {
    if (seen.has(key)) return;
    seen.add(key);
    defs.push({ key, name });
  };
  for (const id of [view, ...serverIds.filter((sid) => sid !== view)].filter(Boolean)) {
    add(`${TUNNEL_PREFIX}${id}`, `${id === view ? "通道" : "隧道"} · ${serverShortName(status, id)}`);
  }
  add("channel", "通道");
  for (const id of agentIds) add(`${AGENT_PREFIX}${id}`, agentDisplayName(status, id));
  for (const id of serverIds) add(`${RESOURCE_PREFIX}${id}`, `资源采集 · ${serverShortName(status, id)}`);
  for (const id of serverIds) add(`${VALIDATION_PREFIX}${id}`, `环境校验 · ${serverShortName(status, id)}`);
  for (const key of keys) {
    const label = objectLabel(key, { status });
    const layer = layerOfKey(key);
    add(key, layer === "tunnels" ? `隧道 · ${label}` : layer === "resources" && !key.startsWith(VALIDATION_PREFIX) ? `资源采集 · ${label}` : label || key);
  }
  return defs;
}

const stampOf = (ts, withDate) => {
  const sec = Math.floor(ts / 1000);
  return withDate ? `${monthDay(dayKeyOf(sec))} ${clockOf(sec)}` : clockOf(sec);
};

// 泳道图的展示模型。options：
//   start / end 窗口；live 是否「近 24 小时」（右端写「现在」、时刻带日期）；
//   status 取界面用名与当前查看的服务器；day 历史某天的日期串（标题用）。
// 返回 { title, rows: [{ key, name, stat, tone, segments: [{ left, width, tone, title }] }], ticks, endLabel, note }。
export function buildSwimModel(entries, { start, end, live = false, status = null, day = "" } = {}) {
  const span = Math.max(1, end - start);
  const { lanes, baselineAt, extended } = reconstructLanes(entries, { start, end, currentView: status?.activeServerId || "" });
  const fullDay = !live && end - start >= 24 * HOUR_MS;
  const endLabel = fullDay ? "24:00" : "现在";
  const rows = [];
  for (const def of laneDefs(status, [...lanes.keys()])) {
    const points = lanes.get(def.key);
    if (!points) continue;
    const segments = laneSegments(points, start, end);
    if (!segments.some((seg) => seg.level != null)) continue; // 窗口里完全没有记录的对象不占一行
    const stats = laneStats(segments);
    rows.push({
      key: def.key,
      name: def.name,
      stat: laneStatText(stats),
      tone: stats.runs ? "warn" : "",
      segments: segments
        .filter((seg) => toneOfLevel(seg.level) !== "ok") // 绿底就是正常，只把不正常的段画出来
        .map((seg) => {
          const tone = toneOfLevel(seg.level);
          const until = seg.to >= end ? endLabel : stampOf(seg.to, false);
          const when = `${stampOf(seg.from, live)} – ${until}`;
          const label = tone === "none" ? "没有记录" : tone === "idle" ? LEVEL_LABELS[seg.level] || seg.level : TONE_LABELS[tone];
          const reason = tone === "none" ? "" : reasonLabel(seg.reason);
          return {
            left: ((seg.from - start) / span) * 100,
            width: ((seg.to - seg.from) / span) * 100,
            tone,
            title: `${def.name}：${label} ${when}${tone === "none" ? "" : ` · ${spanText(seg.to - seg.from)}`}${reason ? ` · ${reason}` : ""}`,
          };
        }),
    });
  }
  const title = live
    ? "近 24 小时 · 每行一个对象，颜色段是它当时的状态"
    : `${dateLabel(day || dayKeyOf(Math.floor(start / 1000)))} ${fullDay ? "全天" : `· 截至 ${clockOf(Math.floor(end / 1000))}`}`;
  let note = "";
  if (baselineAt == null) note = "这段时间还没有状态基线（旧版本留下的记录），只能按变更还原：没有发生过变更的对象不显示。";
  else if (!extended && baselineAt - start > 10 * 60_000 && baselineAt < end) note = `${stampOf(baselineAt, live)} 之前没有状态基线：那一段只能按变更还原，还原不出来的画成无记录。`;
  return {
    title,
    rows,
    // 整点刻度离右端太近时让位给「现在 / 24:00」
    ticks: hourTicks(start, end - 0.6 * HOUR_MS, 6).map((tick) => ({ left: ((tick.t - start) / span) * 100, label: tick.label, strong: tick.strong })),
    endLabel,
    note,
  };
}

const pct = (value) => Number(value.toFixed(3));

export function swimHtml(model) {
  const legend = '<span class="tl-legend"><i class="tl-key"></i>正常<i class="tl-key" data-tone="warn"></i>警告<i class="tl-key" data-tone="error"></i>故障<i class="tl-key" data-tone="none"></i>跳过 / 无记录</span>';
  const head = `<div class="tl-head"><span>${escapeHtml(model.title)}</span>${legend}</div>`;
  if (!model.rows.length) return `${head}<p class="tl-empty">这段时间没有状态记录。</p>${model.note ? `<p class="tl-note">${escapeHtml(model.note)}</p>` : ""}`;
  const rows = model.rows.map((row) => {
    const segs = row.segments.map((seg) => `<span class="tl-seg" data-tone="${seg.tone}" style="left:${pct(seg.left)}%;width:max(2px, ${pct(seg.width)}%)" title="${escapeHtml(seg.title)}"></span>`).join("");
    return `<span class="tl-name" title="${escapeHtml(row.key)}">${escapeHtml(row.name)}</span><span class="tl-bar" role="img" aria-label="${escapeHtml(`${row.name}：${row.stat}`)}">${segs}</span><span class="tl-stat"${row.tone ? ` data-tone="${row.tone}"` : ""}>${escapeHtml(row.stat)}</span>`;
  }).join("");
  const ticks = model.ticks.map((tick) => `<span class="tl-tick${tick.strong ? " is-strong" : ""}" style="left:${pct(tick.left)}%">${escapeHtml(tick.label)}</span>`).join("");
  const axis = `<span aria-hidden="true"></span><span class="tl-axis" aria-hidden="true">${ticks}</span><span class="tl-now" aria-hidden="true">${escapeHtml(model.endLabel)}</span>`;
  return `${head}<div class="tl-rows">${rows}${axis}</div>${model.note ? `<p class="tl-note">${escapeHtml(model.note)}</p>` : ""}`;
}
