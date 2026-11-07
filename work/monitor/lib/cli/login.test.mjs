// 登录服务（login.mjs）：用假 ssh 子进程（伪终端输出逐块推送）+ 手动时钟驱动四种流程——链接解析、
// 授权码回写、超时 / 取消时杀转发与远端进程、端口被占、每台服务器一个任务、key 不进任务视图。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createCliInstallService } from "./install-service.mjs";
import { buildLoginSshArgs, createCliLoginService, DEFAULT_LOGIN_TIMEOUTS } from "./login.mjs";
import { createCliTaskLock } from "./task-lock.mjs";

const KEY = "sk-test-SECRET-1234567890";
const CODEX_URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc";
const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&state=xyz";

class FakeChild extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.killed = [];
    this.closed = false;
    this.stdin = { write: (d) => this.writes.push(d), on() {}, end() {} };
  }
  out(text) {
    this.stdout.emit("data", Buffer.from(text));
  }
  err(text) {
    this.stderr.emit("data", Buffer.from(text));
  }
  exit(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }
  kill(signal) {
    this.killed.push(signal);
    if (!this.closed) setImmediate(() => this.exit(null));
    return true;
  }
}

function manualClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function kindOf(command) {
  if (command.includes("ps -o args=")) return "remote-kill";
  if (command.includes("__CWB_FILE__")) return "inspect";
  if (command.includes("__CWB_HTTP__")) return "reach";
  if (command.includes("codex login status")) return "codex-status";
  if (command.includes("claude auth status")) return "claude-status";
  if (command.includes("codex login --with-api-key")) return "codex-api-key";
  if (command.includes("/keys/")) return "write-key";
  if (command.includes(".codex/config.toml")) return "write-config";
  if (command.includes(".claude/settings.json")) return "write-settings";
  if (command.includes("env.sh.tmp")) return "write-env";
  return "unknown";
}

function setup({ ports = {}, servers, responses = {}, personal = {}, taskLock } = {}) {
  const clock = manualClock();
  const children = [];
  const remoteCalls = [];
  const logs = [];
  const changed = [];
  const saved = [];
  let personalConfig = { revision: 3, ...personal };
  const config = {
    activeServerId: "server-01",
    servers: servers || [
      { id: "server-01", host: "cluster", remotePort: 7892 },
      { id: "server-02", host: "cluster2", remotePort: 7893 },
    ],
  };
  const service = createCliLoginService({
    getConfig: async () => config,
    getPersonalConfig: () => personalConfig,
    savePersonalConfig: async (patch) => {
      saved.push(patch);
      const { expectedRevision, ...rest } = patch;
      assert.equal(expectedRevision, personalConfig.revision, "乐观并发：带上刚读到的 revision");
      personalConfig = { ...personalConfig, ...rest, revision: personalConfig.revision + 1 };
    },
    runRemote: async (server, _config, command, opts = {}) => {
      const kind = kindOf(command);
      remoteCalls.push({ server: server.id, kind, command, input: opts.input });
      const r = responses[kind];
      return (typeof r === "function" ? r({ command, input: opts.input }) : r) ?? { code: 0, stdout: "", stderr: "" };
    },
    spawnSsh: (server, _config, { sshOptions, command }) => {
      const child = new FakeChild({ server: server.id, sshOptions, command });
      children.push(child);
      return child;
    },
    checkLocalPort: async (_port, host) => ports[host] ?? "free",
    onLoginChanged: (info) => changed.push(info),
    log: (line) => logs.push(line),
    // 两道超时（拿链接 / 整体）不覆盖，用的就是生产默认值。
    timeouts: { exitGraceMs: 5_000, killGraceMs: 2_000 },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    sleep: async () => {},
    ...(taskLock ? { taskLock } : {}),
  });
  return { service, clock, children, remoteCalls, logs, changed, saved, getPersonal: () => personalConfig };
}

const INSPECT_OK = { code: 0, stdout: `__CWB_ENV__=1\n__CWB_CLI__=1\n__CWB_FILE__=${b64('model = "gpt-5"\n')}\n`, stderr: "" };

async function waitState(service, jobId, predicate, rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    const job = service.get(jobId);
    if (predicate(job)) return job;
    await flush(2);
  }
  return service.get(jobId);
}

