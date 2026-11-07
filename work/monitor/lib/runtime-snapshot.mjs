// runtime-snapshot.mjs —— T01/T04b supervisor 运行快照（读写双方共用，无顶层副作用）。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §3.2）：
//   - supervisor 是唯一写者：启动、目标变更后、以及正常循环中以有界频率写
//     <dataRoot>/runtime/supervisor-state.json（同目录临时文件 + rename 原子替换）。
//   - 最大 64 KiB：超限报错而不是静默截断 JSON。
//   - monitor 读取时校验 schema、大小、新鲜度（stale 判定 max(3×循环间隔, 30s)，
//     即默认 30s）与进程归属（pid 存活 + 注册表记录匹配）；mtime 不能独自证明有效。
//   - 旧 supervisor 没有快照：调用方拿到 { snapshot: null, reason } 明确降级，
//     不把配置端口伪装成已核实的运行端口。

import { createHash } from "node:crypto";
import { stat as fsStat, readFile as fsReadFile, mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-file.mjs";
import { isPidAlive } from "./process-registry.mjs";

export const RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1;
export const RUNTIME_SNAPSHOT_FILENAME = "supervisor-state.json";
// supervisor 正常循环 5s；过期判定 max(3×5s, 30s) = 30s。
export const SNAPSHOT_STALE_AFTER_MS = 30_000;
export const SNAPSHOT_MAX_BYTES = 64 * 1024;
// 输入服务器数量显式上限（防御异常配置把快照写爆）。
export const SNAPSHOT_MAX_SERVERS = 64;

// 配置修订号：对"会改变隧道/代理拓扑"的字段做规范化哈希。supervisor 与 monitor
// 对同一份配置算出同一个 revision，用作快照 configRevision 与探针 contextKey 的
// 上下文绑定（配置变化 → revision 变化 → 旧结果不能冒充新上下文）。
export function computeConfigRevision(config) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const canonical = servers.map((s) => ({
    id: s?.id ?? null,
    host: s?.host ?? null,
    remotePort: s?.remotePort ?? null,
    localPort: s?.localPort ?? null,
    tunnel: s?.tunnel === undefined ? true : s?.tunnel !== false,
    disabled: s?.disabled === true,
  }));
  const activeServerId = typeof config?.activeServerId === "string" ? config.activeServerId : null;
  const activeAgentId = typeof config?.activeAgentId === "string" ? config.activeAgentId : null;
  const payload = JSON.stringify({ activeServerId, activeAgentId, servers: canonical });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// supervisor 侧：构造快照对象（纯数据）。targets 键为 serverId。
export function buildRuntimeSnapshot({
  instanceId,
  pid,
  startedAt,
  observedAt,
  configRevision,
  build = {},
  capabilities = {},
  effectiveProxyPort,
  targets = {},
  // 热更新：数据面组件指纹（supervisor 启动时冻结的自身指纹 + 从代理 /proxy-health
  // 读回的代理指纹）、当前代理 pid 与首拍完成时间（新 supervisor 接管完成的证据）。
  components,
  proxyPid,
  firstTickCompletedAt,
  // v2.88：本机身份（同账号多台 Mac 接力时显示「这台 / 另一台」）：{ label, ownerId }。
  machine,
} = {}) {
  const safeTargets = {};
  for (const [serverId, target] of Object.entries(targets || {})) {
    if (!serverId || typeof target !== "object") continue;
    if (Object.keys(safeTargets).length >= SNAPSHOT_MAX_SERVERS) break;
    safeTargets[serverId] = {
      host: String(target.host ?? ""),
      remotePort: Number.isInteger(target.remotePort) ? target.remotePort : null,
      localPort: Number.isInteger(target.localPort) ? target.localPort : null,
      signature: String(target.signature ?? ""),
      ...(typeof target.configApplied === "boolean" ? { configApplied: target.configApplied } : {}),
      ...(["verified", "unverified", "changed", "blocked"].includes(target.configIdentityState)
        ? { configIdentityState: target.configIdentityState } : {}),
      ...(sanitizeHandover(target.handover) ? { handover: sanitizeHandover(target.handover) } : {}),
    };
  }
  const safeMachine = sanitizeMachine(machine);
  return {
    schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    instanceId: String(instanceId ?? "").slice(0, 64),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    startedAt: Number.isFinite(startedAt) ? Math.trunc(startedAt) : null,
    observedAt: Number.isFinite(observedAt) ? Math.trunc(observedAt) : null,
    configRevision: String(configRevision ?? "").slice(0, 64),
    build: {
      version: String(build.version ?? "").slice(0, 64),
      gitCommit: String(build.gitCommit ?? "").slice(0, 64),
    },
    capabilities: {
      scopedTunnelRestart: capabilities.scopedTunnelRestart === true,
      controlProtocol: Number.isInteger(capabilities.controlProtocol) ? capabilities.controlProtocol : 0,
      ...(capabilities.handoffExit === true ? { handoffExit: true } : {}),
      ...(capabilities.proxyHandoff === true ? { proxyHandoff: true } : {}),
      ...(capabilities.siblingTakeover === true ? { siblingTakeover: true } : {}),
    },
    ...(safeMachine ? { machine: safeMachine } : {}),
    effectiveProxyPort: Number.isInteger(effectiveProxyPort) && effectiveProxyPort >= 1 && effectiveProxyPort <= 65535
      ? effectiveProxyPort
      : null,
    targets: safeTargets,
    ...(components && typeof components === "object"
      ? { components: { supervisor: sanitizeComponentHash(components.supervisor), proxy: sanitizeComponentHash(components.proxy) } }
      : {}),
    ...(Number.isInteger(proxyPid) && proxyPid > 0 ? { proxyPid } : {}),
    ...(Number.isFinite(firstTickCompletedAt) ? { firstTickCompletedAt: Math.trunc(firstTickCompletedAt) } : {}),
  };
}

// 同账号多台 Mac 接力（v2.88，见 supervisor/sibling-handover.mjs）：本机待命时的事实。
// { role: "standby", since, reason, health, holder: { label, ownerId, heldSec } }；不是待命返回 null。
const HANDOVER_REASONS = new Set(["holder-active", "holder-unresponsive", "yielded"]);
const HANDOVER_HEALTH = new Set(["ok", "dead", "unknown"]);
const LABEL_RE = /^[A-Za-z0-9._-]{1,40}$/;
const OWNER_RE = /^[0-9a-f]{8,32}$/;

export function sanitizeHandover(value) {
  if (!isPlainObject(value) || value.role !== "standby") return null;
  const holder = isPlainObject(value.holder) ? value.holder : null;
  return {
    role: "standby",
    since: Number.isFinite(value.since) ? Math.trunc(value.since) : null,
    reason: HANDOVER_REASONS.has(value.reason) ? value.reason : null,
    health: HANDOVER_HEALTH.has(value.health) ? value.health : null,
    holder: holder
      ? {
        label: typeof holder.label === "string" && LABEL_RE.test(holder.label) ? holder.label : null,
        ownerId: typeof holder.ownerId === "string" && OWNER_RE.test(holder.ownerId) ? holder.ownerId : null,
        heldSec: Number.isFinite(holder.heldSec) && holder.heldSec >= 0 ? Math.trunc(holder.heldSec) : null,
      }
      : null,
  };
}

function sanitizeMachine(value) {
  if (!isPlainObject(value)) return null;
  const label = typeof value.label === "string" && LABEL_RE.test(value.label) ? value.label : null;
  const ownerId = typeof value.ownerId === "string" && OWNER_RE.test(value.ownerId) ? value.ownerId : null;
  return label || ownerId ? { label, ownerId } : null;
}

// 组件指纹只允许短十六进制串；其它一律按"未知"（空串）处理，未知在比较时视为需要交接。
export function sanitizeComponentHash(value) {
  return typeof value === "string" && /^[0-9a-f]{1,64}$/.test(value) ? value : "";
}

function serializeSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, "utf8") > SNAPSHOT_MAX_BYTES) {
    // 超限报错而不是静默截断：截断的 JSON 比没有快照更危险（半份 targets 冒充事实）。
    throw new Error(`runtime snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes`);
  }
  return json;
}

