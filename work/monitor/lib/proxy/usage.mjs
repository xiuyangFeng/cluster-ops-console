// 隧道使用记录（v2.62，设计稿 2026-10-12 W4）：按目标 host:port 记连接数、上下行字节、最近一次时刻，
// 以及口令的「带对了 / 没带 / 带错了 / 被拒」次数。此前代理只知道「当前有几条连接」，谁经这台电脑出过网、
// 去了哪，事后看不出来。
//
// v2.88 起一直记（此前只在口令模式不是「关」时记，要先打开「只记录」才看得到去向）：记录只在本机、0600、
// 有界（见下），集群经这台电脑去了哪、各多少流量，默认就该看得到。口令的「带对了 / 没带 / 带错了 / 被拒」
// 计数仍只在口令模式打开时才会出现（关着时代理根本不做口令判定）。
//
// 有界：
//   - 内存：只留最近 48 个整点小时桶；保留期内的目标名合计最多 200 个，超出的记进「其它」（键 "*"）。
//     被 407 拒掉的请求只能占用前一半名额——没带口令的人拿随机主机名刷，挤不掉正常流量的目标。
//   - 落盘：<runtimeDir>/proxy-usage.json（0600）不超过 128 KB。超了先把每小时的目标数压到前 40 / 20 / 10 / 5 个
//     （其余并进「其它」），再从最旧的小时开始丢。
//   - 写盘：有变化才写，最多每分钟一次（同一个定时器顺带给还开着的连接补记字节）。例外只有一个：
//     生效的口令模式变了，立刻写一次——控制面靠这份文件确认「代理已经按新设置在跑」，等一分钟太久。
//
// 小时桶按 UTC 整点切，也就是北京时间的整点（偏移是整小时）；「近 24 小时」是相对现在的窗口，
// 没有日界，与机器时区无关。
//
// 文件同时是代理给控制面的状态回报（pid、生效的口令模式）：/proxy-health 对节点上所有账号可见，
// 不往上面加任何与口令有关的东西；这份文件只有本机本人读得到。
//
// 平滑交接：新代理接管端口之后才读这份文件并开始写（start）；旧代理在放掉监听之前同步写最后一次（release），
// 之后不再写——同一时刻只有一个进程在写。旧代理排空期间那些连接后来的字节不再计入（连接数与此前的字节都在）。
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic, writePrivateFileAtomicSync } from "../atomic-file.mjs";

export const PROXY_USAGE_FILE = "proxy-usage.json";
export const PROXY_USAGE_VERSION = 1;
export const USAGE_OTHER_KEY = "*";
export const USAGE_HOUR_MS = 3600_000;
export const USAGE_HOURS = 48;
export const USAGE_TARGET_LIMIT = 200;
export const USAGE_MAX_BYTES = 128 * 1024;
export const USAGE_FLUSH_INTERVAL_MS = 60_000;
// 每个目标每小时一行，按这个顺序的 8 个数。
export const USAGE_COLUMNS = Object.freeze(["conn", "up", "down", "lastAt", "authed", "missing", "bad", "denied"]);

const [CONN, UP, DOWN, LAST_AT, AUTHED, MISSING, BAD, DENIED] = [0, 1, 2, 3, 4, 5, 6, 7];
const ROW_WIDTH = USAGE_COLUMNS.length;
// 文件太大时每小时保留的目标数，逐级收紧。
const ROW_CAPS = [40, 20, 10, 5];
// 读文件时的防御上限：不是我们写的东西不照单全收。
const PARSE_MAX_HOURS = 96;
const PARSE_MAX_TARGETS = 512;
const WRITE_ERROR_LOG_INTERVAL_MS = 10 * 60_000;

