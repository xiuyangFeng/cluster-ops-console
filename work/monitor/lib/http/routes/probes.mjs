// 手动运行探针：POST /api/probe/:id/run。
import { sendJson } from "../io.mjs";

const PREFIX = "/api/probe/";
const SUFFIX = "/run";

export function createProbeRoutes({ scheduler, appendLog }) {
  return async ({ req, res, url, operationContext }) => {
    const { pathname } = url;
    if (req.method !== "POST" || !pathname.startsWith(PREFIX) || !pathname.endsWith(SUFFIX)) return false;
    const probeId = decodeURIComponent(pathname.slice(PREFIX.length, pathname.length - SUFFIX.length));
    appendLog(`probe ${probeId} requested`, operationContext);
    try {
      // 此端点只由控制台的“运行探针”操作调用，是显式人工恢复入口：
      // 熔断期间允许用户发起一次真实复核。配置切换、信号复核和启动后的
      // 常规刷新仍使用默认 forceRun，继续受熔断门控。
      const result = await scheduler.forceRun(probeId, { overrideBreaker: true });
      sendJson(res, { ok: true, result });
    } catch (err) {
      if (err && typeof err.message === "string" && err.message.includes("未注册的探针")) {
        sendJson(res, { error: "unknown probe" }, 404);
        return true;
      }
      throw err;
    }
    return true;
  };
}
