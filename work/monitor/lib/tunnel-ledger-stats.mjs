// 断线账本读取端（纯函数）：把 runtime/tunnel-ledger.ndjson 的事件流算成每条隧道的稳定性指标。
// 写入端见 lib/supervisor/tunnel-ledger.mjs。
//
// 口径：
//   - 断线 = 一条已建立的会话异常结束（down 且 planned=false）；受控重启 / 停止通道 / 退出不算。
//   - 断开时长 = 异常结束 → 下一次重新建立；恢复用时同义。仍未恢复的计为进行中。
//   - 可用率 = 在线时长 /（在线 + 断开）——只统计 supervisor 确实在看着的时段：相邻两条记录
//     间隔超过 OBSERVED_GAP_MAX_MS（停机 / Mac 睡眠）的区间不计入分子也不计入分母。
//   - supervisor 重新启动（start）：紧接上一条记录（热更新交接）时会话延续；隔了观测空档才归为未知。
//   - 统计区间：默认「近 24 小时 / 近 7 天」（相对现在）；简报传入自定义区间（如北京时间今天 0 点起、
//     昨天全天）。另出一条时间线（默认近 24 小时）：按 在线 / 断开 / 休眠 / 未观测 分段，供概览在线条。
//
// 休眠（v2.62，账本带 wake 行与 down 行的 sleep 标记时才生效；没有这些的旧账本，结果与之前逐字相同）：
//   - 电脑休眠的起止取自 wake 行（at - sleptMs → at），各条隧道的并在一起当作整台电脑的事实；相隔不超过
//     SLEEP_MERGE_GAP_MS 的几段并成一段——合盖期间系统隔一阵会短暂醒几秒，那不算醒。
//   - 休眠区间里既不算在线、也不算断开、也不是「未观测」，单独记为休眠；区间里记下的断开一律算休眠造成的。
//     醒来后短时间内发现的断线由 supervisor 标 sleep，同样算。这些断开不计入断线次数、原因分布、可用率与
//     恢复用时，另计 sleepDrops（几次）与 sleepDownMs（休眠让这条隧道不可用了多久）。
//   - 唤醒后的重连宽限：醒来时隧道是断的（或醒来后被标了 sleep 断开），SLEEP_RECOVERY_GRACE_MS 内连上，
//     这一小段也算休眠；超过仍没连上，就从醒来那一刻起照旧记成一次普通断线——电脑醒着而隧道不通，
//     不该被「休眠」盖住。
//   - 清单（recentDrops）里同一段休眠造成的几次断开并成一条（cause 为 "sleep"，带 sleep: true）。
//   - 隧道在休眠里没断（醒来 ssh 还在）时会话延续，不像停机空档那样归为未知。
import { TUNNEL_LEDGER_ALIVE_MS } from "./supervisor/tunnel-ledger.mjs";

// 两倍心跳再留 1 分钟余量：超过即视为这段时间没有观测。
export const OBSERVED_GAP_MAX_MS = TUNNEL_LEDGER_ALIVE_MS * 2 + 60_000;
export const STABILITY_WINDOWS = Object.freeze({ "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000 });
// 两段休眠之间醒着的时间不超过它就并成一段；醒来后这么久内被标了 sleep 的断线也归到刚结束的那段休眠名下。
// 与 supervisor 的归因窗口（tunnel-controller.mjs 的 SLEEP_ATTRIBUTION_MS）同长。
export const SLEEP_MERGE_GAP_MS = 120_000;
// 唤醒后的重连宽限。取 10 分钟：与简报里「断开满 10 分钟单独提示」同一条线——电脑醒着、隧道断了这么久，
// 该怎么提示就怎么提示，与改动之前一样。必须短于 OBSERVED_GAP_MAX_MS：宽限里暂存的时间一律当「看着的」
// 记账，观测空档一出现就已经过了宽限（scripts/sleep-attribution-wiring.test.mjs 守着）。
export const SLEEP_RECOVERY_GRACE_MS = 10 * 60_000;
export const SLEEP_CAUSE = "sleep";
const RECENT_DROPS_MAX = 20;
// 观测不足 10 分钟时可用率没有意义，返回 null（前端显示"数据不足"）。
const MIN_OBSERVED_FOR_AVAILABILITY_MS = 10 * 60_000;

export function parseLedgerText(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.type === "string" && Number.isFinite(event.at)) out.push(event);
    } catch {
      // 半行（写入中被读到）/ 损坏行：跳过
    }
  }
  return out;
}

