// jobs:<serverId> 探针的注册规格，以及它的结果不渗入判级 / 事件 / 指标（与 usage:<id> 同等待遇）。
import assert from "node:assert/strict";
import test from "node:test";

import { recordProbeTelemetry } from "../../server/telemetry.mjs";
import { createIncidentObservers } from "../../server/incident-sync.mjs";
import { bus, EVENTS } from "../event-bus.mjs";
import { JOBS_PREFIX, jobsProbeId, serverIdFromJobs } from "../probe-ids.mjs";
import { createChannelToolkit } from "../probes.mjs";
import { createStateStore } from "../state-store.mjs";
import { JOBS_REMOTE_SCRIPT } from "./scan.mjs";

const CONFIG = {
  activeServerId: "server-01",
  servers: [
    { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 },
    { id: "server-02", host: "other", remotePort: 7892, localPort: 8889, tunnel: false },
    { id: "server-me", host: "mine", remotePort: 7893, source: "personal" },
    { id: "server-off", host: "off", remotePort: 7894, disabled: true },
    { id: "server-mute", host: "mute", remotePort: 7895, monitorEnabled: false },
  ],
};

test("probe-ids：jobs: 前缀与反解", () => {
  assert.equal(JOBS_PREFIX, "jobs:");
  assert.equal(jobsProbeId("server-01"), "jobs:server-01");
  assert.equal(serverIdFromJobs("jobs:server-01"), "server-01");
  assert.equal(serverIdFromJobs("usage:server-01"), null);
  assert.equal(serverIdFromJobs("jobs:"), null);
});

function register({ usageStore, execFileImpl, running = () => true, modules } = {}) {
  const specs = new Map();
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => CONFIG, usageStore, execFileImpl });
  const ids = toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec) },
    servers: CONFIG.servers,
    getShouldBeRunning: running,
    modules,
  });
  return { toolkit, specs, ids };
}

test("与 usage 同一采集范围注册 jobs:<id>：团队服务器各一枚，个人 / 禁用 / 关监控不注册", () => {
  const { ids } = register({ usageStore: {} });
  assert.deepEqual(ids.filter((id) => id.startsWith("jobs:")), ["jobs:server-01", "jobs:server-02"]);
  assert.deepEqual(
    ids.filter((id) => id.startsWith("usage:")).map((id) => id.slice(6)),
    ids.filter((id) => id.startsWith("jobs:")).map((id) => id.slice(5)),
    "jobs 与 usage 的服务器集合必须一致",
  );
});

test("v2.47 模块开关：jobs 关闭不产出 jobs:*，usage 关闭不产出 usage:*；slow 采集不受影响", () => {
  const prefixed = (ids, prefix) => ids.filter((id) => id.startsWith(prefix));
  const jobsOff = register({ usageStore: {}, modules: { usage: true, jobs: false } }).ids;
  assert.deepEqual(prefixed(jobsOff, "jobs:"), []);
  assert.deepEqual(prefixed(jobsOff, "usage:"), ["usage:server-01", "usage:server-02"]);
  const usageOff = register({ usageStore: {}, modules: { usage: false, jobs: true } }).ids;
  assert.deepEqual(prefixed(usageOff, "usage:"), []);
  assert.deepEqual(prefixed(usageOff, "jobs:"), ["jobs:server-01", "jobs:server-02"]);
  const bothOff = register({ usageStore: {}, modules: { usage: false, jobs: false } }).ids;
  // cli:<id>（v2.57 官方 CLI 检测）不受数据模块开关影响：安装 / 登录入口要用它。
  assert.deepEqual(bothOff.filter((id) => !id.startsWith("cli:")), prefixed(bothOff, "collect:slow:"));
  assert.deepEqual(prefixed(bothOff, "cli:"), ["cli:server-01", "cli:server-02"], "与用量同一采集范围");
  assert.ok(bothOff.length > 0);
  assert.deepEqual(register({ usageStore: {} }).ids, register({ usageStore: {}, modules: { usage: true, jobs: true } }).ids, "缺省 = 全开");
});

// v2.49：slow 采集的 slurm 段 → 作业登记；本用户作业从队列消失 → 提前 forceRun jobs:<id>。
test("v2.49 登记接线：作业从队列消失 → forceRun jobs:<id>；jobs 模块关闭则不催", async () => {
  const slurm = (lines) => `__CT_BEGIN slurm__\nstate=ok\nuser=kai\njobreg_total=${lines.length}\n${lines.join("\n")}\n__CT_END slurm__\n`;
  for (const jobsOn of [true, false]) {
    let reply = slurm(["jobreg=500|500|N/A|train|/w|/w/o_%j.log|/w/o_%j.log|/w/run.sh"]);
    const forced = [];
    const specs = new Map();
    const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => CONFIG, usageStore: {}, execFileImpl: async () => ({ code: 0, stderr: "", stdout: reply }) });
    toolkit.registerLoadProbes({
      scheduler: { registerProbe: (spec) => specs.set(spec.id, spec), forceRun: async (id) => forced.push(id) },
      servers: CONFIG.servers,
      getShouldBeRunning: () => true,
      modules: { usage: true, jobs: jobsOn },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await specs.get("collect:slow:server-01").run();
    await settle();
    reply = slurm([]);
    await specs.get("collect:slow:server-01").run();
    await settle();
    assert.deepEqual(forced, jobsOn ? ["jobs:server-01"] : [], `jobsOn=${jobsOn}`);
  }
});