// 主机名 / IPv4：字母数字、点、连字符、下划线。IPv6 字面量另算（十六进制、冒号、点，写出来带中括号）。
const HOSTNAME_RE = /^[a-z0-9._-]{1,253}$/;
const IPV6_RE = /^[0-9a-f:.]{2,45}$/;
const KEY_RE = /^(?:[a-z0-9._-]{1,253}|\[[0-9a-f:.]{2,45}\]):\d{1,5}$/;

// 请求里的目标 → 记录用的键（"host:port"，host 小写；IPv6 带中括号）。目标来自集群侧发来的请求行，
// 是不可信输入：字符不在白名单里的（引号、控制字符、百分号……）一律返回 null，记进「其它」，不让它
// 原样进文件、再进界面。
export function usageTargetKey(host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const h = String(host ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h.includes(":")) return IPV6_RE.test(h) ? `[${h}]:${p}` : null;
  return HOSTNAME_RE.test(h) ? `${h}:${p}` : null;
}

export function isUsageKey(key) {
  return key === USAGE_OTHER_KEY || (typeof key === "string" && KEY_RE.test(key));
}

export function usageHourStart(ms) {
  return Math.floor(ms / USAGE_HOUR_MS) * USAGE_HOUR_MS;
}

const CLIENT_AGENT_PATTERNS = [
  [/\bclaude(?:-code|-cli)?\b/i, "claude"],
  [/\bcodex\b/i, "codex"],
  [/\b(?:antigravity|agy)\b/i, "antigravity"],
  [/\bgemini(?:-cli)?\b/i, "gemini"],
  [/\bzcode\b/i, "zcode"],
  [/\bopencode\b/i, "opencode"],
  [/\bcursor\b/i, "cursor"],
  [/\bpip\//i, "pip"],
  [/\bconda\//i, "conda"],
  [/\bgit\//i, "git"],
  [/\bnpm\//i, "npm"],
  [/\bpnpm\//i, "pnpm"],
  [/\byarn\//i, "yarn"],
  [/\bcurl\//i, "curl"],
  [/\bwget\//i, "wget"],
  [/\bpython(?:-requests|-urllib|-httpx)?\b/i, "python"],
  [/\b(?:node|undici)\b/i, "node"],
  [/\bgo-http-client\b/i, "go"],
];

// 请求头 User-Agent → 受控的客户端类别枚举（绝不返回或落盘原始 UA 字符串）。无法识别时返回 null。
export function classifyClientAgent(userAgent) {
  if (typeof userAgent !== "string" || !userAgent) return null;
  const sample = userAgent.slice(0, 256);
  for (const [re, label] of CLIENT_AGENT_PATTERNS) {
    if (re.test(sample)) return label;
  }
  return null;
}

const emptyRow = () => new Array(ROW_WIDTH).fill(0);
// 计数一律是不超过安全整数的非负整数：读回来的文件、socket 给的计数都先过这一道。
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0);

function mergeRow(into, from) {
  for (let i = 0; i < ROW_WIDTH; i += 1) {
    into[i] = i === LAST_AT ? Math.max(into[i], from[i]) : into[i] + from[i];
  }
  return into;
}

// 文件全文 → { pid, startedAt, writtenAt, auth: { mode, since }, hours: [{ t, targets: Map<键, 8 个数> }] } | null。
// 代理启动时接着记、控制面读来展示，都用这一个解析：形状不对的整份不认，单行不对的跳过，数值钳成非负整数。
export function parseUsageDocument(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.v !== PROXY_USAGE_VERSION || !Array.isArray(doc.hours)) return null;
  const hours = [];
  for (const bucket of doc.hours.slice(-PARSE_MAX_HOURS)) {
    const t = Number(bucket?.t);
    const source = bucket?.targets;
    if (!Number.isFinite(t) || t < 0 || t % USAGE_HOUR_MS !== 0 || !source || typeof source !== "object" || Array.isArray(source)) continue;
    const targets = new Map();
    for (const [key, raw] of Object.entries(source).slice(0, PARSE_MAX_TARGETS)) {
      if (!isUsageKey(key) || !Array.isArray(raw) || raw.length !== ROW_WIDTH) continue;
      targets.set(key, raw.map(count));
    }
    if (targets.size) hours.push({ t, targets });
  }
  hours.sort((a, b) => a.t - b.t);
  const mode = doc.auth?.mode;
  return {
    pid: Number.isInteger(doc.pid) && doc.pid > 0 ? doc.pid : null,
    startedAt: count(doc.startedAt),
    writtenAt: count(doc.writtenAt),
    auth: { mode: mode === "observe" || mode === "enforce" || mode === "off" ? mode : null, since: count(doc.auth?.since) },
    hours,
  };
}

// 一小时里的目标按「连接多 → 流量大 → 没带口令 / 被拒多」排，只留前 cap 个，其余并进「其它」。
function capTargets(targets, cap) {
  if (targets.size <= cap) return targets;
  const score = (row) => [row[CONN], row[UP] + row[DOWN], row[MISSING] + row[BAD] + row[DENIED]];
  const named = [...targets].filter(([key]) => key !== USAGE_OTHER_KEY).sort(([, a], [, b]) => {
    const [sa, sb] = [score(a), score(b)];
    return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2];
  });
  const kept = new Map(named.slice(0, cap));
  const other = [...(targets.get(USAGE_OTHER_KEY) || emptyRow())];
  for (const [, row] of named.slice(cap)) mergeRow(other, row);
  kept.set(USAGE_OTHER_KEY, other);
  return kept;
}

// 状态 → 不超过 maxBytes 的文件全文。hours：按 t 升序的 [{ t, targets: Map }]。
export function serializeUsage({ pid, startedAt, writtenAt, auth, hours }, { maxBytes = USAGE_MAX_BYTES } = {}) {
  const render = (list, cap) => JSON.stringify({
    v: PROXY_USAGE_VERSION,
    pid,
    startedAt,
    writtenAt,
    auth,
    hours: list.map(({ t, targets }) => ({ t, targets: Object.fromEntries(cap ? capTargets(targets, cap) : targets) })),
  });
  let body = render(hours, 0);
  for (const cap of ROW_CAPS) {
    if (Buffer.byteLength(body) <= maxBytes) return body;
    body = render(hours, cap);
  }
  let kept = hours;
  while (Buffer.byteLength(body) > maxBytes && kept.length > 0) {
    kept = kept.slice(1);
    body = render(kept, ROW_CAPS.at(-1));
  }
  return body;
}

async function defaultWrite(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(filePath, body);
}

function defaultWriteSync(filePath, body) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(filePath, body, { chmodDir: false });
}

// 记录器。每个方法都自己兜住异常：它是旁路，出什么错都不能影响转发。
//   setAuthMode(mode)  生效的口令模式（policy-reload 的 onAuthChange）。start 之前只记下，不读盘不写盘。
//   start()            接管端口之后调：读回已有的记录接着记；模式不是关就开始记并回报一次。
//   noteAuth / noteDenied / tunnelOpened / requestDone   server.mjs 在口令模式不是关时调。
//   release()          放掉监听之前调：同步写最后一次，此后不再记、不再写。
export function createUsageRecorder({
  filePath,
  pid = process.pid,
  now = Date.now,
  log = (line) => console.error(line),
  readFile = (file) => readFileSync(file, "utf8"),
  write = defaultWrite,
  writeSync = defaultWriteSync,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  flushIntervalMs = USAGE_FLUSH_INTERVAL_MS,
  targetLimit = USAGE_TARGET_LIMIT,
  hourBuckets = USAGE_HOURS,
  maxBytes = USAGE_MAX_BYTES,
} = {}) {
  const startedAt = now();
  const hours = new Map(); // 整点毫秒 → Map<键, 8 个数>
  const names = new Set(); // 保留期内出现过的目标名（不含「其它」）
  const live = new Set(); // 还开着的隧道：{ key, socket, lastUp, lastDown }
  let mode = "off";
  let modeSince = startedAt;
  let started = false;
  let released = false;
  let recorded = false; // 本进程记过东西之后，不再用盘上的内容覆盖内存
  let dirty = false;
  let changeSeq = 0;
  let writing = false;
  let flushAgain = false;
  let timer = null;
  let lastWriteErrorAt = -Infinity;

  const active = () => started && !released;

  function touch() {
    dirty = true;
    changeSeq += 1;
  }

  function rebuildNames() {
    names.clear();
    for (const targets of hours.values()) {
      for (const key of targets.keys()) if (key !== USAGE_OTHER_KEY) names.add(key);
    }
  }

  function prune(at) {
    const oldest = usageHourStart(at) - (hourBuckets - 1) * USAGE_HOUR_MS;
    let removed = false;
    for (const t of hours.keys()) {
      if (t < oldest) {
        hours.delete(t);
        removed = true;
      }
    }
    if (removed) rebuildNames();
  }

  // 目标名 → 这次记在哪一行。reserve：被拒的请求只能用前一半名额。
  function resolveKey(key, reserve) {
    if (!isUsageKey(key) || key === USAGE_OTHER_KEY) return USAGE_OTHER_KEY;
    if (names.has(key)) return key;
    if (names.size >= (reserve ? Math.floor(targetLimit / 2) : targetLimit)) return USAGE_OTHER_KEY;
    names.add(key);
    return key;
  }

  function rowFor(key, at, reserve = false) {
    const t = usageHourStart(at);
    if (!hours.has(t)) {
      hours.set(t, new Map());
      prune(at);
    }
    const targets = hours.get(t);
    const resolved = resolveKey(key, reserve);
    if (!targets.has(resolved)) targets.set(resolved, emptyRow());
    const row = targets.get(resolved);
    row[LAST_AT] = Math.max(row[LAST_AT], at);
    recorded = true;
    touch();
    return row;
  }

  // 还开着的隧道自上次以来的字节（读 socket 自带的计数，不在数据路径上加监听）。
  function sample(entry) {
    const up = count(entry.socket.bytesWritten) - entry.lastUp;
    const down = count(entry.socket.bytesRead) - entry.lastDown;
    if (up <= 0 && down <= 0) return;
    const row = rowFor(entry.key, now());
    if (up > 0) {
      row[UP] += up;
      entry.lastUp += up;
    }
    if (down > 0) {
      row[DOWN] += down;
      entry.lastDown += down;
    }
  }

  function sampleAll() {
    for (const entry of live) {
      try {
        sample(entry);
      } catch {}
    }
  }

  function document() {
    prune(now());
    return {
      pid,
      startedAt,
      writtenAt: now(),
      auth: { mode, since: modeSince },
      hours: [...hours].sort(([a], [b]) => a - b).map(([t, targets]) => ({ t, targets })),
    };
  }

  function logWriteError(err) {
    if (now() - lastWriteErrorAt < WRITE_ERROR_LOG_INTERVAL_MS) return;
    lastWriteErrorAt = now();
    log(`[proxy-usage] 使用记录写盘失败（${err?.code || err?.message || "未知错误"}），下一轮再试`);
  }

  // 有变化才写。上一次还没写完时不并发写第二份，记下「写完再来一次」——模式刚切到关的那一次没有
  // 下一轮定时器可等，不能丢。
  async function flush() {
    if (!filePath || !dirty || released) return false;
    if (writing) {
      flushAgain = true;
      return false;
    }
    writing = true;
    const seq = changeSeq;
    let ok = false;
    try {
      await write(filePath, serializeUsage(document(), { maxBytes }));
      if (changeSeq === seq) dirty = false;
      ok = true;
    } catch (err) {
      logWriteError(err);
    } finally {
      writing = false;
    }
    if (flushAgain) {
      flushAgain = false;
      if (ok) return flush();
    }
    return ok;
  }

  function flushSync() {
    if (!filePath || !dirty) return false;
    try {
      writeSync(filePath, serializeUsage(document(), { maxBytes }));
      dirty = false;
      return true;
    } catch (err) {
      logWriteError(err);
      return false;
    }
  }

  async function tick() {
    try {
      if (active()) sampleAll();
      return await flush();
    } catch {
      return false;
    }
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setIntervalImpl(() => {
      tick();
    }, flushIntervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function stopTimer() {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  // 读回盘上的记录（上一个代理进程留下的）接着记。读不出、不认识就从空白开始，不算错误。
  function load() {
    if (!filePath || recorded) return false;
    let parsed = null;
    try {
      parsed = parseUsageDocument(readFile(filePath));
    } catch {
      return false;
    }
    if (!parsed) return false;
    hours.clear();
    for (const { t, targets } of parsed.hours) hours.set(t, targets);
    prune(now());
    rebuildNames();
    return true;
  }

  function start() {
    if (started || released) return;
    started = true;
    try {
      load();
    } catch {}
    // 回报「这个进程已经按这个模式在跑」。
    startTimer();
    touch();
    flush();
  }

  function setAuthMode(next) {
    try {
      const value = next === "observe" || next === "enforce" ? next : "off";
      if (value === mode) return;
      const wasActive = active();
      mode = value;
      modeSince = now();
      if (!started || released) return;
      // 记录不随口令模式开关（v2.88）：只立刻写一次，让控制面确认「代理已经按新模式在跑」。
      if (wasActive) sampleAll();
      startTimer();
      touch();
      flush();
    } catch {}
  }

  function noteAuth(key, verdict) {
    if (!active()) return;
    try {
      const row = rowFor(key, now());
      if (verdict === "ok") row[AUTHED] += 1;
      else if (verdict === "missing") row[MISSING] += 1;
      else row[BAD] += 1;
    } catch {}
  }

  // 被 407 拒掉的一次。key 为 null = 这个目标本来也过不了放行策略，只进「其它」。
  function noteDenied(key, verdict) {
    if (!active()) return;
    try {
      const row = rowFor(key, now(), true);
      row[DENIED] += 1;
      if (verdict === "missing") row[MISSING] += 1;
      else row[BAD] += 1;
    } catch {}
  }

  // 一条 CONNECT 隧道建好了。socket 是通往目标（或上游代理）的那一条：写出去的是上行，读进来的是下行。
  // baseUp / baseDown：建隧道本身用掉的字节（经上游代理时的 CONNECT 请求与应答），不算流量。
  function tunnelOpened(key, socket, { baseUp = 0, baseDown = 0 } = {}) {
    if (!active() || !socket) return;
    try {
      rowFor(key, now())[CONN] += 1;
      const entry = { key, socket, lastUp: count(baseUp), lastDown: count(baseDown) };
      live.add(entry);
      socket.once("close", () => {
        if (!live.delete(entry) || !active()) return;
        try {
          sample(entry);
        } catch {}
      });
    } catch {}
  }

  // 一次明文转发结束。up / down 是正文字节（不含请求头与响应头）。
  function requestDone(key, { up = 0, down = 0 } = {}) {
    if (!active()) return;
    try {
      const row = rowFor(key, now());
      row[CONN] += 1;
      row[UP] += count(up);
      row[DOWN] += count(down);
    } catch {}
  }

  function release() {
    if (released) return;
    try {
      if (active()) sampleAll();
      if (started) flushSync();
    } catch {}
    released = true;
    live.clear();
    stopTimer();
  }

  return {
    setAuthMode,
    start,
    noteAuth,
    noteDenied,
    tunnelOpened,
    requestDone,
    tick,
    flush,
    release,
    isActive: active,
    // 测试与排障用：当前内存里的记录（与落盘同形）。
    snapshot: () => document(),
    liveCount: () => live.size,
    hasTimer: () => timer !== null,
  };
}