test("会话 ssh 参数：去掉连接复用（-L 不会留在常驻 master 上）、BatchMode、选项在主机名之前", () => {
  const pinned = ["-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/cm-x-%C", "-o", "ControlPersist=5m", "-o", "StrictHostKeyChecking=yes", "-l", "kai", "cluster"];
  const args = buildLoginSshArgs(pinned, ["-tt", "-L", "127.0.0.1:1455:127.0.0.1:1455"], "sh -c 'x'");
  assert.deepEqual(args, ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "BatchMode=yes", "-tt", "-L", "127.0.0.1:1455:127.0.0.1:1455", "-o", "StrictHostKeyChecking=yes", "-l", "kai", "cluster", "sh -c 'x'"]);
});

test("Codex 账号：本机 v4+v6 转发 → 解析授权链接 → 成功 → 核对状态 → 释放锁并触发探针补跑", async () => {
  const { service, children, remoteCalls, changed } = setup({
    responses: { inspect: INSPECT_OK, "codex-status": { code: 0, stdout: "Logged in using ChatGPT\n__CWB_EXIT__=0\n", stderr: "" } },
  });
  const started = await service.start("codex", { method: "account" });
  assert.equal(started.state, "running");
  await flush();
  const child = children[0];
  assert.deepEqual(child.args.sshOptions.filter((_, i, a) => a[i - 1] === "-L"), ["127.0.0.1:1455:127.0.0.1:1455", "[::1]:1455:127.0.0.1:1455"]);
  assert.match(child.args.command, /codex login/);

  // 链接被拆成两块到达、夹着 ANSI 与 OSC 8
  child.out("__CWB_PID__=4242\r\n\x1b[2mStarting local login server on http://localhost:1455.\x1b[0m\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n\x1b]8;;");
  assert.equal(service.get(started.jobId).url, null);
  child.out(`${CODEX_URL}\x07${CODEX_URL}\x1b]8;;\x07\r\n`);
  let job = service.get(started.jobId);
  assert.equal(job.url, CODEX_URL);
  assert.equal(job.phase, "waiting-browser");
  assert.equal(job.needsCode, false);

  child.out("Successfully logged in.\r\n");
  assert.equal(service.get(started.jobId).phase, "verifying");
  child.exit(0);
  job = await waitState(service, started.jobId, (j) => j.state !== "running");
  assert.equal(job.state, "succeeded", JSON.stringify(job.error));
  assert.equal(job.status.login, "chatgpt");
  assert.deepEqual(remoteCalls.map((c) => c.kind), ["inspect", "codex-status"]);
  assert.ok(!remoteCalls.some((c) => c.kind === "remote-kill"), "CLI 自己退出：不做远端清理");
  assert.deepEqual(changed, [{ serverId: "server-01", cli: "codex" }]);
  // 锁已释放：同一台服务器可以再开
  const again = await service.start("codex", { method: "account" });
  assert.equal(again.state, "running");
});

test("Codex 账号：本机没有 IPv6 时只转发 v4；本机 1455 被占 → 不启动 ssh，给清楚提示", async () => {
  let ctx = setup({ ports: { "::1": "unavailable" } });
  await ctx.service.start("codex", { method: "account" });
  await flush();
  assert.deepEqual(ctx.children[0].args.sshOptions.filter((_, i, a) => a[i - 1] === "-L"), ["127.0.0.1:1455:127.0.0.1:1455"]);

  ctx = setup({ ports: { "127.0.0.1": "busy" } });
  const job = await ctx.service.start("codex", { method: "account" });
  const done = await waitState(ctx.service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "failed");
  assert.equal(done.error.code, "local-port-busy");
  assert.match(done.error.message, /本机 1455/);
  assert.equal(ctx.children.length, 0);
  // 失败后锁释放
  assert.equal((await ctx.service.start("claude", { method: "account" })).state, "running");
});

test("Codex 账号：集群 1455 被占（同事正在登录）→ 失败并提示稍后重试，不做远端清理", async () => {
  const { service, children, remoteCalls } = setup();
  const job = await service.start("codex", { method: "account" });
  await flush();
  children[0].out("__CWB_PORT_BUSY__\r\n");
  const done = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.error.code, "remote-port-busy");
  assert.match(done.error.message, /稍|几分钟/);
  assert.ok(children[0].killed.length > 0 || children[0].closed);
  assert.ok(!remoteCalls.some((c) => c.kind === "remote-kill"));
});