test("jobs 探针规格：5 分钟 / jobs 层 / 70s 超时（sacct + 取证 + 关注采集 + 余量）/ usesSsh / hostKey / 只看 shouldBeRunning", () => {
  let running = true;
  const { specs } = register({ usageStore: {}, running: () => running });
  const spec = specs.get("jobs:server-01");
  assert.equal(spec.layer, "jobs");
  assert.equal(spec.intervalMs, 300000);
  assert.equal(spec.timeoutMs, 70000);
  assert.equal(spec.usesSsh, true);
  assert.equal(spec.hostKey(), "myserver");
  assert.equal(spec.enabled(), true);
  running = false;
  assert.equal(spec.enabled(), false);
});

test("jobs 探针 run：经 execCollector 送脚本，结果带探针上下文，快照可从 toolkit.jobs 读到", async () => {
  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stderr: "", stdout: "now=1791014400\ntz=+0800\nuser=kai\nstate=ok\njob=1|x|RUNNING|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|Unknown|00:01:00|node01|GPU\n" };
  };
  const { specs, toolkit } = register({ usageStore: {}, execFileImpl });
  const result = await specs.get("jobs:server-01").run();
  assert.equal(result.level, "ok");
  assert.equal(result.probeContext?.serverId, "server-01");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ssh");
  assert.equal(calls[0].options.input, JOBS_REMOTE_SCRIPT);
  assert.equal(calls[0].options.server.id, "server-01");
  const snap = toolkit.jobs.getSnapshot("server-01");
  assert.equal(snap.state, "ok");
  assert.equal(snap.jobs[0].id, "1");
});

test("未接用量的装配（测试 / fixture，无 usageStore）：toolkit.jobs 存在但不注册探针", () => {
  const { ids, toolkit } = register({});
  assert.equal(ids.some((id) => id.startsWith("jobs:")), false);
  assert.equal(typeof toolkit.jobs.getSnapshot, "function");
  assert.equal(toolkit.jobs.getSnapshot("server-01"), null);
});

// ---- 结果不渗入判级 / 事件 / 指标 ----

const errorResult = () => ({ level: "error", reason: "作业查询失败", data: { state: "error" }, checkedAt: Date.now(), durationMs: 5, probeContext: { serverId: "server-01" } });

test("状态仓：jobs 结果不改任何层级、不触发 STATUS_CHANGED", () => {
  const store = createStateStore({ config: CONFIG });
  let changed = 0;
  const onChanged = () => {
    changed += 1;
  };
  bus.on(EVENTS.STATUS_CHANGED, onChanged);
  try {
    const before = JSON.stringify(store.getLayers());
    bus.emit(EVENTS.PROBE_UPDATED, { id: "jobs:server-01", layer: "jobs", result: errorResult() });
    bus.emit(EVENTS.PROBE_UPDATED, { id: "jobs:server-01", layer: "jobs", result: { ...errorResult(), level: "ok" } });
    assert.equal(JSON.stringify(store.getLayers()), before);
    assert.equal(changed, 0);
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onChanged);
    store.dispose();
  }
});

test("事件与指标：jobs 结果不产生事件事实、不写指标 / 历史样本", () => {
  const calls = [];
  const record = (name) => (payload) => calls.push({ name, ...payload });
  const observers = createIncidentObservers({
    store: {
      getLayers: () => ({ channel: { detail: {} }, tunnels: {}, agents: {} }),
      getSummary: () => ({ context: { serverId: "server-01" } }),
    },
    incidentStore: { observe: record("observe"), reportSuccess: record("reportSuccess"), reportUnknown: record("reportUnknown"), observeDiskUsage: record("observeDiskUsage") },
    getMergedConfig: () => CONFIG,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  });
  observers.onProbeUpdated({ id: "jobs:server-01", result: errorResult() });
  observers.onProbeUpdated({ id: "jobs:server-01", result: { ...errorResult(), level: "ok" } });
  assert.deepEqual(calls, []);

  const samples = [];
  const history = [];
  const deps = {
    metricsStore: { addSample: (s) => samples.push(s) },
    historyStore: { record: (e) => history.push(e) },
    getTunnelUp: () => true,
    isChannelOk: () => true,
  };
  recordProbeTelemetry({ id: "jobs:server-01", result: errorResult() }, deps);
  recordProbeTelemetry({ id: "jobs:server-01", result: { ...errorResult(), level: "ok" } }, deps);
  assert.deepEqual(samples, []);
  assert.deepEqual(history, []);
});
