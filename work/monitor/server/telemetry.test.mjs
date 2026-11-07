// 探针结果 → 指标样本 / 历史采样的分发规则。
import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "../lib/event-bus.mjs";
import { createChannelGates, recordProbeTelemetry, registerHistoryBaseline, registerRerunOnRecovery } from "./telemetry.mjs";

function harness({ tunnelUp = true, channelOk = true } = {}) {
  const samples = [];
  const history = [];
  const deps = {
    metricsStore: { addSample: (sample) => samples.push(sample) },
    historyStore: { record: (entry) => history.push(entry) },
    getTunnelUp: () => tunnelUp,
    isChannelOk: () => channelOk,
  };
  return { deps, samples, history };
}

test("agent 探针：ok/warn/error 记 probe:<id> 延迟样本，skipped 等其它 level 不记", () => {
  const h = harness();
  recordProbeTelemetry({ id: "claude-endpoint", result: { level: "warn", durationMs: 12, data: { latencyMs: 80 } } }, h.deps);
  recordProbeTelemetry({ id: "doctor", result: { level: "skipped" } }, h.deps);
  assert.deepEqual(h.samples, [{
    serverId: "probe:claude-endpoint",
    kind: "probe",
    tunnelUp: true,
    probeDurationMs: 12,
    level: "warn",
    ok: false,
    latencyMs: 80,
  }]);
  assert.deepEqual(h.history, []);
});

test("validation:<id>：只有 remoteProxyTest 通过才记代理延迟样本", () => {
  const h = harness({ tunnelUp: false });
  recordProbeTelemetry({ id: "validation:server-02", result: { level: "ok", durationMs: 30, data: { items: [{ key: "remoteProxyTest", ok: true, durationMs: 7 }] } } }, h.deps);
  recordProbeTelemetry({ id: "validation:server-02", result: { level: "error", data: { items: [{ key: "remoteProxyTest", ok: false }] } } }, h.deps);
  assert.deepEqual(h.samples, [{
    serverId: "server-02", kind: "validation", cpu: 0, ram: 0, disk: 0, tunnelUp: false, probeDurationMs: 30, proxyLatencyMs: 7,
  }]);
});

test("collect:slow:<id>：负载样本进 metrics，同时旁路一条 history 采样；缺 usage 时新口径字段为 null", () => {
  const h = harness({ channelOk: false });
  recordProbeTelemetry({ id: "collect:slow:server-01", result: { level: "ok", durationMs: 5, data: { load: { cpu: 1, ram: 2, disk: 3 } } } }, h.deps);
  recordProbeTelemetry({
    id: "collect:slow:server-02",
    result: { level: "ok", durationMs: 6, data: { load: { cpu: 4, ram: 5, disk: 6 }, usage: { schemaVersion: 2, cpu: { busyPct: 40, loadNormalizedPct: 50 } } } },
  }, h.deps);
  // 非 ok / 无 load / 非采集探针一律不记。
  recordProbeTelemetry({ id: "collect:slow:server-01", result: { level: "error", data: { load: { cpu: 1 } } } }, h.deps);
  recordProbeTelemetry({ id: "log-signals", result: { level: "ok", data: { load: { cpu: 1 } } } }, h.deps);
  assert.deepEqual(h.samples.map((s) => [s.serverId, s.cpuBusyPct, s.metricSchemaVersion]), [
    ["server-01", null, null],
    ["server-02", 40, 2],
  ]);
  assert.deepEqual(h.history.map((e) => [e.type, e.key, e.channelOk, e.loadNormalizedPct]), [
    ["sample", "server-01", false, null],
    ["sample", "server-02", false, 50],
  ]);
});

test("createChannelGates：tunnelUp 与熔断门（tunnelUp && remotePortOpen）", () => {
  let detail = { tunnelUp: true, remotePortOpen: false };
  const gates = createChannelGates({ getLayers: () => ({ channel: { detail } }) });
  assert.equal(gates.getTunnelUp(), true);
  assert.equal(gates.isChannelOk(), false);
  detail = { tunnelUp: true, remotePortOpen: true };
  assert.equal(gates.isChannelOk(), true);
});

