// 编排型作业的子任务进度（v2.51）：纯计算，远端记录一律当不可信数据校验后才用。
//
// 数据来源（remote/job-subruns.py）：stdout 里 `<时间> LAUNCH <run> <phase> <GPU>` / `<时间> END <run> <phase> <退出码>`，
// 以及「正在跑」的子任务日志 <run>_<phase>_<作业号>.log 的尾部 epoch 行。口径：
//   - 按 run + phase + 第几次启动配对；同键还在跑又出现 LAUNCH → 两条都标「无法配对」，不猜哪条 END 属于谁；
//   - 已启动 / 已结束 只是 stdout 里看到的行数；总子任务数未知，不算完成率、不拿差值当「还剩 N 个」；
//   - 退出码非 0 即失败结束（调度器另有「退出码 0 但没写完成标志也算失败」的规则，stdout 看不到，界面写明）；
//   - 游标按文件位置推进，重复读取靠「事件偏移 < 已确认偏移」去重；文件被替换 / 截断时清空重来并记下覆盖缺口。
// 训练指标只认两种核实过的格式：文本 `HH:MM:SS LEVEL epoch X/Y k=v …` 与 JSONL `{"event": "epoch_complete", …}`；
// 别的格式保留最后一行原文。ETA 只针对单个训练子任务，门槛见 estimateEta。

export const SUBRUN_MAX_RUNS = 150;
export const SUBRUN_OPEN_MAX = 12;
const ATTEMPT_KEYS_MAX = 400;
const GAPS_MAX = 6;
const HISTORY_MAX = 30;
const METRICS_MAX = 6;
const ETA_POINTS = 6;
const ETA_SPREAD_MAX = 1.5;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-])(\d{2})(\d{2})$/;
const TEXT_EPOCH_RE = /^(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?\s+[A-Z]+\s+epoch\s+(\d{1,7})\s*\/\s*(\d{1,7})\b(.*)$/;
const PAIR_RE = /([A-Za-z_][\w.]{0,31})=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w.])/g;
const JSONL_SKIP = new Set(["epoch", "step", "seconds", "time", "event", "peak_cuda_memory_bytes"]);
const GAP_TEXT = {
  head: "首次读取时 stdout 已很大，只从末尾附近开始读，更早的启动 / 结束记录未计入",
  truncated: "stdout 变短（被截断或重写），已清空此前的子任务记录并从头重读",
  replaced: "stdout 文件被替换，已清空此前的子任务记录并从头重读",
  skipped: "遇到一段超长无换行的内容，已跳过；其中若有启动 / 结束记录未计入",
};