test("Codex 账号：ssh 本机转发失败（检查后被抢占）→ local-port-busy", async () => {
  const { service, children } = setup();
  const job = await service.start("codex", { method: "account" });
  await flush();
  children[0].err("bind [127.0.0.1]:1455: Address already in use\r\nCould not request local forwarding.\r\n");
  children[0].exit(255);
  const done = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.error.code, "local-port-busy");
});

test("取消：杀掉本机 ssh（连带 -L 转发）并按 pid 清理集群上的 codex login；释放锁", async () => {
  const { service, children, remoteCalls } = setup();
  const job = await service.start("codex", { method: "account" });
  await flush();
  children[0].out(`__CWB_PID__=4242\r\n${CODEX_URL}\r\n`);
  const cancelled = await service.cancel(job.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(children[0].killed, ["SIGTERM"]);
  const kill = remoteCalls.find((c) => c.kind === "remote-kill");
  assert.ok(kill, "远端清理");
  assert.match(kill.command, /-p 4242/);
  assert.match(kill.command, /grep -q '\\''codex'\\''/);
  assert.equal((await service.start("codex", { method: "account" })).state, "running", "锁已释放");
});

test("超时：拿不到链接（120 秒）→ 失败并清理；整体 10 分钟 → timeout 并清理", async () => {
  assert.equal(DEFAULT_LOGIN_TIMEOUTS.urlMs, 120_000, "集群上 claude 约 250MB、NFS 冷读，60 秒偏紧");
  assert.equal(DEFAULT_LOGIN_TIMEOUTS.totalMs, 600_000);
  let ctx = setup();
  let job = await ctx.service.start("claude", { method: "account" });
  await flush();
  assert.match(ctx.service.get(job.jobId).phaseText, /一两分钟/, "连接阶段的提示讲明首次启动可能要等");
  ctx.children[0].out("__CWB_PID__=77\r\nsome banner without url\r\n");
  ctx.clock.advance(60_000);
  await flush();
  assert.equal(ctx.service.get(job.jobId).state, "running", "冷启动超过 60 秒还在等，不提前放弃");
  ctx.clock.advance(60_000);
  let done = await waitState(ctx.service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "failed");
  assert.equal(done.error.code, "no-url");
  assert.match(done.error.message, /等了 120 秒没拿到授权链接/);
  assert.match(done.error.message, /再试一次/, "冷读过一遍之后第二次通常快得多");
  assert.match(done.error.message, /some banner/);
  await flush();
  assert.ok(ctx.remoteCalls.some((c) => c.kind === "remote-kill" && /-p 77/.test(c.command)));

  ctx = setup();
  job = await ctx.service.start("codex", { method: "account" });
  await flush();
  ctx.children[0].out(`__CWB_PID__=88\r\n${CODEX_URL}\r\n`);
  ctx.clock.advance(120_000);
  assert.equal(ctx.service.get(job.jobId).state, "running", "拿到链接后不触发 120 秒超时");
  ctx.clock.advance(480_000);
  done = await waitState(ctx.service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "timeout");
  await flush();
  assert.deepEqual(ctx.children[0].killed, ["SIGTERM"]);
  assert.ok(ctx.remoteCalls.some((c) => c.kind === "remote-kill" && /-p 88/.test(c.command)));
  // SIGTERM 没让进程退出时补 SIGKILL
  ctx = setup();
  job = await ctx.service.start("codex", { method: "account" });
  await flush();
  const stubborn = ctx.children[0];
  stubborn.kill = (signal) => {
    stubborn.killed.push(signal);
    return true;
  };
  const cancelling = ctx.service.cancel(job.jobId);
  await flush();
  ctx.clock.advance(2_000);
  await cancelling;
  assert.deepEqual(stubborn.killed, ["SIGTERM", "SIGKILL"]);
});

test("Claude 账号：链接 → 等授权码 → 写回伪终端（code + 回车）→ 成功；授权码不进任务视图", async () => {
  const { service, children, remoteCalls } = setup({
    responses: { "claude-status": { code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}\n', stderr: "" } },
  });
  const job = await service.start("claude", { method: "account" });
  await flush();
  assert.match(children[0].args.command, /claude auth login --claudeai/);
  assert.ok(!children[0].args.sshOptions.includes("-L"), "Claude 不需要端口转发");
  children[0].out(`__CWB_PID__=77\r\nBrowser didn't open? Use the url below to sign in:\r\n\r\n${CLAUDE_URL}\r\n\r\nPaste code here if prompted > `);
  let view = service.get(job.jobId);
  assert.equal(view.phase, "waiting-code");
  assert.equal(view.needsCode, true);
  assert.throws(() => service.submitCode(job.jobId, "has space"), (e) => e.code === "bad-code");
  const code = "AUTHCODE123#STATE456";
  view = service.submitCode(job.jobId, ` ${code} `);
  assert.equal(view.phase, "verifying");
  assert.deepEqual(children[0].writes, [`${code}\r`]);
  children[0].out(`${code}\r\nLogin successful\r\n`);
  children[0].exit(0);
  view = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(view.state, "succeeded");
  assert.equal(view.status.login, "subscription");
  assert.deepEqual(remoteCalls.map((c) => c.kind), ["claude-status"]);
  assert.ok(!JSON.stringify(view).includes(code));
});

test("Claude 账号：授权码不对 → 回到等码并提示重贴；进程退出时提示可改用长期令牌，输出尾巴里授权码被隐藏", async () => {
  const { service, children } = setup();
  const job = await service.start("claude", { method: "account" });
  await flush();
  children[0].out(`__CWB_PID__=77\r\n${CLAUDE_URL}\r\nPaste code here if prompted > `);
  service.submitCode(job.jobId, "WRONGCODE#1");
  children[0].out("WRONGCODE#1\r\nOAuth error: Invalid code\r\nPaste code here if prompted > ");
  let view = service.get(job.jobId);
  assert.equal(view.phase, "waiting-code");
  assert.equal(view.error.code, "bad-code");
  service.submitCode(job.jobId, "WRONGCODE#2");
  children[0].out("WRONGCODE#2\r\nError: failed to exchange token\r\n");
  children[0].exit(1);
  view = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(view.state, "failed");
  assert.equal(view.error.code, "bad-code");
  assert.match(view.error.message, /setup-token/);
  assert.ok(!view.error.message.includes("WRONGCODE"), view.error.message);
  assert.ok(!view.error.message.includes("state=xyz"), "链接参数隐藏");
});

// 真机（Claude Code 2.1.292，2026-10 验收）抓到的原样输出：授权码不对时 CLI 不重新询问，报错后直接退出码 1。
test("Claude 账号：授权码不对、CLI 直接退出 → bad-code，说明要重新发起登录（不是含糊的「进程退出了」）", async () => {
  const { service, children } = setup();
  const job = await service.start("claude", { method: "account" });
  await flush();
  children[0].out(`__CWB_PID__=77\r\nOpening browser to sign in…\r\nIf the browser didn't open, visit: ${CLAUDE_URL}\r\nPaste code here if prompted > `);
  service.submitCode(job.jobId, "WRONGCODE#STATE");
  children[0].out("Login failed: Request failed with status code 400\r\nConnection to 10.0.0.1 closed.\r\n");
  children[0].exit(1);
  const view = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(view.state, "failed");
  assert.equal(view.error.code, "bad-code");
  assert.match(view.error.message, /授权码没有通过.*重新发起登录/);
  assert.match(view.error.message, /status code 400/, "带上 CLI 的原话");
  assert.ok(!view.error.message.includes("WRONGCODE"), view.error.message);
});

test("Claude 账号：没提交过授权码就退出 → 仍按 exited 报（不冤枉授权码）", async () => {
  const { service, children } = setup();
  const job = await service.start("claude", { method: "account" });
  await flush();
  children[0].out(`__CWB_PID__=77\r\n${CLAUDE_URL}\r\nLogin failed: network error\r\n`);
  children[0].exit(1);
  const view = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(view.error.code, "exited");
});

test("Claude 长期令牌：取到 sk-ant-oat01 令牌 → 经标准输入写 keys/claude-oauth.env；令牌不进任务视图与日志", async () => {
  const { service, children, remoteCalls, logs } = setup({
    responses: { "claude-status": { code: 0, stdout: '{"loggedIn": true, "authMethod": "oauth_token"}\n', stderr: "" } },
  });
  const job = await service.start("claude", { method: "setup-token" });
  await flush();
  assert.match(children[0].args.command, /claude setup-token/);
  children[0].out(`__CWB_PID__=9\r\n${CLAUDE_URL}\r\nPaste code here if prompted > `);
  service.submitCode(job.jobId, "GOODCODE#1");
  const token = `sk-ant-oat01-${"Z".repeat(60)}`;
  children[0].out(`\r\nYour OAuth token (valid for 1 year):\r\n\r\n${token}\r\n\r\nStore this token securely.\r\n`);
  children[0].exit(0);
  const view = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(view.state, "succeeded", JSON.stringify(view.error));
  const write = remoteCalls.find((c) => c.kind === "write-key");
  assert.match(write.command, /keys\/claude-oauth\.env/);
  assert.equal(write.input, `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`);
  assert.ok(!write.command.includes(token));
  assert.ok(!JSON.stringify(view).includes(token));
  assert.ok(!logs.join("\n").includes(token));
});

test("每台服务器同一时刻一个任务：同服 409 busy（带在跑的 jobId），别的服务器照常；锁可与安装任务共用", async () => {
  const lock = createCliTaskLock();
  const { service } = setup();
  const first = await service.start("codex", { method: "account" });
  await assert.rejects(service.start("claude", { method: "account" }), (e) => e.code === "busy" && e.status === 409 && e.jobId === first.jobId);
  assert.equal((await service.start("claude", { method: "account", serverId: "server-02" })).state, "running");
  const release = lock.tryAcquire("s", { kind: "install", jobId: "i1" });
  assert.equal(lock.tryAcquire("s", { kind: "login" }), null);
  assert.equal(lock.current("s").kind, "install");
  release();
  assert.ok(lock.tryAcquire("s", { kind: "login" }));
});

// 安装业务层与登录服务注入同一把锁（server/start.mjs 的装配方式）：两边互斥，提示按 kind 区分。
function installServiceWith(taskLock, runJob) {
  const server = { id: "server-01", name: "集群", host: "cluster", remotePort: 7892 };
  return createCliInstallService({
    getConfig: async () => ({ servers: [server] }),
    getMainServerConfig: () => server,
    sshArgsFor: () => [server.host],
    execCollector: async () => ({ code: 0, stdout: "", stderr: "" }),
    versions: { getLatest: async () => ({ codex: { latest: "0.160.1" }, claude: { latest: "2.1.292" } }) },
    downloadDir: "/nonexistent",
    taskLock,
    runJob,
  });
}

test("共用锁：安装进行中发起登录被拒（409 busy，说明是安装）；登录进行中发起安装被拒（409，说明是登录）", async () => {
  const lock = createCliTaskLock();
  let finish;
  const runJob = (job) => new Promise((resolve) => {
    finish = () => resolve(Object.assign(job, { status: "succeeded", installedVersion: "0.160.1", finishedAt: Date.now() }));
  });
  const install = installServiceWith(lock, runJob);
  const { service } = setup({ taskLock: lock });

  // 安装 → 登录被拒
  await install.startInstall("codex", { serverId: "server-01" });
  await assert.rejects(service.start("claude", { method: "account" }), (e) => {
    assert.equal(e.code, "busy");
    assert.equal(e.status, 409);
    assert.equal(e.busy.kind, "install");
    assert.match(e.message, /codex 的安装 \/ 更新/);
    return true;
  });
  finish();
  await flush();
  assert.equal(lock.current("server-01"), null, "安装结束后释放");

  // 登录 → 安装 / 回滚被拒
  const login = await service.start("codex", { method: "account" });
  assert.equal(lock.current("server-01").kind, "login");
  assert.equal(lock.current("server-01").jobId, login.jobId);
  await assert.rejects(install.startInstall("claude", { serverId: "server-01" }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.busy.kind, "login");
    assert.match(e.message, /codex 的登录/);
    return true;
  });
  await assert.rejects(install.rollback("codex", { serverId: "server-01" }), (e) => e.status === 409 && e.busy.kind === "login");
  await service.cancel(login.jobId);
  await flush();
  assert.equal(lock.current("server-01"), null, "登录取消后释放");
});

test("密码连接的服务器：账号授权直接拒绝（不起 ssh）", async () => {
  const { service, children } = setup({ servers: [{ id: "server-01", host: "h", remotePort: 7892, authRef: "vault:abc" }] });
  const job = await service.start("codex", { method: "account" });
  const done = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.error.code, "password-server");
  assert.equal(children.length, 0);
});

