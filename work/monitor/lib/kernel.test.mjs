import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { appendFile as appendFileAsync, mkdir as mkdirAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bus, EVENTS } from "./event-bus.mjs";
import { createProbeScheduler } from "./probe-scheduler.mjs";
import { createLogger, getLoggerStats, flushAllLoggers, queryLogs, parseNdjsonTail, readLogHistoryFiles, summarizeLogs, createNdjsonTailReader } from "./logger.mjs";
import { createMetricsStore, computeProbeStats } from "./metrics-store.mjs";
import { createProcessRegistry, shouldYieldToExisting } from "./process-registry.mjs";
import { createChannelToolkit } from "./probes.mjs";
import { reduceBridgeStage } from "./supervisor/bridge-stage.mjs";
import { probeProxyHealth } from "./supervisor/proxy-health.mjs";

test("proxy health probe: success/non-200/timeout expose elapsed duration", async () => {
  const success = await probeProxyHealth(8888, {
    request: (_options, onResponse) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      queueMicrotask(() => { onResponse(res); res.emit("data", "ok"); res.emit("end"); });
      return { on() {}, destroy() {} };
    },
    now: (() => { let n = 100; return () => (n += 7); })(),
  });
  assert.deepEqual(success, { ok: true, statusCode: 200, durationMs: 7 });

  const non200 = await probeProxyHealth(8888, {
    request: (_options, onResponse) => {
      const res = new EventEmitter();
      res.statusCode = 503;
      queueMicrotask(() => { onResponse(res); res.emit("data", "no"); res.emit("end"); });
      return { on() {}, destroy() {} };
    },
    now: (() => { let n = 200; return () => (n += 11); })(),
  });
  assert.equal(non200.ok, false);
  assert.equal(non200.statusCode, 503);
  assert.equal(non200.durationMs, 11);

  const timeout = probeProxyHealth(8888, {
    timeoutMs: 20,
    request: () => {
      const req = new EventEmitter();
      req.setTimeout = (_ms, fn) => queueMicrotask(fn);
      req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
      return req;
    },
    now: (() => { let n = 300; return () => (n += 20); })(),
  });
  const timed = await timeout;
  assert.equal(timed.ok, false);
  assert.equal(timed.timedOut, true);
  assert.equal(timed.durationMs, 20);
});

test("proxy health probe: absolute deadline stops dribbling and caps response bytes", async () => {
  let fireDeadline;
  let destroyed = false;
  const pending = probeProxyHealth(8888, {
    timeoutMs: 20,
    maxResponseBytes: 4,
    setTimer: (fn) => { fireDeadline = fn; return 1; },
    clearTimer: () => {},
    request: (_options, onResponse) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => { destroyed = true; };
      const res = new EventEmitter();
      res.statusCode = 200;
      queueMicrotask(() => { onResponse(res); res.emit("data", "12345"); });
      return req;
    },
    now: (() => { let n = 0; return () => (n += 20); })(),
  });
  fireDeadline();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(destroyed, true);
});

test("bridge stage reducer: failure increments, success resets and retains last success", () => {
  let state = reduceBridgeStage(undefined, { stage: "local-proxy", ok: true, durationMs: 8 }, 1000);
  assert.equal(state.lastSuccessAt, 1000);
  state = reduceBridgeStage(state, { stage: "local-proxy", ok: false, durationMs: 12 }, 2000);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.lastSuccessAt, 1000);
  state = reduceBridgeStage(state, { stage: "local-proxy", ok: true, durationMs: 5 }, 3000);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastSuccessAt, 3000);
});

test("bridge stage reducer: tunnel counters and backoff remaining are bounded snapshots", () => {
  let state = reduceBridgeStage(undefined, {
    stage: "ssh-tunnel", ok: false, durationMs: 120, reconnectDelta: 1, fastFailureDelta: 1, backoffUntil: 7000,
  }, 5000);
  assert.equal(state.reconnects, 1);
  assert.equal(state.fastFailures, 1);
  assert.equal(state.backoffRemainingMs, 2000);
  state = reduceBridgeStage(state, { stage: "ssh-tunnel", ok: true, durationMs: 40, backoffUntil: 0 }, 8000);
  assert.equal(state.reconnects, 1);
  assert.equal(state.fastFailures, 1);
  assert.equal(state.backoffRemainingMs, 0);
});

// 让已排队的微任务/已完成的探针结算跑完（不睡眠真实时间）
const flush = () => new Promise((resolve) => setImmediate(resolve));
const mkTmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// ---------------------------------------------------------------------------
// parseNdjsonTail —— /api/logs 文件尾部兜底（supervisor 等独立进程日志）
// ---------------------------------------------------------------------------

test("parseNdjsonTail: 解析、过滤、排序并按 limit 截断，跳过损坏行", () => {
  const raw = [
    JSON.stringify({ ts: 100, source: "supervisor", level: "info", message: "a" }),
    "这是一行损坏的 JSON {",
    JSON.stringify({ ts: 300, source: "supervisor", level: "error", message: "c" }),
    JSON.stringify({ ts: 200, source: "supervisor", level: "warn", message: "b" }),
    "",
  ].join("\n");

  const all = parseNdjsonTail(raw, { source: "supervisor" });
  assert.equal(all.total, 3); // 损坏行被跳过
  assert.deepEqual(all.entries.map((e) => e.message), ["a", "b", "c"]); // 时间升序

  const errOnly = parseNdjsonTail(raw, { source: "supervisor", level: "error" });
  assert.deepEqual(errOnly.entries.map((e) => e.message), ["c"]);

  const sinceFiltered = parseNdjsonTail(raw, { source: "supervisor", since: 250 });
  assert.deepEqual(sinceFiltered.entries.map((e) => e.message), ["c"]);

  const limited = parseNdjsonTail(raw, { source: "supervisor", limit: 1 });
  assert.deepEqual(limited.entries.map((e) => e.message), ["c"]); // 保留最新
  assert.equal(limited.total, 3);

  const withSnapshots = [
    JSON.stringify({ ts: 10, source: "supervisor", level: "info", message: "bridge stage snapshot", bridgeStage: { stage: "local-proxy", ok: true } }),
    JSON.stringify({ ts: 20, source: "supervisor", level: "info", message: "bridge stage snapshot", bridgeStage: { stage: "ssh-tunnel", ok: false } }),
    JSON.stringify({ ts: 30, source: "supervisor", level: "info", message: "bridge stage snapshot", bridgeStage: { stage: "ssh-tunnel", ok: true, adopted: true } }),
    JSON.stringify({ ts: 40, source: "supervisor", level: "warn", message: "[proxy] connect-fail host=api.openai.com" }),
  ].join("\n");
  const defaultView = parseNdjsonTail(withSnapshots, { source: "supervisor", hideRoutineSnapshots: true });
  assert.equal(defaultView.total, 3, "开启 hideRoutineSnapshots 时过滤常规 ok 心跳快照，保留异常/认领快照与真实事件");
  const explicitSnapshot = parseNdjsonTail(withSnapshots, { source: "supervisor", hideRoutineSnapshots: true, q: "snapshot" });
  assert.equal(explicitSnapshot.total, 3, "显式搜 snapshot 时可检出全部快照行");
});

test("parseNdjsonTail: 空/无效输入返回空结果", () => {
  assert.deepEqual(parseNdjsonTail("", {}), { entries: [], total: 0 });
  assert.deepEqual(parseNdjsonTail(null, {}), { entries: [], total: 0 });
});

test("createNdjsonTailReader: 只读新增行，文件被截断后从头恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ndjson-tail-"));
  const file = join(dir, "supervisor.ndjson");
  writeFileSync(file, '{"ts":1,"message":"one"}\n');
  const reader = createNdjsonTailReader(file, { initialTailBytes: 1024 });
  assert.match(await reader.readNew(), /"one"/);
  assert.equal(await reader.readNew(), "");
  appendFileSync(file, '{"ts":2,"message":"two"}\n');
  assert.match(await reader.readNew(), /"two"/);
  writeFileSync(file, '{"ts":3,"message":"reset"}\n');
  assert.match(await reader.readNew(), /"reset"/);
});

// ---------------------------------------------------------------------------
// event-bus
// ---------------------------------------------------------------------------

