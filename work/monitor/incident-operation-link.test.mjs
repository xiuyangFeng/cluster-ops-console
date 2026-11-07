// 「查看处置日志」端到端接线：处置操作受理 → 关联事件 → 按 operationId 取回日志。
//
// 装置与 server/start.mjs 同一套接线（逐项对照）：真实内核（ops/timeline 日志器 + 操作上下文）、
// 真实事件同步（incident store + 落盘）、真实通道生命周期（fixture 模式，不碰进程）、真实执行器
// （单隧道操作经控制信箱，supervisor 侧用真实信箱处理器代答）、真实 HTTP 路由（127.0.0.1 临时
// 端口）。不 spawn、不 ssh、不碰 8877/8888 与 ~/Library/Application Support。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChannelLifecycle } from "./lib/channel-lifecycle.mjs";
import { createHttpRouter } from "./lib/http-router.mjs";
import { buildThreeServerConfig } from "./lib/m1-fixtures.mjs";
import { CONTROL_ACTION_RESTART_TUNNEL, createControlMailbox } from "./lib/supervisor-control.mjs";
import { createAutoRepairRunner } from "./server/auto-repair-runner.mjs";
import { createIncidentSync } from "./server/incident-sync.mjs";
import { createKernel } from "./server/kernel.mjs";
import { createRunners, isAnyRunnerInFlight } from "./server/runners.mjs";

const TOKEN = "tok";
const INSTANCE = "abcdef1234567890";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function snapshotNow() {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE,
    pid: 12345,
    startedAt: 1,
    observedAt: Date.now(),
    configRevision: "rev-1",
    build: {},
    capabilities: { scopedTunnelRestart: true, controlProtocol: 1 },
    effectiveProxyPort: 28888,
    targets: {},
    stale: false,
  };
}

