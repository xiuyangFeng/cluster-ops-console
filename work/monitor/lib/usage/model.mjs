// Agent 用量聚合（纯函数，无 IO）：把 store.snapshot() 的调用 / 轮次 / 会话投影成用量页的视图。
// 快照里的记录就是存储表里的那批对象（不是副本，见 store.mjs「内存里的记录」）：这里只读，绝不修改。
//
// 口径（与设计稿一致，全页只有这一套）：
//   四个基础量：普通输入 inFresh、缓存写入 cacheWrite、缓存读取 cacheRead、输出 output
//   输入合计 = 前三者之和；总 Token = 输入合计 + 输出；未命中输入 = 普通输入 + 缓存写入
//   归日 / 时刻：一律北京时间（lib/usage/time.mjs），按每次调用自己的时间（跨零点的会话拆到两天）
//   状态：最近 5 分钟有新日志 = recent（近期活跃）；今天有记录但 5 分钟内没有 = quiet；更早 = past
//   失败调用不计 Token；没有状态码的失败另按错误原文归类计数（causes，见 error-text.mjs）；上下文 = 最近一次成功主线调用的输入合计 ÷ 窗口
//   （Codex 窗口来自日志 model_context_window；Claude 日志不记录，按模型名 / 观测值推断，标 estimated）

import { errorKindOf } from "./error-text.mjs";
import { dayKeyOf, offsetDay, secondsOfDay, USAGE_TZ_LABEL } from "./time.mjs";

export const RECENT_SECONDS = 300;
export const AGENT_IDS = ["codex", "claude", "antigravity", "gemini", "zcode", "opencode", "cursor", "custom"];
const AGENT_ID_SET = new Set(AGENT_IDS);
const CLAUDE_DEFAULT_WINDOW = 200_000;
const CLAUDE_LONG_WINDOW = 1_000_000;