test("registerRerunOnRecovery：通道进入 ok 时补跑 doctor + 全部门控跳过的探针（去重），其它变迁不动", () => {
  const forced = [];
  let gateSkipped = ["doctor", "endpoint", "validation:server-01"];
  // 只开 codex 的配置（claude-code 模块关着、探针没注册）。
  const scheduler = {
    isRegistered: (id) => id !== "claude-code",
    listGateSkipped: () => gateSkipped,
    forceRun: (id) => {
      forced.push(id);
      return id === "validation:server-01" ? Promise.reject(new Error("未注册的探针")) : Promise.resolve({ level: "ok" });
    },
  };
  const off = registerRerunOnRecovery({ scheduler });
  try {
    const emitChanged = (...transitions) => bus.emit(EVENTS.STATUS_CHANGED, { transitions });
    emitChanged({ key: "channel", from: "waiting", to: "error" }, { key: "agent:codex", from: "skipped", to: "ok" });
    assert.deepEqual(forced, [], "非通道恢复的变迁不触发补跑");

    emitChanged({ key: "channel", from: "waiting", to: "ok" });
    assert.deepEqual(forced, ["doctor", "endpoint", "validation:server-01"], "doctor 照旧插队且不重复");

    forced.length = 0;
    gateSkipped = [];
    emitChanged({ key: "channel", from: "error", to: "ok" });
    assert.deepEqual(forced, ["doctor"], "没有被跳过的探针时只补 doctor（v2.16 语义）");
  } finally {
    off();
  }
  forced.length = 0;
  bus.emit(EVENTS.STATUS_CHANGED, { transitions: [{ key: "channel", from: "error", to: "ok" }] });
  assert.deepEqual(forced, [], "注销后不再响应");
});

test("registerRerunOnRecovery：codex 模块关闭（doctor 未注册）时不补跑 doctor，被跳过的探针照常补跑", () => {
  const forced = [];
  const registered = new Set(["reclaude", "claude-endpoint"]);
  const scheduler = {
    isRegistered: (id) => registered.has(id),
    listGateSkipped: () => ["reclaude"],
    forceRun: (id) => {
      forced.push(id);
      return Promise.resolve({ level: "ok" });
    },
  };
  const off = registerRerunOnRecovery({ scheduler });
  try {
    bus.emit(EVENTS.STATUS_CHANGED, { transitions: [{ key: "channel", from: "error", to: "ok" }] });
    assert.deepEqual(forced, ["reclaude"]);
    registered.add("doctor");
    forced.length = 0;
    bus.emit(EVENTS.STATUS_CHANGED, { transitions: [{ key: "channel", from: "error", to: "ok" }] });
    assert.deepEqual(forced, ["doctor", "reclaude"], "重新打开后恢复补跑 doctor");
  } finally {
    off();
  }
});

// v2.57 评审后续：claude-code 探针与 doctor 同一套自适应节奏（稳态 5 分钟），通道恢复时同样要插队。
test("registerRerunOnRecovery：claude-code 已注册时与 doctor 一起插队——哪怕它没被熔断跳过（降频期间一轮都没到期）", () => {
  const forced = [];
  const registered = new Set(["doctor", "endpoint", "claude-code"]);
  const scheduler = {
    isRegistered: (id) => registered.has(id),
    // 通道断了又很快恢复：只有 90 秒一轮的 endpoint 到期过、被熔断跳过；doctor 与 claude-code 都在 5 分钟窗口里
    listGateSkipped: () => ["endpoint"],
    forceRun: (id) => {
      forced.push(id);
      return Promise.resolve({ level: "ok" });
    },
  };
  const off = registerRerunOnRecovery({ scheduler });
  try {
    bus.emit(EVENTS.STATUS_CHANGED, { transitions: [{ key: "channel", from: "error", to: "ok" }] });
    assert.deepEqual(forced, ["doctor", "claude-code", "endpoint"]);
    registered.delete("doctor");
    forced.length = 0;
    bus.emit(EVENTS.STATUS_CHANGED, { transitions: [{ key: "channel", from: "error", to: "ok" }] });
    assert.deepEqual(forced, ["claude-code", "endpoint"], "只开 Claude Code 的配置：照常补跑 claude-code");
  } finally {
    off();
  }
});

