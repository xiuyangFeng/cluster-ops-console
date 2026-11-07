import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "../lib/event-bus.mjs";
import { PROCESSES_PROBE_ID } from "../lib/probe-ids.mjs";
import { createConfigRefresher } from "./config-refresh.mjs";
import { createProbeBackoffRuntime } from "./probe-backoff.mjs";
import { createRuntimeExtras } from "./status-extras.mjs";

const SSH_DOWN = { code: 255, stdout: "", stderr: "ssh: connect to host x port 22: Operation timed out" };
const SSH_OK = { code: 0, stdout: "__SECTION__ sys\n", stderr: "" };

function harness({ rule = true, env = {}, servers } = {}) {
  let clock = Date.UTC(2026, 9, 12, 3, 0, 0);
  const config = {
    activeServerId: "server-01",
    autoRepair: { enabled: true, observeOnly: false, ...(rule === null ? {} : { rules: { "probe-backoff": rule } }) },
    servers: servers || [
      { id: "server-01", name: "主集群", host: "cluster.example", remotePort: 7891 },
      { id: "aliyun", name: "阿里云", host: "aliyun.example", remotePort: 7892 },
      { id: "off", name: "停用", host: "off.example", disabled: true },
    ],
  };
  const logs = [];
  const runtime = createProbeBackoffRuntime({
    env,
    getMergedConfig: () => config,
    appendLog: (message, fields) => logs.push({ message, fields }),
    now: () => clock,
    rng: () => 0.5,
    networkWatcher: { check: () => null },
  });
  const server = (id) => config.servers.find((item) => item.id === id);
  return {
    runtime,
    config,
    logs,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    fail: (id = "server-01") => runtime.onSshResult({ server: server(id), result: SSH_DOWN }),
    ok: (id = "server-01") => runtime.onSshResult({ server: server(id), result: SSH_OK }),
    // 连续失败到进入退避（首次失败后每 10 秒一次）。
    enter(id = "server-01") {
      this.fail(id);
      while (!runtime.backoff.isHolding(server(id).host)) {
        clock += 10_000;
        this.fail(id);
      }
    },
  };
}

test("默认开（v2.64）：没写规则时照样进入退避；规则显式 false 或环境变量 off 时 SSH 再怎么失败也不记状态", () => {
  const byDefault = harness({ rule: null });
  byDefault.enter();
  assert.equal(byDefault.runtime.getView().enabled, true);
  assert.ok(byDefault.runtime.getView().servers["server-01"]);

  for (const off of [harness({ rule: false }), harness({ rule: null, env: { CODEX_MONITOR_PROBE_BACKOFF: "off" } })]) {
    for (let i = 0; i < 10; i += 1) {
      off.fail();
      off.advance(10_000);
    }
    assert.deepEqual(off.runtime.getView(), { enabled: false, servers: {} });
    assert.equal(off.runtime.backoff.isHolding("cluster.example"), false);
    assert.deepEqual(off.logs, []);
  }

  const viaEnv = harness({ rule: false, env: { CODEX_MONITOR_PROBE_BACKOFF: "1" } });
  viaEnv.enter();
  assert.equal(viaEnv.runtime.getView().enabled, true);
  assert.ok(viaEnv.runtime.getView().servers["server-01"]);
});

test("证据来自 SSH 执行层：连续失败过了宽限期进入退避并记一条日志；视图按服务器 id 给出起始与下次探测时刻；成功即恢复并再记一条", () => {
  const h = harness();
  const startedAt = h.now();
  h.enter();
  const view = h.runtime.getView();
  assert.deepEqual(Object.keys(view.servers), ["server-01"], "只列连不上的那台");
  assert.equal(view.servers["server-01"].since, startedAt);
  assert.equal(view.servers["server-01"].nextProbeAt, h.now() + 10_000);
  assert.equal(view.servers["server-01"].probing, false);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0].message, /^probe-backoff: cluster\.example SSH 连不上已 30 秒，周期探测改为退避（下次 \d\d:\d\d:\d\d）$/);
  assert.deepEqual(
    { level: h.logs[0].fields.level, event: h.logs[0].fields.event, phase: h.logs[0].fields.phase, host: h.logs[0].fields.host },
    { level: "warn", event: "probe-backoff", phase: "enter", host: "cluster.example" },
  );
  h.advance(45_000);
  h.ok();
  assert.deepEqual(h.runtime.getView(), { enabled: true, servers: {} });
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[1].message, /^probe-backoff: cluster\.example 恢复可达（不可达约 75 秒，期间 SSH 失败 4 次），探测回到正常节奏$/);
  assert.equal(h.logs[1].fields.phase, "recover");
});