test("event-bus: 单例常量与最大监听数", () => {
  assert.equal(EVENTS.PROBE_UPDATED, "probeUpdated");
  assert.equal(EVENTS.STATUS_CHANGED, "statusChanged");
  assert.equal(EVENTS.LOG_APPENDED, "logAppended");
  assert.equal(bus.getMaxListeners(), 50);

  let received;
  bus.once(EVENTS.PROBE_UPDATED, (payload) => {
    received = payload;
  });
  bus.emit(EVENTS.PROBE_UPDATED, { id: "x", layer: "L", result: {} });
  assert.equal(received.id, "x");
});

// ---------------------------------------------------------------------------
// probe-scheduler
// ---------------------------------------------------------------------------

test("scheduler: TTL 内不重复执行", async () => {
  let clock = 0;
  const scheduler = createProbeScheduler({ now: () => clock });
  let calls = 0;
  scheduler.registerProbe({
    id: "p1",
    layer: "L1",
    intervalMs: 1000,
    timeoutMs: 5000,
    run: async () => {
      calls += 1;
      return { level: "ok" };
    },
  });

  scheduler.tick();
  await flush();
  assert.equal(calls, 1);

  clock = 500;
  scheduler.tick();
  await flush();
  assert.equal(calls, 1, "TTL 未到不应重复执行");

  clock = 1000;
  scheduler.tick();
  await flush();
  assert.equal(calls, 2, "TTL 到期应再次执行");

  scheduler.stop();
});

test("scheduler: intervalMs 支持函数——按本轮结果动态决定下次间隔（v2.16 自适应节奏）", async () => {
  let clock = 0;
  const scheduler = createProbeScheduler({ now: () => clock });
  let calls = 0;
  let level = "error";
  scheduler.registerProbe({
    id: "adaptive",
    layer: "L1",
    // 失败快节奏 1s，成功慢节奏 10s
    intervalMs: (result) => (result && result.level === "ok" ? 10000 : 1000),
    timeoutMs: 5000,
    run: async () => {
      calls += 1;
      return { level };
    },
  });

  scheduler.tick();
  await flush();
  assert.equal(calls, 1);
  assert.equal(scheduler.getResult("adaptive").nextCheckAt, 1000, "error 结果按快节奏排下一轮");

  clock = 1000;
  level = "ok";
  scheduler.tick();
  await flush();
  assert.equal(calls, 2);
  assert.equal(scheduler.getResult("adaptive").nextCheckAt, 11000, "ok 结果按慢节奏排下一轮");

  clock = 5000;
  scheduler.tick();
  await flush();
  assert.equal(calls, 2, "慢节奏窗口内不应重复执行");

  scheduler.stop();
});

test("scheduler: 探针完成会发出 PROBE_UPDATED", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  let payload;
  const handler = (p) => {
    if (p.id === "emit-probe") payload = p;
  };
  bus.on(EVENTS.PROBE_UPDATED, handler);
  scheduler.registerProbe({
    id: "emit-probe",
    layer: "network",
    intervalMs: 1000,
    timeoutMs: 5000,
    run: async () => ({ level: "ok", data: { foo: 1 } }),
  });
  await scheduler.forceRun("emit-probe");
  bus.off(EVENTS.PROBE_UPDATED, handler);

  assert.equal(payload.id, "emit-probe");
  assert.equal(payload.layer, "network");
  assert.equal(payload.result.level, "ok");
  scheduler.stop();
});

test("scheduler: enabled=false 时结果为 skipped 且不调用 run", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  let calls = 0;
  scheduler.registerProbe({
    id: "p2",
    layer: "L1",
    intervalMs: 1000,
    timeoutMs: 5000,
    enabled: () => false,
    run: async () => {
      calls += 1;
      return { level: "ok" };
    },
  });

  scheduler.tick();
  await flush();
  assert.equal(calls, 0);
  assert.equal(scheduler.getResult("p2").level, "skipped");
  scheduler.stop();
});

test("scheduler: listGateSkipped 只列最近一次被门控跳过的探针（注册序），探针自己 run 出的 skipped 不算", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  let gateOpen = false;
  const register = (id, run, enabled = () => gateOpen) => scheduler.registerProbe({ id, layer: "agents", intervalMs: 90000, timeoutMs: 5000, enabled, run });
  register("gated-a", async () => ({ level: "ok" }));
  register("self-skip", async () => ({ level: "skipped", reason: "仅监控，未启用 Agent 检查" }), () => true);
  register("gated-b", async () => ({ level: "ok" }));

  assert.deepEqual(scheduler.listGateSkipped(), [], "尚无结果");
  scheduler.tick();
  await flush();
  assert.deepEqual(scheduler.listGateSkipped(), ["gated-a", "gated-b"]);

  gateOpen = true;
  await scheduler.forceRun("gated-a");
  assert.deepEqual(scheduler.listGateSkipped(), ["gated-b"], "补跑出真实结果后即不再列出");
  scheduler.stop();
});

test("scheduler: isRegistered 只读反映在册状态（注册 / 注销 / 重注册），不改调度结果", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  const spec = { id: "doctor", layer: "agents", intervalMs: 90000, timeoutMs: 5000, run: async () => ({ level: "ok" }) };
  assert.equal(scheduler.isRegistered("doctor"), false);
  scheduler.registerProbe(spec);
  assert.equal(scheduler.isRegistered("doctor"), true);
  scheduler.tick();
  await flush();
  const before = scheduler.getResult("doctor");
  scheduler.registerProbe(spec);
  assert.equal(scheduler.getResult("doctor"), before, "重注册同 id 不清结果（下次到期时间不变）");
  scheduler.unregisterProbe("doctor");
  assert.equal(scheduler.isRegistered("doctor"), false);
  scheduler.stop();
});

test("scheduler: run 抛异常返回 error 且调度循环继续", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  let good = 0;
  scheduler.registerProbe({
    id: "bad",
    layer: "L",
    intervalMs: 1000,
    timeoutMs: 5000,
    run: async () => {
      throw new Error("boom");
    },
  });
  scheduler.registerProbe({
    id: "good",
    layer: "L",
    intervalMs: 1000,
    timeoutMs: 5000,
    run: async () => {
      good += 1;
      return { level: "ok" };
    },
  });

  const result = await scheduler.forceRun("bad");
  assert.equal(result.level, "error");
  assert.equal(result.error, true);
  assert.match(result.reason, /boom/);

  // 出错后调度循环仍应处理其它探针
  scheduler.tick();
  await flush();
  assert.equal(good, 1);
  scheduler.stop();
});

test("scheduler: 超时返回 error 且不被迟到结果覆盖", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduler = createProbeScheduler({ now: () => 0 });
  let lateResolve;
  scheduler.registerProbe({
    id: "slow",
    layer: "L",
    intervalMs: 1000,
    timeoutMs: 3000,
    run: () =>
      new Promise((resolve) => {
        lateResolve = resolve;
      }),
  });

  const pending = scheduler.forceRun("slow");
  t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(result.level, "error");
  assert.equal(result.error, true);
  assert.match(result.reason, /timeout after 3000ms/);

  // 迟到的真实结果不应覆盖已记录的超时结果
  lateResolve({ level: "ok" });
  await flush();
  assert.equal(scheduler.getResult("slow").level, "error");
  scheduler.stop();
  t.mock.timers.reset();
});

test("scheduler: usesSsh 探针并发不超过 3", async () => {
  const scheduler = createProbeScheduler({ now: () => 0, sshConcurrency: 3 });
  let calls = 0;
  const resolvers = [];
  for (let i = 0; i < 5; i += 1) {
    scheduler.registerProbe({
      id: `s${i}`,
      layer: "ssh",
      intervalMs: 1000,
      timeoutMs: 5000,
      usesSsh: true,
      run: () =>
        new Promise((resolve) => {
          calls += 1;
          resolvers.push(resolve);
        }),
    });
  }

  scheduler.tick();
  await flush();
  assert.equal(calls, 3, "同时最多 3 个 ssh 探针");

  resolvers[0]({ level: "ok" });
  await flush();
  scheduler.tick();
  await flush();
  assert.equal(calls, 4, "释放一个槽位后应再启动一个");

  // 收尾，避免悬挂的 Promise
  for (const resolve of resolvers) resolve({ level: "ok" });
  await flush();
  scheduler.stop();
});

