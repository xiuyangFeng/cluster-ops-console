// Agent 用量的本机持久化（runtimeDir/usage/<serverId>/）。
//
// 为什么要本机存：Claude Code 默认只保留 30 天会话日志，远端日志是会消失的；控制台把
// 扫描到的每次调用沉淀下来，历史才不随远端清理而丢失。
//
// 布局（全部紧凑数组，单日文件 ~百 KB）：
//   days/YYYY-MM-DD.json  当天的调用 / 轮次 / 压缩事件（按北京时间、按每次调用自己的时间归日）
//   sessions.json         会话元数据（工作目录、上下文窗口、首末时间）
//   cursors.json          远端文件游标 + 最近一次扫描的状态
// 写入顺序：先数据、后游标。中途崩溃只会让下一轮重读一段已存的数据（按 ID 去重，结果不变），
// 不会出现「游标前进了、数据没落盘」的丢数。
//
// 并发与常驻（v2.57）：
//   · 冷启动：每台服务器一个共享的加载 Promise，所有首次读取（启动扫描取游标、首页摘要……）等同一次
//     读盘；成功才标记已加载，失败清掉 Promise、下次访问重试。加载完成 / 入库 / 清理都推进 revision()，
//     摘要层据此让缓存失效。
//   · 90 天保留：每次访问检查「保留期起点」（北京时间日期）是否变了，跨日时清理一次——内存里的调用 /
//     轮次 / 压缩 / 会话 / 游标、磁盘上的旧日文件、错误原文字节计数一起更新。常驻进程不重启也持续生效。
//   · 落盘按服务器串行（见 flushData）：探针入库、跨日清理、失败记录都可能触发写盘，且会交错。一轮只写
//     它开始那一刻的游标；写盘途中又被改动的日会重新标脏，由下一轮写出——游标永远不会先于它对应的数据。
//   · 空转不写盘：没有新数据、游标也没动的一轮（稳态下每分钟一次）既不重写游标文件，也不推进 revision()；
//     扫描状态里的时刻最多每 USAGE_SCAN_CLOCK_FLUSH_MS 落一次盘（见 planCursorsWrite）。
//
// 去重键：调用 = agent|rid（同一调用多份记录取用量最大的一份，见 ingest）；
// 轮次 = agent|sid|tid（Codex 的开始 / 结束分两次到达，字段合并）；压缩 = agent|sid|t。
//
// 内存里的记录（常驻内存）：调用 / 轮次 / 压缩事件自带 serverId 与 day（归日），会话自带 serverId，表里直接存记录本身；
// 快照（snapshot）交出的就是这些对象，不再逐条复制——十万条调用的量级，复制一份要多占 20MB 以上。
// 记录入表后只会被整条替换、从不原地修改；拿到快照的一方（model.mjs）同样只读。

import * as nodeFsPromises from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { dayKeyOf } from "./time.mjs";
import { ERROR_TEXT_BUDGET_BYTES, errorTextBytes } from "./error-text.mjs";

export const USAGE_RETENTION_DAYS = 90;
// 游标文件里只有扫描状态的时刻每轮都变。为了这几个数字每分钟整份重写一次游标文件（现役 797 个游标、
// 约 218 KB）不值得：只有时刻变了的一轮最多每 5 分钟落一次盘。代价是重启后读回的「上次同步」时刻
// 最多旧 5 分钟（仍是一次真实扫描的时刻），启动后的第一轮扫描几秒内就会把它刷新。
export const USAGE_SCAN_CLOCK_FLUSH_MS = 5 * 60 * 1000;
// 扫描状态里的事实（是否扫完 / 待读文件数 / 失败原因 / 根目录 / 家目录）：抹掉三个时刻类字段后的样子。
// 事实变了立刻落盘，不受上面的间隔限制——重启后读到的失败原因、回填进度永远是最后一轮的。
const scanFactsJson = (scan) => JSON.stringify({ ...scan, lastScanAt: null, lastOkAt: null, lastDurationSec: null });
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const LOAD_READ_AHEAD = 6;
const SERVER_DIR_RE = /^[A-Za-z0-9._-]{1,64}$/;