async function startStack(t) {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "incident-op-link-"));
  const kernel = createKernel({ runtimeDir });
  const getConfig = async () => buildThreeServerConfig();
  const incidentSync = await createIncidentSync({
    runtimeDir,
    appendLog: kernel.appendLog,
    configManager: { getIncidentServerLifecycle: () => null },
    openGate: {}, // 本测关注关联而非打开门槛：首次失败立即打开
  });
  // 与 start.mjs 同形：late 槽位 + 受理回调 → incidentSync.linkOperation。
  const late = { incidentSync, operationsRunner: null, dataPlaneUpgrader: null };
  const linkOperation = (operation) => late.incidentSync?.linkOperation(operation);
  const store = {
    getLayers: () => ({ channel: { level: "ok" } }),
    getLegacyStatus: () => ({ health: "ok" }),
    // 不带 fields 的 ops 日志：用来验证它继承当前操作上下文里的 operationId。
    setShouldBeRunning: (value) => kernel.appendLog(`fixture store: shouldBeRunning=${value}`),
  };
  const channel = createChannelLifecycle({
    rootDir: runtimeDir,
    paths: {
      dataRoot: runtimeDir,
      runtimeDir,
      configPath: path.join(runtimeDir, "config.json"),
      localConfigPath: path.join(runtimeDir, "config.local.json"),
    },
    fixtureMode: true,
    appendLog: kernel.appendLog,
    registry: kernel.registry,
    scheduler: { forceRun: async () => ({}), getResult: () => undefined },
    toolkit: {},
    store,
    getConfig,
    refreshConfigIntoKernel: async () => ({}),
    statImpl: async () => {
      throw new Error("ENOENT");
    },
    isBlocked: () => isAnyRunnerInFlight(late),
    onRestartAccepted: (context) => linkOperation({ operationId: context.operationId }),
  });
  const runners = createRunners({
    channel,
    getConfig,
    runtimeDir,
    registry: kernel.registry,
    fixtureMode: true,
    appendLog: kernel.appendLog,
    writeTimeline: kernel.writeTimeline,
    snapshots: { getUsableSnapshot: snapshotNow, readFresh: async () => ({ snapshot: snapshotNow(), stale: false }) },
    onOperationAccepted: linkOperation,
  });
  Object.assign(late, runners);
  const router = createHttpRouter({
    authToken: TOKEN,
    version: "0.0.0-test",
    publicDir: path.join(runtimeDir, "no-public"),
    logsDir: kernel.logsDir,
    ndjsonTailLines: 2000,
    maxSseConnections: 1,
    sseHeartbeatMs: 60000,
    store,
    scheduler: {},
    metricsStore: {},
    bootstrapRunner: {},
    toolkit: {},
    appendLog: kernel.appendLog,
    operationStorage: kernel.operationStorage,
    getConfig,
    startChannel: channel.startChannel,
    stopChannel: channel.stopChannel,
    restartChannel: channel.restartChannel,
    operationsRunner: runners.operationsRunner,
    dataPlaneUpgrader: runners.dataPlaneUpgrader,
    incidentStore: incidentSync.incidentStore,
  });
  const server = createServer((req, res) => router.handleHttpRequest(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    incidentSync.beginShutdown();
    await incidentSync.close();
    // 日志落盘是异步的：Windows 上收尾时文件可能仍被占用，rmdir 报 ENOTEMPTY（CI 间歇失败），带重试删除。
    await rm(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function api(method, url, { body, operationId } = {}) {
    const headers = { "x-auth-token": TOKEN, "content-type": "application/json" };
    if (operationId) headers["x-operation-id"] = operationId;
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  }
  const openIncident = (serverId, component, reasonCode) =>
    incidentSync.incidentStore.observe({ serverId, component, reasonCode, severity: "error" }).incidentId;
  async function relatedOps() {
    const { json } = await api("GET", "/api/incidents?state=open&limit=200");
    return Object.fromEntries(json.incidents.map((i) => [i.incidentId, i.relatedOperationIds]));
  }
  return { api, kernel, channel, runners, incidentSync, runtimeDir, openIncident, relatedOps };
}

test("单隧道重启：受理即关联该服务器的隧道/通道事件，/api/logs?operationId= 取回本次操作日志", async (t) => {
  const stack = await startStack(t);
  const tunnelA = stack.openIncident("fixture-a", "tunnel", "TUNNEL_DOWN");
  const channelA = stack.openIncident("fixture-a", "channel", "CHANNEL_ERROR");
  const agentA = stack.openIncident("fixture-a", "agent", "ACCOUNT_BANNED");
  const tunnelB = stack.openIncident("fixture-b", "tunnel", "TUNNEL_DOWN");

  const preview = await stack.api("POST", "/api/operations/preview", { body: { action: "restart-tunnel", target: { serverId: "fixture-a" } } });
  assert.equal(preview.status, 200);
  const operationId = "5b3e2a10-8c4d-4f6e-9a1b-2c3d4e5f6a7b";
  const run = await stack.api("POST", "/api/operations/run", { body: { previewId: preview.json.previewId }, operationId });
  assert.equal(run.status, 202);
  assert.equal(run.json.operationId, operationId, "operationId 就是请求的 x-operation-id");

  const ops = await stack.relatedOps();
  assert.deepEqual(ops[tunnelA], [operationId]);
  assert.deepEqual(ops[channelA], [operationId]);
  assert.deepEqual(ops[agentA], [], "账号封禁不是重启能处置的，不关联");
  assert.deepEqual(ops[tunnelB], [], "其它服务器的事件不关联");

  // supervisor 侧：真实信箱处理器认领请求并写出结果，monitor 侧查询即收尾。
  const mailbox = createControlMailbox({
    runtimeDir: stack.runtimeDir,
    instanceId: INSTANCE,
    handlers: { [CONTROL_ACTION_RESTART_TUNNEL]: async () => ({ status: "succeeded", phase: "verifying", evidence: {} }) },
  });
  await mailbox.poll();
  const done = await stack.api("GET", `/api/operations/${operationId}`);
  assert.equal(done.json.state, "succeeded");

  const logs = await stack.api("GET", `/api/logs?operationId=${operationId}`);
  assert.equal(logs.status, 200);
  const messages = logs.json.entries.map((e) => e.message);
  assert.ok(messages.some((m) => m.startsWith(`operation ${operationId} scoped-restart fixture-a queued`)), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("result=ok")), messages.join("\n"));
  assert.ok(logs.json.entries.every((e) => e.operationId === operationId));
  assert.deepEqual([...new Set(logs.json.entries.map((e) => e.source))].sort(), ["ops", "timeline"]);
});

test("手动一键修复（POST /api/restart）：关联所有服务器的隧道/通道事件；被执行器挡下（409）的不关联", async (t) => {
  const stack = await startStack(t);
  const tunnelA = stack.openIncident("fixture-a", "tunnel", "TUNNEL_DOWN");
  const tunnelB = stack.openIncident("fixture-b", "tunnel", "TUNNEL_DOWN");
  const diskA = stack.openIncident("fixture-a", "filesystem", "DISK_THRESHOLD");

  const operationId = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";
  const restart = await stack.api("POST", "/api/restart", { operationId });
  assert.equal(restart.status, 200);
  const ops = await stack.relatedOps();
  assert.deepEqual(ops[tunnelA], [operationId]);
  assert.deepEqual(ops[tunnelB], [operationId]);
  assert.deepEqual(ops[diskA], [], "磁盘事件不关联");

  const logs = await stack.api("GET", `/api/logs?operationId=${operationId}`);
  const messages = logs.json.entries.map((e) => e.message);
  for (const expected of ["stop requested", "stop completed (fixture)", "start requested", "start completed (fixture)"]) {
    assert.ok(messages.includes(expected), `缺 ${expected}: ${messages.join(" | ")}`);
  }
  assert.ok(messages.includes("fixture store: shouldBeRunning=true"), "不带 fields 的日志继承请求的操作上下文");

  // 单隧道操作在飞 → 通道重启被挡（409）：没发生的操作不能挂到事件上（否则点开是空日志）。
  const preview = await stack.api("POST", "/api/operations/preview", { body: { action: "restart-tunnel", target: { serverId: "fixture-b" } } });
  const scopedId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  await stack.api("POST", "/api/operations/run", { body: { previewId: preview.json.previewId }, operationId: scopedId });
  const rejected = await stack.api("POST", "/api/restart", { operationId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b" });
  assert.equal(rejected.status, 409);
  const after = await stack.relatedOps();
  assert.deepEqual(after[tunnelA], [operationId], "被挡下的重启不关联，也不影响已有关联");
  assert.deepEqual(after[tunnelB], [operationId, scopedId], "最近一次处置在最后");
});

test("自动修复重启：每次一个新 operationId，日志（含未显式带 fields 的行）都带上它，并关联隧道/通道事件", async (t) => {
  const stack = await startStack(t);
  const channelA = stack.openIncident("fixture-a", "channel", "CHANNEL_ERROR");
  const agentA = stack.openIncident("fixture-a", "agent", "ACCOUNT_REVOKED");
  const timeline = [];
  const runner = createAutoRepairRunner({
    policy: {
      evaluate: () => [{ kind: "restart-channel", ruleId: "channel-down-restart", reason: "通道断开 60s" }],
      markExecuted: () => {},
    },
    scheduler: { forceRun: async () => ({}) },
    channel: stack.channel,
    appendLog: stack.kernel.appendLog,
    timeline: (level, message, fields) => {
      timeline.push(fields);
      stack.kernel.writeTimeline(level, message, fields);
    },
    operationStorage: stack.kernel.operationStorage,
  });
  await runner.evaluate();

  const ops = await stack.relatedOps();
  assert.equal(ops[channelA].length, 1);
  const [operationId] = ops[channelA];
  assert.match(operationId, UUID_RE);
  assert.deepEqual(ops[agentA], [], "账号吊销不关联");
  assert.equal(timeline.at(-1).operationId, operationId);

  const logs = await stack.api("GET", `/api/logs?operationId=${operationId}`);
  const messages = logs.json.entries.map((e) => e.message);
  assert.ok(messages.includes("stop requested"));
  assert.ok(messages.includes("fixture store: shouldBeRunning=true"), "自动路径同样在操作上下文里执行");
  assert.ok(messages.includes("自动修复：重启整个通道"), "时间线收尾行归入同一操作");
  assert.ok(logs.json.entries.filter((e) => e.message === "stop requested").every((e) => e.trigger === "auto"));

  await runner.evaluate();
  const again = await stack.relatedOps();
  assert.equal(again[channelA].length, 2);
  assert.notEqual(again[channelA][1], operationId, "每次自动重启一个新 operationId");
});

test("关联尽力而为：受理回调抛错不影响重启与单隧道操作", async (t) => {
  const stack = await startStack(t);
  stack.incidentSync.incidentStore.query = () => {
    throw new Error("incident store exploded");
  };
  stack.openIncident("fixture-a", "tunnel", "TUNNEL_DOWN");
  const restart = await stack.api("POST", "/api/restart", { operationId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e" });
  assert.equal(restart.status, 200);
  const preview = await stack.api("POST", "/api/operations/preview", { body: { action: "restart-tunnel", target: { serverId: "fixture-a" } } });
  const run = await stack.api("POST", "/api/operations/run", { body: { previewId: preview.json.previewId } });
  assert.equal(run.status, 202);

  // 回调本身抛错（而不只是 store 抛错）也被生命周期 / 执行器吞掉。
  const throwing = () => {
    throw new Error("link callback exploded");
  };
  const lifecycle = createChannelLifecycle({
    rootDir: stack.runtimeDir,
    paths: { runtimeDir: stack.runtimeDir, configPath: "/nonexistent/config.json", localConfigPath: "/nonexistent/config.local.json" },
    fixtureMode: true,
    appendLog: () => {},
    store: { setShouldBeRunning: () => {} },
    statImpl: async () => {
      throw new Error("ENOENT");
    },
    onRestartAccepted: throwing,
  });
  assert.deepEqual(await lifecycle.restartChannel({ trigger: "manual", context: { operationId: "op-x" } }), { ok: true, reason: "" });
});
