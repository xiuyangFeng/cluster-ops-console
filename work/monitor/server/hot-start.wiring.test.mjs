// 热启动（重启界面 / 热更新）的真实装配顺序回归：真 state-store + 真调度器 + 生产注册的探针
// 门控（registerProbes / registerValidationProbes 原样注册，只把 run 换成假实现）+ 通道恢复补跑监听。
// 复现的生产时序：listen → runHotStart（preserve）→ 首拍 tick：processes（本机 ps）先回、
// log-signals（SSH fast 采集，远端端口唯一来源）后回；agent/验证探针在首拍被通道熔断门跳过。
import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "../lib/event-bus.mjs";
import { createProbeScheduler } from "../lib/probe-scheduler.mjs";
import { createChannelToolkit } from "../lib/probes.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import { runHotStart } from "./hot-start.mjs";
import { createChannelGates, registerRerunOnRecovery } from "./telemetry.mjs";

const CONFIG = {
  activeServerId: "server-01",
  activeAgentId: "codex",
  agents: [
    { id: "codex", name: "Codex", kind: "codex", command: "codex" },
    { id: "claude-codewing", name: "Claude CodeWing", kind: "reclaude", command: "reclaude" },
  ],
  servers: [
    {
      id: "server-01",
      name: "主集群服务器",
      host: "myserver",
      remotePort: 7891,
      localPort: 8888,
      validationProfile: { remoteProxyTest: "curl -I https://example.com" },
    },
  ],
};

const HEALTHY_PROCESSES = {
  localProxy: [{ pid: "11", command: "node work/local_http_connect_proxy.mjs" }],
  reverseTunnel: [{ pid: "12", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" }],
  supervisor: [{ pid: "13", command: "node work/monitor/channel-supervisor.mjs" }],
};
const NO_PROCESSES = { localProxy: [], reverseTunnel: [], supervisor: [] };

// 各探针的健康结果（形状与真实探针 run 的返回一致）。
const HEALTHY_RESULTS = {
  doctor: {
    level: "ok",
    data: { ok: true, code: 0, summary: { ok: 18, fail: 0, warn: 0, notes: 0, raw: "18 ok | 0 fail" }, output: "doctor ok" },
  },
  endpoint: { level: "ok", data: { ok: true, code: 0, output: "HTTP/1.1 200 Connection Established\nHTTP/2 405" } },
  reclaude: {
    level: "ok",
    data: {
      ok: true, health: "ready", installed: true, daemonRunning: true, loggedIn: true,
      gatewayOk: true, gatewayOutput: "gateway ok", logsOutput: "", output: "reclaude ok",
    },
  },
  "claude-endpoint": { level: "ok", data: { ok: true, httpCode: 401, latencyMs: 300, output: "401 0.300" } },
  "validation:server-01": {
    level: "ok",
    reason: "已验证 1 项，失败 0 项",
    data: { items: [{ key: "remoteProxyTest", ok: true, durationMs: 120, output: "200" }] },
  },
};
const FAST_PORT_OPEN = {
  level: "ok",
  data: { signals: [], activeSignals: [], lastActivityAt: null, sourceIds: [], ports: { 7891: true }, remotePortOpen: true },
};

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function createHarness({ processes }) {
  // 时钟只由测试推进：未推进时任何"按间隔到期"的重跑都不会发生，只剩即时补跑。
  let clock = 1_790_000_000_000;
  const now = () => clock;
  let currentProcesses = processes;
  const store = createStateStore({ config: structuredClone(CONFIG), now });
  const scheduler = createProbeScheduler({ now });
  const runs = new Map();
  const pendingFast = [];
  const fakeRun = (id) => {
    if (id === "processes") return async () => ({ level: "ok", data: { processes: currentProcesses } });
    // log-signals 走 SSH，比本机 ps 慢：由测试手动放行，复现「processes 先回、端口证据后回」。
    if (id === "log-signals") return () => new Promise((resolve) => pendingFast.push(resolve));
    return async () => HEALTHY_RESULTS[id] || { level: "ok", data: null };
  };
  // 生产注册路径原样走一遍（id / 间隔 / layer / usesSsh / 熔断门控都来自真实注册），只替换 run。
  const registering = {
    ...scheduler,
    registerProbe: (spec) => scheduler.registerProbe({
      ...spec,
      run: () => {
        runs.set(spec.id, (runs.get(spec.id) || 0) + 1);
        return fakeRun(spec.id)();
      },
    }),
  };
  let shouldBeRunning = false;
  const getShouldBeRunning = () => shouldBeRunning;
  const { getTunnelUp, isChannelOk } = createChannelGates(store);
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => CONFIG });
  toolkit.registerProbes({ scheduler: registering, getShouldBeRunning, isChannelOk, getTunnelUp });
  toolkit.registerValidationProbes({
    scheduler: registering,
    servers: CONFIG.servers,
    activeServerId: "server-01",
    getShouldBeRunning,
    getChannelUp: isChannelOk,
  });

  const transitions = [];
  const onStatusChanged = ({ transitions: list }) => transitions.push(...list);
  bus.on(EVENTS.STATUS_CHANGED, onStatusChanged);
  const offRecovery = registerRerunOnRecovery({ scheduler });

  const channel = {
    setShouldBeRunning: (value) => {
      shouldBeRunning = Boolean(value);
    },
    getShouldBeRunning,
    stopChannel: async () => {},
    autoRepairChannel: async () => {},
  };
  const hotStart = () => runHotStart({
    fixtureMode: false,
    toolkit: { getProcesses: async () => processes },
    channel,
    store,
    // 不起真实 setInterval：只保留 runHotStart 自己那一拍「立即执行首轮探测」。
    scheduler: { ...scheduler, start() {} },
    appendLog() {},
  });
  const releaseFast = (result) => {
    for (const resolve of pendingFast.splice(0)) resolve(result);
  };
  const channelTransitions = () => transitions.filter((t) => t.key === "channel").map((t) => `${t.from}->${t.to}`);
  const dispose = () => {
    bus.off(EVENTS.STATUS_CHANGED, onStatusChanged);
    offRecovery();
    scheduler.stop();
    store.dispose();
    // 放行仍悬挂的 fast 采集，让调度器清掉它的超时定时器（否则进程要空等 15s）。
    releaseFast({ level: "error", reason: "disposed", error: true });
  };
  const advance = (ms) => {
    clock += ms;
  };
  const setProcesses = (next) => {
    currentProcesses = next;
  };
  return { store, scheduler, runs, transitions, hotStart, releaseFast, channelTransitions, advance, setProcesses, dispose };
}

