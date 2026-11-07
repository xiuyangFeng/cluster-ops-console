// 隧道稳定性（断线账本统计）：只读。数据源见 lib/tunnel-stability-service.mjs。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createTunnelRoutes({ tunnelStability }) {
  return routeTable({
    "GET /api/tunnel-stability": async ({ res }) => {
      if (!tunnelStability) return sendJson(res, { error: "tunnel stability unavailable" }, 503);
      sendJson(res, await tunnelStability.get());
    },
  });
}