test("说明不了问题的结果不算数：本机 spawn 失败、没有服务器条目的回调都不进状态机", () => {
  const h = harness();
  for (let i = 0; i < 6; i += 1) {
    h.runtime.onSshResult({ server: h.config.servers[0], result: { code: 1, stdout: "", stderr: "spawn ssh ENOENT" } });
    h.runtime.onSshResult({ server: null, result: SSH_DOWN });
    h.runtime.onSshResult();
    h.advance(10_000);
  }
  assert.deepEqual(h.runtime.getView().servers, {});
});

test("同一地址的两台服务器（两个账号）一起退避、各列一条；停用的服务器不列", () => {
  const h = harness({
    servers: [
      { id: "a", host: "cluster.example" },
      { id: "b", host: "cluster.example" },
      { id: "c", host: "cluster.example", disabled: true },
    ],
  });
  h.enter("a");
  assert.deepEqual(Object.keys(h.runtime.getView().servers), ["a", "b"]);
});

test("隧道快照：由断转通 → 立刻重探且阶梯从头开始；持续正常的每分钟心跳 → 各立刻探一次、阶梯不动；别的阶段与失败快照不动", () => {
  const h = harness();
  const host = "cluster.example";
  const push = () => {
    const next = h.runtime.getView().servers["server-01"].nextProbeAt;
    if (h.now() < next) h.advance(next - h.now());
    assert.equal(h.runtime.backoff.admit(host, "log-signals"), true);
    h.fail();
    h.runtime.backoff.settle(host, "log-signals");
    return h.runtime.getView().servers["server-01"].nextProbeAt - h.now();
  };
  h.enter();
  for (let i = 0; i < 4; i += 1) push();
  assert.equal(h.runtime.getView().servers["server-01"].nextProbeAt - h.now(), 120_000);

  h.runtime.onBridgeSnapshot({ stage: "local-proxy", ok: true });
  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: false, serverId: "server-01" });
  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: true, serverId: "aliyun" });
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [], "无关快照不触发");

  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: true, serverId: "server-01" });
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [host], "隧道刚建立：立刻探");
  assert.equal(push(), 10_000, "阶梯从头开始");
  for (let i = 0; i < 3; i += 1) push();

  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: true, serverId: "server-01" });
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [host], "心跳：立刻探一次");
  assert.equal(push(), 120_000, "心跳不重置阶梯");

  // 没带 serverId 的旧快照按查看中的那台算。
  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: false });
  h.runtime.onBridgeSnapshot({ stage: "ssh-tunnel", ok: true });
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [host]);
});

test("进程采样：同一条隧道 ssh 连续两拍都在才提示一次（之后同一 pid 不再提示）；换了新 pid 重新计", () => {
  const h = harness();
  const host = "cluster.example";
  const sample = (pids) => h.runtime.onProcesses({ tunnelsByServer: { "server-01": pids.map((pid) => ({ pid, command: "ssh -R" })), aliyun: [] } });
  const waiting = () => h.runtime.backoff.hostsAwaitingCanary();
  const consume = () => {
    assert.equal(h.runtime.backoff.admit(host, "log-signals"), true);
    h.fail();
    h.runtime.backoff.settle(host, "log-signals");
  };
  sample(["100"]);
  sample(["100"]); // 退避之前就稳定的 pid：记为已提示
  h.enter();
  h.advance(10_000);
  consume();
  sample(["100"]);
  assert.deepEqual(waiting(), [], "老隧道还挂着不算恢复的迹象");
  sample([]);
  sample(["200"]);
  assert.deepEqual(waiting(), [], "新隧道只出现一拍：可能还在连接");
  h.advance(5_000);
  sample(["200"]);
  assert.deepEqual(waiting(), [host], "连续两拍都在：立刻探一次");
  consume();
  h.advance(5_000);
  sample(["200"]);
  assert.deepEqual(waiting(), [], "同一 pid 只提示一次");
  // 单隧道旧形状（没有 tunnelsByServer）：按查看中的服务器归属。
  h.runtime.onProcesses({ reverseTunnel: [{ pid: "300", command: "ssh -R" }] });
  h.runtime.onProcesses({ reverseTunnel: [{ pid: "300", command: "ssh -R" }] });
  assert.deepEqual(waiting(), [host]);
  assert.doesNotThrow(() => h.runtime.onProcesses(null));
});