test("scheduler: forceRun 在 in-flight 时复用同一 Promise 不双跑", async () => {
  const scheduler = createProbeScheduler({ now: () => 0 });
  let calls = 0;
  let resolveRun;
  scheduler.registerProbe({
    id: "f",
    layer: "L",
    intervalMs: 1000,
    timeoutMs: 5000,
    run: () =>
      new Promise((resolve) => {
        calls += 1;
        resolveRun = resolve;
      }),
  });

  const p1 = scheduler.forceRun("f");
  const p2 = scheduler.forceRun("f");
  assert.equal(calls, 1);
  assert.equal(p1, p2);

  resolveRun({ level: "ok" });
  await Promise.all([p1, p2]);
  scheduler.stop();
});

test("registerProbes: 注册 claude-endpoint 探针（agents 层 / 90s / usesSsh）", () => {
  const registered = new Map();
  const scheduler = { registerProbe: (p) => registered.set(p.id, p) };
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ servers: [{ id: "server-01", host: "h", remotePort: 7891, localPort: 8888 }] }),
  });
  toolkit.registerProbes({ scheduler, getShouldBeRunning: () => true, isChannelOk: () => true, getTunnelUp: () => true });
  const probe = registered.get("claude-endpoint");
  assert.ok(probe, "claude-endpoint 必须注册");
  assert.equal(probe.layer, "agents");
  assert.equal(probe.intervalMs, 90000);
  assert.equal(probe.usesSsh, true);
});

test("claude-endpoint 探针: HTTP 401 判可达并解析延迟（旧配置回落 Anthropic）", async () => {
  let capturedArgs = null;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ servers: [{ id: "server-01", host: "h", remotePort: 7891, localPort: 8888 }] }),
    execFileImpl: async (cmd, args) => {
      capturedArgs = { cmd, args };
      return { code: 0, stdout: "401 0.325", stderr: "" };
    },
  });
  const registered = new Map();
  toolkit.registerProbes({
    scheduler: { registerProbe: (p) => registered.set(p.id, p) },
    getShouldBeRunning: () => true,
    isChannelOk: () => true,
    getTunnelUp: () => true,
  });
  const result = await registered.get("claude-endpoint").run();
  assert.equal(result.level, "ok");
  assert.equal(result.data.ok, true);
  assert.equal(result.data.httpCode, 401);
  assert.equal(result.data.latencyMs, 325);
  assert.equal(capturedArgs.cmd, "ssh");
  assert.ok(capturedArgs.args.join(" ").includes("api.anthropic.com"), "必须探测 Claude API");
  // 连接复用只在非 win32 存在（buildProbeSshArgs 在 win32 剥掉 Control*），两侧都断言到位。
  assert.equal(capturedArgs.args.join(" ").includes("ControlMaster"), process.platform !== "win32", "非 win32 必须带 ControlMaster，win32 必须不带");
});

// ---------------------------------------------------------------------------
// 探针历史（v2.3）
// ---------------------------------------------------------------------------

test("metrics-store: kind=probe 样本透传 level/ok/latencyMs", () => {
  const store = createMetricsStore({});
  store.addSample({ serverId: "probe:endpoint", kind: "probe", level: "ok", ok: true, latencyMs: 210, probeDurationMs: 900 });
  const { samples } = store.query({ serverId: "probe:endpoint", kind: "probe" });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ok, true);
  assert.equal(samples[0].latencyMs, 210);
  assert.equal(samples[0].level, "ok");
});

test("metrics-store: bridge-stage 样本透传 stage counters 且沿用容量上限", () => {
  const store = createMetricsStore({ maxSamplesPerServer: 2, now: () => 99 });
  for (let i = 0; i < 3; i += 1) {
    store.addSample({
      serverId: "bridge:server-01", kind: "bridge-stage", stage: "tunnel", ok: i === 2,
      durationMs: i, consecutiveFailures: 2 - i, lastSuccessAt: 50,
      reconnects: i, fastFailures: i, backoffRemainingMs: 100 - i,
    });
  }
  const { samples } = store.query({ serverId: "bridge:server-01", kind: "bridge-stage" });
  assert.equal(samples.length, 2);
  assert.equal(samples[1].stage, "tunnel");
  assert.equal(samples[1].reconnects, 2);
  assert.equal(samples[1].backoffRemainingMs, 98);
});

test("metrics-store: bridge-stage replay preserves source ts and deduplicates restart tail", () => {
  const store = createMetricsStore({ now: () => 999 });
  const sample = { serverId: "bridge:s1", kind: "bridge-stage", ts: 123, stage: "tunnel", ok: true, durationMs: 5 };
  store.addSample(sample);
  store.addSample(sample);
  const { samples } = store.query({ serverId: "bridge:s1", kind: "bridge-stage" });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ts, 123);
});

test("computeProbeStats: 可用率与延迟统计", () => {
  const samples = [
    { ok: true, latencyMs: 100 },
    { ok: true, latencyMs: 300 },
    { ok: false, latencyMs: null },
  ];
  const stats = computeProbeStats(samples);
  assert.equal(stats.total, 3);
  assert.equal(stats.okCount, 2);
  assert.equal(stats.uptimePct, 66.7);
  assert.equal(stats.avgLatencyMs, 200);
  assert.equal(stats.maxLatencyMs, 300);
  assert.equal(computeProbeStats([]).uptimePct, null);
});

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

test("logger: ring 超 ringSize 淘汰最旧", () => {
  const logger = createLogger("ring-test", { ringSize: 3 });
  for (let i = 0; i < 5; i += 1) logger.info(`m${i}`);

  const { entries, total } = queryLogs({ source: "ring-test" });
  assert.equal(entries.length, 3);
  assert.equal(total, 3);
  assert.deepEqual(
    entries.map((e) => e.message),
    ["m2", "m3", "m4"],
  );
});

test("logger: queryLogs 按 source/level/since 过滤", () => {
  const logger = createLogger("filter-test", {});
  logger.info("i1", { a: 1 });
  logger.warn("w1");
  logger.error("e1");

  const warns = queryLogs({ source: "filter-test", level: "warn" });
  assert.equal(warns.entries.length, 1);
  assert.equal(warns.entries[0].message, "w1");

  const all = queryLogs({ source: "filter-test" });
  assert.equal(all.total, 3);
  assert.equal(all.entries[0].a, 1, "附加 fields 应展开进条目");

  assert.equal(
    queryLogs({ source: "filter-test", since: Date.now() + 100000 }).entries.length,
    0,
  );
  assert.equal(queryLogs({ source: "filter-test", since: 0 }).entries.length, 3);

  // 别的 source 不应混入
  createLogger("other-source", {}).info("ignored");
  assert.equal(queryLogs({ source: "filter-test" }).total, 3);
});

test("logger: redacts before ring, disk, and event publication", async () => {
  const dir = mkTmp("logger-redact-");
  let published;
  bus.once(EVENTS.LOG_APPENDED, (entry) => { published = entry; });
  const logger = createLogger("redact-test", { dir });
  logger.info("Authorization: Bearer top-secret", {
    operationId: "123e4567-e89b-42d3-a456-426614174000",
    headers: { authorization: "Bearer disk-secret" },
  });
  await logger.flush();
  const ringEntry = queryLogs({ source: "redact-test" }).entries[0];
  const disk = readFileSync(join(dir, "redact-test.ndjson"), "utf8");
  assert.doesNotMatch(JSON.stringify(ringEntry), /top-secret|disk-secret/);
  assert.doesNotMatch(JSON.stringify(published), /top-secret|disk-secret/);
  assert.doesNotMatch(disk, /top-secret|disk-secret/);
});

