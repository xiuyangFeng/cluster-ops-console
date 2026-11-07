// v2.18 本地数据预算的手动清理：POST /api/storage/prune。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 清到预算的 50%，而不是刚好压到 100%——用户点这个按钮通常是因为已经贴着上限了，
// 清到刚好达标下一小时就又触顶，按钮等于白点。
const MANUAL_PRUNE_TARGET_RATIO = 0.5;

export function createStorageRoutes({ storageSweeper, appendLog }) {
  return routeTable({
    "POST /api/storage/prune": async ({ res, operationContext }) => {
      const result = await storageSweeper.sweep({ targetRatio: MANUAL_PRUNE_TARGET_RATIO });
      appendLog(`storage prune: 淘汰 ${result.evicted.length} 个文件，剩余 ${result.usedBytes} / ${result.budgetBytes} bytes`, {
        ...operationContext,
        event: "storage-prune",
        evicted: result.evicted.length,
        usedBytes: result.usedBytes,
        budgetBytes: result.budgetBytes,
        overBudget: result.overBudget,
      });
      sendJson(res, { success: true, ...result });
    },
  });
}