function emptyWindow() {
  return { drops: 0, upMs: 0, downMs: 0, availability: null, recoveries: 0, meanRecoveryMs: null, maxRecoveryMs: null, longestUpMs: 0, causes: {}, networkChangeDrops: 0, sleepDrops: 0, sleepDownMs: 0 };
}

function overlap(start, end, windowStart, windowEnd) {
  return Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
}

export function defaultRanges(nowMs) {
  return Object.fromEntries(Object.entries(STABILITY_WINDOWS).map(([key, ms]) => [key, [nowMs - ms, nowMs]]));
}

// 账本里的 wake 行 → 电脑休眠的区间 [{ from, to }]（按时间升序、互不相接）。
// 截到 nowMs：统计「截至昨天 24 点」时，跨过 0 点的那段休眠只算到 0 点。
export function sleepPeriodsOf(events = [], nowMs = Number.POSITIVE_INFINITY) {
  const naps = [];
  for (const event of events) {
    if (event?.type !== "wake" || !Number.isFinite(event.at) || !Number.isFinite(event.sleptMs) || event.sleptMs <= 0) continue;
    const from = event.at - event.sleptMs;
    // 入睡时刻算出来不是个正经时间戳（坏行）：不采信，免得整条时间线被它涂成休眠。
    if (from > 0 && from < nowMs) naps.push([from, Math.min(event.at, nowMs)]);
  }
  naps.sort((a, b) => a[0] - b[0]);
  const periods = [];
  for (const [from, to] of naps) {
    const last = periods.at(-1);
    if (last && from - last.to <= SLEEP_MERGE_GAP_MS) last.to = Math.max(last.to, to);
    else periods.push({ from, to });
  }
  return periods;
}

// 每个统计区间里电脑休眠了多久、几段、最后一次醒来的时刻（整台电脑的事实，不分隧道）。
function sleepSummary(periods, ranges, nowMs) {
  const out = {};
  for (const [key, [start, end]] of Object.entries(ranges)) {
    const stop = Math.min(end, nowMs);
    const summary = { ms: 0, count: 0, lastWakeAt: null };
    for (const period of periods) {
      const span = overlap(period.from, period.to, start, stop);
      if (span <= 0) continue;
      summary.ms += span;
      summary.count += 1;
      summary.lastWakeAt = Math.min(period.to, stop);
    }
    out[key] = summary;
  }
  return out;
}

