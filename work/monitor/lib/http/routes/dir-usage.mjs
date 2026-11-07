// 本人目录占用：GET /api/dir-usage（读本机已存结果，不发 SSH）与
// POST /api/dir-usage/scan（用户手动触发：{ serverId, root, mode: "start"|"continue", auto }。auto 为真 =
// 立刻返回、后台一轮接一轮续扫到完成，进度看 GET；否则只跑一轮有界扫描并等它回来）与
// POST /api/dir-usage/stop（{ serverId }：停止自动续扫，正在跑的这一轮做完为止）。
// 鉴权与其它 /api/* 相同。扫描的 SSH 占调度器全局槽位（并发上限 3）。
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendError = (res, error) => sendJson(res, { error: String(error?.message || error) }, error?.status || 500);

export function createDirUsageRoutes({ dirUsageService, scheduler }) {
  return routeTable({
    "GET /api/dir-usage": async ({ res, url }) => {
      if (!dirUsageService) return sendJson(res, { error: "dir-usage unavailable" }, 503);
      const serverId = url.searchParams.get("serverId");
      if (!isBoundedServerId(serverId)) return sendJson(res, { error: "服务器无效" }, 400);
      const root = url.searchParams.has("root") ? url.searchParams.get("root") : null;
      await respondOrError(res, async () => sendJson(res, await dirUsageService.get(serverId, root)), sendError);
    },
    "POST /api/dir-usage/scan": async ({ req, res }) => {
      if (!dirUsageService) return sendJson(res, { error: "dir-usage unavailable" }, 503);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || !isBoundedServerId(data.serverId) || typeof (data.root ?? "") !== "string") {
        return sendJson(res, { error: "扫描参数无效" }, 400);
      }
      const run = data.auto === true ? dirUsageService.startAuto : dirUsageService.scan;
      await respondOrError(res, async () => sendJson(res, await run(
        data.serverId,
        { root: data.root ?? "", mode: data.mode ?? "start" },
        { acquireSshSlot: scheduler ? (options) => scheduler.acquireSshSlot(options) : null },
      )), sendError);
    },
    "POST /api/dir-usage/stop": async ({ req, res }) => {
      if (!dirUsageService) return sendJson(res, { error: "dir-usage unavailable" }, 503);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || !isBoundedServerId(data.serverId)) return sendJson(res, { error: "服务器无效" }, 400);
      await respondOrError(res, async () => sendJson(res, await dirUsageService.stopAuto(data.serverId)), sendError);
    },
  });
}