// 按模型族估算等效 API 单价（USD / 1M Tokens），用于折算等效花费（costUsd）与缓存净节省（savedUsd）。
const PRICING_CLAUDE_OPUS = { input: 15, inFresh: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 };
const PRICING_CLAUDE_HAIKU = { input: 0.8, inFresh: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 };
const PRICING_CLAUDE_SONNET = { input: 3, inFresh: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
const PRICING_CODEX_MINI = { input: 0.4, inFresh: 0.4, cacheWrite: 0.4, cacheRead: 0.1, output: 1.6 };
const PRICING_CODEX_STANDARD = { input: 2.5, inFresh: 2.5, cacheWrite: 2.5, cacheRead: 0.625, output: 10 };
const PRICING_GEMINI_FLASH = { input: 0.3, inFresh: 0.3, cacheWrite: 0.3, cacheRead: 0.075, output: 2.5 };
const PRICING_GEMINI_PRO = { input: 1.25, inFresh: 1.25, cacheWrite: 1.25, cacheRead: 0.3125, output: 10 };

// 按 Agent → 模型名缓存单价（perf）：摘要每次对范围内的每次调用估价好几遍（总量 / Agent / 模型 / 项目 / 会话），
// 每次都 toLowerCase + 一串 includes 占了一次 30 天摘要约四分之一的时间。模型名只有十几个，两级 Map 免拼键。
const pricingCache = new Map(); // agent -> Map(model -> 单价表)
const PRICING_CACHE_MAX = 256;

export function modelPricingOf(model, agent = "claude") {
  let byModel = pricingCache.get(agent);
  if (!byModel) {
    if (pricingCache.size >= PRICING_CACHE_MAX) pricingCache.clear();
    byModel = new Map();
    pricingCache.set(agent, byModel);
  }
  let pricing = byModel.get(model);
  if (pricing === undefined) {
    pricing = pricingOf(model, agent);
    if (byModel.size >= PRICING_CACHE_MAX) byModel.clear();
    byModel.set(model, pricing);
  }
  return pricing;
}

function pricingOf(model, agent) {
  const m = String(model || "").toLowerCase();
  if (m.includes("opus")) return PRICING_CLAUDE_OPUS;
  if (m.includes("haiku")) return PRICING_CLAUDE_HAIKU;
  if (m.includes("sonnet") || m.includes("claude")) return PRICING_CLAUDE_SONNET;
  if (m.includes("gemini") && (m.includes("flash") || m.includes("lite"))) return PRICING_GEMINI_FLASH;
  if (m.includes("gemini")) return PRICING_GEMINI_PRO;
  if (m.includes("mini") || m.includes("nano") || m.includes("glm") || m.includes("deepseek")) return PRICING_CODEX_MINI;
  if (m.includes("gpt") || m.includes("codex") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return PRICING_CODEX_STANDARD;
  if (agent === "gemini" || agent === "antigravity") return PRICING_GEMINI_PRO;
  return agent === "codex" ? PRICING_CODEX_STANDARD : PRICING_CLAUDE_SONNET;
}

export function estimateCallCost(call) {
  if (!call || !call.ok) return { costUsd: 0, savedUsd: 0 };
  const p = modelPricingOf(call.model, call.agent);
  const inFresh = Number(call.inFresh) || 0;
  const cacheWrite = Number(call.cacheWrite) || 0;
  const cacheRead = Number(call.cacheRead) || 0;
  const output = Number(call.output) || 0;
  const costUsd = (inFresh * p.inFresh + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead + output * p.output) / 1_000_000;
  const savedRaw = (cacheRead * (p.inFresh - p.cacheRead) - cacheWrite * Math.max(0, p.cacheWrite - p.inFresh)) / 1_000_000;
  return { costUsd, savedUsd: Math.max(0, savedRaw) };
}

const roundUsd = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

const emptyStats = () => ({ calls: 0, errors: 0, codes: {}, causes: {}, inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0, savedUsd: 0 });
function addCall(stats, call, estimate = null) {
  stats.calls += 1;
  if (!call.ok) {
    stats.errors += 1;
    const code = call.code ?? "error";
    stats.codes[code] = (stats.codes[code] ?? 0) + 1;
    if (call.code === null || call.code === undefined) {
      const kind = errorKindOf(call);
      stats.causes[kind] = (stats.causes[kind] ?? 0) + 1;
    }
    return stats;
  }
  stats.inFresh += call.inFresh;
  stats.cacheWrite += call.cacheWrite;
  stats.cacheRead += call.cacheRead;
  stats.output += call.output;
  // Also used as Array.reduce callback, whose third argument is an index.
  const { costUsd, savedUsd } = estimate && typeof estimate === "object" ? estimate : estimateCallCost(call);
  stats.costUsd += costUsd;
  stats.savedUsd += savedUsd;
  return stats;
}
const totalOf = (s) => s.inFresh + s.cacheWrite + s.cacheRead + s.output;
const freshOf = (s) => s.inFresh + s.cacheWrite;
const inputOf = (s) => s.inFresh + s.cacheWrite + s.cacheRead;
const statsView = (s) => ({
  ...s,
  costUsd: roundUsd(s.costUsd),
  savedUsd: roundUsd(s.savedUsd),
  total: totalOf(s),
  fresh: freshOf(s),
  hitRate: inputOf(s) ? s.cacheRead / inputOf(s) : null,
});

export const sessionKeyOf = (rec) => `${rec.serverId}|${rec.agent}|${rec.sid}`;

export { offsetDay };

// ~/xxx 与末段名：项目标签取末段；同名末段在 projectLabels 里再补一级父目录区分。
export function projectPath(cwd, home) {
  if (!cwd) return null;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function projectLabels(paths) {
  const segs = (p) => p.split("/").filter(Boolean);
  const byLast = new Map();
  for (const p of paths) {
    const last = segs(p).at(-1) ?? p;
    byLast.set(last, (byLast.get(last) ?? 0) + 1);
  }
  const labels = new Map();
  for (const p of paths) {
    const parts = segs(p);
    const last = parts.at(-1) ?? p;
    labels.set(p, byLast.get(last) > 1 && parts.length > 1 ? parts.slice(-2).join("/") : last);
  }
  return labels;
}

export function claudeWindow(model, maxPrompt) {
  const m = String(model || "").toLowerCase();
  if (model?.includes("[1m]") || m.includes("gemini") || maxPrompt > CLAUDE_DEFAULT_WINDOW) return CLAUDE_LONG_WINDOW;
  return CLAUDE_DEFAULT_WINDOW;
}

const zeroByAgent = () => Object.fromEntries(AGENT_IDS.map((id) => [id, 0]));

// 会话索引：key → 会话（调用按时间排好）；callEntry[i] / turnEntry[i] = 第 i 次调用 / 轮次所属的会话。
// 按快照对象缓存（perf）：快照在服务里按数据版本缓存，同一份会被 15s 一次的摘要轮询、今日简报、会话详情反复用；
// 此前每次都给每次调用重拼几遍会话键再查表，一次摘要约 70–150ms，几乎全花在这里。
const sessionIndexCache = new WeakMap(); // snapshot -> { homesKey, byKey, callEntry, turnEntry }

export const HIGH_COMPACT_THRESHOLD = 3;
export const LOW_CACHE_MIN_OK_CALLS = 8;
export const LOW_CACHE_MAX_HIT_RATE = 0.3;
export const LOW_CACHE_MIN_FRESH_TOKENS = 50_000;

// 会话级上下文健康诊断：高频上下文压缩（≥3 次）或缓存命中率偏低（成功调用 ≥8 次、未命中 ≥50k 且命中率 <30%）。
export function evaluateSessionHealth(stats, compactCount = 0) {
  const compacts = Number(compactCount) || 0;
  if (compacts >= HIGH_COMPACT_THRESHOLD) {
    return {
      kind: "high-compact",
      tone: "warn",
      label: `压缩 ${compacts} 次`,
      detail: `本会话已触发 ${compacts} 次上下文压缩，历史细节可能丢失并推高未命中输入，建议适时新开会话`,
    };
  }
  const okCalls = (Number(stats?.calls) || 0) - (Number(stats?.errors) || 0);
  const hitRate = stats?.hitRate;
  const fresh = Number(stats?.fresh) || 0;
  if (okCalls >= LOW_CACHE_MIN_OK_CALLS && hitRate !== null && hitRate !== undefined && hitRate < LOW_CACHE_MAX_HIT_RATE && fresh >= LOW_CACHE_MIN_FRESH_TOKENS) {
    const pct = (hitRate * 100).toFixed(1);
    return {
      kind: "low-cache",
      tone: "warn",
      label: `命中偏低 ${Math.round(hitRate * 100)}%`,
      detail: `缓存命中率仅 ${pct}%（未命中输入已达 ${Math.round(fresh / 1000)}k Token），建议检查长上下文变动或新开会话`,
    };
  }
  return null;
}

function indexSessions(snapshot, homes) {
  const homesKey = JSON.stringify(homes ?? {});
  const hit = sessionIndexCache.get(snapshot);
  if (hit && hit.homesKey === homesKey) return hit;
  const meta = new Map();
  for (const s of snapshot.sessions) meta.set(sessionKeyOf(s), s);
  const byKey = new Map();
  const callEntry = new Array(snapshot.calls.length);
  for (let i = 0; i < snapshot.calls.length; i += 1) {
    const call = snapshot.calls[i];
    const key = sessionKeyOf(call);
    let entry = byKey.get(key);
    if (!entry) {
      const m = meta.get(key) || {};
      const project = projectPath(m.cwd, homes?.[call.serverId]) ?? "（未知目录）";
      entry = { key, serverId: call.serverId, agent: call.agent, sid: call.sid, cwd: m.cwd || null, project, window: m.window ?? null, calls: [], compacts: 0 };
      byKey.set(key, entry);
    }
    entry.calls.push(call);
    callEntry[i] = entry;
  }
  for (const c of Array.isArray(snapshot.compacts) ? snapshot.compacts : []) {
    const entry = byKey.get(sessionKeyOf(c));
    if (entry) entry.compacts += 1;
  }
  for (const entry of byKey.values()) entry.calls.sort((a, b) => a.t - b.t);
  const turnEntry = snapshot.turns.map((turn) => byKey.get(sessionKeyOf(turn)));
  const index = { homesKey, byKey, callEntry, turnEntry };
  if (snapshot && typeof snapshot === "object") sessionIndexCache.set(snapshot, index);
  return index;
}

function sessionRow(entry, nowSec, today) {
  // A snapshot is immutable. Reuse only its small lifetime aggregate; status still
  // follows the request clock. No second copy of calls or history is retained.
  if (entry.row) return { ...entry.row, status: nowSec - entry.row.last <= RECENT_SECONDS ? "recent" : entry.row.day === today ? "quiet" : "past" };
  const stats = entry.calls.reduce(addCall, emptyStats());
  let lastMain = null;
  let maxPrompt = 0;
  for (const call of entry.calls) {
    if (!call.ok) continue;
    maxPrompt = Math.max(maxPrompt, call.prompt);
    if (!call.sidechain) lastMain = call;
  }
  const lastOk = lastMain ?? [...entry.calls].reverse().find((c) => c.ok) ?? null;
  const model = lastOk?.model ?? entry.calls.find((c) => c.model)?.model ?? null;
  const hasExactWindow = entry.agent !== "claude" && Number.isFinite(entry.window) && entry.window > 0;
  const estimated = !hasExactWindow;
  const window = entry.agent === "codex" ? entry.window : (hasExactWindow ? entry.window : claudeWindow(model, maxPrompt));
  const first = entry.calls[0].t;
  const last = entry.calls.at(-1).t;
  const status = nowSec - last <= RECENT_SECONDS ? "recent" : dayKeyOf(last) === today ? "quiet" : "past";
  const viewStats = statsView(stats);
  const compactCount = entry.compacts || 0;
  entry.row = {
    key: entry.key,
    serverId: entry.serverId,
    agent: entry.agent,
    sid: entry.sid,
    project: entry.project,
    model,
    first,
    last,
    day: dayKeyOf(last),
    status,
    stats: viewStats,
    compactCount,
    healthHint: evaluateSessionHealth(viewStats, compactCount),
    context: lastOk ? { tokens: lastOk.prompt, window: window || null, ratio: window ? lastOk.prompt / window : null, estimated } : null,
  };
  return { ...entry.row };
}

const modelKeyOf = (call) => String(call.model || "").trim() || `${call.agent}-default`;
function matches(call, sessionMeta, { agent, project, model = "all" }) {
  if (agent !== "all" && call.agent !== agent) return false;
  if (project !== "all" && sessionMeta?.project !== project) return false;
  if (model !== "all" && modelKeyOf(call) !== model) return false;
  return true;
}

export function scopeOf({ range = 1, date = null, today }) {
  if (date) return { start: date, end: date, days: 1, single: true };
  const days = [1, 7, 30].includes(range) ? range : 1;
  return { start: offsetDay(today, 1 - days), end: today, days, single: days === 1 };
}

export function buildUsageSummary(snapshot, { nowSec, range = 1, date = null, agent = "all", project = "all", model = "all", homes = {}, coverageStart = null, snapshotStart = null, sources = [] } = {}) {
  const today = dayKeyOf(nowSec);
  const scope = scopeOf({ range, date, today });
  const { callEntry, turnEntry } = indexSessions(snapshot, homes);
  const calls = snapshot.calls;
  const filters = { agent, project, model };
  const previousScope = { start: offsetDay(scope.start, -scope.days), end: offsetDay(scope.start, -1) };
  const cutoff = scope.end === today ? secondsOfDay(nowSec) : Infinity;
  const previousStats = emptyStats();
  const scopedSessions = new Map();

  const detectedSet = new Set(["codex", "claude"]);
  for (const src of Array.isArray(sources) ? sources : []) {
    for (const a of Array.isArray(src?.installed) ? src.installed : []) if (AGENT_IDS.includes(a)) detectedSet.add(a);
    if (src?.roots && typeof src.roots === "object") {
      for (const a of AGENT_IDS) if (src.roots[a] === true) detectedSet.add(a);
    }
  }

  const stats = emptyStats();
  const touched = new Set(); // 会话（索引里的同一个对象）
  const modelMap = new Map();
  const agentStatsMap = new Map(AGENT_IDS.map((id) => [id, { stats: emptyStats(), sessions: new Set(), turnSum: 0, turnCount: 0 }]));

  // 趋势：今天只画到当前时刻（横向铺满）；当天不足 6 小时按 15 分钟一档，否则按小时。
  // 最后一档还没过完（partial），前端画虚线，避免「末尾下跌」的假象。历史某天画完整 24 小时，多日按天。
  const isToday = scope.single && scope.start === today;
  const nowMinutes = Math.floor(secondsOfDay(nowSec) / 60);
  const granularity = !scope.single ? "day" : isToday && nowMinutes < 6 * 60 ? "quarter" : "hour";
  const slotMinutes = granularity === "quarter" ? 15 : 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  let buckets;
  if (granularity === "day") {
    buckets = Array.from({ length: scope.days }, (_, i) => {
      const day = offsetDay(scope.end, i + 1 - scope.days);
      return { key: day, label: `${Number(day.slice(5, 7))}.${Number(day.slice(8))}`, ...zeroByAgent(), calls: 0, errors: 0, partial: day === today };
    });
  } else {
    const count = isToday ? Math.floor(nowMinutes / slotMinutes) + 1 : 24;
    buckets = Array.from({ length: count }, (_, i) => {
      const minutes = i * slotMinutes;
      return { key: i, label: `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`, ...zeroByAgent(), calls: 0, errors: 0, partial: isToday && i === count - 1 };
    });
  }
  const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]));

  // 日历：近 62 天（覆盖「近 30 天」与上 / 本自然月），同样受 Agent / 项目筛选
  const calendarStart = offsetDay(today, -61);
  const calendar = {};
  // 项目：不受项目筛选（用来选项目），受 Agent 筛选
  const projects = new Map();

  // 一趟扫完全部调用（perf）：总量 / 各 Agent / 模型、趋势分档、日历、项目、出现过的 Agent 原来各扫一遍
  // （近 30 天摘要要把十万条调用扫五六遍）。各自的筛选条件与累加顺序不变，结果逐字段相同。
  const anyAgent = agent === "all";
  const anyProject = project === "all";
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const meta = callEntry[i];
    const day = call.day;
    if (AGENT_ID_SET.has(call.agent)) detectedSet.add(call.agent);
    const agentOk = anyAgent || call.agent === agent;
    const projectOk = anyProject || meta?.project === project;
    const modelOk = model === "all" || modelKeyOf(call) === model;
    if (agentOk && projectOk && modelOk && day >= previousScope.start && day <= previousScope.end && (day !== previousScope.end || secondsOfDay(call.t) <= cutoff)) addCall(previousStats, call);
    if (!modelOk) continue;
    if (agentOk && projectOk && day >= calendarStart) {
      if (!calendar[day]) calendar[day] = { calls: 0, tokens: 0 };
      const cell = calendar[day];
      cell.calls += 1;
      if (call.ok) cell.tokens += call.inFresh + call.cacheWrite + call.cacheRead + call.output;
    }
    if (day < scope.start || day > scope.end) continue;
    const estimate = call.ok ? estimateCallCost(call) : null;
    if (projectOk) {
      const agBucket = agentStatsMap.get(call.agent);
      if (agBucket) {
        addCall(agBucket.stats, call, estimate);
        if (meta) agBucket.sessions.add(meta);
      }
    }
    if (!agentOk) continue;
    const projectKey = meta?.project ?? "（未知目录）";
    if (!projects.has(projectKey)) projects.set(projectKey, { key: projectKey, sessions: new Set(), stats: emptyStats(), byAgent: zeroByAgent() });
    const projectRow = projects.get(projectKey);
    addCall(projectRow.stats, call, estimate);
    projectRow.sessions.add(meta);
    if (call.ok) projectRow.byAgent[call.agent] = (projectRow.byAgent[call.agent] || 0) + call.inFresh + call.cacheWrite + call.cacheRead + call.output;
    if (!projectOk) continue;
    addCall(stats, call, estimate);
    touched.add(meta);
    if (!scopedSessions.has(meta)) scopedSessions.set(meta, emptyStats());
    addCall(scopedSessions.get(meta), call, estimate);
    const mKey = modelKeyOf(call);
    if (!modelMap.has(mKey)) {
      modelMap.set(mKey, { model: mKey, agent: call.agent, stats: emptyStats(), agents: new Set() });
    }
    const mRow = modelMap.get(mKey);
    addCall(mRow.stats, call, estimate);
    if (call.agent) mRow.agents.add(call.agent);
    const bucket = buckets[bucketIndex.get(granularity === "day" ? day : Math.floor(secondsOfDay(call.t) / 60 / slotMinutes))];
    if (bucket) {
      bucket.costUsd = (bucket.costUsd || 0) + (estimate?.costUsd || 0);
      if (call.ok) {
        bucket.input = (bucket.input || 0) + inputOf(call);
        bucket.cacheRead = (bucket.cacheRead || 0) + call.cacheRead;
      }
      bucket.calls += 1;
      if (!call.ok) bucket.errors += 1;
      else bucket[call.agent] = (bucket[call.agent] || 0) + call.inFresh + call.cacheWrite + call.cacheRead + call.output;
    }
  }
  for (const s of Array.isArray(snapshot.sessions) ? snapshot.sessions : []) if (AGENT_ID_SET.has(s.agent)) detectedSet.add(s.agent);
  const detectedAgents = AGENT_IDS.filter((a) => detectedSet.has(a));

  // 未命中输入与前 7 天同一时段的日均比较（只在单日视图有意义；采集起始之前的日子不计入）
  let freshVsAvg = null;
  if (scope.single) {
    const validDays = Array.from({ length: 7 }, (_, i) => offsetDay(scope.start, -1 - i)).filter((d) => !coverageStart || d >= coverageStart);
    if (validDays.length) {
      const cutoff = scope.start === today ? secondsOfDay(nowSec) : Infinity;
      const set = new Set(validDays);
      const prev = emptyStats();
      for (let i = 0; i < calls.length; i += 1) {
        const call = calls[i];
        if (!set.has(call.day) || !matches(call, callEntry[i], filters) || secondsOfDay(call.t) > cutoff) continue;
        addCall(prev, call);
      }
      const base = freshOf(prev) / validDays.length;
      freshVsAvg = base > 0 ? { ratio: freshOf(stats) / base, days: validDays.length, sameTime: scope.start === today } : null;
    }
  }

  const labels = projectLabels([...projects.keys()]);
  const projectRows = [...projects.values()]
    .map((row) => ({ key: row.key, label: labels.get(row.key) ?? row.key, sessions: row.sessions.size, byAgent: row.byAgent, stats: statsView(row.stats) }))
    .sort((a, b) => b.stats.total - a.stats.total);

  // 会话：范围内有调用的会话（行内统计是整个会话，不只范围内的部分）。
  // 同一会话的行在下面各 Agent 的上下文均值里还要再用一次：本次摘要内按会话记住，不把整段会话重算两遍。
  const rowCache = new Map();
  const rowOf = (entry) => {
    let row = rowCache.get(entry);
    if (!row) {
      row = sessionRow(entry, nowSec, today);
      rowCache.set(entry, row);
    }
    return row;
  };
  const sessionRows = [...touched].map(rowOf);
  for (const row of sessionRows) row.projectLabel = labels.get(row.project) ?? row.project;

  // 平均每轮耗时：范围内已结束的轮次
  let turnSum = 0;
  let turnCount = 0;
  for (let i = 0; i < snapshot.turns.length; i += 1) {
    const turn = snapshot.turns[i];
    if (turn.t0 === null || turn.t1 === null || turn.t1 < turn.t0) continue;
    const day = dayKeyOf(turn.t0);
    if (day < scope.start || day > scope.end) continue;
    const meta = turnEntry[i];
    if (project !== "all" && meta?.project !== project) continue;
    if (model !== "all" && !meta?.calls.some((c) => (c.turnId ? c.turnId === turn.tid : c.t >= turn.t0 - 2 && c.t <= turn.t1 + 2) && modelKeyOf(c) === model)) continue;
    const agBucket = agentStatsMap.get(turn.agent);
    if (agBucket) {
      agBucket.turnSum += turn.t1 - turn.t0;
      agBucket.turnCount += 1;
    }
    if (agent !== "all" && turn.agent !== agent) continue;
    turnSum += turn.t1 - turn.t0;
    turnCount += 1;
  }

  const models = [...modelMap.values()]
    .map((m) => {
      const sv = statsView(m.stats);
      return {
        model: m.model,
        agent: m.agent,
        agents: [...m.agents],
        calls: sv.calls,
        errors: sv.errors,
        total: sv.total,
        fresh: sv.fresh,
        cacheRead: sv.cacheRead,
        output: sv.output,
        billable: sv.fresh + sv.output,
        costUsd: sv.costUsd,
        savedUsd: sv.savedUsd,
      };
    })
    .filter((m) => m.total > 0 || m.calls > 0)
    .sort((a, b) => b.total - a.total || b.calls - a.calls);

  const byAgent = [...agentStatsMap.entries()].map(([id, b]) => {
    const sv = statsView(b.stats);
    let ctxSum = 0;
    let ctxCnt = 0;
    for (const entry of b.sessions) {
      const sr = rowOf(entry);
      if (sr.context && Number.isFinite(sr.context.ratio) && sr.context.ratio > 0) {
        ctxSum += Math.min(1, sr.context.ratio);
        ctxCnt += 1;
      }
    }
    return {
      agent: id,
      calls: sv.calls,
      errors: sv.errors,
      total: sv.total,
      fresh: sv.fresh,
      cacheRead: sv.cacheRead,
      output: sv.output,
      costUsd: sv.costUsd,
      savedUsd: sv.savedUsd,
      hitRate: sv.hitRate,
      sessions: b.sessions.size,
      avgTurnSec: b.turnCount ? b.turnSum / b.turnCount : null,
      ctxRatio: ctxCnt ? ctxSum / ctxCnt : null,
    };
  });

  const topSessions = [...scopedSessions.entries()].filter(([, s]) => s.costUsd > 0)
    .sort((a, b) => b[1].costUsd - a[1].costUsd || a[0].key.localeCompare(b[0].key)).slice(0, 5).map(([entry, s]) => ({
    key: entry.key, serverId: entry.serverId, sid: entry.sid, agent: entry.agent, project: entry.project,
    projectLabel: labels.get(entry.project) ?? entry.project, stats: statsView(s),
    }));
  const prev = statsView(previousStats);
  const current = statsView(stats);
  const covered = Boolean(coverageStart && coverageStart <= previousScope.start && (!snapshotStart || snapshotStart <= previousScope.start));
  const scanIncomplete = sources.some((s) => s.lastError || s.complete !== true);
  const comparison = {
    previousScope, sameTime: cutoff !== Infinity, covered, scanIncomplete,
    current, previous: prev,
    costRatio: covered && !scanIncomplete && prev.costUsd > 0 ? current.costUsd / prev.costUsd : null,
    tokenRatio: covered && !scanIncomplete && prev.total > 0 ? current.total / prev.total : null,
    hitRateDelta: covered && !scanIncomplete && current.hitRate !== null && prev.hitRate !== null ? current.hitRate - prev.hitRate : null,
  };

  return {
    now: nowSec,
    today,
    timezone: USAGE_TZ_LABEL,
    scope,
    coverageStart,
    detectedAgents,
    kpis: {
      ...statsView(stats),
      sessions: sessionRows.length,
      recentSessions: sessionRows.filter((row) => row.status === "recent").length,
      avgTurnSec: turnCount ? turnSum / turnCount : null,
      turnCount,
      freshVsAvg,
    },
    models,
    byAgent,
    insights: { topSessions, comparison },
    trend: { granularity, buckets },
    calendar,
    projects: projectRows,
    sessions: sessionRows,
  };
}

