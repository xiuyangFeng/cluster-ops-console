// CLI 概览与安装 / 更新 / 回滚（第 2 期，lib/cli/install-service.mjs）。登录路由在 routes/cli-login.mjs，
// http-router 里排在本组之前（/api/cli/:cli/login*、/api/cli/login/* 先被登录组认领；本组只认 install / rollback /
// jobs，两组路径互不重叠，顺序只是保险）。
//   GET  /api/cli[?serverId=<id>]                         → { eligible, serverId, serverName, checkedAt,
//                                                            clis: { codex|claude: { ...CliState, label, latest,
//                                                                    latestCheckedAt, latestError, updateAvailable } },
//                                                            fallbackUnavailable, job, busy }
//                                                            （fallbackUnavailable：密码连接的服务器没有回退上传时的说明，否则 null）
//   POST /api/cli/:id/install   { serverId?, mode?: "auto"|"local" } → 202 { jobId, job }（安装或更新；前端先确认）
//   GET  /api/cli/jobs/:jobId                             → 任务快照（install.mjs createJobState 的形状）；不存在 404
//   POST /api/cli/jobs/:jobId/cancel                      → { job }（取消安装 / 更新任务，不需要请求体）。受理后等收尾做完
//                                                            才返回，那时 job.status="cancelled"、任务锁已释放；收尾超过约 20 秒
//                                                            （SSH 不通）先返回 cancelling=true 的快照。已结束的任务原样返回；
//                                                            不存在 404；落盘 / 切软链期间 409 { error, code: "not-cancellable" }
//   POST /api/cli/:id/rollback  { serverId?, target? }    → { ok, result, from, to, error }（target 缺省 = 上一个版本）
//   GET  /api/cli/team-cache[?serverId=&force=1]          → { serverId, dir, hub, isAdmin, sshUser, entries: { codex, claude },
//                                                            checkedAt, error }（团队缓存里有哪些版本，v2.89；60 秒内复用）
//   POST /api/cli/:id/publish   { serverId? }             → 202 { jobId, job }（管理员：发布最新版到团队缓存；进度同安装任务）
//   POST /api/cli/:id/smoke-test { serverId? }            → { ok, code, message, hint, reply, tail, seconds, envSh }
//                                                            （在集群上真的发一条很短的请求，最长约 2.5 分钟）
// serverId 可选；给了就必须等于当前活跃服务器（格式不对 400，不是活跃服务器 409）。同一台服务器同一时刻一个任务
// （安装 / 回滚 / 登录共用锁），占用中 409。写接口沿用全局鉴权（POST 必须带 token）。服务缺席时 503。
// 每个请求把运行时能力作为 runtime 传给服务：SSH 槽位（调度器）、已装状态（cliProbe = toolkit.cli 的
// getSnapshot：{ serverId, checkedAt, clis }，某轮 SSH 失败也保留上一份）、任务结束后的刷新（onCliChanged，
// lib/cli/refresh.mjs；没给时只补跑 cli:<serverId> 探针）。
import { cliProbeId } from "../../probe-ids.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";

// code 只透传服务自己带状态码的业务错误（如 not-cancellable），不把系统错误的 code（ENOENT 之类）漏出去。
const sendError = (res, error) => sendJson(res, {
  error: String(error?.message || error),
  ...(error?.busy ? { busy: error.busy } : {}),
  ...(error?.status && typeof error.code === "string" ? { code: error.code } : {}),
}, error?.status || 500);

const ACTION_PATH = /^\/api\/cli\/([a-z]{1,16})\/(install|rollback|publish|smoke-test)$/;
const JOB_PATH = /^\/api\/cli\/jobs\/([A-Za-z0-9-]{1,80})$/;
const JOB_CANCEL_PATH = /^\/api\/cli\/jobs\/([A-Za-z0-9-]{1,80})\/cancel$/;