test("logger: operationId filter correlates ring and NDJSON entries", () => {
  const wanted = "123e4567-e89b-42d3-a456-426614174000";
  const other = "123e4567-e89b-42d3-a456-426614174001";
  const logger = createLogger("operation-filter-test");
  logger.info("wanted", { operationId: wanted });
  logger.info("other", { operationId: other });
  assert.deepEqual(queryLogs({ source: "operation-filter-test", operationId: wanted }).entries.map((e) => e.message), ["wanted"]);
  const raw = [
    JSON.stringify({ ts: 1, source: "disk", level: "info", message: "wanted", operationId: wanted }),
    JSON.stringify({ ts: 2, source: "disk", level: "info", message: "other", operationId: other }),
  ].join("\n");
  assert.deepEqual(parseNdjsonTail(raw, { operationId: wanted }).entries.map((e) => e.message), ["wanted"]);
});

test("logger: limit 大于 500 被钳制到 500", () => {
  const logger = createLogger("limit-test", { ringSize: 600 });
  for (let i = 0; i < 520; i += 1) logger.info(`m${i}`);

  const result = queryLogs({ source: "limit-test", limit: 9999 });
  assert.equal(result.entries.length, 500);
  assert.equal(result.total, 520);
  // 返回的是最近的 500 条，且按时间升序
  assert.equal(result.entries[result.entries.length - 1].message, "m519");
});

test("logger: 每条写入发出 LOG_APPENDED", () => {
  let received;
  const handler = (entry) => {
    if (entry.source === "emit-log") received = entry;
  };
  bus.on(EVENTS.LOG_APPENDED, handler);
  createLogger("emit-log", {}).info("hello", { k: "v" });
  bus.off(EVENTS.LOG_APPENDED, handler);

  assert.equal(received.message, "hello");
  assert.equal(received.level, "info");
  assert.equal(received.k, "v");
});

test("logger: NDJSON 落盘并在超过 maxBytes 时轮转", async () => {
  const dir = mkTmp("kernel-log-");
  const logger = createLogger("disk-test", { dir, maxBytes: 1024, ringSize: 100 });
  for (let i = 0; i < 40; i += 1) logger.info("x".repeat(30));
  await logger.flush();

  assert.ok(existsSync(join(dir, "disk-test.ndjson")), "应写入 NDJSON 文件");
  assert.ok(existsSync(join(dir, "disk-test.ndjson.1")), "超限应轮转为 .1");
});

test("logger: NDJSON 轮转后当前文件保留 reset marker", async () => {
  const dir = mkTmp("kernel-log-");
  const logger = createLogger("rotate-marker", { dir, maxBytes: 1024, ringSize: 100 });
  for (let i = 0; i < 20; i += 1) logger.info("x".repeat(30));
  await logger.flush();

  const raw = readFileSync(join(dir, "rotate-marker.ndjson"), "utf8");
  const firstLine = raw.split("\n").filter(Boolean)[0];
  const marker = JSON.parse(firstLine);
  assert.equal(marker.source, "rotate-marker");
  assert.equal(marker.level, "info");
  assert.match(marker.message, /^LOG AUTO-ROTATED AT /);
  assert.equal(marker.rotated, true);
});

test("logger: 多次轮转只保留一份 .1", async () => {
  const dir = mkTmp("logger-rot-");
  const logger = createLogger("rotsrc", { dir, maxBytes: 1024 });
  for (let i = 0; i < 30; i += 1) logger.info(`msg-${i}-${"x".repeat(50)}`);
  await logger.flush();
  const files = readdirSync(dir).filter((f) => f.startsWith("rotsrc")).sort();
  assert.deepEqual(files, ["rotsrc.ndjson", "rotsrc.ndjson.1"], "不得出现 .2 及更多分卷");
});

test("logger: readLogHistoryFiles 拼接轮转文件且缺失文件安全跳过", async () => {
  // readLogHistoryFiles 已异步化（HTTP 路径上不再 readFileSync 阻塞事件循环）并带
  // (path, size, mtimeMs) 缓存 + 最小读盘间隔；对外语义不变：拼接顺序最旧轮转 → 当前，
  // 文件缺失安全跳过返回 ""。
  const dir = mkTmp("logger-hist-");
  writeFileSync(join(dir, "h.ndjson.1"), `${JSON.stringify({ ts: 1, source: "h", level: "info", message: "old" })}\n`);
  writeFileSync(join(dir, "h.ndjson"), `${JSON.stringify({ ts: 9, source: "h", level: "info", message: "new" })}\n`);
  const raw = await readLogHistoryFiles(dir, "h");
  const { entries } = parseNdjsonTail(raw, { source: "h" });
  assert.deepEqual(entries.map((e) => e.message), ["old", "new"]);
  assert.equal(await readLogHistoryFiles(dir, "nonexistent"), "");
  // 最小读盘间隔内的重复请求直接复用上次拼接结果（内容一致）。
  assert.equal(await readLogHistoryFiles(dir, "h"), raw);
});

test("logger: summarizeLogs 按窗口聚合 error/warn 与高频消息", () => {
  const logger = createLogger("sumsrc");
  logger.error("boom A");
  logger.error("boom A");
  logger.warn("slow B");
  const summary = summarizeLogs({ windows: [3600e3] });
  const win = summary.windows[0];
  assert.equal(win.bySource.sumsrc.error, 2);
  assert.equal(win.bySource.sumsrc.warn, 1);
  assert.equal(win.topMessages[0].message, "boom A");
  assert.equal(win.topMessages[0].count, 2);
});

test("logger: queryLogs 支持 q 关键词与 until 上界", () => {
  const logger = createLogger("qsrc");
  logger.info("alpha event", { code: 42 });
  logger.warn("beta failure");
  const all = queryLogs({ source: "qsrc" });
  const cutoff = all.entries[0].ts;
  assert.equal(queryLogs({ source: "qsrc", q: "BETA" }).entries.length, 1);
  assert.equal(queryLogs({ source: "qsrc", q: "42" }).entries.length, 1, "q 匹配 fields");
  assert.ok(queryLogs({ source: "qsrc", until: cutoff }).entries.every((e) => e.ts <= cutoff));
});

test("logger: defaultFields 写入每条日志并可被单次 fields 覆盖", () => {
  const logger = createLogger("ctx-test", { defaultFields: { sessionId: "abc123", channelId: "server-01" } });
  logger.info("up", { event: "tunnel-start" });
  logger.warn("retry", { channelId: "server-02" });
  const { entries } = queryLogs({ source: "ctx-test" });
  assert.equal(entries[0].sessionId, "abc123");
  assert.equal(entries[0].channelId, "server-01");
  assert.equal(entries[0].event, "tunnel-start");
  assert.equal(entries[1].channelId, "server-02");
  assert.equal(entries[1].sessionId, "abc123");
});

// ---------------------------------------------------------------------------
// metrics-store
// ---------------------------------------------------------------------------

test("metrics: 超 maxSamplesPerServer 裁剪最旧", () => {
  let clock = 0;
  const store = createMetricsStore({
    filePath: join(mkTmp("kernel-metrics-"), "metrics.json"),
    maxSamplesPerServer: 3,
    now: () => clock,
  });
  for (let i = 0; i < 5; i += 1) {
    clock = i;
    store.addSample({ serverId: "s1", cpu: i, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });
  }

  const { samples } = store.query({ serverId: "s1" });
  assert.equal(samples.length, 3);
  assert.deepEqual(
    samples.map((s) => s.cpu),
    [2, 3, 4],
  );
});

test("metrics: 默认按 24h 时间窗口淘汰旧样本", () => {
  const clock = 2 * 86400e3;
  const store = createMetricsStore({ now: () => clock, maxAgeMs: 86400e3 });
  store.addSample({ serverId: "s1", ts: 1, cpu: 1 });
  store.addSample({ serverId: "s1", ts: clock - 1000, cpu: 2 });
  assert.deepEqual(store.query({ serverId: "s1" }).samples.map((s) => s.cpu), [2]);
});

test("metrics: query since 窗口正确", () => {
  let clock = 0;
  const store = createMetricsStore({
    filePath: join(mkTmp("kernel-metrics-"), "metrics.json"),
    maxSamplesPerServer: 100,
    now: () => clock,
  });
  for (let i = 0; i < 5; i += 1) {
    clock = i;
    store.addSample({ serverId: "s1", cpu: i, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });
  }

  const { samples } = store.query({ serverId: "s1", since: 3 });
  assert.deepEqual(
    samples.map((s) => s.ts),
    [3, 4],
  );
});

