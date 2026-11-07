// supervisor-control.mjs —— T04b monitor ↔ supervisor 的本机文件控制信箱。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §7.3）：
//   - supervisor 独立运行且可跨 monitor 生命周期接管，不能依赖父子 IPC；本协议是
//     runtime/control/<instanceId>/ 下的有限文件信箱，不新增任何 TCP 监听。
//   - monitor 原子写 requests/<requestId>.json；supervisor 原子认领（rename）到
//     processing/，完成后写 results/<requestId>.json（tmp+rename）。
//   - 目录 0700、文件 0600；拒绝符号链接、非普通文件、超长内容与路径穿越；
//     请求内容只允许固定 schema 字段——命令字符串、任意 PID、文件路径不进协议。
//   - supervisor 必须自行校验实例、目标签名、controller 归属与 shouldBeRunning；
//     未知归属 / foreign 状态绝不通过该动作杀远端进程（A22）。
//   - 有界：每实例待处理请求 ≤ 16、结果 ≤ 100 份且 24h 过期，纳入存储预算。
//   - crash 语义（A20）：processing 残留超时 → 写 status:"unknown" 的结果，先核实
//     运行事实再决定动作；本协议不承诺跨崩溃 exactly-once。

import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
  readdir as fsReaddir,
  lstat as fsLstat,
} from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-file.mjs";
import { StatusError } from "./status-error.mjs";
import { BOUNDED_SERVER_ID_PATTERN } from "./validators.mjs";

export const CONTROL_SCHEMA_VERSION = 1;
export const CONTROL_ACTION_RESTART_TUNNEL = "restart-tunnel";
// 热更新（数据面交接）：
//   handoff-exit   supervisor 停循环、不杀子进程、不删隧道/代理登记，只删自己的记录后退出 0；
//                  serverId 固定 "supervisor"，targetSignature 为 "instance:<instanceId>"。
//   proxy-handoff  supervisor 平滑替换本地代理（新代理接管监听，旧代理排空已有连接）；
//                  serverId 固定 "local-proxy"，targetSignature 为 "proxy:<effectiveProxyPort>"。
// 信箱是跨平台主通道（win32 没有 SIGUSR2）；POSIX 上 SIGUSR2 只是 handoff-exit 的加速器。
export const CONTROL_ACTION_HANDOFF_EXIT = "handoff-exit";
export const CONTROL_ACTION_PROXY_HANDOFF = "proxy-handoff";
// v2.88 同账号多台 Mac 接力：「让这台承载」。serverId / targetSignature 与 restart-tunnel 相同；
// supervisor 只结束本账号另一台 Mac 在同一端口上的会话（按会话标记认），再在本机建隧道。
export const CONTROL_ACTION_TAKEOVER_TUNNEL = "takeover-tunnel";
export const HANDOFF_SUPERVISOR_SERVER_ID = "supervisor";
export const HANDOFF_PROXY_SERVER_ID = "local-proxy";
export function handoffExitSignature(instanceId) {
  return `instance:${String(instanceId)}`;
}
export function proxyHandoffSignature(port) {
  return `proxy:${Number(port)}`;
}
export const CONTROL_ACTIONS = Object.freeze([
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_ACTION_HANDOFF_EXIT,
  CONTROL_ACTION_PROXY_HANDOFF,
  CONTROL_ACTION_TAKEOVER_TUNNEL,
]);
// 待处理请求上限：满载拒绝并可见报错，不能无限建文件。
export const CONTROL_MAX_PENDING_REQUESTS = 16;
export const CONTROL_REQUEST_MAX_BYTES = 4096;
// 结果保留：最多 100 份、24 小时，monitor 崩溃恢复后仍可按 operationId 查证。
export const CONTROL_RESULT_MAX_COUNT = 100;
export const CONTROL_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// processing 残留超过该时长视为 supervisor 中途死亡 → 结果 unknown。
export const CONTROL_PROCESSING_STALE_MS = 120 * 1000;
// 请求有效期：monitor 写入后 supervisor 须在窗口内认领，过期拒绝执行。
export const CONTROL_REQUEST_TTL_MS = 60 * 1000;

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANCE_ID_RE = /^[0-9a-f]{4,64}$/;

// new ControlProtocolError(status, message)：路由按 err.status 回写响应码（见 status-error.mjs）。
export class ControlProtocolError extends StatusError {}

export function controlDir(runtimeDir, instanceId) {
  return path.join(runtimeDir, "control", String(instanceId));
}

// ---- 请求构造与校验（双方共用同一把尺子）----

