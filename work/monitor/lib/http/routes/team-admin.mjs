// 团队管理（Team Admin）HTTP 路由组（lib/team-admin/service.mjs + member-sync.mjs）：
//
//   GET  /api/team/overview[?serverId=...&force=1]   → TeamOverview（仅管理员可调，非管理员 403）
//   POST /api/team/member                            → 新增或编辑成员名册 / 预分配端口（返回最新 TeamOverview）
//   POST /api/team/member/remove                     → 从名册移除成员（返回最新 TeamOverview）
//   POST /api/team/assign                            → 加密下发或撤回 AI 中转站 / API Key（返回 { delivery, rev, overview }）
//   POST /api/team/release-port                      → 释放闲置端口登记（返回 { status, port, command?, message?, overview }）
//   POST /api/team/sync-now                          → 立即触发本机成员端后台同步（拉取加密配置 + 上报心跳）

import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readJsonBody, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

export function createTeamAdminRoutes({ teamAdminService = null, memberSync = null } = {}) {
  const unavailable = (res) => sendJson(res, { error: "team admin service unavailable" }, 503);

  const sendError = (res, error) => sendJson(
    res,
    {
      error: error?.message || "操作失败",
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.field ? { field: error.field } : {}),
    },
    error?.status || 500,
  );

  const adminAction = (run) => async ({ req, res }) => {
    if (!teamAdminService) return unavailable(res);
    const data = await readJsonBody(req);
    if (!isJsonObject(data)) return sendJson(res, { error: "请求正文必须是 JSON 对象" }, 400);
    if (data.serverId != null && data.serverId !== "" && !isBoundedServerId(data.serverId)) {
      return sendJson(res, { error: "invalid serverId" }, 400);
    }
    try {
      sendJson(res, await run({ ...data, serverId: data.serverId || null }));
    } catch (error) {
      sendError(res, error);
    }
  };

  return routeTable({
    "GET /api/team/overview": async ({ res, url }) => {
      if (!teamAdminService) return unavailable(res);
      const serverId = url.searchParams.get("serverId") || null;
      if (serverId !== null && !isBoundedServerId(serverId)) {
        return sendJson(res, { error: "invalid serverId" }, 400);
      }
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("fresh") === "1";
      try {
        sendJson(res, await teamAdminService.getOverview({ serverId, force }));
      } catch (error) {
        sendError(res, error);
      }
    },
    "POST /api/team/member": adminAction((data) => teamAdminService.upsertMember(data)),
    "POST /api/team/member/remove": adminAction((data) => teamAdminService.removeMember(data)),
    "POST /api/team/assign": adminAction((data) => teamAdminService.assignAiConfig(data)),
    "POST /api/team/notice": adminAction((data) => teamAdminService.publishNotice(data)),
    "POST /api/team/release-port": adminAction((data) => teamAdminService.releasePort(data)),
    "POST /api/team/kill-port": adminAction((data) => teamAdminService.killPort(data)),
    "POST /api/team/sync-now": async ({ req, res }) => {
      if (!memberSync) return sendJson(res, { error: "member sync unavailable" }, 503);
      let data = {};
      try {
        const parsed = await readJsonBody(req);
        if (isJsonObject(parsed)) data = parsed;
      } catch {}
      if (data.serverId != null && data.serverId !== "" && !isBoundedServerId(data.serverId)) {
        return sendJson(res, { error: "invalid serverId" }, 400);
      }
      try {
        sendJson(res, await memberSync.syncNow({
          serverId: data.serverId || null,
          forceApply: data.forceApply === true,
        }));
      } catch (error) {
        sendError(res, error);
      }
    },
  });
}
