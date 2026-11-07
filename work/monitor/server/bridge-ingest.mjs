// bridge 快照摄取：supervisor 独立进程通过既有 NDJSON 日志发布 bridge-stage 快照，
// 这里按偏移增量读取新行（createNdjsonTailReader 每行只交付一次）并归并，避免新端口/IPC
// 与 SSE 协议变更。
// 三个纯函数维护 per-server 的"异己占用集合 / SSH 失败归因表"，工厂持有摄取状态与 2s 轮询。

import { stat } from "node:fs/promises";
import path from "node:path";

import { createNdjsonTailReader, parseNdjsonTail } from "../lib/logger.mjs";
import { NDJSON_TAIL_LINES } from "./runtime-env.mjs";

const SUPERVISOR_MESSAGE_TAIL_MAX = 500; // supervisor 消息尾巴（信号引擎输入）上限
export const BRIDGE_SNAPSHOT_POLL_MS = 2000; // bridge 快照轮询周期

// bridge 的 ssh-tunnel 快照 → "端口被异己占用"的服务器集合（/api/status.tunnelPortForeign）。
// Task 3 的孤儿接管会写两种快照：{ ok:false, foreign:true }（异己占用，一律不杀，需人工）
// 与 { ok:true, adopted:true }（已认领）。这里只做集合增删：foreign 进集合，任何
// ok:true 快照即视为该服务器的端口已回到我们手里，出集合。
// 注意 state-store.ingestBridgeStage 只按 stage 归并（同一 stage 后到的覆盖先到的），
// 分不出是哪台服务器——所以这份 per-server 集合必须在这里单独维护。
export function applyTunnelForeignSnapshot(set, snapshot) {
  if (!set || !snapshot || snapshot.stage !== "ssh-tunnel") return false;
  const serverId = typeof snapshot.serverId === "string" ? snapshot.serverId : "";
  if (!serverId) return false;
  if (snapshot.foreign === true) {
    set.add(serverId);
    return true;
  }
  if (snapshot.ok === true) return set.delete(serverId);
  return false;
}

// W5：ssh-tunnel 快照里的 sshFailure（supervisor 按 stderr 归因的 auth/hostkey/timeout/...）
// → per-server 失败归因表（/api/status.tunnelFailures）。与 foreign 同理必须按服务器单独维护：
// state-store 的 bridgeStages 只按 stage 归并，多隧道时分不出是哪台。
// ok 快照或 sshFailure:null 即清除；返回值表示表是否发生变化。
export function applyTunnelFailureSnapshot(map, snapshot) {
  if (!map || !snapshot || snapshot.stage !== "ssh-tunnel") return false;
  const serverId = typeof snapshot.serverId === "string" ? snapshot.serverId : "";
  if (!serverId) return false;
  const failure = snapshot.sshFailure;
  if (snapshot.ok === true || failure === null) return map.delete(serverId);
  // 新的失败快照整条替换：带了 sshFailure 字段但归因无效（未知原因）也清掉旧归因，
  // 不让上一次的 auth 之类粘在之后无法归类的断线上。完全不带该字段的快照（旧协议）不动。
  if (!("sshFailure" in snapshot)) return false;
  if (!failure || typeof failure.code !== "string" || !failure.code) return map.delete(serverId);
  map.set(serverId, {
    code: failure.code,
    nextAction: typeof failure.nextAction === "string" ? failure.nextAction : "",
    at: Number.isFinite(Number(failure.at)) ? Number(failure.at) : null,
  });
  return true;
}

// 删除/禁用的服务器不再出隧道快照，它们的失败归因永远不会被 ok 快照清掉——
// 按当前启用的服务器 id 修剪。返回是否有删除。
export function pruneTunnelFailures(map, enabledServerIds) {
  if (!map) return false;
  const keep = new Set(enabledServerIds || []);
  let changed = false;
  for (const id of [...map.keys()]) {
    if (!keep.has(id)) {
      map.delete(id);
      changed = true;
    }
  }
  return changed;
}

