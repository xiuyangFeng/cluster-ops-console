// 接入管理（lib/onboarding-guide/access.mjs，配置 →「接入引导」下面的端口登记与撤销接入）：
//
//   GET  /api/onboarding/access[?fresh=1]         → { available, reason, server, port, registry, busy, undo }
//                                                    本机已知的部分立刻返回；registry.pending 为真 = 后台正在 SSH 读端口登记，
//                                                    隔一秒再取。fresh=1 跳过一分钟的缓存重读。undo 是最近一次撤销的进度 / 结果。
//   POST /api/onboarding/access/release-port      { port, serverId? } → { port, result: "ok" | "absent", access }
//                                                    只放闲置的：这台电脑在用的、正在被监听的、不在自己名下的 409。
//   POST /api/onboarding/access/undo/preview      { serverId? } → { preview, access }。只读；preview.previewId 十分钟内有效。
//   POST /api/onboarding/access/undo/run          { previewId, releasePort?, serverId? } → { access }
//                                                    立刻返回，后台逐步执行（任何一步没做成就停），进度看 GET 的 undo。
//
// 只对团队集群那一台；serverId 给了就必须是它（409）。写接口沿用全局鉴权（必须带 token）。
// 同一时刻只做一个动作，正在做时 409 { code: "busy" }；安装 / 登录占着任务锁时同样 409（带 busy）。
// 读不到集群 502；服务缺席（未装配）时 503。
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readJsonBody, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createOnboardingAccessRoutes({ accessManager }) {
  const unavailable = (res) => sendJson(res, { error: "access management unavailable" }, 503);

  const sendError = (res, error) => sendJson(
    res,
    { error: error?.message || "操作失败", code: error?.code, ...(error?.busy ? { busy: error.busy } : {}) },
    error?.status || 500,
  );

  // 读正文 → 调服务 → 回结果；服务抛的 statusError 原样带上状态码与 code。
  const action = (run) => async ({ req, res }) => {
    if (!accessManager) return unavailable(res);
    const data = await readJsonBody(req);
    if (!isJsonObject(data)) return sendJson(res, { error: "请求正文必须是 JSON 对象" }, 400);
    if (data.serverId != null && !isBoundedServerId(data.serverId)) return sendJson(res, { error: "invalid serverId" }, 400);
    try {
      sendJson(res, await run({ ...data, serverId: data.serverId ?? null }));
    } catch (error) {
      sendError(res, error);
    }
  };

  return routeTable({
    "GET /api/onboarding/access": async ({ res, url }) => {
      if (!accessManager) return unavailable(res);
      try {
        sendJson(res, await accessManager.getAccess({ fresh: url.searchParams.get("fresh") === "1" }));
      } catch (error) {
        sendError(res, error);
      }
    },
    "POST /api/onboarding/access/release-port": action((data) => accessManager.releasePort({ serverId: data.serverId, port: data.port })),
    "POST /api/onboarding/access/undo/preview": action((data) => accessManager.previewUndo({ serverId: data.serverId })),
    "POST /api/onboarding/access/undo/run": action((data) => accessManager.runUndo({
      serverId: data.serverId,
      previewId: data.previewId,
      // 只有明确的 true 才释放端口：漏传、传错类型一律按"保留"。
      releasePort: data.releasePort === true,
    })),
  });
}