test("recordProbeTelemetry：agent 探针由注册表派生（含 zcode），非 agent 探针不写 probe 样本", () => {
  const samples = [];
  const deps = { metricsStore: { addSample: (s) => samples.push(s) }, historyStore: { record() {} }, getTunnelUp: () => true, isChannelOk: () => true };
  recordProbeTelemetry({ id: "zcode-status", result: { level: "ok", durationMs: 5, data: {} } }, deps);
  recordProbeTelemetry({ id: "doctor", result: { level: "error", durationMs: 7, data: null } }, deps);
  recordProbeTelemetry({ id: "processes", result: { level: "ok", durationMs: 1, data: {} } }, deps);
  assert.deepEqual(samples.map((s) => [s.serverId, s.kind, s.level]), [["probe:zcode-status", "probe", "ok"], ["probe:doctor", "probe", "error"]]);
});

test("registerHistoryBaseline：挂载即落启动基线，视角切换（LEVELS_REBASED）另记一份；注销后不再记", () => {
  const calls = [];
  let provider = null;
  const historyStore = {
    setBaselineProvider: (fn) => { provider = fn; },
    checkpoint: () => { calls.push(["checkpoint"]); return true; },
    recordBaseline: (arg) => { calls.push(["baseline", arg]); return true; },
  };
  let snapshot = () => ({ view: "server-01", levels: { channel: "ok" } });
  const off = registerHistoryBaseline({ historyStore, getLevelSnapshot: () => snapshot(), checkMs: 3_600_000 });
  try {
    assert.deepEqual(calls, [["checkpoint"]]);
    assert.deepEqual(provider(), { view: "server-01", levels: { channel: "ok" } });
    snapshot = () => { throw new Error("store gone"); };
    assert.equal(provider(), null, "取快照抛错时给 null，不让异常冒进历史写入路径");
    bus.emit(EVENTS.LEVELS_REBASED, { view: "server-02", levels: { channel: "warn", "tunnel:server-01": "ok" } });
    assert.deepEqual(calls[1], ["baseline", { cause: "view", view: "server-02", levels: { channel: "warn", "tunnel:server-01": "ok" } }]);
  } finally {
    off();
  }
  bus.emit(EVENTS.LEVELS_REBASED, { view: "server-01", levels: { channel: "ok" } });
  assert.equal(calls.length, 2);
  assert.equal(provider, null);
});

test("资源样本带每卡 GPU 利用率（按卡序）；没有 GPU 的机器不带", () => {
  const h = harness();
  const load = { cpu: 10, ram: 20, disk: 30 };
  recordProbeTelemetry({ id: "collect:slow:server-01", result: { level: "ok", durationMs: 900, data: { load, gpu: [{ index: 0, util: 97 }, { index: 1, util: null }, { index: 2, util: 3 }] } } }, h.deps);
  recordProbeTelemetry({ id: "collect:slow:server-aliyun", result: { level: "ok", durationMs: 400, data: { load, gpu: [] } } }, h.deps);
  assert.deepEqual(h.samples[0].gpuUtil, [97, null, 3]);
  assert.deepEqual(h.samples[1].gpuUtil, []);
});

test("资源样本带直连节点（node04）的各卡利用率；不可达 / 非直连 / 没有 GPU 的节点不带", () => {
  const h = harness();
  const load = { cpu: 10, ram: 20, disk: 30 };
  const slurm = {
    nodes: [
      { name: "master", source: "slurm", gpus: { total: 4, used: 4 } },
      { name: "node04", source: "direct", reachable: true, gpus: { total: 2, cards: [{ index: 0, util: 0 }, { index: 1, util: 88 }] } },
      { name: "node09", source: "direct", reachable: false, gpus: null },
      { name: "node08", source: "direct", reachable: true, gpus: null },
    ],
  };
  recordProbeTelemetry({ id: "collect:slow:server-01", result: { level: "ok", durationMs: 900, data: { load, gpu: [], slurm } } }, h.deps);
  recordProbeTelemetry({ id: "collect:slow:server-aliyun", result: { level: "ok", durationMs: 400, data: { load, slurm: null } } }, h.deps);
  assert.deepEqual(h.samples[0].nodeGpuUtil, { node04: [0, 88] });
  assert.equal(h.samples[1].nodeGpuUtil, null);
});
