// 环境引导步骤：GET /api/bootstrap/state 与 POST /api/bootstrap/step/:id/run。
import { sendJson } from "../io.mjs";

const STEP_PREFIX = "/api/bootstrap/step/";
const STEP_RUN_RE = /^\/api\/bootstrap\/step\/([a-z-]+)\/run$/;

export function createBootstrapRoutes({ bootstrapRunner, appendLog }) {
  function runStep(res, stepId, operationContext) {
    const step = bootstrapRunner.getState().steps.find((s) => s.id === stepId);
    if (!step) return sendJson(res, { error: "unknown bootstrap step" }, 404);
    if (step.status === "running") return sendJson(res, { started: false, reason: "already running" });
    if (step.disabled) return sendJson(res, { started: false, reason: step.disabledReason || "unsupported-platform" });
    // 触发后立即返回；步骤在后台运行，前端轮询 /api/bootstrap/state 直至离开 running。
    appendLog(`bootstrap step ${stepId} requested`, operationContext);
    bootstrapRunner.runStep(stepId, operationContext).catch((err) => appendLog(`bootstrap step ${stepId} error: ${err.message}`, operationContext));
    sendJson(res, { started: true });
  }

  return async ({ req, res, url, operationContext }) => {
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/api/bootstrap/state") {
      sendJson(res, bootstrapRunner.getState());
      return true;
    }
    if (req.method !== "POST" || !pathname.startsWith(STEP_PREFIX)) return false;
    const match = pathname.match(STEP_RUN_RE);
    if (!match) sendJson(res, { error: "unknown bootstrap step" }, 404);
    else runStep(res, match[1], operationContext);
    return true;
  };
}
