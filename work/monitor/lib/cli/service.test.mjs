import assert from "node:assert/strict";
import test from "node:test";

import { createChannelToolkit } from "../probes.mjs";
import { cliProbeId, serverIdFromCli } from "../probe-ids.mjs";
import { CLI_SCAN_INTERVAL_MS, CLI_SCAN_TIMEOUT_MS, createCliService } from "./service.mjs";

// 2026-10-07 只读核实 myserver（kai）的探测输出（版本缓存命中的形态）。
const CY_OUTPUT = [
  "__CLI_BEGIN__",
  "user=kai",
  "keys.env=",
  "codex.installed=1",
  "codex.command=/public/newhome/kai/.local/bin/codex",
  "codex.path=/public/newhome/kai/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex",
  "codex.versionCached=1",
  "codex.version=codex-cli 0.159.2",
  "codex.npmGlobal=0",
  "codex.authFile=0",
  "codex.provider=cpa",
  "codex.credStore=",
  "codex.forcedLogin=",
  "codex.providerBaseUrl=https://api.relay-demo.example:9443",
  "codex.providerEnvKey=CPA_API_KEY",
  "claude.installed=1",
  "claude.command=/public/newhome/kai/.local/bin/claude",
  "claude.path=/public/newhome/kai/.local/share/claude/versions/2.1.292",
  "claude.versionCached=1",
  "claude.version=2.1.292 (Claude Code)",
  "claude.npmGlobal=0",
  "claude.oauth=1",
  "claude.subscription=max",
  "claude.settingsEnv=",
  "claude.baseUrl=",
  "claude.apiKeyHelper=0",
  "claude.reclaude=1",
  "claude.primaryApiKey=0",
  "__CLI_END__",
].join("\n");

const CONFIG = {
  activeServerId: "server-01",
  servers: [
    { id: "server-01", host: "myserver", remotePort: 7891 },
    { id: "server-me", host: "box", source: "personal" },
    { id: "server-off", host: "off", disabled: true },
  ],
};

function service({ reply = CY_OUTPUT, now = () => 1000 } = {}) {
  const calls = [];
  const replies = Array.isArray(reply) ? [...reply] : null;
  const svc = createCliService({
    getConfig: async () => CONFIG,
    dataDir: "/nonexistent-cli",
    now,
    execCollector: async (invocation, server) => {
      calls.push({ invocation, server });
      const stdout = replies ? replies.shift() : reply;
      return { code: stdout ? 0 : 255, stdout, stderr: stdout ? "" : "Connection timed out" };
    },
  });
  return { svc, calls };
}

test("probe-ids：cli: 前缀与反解", () => {
  assert.equal(cliProbeId("server-01"), "cli:server-01");
  assert.equal(serverIdFromCli("cli:server-01"), "server-01");
  assert.equal(serverIdFromCli("jobs:server-01"), null);
});

test("runScan：快照契约 { serverId, checkedAt, clis: { codex, claude } }；kai 的 codex 走中转站、Claude 由 reclaude 接管", async () => {
  const { svc, calls } = service();
  assert.equal(svc.getSnapshot("server-01"), null, "未探测过 → null");
  const result = await svc.runScan("server-01");
  assert.equal(result.level, "ok");
  assert.equal(result.reason, "codex 0.159.2，claude 2.1.292");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].invocation.args.at(-1), "env CT_CLI_IDS='codex,claude' CT_ENDPOINT_PORT='' sh -s", "全量探测不做连通性检查");
  assert.equal(calls[0].server.id, "server-01");
  const snap = svc.getSnapshot("server-01");
  assert.equal(snap.serverId, "server-01");
  assert.equal(snap.checkedAt, 1000);
  assert.deepEqual(Object.keys(snap.clis), ["codex", "claude"]);
  assert.deepEqual(snap.clis.codex, {
    installed: true,
    version: "0.159.2",
    kind: "standalone",
    path: "/public/newhome/kai/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex",
    login: "apikey",
    loginDetail: "中转站 cpa · api.relay-demo.example:9443 · 密钥变量 CPA_API_KEY",
    npmGlobal: false,
  });
  assert.equal(snap.clis.claude.login, "subscription");
  assert.equal(snap.clis.claude.managedBy, "reclaude");
  snap.clis.codex.version = "mutated";
  assert.equal(svc.getSnapshot("server-01").clis.codex.version, "0.159.2", "返回副本");
});

