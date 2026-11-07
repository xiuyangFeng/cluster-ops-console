// 热更新：数据面（supervisor / 本地代理）零断连交接，POST /api/data-plane/upgrade。
// 同一时刻只允许一次（409），参数错 400；业务失败（如隧道 pid 变化）仍回 200 + ok:false。
// 状态码与响应体都由 upgrader 决定，这里只透传。
import { readJsonBody, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const UPGRADE_BODY_MAX_BYTES = 4096;

export function createDataPlaneRoutes({ dataPlaneUpgrader, appendLog }) {
  return routeTable({
    "POST /api/data-plane/upgrade": async ({ req, res, operationContext }) => {
      // 坏正文 / 超限给 upgrader 的是 null，由它回 400。
      const data = await readJsonBody(req, UPGRADE_BODY_MAX_BYTES);
      const { status, body } = await dataPlaneUpgrader.upgrade(data);
      appendLog(`data-plane upgrade request -> ${status}${body && typeof body.ok === "boolean" ? ` ok=${body.ok}` : ""}`, {
        ...operationContext,
        event: "data-plane-upgrade",
        ...(status === 200 && body?.ok === false ? { level: "warn" } : {}),
      });
      sendJson(res, body, status);
    },
  });
}