// supervisor 侧：原子写（同目录 tmp + rename）。写失败向上抛，由调用方限频告警，
// 绝不影响隧道保活主循环。
export async function writeRuntimeSnapshotFile(filePath, snapshot) {
  const json = serializeSnapshot(snapshot);
  await fsMkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, json);
  return json.length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSnapshotShape(snapshot) {
  if (!isPlainObject(snapshot)) return false;
  if (snapshot.schemaVersion !== RUNTIME_SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof snapshot.instanceId !== "string" || snapshot.instanceId === "") return false;
  if (!Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (!isPlainObject(snapshot.targets)) return false;
  if (!isPlainObject(snapshot.capabilities)) return false;
  return true;
}

// monitor 侧：读取 + 大小/schema 校验 + 新鲜度判定。文件不存在 / 超限 / JSON 损坏 /
// 形状不符都返回 { snapshot: null, reason } 明确降级，绝不抛出。
export async function readRuntimeSnapshotFile(filePath, {
  nowMs = Date.now(),
  staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
  stat = fsStat,
  readFile = fsReadFile,
} = {}) {
  let info = null;
  try {
    info = await stat(filePath);
  } catch {
    return { snapshot: null, reason: "no-snapshot" };
  }
  if (!info.isFile()) return { snapshot: null, reason: "not-a-file" };
  if (info.size > SNAPSHOT_MAX_BYTES) return { snapshot: null, reason: "oversized" };
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { snapshot: null, reason: "unreadable" };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    return { snapshot: null, reason: "invalid-json" };
  }
  if (!validSnapshotShape(snapshot)) return { snapshot: null, reason: "invalid-schema" };
  const observedAt = Number.isFinite(snapshot.observedAt) ? snapshot.observedAt : null;
  const stale = observedAt == null || nowMs - observedAt > staleAfterMs;
  return { snapshot, reason: stale ? "stale" : "ok", stale };
}

