import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { LoginError } from "../../cli/login-api.mjs";
import { createCliLoginRoutes } from "./cli-login.mjs";

async function call(route, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    writeHead(code) {
      this.status = code;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: { operationId: "op-1" } });
  return { handled, status: res.status, body: res.body };
}

const JOB = { jobId: "j-1", state: "running", phase: "waiting-code" };

test("/api/cli 登录路由：启动 202、轮询、回贴授权码、取消、中转站预检；正文与操作上下文交给服务", async () => {
  const calls = [];
  const route = createCliLoginRoutes({
    cliLoginService: {
      start: async (cli, body, ctx) => {
        calls.push(["start", cli, { ...body }, ctx]);
        return JOB;
      },
      get: (id) => (id === "j-1" ? JOB : null),
      current: (serverId) => {
        calls.push(["current", serverId]);
        return null;
      },
      submitCode: (id, code) => {
        calls.push(["code", id, code]);
        return { ...JOB, phase: "verifying" };
      },
      cancel: async (id) => {
        calls.push(["cancel", id]);
        return { ...JOB, state: "cancelled" };
      },
      relayCheck: (baseUrl) => ({ ok: true, action: "none", baseUrl }),
    },
  });
  assert.deepEqual(await call(route, "POST", "/api/cli/codex/login", { method: "api", apiKey: "sk-xxxxxxxxxx" }), { handled: true, status: 202, body: { jobId: "j-1", job: JOB } });
  assert.deepEqual(calls[0], ["start", "codex", { method: "api", apiKey: "sk-xxxxxxxxxx" }, { operationId: "op-1" }]);
  assert.deepEqual(await call(route, "GET", "/api/cli/login/jobs/j-1"), { handled: true, status: 200, body: { job: JOB } });
  assert.equal((await call(route, "GET", "/api/cli/login/jobs/nope")).status, 404);
  assert.equal((await call(route, "POST", "/api/cli/login/jobs/j-1/code", { code: "abc#d" })).body.job.phase, "verifying");
  assert.equal((await call(route, "POST", "/api/cli/login/jobs/j-1/cancel")).body.job.state, "cancelled");
  assert.deepEqual((await call(route, "GET", "/api/cli/login/current?serverId=server-02")).body, { job: null });
  assert.equal((await call(route, "POST", "/api/cli/login/relay-check", { baseUrl: "https://r" })).body.action, "none");
  assert.deepEqual(calls.slice(1), [["code", "j-1", "abc#d"], ["cancel", "j-1"], ["current", "server-02"]]);
  assert.equal((await call(route, "POST", "/api/cli/codex/login", "{bad")).status, 400);
});

test("/api/cli 登录路由：业务错误按 status 回 { error, code, field, jobId }；非本组路径交给下一组（安装路由）", async () => {
  const route = createCliLoginRoutes({
    cliLoginService: {
      start: async () => {
        const err = new LoginError("busy", "服务器 server-01 上已有一个登录任务在进行", { status: 409 });
        err.jobId = "j-0";
        throw err;
      },
      submitCode: () => {
        throw new LoginError("bad-code", "授权码格式不对", { field: "code" });
      },
      cancel: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(await call(route, "POST", "/api/cli/claude/login", { method: "account" }), {
    handled: true,
    status: 409,
    body: { error: "服务器 server-01 上已有一个登录任务在进行", code: "busy", jobId: "j-0" },
  });
  assert.deepEqual((await call(route, "POST", "/api/cli/login/jobs/j-1/code", { code: "x" })).body, { error: "授权码格式不对", code: "bad-code", field: "code" });
  assert.deepEqual(await call(route, "POST", "/api/cli/login/jobs/j-1/cancel"), { handled: true, status: 500, body: { error: "登录服务出错", code: "internal" } });
  for (const [method, path] of [["GET", "/api/cli"], ["POST", "/api/cli/codex/install"], ["GET", "/api/cli/jobs/abc"], ["GET", "/api/cli/codex/login"], ["POST", "/api/cli/login/jobs/j-1"], ["GET", "/api/egress"]]) {
    assert.equal((await call(route, method, path)).handled, false, `${method} ${path}`);
  }
});

test("/api/cli 登录路由：服务未装配时本组路径回 503", async () => {
  const route = createCliLoginRoutes({ cliLoginService: null });
  assert.equal((await call(route, "POST", "/api/cli/codex/login", { method: "account" })).status, 503);
  assert.equal((await call(route, "GET", "/api/cli/login/jobs/x")).status, 503);
  assert.equal((await call(route, "GET", "/api/cli")).handled, false);
});