test("metrics: query 无 serverId 时合并所有服务器样本并按 ts 升序", () => {
  let clock = 0;
  const store = createMetricsStore({
    filePath: join(mkTmp("kernel-metrics-"), "metrics.json"),
    maxSamplesPerServer: 100,
    now: () => clock,
  });
  // 交错写入两台服务器，制造乱序 ts
  clock = 10;
  store.addSample({ serverId: "s1", cpu: 1, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });
  clock = 20;
  store.addSample({ serverId: "s2", cpu: 2, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });
  clock = 30;
  store.addSample({ serverId: "s1", cpu: 3, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });
  clock = 40;
  store.addSample({ serverId: "s2", cpu: 4, ram: 0, disk: 0, tunnelUp: true, probeDurationMs: 0 });

  // 无 serverId：合并两台并按 ts 升序
  const merged = store.query({});
  assert.deepEqual(
    merged.samples.map((s) => s.ts),
    [10, 20, 30, 40],
  );
  assert.deepEqual(
    merged.samples.map((s) => s.serverId),
    ["s1", "s2", "s1", "s2"],
  );

  // 无 serverId + since：同样的 since 过滤应作用于合并结果
  const sinceFiltered = store.query({ since: 25 });
  assert.deepEqual(
    sinceFiltered.samples.map((s) => s.ts),
    [30, 40],
  );
});

test("metrics: 默认查询只返回资源样本，validation latency 不污染负载趋势", () => {
  let clock = 0;
  const store = createMetricsStore({
    filePath: join(mkTmp("kernel-metrics-"), "metrics.json"),
    maxSamplesPerServer: 100,
    now: () => clock,
  });
  clock = 10;
  store.addSample({ serverId: "s1", cpu: 50, ram: 40, disk: 30, tunnelUp: true, probeDurationMs: 15 });
  clock = 20;
  store.addSample({
    serverId: "s1",
    kind: "validation",
    cpu: 0,
    ram: 0,
    disk: 0,
    tunnelUp: true,
    probeDurationMs: 80,
    proxyLatencyMs: 123,
  });

  const resourceOnly = store.query({ serverId: "s1" });
  assert.deepEqual(resourceOnly.samples.map((s) => s.ts), [10]);
  assert.deepEqual(resourceOnly.samples.map((s) => s.cpu), [50]);

  const validationOnly = store.query({ serverId: "s1", kind: "validation" });
  assert.equal(validationOnly.samples.length, 1);
  assert.equal(validationOnly.samples[0].proxyLatencyMs, 123);
});

test("metrics: load 读损坏 JSON 不抛且视为空", () => {
  const filePath = join(mkTmp("kernel-metrics-"), "metrics.json");
  writeFileSync(filePath, "{ this is not json");
  const store = createMetricsStore({ filePath });

  assert.doesNotThrow(() => store.load());
  assert.deepEqual(store.query({ serverId: "any" }).samples, []);
});

test("metrics: flush 原子写后可被 load 恢复", async () => {
  const filePath = join(mkTmp("kernel-metrics-"), "metrics.json");
  const store = createMetricsStore({ filePath, now: () => 10 });
  store.addSample({ serverId: "s1", cpu: 5, ram: 1, disk: 2, tunnelUp: true, probeDurationMs: 3 });
  await store.flush();

  const restored = createMetricsStore({ filePath, now: () => 10 });
  restored.load();
  const { samples } = restored.query({ serverId: "s1" });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].cpu, 5);
  assert.equal(samples[0].ts, 10);
});

// ---------------------------------------------------------------------------
// process-registry
// ---------------------------------------------------------------------------

test("registry: recordProcess 写入元数据并可被 readMeta 读回", () => {
  const registry = createProcessRegistry({ runtimeDir: mkTmp("kernel-reg-") });
  registry.recordProcess("worker", 999, {
    command: "node",
    args: ["a.mjs"],
    cwd: "/root/app",
    parentPid: 1,
  });

  const meta = registry.readMeta("worker");
  assert.equal(meta.name, "worker");
  assert.equal(meta.pid, 999);
  assert.equal(meta.rootDir, "/root/app");
  assert.equal(meta.parentPid, 1);
  assert.ok(meta.startedAt, "应带 ISO startedAt");
});

test("registry: verifyProcess 命令行匹配时 verified=true", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("kernel-reg-"),
    execFileImpl: async () => ({ stdout: " 12345 node work/local_http_connect_proxy.mjs\n" }),
  });
  registry.recordProcess("proxy", 12345, {
    command: "node",
    args: ["work/local_http_connect_proxy.mjs"],
    cwd: "/app",
  });

  const result = await registry.verifyProcess("proxy");
  assert.equal(result.verified, true);
});

test("registry: verifyProcess 命令行不匹配时 verified=false", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("kernel-reg-"),
    execFileImpl: async () => ({ stdout: " 12345 /usr/bin/python other_script.py\n" }),
  });
  registry.recordProcess("proxy", 12345, {
    command: "node",
    args: ["work/local_http_connect_proxy.mjs"],
    cwd: "/app",
  });

  const result = await registry.verifyProcess("proxy");
  assert.equal(result.verified, false);
  assert.ok(result.reason);
});

test("registry: stopProcess 对 verify 失败的进程拒绝杀进程", async () => {
  const runtimeDir = mkTmp("kernel-reg-");
  const registry = createProcessRegistry({
    runtimeDir,
    execFileImpl: async () => ({ stdout: " 12345 /usr/bin/python other_script.py\n" }),
  });
  registry.recordProcess("proxy", 12345, {
    command: "node",
    args: ["work/local_http_connect_proxy.mjs"],
    cwd: "/app",
  });

  const result = await registry.stopProcess("proxy");
  assert.equal(result.stopped, false);
  assert.ok(result.reason);
  // 校验失败不删 pid.json
  assert.ok(existsSync(join(runtimeDir, "proxy.pid.json")));
});

test("registry: listRuntimeProcesses 汇总并标注 verified", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("kernel-reg-"),
    // 按 ps -p 列表里的每个 pid 作答：darwin 逐 pid 单查，linux 一条 "-p 1,2" 批量查——
    // 只答 pid 1 的话，linux 会把 pid 2 判为"不存在"并 GC 掉。（win32 走 PowerShell 逐条查，
    // 只要输出里带命令行即可。）
    execFileImpl: async (_cmd, args) => ({
      stdout: String(args.at(-1)).split(",").map((pid) => ` ${pid} node ${pid === "2" ? "b" : "a"}.mjs\n`).join(""),
    }),
  });
  registry.recordProcess("a", 1, { command: "node", args: ["a.mjs"], cwd: "/x" });
  registry.recordProcess("b", 2, { command: "node", args: ["b.mjs"], cwd: "/x" });

  const list = await registry.listRuntimeProcesses();
  assert.equal(list.length, 2);
  assert.ok(list.every((entry) => typeof entry.verified === "boolean"));
  assert.ok(list.every((entry) => entry.meta && entry.name));
});

// ---------------------------------------------------------------------------
// v2.1 内核偿债：forceRun 信号量 / unregisterProbe / acquireSshSlot / registry GC
// ---------------------------------------------------------------------------

test("forceRun 在 ssh 并发满载时排队等待槽位", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 1000 });
  let releaseFirst;
  const firstDone = new Promise((r) => { releaseFirst = r; });
  scheduler.registerProbe({ id: "a", layer: "channel", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => firstDone.then(() => ({ level: "ok" })) });
  const pa = scheduler.forceRun("a");           // 占满唯一槽位
  let bStarted = false;
  scheduler.registerProbe({ id: "b2", layer: "channel", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => { bStarted = true; return { level: "ok" }; } });
  const pb = scheduler.forceRun("b2");          // 应排队而非立即执行
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bStarted, false, "槽位满载时 forceRun 不得立即执行");
  releaseFirst();
  await pa; await pb;
  assert.equal(bStarted, true, "槽位释放后排队的 forceRun 应执行");
});

