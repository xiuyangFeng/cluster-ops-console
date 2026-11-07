// 探针退避的装配（状态机在 lib/probe-backoff.mjs，闸门在 lib/probe-scheduler.mjs）：
// 把「这台主机连不连得上」的证据和「可能已经恢复」的信号接到状态机上，并给界面出只读视图。
//
// 证据（唯一来源）：SSH 执行层每次真实执行的结果（lib/ssh-runtime.mjs 的 onSshResult）。
// 信号（只会让下一次探测提前，绝不推后）：
//   - 本机连续两次进程采样（5 秒一拍）看到同一条隧道 ssh —— 隧道稳住了，立刻探一次；
//   - 守护进程上报隧道已建立 —— 退避阶梯从头开始并立刻探；之后每分钟的隧道心跳再各探一次；
//   - 配置变更 —— 全部从头再探；
//   - 休眠唤醒 / 本机网络地址变化 —— 状态机自己在调度器的节拍里发现（beat）。
// 开关：环境变量 CODEX_MONITOR_PROBE_BACKOFF 或配置 autoRepair（v2.64 起默认开；总开关关着或
// rules["probe-backoff"] 显式 false 时关）；关着时状态机不记任何状态，调度与 v2.60 逐字一致。

import { listEnabledServers, selectMainServer } from "../lib/config-loader.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { classifySshTransport, createProbeBackoff, isProbeBackoffEnabled } from "../lib/probe-backoff.mjs";
import { PROCESSES_PROBE_ID } from "../lib/probe-ids.mjs";
import { createNetworkWatcher } from "../lib/supervisor/network-watch.mjs";

const RESET_REASON_TEXT = { wake: "休眠唤醒", network: "本机网络地址变化", config: "配置变更" };