// 归日一律按北京时间（lib/usage/time.mjs），与本机时区无关；保留这个导出给既有调用方。
export { dayKeyOf };

// 调用的去重键 = 「agent|」前缀 + rid。前缀每个 Agent 只拼一次、所有键共用（常驻内存）：V8 把这样的键存成指向
// 前缀与 rid 两段的拼接串，键的值与逐条拼 `${agent}|${rid}` 完全相同，但不再为十万条调用各存一份前缀（真实数据 -3MB）。
const keyPrefixes = new Map(); // agent → "agent|"
const KEY_PREFIX_MAX = 64; // Agent 只有个位数；坏数据里的怪值超出上限后照常现拼，不再缓存
function keyPrefix(agent) {
  let prefix = keyPrefixes.get(agent);
  if (prefix === undefined) {
    prefix = `${agent}|`;
    if (keyPrefixes.size < KEY_PREFIX_MAX) keyPrefixes.set(agent, prefix);
  }
  return prefix;
}
const callKey = (c) => `${keyPrefix(c.agent)}${c.rid}`;
const totalTokens = (c) => c.inFresh + c.cacheWrite + c.cacheRead + c.output;
// 同一调用的两份记录谁更可信：用量更大者；用量相同取时间更早者；完全相同时保持现状（不算更新）。
const isBetterCopy = (next, prev) => totalTokens(next) > totalTokens(prev)
  || (totalTokens(next) === totalTokens(prev) && next.t < prev.t)
  || (totalTokens(next) === totalTokens(prev) && next.t === prev.t && JSON.stringify(next) !== JSON.stringify(prev));
const turnKey = (t) => `${t.agent}|${t.sid}|${t.tid}`;
const compactKey = (x) => `${x.agent}|${x.sid}|${x.t}`;
const sessionKey = (agent, sid) => `${agent}|${sid}`;

// [14] 错误原文（v2.51 起，只有失败调用才有这一位）：字符串 = 原文（"" = 日志里没有文本）；
// 0 = 超出本机保存上限未保存；缺省 = 采集于 v2.51 之前。旧版读到多出的一位会直接忽略。
// 落盘只写各自的字段（serverId / day 由目录与日文件表达，不进行内）；读回时一次性建出带 serverId / day 的完整记录，
// 字段写在同一个字面量里（之后再补属性会让十万个对象各多挂一块属性数组）。
function packCall(c) {
  const row = [c.agent, c.rid, c.sid, c.t, c.ok ? 1 : 0, c.code, c.inFresh, c.cacheWrite, c.cacheRead, c.output, c.prompt, c.model, c.turnId, c.sidechain ? 1 : 0];
  if (!c.ok && (c.errorDropped || typeof c.errorText === "string")) row.push(c.errorDropped ? 0 : c.errorText);
  return row;
}
const unpackCall = (a, serverId, day) => ({ agent: a[0], rid: a[1], sid: a[2], t: a[3], ok: a[4] === 1, code: a[5] ?? null, inFresh: a[6] || 0, cacheWrite: a[7] || 0, cacheRead: a[8] || 0, output: a[9] || 0, prompt: a[10] || 0, model: a[11] ?? null, turnId: a[12] ?? null, sidechain: a[13] === 1, errorText: a[4] !== 1 && typeof a[14] === "string" ? a[14] : null, errorDropped: a[4] !== 1 && a[14] === 0, serverId, day });
const packTurn = (t) => [t.agent, t.sid, t.tid, t.t0, t.t1];
const unpackTurn = (a, serverId, day) => ({ agent: a[0], sid: a[1], tid: a[2], t0: a[3] ?? null, t1: a[4] ?? null, serverId, day });
const packCompact = (x) => [x.agent, x.sid, x.t];
const unpackCompact = (a, serverId, day) => ({ agent: a[0], sid: a[1], t: a[2], serverId, day });
const packSession = (s) => [s.agent, s.sid, s.cwd, s.window, s.firstT, s.lastT];
const unpackSession = (a, serverId) => ({ agent: a[0], sid: a[1], cwd: a[2] ?? null, window: a[3] ?? null, firstT: a[4] ?? null, lastT: a[5] ?? null, serverId });