test("unregisterProbe 剪除排队中的 forceRun 等待者，槽位释放后不跑陈旧探针", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 1000 });
  let releaseFirst;
  const firstDone = new Promise((r) => { releaseFirst = r; });
  scheduler.registerProbe({ id: "load:server-01", layer: "resources", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => firstDone.then(() => ({ level: "ok" })) });
  let staleCalled = false;
  scheduler.registerProbe({ id: "load:server-02", layer: "resources", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => { staleCalled = true; return { level: "ok" }; } });

  const pa = scheduler.forceRun("load:server-01"); // 占满唯一槽位
  const pb = scheduler.forceRun("load:server-02"); // 排队等待

  // 记录 unregister 之后是否还有针对该 id 的 PROBE_UPDATED
  let staleEmitted = false;
  const handler = (p) => { if (p.id === "load:server-02") staleEmitted = true; };
  bus.on(EVENTS.PROBE_UPDATED, handler);

  scheduler.unregisterProbe("load:server-02"); // 配置重载移除该服务器

  releaseFirst();
  await pa;
  await flush();
  const bResult = await pb;
  bus.off(EVENTS.PROBE_UPDATED, handler);

  assert.equal(staleCalled, false, "被注销探针的 run 不得在槽位释放后执行");
  assert.equal(bResult.level, "skipped", "排队的 forceRun 应结算为 skipped");
  assert.equal(bResult.reason, "probe unregistered");
  assert.equal(staleEmitted, false, "注销后不得再为该 id 发出 PROBE_UPDATED");
  scheduler.stop();
});

test("unregisterProbe 移除探针后 tick 不再调度且结果被清除", () => {
  const scheduler = createProbeScheduler({ now: () => 1000 });
  scheduler.registerProbe({ id: "x", layer: "resources", intervalMs: 1000, timeoutMs: 500, run: () => ({ level: "ok" }) });
  scheduler.tick();
  scheduler.unregisterProbe("x");
  assert.equal(scheduler.getResult("x"), undefined);
  assert.equal(scheduler.tick(), 0);
});

test("acquireSshSlot 占用并发额度，release 后探针恢复调度", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 1000 });
  scheduler.registerProbe({ id: "p", layer: "channel", intervalMs: 1000, timeoutMs: 500, usesSsh: true, run: () => ({ level: "ok" }) });
  const release = await scheduler.acquireSshSlot();
  assert.equal(scheduler.tick(), 0, "槽位被外部占用时 ssh 探针不得启动");
  release();
  assert.equal(scheduler.tick(), 1);
});

test("registry.listRuntimeProcesses 删除校验失败的 pid.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-gc-"));
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux", // 查询失败=进程确认不存在，是 POSIX 语义；win32 判 indeterminate 不回收
    execFileImpl: async () => { throw new Error("no such process"); }, // 模拟进程不存在
  });
  registry.recordProcess("dead", 999999, { command: "node dead.mjs", cwd: dir });
  const list = await registry.listRuntimeProcesses();
  assert.equal(list.length, 0, "死条目应被 GC 而非返回");
  assert.equal(existsSync(join(dir, "dead.pid.json")), false);
});

test("runValidationProbe 解析测试：模拟 SSH 返回，断言输出截断和 level 归纳", async () => {
  const config = {
    servers: [
      {
        id: "server-01",
        host: "myserver",
        name: "主集群服务器",
        remotePort: 7892,
        validationProfile: {
          remoteProxyTest: "curl -s https://api.openai.com",
          agentVersionCommands: {
            codex: "codex --version",
            reclaude: "reclaude --version"
          },
          workspaceSmokeCommand: "echo 'ok'"
        }
      }
    ]
  };

  const calledCmds = [];
  const toolkit = createChannelToolkit({
    rootDir: ".",
    getConfig: async () => config,
    execFileImpl: async (_cmd, args) => {
      calledCmds.push(args[args.length - 1]);
      const lastCmd = args[args.length - 1];
      if (lastCmd.includes("curl")) {
        return { code: 0, stdout: "200", stderr: "" };
      } else if (lastCmd.includes("codex --version")) {
        return { code: 1, stdout: "", stderr: "command not found" };
      } else if (lastCmd.includes("reclaude --version")) {
        const longOutput = "a".repeat(600);
        return { code: 0, stdout: longOutput, stderr: "" };
      } else if (lastCmd.includes("echo")) {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  const res = await toolkit.runValidationProbe("server-01");

  assert.equal(calledCmds.length, 4);
  for (const cmd of calledCmds) {
    assert.ok(
      cmd.startsWith('export PATH="$HOME/.local/bin:$PATH"; '),
      `验证命令需注入 PATH 前缀（非交互 SSH 默认 PATH 不含 ~/.local/bin）：${cmd}`
    );
  }
  assert.equal(res.level, "warn", "有一项失败，应该归纳为 warn");
  assert.equal(res.data.items.length, 4);
  
  const proxyTest = res.data.items.find(i => i.key === "remoteProxyTest");
  assert.equal(proxyTest.ok, true);
  assert.equal(proxyTest.output, "200");

  const codexTest = res.data.items.find(i => i.key === "agentVersion:codex");
  assert.equal(codexTest.ok, false);
  assert.equal(codexTest.output, "command not found");

  const reclaudeTest = res.data.items.find(i => i.key === "agentVersion:reclaude");
  assert.equal(reclaudeTest.ok, true);
  assert.equal(reclaudeTest.output.length, 515, "包含 512B 截断和三个省略号");
  assert.ok(reclaudeTest.output.endsWith("..."));
});

test("runValidationProbe 超时预算：每项 10s，注册的整体 timeoutMs 覆盖串行总耗时", async () => {
  const config = {
    servers: [
      {
        id: "server-01",
        host: "myserver",
        remotePort: 7892,
        validationProfile: {
          remoteProxyTest: "curl -s https://api.openai.com",
          agentVersionCommands: { codex: "codex --version", reclaude: "reclaude --version" },
          workspaceSmokeCommand: "echo 'ok'"
        }
      }
    ]
  };

  const seenTimeouts = [];
  const toolkit = createChannelToolkit({
    rootDir: ".",
    getConfig: async () => config,
    execFileImpl: async (_cmd, _args, options = {}) => {
      seenTimeouts.push(options.timeoutMs);
      return { code: 0, stdout: "ok", stderr: "" };
    }
  });

  await toolkit.runValidationProbe("server-01");
  assert.equal(seenTimeouts.length, 4);
  for (const t of seenTimeouts) {
    assert.equal(t, 10000, "单项超时应为 10s，串行 4 项才能装进探针整体超时");
  }

  const registered = [];
  const fakeScheduler = { registerProbe: (def) => registered.push(def) };
  toolkit.registerValidationProbes({
    scheduler: fakeScheduler,
    servers: config.servers,
    activeServerId: "server-01",
    getShouldBeRunning: () => true,
    getChannelUp: () => true,
  });
  assert.equal(registered.length, 1);
  // 4 项 × 10s + 5s 调度余量 = 45s；旧值 20s 会在慢网络下丢弃全部已完成项。
  assert.equal(registered[0].timeoutMs, 45000);
});

// ---------------------------------------------------------------------------
// v2.4 加固：forceRun 熔断门控 / 单实例让位判定 / recordProcess 原子写
// ---------------------------------------------------------------------------

test("forceRun 对 enabled()=false 的探针返回 skipped，不执行 run、不占槽、不覆盖已有结果", async () => {
  let clock = 1000;
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => clock });
  let ran = false;
  let gate = true;
  scheduler.registerProbe({
    id: "gated",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    enabled: () => gate, // 熔断门：通道断开 / 手动停止
    run: () => { ran = true; return { level: "ok" }; },
  });

  // 先跑出一次真实结果，随后闭合熔断门。
  await scheduler.forceRun("gated");
  assert.equal(scheduler.getResult("gated").level, "ok");
  const realNextCheckAt = scheduler.getResult("gated").nextCheckAt;
  ran = false;
  gate = false;
  clock = 2000;

  let emitted = null;
  const handler = (p) => { if (p.id === "gated") emitted = p.result; };
  bus.on(EVENTS.PROBE_UPDATED, handler);

  const result = await scheduler.forceRun("gated");
  bus.off(EVENTS.PROBE_UPDATED, handler);

  assert.equal(ran, false, "熔断中的探针不得被 forceRun 真正执行");
  assert.equal(result.level, "skipped");
  assert.equal(result.reason, "probe disabled");
  assert.equal(scheduler.getResult("gated").level, "ok", "上一次真实结果不得被 skipped 覆盖");
  assert.equal(scheduler.getResult("gated").nextCheckAt, realNextCheckAt, "nextCheckAt 不得被顺延");
  assert.equal(emitted, null, "被拒绝的手动触发不应发出 PROBE_UPDATED");

  // 未占用槽位：另一个 ssh 探针应能立即执行
  let otherRan = false;
  scheduler.registerProbe({ id: "other", layer: "agents", intervalMs: 90000, timeoutMs: 5000, usesSsh: true, run: () => { otherRan = true; return { level: "ok" }; } });
  await scheduler.forceRun("other");
  assert.equal(otherRan, true);
  scheduler.stop();
});

test("排队等待槽位的 forceRun 在授予时重查 enabled()，熔断闭合则放弃启动", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 1000 });
  let releaseFirst;
  const firstDone = new Promise((r) => { releaseFirst = r; });
  scheduler.registerProbe({ id: "hold", layer: "channel", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => firstDone.then(() => ({ level: "ok" })) });

  let gate = true;
  let ran = false;
  scheduler.registerProbe({ id: "late", layer: "agents", intervalMs: 90000, timeoutMs: 5000, usesSsh: true, enabled: () => gate, run: () => { ran = true; return { level: "ok" }; } });

  const pHold = scheduler.forceRun("hold"); // 占满唯一槽位
  const pLate = scheduler.forceRun("late"); // 排队（此刻 enabled=true）

  gate = false; // 等待期间熔断闭合
  releaseFirst();
  await pHold;
  const late = await pLate;

  assert.equal(ran, false, "熔断闭合后被授予槽位的等待者不得启动真实探针");
  assert.equal(late.level, "skipped");
  assert.equal(late.reason, "probe disabled");
  scheduler.stop();
});