test("总线接线：processes 探针的结果经 attachBus 进入进程采样；注销后不再接收", () => {
  const h = harness();
  const host = "cluster.example";
  const detach = h.runtime.attachBus();
  const emit = (pid) => bus.emit(EVENTS.PROBE_UPDATED, {
    id: PROCESSES_PROBE_ID,
    layer: "channel",
    result: { level: "ok", data: { processes: { tunnelsByServer: { "server-01": [{ pid, command: "ssh" }] } } } },
  });
  try {
    h.enter();
    emit("41");
    bus.emit(EVENTS.PROBE_UPDATED, { id: "log-signals", result: { data: { processes: { tunnelsByServer: { "server-01": [{ pid: "41" }] } } } } });
    assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [], "别的探针的结果不算采样");
    emit("41");
    assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [host]);
  } finally {
    detach();
  }
  h.runtime.backoff.admit(host, "log-signals");
  h.fail();
  h.runtime.backoff.settle(host, "log-signals");
  emit("77");
  emit("77");
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), [], "注销后不再接收");
});

test("配置热载：开关改完即生效（各记一条日志）；关掉清空状态；已删除的服务器清掉，其余立刻从头再探", () => {
  const h = harness({ rule: false });
  h.fail();
  assert.equal(h.runtime.getView().enabled, false);
  h.config.autoRepair.rules["probe-backoff"] = true;
  h.runtime.onConfigRefreshed(h.config);
  assert.equal(h.runtime.getView().enabled, true);
  assert.match(h.logs.at(-1).message, /探针退避已开启/);

  h.enter();
  h.enter("aliyun");
  assert.deepEqual(Object.keys(h.runtime.getView().servers), ["server-01", "aliyun"]);
  h.config.servers = h.config.servers.filter((server) => server.id !== "aliyun");
  h.runtime.onConfigRefreshed(h.config);
  assert.deepEqual(Object.keys(h.runtime.getView().servers), ["server-01"]);
  assert.deepEqual(h.runtime.backoff.hostsAwaitingCanary(), ["cluster.example"], "配置变了：立刻再探");
  assert.match(h.logs.at(-1).message, /配置变更，1 台退避中的服务器立即重新探测/);

  h.config.autoRepair.rules["probe-backoff"] = false;
  h.runtime.onConfigRefreshed(h.config);
  assert.deepEqual(h.runtime.getView(), { enabled: false, servers: {} });
  assert.match(h.logs.at(-1).message, /探针退避已关闭/);
  assert.equal(h.runtime.backoff.isHolding("cluster.example"), false);
});

test("配置热载入口（createConfigRefresher）把新配置交给探针退避；它抛错不影响热载返回", async () => {
  const seen = [];
  const parsed = { autoRepair: {}, servers: [] };
  const late = {
    configKernel: { refreshConfigIntoKernel: async () => parsed },
    incidentSync: { syncServerLifecycle: async () => {} },
  };
  const autoRepairPolicy = { setConfig: () => {} };
  const refresh = createConfigRefresher({ late, autoRepairPolicy, probeBackoff: { onConfigRefreshed: (config) => seen.push(config) } });
  assert.equal(await refresh(), parsed);
  assert.deepEqual(seen, [parsed]);
  const broken = createConfigRefresher({ late, autoRepairPolicy, probeBackoff: { onConfigRefreshed: () => { throw new Error("boom"); } } });
  assert.equal(await broken(), parsed);
  assert.equal(await createConfigRefresher({ late, autoRepairPolicy })(), parsed, "没装配时照旧");
});

test("/api/status.probeBackoff：装配了就带视图，没装配为 null", () => {
  const h = harness();
  h.enter();
  const base = {
    rootDir: "/nonexistent",
    localConfigPath: "/nonexistent/config.local.json",
    getMergedConfig: () => h.config,
    autoRepairPolicy: { getState: () => ({ config: { enabled: true, observeOnly: false }, lastActions: [] }) },
    autoRepair: { isExhausted: () => false },
    bridge: { getTunnelPortForeign: () => [], getTunnelFailures: () => ({}) },
    scheduler: { getMetrics: () => ({}) },
  };
  const extras = createRuntimeExtras({ ...base, probeBackoff: h.runtime })();
  assert.equal(extras.probeBackoff.enabled, true);
  assert.equal(extras.probeBackoff.servers["server-01"].nextProbeAt, h.now() + 10_000);
  assert.equal(createRuntimeExtras(base)().probeBackoff, null);
});