function createServerData(dir, serverId) {
  return {
    dir,
    serverId,
    calls: new Map(), // key → 记录（带 serverId / day，见文件头「内存里的记录」）
    turns: new Map(),
    compacts: new Map(),
    sessions: new Map(), // agent|sid → 记录（带 serverId）
    cursors: {},
    scan: { lastScanAt: null, lastOkAt: null, complete: null, pending: null, lastError: null, lastDurationSec: null },
    dirtyDays: new Set(),
    sessionsDirty: false,
    cursorsOnDisk: null, // 上一次成功写出的游标文件 { cursors, scan, facts, at }；null = 本进程还没写成过，下一轮照写
    errorTextBytes: 0, // 保留期内已存错误原文的总字节（上限 ERROR_TEXT_BUDGET_BYTES）
    loaded: false,
    loadPromise: null, // 首次加载进行中：并发的首次读取共享这一个
    prunedCutoff: null, // 最近一次保留期清理时的起点日期（变了 = 跨日，需要再清一次）
    pruning: null, // 进行中的那次保留期清理：并发的访问等同一次（见 pruneExpired）
    flushTail: Promise.resolve(), // 写盘队列的队尾：下一轮 flush 接在它后面（见 flushData）
  };
}

// fs 可注入（node:fs/promises 的形状；测试用它编排并发写盘的先后）。
// log：ops 日志，某份文件解析不了时记一条警告。
export function createUsageStore({ rootDir, retentionDays = USAGE_RETENTION_DAYS, now = Date.now, errorTextBudgetBytes = ERROR_TEXT_BUDGET_BYTES, fs = nodeFsPromises, log = () => {} } = {}) {
  const servers = new Map();

  // 读不到 → null。解析不了的先留档（<名字>.corrupt-<北京时间>，同名最多 2 份）再当没有：日文件之后整份重写、
  // 游标丢了只是下一轮从头读（去重兜得住）；但集群上的 Claude 日志只留 30 天，更早的用量只在本机，留档是唯一的出处。
  async function readText(file) {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  }

  async function parseJson(file, text) {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      if (isParseFailure(err)) await archiveCorruptFile(file, { fs, now, log, label: "Agent 用量" });
      return null;
    }
  }

  const cutoffDay = () => dayKeyOf(now() / 1000 - retentionDays * 86400);

  function dataFor(serverId) {
    if (!SERVER_DIR_RE.test(String(serverId))) throw new Error(`invalid usage serverId: ${serverId}`);
    if (!servers.has(serverId)) servers.set(serverId, createServerData(path.join(rootDir, serverId), serverId));
    return servers.get(serverId);
  }

  // 数据版本：加载完成、确有变化的入库、保留期清理都会 +1；摘要缓存以它为键之一。
  // 空转的一轮（数据与游标都没变）不推进——否则摘要快照每分钟白白重建一次。
  let revision = 0;

  // 读盘构建一份完整的服务器数据；中途出错整体作废（不留半份），由调用方决定重试。
  async function load(dir, serverId) {
    const data = createServerData(dir, serverId);
    const cutoff = cutoffDay();
    let names = [];
    try {
      names = await fs.readdir(path.join(dir, "days"));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err; // 还没有数据目录 = 空；其他读盘错误交给下次访问重试
    }
    // 冷启动（perf）：会话 / 游标文件与日文件一开始就并行去读，日文件最多预读 LOAD_READ_AHEAD 份，读盘与解析重叠；
    // 解析与入表仍严格按目录顺序（Map 的插入顺序决定快照里调用的先后），结果与逐个读完全相同。
    const sessionsText = readText(path.join(dir, "sessions.json"));
    const cursorsText = readText(path.join(dir, "cursors.json"));
    // Agent 名 / 会话 ID / 轮次 ID / 模型名在日文件里一条调用写一遍，JSON.parse 每处都新建一份字符串：
    // 加载时按值共用同一份（常驻内存 -10MB，十万条调用的量级），值不变。
    const pool = new Map();
    const intern = (v) => {
      if (typeof v !== "string") return v;
      const hit = pool.get(v);
      if (hit !== undefined) return hit;
      pool.set(v, v);
      return v;
    };
    const dayFiles = [];
    for (const name of names) {
      const match = DAY_FILE_RE.exec(name);
      if (!match) continue;
      if (match[1] < cutoff) continue; // 过期日文件不读，删除交给 pruneExpired
      dayFiles.push({ day: match[1], file: path.join(dir, "days", name) });
    }
    const texts = new Array(dayFiles.length).fill(null);
    const prefetch = (i) => {
      if (i < dayFiles.length && texts[i] === null) texts[i] = readText(dayFiles[i].file);
    };
    for (let i = 0; i < LOAD_READ_AHEAD; i += 1) prefetch(i);
    for (let i = 0; i < dayFiles.length; i += 1) {
      prefetch(i + LOAD_READ_AHEAD);
      const { day, file } = dayFiles[i];
      const text = await texts[i];
      texts[i] = undefined; // 解析完就放手，不把整份目录的原文同时留在内存里
      const body = await parseJson(file, text);
      if (!body) continue;
      // 归日按记录自己的时间戳重算：旧版（v2.41.2 及以前）按本机时区写的日文件，在这里自动改归
      // 北京时间，涉及的日子标脏，下次写盘时重写（空了的旧日文件随之删除），无需重新扫描。
      const dayOf = (t) => {
        const actual = Number.isFinite(t) ? dayKeyOf(t) : day;
        if (actual !== day) { data.dirtyDays.add(day); data.dirtyDays.add(actual); }
        return actual;
      };
      for (const row of body.calls || []) { row[0] = intern(row[0]); row[2] = intern(row[2]); row[11] = intern(row[11]); row[12] = intern(row[12]); const rec = unpackCall(row, serverId, dayOf(row[3])); data.calls.set(callKey(rec), rec); data.errorTextBytes += errorTextBytes(rec.errorText); }
      for (const row of body.turns || []) { row[1] = intern(row[1]); const rec = unpackTurn(row, serverId, dayOf(row[3] ?? row[4])); data.turns.set(turnKey(rec), rec); }
      for (const row of body.compacts || []) { const rec = unpackCompact(row, serverId, dayOf(row[2])); data.compacts.set(compactKey(rec), rec); }
    }
    const sessions = await parseJson(path.join(dir, "sessions.json"), await sessionsText);
    for (const row of sessions?.sessions || []) { const rec = unpackSession(row, serverId); data.sessions.set(sessionKey(rec.agent, rec.sid), rec); }
    const cursors = await parseJson(path.join(dir, "cursors.json"), await cursorsText);
    if (cursors?.cursors && typeof cursors.cursors === "object") data.cursors = cursors.cursors;
    if (cursors?.scan && typeof cursors.scan === "object") data.scan = { ...data.scan, ...cursors.scan };
    return data;
  }

  // 保留期清理：保留期起点（北京时间日期）变了才做，一天一次。内存先同步删掉（之后的读取立刻一致），
  // 再删磁盘上的旧日文件、重写会话与游标；写盘失败下次访问重试（内存删除幂等）。
  //
  // 并发的访问等同一次清理（data.pruning），按到达顺序继续。不等的话，恰好负责清理的那个调用会落到后来者
  // 之后：首次访问时它在等 readdir，后到的 ingest 已经改完数据并推进了游标，它醒来再写自己那份较旧的游标，
  // 就把新的盖掉了——数据不丢，只是下一轮多读。真实的探针不会对同一台服务器并发入库，是 CI 的慢盘把这个
  // 顺序暴露出来的（v2.57 上线前）。
  function pruneExpired(data) {
    const cutoff = cutoffDay();
    if (data.prunedCutoff === cutoff) return data.pruning;
    data.prunedCutoff = cutoff;
    data.pruning = pruneNow(data, cutoff).finally(() => {
      data.pruning = null;
    });
    return data.pruning;
  }

  // 永不 reject：出错时把 prunedCutoff 置空，下次访问重试。
  async function pruneNow(data, cutoff) {
    const cutoffSec = now() / 1000 - retentionDays * 86400;
    let changed = false;
    for (const map of [data.calls, data.turns, data.compacts]) {
      for (const [key, rec] of map) {
        if (rec.day >= cutoff) continue;
        if (map === data.calls) data.errorTextBytes -= errorTextBytes(rec.errorText);
        map.delete(key);
        data.dirtyDays.add(rec.day); // 写盘时这一天已空 → 删除日文件
        changed = true;
      }
    }
    for (const [key, rec] of data.sessions) {
      if ((rec.lastT ?? rec.firstT ?? Infinity) >= cutoffSec) continue;
      data.sessions.delete(key);
      data.sessionsDirty = true;
      changed = true;
    }
    for (const [file, cursor] of Object.entries(data.cursors)) {
      if ((cursor?.mt || 0) < cutoffSec) { delete data.cursors[file]; changed = true; }
    }
    if (changed) revision += 1;
    try {
      let names = [];
      try {
        names = await fs.readdir(path.join(data.dir, "days"));
      } catch {}
      for (const name of names) {
        const match = DAY_FILE_RE.exec(name);
        if (match && match[1] < cutoff) await fs.unlink(path.join(data.dir, "days", name)).catch(() => {});
      }
      if (changed) await flushData(data);
    } catch {
      data.prunedCutoff = null;
    }
  }

  async function ensureLoaded(serverId) {
    const data = dataFor(serverId);
    if (!data.loaded) {
      // 并发的首次读取共享同一次加载；成功才标记已加载，失败清掉 Promise，下次访问重试。
      data.loadPromise ??= load(data.dir, serverId).then((fresh) => {
        Object.assign(data, fresh, { loaded: true, loadPromise: null });
        revision += 1;
      }, (err) => {
        data.loadPromise = null;
        throw err;
      });
      await data.loadPromise;
    }
    await pruneExpired(data);
    return data;
  }

  function place(map, key, rec, data) {
    const prev = map.get(key);
    if (prev && prev.day !== rec.day) data.dirtyDays.add(prev.day);
    map.set(key, rec);
    data.dirtyDays.add(rec.day);
  }

  function touchSession(data, agent, sid, patch) {
    const key = sessionKey(agent, sid);
    const prev = data.sessions.get(key) || { agent, sid, cwd: null, window: null, firstT: null, lastT: null, serverId: data.serverId };
    const next = { ...prev };
    if (patch.cwd && !next.cwd) next.cwd = patch.cwd;
    if (patch.window) next.window = patch.window;
    if (Number.isFinite(patch.t)) {
      next.firstT = next.firstT === null ? patch.t : Math.min(next.firstT, patch.t);
      next.lastT = next.lastT === null ? patch.t : Math.max(next.lastT, patch.t);
    }
    if (JSON.stringify(next) === JSON.stringify(prev)) return false;
    data.sessions.set(key, next);
    data.sessionsDirty = true;
    return true;
  }

  // 合入一轮扫描结果（parseUsageScanOutput 的产物）。返回本轮新增 / 更新的调用数。
  async function ingest(serverId, parsed, { scannedAt = now() } = {}) {
    const data = await ensureLoaded(serverId);
    const cutoff = cutoffDay();
    let added = 0;
    let updated = 0;
    let changed = false; // 本轮有没有改到数据（会话 / 调用 / 轮次 / 压缩）或游标；扫描状态不算
    for (const s of parsed.sessions || []) changed = touchSession(data, s.agent, s.sid, { cwd: s.cwd, window: s.window }) || changed;
    for (const incoming of parsed.calls || []) {
      const day = dayKeyOf(incoming.t);
      if (day < cutoff) continue;
      const key = callKey(incoming);
      const prev = data.calls.get(key);
      // 错误原文有总字节上限：放不下就只记「未保存」，不挤掉已有原文（同一调用重读时先扣掉旧的那份）。
      const prevBytes = errorTextBytes(prev?.errorText);
      const bytes = errorTextBytes(incoming.errorText);
      // 入表的记录在调用本身之后补上 serverId / day。旧记录同样带着这两项，且同一调用的 serverId 相同、day 只由 t 决定，
      // 所以下面两处整条 JSON 比较的结论与只比调用本身完全一致。
      const call = bytes && data.errorTextBytes - prevBytes + bytes > errorTextBudgetBytes
        ? { ...incoming, errorText: null, errorDropped: true, serverId, day }
        : { ...incoming, serverId, day };
      if (prev && JSON.stringify(prev) === JSON.stringify(call)) continue;
      // 同一调用的多份记录里只有用量最大的是最终值（内容块逐行增长 / 分叉副本为 0 / 子 Agent 副本是中间值）；
      // 总量相同取时间最早的（恢复会话的副本时间戳是复制那一刻）。结果与文件读取顺序无关。
      if (prev?.ok && call.ok && !isBetterCopy(call, prev)) continue;
      if (prev) updated += 1;
      else added += 1;
      data.errorTextBytes += errorTextBytes(call.errorText) - prevBytes;
      place(data.calls, key, call, data);
      touchSession(data, call.agent, call.sid, { t: call.t });
      changed = true;
    }
    for (const turn of parsed.turns || []) {
      const key = turnKey(turn);
      const prev = data.turns.get(key);
      const t0 = turn.t0 ?? prev?.t0 ?? null;
      const t1 = turn.t1 ?? prev?.t1 ?? null;
      const day = dayKeyOf(t0 ?? t1);
      if (day < cutoff) continue;
      if (prev && prev.t0 === t0 && prev.t1 === t1) continue;
      place(data.turns, key, { ...turn, t0, t1, serverId, day }, data);
      changed = true;
    }
    for (const compact of parsed.compacts || []) {
      const key = compactKey(compact);
      if (data.compacts.has(key) || dayKeyOf(compact.t) < cutoff) continue;
      place(data.compacts, key, { ...compact, serverId, day: dayKeyOf(compact.t) }, data);
      changed = true;
    }
    // 游标：远端只回传本轮读过的文件；mtime 早于保留期的旧游标顺手淘汰（远端也不会再读它们）。
    // 末行还没写完的文件每轮都会原样回传同一份游标——内容没变不算「动了」。
    for (const [file, cursor] of Object.entries(parsed.cursors || {})) {
      if (JSON.stringify(data.cursors[file]) !== JSON.stringify(cursor)) changed = true;
      data.cursors[file] = cursor;
    }
    const cutoffSec = now() / 1000 - retentionDays * 86400;
    for (const [file, cursor] of Object.entries(data.cursors)) {
      if ((cursor?.mt || 0) >= cutoffSec) continue;
      delete data.cursors[file];
      changed = true;
    }
    // 扫描状态只由带收尾记录的完整一轮更新；没跑完的一轮（超时 / SSH 中断）只入库已收到的数据。
    if (parsed.end) data.scan = {
      ...data.scan,
      lastScanAt: scannedAt,
      lastOkAt: scannedAt,
      complete: parsed.end?.complete ?? null,
      pending: parsed.end ? Math.max(0, parsed.end.pending - parsed.end.files) : null,
      lastError: null,
      lastDurationSec: parsed.end?.sec ?? null,
      roots: parsed.end?.roots ?? data.scan.roots ?? null,
      installed: parsed.end?.installed ?? data.scan.installed ?? null,
      home: parsed.end?.home ?? data.scan.home ?? null,
    };
    if (changed) revision += 1;
    await flushData(data);
    return { added, updated };
  }

  async function recordError(serverId, reason, { at = now() } = {}) {
    const data = await ensureLoaded(serverId);
    data.scan = { ...data.scan, lastScanAt: at, lastError: String(reason || "").slice(0, 300) };
    // 也走写盘队列：直接写游标文件会把并发 ingest 刚推进、数据还没落盘的游标一并写出去。
    await flushData(data);
  }

  // 显式落盘：内存里有什么盘上就有什么——攒着没写的扫描时刻也一并写出，不等间隔。
  async function flush(serverId) {
    await flushData(await ensureLoaded(serverId), { force: true });
  }

  // 落盘入口：每台服务器一条写盘队列，前一轮结束才开始下一轮（前一轮失败不影响后面的）。
  //
  // 触发写盘的有三处——探针入库、跨日清理（任何一次访问都可能触发，比如首页摘要）、失败记录——它们会交错。
  // 旧实现各跑各的，收尾时整表 dirtyDays.clear()、再写「当前」游标：一轮写盘途中另一轮 ingest 标脏的日
  // 被顺手清掉（之后谁也不会再写它），而那次 ingest 推进的游标已经写了出去——「游标前进了、数据没落盘」，
  // 这时重启就丢数；两轮同时写同一个日文件，还可能旧内容后落盘、盖掉新内容。
  function flushData(data, options) {
    const run = data.flushTail.then(() => flushOnce(data, options));
    data.flushTail = run.catch(() => {});
    return run;
  }

  // 这一轮要不要写游标文件；要写就返回 { body, memo }，不用写返回 null。与「此刻的游标」同一拍取（无 await）。
  // 拿候选内容与上一次成功写出的那份（data.cursorsOnDisk）比，而不是另记一个脏标记：
  //   · 游标或扫描事实不一样 → 写。上一次没写成时记忆还是更早的那份（或 null），所以失败之后必然重试。
  //   · 只有扫描时刻不一样（空转的一轮）→ 距上次写出满 USAGE_SCAN_CLOCK_FLUSH_MS 才写；force 时不等。
  //     本机时钟被往回拨（差值为负）也照写，不至于一直等到时钟追上来。
  //   · 逐字节相同 → 不写。
  function planCursorsWrite(data, force) {
    const cursors = JSON.stringify(data.cursors);
    const scan = JSON.stringify(data.scan);
    const facts = scanFactsJson(data.scan);
    const last = data.cursorsOnDisk;
    const at = now();
    const due = last && (force || at - last.at >= USAGE_SCAN_CLOCK_FLUSH_MS || at < last.at);
    if (last && last.cursors === cursors && last.facts === facts && (last.scan === scan || !due)) return null;
    // 与 JSON.stringify({ v: 1, scan, cursors }) 逐字节相同；拼接是为了不把游标表再序列化一遍。
    return { body: `{"v":1,"scan":${scan},"cursors":${cursors}}`, memo: { cursors, scan, facts, at } };
  }

  // 一轮写盘。开头同步取下「要写哪些日」与「此刻的游标」，之后按 日文件 → 会话 → 游标 的顺序写：
  //   · 写出的游标是这一轮开始时的那份。写盘途中别的 ingest 再推进的游标不在其中——它的数据可能还没写，
  //     留给它自己排在后面的那一轮（那一轮先写完它的数据）。
  //   · 每个日先摘掉脏标记、再取数（中间没有 await）：取数之后的改动会重新标脏，由下一轮写出。
  //   · 哪一步失败就把那个标记放回去并抛出：游标不写，下一轮重试。
  //   · 什么都不用写（空转）时一次 fs 调用都不发。
  async function flushOnce(data, { force = false } = {}) {
    const days = [...data.dirtyDays].sort();
    const cursorsFile = planCursorsWrite(data, force);
    if (!days.length && !data.sessionsDirty && !cursorsFile) return;
    const daysDir = path.join(data.dir, "days");
    await fs.mkdir(daysDir, { recursive: true, mode: 0o700 });
    for (const day of days) {
      data.dirtyDays.delete(day);
      const pick = (map, pack) => [...map.values()].filter((rec) => rec.day === day).map(pack);
      const body = { v: 1, calls: pick(data.calls, packCall), turns: pick(data.turns, packTurn), compacts: pick(data.compacts, packCompact) };
      try {
        if (body.calls.length + body.turns.length + body.compacts.length === 0) await fs.unlink(path.join(daysDir, `${day}.json`)).catch(() => {});
        else await writeFileAtomic(path.join(daysDir, `${day}.json`), JSON.stringify(body), { fs });
      } catch (err) {
        data.dirtyDays.add(day);
        throw err;
      }
    }
    if (data.sessionsDirty) {
      data.sessionsDirty = false;
      const cutoffSec = now() / 1000 - retentionDays * 86400;
      for (const [key, rec] of data.sessions) if ((rec.lastT ?? rec.firstT ?? Infinity) < cutoffSec) data.sessions.delete(key);
      try {
        await writeFileAtomic(path.join(data.dir, "sessions.json"), JSON.stringify({ v: 1, sessions: [...data.sessions.values()].map(packSession) }), { fs });
      } catch (err) {
        data.sessionsDirty = true;
        throw err;
      }
    }
    if (!cursorsFile) return;
    await writeFileAtomic(path.join(data.dir, "cursors.json"), cursorsFile.body, { fs });
    data.cursorsOnDisk = cursorsFile.memo; // 写成了才记：失败时保持原样，下一轮比出不同再写
  }

  async function getCursors(serverId) {
    return { ...(await ensureLoaded(serverId)).cursors };
  }

  async function getScanStatus(serverId) {
    return { ...(await ensureLoaded(serverId)).scan };
  }

  // 只读快照：给聚合模型用。sinceDay 之前的数据不返回（日历 / 近 30 天都在保留期内）。
  // 交出的是表里的记录本身（已带 serverId / day，见文件头「内存里的记录」），只读，不得修改。
  async function snapshot(serverIds, { sinceDay = "0000-00-00" } = {}) {
    const out = { calls: [], turns: [], compacts: [], sessions: [] };
    for (const serverId of serverIds) {
      const data = await ensureLoaded(serverId);
      for (const rec of data.calls.values()) if (rec.day >= sinceDay) out.calls.push(rec);
      for (const rec of data.turns.values()) if (rec.day >= sinceDay) out.turns.push(rec);
      for (const rec of data.compacts.values()) if (rec.day >= sinceDay) out.compacts.push(rec);
      for (const rec of data.sessions.values()) out.sessions.push(rec);
    }
    return out;
  }

  // 本机最早有数据的那天（日历里更早的日期 = 「未采集」，不是 0）。
  async function coverageStart(serverIds) {
    let earliest = null;
    for (const serverId of serverIds) {
      const data = await ensureLoaded(serverId);
      for (const { day } of data.calls.values()) if (earliest === null || day < earliest) earliest = day;
    }
    return earliest;
  }

  return { ingest, recordError, flush, getCursors, getScanStatus, snapshot, coverageStart, ensureLoaded, revision: () => revision };
}