// 单台服务器：events 是全局事件（start/alive）与本服务器事件按时间合并后的序列。
// ranges：{ key: [startMs, endMs] }；timelineStart：时间线起点（终点 = nowMs）；periods：sleepPeriodsOf 的结果。
function computeServer(serverId, events, nowMs, ranges, timelineStart, periods = []) {
  const keys = Object.keys(ranges);
  const windows = Object.fromEntries(keys.map((key) => [key, emptyWindow()]));
  const windowStarts = Object.fromEntries(keys.map((key) => [key, ranges[key][0]]));
  const windowEnds = Object.fromEntries(keys.map((key) => [key, Math.min(ranges[key][1], nowMs)]));
  const inRange = (key, at) => at >= windowStarts[key] && at < windowEnds[key] + (windowEnds[key] === nowMs ? 1 : 0);
  const recoveryTotals = Object.fromEntries(keys.map((key) => [key, 0]));
  const runUp = Object.fromEntries(keys.map((key) => [key, 0]));
  const segments = [];
  const outages = [];
  // state：up / down（普通断线）/ sleep（因休眠断着：电脑睡着，或醒来后还在重连宽限内）/ unknown。
  // standby（v2.88）：同账号另一台 Mac 在承载、本机待命——集群照样出网，不算在线也不算断开，时间线单独一段。
  let state = "unknown";
  let since = null;
  let standbyPeer = null;
  let host = null;
  let openOutage = null;
  let lastDrop = null;
  // ---- 休眠 ----
  let asleep = false; // 电脑此刻睡着（在某个休眠区间里）
  let period = null; // 当前 / 最近一个休眠区间
  let upWhileAsleep = false; // 这段休眠里记过「建立」（多半是握手没做完就睡过去的那条，醒来才知道通不通）
  // 因休眠断着时，最近那次断开的原因等：宽限内没连上、改记普通断线时沿用。
  let carry = null;
  // 唤醒后的重连宽限：{ at, spans: [[from, to]], flagged }。spans 暂存这段醒着的时间，有了结局再记账；
  // flagged = 这一段是醒来后被标了 sleep 的那次断线开的头（{ near }：归到哪段休眠名下）。
  let pending = null;
  // 清单里这条隧道当前这段休眠的条目（同一段休眠造成的几次断开并成一条）。
  let sleepEntry = null;
  const entryByPeriod = new Map();

  // 时间线分段：相邻同状态合并；断开段带上那次断线的原因（悬停提示用）。
  function pushSegment(from, to, segState) {
    const start = Math.max(from, timelineStart);
    if (to <= start) return;
    const cause = segState === "down" ? openOutage?.cause ?? null : null;
    const last = segments.at(-1);
    if (last && last.state === segState && last.to === start && (last.cause ?? null) === cause) {
      last.to = to;
      return;
    }
    segments.push({ from: start, to, state: segState, ...(cause ? { cause, at: openOutage.at } : {}) });
  }

  // 醒着的一段 [from, to) 按当前状态记账（每个窗口各自裁剪）。
  function accountAwake(from, to) {
    const covered = to - from <= OBSERVED_GAP_MAX_MS;
    pushSegment(from, to, covered ? (state === "unknown" ? "unobserved" : state) : "unobserved");
    for (const key of keys) {
      const span = covered ? overlap(from, to, windowStarts[key], windowEnds[key]) : 0;
      if (state === "up" && span > 0) {
        windows[key].upMs += span;
        runUp[key] += span;
        windows[key].longestUpMs = Math.max(windows[key].longestUpMs, runUp[key]);
      } else if (state !== "up" || !covered) {
        runUp[key] = 0;
      }
      if (state === "down" && span > 0) windows[key].downMs += span;
    }
    // 观测中断（停机 / 睡眠）后不知道期间发生了什么：在线状态不延续。
    if (!covered && state === "up") {
      state = "unknown";
      since = null;
    }
  }

  // [from, to) 算休眠：不算在线也不算断开，连续在线到此为止。
  function accountSleep(from, to) {
    pushSegment(from, to, "sleep");
    for (const key of keys) {
      runUp[key] = 0;
      windows[key].sleepDownMs += overlap(from, to, windowStarts[key], windowEnds[key]);
    }
  }

  function account(from, to) {
    if (to <= from) return;
    if (asleep) return accountSleep(from, to);
    if (state === "sleep") {
      if (to - pending.at <= SLEEP_RECOVERY_GRACE_MS) {
        pending.spans.push([from, to]);
        return;
      }
      escalatePending();
    }
    accountAwake(from, to);
  }

  function countDrop(drop) {
    outages.push(drop);
    lastDrop = drop;
    openOutage = drop;
    for (const key of keys) {
      if (!inRange(key, drop.at)) continue;
      windows[key].drops += 1;
      windows[key].causes[drop.cause] = (windows[key].causes[drop.cause] || 0) + 1;
      if (drop.networkChange) windows[key].networkChangeDrops += 1;
    }
  }

  function countSleepDrop(at) {
    for (const key of keys) {
      if (inRange(key, at)) windows[key].sleepDrops += 1;
    }
  }

  // 打开清单里的休眠条目。归到某段休眠名下的从那段休眠开始算（同一段只有一条，已收尾的重新打开）；
  // 找不到是哪段休眠的（wake 行没写进来）就从断开那一刻算。
  function openSleepEntry(ofPeriod, at) {
    let entry = ofPeriod ? entryByPeriod.get(ofPeriod) : null;
    if (entry) {
      entry.recoveredAt = null;
      entry.downMs = null;
    } else {
      entry = { serverId, host: carry?.host ?? host, at: ofPeriod ? ofPeriod.from : at, cause: SLEEP_CAUSE, detail: "", uptimeMs: null, networkChange: false, recoveredAt: null, downMs: null, attempts: null, sleep: true, drops: 0 };
      if (ofPeriod) entryByPeriod.set(ofPeriod, entry);
      outages.push(entry);
    }
    sleepEntry = entry;
    return entry;
  }

  function closeSleepEntry(at, attempts = null) {
    if (!sleepEntry) return;
    sleepEntry.recoveredAt = at;
    sleepEntry.downMs = Math.max(0, at - sleepEntry.at);
    if (Number.isFinite(attempts)) sleepEntry.attempts = attempts;
    sleepEntry = null;
  }

  // 宽限内有了结局（连上了 / 电脑又睡了 / 统计到此为止）：这一小段算休眠。
  function settlePending() {
    const span = pending;
    pending = null;
    for (const [from, to] of span.spans) accountSleep(from, to);
    if (span.flagged) {
      countSleepDrop(span.at);
      openSleepEntry(span.flagged.near, span.at).drops += 1;
    }
  }

  // 宽限过了还没连上：从这一段开始的时刻起改记一次普通断线，暂存的时间按断开补记。
  function escalatePending() {
    const span = pending;
    pending = null;
    closeSleepEntry(span.at);
    countDrop({
      serverId,
      host: carry?.host ?? host,
      at: span.at,
      cause: carry?.cause || "unknown",
      detail: carry?.detail || "",
      uptimeMs: span.flagged ? carry?.uptimeMs ?? null : null,
      networkChange: carry?.networkChange === true,
      recoveredAt: null,
      downMs: null,
      attempts: null,
    });
    state = "down";
    since = span.at;
    for (const [from, to] of span.spans) accountAwake(from, to);
  }

  // 因休眠断着的状态被别的事打断（计划内停止 / 又一条断线记录）：先把宽限这一小段了结。
  function leaveSleepState(at) {
    if (state !== "sleep") return;
    if (pending) settlePending();
    closeSleepEntry(at);
  }

  function fallAsleep(next) {
    if (state === "sleep") {
      // 宽限内电脑又睡了：醒着的这一小段照旧算休眠；上一段休眠的条目到此为止，新的一段另起一条。
      if (pending) settlePending();
      closeSleepEntry(next.from);
      openSleepEntry(next, next.from);
    } else if (state === "down") {
      // 普通断线还没恢复电脑就睡了：这次断线记到入睡为止（不是恢复），之后归休眠。
      if (openOutage) {
        carry = { cause: openOutage.cause, detail: openOutage.detail, networkChange: openOutage.networkChange, host: openOutage.host, uptimeMs: null };
        openOutage.recoveredAt = next.from;
        openOutage.downMs = Math.max(0, next.from - openOutage.at);
        openOutage.endedBy = SLEEP_CAUSE;
        openOutage = null;
      }
      state = "sleep";
      since = next.from;
      openSleepEntry(next, next.from);
    }
    asleep = true;
    period = next;
    upWhileAsleep = false;
  }

  function wakeUp(at) {
    asleep = false;
    if (state === "sleep") {
      pending = { at, spans: [], flagged: null };
      since = at;
    } else {
      // 醒来时隧道是通的（休眠里重建成了）或状态未知：条目到醒来为止；在线从醒来算起。
      if (state === "up" && upWhileAsleep) since = at;
      closeSleepEntry(at);
    }
    upWhileAsleep = false;
  }

  // 休眠区间的起止并进事件流（没有休眠时就是原来的事件序列）。同一毫秒上：先醒来、再处理当时的记录、最后入睡。
  let stream = events.map((event, index) => ({ at: event.at, rank: 1, index, event }));
  if (periods.length) {
    for (const span of periods) {
      stream.push({ at: span.from, rank: 2, index: 0, edge: "sleep", period: span });
      if (span.to < nowMs) stream.push({ at: span.to, rank: 0, index: 0, edge: "wake", period: span });
    }
    stream = stream.sort((a, b) => (a.at - b.at) || (a.rank - b.rank) || (a.index - b.index));
  }

  let cursor = null;
  // 第一条记录之前（账本开始记录之前）：未观测。
  if (stream.length && stream[0].at > timelineStart) pushSegment(timelineStart, Math.min(stream[0].at, nowMs), "unobserved");
  if (!stream.length) pushSegment(timelineStart, nowMs, "unobserved");
  for (const item of stream) {
    if (cursor != null) account(cursor, item.at);
    cursor = item.at;
    if (item.edge === "sleep") {
      fallAsleep(item.period);
      continue;
    }
    if (item.edge === "wake") {
      wakeUp(item.at);
      continue;
    }
    const event = item.event;
    if (event.host) host = event.host;
    if (event.type === "start") {
      // supervisor 重新启动：紧接着上一条记录（热更新交接 / 快速重启，隧道被新 supervisor 原样接管）
      // 时会话延续，在线时长不归零；隔了观测空档（退出 App / 睡眠）的情形已由上面 account() 把在线
      // 状态归为未知。进行中的断线保留（重启前就断着），等下一次 up 收尾。
      continue;
    }
    if (event.type === "alive") continue;
    if (event.type === "handover") {
      // 转为待命：此前的会话已按计划内交接结束（down planned），这里只把「未知」改记成待命。
      if (event.role === "standby" && state !== "up" && !asleep) {
        state = "standby";
        since = event.at;
        standbyPeer = typeof event.peer === "string" ? event.peer : null;
      }
      continue;
    }
    if (event.type === "up") {
      if (asleep) {
        // 休眠里的「建立」：不计恢复，时间照旧算休眠；醒来时还通着才从醒来那一刻算在线。
        state = "up";
        since = event.at;
        upWhileAsleep = true;
        continue;
      }
      if (state === "sleep") {
        // 宽限内连上了：这次断开整段算休眠造成的。
        if (pending) settlePending();
        closeSleepEntry(event.at, event.attempts);
        state = "up";
        since = event.at;
        continue;
      }
      if (openOutage) {
        openOutage.recoveredAt = event.at;
        openOutage.downMs = Math.max(0, event.at - openOutage.at);
        openOutage.attempts = Number.isFinite(event.attempts) ? event.attempts : null;
        for (const key of keys) {
          if (inRange(key, event.at)) {
            windows[key].recoveries += 1;
            recoveryTotals[key] += openOutage.downMs;
            windows[key].maxRecoveryMs = Math.max(windows[key].maxRecoveryMs ?? 0, openOutage.downMs);
          }
        }
        openOutage = null;
      }
      if (state !== "up") since = event.at;
      state = "up";
      continue;
    }
    if (event.type === "down") {
      for (const key of Object.keys(runUp)) runUp[key] = 0;
      if (event.planned) {
        leaveSleepState(event.at);
        state = "unknown";
        since = null;
        continue;
      }
      if (asleep || event.sleep === true) {
        leaveSleepState(event.at);
        carry = { cause: event.cause || "unknown", detail: event.detail || "", networkChange: event.networkChange === true, host: event.host ?? host, uptimeMs: Number.isFinite(event.uptimeMs) ? event.uptimeMs : null };
        openOutage = null;
        state = "sleep";
        if (asleep) {
          // 休眠区间里记下的断开（短暂唤醒时发现 ssh 死了）：并进这段休眠的条目。
          countSleepDrop(event.at);
          openSleepEntry(period, event.at).drops += 1;
          since = period.from;
        } else {
          // 醒着、被 supervisor 标了 sleep：进重连宽限，有了结局再定。
          const near = period && event.at - period.to <= SLEEP_MERGE_GAP_MS ? period : null;
          pending = { at: event.at, spans: [], flagged: { near } };
          since = event.at;
        }
        continue;
      }
      leaveSleepState(event.at);
      countDrop({
        serverId,
        host: event.host ?? host,
        at: event.at,
        cause: event.cause || "unknown",
        detail: event.detail || "",
        uptimeMs: Number.isFinite(event.uptimeMs) ? event.uptimeMs : null,
        networkChange: event.networkChange === true,
        recoveredAt: null,
        downMs: null,
        attempts: null,
      });
      state = "down";
      since = event.at;
    }
  }
  if (cursor != null) account(cursor, nowMs);
  // 统计到此为止时还在宽限内：这一小段暂按休眠记（条目保持「未恢复」）。
  if (pending) settlePending();

  for (const key of keys) {
    const w = windows[key];
    const observed = w.upMs + w.downMs;
    w.availability = observed >= MIN_OBSERVED_FOR_AVAILABILITY_MS ? w.upMs / observed : null;
    w.meanRecoveryMs = w.recoveries ? Math.round(recoveryTotals[key] / w.recoveries) : null;
  }
  return {
    summary: {
      serverId, host, state: asleep ? "sleep" : state, since: asleep ? period.from : since, lastDrop, windows, timeline: { start: timelineStart, end: nowMs, segments },
      ...(!asleep && state === "standby" ? { standbyPeer } : {}),
    },
    outages,
  };
}

