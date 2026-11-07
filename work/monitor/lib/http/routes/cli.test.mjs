import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createCliRoutes } from "./cli.mjs";

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
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: undefined });
  return { handled, status: res.status, body: res.body };
}

test("/api/cli*：概览 / 安装 202 / 任务进度 / 回滚；已装状态读探测快照，结束后走 onCliChanged", async () => {
  const calls = [];
  const scheduler = {
    acquireSshSlot: async () => () => {},
    isRegistered: () => true,
    forceRun: async (id) => calls.push(["forceRun", id]),
  };
  // toolkit.cli（lib/cli/service.mjs）的快照形状：{ serverId, checkedAt, clis }。
  const cliProbe = { getSnapshot: (id) => (id === "server-01" ? { serverId: id, checkedAt: 1, clis: {} } : null) };
  const cliService = {
    overview: async (serverId, runtime) => {
      calls.push(["overview", serverId, runtime.getCliState("server-01")?.checkedAt]);
      return { eligible: true, serverId: "server-01", clis: {}, job: null };
    },
    startInstall: async (cli, opts, runtime) => {
      calls.push(["startInstall", cli, opts, typeof runtime.acquireSshSlot]);
      runtime.onCliChanged("server-01", { cli, ok: true });
      return { jobId: "cli-abc", job: { status: "running" } };
    },
    getJob: (id) => (id === "cli-abc" ? { jobId: id, status: "running" } : null),
    rollback: async (cli, opts) => {
      calls.push(["rollback", cli, opts]);
      return { ok: true, result: "ok", from: "a", to: "b", error: null };
    },
  };
  const route = createCliRoutes({ cliService, cliProbe, scheduler, onCliChanged: async (id, info) => calls.push(["onCliChanged", id, info]) });
  assert.equal((await call(route, "GET", "/api/cli?serverId=server-01")).status, 200);
  const install = await call(route, "POST", "/api/cli/codex/install", { serverId: "server-01", mode: "local" });
  assert.deepEqual([install.status, install.body.jobId], [202, "cli-abc"]);
  assert.deepEqual((await call(route, "GET", "/api/cli/jobs/cli-abc")).body, { jobId: "cli-abc", status: "running" });
  assert.equal((await call(route, "GET", "/api/cli/jobs/cli-zzz")).status, 404);
  assert.equal((await call(route, "POST", "/api/cli/claude/rollback", { target: " 2.1.285 " })).status, 200);
  assert.deepEqual(calls, [
    ["overview", "server-01", 1],
    ["startInstall", "codex", { serverId: "server-01", mode: "local" }, "function"],
    ["onCliChanged", "server-01", { cli: "codex", ok: true }],
    ["rollback", "claude", { serverId: null, target: "2.1.285" }],
  ]);
});

test("/api/cli*：参数校验、服务缺席 503、错误带状态码与占用信息、不归自己的路径交给下一组", async () => {
  const busy = Object.assign(new Error("这台服务器上正在进行 codex 的安装 / 更新，请等它结束"), { status: 409, busy: { kind: "install", cli: "codex" } });
  const route = createCliRoutes({
    cliService: {
      overview: async () => ({}),
      startInstall: async () => { throw busy; },
      getJob: () => null,
      rollback: async () => ({}),
    },
  });
  assert.equal((await call(route, "GET", "/api/cli?serverId=bad%20id")).status, 400);
  assert.equal((await call(route, "POST", "/api/cli/codex/install", { serverId: "../x" })).status, 400);
  assert.equal((await call(route, "POST", "/api/cli/codex/install", "{oops")).status, 400);
  assert.equal((await call(route, "POST", "/api/cli/codex/install", [1])).status, 400);
  const conflict = await call(route, "POST", "/api/cli/codex/install", {});
  assert.deepEqual([conflict.status, conflict.body.busy.kind], [409, "install"]);
  assert.equal((await call(route, "DELETE", "/api/cli")).handled, false);
  assert.equal((await call(route, "GET", "/api/cli/codex/install")).handled, false);
  assert.equal((await call(route, "GET", "/api/clix")).handled, false);
  assert.equal((await call(createCliRoutes({ cliService: null }), "GET", "/api/cli")).status, 503);
});