// 提取某台服务器的会话列表（供 Slurm 作业双向归属匹配使用）：[{ serverId, agent, sid, cwd, firstSec, lastSec }]
export function listSessionsForJobs(snapshot, serverId) {
  if (!snapshot || !serverId) return [];
  const { byKey } = indexSessions(snapshot, {});
  const out = [];
  for (const entry of byKey.values()) {
    if (entry.serverId !== serverId || !entry.cwd || !entry.calls.length) continue;
    out.push({
      serverId: entry.serverId,
      agent: entry.agent,
      sid: entry.sid,
      cwd: entry.cwd,
      firstSec: entry.calls[0].t,
      lastSec: entry.calls.at(-1).t,
    });
  }
  return out;
}

// 匹配某次 Agent 会话期间在同项目目录提交的 Slurm 作业（基于 job-registry 条目）。
export function matchSessionSlurmJobs(entry, regEntries = []) {
  const cwd = typeof entry?.cwd === "string" ? entry.cwd.replace(/\/+$/, "") : "";
  if (!cwd || !Array.isArray(regEntries) || !regEntries.length || !entry?.calls?.length) return [];
  const firstSec = entry.calls[0].t - 600;
  const lastSec = entry.calls.at(-1).t + 1800;
  const matched = [];
  for (const reg of regEntries) {
    if (!reg || typeof reg !== "object") continue;
    const rawDir = reg.workDir || (typeof reg.stdout === "string" && reg.stdout.startsWith("/") ? reg.stdout.replace(/\/[^/]+$/, "") : "");
    const dir = String(rawDir || "").replace(/\/+$/, "");
    if (!dir) continue;
    const pathMatch = dir === cwd || dir.startsWith(`${cwd}/`) || cwd.startsWith(`${dir}/`);
    if (!pathMatch) continue;
    const seenSec = Number.isFinite(reg.firstSeenAt) ? reg.firstSeenAt / 1000 : null;
    if (seenSec !== null && (seenSec < firstSec || seenSec > lastSec)) continue;
    matched.push({ jobId: reg.jobId, name: reg.name || null });
  }
  return matched.slice(0, 20);
}