test("热启动（数据面健康）：远端端口证据回来之前通道保持 waiting，时间线没有 waiting -> error 的假故障", async () => {
  const h = createHarness({ processes: HEALTHY_PROCESSES });
  try {
    await h.hotStart();
    await flush();
    // 本机 processes 已回、fast 采集未回：端口是「未知」不是「未开放」。
    assert.equal(h.runs.get("processes"), 1);
    assert.equal(h.store.getLayers().channel.level, "waiting");
    assert.equal(h.store.getLegacyStatus().health, "waiting", "健康总览同样保持 waiting，不报 down");
    assert.deepEqual(h.channelTransitions(), []);

    h.releaseFast(FAST_PORT_OPEN);
    await flush();
    assert.equal(h.store.getLayers().channel.level, "ok");
    assert.deepEqual(h.channelTransitions(), ["waiting->ok"], "通道直接 waiting -> ok，不经过 error");
    assert.equal(h.store.getLayers().channel.detail.downSinceMs, null);
  } finally {
    h.dispose();
  }
});

test("热启动（数据面健康）：首拍被熔断跳过的 agent / 验证探针在通道首次 ok 时立即补跑，不等下一个间隔", async () => {
  const h = createHarness({ processes: HEALTHY_PROCESSES });
  try {
    await h.hotStart();
    await flush();
    // 首拍：通道还没有任何样本，熔断门不开 → agent / 验证探针被跳过（不发 SSH）。
    for (const id of ["doctor", "endpoint", "reclaude", "claude-endpoint", "validation:server-01"]) {
      assert.equal(h.runs.get(id) ?? 0, 0, `${id} 首拍不应发起`);
      assert.equal(h.scheduler.getResult(id)?.level, "skipped", `${id} 首拍应为熔断跳过`);
    }

    h.releaseFast(FAST_PORT_OPEN);
    await flush(60);
    // 时钟冻结——这些运行只可能来自通道恢复时的即时补跑。
    for (const id of ["doctor", "endpoint", "reclaude", "claude-endpoint", "validation:server-01"]) {
      assert.equal(h.runs.get(id), 1, `${id} 应在通道 ok 时立即补跑一次`);
    }
    const layers = h.store.getLayers();
    assert.equal(layers.agents.codex.level, "ok");
    assert.equal(layers.agents["claude-codewing"].level, "ok");
    assert.equal(layers.validation["server-01"].level, "ok");
    const legacy = h.store.getLegacyStatus();
    assert.equal(legacy.health, "ready", "不再挂着熔断占位带来的假「降级」");
    assert.equal(legacy.agentsStatus.codex.degradedReason, null);
  } finally {
    h.dispose();
  }
});

