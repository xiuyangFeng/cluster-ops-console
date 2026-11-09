// 管理员存储视图（lib/storage-admin/service.mjs）。root 或 adminUsers 可用，其余一律 403（服务内判定）。
//
//   GET  /api/storage-admin                                 → 概览（只读本机，不发 SSH）
//   POST /api/storage-admin/refresh    { targetId }         → 连 root 刷新容量 / 配额 / 任务
//   POST /api/storage-admin/key                             → 本机生成专用密钥（已有则直接返回）
//   POST /api/storage-admin/installer  { targetId }         → 生成安装脚本，返回在终端执行的命令
//   POST /api/storage-admin/scan       { targetId, root }   → 服务器后台开始整树扫描
//   POST /api/storage-admin/usage      { targetId, mount }  → 服务器后台按用户统计整块盘（读 inode 表）
//   POST /api/storage-admin/stop       { targetId, jobId }  → 停止扫描（已扫部分照常出结果）
//   GET  /api/storage-admin/view?targetId&jobId&rel         → 扫描结果的某一层（只读本机）
//   GET  /api/storage-admin/list?targetId&path[&jobId]      → 即时列一层目录（发 SSH）
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendError = (res, error) => sendJson(res, { error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) }, error?.status || 500);

export function createStorageAdminRoutes({ storageAdmin }) {
  const unavailable = (res) => sendJson(res, { error: "storage admin unavailable" }, 503);

  const post = (run) => async ({ req, res }) => {
    if (!storageAdmin) return unavailable(res);
    const data = await readRequiredBody(req, res);
    if (data == null) return;
    if (!isJsonObject(data)) return sendJson(res, { error: "请求正文必须是 JSON 对象" }, 400);
    if (data.targetId != null && !isBoundedServerId(data.targetId)) return sendJson(res, { error: "机器无效" }, 400);
    await respondOrError(res, async () => sendJson(res, await run(data)), sendError);
  };

  return routeTable({
    "GET /api/storage-admin": async ({ res }) => {
      if (!storageAdmin) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await storageAdmin.overview()), sendError);
    },
    "POST /api/storage-admin/refresh": post((d) => storageAdmin.refresh(d.targetId)),
    "POST /api/storage-admin/targets": post((d) => storageAdmin.configureTarget(d)),
    "POST /api/storage-admin/key": post(() => storageAdmin.ensureKey()),
    "POST /api/storage-admin/installer": post((d) => storageAdmin.installer(d.targetId)),
    "POST /api/storage-admin/scan": post((d) => {
      if (typeof d.root !== "string") throw Object.assign(new Error("扫描路径无效"), { status: 400 });
      return storageAdmin.startScan(d.targetId, d.root);
    }),
    "POST /api/storage-admin/usage": post((d) => {
      if (typeof d.mount !== "string") throw Object.assign(new Error("挂载点无效"), { status: 400 });
      return storageAdmin.startUsage(d.targetId, d.mount);
    }),
    "POST /api/storage-admin/stop": post((d) => storageAdmin.stopScan(d.targetId, d.jobId)),
    "GET /api/storage-admin/view": async ({ res, url }) => {
      if (!storageAdmin) return unavailable(res);
      const targetId = url.searchParams.get("targetId");
      if (!isBoundedServerId(targetId)) return sendJson(res, { error: "机器无效" }, 400);
      await respondOrError(res, async () => sendJson(res, await storageAdmin.scanView(
        targetId, url.searchParams.get("jobId"), url.searchParams.get("rel") ?? "",
      )), sendError);
    },
    "GET /api/storage-admin/list": async ({ res, url }) => {
      if (!storageAdmin) return unavailable(res);
      const targetId = url.searchParams.get("targetId");
      if (!isBoundedServerId(targetId)) return sendJson(res, { error: "机器无效" }, 400);
      await respondOrError(res, async () => sendJson(res, await storageAdmin.list(
        targetId, url.searchParams.get("path"), url.searchParams.get("jobId"),
      )), sendError);
    },
  });
}
