// 指标读接口：/api/metrics（资源采样，近 24 小时）、/api/metrics/range（7 天 / 30 天降采样）
// 与 /api/probes/history（单探针延迟/成功率）。
import { createMetricsRange, METRIC_RANGES } from "../../metrics-range.mjs";
import { computeProbeStats } from "../../metrics-store.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { numberParam, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const PROBE_HISTORY_DEFAULT_WINDOW_MS = 86400e3; // /api/probes/history 默认回看 24h
const PROBE_ID_RE = /^[a-z-]+$/;

export function createMetricsRoutes({ metricsStore, historyStore = null }) {
  // 长范围读的是按天历史文件；没有历史存储（装配缺失）时该接口 503，其余接口不受影响。
  const metricsRange = historyStore ? createMetricsRange({ historyStore }) : null;
  return routeTable({
    "GET /api/metrics": ({ res, url }) => {
      const params = url.searchParams;
      // 不默认回落到 activeServerId：无 serverId 时返回全部服务器样本合并（metrics-store.query 的 merge-all 分支）。
      sendJson(res, metricsStore.query({
        serverId: params.get("serverId") || undefined,
        kind: params.get("kind") || undefined,
        since: numberParam(params, "since"),
      }));
    },
    // 资源趋势的 7 天 / 30 天：服务端读历史日文件降采样（7 天按小时、30 天按 3 小时取均值）。
    // 参数先校验再读盘；serverId 只用作内存里的查找键，不参与拼路径。
    "GET /api/metrics/range": async ({ res, url }) => {
      const serverId = url.searchParams.get("serverId") || "";
      const range = url.searchParams.get("range") || "";
      if (!isBoundedServerId(serverId)) return sendJson(res, { error: "invalid serverId" }, 400);
      if (!Object.hasOwn(METRIC_RANGES, range)) return sendJson(res, { error: "invalid range" }, 400);
      if (!metricsRange) return sendJson(res, { error: "history unavailable" }, 503);
      sendJson(res, await metricsRange.query({ serverId, range }));
    },
    "GET /api/probes/history": ({ res, url }) => {
      const id = url.searchParams.get("id") || "";
      if (!PROBE_ID_RE.test(id)) {
        return sendJson(res, { error: "invalid probe id" }, 400);
      }
      const since = numberParam(url.searchParams, "since", Date.now() - PROBE_HISTORY_DEFAULT_WINDOW_MS);
      const { samples } = metricsStore.query({ serverId: `probe:${id}`, kind: "probe", since });
      sendJson(res, { samples, stats: computeProbeStats(samples) });
    },
  });
}
