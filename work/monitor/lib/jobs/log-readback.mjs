// 日志按段向前读取（v2.51）：关注区「进度依据」与「我的历史」失败诊断里的「读取前一段」。
//
// 两个入口：
//   from=watch      关注中的作业；路径 = 本机登记表（job-registry）里的 StdOut / StdErr 模板在本机展开（log-paths.mjs），
//                   log = stdout | stderr。和「进度依据」显示的是同一个文件时，从那段末尾的起点往前接着读。
//   from=diagnosis  有诊断记录的失败作业；路径 = 诊断记录里取证时记下的文件（log = 文件序号 0–5，带 stdout / stderr /
//                   同号日志的角色，v2.51 之前的旧记录没有角色），从取证时保存的末尾的起点往前读。
// 前端只给作业号、入口、流 / 序号和上一段回传的游标，不给路径；路径只在本机由登记 / 诊断记录解析。
//
// 每一段：一次 SSH（经调度器的全局槽位，与探针共用并发上限），远端只读一个 ≤ 32KB 的字节区间，按行边界对齐
// （丢掉首个不完整的行，下一段会把它读回来）。游标 = { before, ino, size, mtimeMs, sig }：远端先核对文件身份——
// inode 变了（轮转 / 重建）、变短了（截断）、大小没变但修改时刻变了或衔接处字节对不上（原地改写）、文件没了，
// 都停下并明确报错（409 + code），不拿旧游标读新文件。前端可以改为「从当前末尾重新读取」（fresh）。
// 同一请求在途合并；结果本机短期缓存（条数 + 字节双上限）。远端输出按不可信数据解析（log-segment.mjs）。

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { statusError } from "../status-error.mjs";
import { isUsageEligible } from "../usage/service.mjs";
import { isUsableLogPath, resolveRegisteredLogs } from "./log-paths.mjs";
import { buildSegmentInvocation, parseSegmentOutput, SIG_RE, textSignature } from "./log-segment.mjs";

export const READBACK_CACHE_MAX = 48;
export const READBACK_CACHE_BYTES = 2 * 1024 * 1024;
export const READBACK_CACHE_TTL_MS = 2 * 60_000;
// 同时在读的不同片段上限（同一片段在途合并，不占名额）：手动操作不该挤占采集的 SSH 槽位。
export const READBACK_INFLIGHT_MAX = 2;
export const DIAGNOSIS_FILES_MAX = 6;

const JOB_ID_RE = /^\d{1,12}(?:_\d{1,9})?$/;
const OFFSET_RE = /^\d{1,15}$/;
const INO_RE = /^\d{1,20}$/;

export const SEGMENT_ERROR_TEXT = Object.freeze({
  missing: "日志文件已不存在（可能已删除或移走），旧的读取位置已失效",
  rotated: "日志文件已被替换（轮转或重新创建），旧的读取位置已失效",
  truncated: "日志文件比上次读取时短（被截断或清空），旧的读取位置已失效",
  rewritten: "日志内容与上次读取时对不上（可能被原地改写），旧的读取位置已失效",
  notOwner: "日志文件不属于当前集群用户，已拒绝读取",
  notRegular: "登记的日志路径不是普通文件，已拒绝读取",
  binary: "这一段含二进制内容，不是文本日志",
  unreadable: "日志文件无法读取（权限或路径问题）",
});
// 这些错误意味着文件身份变了：前端应停用旧游标。
export const CURSOR_INVALID_CODES = Object.freeze(["missing", "rotated", "truncated", "rewritten"]);

const byteLength = (text) => Buffer.byteLength(typeof text === "string" ? text : "", "utf8");