const finiteNum = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const nonNeg = (v) => (finiteNum(v) !== null && v >= 0 ? v : null);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const keyOf = (run, phase) => `${run}\t${phase}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

// `2026-10-05T22:36:17+0800` → 毫秒；格式不对返回 null。
export function parseStamp(text) {
  const m = STAMP_RE.exec(String(text ?? ""));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(ms) ? ms : null;
}

// ---- 远端记录校验 ----

function parseEvent(raw) {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const [o, at, type, run, phase, code] = raw;
  if (!Number.isSafeInteger(o) || o < 0 || !["L", "E"].includes(type) || !TOKEN_RE.test(run ?? "") || !TOKEN_RE.test(phase ?? "")) return null;
  const ms = parseStamp(at);
  if (ms === null) return null;
  if (type === "E" && !(Number.isInteger(code) && code >= -9999 && code <= 9999)) return null;
  return { o, at: ms, type, run, phase, code: type === "E" ? code : null };
}

function parseLog(raw) {
  if (!raw || typeof raw !== "object" || !TOKEN_RE.test(raw.r ?? "") || !TOKEN_RE.test(raw.s ?? "")) return null;
  if (raw.miss === true) return { run: raw.r, phase: raw.s, missing: true };
  const lines = (Array.isArray(raw.ep) ? raw.ep : []).slice(-8).filter((v) => typeof v === "string").map((v) => v.slice(0, 600));
  return { run: raw.r, phase: raw.s, missing: false, mtime: nonNeg(raw.mt), size: nonNeg(raw.sz), lines, last: str(raw.last, 300) || "" };
}

export function parseSubrunRecord(r) {
  if (!r || !/^\d{1,12}(?:_\d{1,9})?$/.test(String(r.id || ""))) return null;
  const kind = r.k === "subruns-final" ? "final" : "live";
  const path = typeof r.p === "string" && r.p.startsWith("/") ? r.p.slice(0, 1024) : null;
  if (r.miss === true) return { kind, id: r.id, path, missing: true };
  if (!path || typeof r.cid !== "string" || !/^\d{1,24}:\d{1,24}$/.test(r.cid)) return null;
  const from = Number.isSafeInteger(r.from) && r.from >= 0 ? r.from : null;
  const off = Number.isSafeInteger(r.off) && r.off >= 0 ? r.off : null;
  if (from === null || off === null || off < from) return null;
  const events = (Array.isArray(r.ev) ? r.ev : []).slice(0, 300).map(parseEvent).filter((e) => e && e.o >= from && e.o < off).sort((a, b) => a.o - b.o);
  return {
    kind, id: r.id, path, cid: r.cid, from, off, size: nonNeg(r.sz), mtime: nonNeg(r.mt), remoteNow: nonNeg(r.rn),
    gap: Object.hasOwn(GAP_TEXT, r.gap) ? r.gap : null, more: r.more === true, events,
    logs: kind === "live" ? (Array.isArray(r.logs) ? r.logs : []).slice(0, 6).map(parseLog).filter(Boolean) : [],
  };
}

// ---- 送给远端的游标与「正在跑」列表（最久未采样的排前面）----

export function subrunPayload(state) {
  const cursor = state?.cursor;
  const open = (state?.runs || []).filter((r) => r.status === "running")
    .sort((a, b) => (a.log?.checkedAt || 0) - (b.log?.checkedAt || 0) || (a.launchAt || 0) - (b.launchAt || 0))
    .slice(0, SUBRUN_OPEN_MAX).map((r) => [r.run, r.phase]);
  return { cur: cursor && typeof cursor.cid === "string" && Number.isSafeInteger(cursor.off) ? { cid: cursor.cid, off: cursor.off } : null, open };
}

// ---- 训练日志解析 ----

function textPoint(line) {
  const m = TEXT_EPOCH_RE.exec(line);
  if (!m) return null;
  const metrics = {};
  for (const [, k, v] of m[6].matchAll(PAIR_RE)) {
    if (Object.keys(metrics).length >= METRICS_MAX) break;
    if (!Object.hasOwn(metrics, k) && Number.isFinite(Number(v))) metrics[k] = Number(v);
  }
  return { format: "text", e: Number(m[4]), total: Number(m[5]) > 0 ? Number(m[5]) : null, t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), metrics, best: /\[best\]/.test(m[6]) };
}

function jsonPoint(line) {
  if (!line.startsWith("{") || !line.includes("epoch_complete")) return null;
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if (v?.event !== "epoch_complete" ||!Number.isSafeInteger(v.epoch) || v.epoch < 0) return null;
  const at = typeof v.time === "string" ? Date.parse(v.time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
  const metrics = {};
  for (const [k, val] of Object.entries(v)) {
    if (Object.keys(metrics).length >= METRICS_MAX) break;
    if (!JSONL_SKIP.has(k) && /^[A-Za-z_][\w.]{0,31}$/.test(k) && finiteNum(val) !== null) metrics[k] = val;
  }
  return { format: "jsonl", e: v.epoch, total: null, t: Number.isFinite(at) ? at / 1000 : null, metrics, step: Number.isSafeInteger(v.step) ? v.step : null, seconds: nonNeg(v.seconds) };
}

// 一批尾部行 → 按文件顺序的 epoch 点。文本时间只有时分秒：跨午夜按 +24 小时展开（相邻两点间隔不会超过一天）。
// epoch 不增反降 = 子任务在同一个日志里重启了，丢掉重启前的点并记 restarted。
export function parseEpochLines(lines) {
  const points = [];
  let restarted = false;
  let dayShift = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const p = textPoint(String(line)) || jsonPoint(String(line));
    if (!p) continue;
    const prev = points.at(-1);
    if (prev && p.format !== prev.format) { points.length = 0; dayShift = 0; }
    if (p.format === "text" && prev?.format === "text" && p.t + dayShift < prev.t - 60) dayShift += 86400;
    if (p.format === "text") p.t += dayShift;
    if (prev && p.format === prev.format && p.e <= prev.e) { points.length = 0; restarted = true; }
    points.push(p);
  }
  return { points, restarted };
}

// ETA：至少 3 个连续 epoch 点、时间与 epoch 都严格递增、每 epoch 用时最大 / 最小 ≤ 1.5，且日志给出了总 epoch 数。
// 不知道 epoch 从 0 还是 1 数，下界按「还剩 total−e−1 个」、上界按「还剩 total−e 个」，区间同时覆盖两种写法。
export function estimateEta(points) {
  const pts = (points || []).slice(-ETA_POINTS);
  if (pts.length < 3) return { reason: "至少需要 3 个连续 epoch 记录才估算" };
  const total = pts.at(-1).total;
  if (!total) return { reason: "日志没有给出总 epoch 数，不估算" };
  const rates = [];
  for (let i = 1; i < pts.length; i += 1) {
    const dt = pts[i].t - pts[i - 1].t;
    const de = pts[i].e - pts[i - 1].e;
    if (!(Number.isFinite(dt) && dt > 0 && de > 0)) return { reason: "epoch 时间不连续，不估算" };
    rates.push(dt / de);
  }
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  if (hi / lo > ETA_SPREAD_MAX) return { reason: "最近几个 epoch 速度波动较大，不估算" };
  const last = pts.at(-1).e;
  if (last >= total) return { reason: "已到最后一个 epoch" };
  return { loSec: Math.max(0, total - last - 1) * lo, hiSec: Math.max(0, total - last) * hi, points: pts.length, secPerEpoch: Math.round(((lo + hi) / 2) * 10) / 10 };
}

function primaryKey(metrics) {
  const keys = Object.keys(metrics || {});
  return ["loss", "train_loss", "z_mse"].find((k) => keys.includes(k)) || keys[0] || null;
}

function mergeLog(prev, log, { now, remoteNow }) {
  const checkedAt = now;
  if (log.missing) return { ...(prev || {}), checkedAt, missing: true };
  const lastLogAt = log.mtime !== null && remoteNow !== null ? now - Math.max(0, remoteNow - log.mtime) * 1000 : prev?.lastLogAt ?? null;
  const { points, restarted } = parseEpochLines(log.lines);
  const next = { ...(prev || {}), checkedAt, missing: false, lastLogAt, size: log.size, lastLine: log.last };
  if (!points.length) return { ...next, format: prev?.format || "unknown" };
  const last = points.at(-1);
  const primary = primaryKey(last.metrics);
  const fresh = points.filter((p) => primary && finiteNum(p.metrics[primary]) !== null).map((p) => ({ e: p.e, v: p.metrics[primary] }));
  const reset = restarted || prev?.primary !== primary || (prev?.epoch != null && last.e < prev.epoch);
  const kept = reset ? [] : (prev?.history || []).filter((h) => h.e < (fresh[0]?.e ?? Infinity));
  const eta = estimateEta(points);
  return {
    ...next, format: last.format, epoch: last.e, total: last.total, step: last.step ?? null, metrics: last.metrics, best: last.best === true,
    primary, history: [...kept, ...fresh].slice(-HISTORY_MAX), restarted: restarted || (reset && prev?.epoch != null && last.e < prev.epoch),
    eta: eta.reason ? null : { loSec: eta.loSec, hiSec: eta.hiSec, points: eta.points, secPerEpoch: eta.secPerEpoch, anchorAt: lastLogAt },
    etaNote: eta.reason || null,
  };
}

// ---- 状态推进 ----

export function emptySubrunState({ serverId, jobId, now }) {
  return { serverId, jobId, createdAt: now, updatedAt: now, cursor: null, finalized: false, finalAttempts: 0, more: false,
    counts: { launched: 0, ended: 0, failed: 0, orphanEnds: 0 }, attempts: {}, runs: [], gaps: [] };
}

function pruneRuns(state) {
  // 计数单独保存，裁掉明细不改变「已启动 / 已结束 / 失败」；先裁最早的正常结束，再裁其它已结束的，正在跑的不裁。
  for (const status of ["ok", "unended", "ambiguous", "failed"]) {
    while (state.runs.length > SUBRUN_MAX_RUNS) {
      const i = state.runs.findIndex((r) => r.status === status);
      if (i < 0) break;
      state.runs.splice(i, 1);
    }
  }
  const keys = Object.keys(state.attempts);
  for (const k of keys.slice(0, Math.max(0, keys.length - ATTEMPT_KEYS_MAX))) delete state.attempts[k];
}

function applyEvent(state, ev) {
  const key = keyOf(ev.run, ev.phase);
  const open = state.runs.filter((r) => r.status === "running" && r.run === ev.run && r.phase === ev.phase);
  if (ev.type === "L") {
    state.counts.launched += 1;
    state.attempts[key] = (state.attempts[key] || 0) + 1;
    for (const r of open) { r.status = "ambiguous"; r.ambiguous = true; }
    state.runs.push({ run: ev.run, phase: ev.phase, attempt: state.attempts[key], launchAt: ev.at, endAt: null, code: null, status: "running", ambiguous: open.length > 0, orphan: false, log: null });
    return;
  }
  state.counts.ended += 1;
  if (ev.code !== 0) state.counts.failed += 1;
  const status = ev.code === 0 ? "ok" : "failed";
  if (open.length === 1) {
    Object.assign(open[0], { endAt: ev.at, code: ev.code, status });
    return;
  }
  // 找不到对应的启动（多半是开头没读到）：计数照算，失败的留一条明细供提醒与查看。
  state.counts.orphanEnds += 1;
  if (status === "failed") state.runs.push({ run: ev.run, phase: ev.phase, attempt: 0, launchAt: null, endAt: ev.at, code: ev.code, status, ambiguous: false, orphan: true, log: null });
}

function addGap(state, kind, now) {
  state.gaps = [...state.gaps, { kind, at: now }].slice(-GAPS_MAX);
}

// 把一条远端记录并进状态，返回新状态（不改入参）。过期 / 重复的记录原样返回旧状态。
export function applySubrunRecord(prev, record, { now, serverId, jobId }) {
  let state = prev ? clone(prev) : emptySubrunState({ serverId, jobId, now });
  if (!record || record.missing) {
    if (record?.kind === "final") return finalizeSubruns(state, { now, note: "收尾读取时 stdout 已不可读" });
    return state;
  }
  const cursor = state.cursor;
  const reset = record.gap === "replaced" || record.gap === "truncated" || (cursor && cursor.path !== record.path);
  if (!reset && cursor && (record.cid !== cursor.cid || record.from !== cursor.off)) return state; // 迟到 / 重复的一轮
  if (reset && record.kind === "final") {
    addGap(state, record.gap || "replaced", now);
    return finalizeSubruns(state, { now, note: "作业结束后 stdout 被替换或截断，收尾读取未进行" });
  }
  if (reset) {
    const fresh = emptySubrunState({ serverId, jobId, now });
    state = { ...fresh, createdAt: state.createdAt, gaps: state.gaps, finalAttempts: state.finalAttempts };
    addGap(state, record.gap || "replaced", now);
  } else if (record.gap) addGap(state, record.gap, now);
  const base = state.cursor?.off ?? 0;
  for (const ev of record.events) if (ev.o >= base) applyEvent(state, ev);
  state.cursor = { path: record.path, cid: record.cid, off: record.off, size: record.size, mtime: record.mtime };
  state.more = record.more;
  for (const log of record.logs) {
    const candidates = state.runs.filter((r) => r.run === log.run && r.phase === log.phase && !r.orphan);
    const target = candidates.find((r) => r.status === "running") || candidates.at(-1);
    if (target) target.log = mergeLog(target.log, log, { now, remoteNow: record.remoteNow });
  }
  state.updatedAt = now;
  pruneRuns(state);
  return record.kind === "final" ? finalizeSubruns(state, { now }) : state;
}

// 父作业已结束：仍在跑的标为「未见结束记录」（调度器被取消 / 超时终止时直接杀子任务，不打印 END）。
export function finalizeSubruns(prev, { now, note = null }) {
  const state = clone(prev);
  for (const r of state.runs) if (r.status === "running") r.status = "unended";
  state.finalized = true;
  state.finalNote = note;
  state.updatedAt = now;
  return state;
}

// 失败提醒候选：结束时刻不早于 since（关注之前就失败的只显示、不提醒）。
export function subrunFailures(state, since) {
  return (state?.runs || []).filter((r) => r.status === "failed" && Number.isFinite(r.endAt) && r.endAt >= since)
    .map((r) => ({ key: `${r.run}\t${r.phase}\t${r.attempt}\t${r.endAt}`, run: r.run, phase: r.phase, code: r.code, endAt: r.endAt }));
}

// 有活动的子任务日志 → 给「疑似停滞」判断用的指纹：编排型作业的 stdout 只在启动 / 结束时才写，不能单看它。
export function subrunActivity(state) {
  const logs = (state?.runs || []).filter((r) => r.status === "running" && r.log && !r.log.missing && Number.isFinite(r.log.size));
  if (!logs.length) return null;
  return {
    fingerprint: logs.map((r) => `${r.run}/${r.phase}:${r.log.size}`).sort().join("|"),
    lastLogAt: Math.max(...logs.map((r) => r.log.lastLogAt || 0)) || null,
  };
}

// ---- 视图 ----

function runView(r) {
  return { run: r.run, phase: r.phase, attempt: r.attempt, launchAt: r.launchAt, endAt: r.endAt, code: r.code, status: r.status, ambiguous: r.ambiguous === true, orphan: r.orphan === true };
}

function logView(log, now) {
  if (!log) return null;
  const metrics = Object.entries(log.metrics || {}).slice(0, METRICS_MAX);
  let eta = null;
  let etaNote = log.etaNote || null;
  if (log.eta && Number.isFinite(log.eta.anchorAt)) {
    const endLo = log.eta.anchorAt + log.eta.loSec * 1000;
    const endHi = log.eta.anchorAt + log.eta.hiSec * 1000;
    const silent = Number.isFinite(log.lastLogAt) ? now - log.lastLogAt : Infinity;
    if (silent > Math.max(10 * 60000, log.eta.secPerEpoch * 3000 * 3)) etaNote = "日志较久未更新，暂不估算";
    else if (now > endHi + 10 * 60000) etaNote = "已超过此前的估算区间，暂不估算";
    else eta = { endLo, endHi, points: log.eta.points, secPerEpoch: log.eta.secPerEpoch };
  }
  return {
    format: log.format || "unknown", missing: log.missing === true, checkedAt: log.checkedAt ?? null, lastLogAt: log.lastLogAt ?? null,
    epoch: log.epoch ?? null, total: log.total ?? null, step: log.step ?? null, metrics, best: log.best === true, primary: log.primary || null,
    history: (log.history || []).map((h) => h.v), restarted: log.restarted === true, lastLine: log.lastLine || "", eta, etaNote,
  };
}

export function subrunView(state, now) {
  if (!state || (!state.counts?.launched && !state.counts?.ended && !state.gaps?.length)) return null;
  const runs = state.runs || [];
  const running = runs.filter((r) => r.status === "running");
  const ended = runs.filter((r) => ["ok", "failed"].includes(r.status) && Number.isFinite(r.endAt)).sort((a, b) => b.endAt - a.endAt);
  return {
    launched: state.counts.launched, ended: state.counts.ended, failed: state.counts.failed, orphanEnds: state.counts.orphanEnds,
    runningCount: running.length,
    running: running.sort((a, b) => (a.launchAt || 0) - (b.launchAt || 0)).slice(0, SUBRUN_OPEN_MAX).map((r) => ({ ...runView(r), log: logView(r.log, now) })),
    failedRuns: ended.filter((r) => r.status === "failed").slice(0, 10).map((r) => ({ ...runView(r), log: logView(r.log, now) })),
    recent: ended.filter((r) => r.status === "ok").slice(0, 5).map(runView),
    ambiguous: runs.filter((r) => r.ambiguous).length,
    unended: runs.filter((r) => r.status === "unended").slice(0, 10).map(runView),
    gaps: (state.gaps || []).map((g) => ({ kind: g.kind, at: g.at, text: GAP_TEXT[g.kind] || "存在覆盖缺口" })),
    finalized: state.finalized === true, finalNote: state.finalNote || null, catchingUp: state.more === true, checkedAt: state.updatedAt ?? null,
  };
}
