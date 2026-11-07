// runHotStart（listen 回调体）的分支行为。adopt 分支的调用序列在 monitor-server.test.mjs 里测，
// 这里覆盖 preserve / clean / fixture / 决策失败四条路径。
import assert from "node:assert/strict";
import test from "node:test";

import { runHotStart } from "./hot-start.mjs";

function harness({ processes, fixtureMode = false, getProcessesError = null } = {}) {
  const calls = [];
  let shouldBeRunning = false;
  const deps = {
    fixtureMode,
    toolkit: {
      getProcesses: async () => {
        if (getProcessesError) throw getProcessesError;
        return processes;
      },
    },
    channel: {
      setShouldBeRunning: (value) => {
        calls.push(`channel.set:${value}`);
        shouldBeRunning = value;
      },
      getShouldBeRunning: () => shouldBeRunning,
      autoRepairChannel: async (options) => calls.push(`autoRepairChannel:${JSON.stringify(options)}`),
      stopChannel: async () => calls.push("stopChannel"),
    },
    store: { setShouldBeRunning: (value) => calls.push(`store.set:${value}`) },
    scheduler: { start: () => calls.push("scheduler.start"), tick: () => calls.push("scheduler.tick") },
    appendLog: (message, fields) => calls.push(`log:${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`),
  };
  return { deps, calls };
}

test("runHotStart preserve：supervisor + 代理都在 → 原样接管，不 stop、不补 spawn", async () => {
  const { deps, calls } = harness({ processes: { supervisor: [{ pid: 1 }], localProxy: [{ pid: 2 }] } });
  await runHotStart(deps);
  assert.deepEqual(calls, [
    "log:server started, detected background supervisor and proxy. Preserving existing channels (hot start).",
    "channel.set:true",
    "store.set:true",
    "scheduler.start",
    "scheduler.tick",
  ]);
});

test("runHotStart clean：什么都没有 → 先 stopChannel 再置运行意图", async () => {
  const { deps, calls } = harness({ processes: { supervisor: [], localProxy: [], reverseTunnel: [] } });
  await runHotStart(deps);
  assert.deepEqual(calls, [
    "log:server started, no complete background tunnel detected. Performing clean start.",
    "stopChannel",
    "channel.set:true",
    "store.set:true",
    "scheduler.start",
    "scheduler.tick",
  ]);
});

test("runHotStart fixture：不探测进程、不启动调度器，运行意图置 false", async () => {
  const { deps, calls } = harness({ fixtureMode: true, processes: { supervisor: [{ pid: 1 }], localProxy: [{ pid: 2 }] } });
  await runHotStart(deps);
  assert.deepEqual(calls, [
    "channel.set:false",
    "store.set:false",
    "log:fixture mode ready: process mutation and live probes disabled",
  ]);
});

test("runHotStart：进程探测失败只记日志，调度器照常启动", async () => {
  const { deps, calls } = harness({ getProcessesError: new Error("ps failed") });
  await runHotStart(deps);
  assert.deepEqual(calls, ["log:initial setup failed: ps failed", "scheduler.start", "scheduler.tick"]);
});