test("POST /api/cli/jobs/:jobId/cancel：返回 { job }；不存在 404、临界阶段 409 带 code、服务缺席 503；不需要请求体；GET 不认", async () => {
  const calls = [];
  const notCancellable = Object.assign(new Error("集群上正在解包、冒烟并切换版本（已经在改正式目录），这一步不能中途取消"), { status: 409, code: "not-cancellable" });
  const route = createCliRoutes({
    cliService: {
      getJob: () => null,
      cancelJob: async (jobId) => {
        calls.push(jobId);
        if (jobId === "cli-critical") throw notCancellable;
        if (jobId === "cli-gone") throw Object.assign(new Error("任务不存在或已过期"), { status: 404 });
        return { jobId, status: "cancelled", cancelling: false };
      },
    },
  });
  const ok = await call(route, "POST", "/api/cli/jobs/cli-abc/cancel");
  assert.deepEqual([ok.status, ok.body], [200, { job: { jobId: "cli-abc", status: "cancelled", cancelling: false } }]);
  assert.equal((await call(route, "POST", "/api/cli/jobs/cli-abc/cancel", {})).status, 200, "带空对象也行");
  const critical = await call(route, "POST", "/api/cli/jobs/cli-critical/cancel");
  assert.deepEqual([critical.status, critical.body.code], [409, "not-cancellable"]);
  assert.match(critical.body.error, /不能中途取消/);
  assert.equal((await call(route, "POST", "/api/cli/jobs/cli-gone/cancel")).status, 404);
  assert.deepEqual(calls, ["cli-abc", "cli-abc", "cli-critical", "cli-gone"]);

  assert.equal((await call(route, "GET", "/api/cli/jobs/cli-abc/cancel")).handled, false);
  assert.equal((await call(route, "POST", "/api/cli/jobs/cli-abc")).handled, false);
  assert.equal((await call(route, "POST", "/api/cli/jobs/bad%20id/cancel")).handled, false);
  assert.equal((await call(createCliRoutes({ cliService: null }), "POST", "/api/cli/jobs/cli-abc/cancel")).status, 503);
});

test("/api/cli*：没给 onCliChanged 时只补跑已注册的 cli:<serverId> 探针；探测服务缺席时已装状态为 null", async () => {
  const calls = [];
  const scheduler = { isRegistered: (id) => id === "cli:server-01", forceRun: async (id) => calls.push(id) };
  let runtime = null;
  const route = createCliRoutes({
    cliService: { overview: async (_s, rt) => { runtime = rt; return {}; } },
    scheduler,
  });
  await call(route, "GET", "/api/cli");
  assert.equal(runtime.getCliState("server-01"), null);
  await runtime.onCliChanged("server-01", { cli: "codex", ok: true });
  assert.equal(runtime.onCliChanged("server-02", { cli: "codex", ok: true }), null);
  assert.deepEqual(calls, ["cli:server-01"]);
});

test("/api/cli/team-cache、/publish、/smoke-test（v2.89）：参数透传，业务错误带状态码；服务没有这些方法时 503", async () => {
  const calls = [];
  const cliService = {
    teamCache: async (serverId, runtime, opts) => {
      calls.push(["teamCache", serverId, opts, typeof runtime.acquireSshSlot]);
      return { serverId: "server-01", best: { codex: "0.160.1", claude: null } };
    },
    startPublish: async (cli, opts) => {
      calls.push(["startPublish", cli, opts]);
      if (cli === "claude") throw Object.assign(new Error("只有团队管理员能发布"), { status: 403, code: "forbidden" });
      return { jobId: "cli-pub", job: { action: "publish" } };
    },
    smokeTest: async (cli, opts) => {
      calls.push(["smokeTest", cli, opts]);
      return { ok: true, code: "ok" };
    },
  };
  const route = createCliRoutes({ cliService, scheduler: { acquireSshSlot: async () => () => {} } });
  assert.equal((await call(route, "GET", "/api/cli/team-cache?serverId=server-01&force=1")).body.best.codex, "0.160.1");
  assert.equal((await call(route, "GET", "/api/cli/team-cache?serverId=bad%20id")).status, 400);
  const pub = await call(route, "POST", "/api/cli/codex/publish", { serverId: "server-01" });
  assert.deepEqual([pub.status, pub.body.jobId], [202, "cli-pub"]);
  const denied = await call(route, "POST", "/api/cli/claude/publish", {});
  assert.deepEqual([denied.status, denied.body.code], [403, "forbidden"]);
  assert.deepEqual((await call(route, "POST", "/api/cli/codex/smoke-test", {})).body, { ok: true, code: "ok" });
  assert.deepEqual(calls, [
    ["teamCache", "server-01", { force: true }, "function"],
    ["startPublish", "codex", { serverId: "server-01" }],
    ["startPublish", "claude", { serverId: null }],
    ["smokeTest", "codex", { serverId: null }],
  ]);
  const old = createCliRoutes({ cliService: { overview: async () => ({}) } });
  assert.equal((await call(old, "GET", "/api/cli/team-cache")).status, 503);
  assert.equal((await call(old, "POST", "/api/cli/codex/smoke-test", {})).status, 503);
});
