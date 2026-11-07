// v2.16 历史复盘：按天读取状态迁移/指标采样/信号历史（runtime/history/*.ndjson）。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_RE = /^[a-z]{1,16}$/;

// ?types=transition,levels：只要这些类型的条目（泳道图不需要逐分钟的 sample，一天能省下九成体量）。
// 省略 = 全部，行为与此前一致；写了但没有一个合法类型名 = 空结果。早期只带消息体、没有
// type 字段的迁移条目按 transition 算。
function parseTypes(raw) {
  if (raw == null || raw === "") return null;
  return new Set(String(raw).split(",").map((t) => t.trim()).filter((t) => TYPE_RE.test(t)).slice(0, 8));
}

export function createHistoryRoutes({ historyStore }) {
  return routeTable({
    "GET /api/history/days": async ({ res }) => sendJson(res, { days: await historyStore.listDays() }),
    "GET /api/history": async ({ res, url }) => {
      const date = url.searchParams.get("date") || "";
      // 白名单格式校验在拼任何路径之前：非法一律 400（含路径穿越尝试）。
      if (!DATE_RE.test(date)) {
        return sendJson(res, { error: "invalid date" }, 400);
      }
      const entries = await historyStore.readDay(date);
      const types = parseTypes(url.searchParams.get("types"));
      sendJson(res, { date, entries: types ? entries.filter((entry) => types.has(entry.type || "transition")) : entries });
    },
  });
}
