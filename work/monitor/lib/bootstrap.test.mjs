import { test } from "node:test";
import assert from "node:assert/strict";

import { createBootstrapRunner } from "./bootstrap-steps.mjs";
import { createLogger, queryLogs } from "./logger.mjs";

function fakeConfig() {
  return {
    activeServerId: "server-01",
    servers: [
      { id: "server-01", host: "myserver", remotePort: 7891, name: "主集群" },
    ],
    agents: [{ id: "codex", command: "codex" }],
  };
}

function nullLogger() {
  return { info() {}, warn() {}, error() {} };
}

// build-tarball（本地构建离线包）依赖 bash，win32 上按平台门控禁用（门控本身见 console-ux.test.mjs）。
// 借它测 runner 状态机的用例显式按 POSIX 平台构造，结果不随宿主平台变化。
const POSIX_PLATFORM = "linux";

test("初始 state 为 7 步全 pending 且带可复制命令", () => {
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "" }),
    logger: nullLogger(),
    acquireSshSlot: async () => () => {},
  });
  const { steps } = runner.getState();
  assert.equal(steps.length, 7);
  assert.ok(
    steps.every(
      (s) => s.status === "pending" && typeof s.copyCommand === "string" && s.copyCommand.length > 0,
    ),
  );
  // 固定 7 个 id 顺序
  assert.deepEqual(
    steps.map((s) => s.id),
    ["detect-arch", "build-tarball", "upload", "remote-install", "path-check", "version-verify", "login-verify"],
  );
  // copyCommand 应插值活跃 server 主机名
  const upload = steps.find((s) => s.id === "upload");
  assert.ok(upload.copyCommand.includes("myserver"));
});

test("login-verify：doctor 带活跃服务器的隧道代理运行，避免 reachability 直连外网误报失败", () => {
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "" }),
    logger: nullLogger(),
    acquireSshSlot: async () => () => {},
  });
  const step = runner.getState().steps.find((s) => s.id === "login-verify");
  assert.match(step.copyCommand, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7891 .*codex doctor --summary --ascii/);
});

test("runStep 成功流转 running -> success 且释放 ssh 槽位", async () => {
  let released = false;
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "x86_64\n" }),
    logger: nullLogger(),
    acquireSshSlot: async () => () => {
      released = true;
    },
  });
  await runner.runStep("detect-arch");
  const step = runner.getState().steps.find((s) => s.id === "detect-arch");
  assert.equal(step.status, "success");
  assert.ok(step.summary.includes("x86_64"));
  assert.ok(step.finishedAt > 0);
  assert.equal(released, true, "远端步骤结束必须释放槽位");
});

test("命令失败 -> fail 并保留摘要；重跑同一步骤在 running 中被拒", async () => {
  let rejectGate;
  const gate = new Promise((_, reject) => {
    rejectGate = reject;
  });
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    // build-tarball 为纯本地步骤，execFileImpl 悬挂直到我们手动 reject。
    execFileImpl: () => gate,
    logger: nullLogger(),
    acquireSshSlot: async () => () => {},
    platform: POSIX_PLATFORM,
  });

  // 第一次调用：同步置 running，返回的 promise 待步骤结束才 resolve。
  const first = runner.runStep("build-tarball");
  const running = runner.getState().steps.find((s) => s.id === "build-tarball");
  assert.equal(running.status, "running");

  // running 期间二次 runStep 被拒。
  const second = await runner.runStep("build-tarball");
  assert.equal(second.started, false);
  assert.ok(second.reason && second.reason.length > 0);

  // 触发命令失败。
  rejectGate(new Error("boom disk full"));
  await first;

  const step = runner.getState().steps.find((s) => s.id === "build-tarball");
  assert.equal(step.status, "fail");
  assert.ok(step.summary.includes("boom"), "失败摘要应保留错误信息");
});

