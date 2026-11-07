// 官方 CLI 探测服务：cli:<serverId> 低频探针（10 分钟一轮）→ 每台服务器一份内存快照。
//
// 采集范围与用量 / 作业同一口径（isUsageEligible：团队服务器、未禁用、未关监控）。探测只走 SSH，
// 不经隧道；结果只进本服务的快照，cli:<serverId> 探针结果与 usage / jobs 一样不被状态仓、
// 事件、指标消费，不参与判级。
//
// getSnapshot(serverId) 契约（从未成功探测过 → null）：
//   { serverId, checkedAt, startedAt, clis: { codex: CliState, claude: CliState } }
//   CliState = { installed, version, kind, path, login, loginDetail, npmGlobal, managedBy?, offPath? }（见 detect.mjs；
//   offPath 只在「装了但非交互 SSH 的 PATH 里找不到」时出现，此时 installed 为 false）
//   checkedAt = 这一轮结果到手的时刻（对外展示的「检查时间」）；startedAt = 这一轮 SSH 发出之前的时刻。
//   拿快照和别的事实比「谁新」（如安装后的覆盖层，install-service.mjs 的 mergeCliState）必须用 startedAt：
//   远端状态是在 startedAt 之后读的，一轮跨过安装完成时刻的探测，结束得再晚，内容也是安装之前的。
// 某一轮 SSH 失败时保留上一份快照（error 只体现在探针结果上），不把通道故障写成「未安装」。
//
// refresh(serverId)：安装 / 更新 / 登录完成后插队跑一轮（经 bindRefresh 绑定的 scheduler.forceRun）；
// 没绑定（测试 / 探针没注册）时直接跑一轮 runScan。

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isUsageEligible } from "../usage/service.mjs";
import { CLI_IDS } from "./catalog.mjs";
import { buildCliScanInvocation, CLI_SCAN_TIMEOUT_MS, parseCliScan } from "./detect.mjs";

export const CLI_SCAN_INTERVAL_MS = 10 * 60000;
export { CLI_SCAN_TIMEOUT_MS };
export const isCliEligible = isUsageEligible;

export function createCliService({ getConfig, dataDir, execCollector, probeSshFailureReason = (code) => `ssh exit ${code}`, now = Date.now, buildInvocation = buildCliScanInvocation }) {
  const snapshots = new Map();
  let forceRun = null;

  async function runScan(serverId) {
    const config = await getConfig();
    const server = (config.servers || []).find((s) => s.id === serverId);
    if (!isCliEligible(server)) {
      snapshots.delete(serverId);
      return { level: "skipped", reason: "该服务器不在 CLI 检测范围", data: null };
    }
    const invocation = buildInvocation({
      server,
      parsed: config,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
      ids: CLI_IDS,
    });
    const startedAt = now();
    let res;
    try {
      res = await execCollector(invocation, server);
    } catch (error) {
      res = { code: null, stdout: "", stderr: String(error?.message || error) };
    }
    const { stdout, stderr, code } = res || {};
    const scan = parseCliScan(stdout, CLI_IDS);
    if (!scan || !CLI_IDS.every((id) => scan.clis[id])) {
      // SSH 没到远端 / 输出被截断：保留上一份快照。
      return { level: "error", reason: `CLI 检测未完成（${probeSshFailureReason(code, stderr, stdout)}）`, data: null };
    }
    const snapshot = { serverId, checkedAt: now(), startedAt, clis: scan.clis };
    snapshots.set(serverId, snapshot);
    const summary = CLI_IDS.map((id) => {
      const s = scan.clis[id];
      return `${id} ${s.installed ? (s.version || "版本未知") : s.offPath ? `不在非交互 PATH（${s.offPath}）` : "未安装"}`;
    }).join("，");
    return { level: "ok", reason: summary, data: { clis: scan.clis } };
  }

  function getSnapshot(serverId) {
    const snap = snapshots.get(serverId);
    return snap ? structuredClone(snap) : null;
  }

  // 服务器被删 / 屏蔽时由注册方清理（registerLoadProbes 每轮传入存活集合）。
  function prune(liveServerIds) {
    const live = new Set(liveServerIds || []);
    for (const id of [...snapshots.keys()]) {
      if (!live.has(id)) snapshots.delete(id);
    }
  }

  function bindRefresh(fn) {
    forceRun = typeof fn === "function" ? fn : null;
  }

  // 安装 / 登录后插队：探针已注册走调度器（占 SSH 槽位、结果去重）；否则直接跑一轮。
  async function refresh(serverId) {
    if (forceRun) {
      try {
        await forceRun(serverId);
        return getSnapshot(serverId);
      } catch {
        // 探针还没注册（刚加的服务器）→ 落到直接扫描
      }
    }
    await runScan(serverId);
    return getSnapshot(serverId);
  }

  return { runScan, getSnapshot, prune, bindRefresh, refresh };
}