// 快照只进状态仓与下面两份 per-server 旁路表，不再镜像进指标环（metrics.json）：
// 那份 kind:"bridge-stage" 的样本没有任何读取方（/api/metrics 默认只出 resource，前端从不带 kind），
// 却随每分钟的心跳占了 metrics.json 约一半体积、每 5 分钟整份重写一次；而且 ssh-tunnel 快照自带
// serverId，展开时盖掉了 `bridge:` 前缀，样本落进真实服务器的环里挤占资源采样的名额。
// 已落盘的旧样本按指标环自己的 24 小时上限过期，不做迁移。
// onSnapshot：每条快照的旁路观察者（探针退避拿隧道快照当「可能已恢复」的信号）；它抛错不影响摄取。
// onMessage(message, ts)：每条带 message 的行的旁路观察者（v2.65 出网健康数本机代理的 connect-fail）；
// ts 是日志行自己的时刻——首拍会先读回文件尾巴里的旧行，观察者据此分辨新旧。同样抛错不影响摄取。
export function createBridgeIngest({ runtimeDir, store, onSnapshot = null, onMessage = null }) {
  // "反向端口被异己占用"的服务器集合（Task 3 孤儿接管上报，/api/status.tunnelPortForeign）。
  const foreignTunnelServers = new Set();
  const tunnelSshFailures = new Map();
  const supervisorMessageTail = [];
  const supervisorLogPath = path.join(runtimeDir, "logs", "supervisor.ndjson");
  const supervisorTailReader = createNdjsonTailReader(supervisorLogPath);
  let ingestInFlight = false;
  // 轮转降噪：2 秒轮询大多数拍里文件根本没变。先 stat 一次，size+mtimeMs 与上一拍相同就
  // 直接跳过 readNew/解析，避免无谓的文件打开与 NDJSON 解析。
  let lastSupervisorLogSig = null;
  let timer = null;

  function ingestEntry(entry) {
    if (entry.message && !(entry.bridgeStage && entry.message === "bridge stage snapshot")) {
      supervisorMessageTail.push(entry.message);
      if (supervisorMessageTail.length > SUPERVISOR_MESSAGE_TAIL_MAX) supervisorMessageTail.shift();
      if (onMessage) {
        try {
          onMessage(entry.message, entry.ts);
        } catch {}
      }
    }
    const snapshot = entry.bridgeStage;
    if (!snapshot || typeof snapshot.stage !== "string") return;
    store.ingestBridgeStage(snapshot);
    applyTunnelForeignSnapshot(foreignTunnelServers, snapshot);
    applyTunnelFailureSnapshot(tunnelSshFailures, snapshot);
    if (onSnapshot) {
      try {
        onSnapshot(snapshot);
      } catch {}
    }
  }

  async function ingest() {
    if (ingestInFlight) return;
    ingestInFlight = true;
    try {
      let sig = null;
      try {
        const info = await stat(supervisorLogPath);
        sig = `${info.size}:${info.mtimeMs}`;
      } catch {
        // 文件尚未创建（supervisor 未启动过）：清空签名，等待下一拍。
        lastSupervisorLogSig = null;
        return;
      }
      if (sig === lastSupervisorLogSig) return;
      lastSupervisorLogSig = sig;
      const raw = await supervisorTailReader.readNew();
      if (!raw) return;
      const { entries } = parseNdjsonTail(raw, { source: "supervisor", tailLines: NDJSON_TAIL_LINES, limit: 2000 });
      for (const entry of entries) ingestEntry(entry);
    } finally {
      ingestInFlight = false;
    }
  }

  // 2s 轮询 + 立即首拍。unref：摄取不该成为进程存活的理由（listen 的句柄才是）。
  function start() {
    timer = setInterval(() => ingest().catch(() => {}), BRIDGE_SNAPSHOT_POLL_MS);
    timer.unref();
    ingest().catch(() => {});
  }

  return {
    ingest,
    start,
    // local_http_connect_proxy 的 connect-deny 会被 supervisor 写为 NDJSON。只提取 message
    // 字段给信号引擎，既不把 JSON 包装/字段泄到前端，也能用其精确行规则避免泛化误报。
    readLocalProxyLog: async () => supervisorMessageTail.join("\n"),
    getTunnelPortForeign: () => [...foreignTunnelServers],
    // 先按当前启用的服务器修剪，再出 { serverId: { code, nextAction, at } }。
    getTunnelFailures: (enabledServerIds) => {
      pruneTunnelFailures(tunnelSshFailures, enabledServerIds);
      return Object.fromEntries(tunnelSshFailures);
    },
  };
}