// 会话详情：会话 → 轮次 → 调用。
export function buildSessionDetail(snapshot, key, { nowSec, homes = {}, regEntries = null } = {}) {
  const entry = indexSessions(snapshot, homes).byKey.get(key);
  if (!entry) return null;
  const today = dayKeyOf(nowSec);
  const row = sessionRow(entry, nowSec, today);
  row.projectLabel = projectLabels([row.project]).get(row.project);
  const turnRecs = snapshot.turns
    .filter((t) => sessionKeyOf(t) === key)
    .map((t) => ({ tid: t.tid, t0: t.t0, t1: t.t1 }))
    .sort((a, b) => (a.t0 ?? a.t1) - (b.t0 ?? b.t1));
  const compacts = snapshot.compacts.filter((x) => sessionKeyOf(x) === key).map((x) => x.t);

  const groups = [];
  if (entry.agent !== "claude" && (entry.agent === "codex" || entry.calls.some((c) => c.turnId))) {
    const byTid = new Map(turnRecs.map((t) => [t.tid, { ...t, calls: [] }]));
    const loose = [];
    for (const call of entry.calls) {
      let turn = call.turnId ? byTid.get(call.turnId) : null;
      if (!turn && call.turnId) {
        turn = { tid: call.turnId, t0: call.t, t1: null, calls: [] };
        byTid.set(call.turnId, turn);
      }
      if (turn) turn.calls.push(call);
      else loose.push(call);
    }
    groups.push(...[...byTid.values()].filter((t) => t.calls.length || t.t1 !== null));
    if (loose.length) groups.push({ tid: null, t0: loose[0].t, t1: null, calls: loose });
  } else {
    // Claude / 无 turnId 的 Agent：turn_duration 给出 [开始, 结束]；区间外连续的调用归成「未记录结束」的一组
    const turns = turnRecs.map((t) => ({ ...t, calls: [] }));
    let loose = null;
    for (const call of entry.calls) {
      const turn = turns.find((t) => t.t0 !== null && t.t1 !== null && call.t >= t.t0 - 2 && call.t <= t.t1 + 2);
      if (turn) {
        turn.calls.push(call);
        loose = null;
        continue;
      }
      if (!loose) {
        loose = { tid: null, t0: call.t, t1: null, calls: [] };
        groups.push(loose);
      }
      loose.calls.push(call);
    }
    groups.push(...turns.filter((t) => t.calls.length));
  }
  groups.sort((a, b) => (a.t0 ?? a.calls[0]?.t ?? 0) - (b.t0 ?? b.calls[0]?.t ?? 0));

  const turns = groups.map((group, index) => {
    const stats = group.calls.reduce(addCall, emptyStats());
    const start = group.t0 ?? group.calls[0]?.t ?? null;
    const end = group.t1;
    return {
      index: index + 1,
      tid: group.tid,
      t0: start,
      t1: end,
      open: end === null,
      durationSec: end !== null && start !== null ? Math.max(0, end - start) : null,
      compacted: compacts.some((t) => start !== null && t >= start && (end === null || t <= end + 2)),
      stats: statsView(stats),
      calls: group.calls.map((c) => {
        const view = { t: c.t, rid: c.rid, ok: c.ok, code: c.code, model: c.model, sidechain: c.sidechain, inFresh: c.inFresh, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output, prompt: c.prompt };
        if (!c.ok) Object.assign(view, { errorText: c.errorText ?? null, errorDropped: c.errorDropped === true, errorKind: errorKindOf(c) });
        return view;
      }),
    };
  });

  const contextSeries = entry.calls.filter((c) => c.ok && !c.sidechain).map((c) => [c.t, c.prompt]);
  const slurmJobs = Array.isArray(regEntries) ? matchSessionSlurmJobs(entry, regEntries) : [];
  return { ...row, turns, contextSeries, compacts, ...(slurmJobs.length ? { slurmJobs } : {}) };
}
