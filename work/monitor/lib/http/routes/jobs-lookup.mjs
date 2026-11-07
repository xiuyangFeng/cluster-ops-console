// 「我的历史」按需回查（v2.51，lib/jobs/lookup.mjs）。只读，鉴权与其它 /api/* 读接口相同。
//
//   GET /api/jobs/lookup?serverId=<id>&job=<作业号>
//   GET /api/jobs/lookup?serverId=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD[&endBefore=<epoch 毫秒>]
//     → 与 GET /api/jobs 同形的响应体（rows / summary / truncated / snapshotId…），windowHours 为 null，另带
//       query、coverage { kind, from, to, endBefore, keptFrom, rowsTotal, tzKnown }、source（"ssh" | "local"）、
//       fetchedAt、cached。作业号 48213 或 48213_7；日期范围最多 7 天。缓存未命中时一次 SSH（经全局调度）。
//     → 429 { error }：这台服务器已有查询在途；400：参数不合法（作业号格式、日期、范围上限）。
//   GET /api/jobs/group?serverId=<id>&snapshot=<snapshotId>&key=<组 key>&limit=<1..1000>
//     → { snapshotId, key, total, children, more }：组内前 limit 条（只读本机快照，0 SSH）。
//     → 409 { error: "snapshot expired" }：快照已换代（新一轮采集）/ 回查结果过期，前端换新快照后重取。
//
// 回查结果不触发提醒、取证与简报统计（见 lib/jobs/lookup.mjs）。模块关闭时与 /api/jobs 一样回 { disabled: true }。
import { HISTORY_GROUP_PAGE_MAX } from "../../jobs/model.mjs";
import { LOOKUP_GROUP_KEY_MAX, LOOKUP_SNAPSHOT_RE, parseLookupQuery } from "../../jobs/lookup.mjs";
import { isDataModuleEnabled } from "../../modules/catalog.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const hasControlChar = (text) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

export function createJobsLookupRoutes({ jobsService, getConfig = async () => null, acquireSshSlot = null, now = Date.now }) {
  // 与 /api/jobs 同一前置：模块开关 → 服务在不在 → serverId 白名单。返回 serverId 或 null（已写出响应）。
  async function precheck(res, url, method) {
    if (!isDataModuleEnabled(await getConfig(), "jobs")) {
      sendJson(res, { disabled: true });
      return null;
    }
    if (typeof jobsService?.[method] !== "function") {
      sendJson(res, { error: "jobs lookup unavailable" }, 503);
      return null;
    }
    const serverId = url.searchParams.get("serverId") || "";
    if (!isBoundedServerId(serverId)) {
      sendJson(res, { error: "invalid serverId" }, 400);
      return null;
    }
    return serverId;
  }

  return routeTable({
    "GET /api/jobs/lookup": async ({ res, url }) => {
      const serverId = await precheck(res, url, "lookupHistory");
      if (serverId === null) return;
      const { query, error } = parseLookupQuery(url.searchParams, { now: now() });
      if (!query) return sendJson(res, { error }, 400);
      await respondOrError(res, async () => {
        const result = await jobsService.lookupHistory(serverId, query, { acquireSshSlot });
        if (result?.busy) return sendJson(res, { error: "上一次查询还没结束，请稍后再试" }, 429);
        sendJson(res, result);
      });
    },
    "GET /api/jobs/group": async ({ res, url }) => {
      const serverId = await precheck(res, url, "historyGroupPage");
      if (serverId === null) return;
      const snapshot = url.searchParams.get("snapshot") || "";
      const key = url.searchParams.get("key") || "";
      const limitRaw = url.searchParams.get("limit") || "";
      if (!LOOKUP_SNAPSHOT_RE.test(snapshot)) return sendJson(res, { error: "invalid snapshot" }, 400);
      // 组 key = 状态|名字前缀（lib/jobs/model.mjs）；控制字符一律拒绝。
      if (!key || key.length > LOOKUP_GROUP_KEY_MAX || !key.includes("|") || hasControlChar(key)) return sendJson(res, { error: "invalid key" }, 400);
      if (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > HISTORY_GROUP_PAGE_MAX) return sendJson(res, { error: "invalid limit" }, 400);
      await respondOrError(res, async () => {
        const page = await jobsService.historyGroupPage(serverId, snapshot, key, { limit: Number(limitRaw) });
        if (!page || page.expired) return sendJson(res, { error: "snapshot expired" }, 409);
        sendJson(res, page);
      });
    },
  });
}