// monitor 侧：进程归属核实。快照里的 pid 必须仍存活，且进程注册表里
// channel-supervisor 记录的 pid 与之一致（防 pid 复用）。任一不成立 → 归属失败。
export function verifySnapshotOwnership(snapshot, {
  registry,
  pidAlive = isPidAlive,
} = {}) {
  if (!snapshot || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  if (!pidAlive(snapshot.pid)) return false;
  if (!registry || typeof registry.readMeta !== "function") return false;
  const meta = registry.readMeta("channel-supervisor");
  if (!meta || Number(meta.pid) !== snapshot.pid) return false;
  return true;
}

// monitor 侧：把（已验证归属的）快照 + 合并配置投影成 /api/status.connectionTargets。
// 旧 supervisor / 快照无效 → config-only 降级：远端端口标 configured，运行事实缺位。
export function buildConnectionTargetsProjection({
  snapshot,
  snapshotState = "missing",
  config,
} = {}) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  const projection = {
    schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    source: snapshot ? "supervisor-snapshot" : "config-only",
    freshness: snapshot ? (snapshotState === "stale" ? "stale" : "fresh") : "unknown",
    checkedAt: snapshot && Number.isFinite(snapshot.observedAt) ? snapshot.observedAt : null,
    configRevision: snapshot ? snapshot.configRevision : computeConfigRevision(config),
    effectiveProxyPort: snapshot && Number.isInteger(snapshot.effectiveProxyPort)
      ? { value: snapshot.effectiveProxyPort, source: "runtime" }
      : { value: null, source: "unknown" },
    capabilities: snapshot ? { ...snapshot.capabilities } : { scopedTunnelRestart: false, controlProtocol: 0 },
    supervisor: snapshot
      ? { instanceId: snapshot.instanceId, pid: snapshot.pid, startedAt: snapshot.startedAt, observedAt: snapshot.observedAt, stale: snapshotState === "stale" }
      : null,
    ...(snapshot && sanitizeMachine(snapshot.machine) ? { machine: sanitizeMachine(snapshot.machine) } : {}),
    servers: {},
  };
  for (const server of servers) {
    if (!server || typeof server.id !== "string" || !server.id) continue;
    if (Object.keys(projection.servers).length >= SNAPSHOT_MAX_SERVERS) break;
    const target = snapshot && isPlainObject(snapshot.targets) ? snapshot.targets[server.id] : null;
    projection.servers[server.id] = {
      host: typeof server.host === "string" ? server.host : "",
      tunnelEnabled: server.tunnel !== false && server.disabled !== true,
      remotePort: {
        configured: Number.isInteger(server.remotePort) ? server.remotePort : null,
        // 运行目标只来自快照；配置端口永远单列，不冒充 effective。
        effective: target && target.configApplied !== false && Number.isInteger(target.remotePort) ? target.remotePort : null,
      },
      localPort: {
        configured: Number.isInteger(server.localPort) ? server.localPort : null,
      },
      signature: target && typeof target.signature === "string" ? target.signature : "",
      ...(typeof target?.configApplied === "boolean" ? { configApplied: target.configApplied } : {}),
      ...(target?.configIdentityState ? { configIdentityState: target.configIdentityState } : {}),
      // 过期快照里的待命状态不可信（supervisor 可能早已不在），不投影。
      ...(snapshotState !== "stale" && sanitizeHandover(target?.handover) ? { handover: sanitizeHandover(target.handover) } : {}),
    };
  }
  // 快照里有、配置里已删掉的目标不进投影（以当前配置为准；历史目标随 reconcile 消失）。
  return projection;
}