test("runScan：startedAt 取 SSH 发出之前的时刻，checkedAt 取结果到手的时刻", async () => {
  let clock = 1000;
  const svc = createCliService({
    getConfig: async () => CONFIG,
    dataDir: "/nonexistent-cli",
    now: () => clock,
    execCollector: async () => {
      clock += 20000; // 首次探测要各跑一次 --version，可能要十几秒
      return { code: 0, stdout: CY_OUTPUT, stderr: "" };
    },
  });
  await svc.runScan("server-01");
  const snap = svc.getSnapshot("server-01");
  assert.deepEqual([snap.startedAt, snap.checkedAt], [1000, 21000]);
});

test("runScan：SSH 失败 / 输出截断保留上一份快照；不在范围的服务器 skipped 并清快照", async () => {
  const { svc } = service({ reply: [CY_OUTPUT, "", "__CLI_BEGIN__\ncodex.installed=1\n"] });
  await svc.runScan("server-01");
  const failed = await svc.runScan("server-01");
  assert.equal(failed.level, "error");
  assert.match(failed.reason, /CLI 检测未完成/);
  assert.equal(svc.getSnapshot("server-01").clis.codex.version, "0.159.2");
  assert.equal((await svc.runScan("server-01")).level, "error", "截断（claude 段没到）也不覆盖");
  assert.equal((await svc.runScan("server-me")).level, "skipped", "个人服务器不检测");
  assert.equal((await svc.runScan("server-off")).level, "skipped");
  assert.equal((await svc.runScan("ghost")).level, "skipped");
  svc.prune([]);
  assert.equal(svc.getSnapshot("server-01"), null);
});

test("refresh：绑定了 forceRun 走调度器；没绑定或调度器拒绝时直接扫一轮", async () => {
  const { svc, calls } = service();
  assert.equal((await svc.refresh("server-01")).clis.claude.version, "2.1.292");
  assert.equal(calls.length, 1);
  const forced = [];
  svc.bindRefresh(async (serverId) => {
    forced.push(serverId);
    return svc.runScan(serverId);
  });
  await svc.refresh("server-01");
  assert.deepEqual(forced, ["server-01"]);
  svc.bindRefresh(async () => {
    throw new Error("probe not registered");
  });
  await svc.refresh("server-01");
  assert.equal(calls.length, 3);
});

test("注册：cli:<id> 与用量同一采集范围，10 分钟一轮、cli 层、走 SSH 槽位；toolkit.cli 可读快照与 forceRun 绑定", async () => {
  const specs = new Map();
  const forced = [];
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => CONFIG,
    usageStore: {},
    execFileImpl: async () => ({ code: 0, stderr: "", stdout: CY_OUTPUT }),
  });
  const ids = toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec), forceRun: async (id) => forced.push(id) },
    servers: CONFIG.servers,
    getShouldBeRunning: () => true,
    modules: { usage: false, jobs: false },
  });
  assert.deepEqual(ids.filter((id) => id.startsWith("cli:")), ["cli:server-01"], "个人 / 禁用服务器不注册；数据模块全关也照常注册");
  const spec = specs.get("cli:server-01");
  assert.equal(spec.layer, "cli");
  assert.equal(spec.intervalMs, CLI_SCAN_INTERVAL_MS);
  assert.equal(spec.intervalMs, 600000);
  assert.equal(spec.timeoutMs, CLI_SCAN_TIMEOUT_MS + 5000);
  assert.equal(spec.usesSsh, true);
  assert.equal(spec.hostKey(), "myserver");
  const result = await spec.run();
  assert.equal(result.level, "ok");
  assert.equal(toolkit.cli.getSnapshot("server-01").clis.codex.version, "0.159.2");
  await toolkit.cli.refresh("server-01");
  assert.deepEqual(forced, ["cli:server-01"]);
});

test("未接用量的装配（测试 / fixture）：toolkit.cli 存在但不注册探针", () => {
  const specs = new Map();
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => CONFIG });
  const ids = toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec), forceRun: async () => {} },
    servers: CONFIG.servers,
    getShouldBeRunning: () => true,
  });
  assert.ok(toolkit.cli);
  assert.deepEqual(ids.filter((id) => id.startsWith("cli:")), []);
});