export function createCliRoutes({ cliService, cliProbe = null, scheduler = null, onCliChanged = null }) {
  const runtime = {
    acquireSshSlot: scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null,
    // 探测服务的快照；从未探测成功 / 服务缺席 → null（界面显示「安装状态未知」）。
    getCliState: (serverId) => cliProbe?.getSnapshot?.(serverId) ?? null,
    onCliChanged: onCliChanged || ((serverId) => {
      if (scheduler?.isRegistered?.(cliProbeId(serverId))) return scheduler.forceRun(cliProbeId(serverId)).catch(() => {});
      return null;
    }),
  };
  const unavailable = (res) => {
    sendJson(res, { error: "cli management unavailable" }, 503);
    return true;
  };
  const badServerId = (value) => value != null && !isBoundedServerId(value);

  return async (ctx) => {
    const { req, res, url } = ctx;
    const pathname = url.pathname;
    if (pathname !== "/api/cli" && !pathname.startsWith("/api/cli/")) return false;

    if (pathname === "/api/cli") {
      if (req.method !== "GET") return false;
      if (!cliService) return unavailable(res);
      const serverId = url.searchParams.has("serverId") ? url.searchParams.get("serverId") : null;
      if (badServerId(serverId)) {
        sendJson(res, { error: "invalid serverId" }, 400);
        return true;
      }
      await respondOrError(res, async () => sendJson(res, await cliService.overview(serverId, runtime)), sendError);
      return true;
    }

    if (pathname === "/api/cli/team-cache" && req.method === "GET") {
      if (!cliService?.teamCache) return unavailable(res);
      const serverId = url.searchParams.has("serverId") ? url.searchParams.get("serverId") : null;
      if (badServerId(serverId)) {
        sendJson(res, { error: "invalid serverId" }, 400);
        return true;
      }
      const force = url.searchParams.get("force") === "1";
      await respondOrError(res, async () => sendJson(res, await cliService.teamCache(serverId, runtime, { force })), sendError);
      return true;
    }

    const jobMatch = pathname.match(JOB_PATH);
    if (jobMatch && req.method === "GET") {
      if (!cliService) return unavailable(res);
      const job = cliService.getJob(jobMatch[1]);
      if (!job) sendJson(res, { error: "job not found" }, 404);
      else sendJson(res, job);
      return true;
    }

    const cancelMatch = pathname.match(JOB_CANCEL_PATH);
    if (cancelMatch && req.method === "POST") {
      if (!cliService) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, { job: await cliService.cancelJob(cancelMatch[1]) }), sendError);
      return true;
    }

    const actionMatch = pathname.match(ACTION_PATH);
    if (actionMatch && req.method === "POST") {
      if (!cliService) return unavailable(res);
      const [, cli, action] = actionMatch;
      const data = await readRequiredBody(req, res);
      if (data == null) return true;
      if (!isJsonObject(data)) {
        sendJson(res, { error: "invalid request body" }, 400);
        return true;
      }
      if (badServerId(data.serverId)) {
        sendJson(res, { error: "invalid serverId" }, 400);
        return true;
      }
      if (action === "install") {
        await respondOrError(res, async () => sendJson(res, await cliService.startInstall(cli, { serverId: data.serverId ?? null, mode: data.mode ?? "auto" }, runtime), 202), sendError);
      } else if (action === "publish") {
        if (!cliService.startPublish) return unavailable(res);
        await respondOrError(res, async () => sendJson(res, await cliService.startPublish(cli, { serverId: data.serverId ?? null }, runtime), 202), sendError);
      } else if (action === "smoke-test") {
        if (!cliService.smokeTest) return unavailable(res);
        await respondOrError(res, async () => sendJson(res, await cliService.smokeTest(cli, { serverId: data.serverId ?? null }, runtime)), sendError);
      } else {
        const target = typeof data.target === "string" ? data.target.trim() : null;
        await respondOrError(res, async () => sendJson(res, await cliService.rollback(cli, { serverId: data.serverId ?? null, target }, runtime)), sendError);
      }
      return true;
    }
    return false;
  };
}
