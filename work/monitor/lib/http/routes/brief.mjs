// 今日简报：GET /api/brief?day=YYYY-MM-DD（缺省今天）与 GET /api/brief/days（可翻看的日期）。只读。
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createBriefRoutes({ briefService }) {
  return routeTable({
    "GET /api/brief/days": async ({ res }) => {
      if (!briefService) return sendJson(res, { error: "brief unavailable" }, 503);
      sendJson(res, await briefService.listDays());
    },
    "GET /api/brief": async ({ res, url }) => {
      if (!briefService) return sendJson(res, { error: "brief unavailable" }, 503);
      const day = url.searchParams.get("day") || "";
      // 白名单格式校验在拼任何路径之前：非法一律 400（含路径穿越尝试）。
      if (day && !DAY_RE.test(day)) return sendJson(res, { error: "invalid day" }, 400);
      const brief = await briefService.get(day || undefined);
      if (!brief) return sendJson(res, { error: "no brief for this day" }, 404);
      sendJson(res, brief);
    },
  });
}