// events：parseLedgerText 的结果（可乱序，内部按时间稳定排序）。
// serverIds：要输出的服务器（缺省 = 账本里出现过的全部）。
export function computeTunnelStability({ events = [], nowMs = Date.now(), serverIds = null, ranges = null, timelineStartMs = null, recentLimit = RECENT_DROPS_MAX } = {}) {
  const useRanges = ranges || defaultRanges(nowMs);
  const timelineStart = Number.isFinite(timelineStartMs) ? timelineStartMs : nowMs - STABILITY_WINDOWS["24h"];
  // 休眠区间取自全部 wake 行（含晚于 nowMs 的：那一行说的休眠可能在 nowMs 之前就开始了）。
  const periods = sleepPeriodsOf(events, nowMs);
  const sorted = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.at - b.event.at) || (a.index - b.index))
    .map(({ event }) => event)
    .filter((event) => event.at <= nowMs);
  const ids = serverIds || [...new Set(sorted.filter((e) => e.serverId).map((e) => e.serverId))];
  const servers = {};
  const allOutages = [];
  for (const serverId of ids) {
    const own = sorted.filter((e) => e.type === "start" || e.type === "alive" || e.serverId === serverId);
    const { summary, outages } = computeServer(serverId, own, nowMs, useRanges, timelineStart, periods);
    servers[serverId] = summary;
    allOutages.push(...outages);
  }
  const recentDrops = allOutages.sort((a, b) => b.at - a.at).slice(0, recentLimit);
  // 承载切换记录（v2.88）：新 → 旧。
  const wanted = new Set(ids);
  const recentHandovers = sorted
    .filter((e) => e.type === "handover" && wanted.has(e.serverId) && (e.role === "standby" || e.role === "active"))
    .reverse()
    .slice(0, Number.isFinite(recentLimit) ? recentLimit : RECENT_DROPS_MAX)
    .map((e) => ({ serverId: e.serverId, at: e.at, role: e.role, reason: typeof e.reason === "string" ? e.reason : null, peer: typeof e.peer === "string" ? e.peer : null }));
  return {
    generatedAt: nowMs,
    since: sorted.length ? sorted[0].at : null,
    servers,
    recentDrops,
    recentHandovers,
    sleep: sleepSummary(periods, useRanges, nowMs),
  };
}