test("copyCommand 粘贴安全：远端 ssh payload 单引号包裹，payload 内无单引号", () => {
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "" }),
    logger: nullLogger(),
    acquireSshSlot: async () => () => {},
  });
  const { steps } = runner.getState();

  // upload 用 scp（无内联 payload），其余远端步骤均经由 ssh 携带 payload。
  const sshSteps = steps.filter((s) => s.kind === "remote" && s.id !== "upload");
  assert.ok(sshSteps.length >= 1);
  for (const s of sshSteps) {
    // ssh 之后的 payload 必须以单引号段收尾——粘贴时不会本地展开 $HOME/$PATH、
    // 不会本地断行于 && / ;、外层引号不会被 payload 内双引号提前闭合。
    assert.match(
      s.copyCommand,
      /ssh .* '[^']*'$/,
      `${s.id} copyCommand 应以单引号包裹的远端 payload 收尾: ${s.copyCommand}`,
    );
    // 守卫未来编辑：任何步骤的 copyCommand 都不得含未转义的裸双引号包裹（旧的破损写法）。
    assert.ok(
      !/ssh .* "[^"]*"$/.test(s.copyCommand),
      `${s.id} copyCommand 不应用裸双引号包裹 payload: ${s.copyCommand}`,
    );
  }

  // 守卫：所有 copyCommand 内不得出现单引号以外用途的单引号（payload 本身无单引号，
  // 否则单引号包裹会被 payload 内的单引号提前闭合）。逐命令统计单引号成对出现。
  for (const s of steps) {
    const singleQuotes = (s.copyCommand.match(/'/g) || []).length;
    assert.equal(
      singleQuotes % 2,
      0,
      `${s.id} copyCommand 单引号应成对（payload 内不得含单引号）: ${s.copyCommand}`,
    );
  }

  // 关键：含 $HOME/$PATH 的步骤，其 $ 必须落在单引号内（否则粘贴即本地展开）。
  const versionVerify = steps.find((s) => s.id === "version-verify");
  assert.match(versionVerify.copyCommand, /'[^']*\$HOME[^']*\$PATH[^']*'/);
});

test("本地步骤 build-tarball 绝不占用 ssh 槽位", async () => {
  let slotCalls = 0;
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "Created dist/pkg.tar.gz\n" }),
    logger: nullLogger(),
    acquireSshSlot: async () => {
      slotCalls += 1;
      return () => {};
    },
    platform: POSIX_PLATFORM,
  });
  await runner.runStep("build-tarball");
  const step = runner.getState().steps.find((s) => s.id === "build-tarball");
  assert.equal(step.status, "success");
  assert.equal(slotCalls, 0, "本地步骤不得调用 acquireSshSlot");
});

test("未知步骤 runStep 返回 started:false", async () => {
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "" }),
    logger: nullLogger(),
    acquireSshSlot: async () => () => {},
  });
  const res = await runner.runStep("does-not-exist");
  assert.equal(res.started, false);
});

test("runStep operation context reaches async completion logs", async () => {
  const operationId = "123e4567-e89b-42d3-a456-426614174000";
  const source = `bootstrap-operation-${Date.now()}`;
  const runner = createBootstrapRunner({
    config: fakeConfig(),
    execFileImpl: async () => ({ stdout: "Created dist/pkg.tar.gz\n" }),
    logger: createLogger(source),
    acquireSshSlot: async () => () => {},
    platform: POSIX_PLATFORM,
  });
  await runner.runStep("build-tarball", { operationId });
  const correlated = queryLogs({ source, operationId }).entries;
  assert.ok(correlated.some((entry) => entry.message.includes("成功")), "completion log must be correlated");
  assert.ok(correlated.every((entry) => entry.operationId === operationId));
});

test("bootstrap captures server credentials and applies port, user, identity and host-key policy to SSH/scp", async () => {
  const config = fakeConfig();
  Object.assign(config.servers[0], { sshPort: 2222, sshUser: "reader", sshIdentityFile: "/tmp/key with spaces", authRef: "mem:test" });
  const calls = [];
  const runner = createBootstrapRunner({ config, execFileImpl: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { stdout: "ok" }; }, logger: nullLogger(), acquireSshSlot: async () => () => {} });
  await runner.runStep("path-check");
  await runner.runStep("upload");
  assert.equal(calls[0].cmd, "ssh");
  assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(calls[0].args.includes("2222"));
  assert.ok(calls[0].args.includes("reader"));
  assert.ok(calls[0].args.includes("/tmp/key with spaces"));
  assert.equal(calls[0].options.server.authRef, "mem:test");
  assert.notEqual(calls[0].options.server, config.servers[0]);
  assert.equal(calls[1].cmd, "scp");
  assert.ok(calls[1].args.includes("-P"));
  assert.ok(calls[1].args.includes("User=reader"));
  assert.equal(calls[1].options.server.authRef, "mem:test");
});

test("bootstrap with no enabled server does not invent or contact a default host", async () => {
  const runner = createBootstrapRunner({ config: { servers: [] }, execFileImpl: async () => { assert.fail("no connection expected"); }, logger: nullLogger(), acquireSshSlot: async () => () => {} });
  await runner.runStep("path-check");
  const step = runner.getState().steps.find((item) => item.id === "path-check");
  assert.equal(step.status, "fail");
  assert.match(step.summary, /配置.*服务器/);
});
