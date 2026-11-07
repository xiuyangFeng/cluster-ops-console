// 工作台自己的诊断（v2.64，lib/diagnostics/service.mjs）：
//
//   GET  /api/diagnostics/bundle        → { filename, bundle, bytes, redactions }：导出用的诊断包（已脱敏）。
//                                          配置浮层「版本与更新」里的「导出诊断包」取它，交给保存对话框 / 浏览器下载。
//   POST /api/diagnostics/client-error  → 202 { accepted: true }：页面脚本的未捕获异常 / 未处理 rejection，
//                                          写 runtime/logs/renderer.ndjson（只由监控服务写；desktop.ndjson 归 Electron 主进程）。
//        正文不是对象、超过 16 KB、缺 kind / message → 400；同一条一分钟内重复 / 超过每分钟 10 条或每小时 60 条 → 429。
//        页面那边上报失败不重试，所以这里不给任何「稍后再试」的提示。
//
// 两条都沿用全局鉴权（读写都要令牌）。服务缺席时 503。
import { isJsonObject, readJsonBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";
import { CLIENT_ERROR_LIMITS } from "../../diagnostics/client-errors.mjs";

export function createDiagnosticsRoutes({ diagnostics = null, getStatusPayload = () => null }) {
  const unavailable = (res) => sendJson(res, { error: "diagnostics unavailable" }, 503);
  return routeTable({
    "GET /api/diagnostics/bundle": async ({ res }) => {
      if (!diagnostics) return unavailable(res);
      let status;
      try {
        status = getStatusPayload();
      } catch (err) {
        status = { error: String(err?.message || err).slice(0, 300) };
      }
      await respondOrError(res, async () => sendJson(res, await diagnostics.buildBundle({ status })), (r, err) => sendJson(r, { error: err.message || "diagnostics failed" }, 500));
    },
    "POST /api/diagnostics/client-error": async ({ req, res }) => {
      if (!diagnostics) return unavailable(res);
      const body = await readJsonBody(req, CLIENT_ERROR_LIMITS.bodyBytes);
      if (!isJsonObject(body)) return sendJson(res, { accepted: false, reason: "invalid" }, 400);
      const result = diagnostics.recordClientError(body);
      if (result.ok) return sendJson(res, { accepted: true }, 202);
      sendJson(res, { accepted: false, reason: result.reason }, result.reason === "invalid" ? 400 : 429);
    },
  });
}
