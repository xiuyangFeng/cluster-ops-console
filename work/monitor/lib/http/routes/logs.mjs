// 日志检索：/api/logs（内存 ring 优先、必要时回读磁盘轮转历史）与 /api/logs/summary。
import {
  getRingOldestTs,
  LOG_QUERY_DEFAULT_LIMIT,
  LOG_QUERY_MAX_LIMIT,
  parseNdjsonTail,
  queryLogs,
  readLogHistoryFiles,
  summarizeLogs,
} from "../../logger.mjs";
import { numberParam, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 只有形如 "ops" / "supervisor" / "local-proxy" 的 source 才回读磁盘（它直接拼进文件名）。
const DISK_SOURCE_RE = /^[a-z-]+$/;

export function createLogRoutes({ logsDir, ndjsonTailLines }) {
  return routeTable({
    "GET /api/logs": async ({ res, url }) => {
      const params = url.searchParams;
      const filter = {
        source: params.get("source") || undefined,
        level: params.get("level") || undefined,
        since: numberParam(params, "since"),
        until: numberParam(params, "until"),
        q: params.get("q") || undefined,
        operationId: params.get("operationId") || undefined,
        limit: numberParam(params, "limit"),
        hideRoutineSnapshots: true,
      };
      const { source, since, limit, operationId } = filter;
      const result = queryLogs(filter);
      // 深回溯：内存 ring 无结果（如 supervisor 由独立进程写盘），或请求的 since 早于 ring
      // 覆盖范围时，回读磁盘轮转历史（.3→.2→.1→当前）兜底。两处修正：
      //  - 旧条件用"过滤后最旧条目.ts > since"判断覆盖范围，但 matchEntry 本身保证过滤结果
      //    的 ts >= since，该条件几乎恒真（since=0 时更是绝对恒真）——正常轮询每次都同步
      //    读盘 4 个文件（各至多 2MB）阻塞事件循环。改用 ring 的未过滤最旧时间戳判断真实
      //    覆盖范围（getRingOldestTs）。
      //  - ring 已返回满 limit 条时磁盘只会补更旧的条目，最终仍被 limit 裁掉，读盘纯浪费，
      //    直接跳过。读盘本身也已改为异步 + 缓存（见 lib/logger.mjs readLogHistoryFiles）。
      const cappedLimit = Number.isFinite(limit)
        ? Math.min(Math.max(1, limit), LOG_QUERY_MAX_LIMIT)
        : LOG_QUERY_DEFAULT_LIMIT;
      const ringFilled = result.entries.length >= cappedLimit;
      const ringOldest = getRingOldestTs(source);
      const needDisk = source && DISK_SOURCE_RE.test(source) && !ringFilled &&
        (result.entries.length === 0 || (since != null && ringOldest != null && since < ringOldest));
      // 按操作回看（事件「查看处置日志」/ runbook「查看本次操作日志」）不限来源：ring 无命中
      // （monitor 重启后 ring 清空，而事件与其关联的 operationId 是持久化的）时回读 ops 磁盘历史。
      const diskSource = needDisk ? source : !source && operationId && result.entries.length === 0 ? "ops" : "";
      if (diskSource) {
        const raw = await readLogHistoryFiles(logsDir, diskSource);
        if (raw) return sendJson(res, parseNdjsonTail(raw, { ...filter, tailLines: ndjsonTailLines }));
      }
      sendJson(res, result);
    },
    "GET /api/logs/summary": ({ res }) => sendJson(res, summarizeLogs()),
  });
}
