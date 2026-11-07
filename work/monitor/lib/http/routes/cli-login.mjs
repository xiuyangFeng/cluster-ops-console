// 集群 CLI 登录（v2.57 第 2 期 P-E，lib/cli/login.mjs）。与安装 / 版本（routes/cli.mjs）同属 /api/cli，
// 单独成文件，集成时可并入。
//
//   POST /api/cli/:cli/login                 { method, serverId?, apiKey?, baseUrl?, providerId?, providerName?,
//                                              acknowledgePlaintext? } → 202 { jobId, job }
//        cli: codex | claude；method: account | api | relay（Claude 另有 setup-token）。
//        同一台服务器已有登录 / 安装 / 回滚任务（共用 task-lock.mjs）→ 409 { error, code: "busy", jobId, busy: { kind, cli } }。
//   GET  /api/cli/login/jobs/:jobId          → { job }（结束后保留 10 分钟）
//   GET  /api/cli/login/current?serverId=    → { job | null }（正在进行的，或最近一个）
//   POST /api/cli/login/jobs/:jobId/code     { code } → { job }（Claude 账号 / 长期令牌：回贴授权码）
//   POST /api/cli/login/jobs/:jobId/cancel   → { job }（杀本机 ssh 与端口转发，清理集群上的登录进程）
//   POST /api/cli/login/relay-check          { baseUrl } → { ok, action, entry?, host, port, warnings, notes, error? }
//
// 请求体里的 apiKey / code 只交给服务、不写日志；错误响应只带服务给出的中文原因（从不含 key）。
// 写接口沿用全局鉴权（http-auth：写方法必须带有效 token）。服务缺席时 503。
import { readRequiredBody, sendJson } from "../io.mjs";

const JOB_PATH = /^\/api\/cli\/login\/jobs\/([A-Za-z0-9-]{1,64})(?:\/(code|cancel))?$/;
const START_PATH = /^\/api\/cli\/([a-z]{1,16})\/login$/;

function sendLoginError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const body = { error: status === 500 && !err?.code ? "登录服务出错" : err.message, code: err?.code || "internal" };
  if (err?.field) body.field = err.field;
  if (err?.jobId) body.jobId = err.jobId;
  // 与安装路由（routes/cli.mjs）同一形状：占用者 { kind, cli, … }，前端按 kind 区分提示。
  if (err?.busy) body.busy = err.busy;
  sendJson(res, body, status);
}

export function createCliLoginRoutes({ cliLoginService }) {
  const unavailable = (res) => sendJson(res, { error: "cli login unavailable" }, 503);

  // 本组接管的路径（不论服务在不在）：服务缺席时统一 503。
  function owns(method, path) {
    if (method === "POST" && path === "/api/cli/login/relay-check") return true;
    if (method === "GET" && path === "/api/cli/login/current") return true;
    const job = path.match(JOB_PATH);
    if (job) return job[2] ? method === "POST" : method === "GET";
    return method === "POST" && START_PATH.test(path);
  }

  return async ({ req, res, url, operationContext }) => {
    const path = url.pathname;
    const method = req.method;
    if (!path.startsWith("/api/cli/") || !owns(method, path)) return false;
    if (!cliLoginService) {
      unavailable(res);
      return true;
    }

    if (method === "POST" && path === "/api/cli/login/relay-check") {
      const data = await readRequiredBody(req, res);
      if (data == null) return true;
      sendJson(res, cliLoginService.relayCheck(data?.baseUrl));
      return true;
    }

    if (method === "GET" && path === "/api/cli/login/current") {
      sendJson(res, { job: cliLoginService.current(url.searchParams.get("serverId") || null) });
      return true;
    }

    const jobMatch = path.match(JOB_PATH);
    if (jobMatch) {
      const [, jobId, action] = jobMatch;
      if (!action) {
        const job = cliLoginService.get(jobId);
        if (!job) sendJson(res, { error: "登录任务不存在或已过期", code: "not-found" }, 404);
        else sendJson(res, { job });
        return true;
      }
      const data = action === "code" ? await readRequiredBody(req, res) : {};
      if (data == null) return true;
      try {
        const job = action === "code" ? cliLoginService.submitCode(jobId, data?.code) : await cliLoginService.cancel(jobId);
        sendJson(res, { job });
      } catch (err) {
        sendLoginError(res, err);
      } finally {
        if (typeof data === "object") data.code = null;
      }
      return true;
    }

    // POST /api/cli/:cli/login
    const cli = path.match(START_PATH)[1];
    const data = await readRequiredBody(req, res);
    if (data == null) return true;
    try {
      const job = await cliLoginService.start(cli, data, operationContext);
      sendJson(res, { jobId: job.jobId, job }, 202);
    } catch (err) {
      sendLoginError(res, err);
    } finally {
      // 请求体里的 key 不再被引用（字符串无法清零，尽力而为）。
      if (data && typeof data === "object") data.apiKey = null;
    }
    return true;
  };
}