export function buildControlRequest({
  requestId,
  operationId,
  instanceId,
  action = CONTROL_ACTION_RESTART_TUNNEL,
  serverId,
  targetSignature,
  expiresAt,
  createdAt,
} = {}) {
  if (!REQUEST_ID_RE.test(String(requestId || ""))) throw new ControlProtocolError(400, "requestId 必须是 UUID");
  if (!REQUEST_ID_RE.test(String(operationId || ""))) throw new ControlProtocolError(400, "operationId 必须是 UUID");
  if (!INSTANCE_ID_RE.test(String(instanceId || ""))) throw new ControlProtocolError(400, "instanceId 非法");
  if (!CONTROL_ACTIONS.includes(action)) throw new ControlProtocolError(400, `不支持的 action: ${String(action)}`);
  if (!BOUNDED_SERVER_ID_PATTERN.test(String(serverId || ""))) throw new ControlProtocolError(400, "serverId 非法");
  const signature = String(targetSignature || "");
  if (!signature || signature.length > 256 || /[\r\n\0]/.test(signature)) {
    throw new ControlProtocolError(400, "targetSignature 非法");
  }
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    requestId,
    operationId,
    instanceId,
    action,
    serverId,
    targetSignature: signature,
    createdAt: Number.isFinite(createdAt) ? Math.trunc(createdAt) : Date.now(),
    expiresAt: Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : Date.now() + CONTROL_REQUEST_TTL_MS,
  };
}

// 校验从磁盘读回的请求（supervisor 认领前调用）。多一字段都拒绝：协议封闭。
export function validateControlRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ControlProtocolError(400, "request 必须是对象");
  }
  const expected = buildControlRequest({
    requestId: raw.requestId,
    operationId: raw.operationId,
    instanceId: raw.instanceId,
    action: raw.action,
    serverId: raw.serverId,
    targetSignature: raw.targetSignature,
    expiresAt: raw.expiresAt,
    createdAt: raw.createdAt,
  });
  for (const key of Object.keys(raw)) {
    if (!(key in expected)) throw new ControlProtocolError(400, `意外的请求字段: ${key}`);
  }
  return expected;
}

// ---- 通用安全文件原语 ----

async function ensureDir(dir) {
  await fsMkdir(dir, { recursive: true, mode: 0o700 });
}

async function assertRegularFile(fullPath) {
  // 拒绝符号链接与设备文件：信箱目录里的每个条目都必须是我们自己写的普通文件。
  const info = await fsLstat(fullPath);
  if (!info.isFile()) throw new ControlProtocolError(400, "信箱条目不是普通文件");
}

async function atomicWriteJson(fullPath, value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > CONTROL_REQUEST_MAX_BYTES) {
    throw new ControlProtocolError(400, "信箱条目超限");
  }
  await writeFileAtomic(fullPath, json);
}

// ---- monitor 侧：写入一条控制请求 ----

export async function writeControlRequest({ runtimeDir, request } = {}) {
  const valid = validateControlRequest(request);
  const dir = controlDir(runtimeDir, valid.instanceId);
  const requestsDir = path.join(dir, "requests");
  await ensureDir(requestsDir);
  // 满载拒绝：不静默丢弃，也不无限堆积。
  const pending = await fsReaddir(requestsDir).catch(() => []);
  if (pending.filter((name) => name.endsWith(".json")).length >= CONTROL_MAX_PENDING_REQUESTS) {
    throw new ControlProtocolError(503, "控制信箱已满，请稍后再试");
  }
  await atomicWriteJson(path.join(requestsDir, `${valid.requestId}.json`), valid);
  return valid;
}

// ---- monitor 侧：读取结果（按 requestId / operationId）----