test("运行中通道真断开又恢复：断开期间被熔断跳过的 agent 探针在恢复 ok 时立即补跑，不等下一个 90s 间隔", async () => {
  const h = createHarness({ processes: HEALTHY_PROCESSES });
  try {
    await h.hotStart();
    await flush();
    h.releaseFast(FAST_PORT_OPEN);
    await flush(60);
    // 先走一轮常规 90s 周期，让前置条件（agent 全绿）不依赖热启动那一拍的补跑。
    h.advance(90_000);
    h.scheduler.tick();
    await flush();
    h.releaseFast(FAST_PORT_OPEN);
    await flush(60);
    assert.equal(h.store.getLayers().agents.codex.level, "ok");

    // 隧道断开 → 下一拍 processes（5s）判通道 error；agent 探针到期时被熔断跳过（按完整 90s 排下一次）。
    h.setProcesses({ ...HEALTHY_PROCESSES, reverseTunnel: [] });
    h.advance(5_000);
    h.scheduler.tick();
    await flush();
    assert.equal(h.store.getLayers().channel.level, "error");
    h.advance(95_000); // 越过断开前各 agent 探针的下一次到期（SSH 槽位错峰后最晚的一枚）
    h.scheduler.tick();
    await flush();
    for (const id of ["endpoint", "reclaude", "claude-endpoint"]) {
      assert.equal(h.scheduler.getResult(id).level, "skipped", `${id} 断开期间应被熔断跳过`);
    }
    assert.equal(h.store.getLayers().agents.codex.level, "skipped");
    const runsBefore = new Map(h.runs);

    // 隧道回来（5s 后的 processes 拍）→ 通道 ok → 立即补跑，远早于各自 90s 的下一次。
    h.setProcesses(HEALTHY_PROCESSES);
    h.advance(5_000);
    h.scheduler.tick();
    await flush(60);
    assert.equal(h.store.getLayers().channel.level, "ok");
    for (const id of ["endpoint", "reclaude", "claude-endpoint"]) {
      assert.equal(h.runs.get(id), runsBefore.get(id) + 1, `${id} 应在通道恢复时立即补跑`);
    }
    assert.equal(h.store.getLayers().agents.codex.level, "ok");
    assert.equal(h.store.getLegacyStatus().health, "ready");
  } finally {
    h.dispose();
  }
});

test("冷启动（数据面未运行）：本地链路缺失照常立即判 error，熔断门保持关闭、不补跑 agent 探针", async () => {
  const h = createHarness({ processes: NO_PROCESSES });
  try {
    await h.hotStart();
    await flush();
    const channel = h.store.getLayers().channel;
    assert.equal(channel.level, "error", "真故障不因等待端口证据而被压成 waiting");
    assert.match(channel.reason, /本地代理未运行/);
    assert.match(channel.reason, /SSH 隧道未开启/);
    assert.deepEqual(h.channelTransitions(), ["waiting->error"]);
    assert.equal(h.store.getLegacyStatus().health, "down");
    for (const id of ["doctor", "endpoint", "reclaude", "claude-endpoint", "validation:server-01"]) {
      assert.equal(h.runs.get(id) ?? 0, 0, `${id} 在通道断开时不应发起`);
    }
  } finally {
    h.dispose();
  }
});