// ---------------------------------------------------------------------------
// v2.10 forceRun 闸门收口：防抖合并（防信号风暴）/ overrideBreaker 人工逃生门
// ---------------------------------------------------------------------------

test("forceRun 防抖：窗口内同一探针重复触发合并为一次，窗口过期后重新执行", async () => {
  let clock = 10000;
  const scheduler = createProbeScheduler({ sshConcurrency: 3, now: () => clock });
  let calls = 0;
  scheduler.registerProbe({
    id: "debounced",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    run: () => { calls += 1; return { level: "ok" }; },
  });

  const first = await scheduler.forceRun("debounced");
  assert.equal(calls, 1);
  assert.equal(first.level, "ok");

  clock += 2000; // 仍在 5s 防抖窗口内
  const merged = await scheduler.forceRun("debounced");
  assert.equal(calls, 1, "防抖窗口内的重复 forceRun 必须合并，不得再次发起 SSH 运行");
  assert.equal(merged.level, "ok", "合并调用应拿到上一次真实结果作为反馈，而非悬挂或报错");

  clock += 4000; // 距首次 6s，已出窗口
  await scheduler.forceRun("debounced");
  assert.equal(calls, 2, "防抖窗口过期后 forceRun 应重新真实执行");
  scheduler.stop();
});

test("forceRun 防抖只锚定真实运行：熔断 skipped 不建立防抖窗口", async () => {
  let clock = 10000;
  let gate = false;
  let calls = 0;
  const scheduler = createProbeScheduler({ sshConcurrency: 3, now: () => clock });
  scheduler.registerProbe({
    id: "gated-then-open",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    enabled: () => gate,
    run: () => { calls += 1; return { level: "ok" }; },
  });

  const skipped = await scheduler.forceRun("gated-then-open");
  assert.equal(skipped.level, "skipped");
  assert.equal(calls, 0);

  clock += 1000; // 若 skipped 也建窗口，这里会被误合并
  gate = true;
  const real = await scheduler.forceRun("gated-then-open");
  assert.equal(calls, 1, "skipped 结算不占防抖窗口，熔断恢复后的触发必须真实执行");
  assert.equal(real.level, "ok");
  scheduler.stop();
});

test("forceRun 在 SSH 排队期间也合并同一常规请求，槽位释放后只运行一次", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 0 });
  let releaseHold;
  const holdDone = new Promise((resolve) => { releaseHold = resolve; });
  scheduler.registerProbe({
    id: "queue-hold",
    layer: "channel",
    intervalMs: 60000,
    timeoutMs: 5000,
    usesSsh: true,
    run: () => holdDone.then(() => ({ level: "ok" })),
  });
  let calls = 0;
  scheduler.registerProbe({
    id: "queue-debounced",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    run: () => { calls += 1; return { level: "ok" }; },
  });

  const hold = scheduler.forceRun("queue-hold");
  const first = scheduler.forceRun("queue-debounced");
  const duplicate = scheduler.forceRun("queue-debounced");
  assert.equal(first, duplicate, "同一常规请求在 SSH 队列中也必须复用同一 Promise");
  releaseHold();
  await Promise.all([hold, first, duplicate]);
  assert.equal(calls, 1, "槽位释放后不得依次执行信号风暴中积压的重复请求");
  scheduler.stop();
});

test("forceRun overrideBreaker：熔断打开时自动触发被拒，人工触发仍执行", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 3, now: () => 0 });
  let calls = 0;
  scheduler.registerProbe({
    id: "manual-escape",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    enabled: () => false, // 熔断打开
    run: () => { calls += 1; return { level: "ok" }; },
  });

  const auto = await scheduler.forceRun("manual-escape");
  assert.equal(auto.level, "skipped", "不带 override 的自动触发在熔断期应被拒绝");
  assert.equal(auto.reason, "probe disabled");
  assert.equal(calls, 0);

  const manual = await scheduler.forceRun("manual-escape", { overrideBreaker: true });
  assert.equal(calls, 1, "人工强制重试是熔断后恢复的合法路径，必须真实执行");
  assert.equal(manual.level, "ok");
  scheduler.stop();
});

test("forceRun overrideBreaker 绕过防抖并刷新窗口，人工重试总是真实执行", async () => {
  let clock = 0;
  const scheduler = createProbeScheduler({ sshConcurrency: 3, now: () => clock });
  let calls = 0;
  scheduler.registerProbe({
    id: "manual-fresh",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 5000,
    usesSsh: true,
    run: () => { calls += 1; return { level: "ok" }; },
  });

  await scheduler.forceRun("manual-fresh"); // 建立防抖窗口
  assert.equal(calls, 1);

  clock += 1000;
  await scheduler.forceRun("manual-fresh", { overrideBreaker: true });
  assert.equal(calls, 2, "人工触发不受防抖合并——点按钮必须立即有真实反馈");

  clock += 1000; // override 运行也刷新了窗口，自动触发继续被合并
  await scheduler.forceRun("manual-fresh");
  assert.equal(calls, 2, "override 运行后窗口内的自动触发仍应合并");
  scheduler.stop();
});

test("forceRun overrideBreaker 仍受 ssh 并发上限约束：排队等待，且熔断闭合不弃行", async () => {
  const scheduler = createProbeScheduler({ sshConcurrency: 1, now: () => 0 });
  let releaseHold;
  const holdDone = new Promise((r) => { releaseHold = r; });
  scheduler.registerProbe({ id: "hold2", layer: "channel", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, run: () => holdDone.then(() => ({ level: "ok" })) });

  let gate = true;
  let lateRan = false;
  scheduler.registerProbe({ id: "late2", layer: "agents", intervalMs: 90000, timeoutMs: 5000, usesSsh: true, enabled: () => gate, run: () => { lateRan = true; return { level: "ok" }; } });

  const pHold = scheduler.forceRun("hold2"); // 占满唯一槽位
  const pLate = scheduler.forceRun("late2", { overrideBreaker: true }); // 应排队而非超发
  await flush();
  assert.equal(lateRan, false, "override 不得绕开 ssh 并发上限直接超发");

  gate = false; // 等待期间熔断闭合
  releaseHold();
  await pHold;
  const late = await pLate;
  assert.equal(lateRan, true, "带 override 的排队等待者在熔断闭合后仍应执行（人工强制重试语义）");
  assert.equal(late.level, "ok");
  scheduler.stop();
});

