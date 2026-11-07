// T04b 单隧道操作：preview（后端计算影响范围）→ run（只接 previewId，202 已受理）→
// GET /api/operations/:id 查询（queued/executing/verifying/succeeded/failed/unknown）。
// 旧 /api/restart 等接口语义不变（仍是全局动作）。
import { readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { firstMatch, routeTable } from "../route-kit.mjs";

const ITEM_PREFIX = "/api/operations/";

export function createOperationRoutes({ operationsRunner }) {
  const actions = routeTable({
    "POST /api/operations/preview": async ({ req, res }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => sendJson(res, await operationsRunner.preview(data)));
    },
    "POST /api/operations/run": async ({ req, res, operationContext }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => {
        const result = await operationsRunner.run({ previewId: data.previewId, operationId: operationContext?.operationId });
        sendJson(res, result, 202);
      });
    },
  });

  async function getOperation({ req, res, url }) {
    if (req.method !== "GET" || !url.pathname.startsWith(ITEM_PREFIX)) return false;
    const operationId = decodeURIComponent(url.pathname.slice(ITEM_PREFIX.length));
    await respondOrError(res, async () => {
      const operation = await operationsRunner.getOperation(operationId);
      if (!operation) return sendJson(res, { error: "operation not found" }, 404);
      sendJson(res, operation);
    });
    return true;
  }

  return firstMatch(actions, getOperation);
}