export async function readControlResult(runtimeDir, instanceId, requestId, { readFile = fsReadFile } = {}) {
  const fullPath = path.join(controlDir(runtimeDir, instanceId), "results", `${String(requestId)}.json`);
  let raw;
  try {
    raw = await readFile(fullPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// monitor 重启后内存操作表已空：扫描结果目录按 operationId 找回已验证的结果（A20）。
// 有界扫描（结果目录 ≤ 100 份），找不到返回 null。
export async function findControlResultByOperationId(runtimeDir, instanceId, operationId, { readdir = fsReaddir, readFile = fsReadFile } = {}) {
  const resultsDir = path.join(controlDir(runtimeDir, instanceId), "results");
  const names = await readdir(resultsDir).catch(() => []);
  for (const name of names.slice(0, CONTROL_RESULT_MAX_COUNT)) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(resultsDir, name), "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.operationId === operationId) return parsed;
    } catch {}
  }
  return null;
}

// ---- supervisor 侧：信箱处理器 ----

// handlers: { [action]: async ({ request }) => { status, phase, reason, evidence } }
// 停止意图 / 未知归属 / 签名不符等业务校验在 handler 内完成（supervisor 自有状态），
// 本工厂只负责文件协议与崩溃恢复。
export function createControlMailbox({
  runtimeDir,
  instanceId,
  handlers = {},
  log = () => {},
  now = Date.now,
  stopping = () => false,
  readFile = fsReadFile,
  rename = fsRename,
  unlink = fsUnlink,
  readdir = fsReaddir,
  lstat = fsLstat,
  processingStaleMs = CONTROL_PROCESSING_STALE_MS,
  resultMaxAgeMs = CONTROL_RESULT_MAX_AGE_MS,
} = {}) {
  if (!INSTANCE_ID_RE.test(String(instanceId || ""))) {
    throw new Error("createControlMailbox 需要 instanceId");
  }
  const dir = controlDir(runtimeDir, instanceId);
  const requestsDir = path.join(dir, "requests");
  const processingDir = path.join(dir, "processing");
  const resultsDir = path.join(dir, "results");
  let pollInFlight = false;
  let pollPromise = null;
  const settled = new Set(); // 本进程已写出结果的 requestId（防重复处理）

  async function ensureDirs() {
    for (const d of [requestsDir, processingDir, resultsDir]) await ensureDir(d);
  }

  async function safeUnlink(fullPath) {
    try {
      await unlink(fullPath);
    } catch {}
  }

  async function writeResult(result) {
    await atomicWriteJson(path.join(resultsDir, `${result.requestId}.json`), result);
  }

  // 结果文件的 12 个字段集中在一处构造；request 缺失（残留/非法条目）时身份字段留空。
  function makeResult(requestId, request, { status, phase, reason, evidence, startedAt }) {
    return {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      requestId,
      operationId: request?.operationId || "",
      instanceId,
      serverId: request?.serverId || "",
      action: request?.action || "",
      targetSignature: request?.targetSignature || "",
      status, // succeeded | failed | unknown
      phase,
      reason,
      evidence,
      startedAt,
      finishedAt: now(),
    };
  }

  // 认领：requests/<id>.json → processing/<id>.json（同文件系统 rename，原子）。
  async function claim(requestId) {
    const from = path.join(requestsDir, `${requestId}.json`);
    const to = path.join(processingDir, `${requestId}.json`);
    await assertRegularFile(from);
    await rename(from, to);
    return to;
  }

  async function processRequest(request) {
    const handler = handlers[request.action];
    const startedAt = now();
    let outcome;
    if (!handler) {
      outcome = { status: "failed", phase: "queued", reason: `unsupported action: ${request.action}`, evidence: {} };
    } else if (request.expiresAt <= now()) {
      outcome = { status: "failed", phase: "queued", reason: "request expired before claim", evidence: {} };
    } else {
      try {
        outcome = await handler({ request });
      } catch (err) {
        outcome = { status: "failed", phase: "executing", reason: String(err?.message || err).slice(0, 200), evidence: {} };
      }
    }
    const result = makeResult(request.requestId, request, {
      status: outcome.status,
      phase: outcome.phase || "executing",
      reason: String(outcome.reason || "").slice(0, 200),
      evidence: outcome.evidence && typeof outcome.evidence === "object" ? outcome.evidence : {},
      startedAt,
    });
    await writeResult(result);
    settled.add(request.requestId);
    await safeUnlink(path.join(processingDir, `${request.requestId}.json`));
    log(`control mailbox: request ${request.requestId} (${request.action} ${request.serverId}) -> ${result.status}${result.reason ? `: ${result.reason}` : ""}`, {
      event: "control-mailbox-result",
      requestId: request.requestId,
      operationId: request.operationId,
      serverId: request.serverId,
      status: result.status,
      level: result.status === "succeeded" ? "info" : "warn",
    });
  }

  // 主循环每拍调用（5s 边界）。内部互斥：上一次处理未完不重入，主循环不等待。
  // 在飞的那一轮同时挂在 pollPromise 上，供 whenIdle() 有界等待——交接退出必须在
  // "正在跑的受控重启"收尾之后才 exit(0)：那是"停旧 ssh → 起新 ssh"的复合动作，
  // 中途退出会留下"进程已停、注册表记录还在"的状态，也让结果文件永远写不出来。
  async function poll() {
    if (pollInFlight || stopping()) return;
    pollInFlight = true;
    pollPromise = (async () => {
      await ensureDirs();
      // 1) processing 残留恢复：超时 → unknown 结果（不盲目重放，A20）；已有结果则仅清理。
      let leftovers = [];
      try {
        leftovers = await readdir(processingDir);
      } catch {}
      for (const name of leftovers) {
        if (!name.endsWith(".json")) continue;
        const fullPath = path.join(processingDir, name);
        try {
          await assertRegularFile(fullPath);
        } catch {
          await safeUnlink(fullPath);
          continue;
        }
        const requestId = name.slice(0, -".json".length);
        if (settled.has(requestId)) {
          await safeUnlink(fullPath);
          continue;
        }
        let info = null;
        try {
          info = await lstat(fullPath);
        } catch {}
        const age = info ? now() - info.mtimeMs : 0;
        let request = null;
        try {
          request = validateControlRequest(JSON.parse(await readFile(fullPath, "utf8")));
        } catch {}
        if (request && (!settled.has(requestId)) && (await readControlResult(runtimeDir, instanceId, requestId, { readFile }))) {
          // 结果已写出、只是 processing 清理未完成：不重放，仅清理。
          settled.add(requestId);
          await safeUnlink(fullPath);
          continue;
        }
        if (info && age > processingStaleMs) {
          log(`control mailbox: processing leftover ${requestId} is stale (${Math.round(age / 1000)}s), marking unknown`, {
            level: "warn",
            event: "control-mailbox-stale",
            requestId,
          });
          await writeResult(makeResult(requestId, request, {
            status: "unknown",
            phase: "executing",
            reason: "supervisor restarted while processing; outcome unverified",
            evidence: {},
            startedAt: info.mtimeMs,
          }));
          settled.add(requestId);
          await safeUnlink(fullPath);
        }
      }
      // 2) 结果目录修剪（≤100 份且 24h）。
      let resultNames = [];
      try {
        resultNames = await readdir(resultsDir);
      } catch {}
      if (resultNames.length > 0) {
        const nowMs = now();
        const entries = [];
        for (const name of resultNames) {
          if (!name.endsWith(".json")) continue;
          let mtimeMs = 0;
          try {
            mtimeMs = (await lstat(path.join(resultsDir, name))).mtimeMs;
          } catch {}
          entries.push({ name, mtimeMs });
        }
        const expired = entries.filter((e) => e.mtimeMs && nowMs - e.mtimeMs > resultMaxAgeMs);
        for (const e of expired) await safeUnlink(path.join(resultsDir, e.name));
        const kept = entries.filter((e) => !expired.includes(e)).sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const e of kept.slice(0, Math.max(0, kept.length - CONTROL_RESULT_MAX_COUNT))) {
          await safeUnlink(path.join(resultsDir, e.name));
        }
      }
      // 3) 认领并处理新请求（每拍最多认领满 maxPending 的量，处理串行、有界）。
      let pending = [];
      try {
        pending = (await readdir(requestsDir)).filter((name) => name.endsWith(".json")).sort();
      } catch {}
      let claimed = 0;
      for (const name of pending) {
        if (claimed >= CONTROL_MAX_PENDING_REQUESTS) break;
        const requestId = name.slice(0, -".json".length);
        if (settled.has(requestId)) continue;
        const fullPath = path.join(requestsDir, name);
        let raw;
        try {
          await assertRegularFile(fullPath);
          raw = await readFile(fullPath, "utf8");
        } catch (err) {
          // 非普通文件 / 读失败：隔离到结果目录以免永久卡住（可见错误而非静默）。
          if (err instanceof ControlProtocolError) {
            await writeResult(makeResult(requestId, null, {
              status: "failed", phase: "queued", reason: err.message, evidence: {}, startedAt: now(),
            }));
            settled.add(requestId);
            await safeUnlink(fullPath);
          }
          continue;
        }
        if (Buffer.byteLength(raw, "utf8") > CONTROL_REQUEST_MAX_BYTES) {
          await safeUnlink(fullPath);
          continue;
        }
        let request;
        try {
          request = validateControlRequest(JSON.parse(raw));
        } catch (err) {
          await writeResult(makeResult(requestId, null, {
            status: "failed", phase: "queued", reason: `invalid request: ${String(err?.message || err).slice(0, 120)}`, evidence: {}, startedAt: now(),
          }));
          settled.add(requestId);
          await safeUnlink(fullPath);
          continue;
        }
        if (request.instanceId !== instanceId) {
          // 不是写给本实例的请求（陈旧信箱目录）：忽略并移除，绝不跨实例执行。
          await safeUnlink(fullPath);
          continue;
        }
        await claim(requestId);
        claimed += 1;
        await processRequest(request);
      }
    })();
    try {
      await pollPromise;
    } finally {
      pollInFlight = false;
      pollPromise = null;
    }
  }

  return { poll, whenIdle: () => pollPromise || Promise.resolve(), isPolling: () => pollInFlight };
}