test("shouldYieldToExisting 判定矩阵：仅当他人存活且命令行匹配时让位", () => {
  const meta = { pid: 500 };
  const base = { meta, selfPid: 600, alive: true, cmdline: "node work/monitor/channel-supervisor.mjs", expect: "channel-supervisor.mjs" };

  assert.equal(shouldYieldToExisting(base), true, "他人存活且命令行匹配 → 让位");
  assert.equal(shouldYieldToExisting({ ...base, meta: null }), false, "无登记 → 不让位");
  assert.equal(shouldYieldToExisting({ ...base, meta: { pid: 600 }, selfPid: 600 }), false, "登记的是自己 → 不让位");
  assert.equal(shouldYieldToExisting({ ...base, alive: false }), false, "pid 已死 → 不让位（正常接管）");
  assert.equal(shouldYieldToExisting({ ...base, cmdline: "vim notes.txt" }), false, "pid 复用为无关进程 → 不让位");
  assert.equal(shouldYieldToExisting({ ...base, meta: { pid: 0 } }), false, "非法 pid → 不让位");
  assert.equal(shouldYieldToExisting({ ...base, cmdline: "" }), false, "读不到命令行 → 不让位");
});

test("recordProcess 原子写：落盘后可读回且不残留 .tmp 文件", () => {
  const dir = mkTmp("registry-atomic-");
  const registry = createProcessRegistry({ runtimeDir: dir });
  registry.recordProcess("worker", 4242, { command: "node w.mjs", args: ["w.mjs"], cwd: "/x" });

  const meta = registry.readMeta("worker");
  assert.equal(meta.pid, 4242);
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "原子写不得残留 tmp 文件");
});

test("logger: shared flush promise counts in-flight bytes and waits for all pending writes", async () => {
  const dir = mkTmp("logger-inflight-");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const logger = createLogger("inflight-test", { dir, maxQueueBytes: 1024,
    appendFileImpl: async (...args) => { await gate; return appendFileAsync(...args); } });
  logger.info("x".repeat(500));
  const first = logger.flush();
  assert.ok(logger.stats().queuedBytes > 0, "in-flight batch still consumes queue budget");
  logger.info("x".repeat(500));
  assert.equal(logger.stats().dropped, 1);
  assert.equal(logger.flush(), first);
  let finished = false;
  const drainAll = flushAllLoggers().then(() => { finished = true; });
  await flush();
  assert.equal(finished, false);
  release();
  await drainAll;
  assert.equal(logger.stats().queuedBytes, 0);
  assert.match(readFileSync(join(dir, "inflight-test.ndjson"), "utf8"), /xxxx/);
  await logger.dispose();
});

test("logger: normal and rotated files remain within exact byte limit", async () => {
  const dir = mkTmp("logger-hard-cap-");
  const logger = createLogger("cap-test", { dir, maxBytes: 1024 });
  for (let i = 0; i < 80; i += 1) logger.info("x".repeat(100), { index: i });
  logger.info("oversized", { nested: { output: "y".repeat(1024 * 1024) } });
  await logger.flush();
  for (const file of readdirSync(dir)) assert.ok(statSync(join(dir, file)).size <= 1024, file);
  assert.ok(logger.stats().ringBytes < 16384, "large nested entry must also be bounded in memory");
  await logger.dispose();
});

test("logger: global ring and queued byte budgets survive multiple sources", async () => {
  const records = [];
  const dir = mkTmp("logger-global-");
  for (let i = 0; i < 10; i += 1) {
    const logger = createLogger(`global-cap-${i}`, { dir, maxRingBytes: 2 * 1024 * 1024, appendFileImpl: async () => {} });
    records.push(logger);
    for (let j = 0; j < 200; j += 1) logger.info("x".repeat(7000));
  }
  const stats = getLoggerStats();
  assert.ok(stats.ringBytes <= stats.maxRingBytes);
  assert.ok(stats.queuedBytes <= stats.maxQueueBytes);
  assert.ok(records.some((logger) => logger.stats().dropped > 0));
  await Promise.all(records.map((logger) => logger.dispose()));
});

test("logger: failed async append exposes dropped count and resolves flush", async () => {
  const logger = createLogger("write-failed", { dir: mkTmp("logger-failed-"), appendFileImpl: async () => { throw new Error("disk full"); } });
  logger.info("one");
  await logger.flush();
  assert.equal(logger.stats().writeErrors, 1);
  assert.equal(logger.stats().dropped, 1);
  assert.equal(logger.stats().queuedBytes, 0);
  await logger.dispose();
});

test("metrics: global key/sample/serialized-byte budgets and defensive query copy", () => {
  const store = createMetricsStore({ maxMemoryBytes: 800, maxTotalSamples: 5, maxServers: 2, now: () => 1000 });
  for (let i = 0; i < 100; i += 1) store.addSample({ serverId: `s${i}`, ts: 1000, cpu: i });
  const stats = store.stats();
  assert.ok(stats.storedBytes <= 800);
  assert.ok(stats.sampleCount <= 5);
  assert.ok(stats.servers <= 2);
  const sample = store.query().samples[0];
  sample.cpu = -100;
  assert.ok(store.query().samples.every((s) => s.cpu >= 0));
});

test("metrics: failed write stays dirty and explicit retry persists data", async () => {
  const filePath = join(mkTmp("metrics-retry-"), "metrics.json");
  let failing = true;
  const store = createMetricsStore({ filePath, io: { mkdir: mkdirAsync, unlink: unlinkAsync,
    writeFile: async (...args) => { if (failing) throw new Error("disk full"); return writeFileAsync(...args); } } });
  store.addSample({ serverId: "s1", cpu: 25 });
  await store.flush();
  assert.equal(store.stats().dirty, true);
  assert.equal(store.stats().writeErrors, 1);
  failing = false;
  await store.flush();
  assert.equal(store.stats().dirty, false);
  assert.equal(JSON.parse(readFileSync(filePath)).servers.s1[0].cpu, 25);
  await store.dispose();
});

test("metrics: concurrent flush waits and modifications during write get a second snapshot", async () => {
  const filePath = join(mkTmp("metrics-concurrent-"), "metrics.json");
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let writes = 0;
  const store = createMetricsStore({ filePath, io: { mkdir: mkdirAsync, unlink: unlinkAsync,
    writeFile: async (...args) => { writes += 1; if (writes === 1) { entered(); await gate; } return writeFileAsync(...args); } } });
  store.addSample({ serverId: "s1", cpu: 10 });
  const first = store.flush();
  await started;
  assert.equal(store.flush(), first);
  store.addSample({ serverId: "s1", cpu: 20 });
  release();
  await first;
  assert.equal(writes, 2);
  assert.equal(JSON.parse(readFileSync(filePath)).servers.s1.length, 2);
  await store.dispose();
});

test("metrics: sync shutdown persists newest state and cancels stale asynchronous commit", async () => {
  const filePath = join(mkTmp("metrics-shutdown-"), "metrics.json");
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const store = createMetricsStore({ filePath, io: { mkdir: mkdirAsync, unlink: unlinkAsync,
    writeFile: async (...args) => { entered(); await gate; return writeFileAsync(...args); } } });
  store.addSample({ serverId: "s1", cpu: 10 });
  const pending = store.flush();
  await started;
  store.addSample({ serverId: "s1", cpu: 20 });
  store.flushSync();
  assert.equal(JSON.parse(readFileSync(filePath)).servers.s1.length, 2);
  assert.equal(store.addSample({ serverId: "s1", cpu: 30 }), false, "shutdown closes the writer");
  release();
  await pending;
  assert.equal(JSON.parse(readFileSync(filePath)).servers.s1.length, 2);
  assert.equal(readdirSync(join(filePath, "..")).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("metrics: oversized persisted snapshot is rejected before parsing", () => {
  const filePath = join(mkTmp("metrics-oversized-"), "metrics.json");
  writeFileSync(filePath, JSON.stringify({ servers: { s1: [{ ts: Date.now(), payload: "x".repeat(20000) }] } }));
  const store = createMetricsStore({ filePath, maxMemoryBytes: 1024, maxServers: 2 });
  store.load();
  assert.deepEqual(store.query().samples, []);
});
