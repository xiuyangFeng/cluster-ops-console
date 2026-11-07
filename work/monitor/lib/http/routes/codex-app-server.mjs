// Codex 客户端守护进程（v2.85）：只有一条写接口。
//   POST /api/codex/app-server/restart  { serverId? }
//     → { ok, serverId, result: "restarted"|"recovered"|"failed", message, error, output, checkedAt }
// serverId 可选；给了就必须等于当前活跃服务器（格式不对 400，不是活跃服务器 409）。正文只接受 serverId，
// 多带任何键一律 400——请求里的字符串到不了远端命令。服务缺席 503；同一时刻一个重启（服务层 409）。
// 鉴权 / CSRF 与其它 /api/* 相同（POST 必须带 token）。SSH 占调度器全局槽位。
// 成功之后补跑一次 doctor 探针（不等 5 分钟稳态间隔），让界面上的端口与卡片尽快回到真实状态。
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendError = (res, error) => sendJson(res, { error: String(error?.message || error) }, error?.status || 500);

export function createCodexAppServerRoutes({ codexAppServer = null, scheduler = null }) {
  const acquireSshSlot = scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null;

  return routeTable({
    "POST /api/codex/app-server/restart": async ({ req, res }) => {
      if (!codexAppServer) return sendJson(res, { error: "codex app-server unavailable" }, 503);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || Object.keys(data).some((key) => key !== "serverId")) {
        return sendJson(res, { error: "只接受 serverId" }, 400);
      }
      if (data.serverId != null && !isBoundedServerId(data.serverId)) {
        return sendJson(res, { error: "invalid serverId" }, 400);
      }
      await respondOrError(res, async () => {
        const result = await codexAppServer.restart({ serverId: data.serverId ?? null }, { acquireSshSlot });
        if (result?.ok) {
          // 不阻塞响应：补跑结果由状态推送自己到达前端。
          Promise.resolve(scheduler?.forceRun?.("doctor")).catch(() => {});
        }
        sendJson(res, result);
      }, sendError);
    },
  });
}