function clock(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function createProbeBackoffRuntime({
  env = process.env,
  getMergedConfig,
  appendLog = () => {},
  now = Date.now,
  rng = Math.random,
  networkWatcher = createNetworkWatcher(),
} = {}) {
  const readConfig = () => {
    try {
      return getMergedConfig() || null;
    } catch {
      return null;
    }
  };
  const servers = () => listEnabledServers(readConfig() || {});
  const hostOf = (serverId) => servers().find((server) => server?.id === serverId)?.host || null;

  const backoff = createProbeBackoff({
    now,
    rng,
    enabled: isProbeBackoffEnabled({ env, config: readConfig() }),
    networkChanged: () => networkWatcher.check(),
    onEvent: (event) => {
      if (event.type === "enter") {
        appendLog(
          `probe-backoff: ${event.hostKey} SSH 连不上已 ${Math.round(event.sinceMs / 1000)} 秒，周期探测改为退避（下次 ${clock(event.nextProbeAt)}）`,
          { level: "warn", event: "probe-backoff", phase: "enter", host: event.hostKey, failures: event.failures },
        );
      } else if (event.type === "recover") {
        appendLog(
          `probe-backoff: ${event.hostKey} 恢复可达（不可达约 ${Math.round(event.downMs / 1000)} 秒，期间 SSH 失败 ${event.failures} 次），探测回到正常节奏`,
          { event: "probe-backoff", phase: "recover", host: event.hostKey, downMs: event.downMs, failures: event.failures },
        );
      } else if (event.type === "reset") {
        appendLog(
          `probe-backoff: ${RESET_REASON_TEXT[event.reason] || event.reason}，${event.hosts} 台退避中的服务器立即重新探测`,
          { event: "probe-backoff", phase: "reset", reason: event.reason, hosts: event.hosts },
        );
      }
    },
  });

  // SSH 执行层的回调：server 是执行时那一刻配置里的条目。
  function onSshResult({ server, result } = {}) {
    const host = typeof server?.host === "string" ? server.host : "";
    if (host) backoff.observe(host, classifySshTransport(result));
  }

  // 守护进程的隧道快照（server/bridge-ingest.mjs 逐条转交）。老快照没有 serverId 时按查看中的那台算。
  const tunnelOk = new Map(); // serverId -> 上一份快照是否 ok
  function onBridgeSnapshot(snapshot) {
    if (snapshot?.stage !== "ssh-tunnel") return;
    const serverId = typeof snapshot.serverId === "string" && snapshot.serverId
      ? snapshot.serverId
      : selectMainServer(readConfig() || {})?.id;
    if (!serverId) return;
    const ok = snapshot.ok === true;
    const wasOk = tunnelOk.get(serverId) === true;
    tunnelOk.set(serverId, ok);
    if (!ok) return;
    const host = hostOf(serverId);
    if (!host) return;
    if (wasOk) backoff.nudge(host);
    else backoff.reset(host);
  }

  // 本机进程采样：同一条隧道 ssh（同 pid）连续两拍都在，每个 pid 只提示一次。
  const lastTunnelPids = new Map(); // serverId -> Set<pid>
  const announcedPid = new Map(); // serverId -> 已提示过的 pid
  function onProcesses(processes) {
    if (!processes || typeof processes !== "object") return;
    const byServer = processes.tunnelsByServer && typeof processes.tunnelsByServer === "object"
      ? Object.entries(processes.tunnelsByServer)
      : [[selectMainServer(readConfig() || {})?.id, processes.reverseTunnel]];
    for (const [serverId, list] of byServer) {
      if (!serverId) continue;
      const pids = new Set((Array.isArray(list) ? list : []).map((proc) => String(proc?.pid ?? "")).filter(Boolean));
      const previous = lastTunnelPids.get(serverId);
      lastTunnelPids.set(serverId, pids);
      if (pids.size === 0) announcedPid.delete(serverId);
      if (!previous) continue;
      const stable = [...pids].find((pid) => previous.has(pid));
      if (!stable || announcedPid.get(serverId) === stable) continue;
      announcedPid.set(serverId, stable);
      const host = hostOf(serverId);
      if (host) backoff.nudge(host);
    }
  }

  const onProbeUpdated = ({ id, result } = {}) => {
    if (id !== PROCESSES_PROBE_ID) return;
    try {
      onProcesses(result?.data?.processes);
    } catch {}
  };

  // 配置热载之后：开关改完即生效；已不在配置里的主机清掉；其余从头再探。
  function onConfigRefreshed(config) {
    const next = isProbeBackoffEnabled({ env, config: config || readConfig() });
    if (next !== backoff.isEnabled()) {
      backoff.setEnabled(next);
      appendLog(`probe-backoff: 探针退避已${next ? "开启" : "关闭"}`, { event: "probe-backoff", phase: next ? "enabled" : "disabled" });
    }
    const live = listEnabledServers(config || readConfig() || {});
    backoff.retain(live.map((server) => server?.host).filter(Boolean));
    const liveIds = new Set(live.map((server) => server?.id));
    for (const map of [tunnelOk, lastTunnelPids, announcedPid]) {
      for (const serverId of [...map.keys()]) if (!liveIds.has(serverId)) map.delete(serverId);
    }
    backoff.resetAll("config");
  }

  // /api/status.probeBackoff：{ enabled, servers: { serverId: { since, nextProbeAt, failures, probing } } }。
  // 只列退避中的服务器（宽限期内不算）；同一地址的多台服务器各列一条。
  function getView() {
    const view = { enabled: backoff.isEnabled(), servers: {} };
    if (!view.enabled) return view;
    const byHost = backoff.getView();
    if (Object.keys(byHost).length === 0) return view;
    for (const server of servers()) {
      const entry = server?.host ? byHost[server.host] : null;
      if (entry && server.id) view.servers[server.id] = entry;
    }
    return view;
  }

  return {
    backoff,
    onSshResult,
    onBridgeSnapshot,
    onProcesses,
    onConfigRefreshed,
    getView,
    // 总线监听单独挂（挂载时机由 start.mjs 决定）；返回注销函数（供测试）。
    attachBus() {
      bus.on(EVENTS.PROBE_UPDATED, onProbeUpdated);
      return () => bus.off(EVENTS.PROBE_UPDATED, onProbeUpdated);
    },
  };
}