// URLSearchParams → { jobId, from, log, cursor, fresh }；不合格抛 400（路由与直接调用同一道校验）。
export function parseSegmentQuery(params) {
  const get = (name) => (typeof params?.get === "function" ? params.get(name) : params?.[name] ?? null);
  const jobId = get("jobId") || "";
  if (!JOB_ID_RE.test(jobId)) throw statusError("invalid jobId");
  const from = get("from") || "";
  if (from !== "watch" && from !== "diagnosis") throw statusError("invalid from");
  const log = get("log") || "";
  if (from === "watch" ? log !== "stdout" && log !== "stderr" : !/^[0-5]$/.test(log)) throw statusError("invalid log");
  const fresh = get("fresh");
  if (fresh !== null && fresh !== "1") throw statusError("invalid fresh");
  const before = get("before");
  const cursorFields = ["ino", "size", "mtimeMs", "sig"].filter((name) => get(name) !== null);
  if (before === null) {
    if (cursorFields.length) throw statusError("cursor requires before");
    return { jobId, from, log, cursor: null, fresh: fresh === "1" };
  }
  if (fresh === "1") throw statusError("fresh and before are exclusive");
  const ino = get("ino");
  const size = get("size");
  const mtimeMs = get("mtimeMs");
  const sig = get("sig");
  if (!OFFSET_RE.test(before) || Number(before) < 1) throw statusError("invalid before");
  if (!INO_RE.test(ino || "")) throw statusError("invalid ino");
  if (!OFFSET_RE.test(size || "") || Number(size) < Number(before)) throw statusError("invalid size");
  if (mtimeMs !== null && !OFFSET_RE.test(mtimeMs)) throw statusError("invalid mtimeMs");
  if (sig !== null && !SIG_RE.test(sig)) throw statusError("invalid sig");
  return {
    jobId,
    from,
    log,
    fresh: false,
    cursor: { before: Number(before), ino, size: Number(size), mtimeMs: mtimeMs === null ? null : Number(mtimeMs), sig },
  };
}

// 关注采集的进度指纹（watch-model.mjs：`${path}:${size}:${mtime}` 以 | 连接）里取某个文件当时的大小。
// 只读不改它的格式；路径里本身带 | 或 : 也能按「整段路径 + :」定位。找不到 → null。
export function sizeFromFingerprint(fingerprint, filePath) {
  if (typeof fingerprint !== "string" || typeof filePath !== "string" || !filePath) return null;
  const marker = `${filePath}:`;
  for (let i = fingerprint.indexOf(marker); i >= 0; i = fingerprint.indexOf(marker, i + 1)) {
    if (i !== 0 && fingerprint[i - 1] !== "|") continue;
    const m = /^(\d{1,15}):\d+(?:\.\d+)?(?:\||$)/.exec(fingerprint.slice(i + marker.length));
    if (m) return Number(m[1]);
  }
  return null;
}

