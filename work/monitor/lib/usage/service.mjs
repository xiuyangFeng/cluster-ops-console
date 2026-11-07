// Agent 用量服务：选定采集哪些服务器、跑一轮增量扫描、给 HTTP 路由出视图。
//
// 采集范围：团队配置里的服务器（config.json，source !== "personal"），且未禁用 / 未关监控。
// 个人服务器（config.local.json）默认不采集——用量页只统计主集群一类的共享机器。
// 扫描只走 SSH 读日志（不经隧道 / 代理），失败只记在用量存储里，不影响任何通道或资源判级。

import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { buildSessionDetail, buildUsageSummary, listSessionsForJobs } from "./model.mjs";
import { buildUsageScanInvocation, parseUsageScanOutput } from "./scan.mjs";
import { dayKeyOf, USAGE_RETENTION_DAYS } from "./store.mjs";

// 稳态 60s 一轮；首轮回填（远端还没扫完）时 5s 后接着扫，几轮内追平。
export const USAGE_SCAN_INTERVAL_MS = 60000;
export const USAGE_BACKFILL_INTERVAL_MS = 5000;
const SNAPSHOT_DAYS = 62; // 日历回看 62 天，摘要只需要这么多

export function isUsageEligible(server) {
  return Boolean(server) && server.disabled !== true && server.monitorEnabled !== false && server.source !== "personal";
}

export function usageServers(config) {
  return (config?.servers || []).filter(isUsageEligible);
}

export function createUsageService({ store, getConfig, dataDir, execCollector, probeSshFailureReason, jobRegistry = null, now = Date.now, retentionDays = USAGE_RETENTION_DAYS }) {
  // 摘要请求会被前端每 15s 轮询；快照按「最近一次落盘」缓存，没有新扫描就不重复复制。
  let snapshotCache = null;
  let revision = 0;

  async function runScan(serverId) {
    const config = await getConfig();
    if (!isDataModuleEnabled(config, "usage")) return { level: "skipped", reason: "用量模块已关闭", data: null };
    const server = (config.servers || []).find((s) => s.id === serverId);
    if (!isUsageEligible(server)) return { level: "skipped", reason: "该服务器不在用量统计范围", data: null };
    const cursors = await store.getCursors(serverId);
    const invocation = buildUsageScanInvocation({
      server,
      parsed: config,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
      cursors,
      sinceSec: now() / 1000 - retentionDays * 86400,
    });
    const { stdout, stderr, code, truncated } = await execCollector(invocation, server);
    const parsed = parseUsageScanOutput(stdout);
    if (!parsed.end) {
      // 没有收尾记录 = 远端没跑完（python3 缺失 / SSH 失败 / 被超时打断 / 输出超出本机接收上限）。
      // 已收到的完整记录照样入库——游标只随文件一起回传，没回传游标的文件下一轮会从旧偏移重读，结果按 ID 去重不变。
      const missingPython = /python3: (command )?not found|No such file or directory/.test(stderr || "");
      const reason = missingPython ? "服务器上没有 python3，无法扫描用量"
        : truncated ? "用量扫描输出超出本机接收上限（已收到的记录照常入库）"
          : `用量扫描失败 (${probeSshFailureReason(code, stderr, stdout)})`;
      if (parsed.calls.length || Object.keys(parsed.cursors).length) {
        await store.ingest(serverId, parsed);
        revision += 1;
      }
      await store.recordError(serverId, reason);
      return { level: "error", reason, data: { complete: false } };
    }
    const { added, updated } = await store.ingest(serverId, parsed);
    if (added || updated || Object.keys(parsed.cursors).length) revision += 1;
    const data = { complete: parsed.end.complete, added, updated, files: parsed.end.files, pending: parsed.end.pending, sec: parsed.end.sec, badLines: parsed.badLines };
    return { level: "ok", reason: parsed.end.complete ? `用量已同步（新增 ${added} 次调用）` : `用量回填中（本轮新增 ${added} 次调用）`, data };
  }

  async function context() {
    const config = await getConfig();
    const servers = usageServers(config);
    const ids = servers.map((s) => s.id);
    // 先取扫描状态：它会等各服务器的首次加载完成、并做跨日保留期清理，之后读到的数据版本才可信
    // （冷启动时摘要请求与启动扫描并发，不能把加载中途的空数据缓存下来）。
    const scans = await Promise.all(ids.map((id) => store.getScanStatus(id)));
    // 缓存键：本服务的扫描版本 + 存储的数据版本（加载完成 / 入库 / 保留期清理都会推进）+ 服务器集合。
    // 版本在读快照之前取：读快照期间数据又变了，下次请求自然重建。
    const key = `${revision}|${store.revision?.() ?? 0}|${ids.join(",")}`;
    if (!snapshotCache || snapshotCache.key !== key) {
      const sinceDay = dayKeyOf(now() / 1000 - SNAPSHOT_DAYS * 86400);
      snapshotCache = { key, sinceDay, snapshot: await store.snapshot(ids, { sinceDay }), coverageStart: await store.coverageStart(ids) };
    }
    const homes = Object.fromEntries(ids.map((id, i) => [id, scans[i].home || null]));
    const sources = servers.map((server, i) => ({ id: server.id, name: server.name || server.id, ...scans[i] }));
    return { snapshot: snapshotCache.snapshot, snapshotStart: snapshotCache.sinceDay, coverageStart: snapshotCache.coverageStart, homes, sources };
  }

  async function summary(params = {}) {
    const ctx = await context();
    const view = buildUsageSummary(ctx.snapshot, { ...params, nowSec: now() / 1000, homes: ctx.homes, coverageStart: ctx.coverageStart, snapshotStart: ctx.snapshotStart, sources: ctx.sources });
    return { ...view, sources: ctx.sources };
  }

  async function sessionDetail(key) {
    const ctx = await context();
    const serverId = typeof key === "string" ? key.split("|")[0] : "";
    if (jobRegistry?.load) await jobRegistry.load();
    const regEntries = jobRegistry?.list && serverId ? jobRegistry.list(serverId) : null;
    return buildSessionDetail(ctx.snapshot, key, { nowSec: now() / 1000, homes: ctx.homes, regEntries });
  }

  function listServerSessions(serverId) {
    return snapshotCache?.snapshot ? listSessionsForJobs(snapshotCache.snapshot, serverId) : [];
  }

  return { runScan, summary, sessionDetail, listServerSessions };
}