test("API 任务：key 不进任务视图；中转站非 443 写进个人层白名单（乐观并发）；内网中转站写 noProxyExtra", async () => {
  const reach = { code: 0, stdout: "__CWB_HTTP__=200\n", stderr: "" };
  let ctx = setup({ responses: { inspect: INSPECT_OK, reach }, personal: { proxyAllowedTargets: ["a.example.com:8443"] } });
  let job = await ctx.service.start("codex", { method: "relay", apiKey: KEY, baseUrl: "https://relay.example.com:9443/v1" });
  assert.ok(!JSON.stringify(job).includes(KEY));
  let done = await waitState(ctx.service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.deepEqual(ctx.getPersonal().proxyAllowedTargets, ["a.example.com:8443", "relay.example.com:9443"]);
  assert.ok(!JSON.stringify(done).includes(KEY));
  assert.ok(!ctx.logs.join("\n").includes(KEY));

  ctx = setup({ responses: { inspect: INSPECT_OK, reach }, personal: { noProxyExtra: { "server-02": ["x.lab"] } } });
  job = await ctx.service.start("codex", { method: "relay", apiKey: KEY, baseUrl: "https://10.1.2.3/v1" });
  done = await waitState(ctx.service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "succeeded", JSON.stringify(done.error));
  assert.deepEqual(ctx.getPersonal().noProxyExtra, { "server-02": ["x.lab"], "server-01": ["10.1.2.3"] }, "只改这台服务器的条目");
  assert.ok(ctx.remoteCalls.some((c) => c.kind === "write-env"));
});

test("API 任务：输入不合法在占锁之前就拒绝（400），不发 SSH；http 明文未确认同样拒绝", async () => {
  const { service, remoteCalls } = setup();
  await assert.rejects(service.start("codex", { method: "api", apiKey: "x" }), (e) => e.code === "bad-key" && e.status === 400);
  await assert.rejects(service.start("claude", { method: "relay", apiKey: KEY, baseUrl: "http://r.example.com" }), (e) => e.code === "plaintext-confirm");
  await assert.rejects(service.start("codex", { method: "setup-token" }), (e) => e.code === "bad-method");
  await assert.rejects(service.start("gemini", { method: "api" }), (e) => e.code === "bad-cli");
  await assert.rejects(service.start("codex", { method: "api", apiKey: KEY, serverId: "nope" }), (e) => e.code === "no-server" && e.status === 404);
  assert.equal(remoteCalls.length, 0);
  assert.equal((await service.start("codex", { method: "account" })).state, "running", "没有残留的锁");
});

test("API 任务失败：reclaude 接管 → failed，原因说明清楚；current() 返回最近一个任务", async () => {
  const reclaude = JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: "/x/.reclaude/ca.pem" } });
  const { service } = setup({ responses: { inspect: { code: 0, stdout: `__CWB_ENV__=1\n__CWB_CLI__=1\n__CWB_FILE__=${b64(reclaude)}\n`, stderr: "" } } });
  const job = await service.start("claude", { method: "api", apiKey: KEY });
  const done = await waitState(service, job.jobId, (j) => j.state !== "running");
  assert.equal(done.state, "failed");
  assert.equal(done.error.code, "reclaude-managed");
  assert.equal(service.current("server-01").jobId, job.jobId);
  assert.equal(service.current("server-02"), null);
  await assert.rejects(service.cancel("missing"), (e) => e.code === "not-found");
});

test("服务关闭：正在进行的账号会话被强制结束", async () => {
  const { service, children } = setup();
  await service.start("codex", { method: "account" });
  await flush();
  service.dispose();
  assert.deepEqual(children[0].killed, ["SIGKILL"]);
});