export function createLogReadbackService({
  registry,
  diagnoses,
  watchStore = null,
  getConfig,
  dataDir,
  execCollector,
  probeSshFailureReason = (code) => `ssh exit ${code}`,
  ready = Promise.resolve(),
  now = Date.now,
  cacheMax = READBACK_CACHE_MAX,
  cacheBytes = READBACK_CACHE_BYTES,
  cacheTtlMs = READBACK_CACHE_TTL_MS,
}) {
  const cache = new Map(); // key -> { at, bytes, value }（插入序 = 新旧序）
  let cachedBytes = 0;
  const inflight = new Map(); // key -> Promise

  function dropCache(key) {
    const hit = cache.get(key);
    if (!hit) return;
    cachedBytes -= hit.bytes;
    cache.delete(key);
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > cacheTtlMs) {
      dropCache(key);
      return null;
    }
    return hit.value;
  }

  function cachePut(key, value) {
    dropCache(key);
    const bytes = byteLength(value.segment.text) + 512;
    if (bytes > cacheBytes) return;
    cache.set(key, { at: now(), bytes, value });
    cachedBytes += bytes;
    for (const [k, hit] of cache) {
      if (cache.size <= cacheMax && cachedBytes <= cacheBytes && now() - hit.at <= cacheTtlMs) break;
      dropCache(k);
    }
  }

  // 数组子作业：登记表里运行中的子作业以实际编号登记（jobId = 实际编号，带 arrayJobId / arrayTaskId）。
  function lookupRegistered(serverId, jobId) {
    const exact = registry.lookup(serverId, jobId);
    const match = /^(\d+)_(\d+)$/.exec(jobId);
    if (!match) return { reg: exact, rawId: null };
    const task = registry.findArrayTask?.(serverId, match[1], match[2]) ?? null;
    const rawId = task && /^\d{1,12}$/.test(task.jobId) ? task.jobId : null;
    return { reg: exact || task, rawId };
  }

  async function watchTarget(serverId, q) {
    if (!watchStore) throw statusError("作业关注不可用", 503);
    const data = await watchStore.snapshot();
    const job = data.watches.filter((w) => w.serverId === serverId).flatMap((w) => w.jobs).find((j) => j.id === q.jobId);
    if (!job) throw statusError("只能读取关注中的作业日志", 404);
    const { reg, rawId } = lookupRegistered(serverId, q.jobId);
    if (!reg?.user) throw statusError("还没有登记到此作业的本人日志路径", 409);
    const logs = resolveRegisteredLogs(q.jobId, reg, { rawId });
    const filePath = logs[q.log];
    if (!filePath) throw statusError(logs.reason || "登记的日志路径不可用", 409);
    const target = { path: filePath, role: q.log, sameFile: logs.sameFile, anchor: { skip: 0 }, anchorText: null, anchorCheckedAt: null, continuous: false, notes: [] };
    const progress = job.progress;
    // 「进度依据」显示的就是这个文件：从那段末尾的起点往前接（大小取自采集时的指纹）。
    if (progress?.path === filePath && typeof progress.tail === "string") {
      const size = sizeFromFingerprint(progress.fingerprint, filePath);
      if (size !== null) {
        target.anchor = { end: Math.max(0, size - byteLength(progress.tail)), expect: { size, sig: textSignature(progress.tail) } };
        target.anchorCheckedAt = Number.isFinite(progress.checkedAt) ? progress.checkedAt : null;
        target.continuous = true;
      } else {
        target.notes.push("采集记录里没有这个文件当时的大小，从当前文件末尾往前读，可能与上方末尾不连续");
      }
    }
    return target;
  }

  function diagnosisTarget(serverId, q) {
    const item = diagnoses.get(serverId, q.jobId);
    if (!item) throw statusError("没有这个作业的诊断记录", 404);
    const file = (Array.isArray(item.files) ? item.files : []).slice(0, DIAGNOSIS_FILES_MAX)[Number(q.log)];
    if (!file) throw statusError("诊断记录里没有这个日志", 404);
    if (!isUsableLogPath(file.path)) throw statusError("诊断记录里的日志路径不可用", 409);
    const tail = typeof file.tail === "string" ? file.tail : "";
    const target = { path: file.path, role: file.role ?? null, sameFile: false, anchorText: tail, anchorCheckedAt: null, continuous: true, notes: [] };
    if (Number.isSafeInteger(file.size) && file.size >= 0) {
      target.anchor = { end: Math.max(0, file.size - byteLength(tail)), expect: { size: file.size, sig: textSignature(tail) } };
    } else {
      // v2.51 之前的诊断记录没记采集时的大小：按当前末尾往前跳过已保存的字节；衔接处签名不符时远端会报「对不上」。
      target.anchor = { skip: byteLength(tail), expect: { sig: textSignature(tail) } };
      target.notes.push("该诊断记录早于本功能，没有记下取证时的文件大小，按当前文件末尾对齐");
    }
    return target;
  }

  async function fetchSegment(server, config, request) {
    const invocation = buildSegmentInvocation({
      server,
      parsed: config,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
      request,
    });
    let res;
    try {
      res = await execCollector(invocation, server);
    } catch (error) {
      res = { code: null, stdout: "", stderr: String(error?.message || error) };
    }
    const parsed = parseSegmentOutput(res?.stdout);
    if (parsed.ok) return parsed.segment;
    if (parsed.code) throw statusError(SEGMENT_ERROR_TEXT[parsed.code] || SEGMENT_ERROR_TEXT.unreadable, 409, { code: parsed.code });
    throw statusError(`日志读取失败（${probeSshFailureReason(res?.code ?? null, res?.stderr ?? "", res?.stdout ?? "")}）`, 502, { code: "ssh" });
  }

  // query：parseSegmentQuery 的结果或原始参数。acquireSshSlot：调度器的全局槽位（路由注入；缺省不限流，仅测试）。
  async function read(serverId, query, { acquireSshSlot = null } = {}) {
    const q = query && typeof query === "object" && "cursor" in query ? query : parseSegmentQuery(query);
    const config = await getConfig();
    if (!isDataModuleEnabled(config, "jobs")) throw statusError("我的 Slurm 作业模块已关闭", 409);
    const server = (config?.servers || []).find((s) => s.id === serverId);
    if (!isUsageEligible(server)) throw statusError("服务器不在作业采集范围", 404);
    await ready;
    const target = q.from === "diagnosis" ? diagnosisTarget(serverId, q) : await watchTarget(serverId, q);
    const anchored = !q.cursor && !q.fresh;
    const request = q.cursor
      ? { path: target.path, end: q.cursor.before, expect: { ino: q.cursor.ino, size: q.cursor.size, mtimeMs: q.cursor.mtimeMs, sig: q.cursor.sig } }
      : q.fresh
        ? { path: target.path, skip: 0 }
        : { path: target.path, ...target.anchor };
    const key = JSON.stringify([serverId, request.path, request.end ?? null, request.skip ?? null, request.expect ?? null]);
    // fresh = 用户明确要当前文件末尾（多半刚遇到游标失效）：不吃缓存，结果照常入缓存。
    const cached = q.fresh ? null : cacheGet(key);
    let segment = cached?.segment ?? null;
    if (!segment) {
      let pending = inflight.get(key);
      if (!pending) {
        if (inflight.size >= READBACK_INFLIGHT_MAX) throw statusError("已有日志读取在进行，请稍后再试", 429);
        pending = (async () => {
          const release = typeof acquireSshSlot === "function" ? await acquireSshSlot({ hostKey: server.host || null }) : null;
          try {
            return await fetchSegment(server, config, request);
          } finally {
            release?.();
          }
        })();
        inflight.set(key, pending);
        pending.finally(() => inflight.delete(key)).catch(() => {});
      }
      segment = await pending;
      if (!cacheGet(key)) cachePut(key, { segment, fetchedAt: now() });
    }
    const fetchedAt = cacheGet(key)?.fetchedAt ?? now();
    return {
      jobId: q.jobId,
      from: q.from,
      log: q.log,
      role: target.role,
      path: target.path,
      sameFile: target.sameFile,
      start: segment.start,
      end: segment.end,
      size: segment.size,
      dropped: segment.dropped,
      noBreak: segment.noBreak,
      text: segment.text,
      atStart: segment.start === 0,
      next: segment.start > 0 ? { before: segment.start, ino: segment.ino, size: segment.size, mtimeMs: segment.mtimeMs, sig: segment.sig } : null,
      // 只有第一段带：它衔接的是哪段已显示的末尾（诊断 = 取证时保存的末尾原文；关注 = 那一轮采集的时刻）。
      anchorText: anchored && q.from === "diagnosis" ? target.anchorText : null,
      anchorCheckedAt: anchored ? target.anchorCheckedAt : null,
      continuous: q.cursor ? true : anchored && target.continuous,
      notes: anchored ? target.notes : [],
      cached: Boolean(cached),
      fetchedAt,
    };
  }

  return { read, cacheSize: () => cache.size };
}
