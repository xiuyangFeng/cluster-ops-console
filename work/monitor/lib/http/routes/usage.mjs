// Agent 用量读接口：GET /api/usage/summary（KPI / 趋势 / 日历 / 项目 / 会话列表）与
// GET /api/usage/session（单个会话的 轮次 → 调用 明细）。只读，鉴权与其它 /api/* 读接口相同。
// 立即同步复用 POST /api/probe/usage:<serverId>/run。
// 设置页「监控模块」关掉用量统计时两个接口都回 200 { disabled: true }（前端显示「模块已关闭」）。
import { isDataModuleEnabled } from "../../modules/catalog.mjs";
import { AGENT_IDS } from "../../usage/model.mjs";
import { sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENTS = new Set(["all", ...AGENT_IDS]);

export function parseSummaryParams(params) {
  const range = Number(params.get("range"));
  const date = params.get("date");
  const agent = params.get("agent") || "all";
  const project = params.get("project") || "all";
  const model = params.get("model") || "all";
  return {
    range: [1, 7, 30].includes(range) ? range : 1,
    date: date && DAY_RE.test(date) ? date : null,
    agent: AGENTS.has(agent) ? agent : "all",
    project: project.length <= 600 ? project : "all",
    ...(model !== "all" && model.length <= 80 ? { model } : {}),
  };
}

export function createUsageRoutes({ usageService, getConfig = async () => null }) {
  const moduleDisabled = async () => !isDataModuleEnabled(await getConfig(), "usage");
  return routeTable({
    "GET /api/usage/summary": async ({ res, url }) => {
      if (await moduleDisabled()) return sendJson(res, { disabled: true });
      if (!usageService) return sendJson(res, { error: "usage unavailable" }, 503);
      try {
        sendJson(res, await usageService.summary(parseSummaryParams(url.searchParams)));
      } catch (err) {
        sendJson(res, { error: String(err?.message || err) }, 500);
      }
    },
    "GET /api/usage/session": async ({ res, url }) => {
      if (await moduleDisabled()) return sendJson(res, { disabled: true });
      if (!usageService) return sendJson(res, { error: "usage unavailable" }, 503);
      const key = url.searchParams.get("key") || "";
      if (!key || key.length > 400) return sendJson(res, { error: "invalid session key" }, 400);
      try {
        const detail = await usageService.sessionDetail(key);
        if (!detail) return sendJson(res, { error: "session not found" }, 404);
        sendJson(res, detail);
      } catch (err) {
        sendJson(res, { error: String(err?.message || err) }, 500);
      }
    },
  });
}
