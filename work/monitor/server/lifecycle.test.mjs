// 退出顺序是契约（事件最终落盘必须排在在途请求之后，exit 必须最后），这里用记录型替身锁死。
import assert from "node:assert/strict";
import test from "node:test";

import { createShutdown } from "./lifecycle.mjs";

function harness({ failing = [] } = {}) {
  const order = [];
  const step = (name, value) => () => {
    order.push(name);
    if (failing.includes(name)) throw new Error(`${name} failed`);
    return value;
  };
  const asyncStep = (name) => async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push(name);
    if (failing.includes(name)) throw new Error(`${name} failed`);
  };
  const shutdown = createShutdown({
    incidentSync: { beginShutdown: step("incident.beginShutdown"), close: asyncStep("incident.close") },
    httpServer: {
      server: { close: step("server.close"), closeAllConnections: step("server.closeAllConnections") },
      drainPendingRequests: asyncStep("http.drain"),
    },
    scheduler: { stop: step("scheduler.stop") },
    localResourceProbe: { dispose: step("localResource.dispose") },
    metricsStore: { dispose: asyncStep("metrics.dispose") },
    historyStore: { dispose: step("history.dispose") },
    storage: { stopSweeper: step("storage.stopSweeper") },
    credentials: { closeOwnedVault: step("vault.close") },
    flushLoggers: asyncStep("loggers.flush"),
    flushServices: asyncStep("services.flush"),
    exit: (code) => order.push(`exit:${code}`),
  });
  return { shutdown, order };
}

const EXPECTED = [
  "incident.beginShutdown",
  "server.close",
  "server.closeAllConnections",
  "scheduler.stop",
  "localResource.dispose",
  "http.drain",
  "services.flush",
  "metrics.dispose",
  "incident.close",
  "history.dispose",
  "storage.stopSweeper",
  "loggers.flush",
  "vault.close",
  "exit:0",
];

test("shutdown：按既定顺序收尾并以 0 退出；重复信号只执行一次", async () => {
  const { shutdown, order } = harness();
  await Promise.all([shutdown(), shutdown()]);
  assert.deepEqual(order, EXPECTED);
});

test("shutdown：落盘类步骤失败不打断后续收尾，仍以 0 退出", async () => {
  const { shutdown, order } = harness({
    failing: ["services.flush", "metrics.dispose", "incident.close", "history.dispose", "storage.stopSweeper", "loggers.flush"],
  });
  await shutdown();
  assert.deepEqual(order, EXPECTED);
});

// v2.59 自更新：网页模式的「重启监控服务」走同一条优雅退出，只是退出码不同（launch.mjs 据此重新拉起）。
test("显式传 { exitCode } 才改退出码；信号处理器传进来的信号名不影响（仍是 0）", async () => {
  const restart = harness();
  await restart.shutdown({ exitCode: 75 });
  assert.equal(restart.order.at(-1), "exit:75");
  assert.deepEqual(restart.order.slice(0, -1), EXPECTED.slice(0, -1), "退出顺序不变");
  const signal = harness();
  await signal.shutdown("SIGTERM");
  assert.equal(signal.order.at(-1), "exit:0");
});

// v2.62 服务直达：转发 ssh 的 SIGTERM 要赶在排干在途请求之前发（同步），确认退出排在服务收尾之后。
test("shutdown：转发先于排干收到停止信号，收尾之后再确认退出；这两步出错不打断后续收尾", async () => {
  const run = async (failing = []) => {
    const order = [];
    const step = (name) => () => {
      order.push(name);
      if (failing.includes(name)) throw new Error(`${name} failed`);
    };
    const asyncStep = (name) => async () => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push(name);
      if (failing.includes(name)) throw new Error(`${name} failed`);
    };
    const shutdown = createShutdown({
      incidentSync: { beginShutdown: step("incident.beginShutdown"), close: asyncStep("incident.close") },
      httpServer: { server: { close: step("server.close"), closeAllConnections: step("server.closeAllConnections") }, drainPendingRequests: asyncStep("http.drain") },
      scheduler: { stop: step("scheduler.stop") },
      localResourceProbe: { dispose: step("localResource.dispose") },
      metricsStore: { dispose: asyncStep("metrics.dispose") },
      historyStore: { dispose: step("history.dispose") },
      storage: { stopSweeper: step("storage.stopSweeper") },
      credentials: { closeOwnedVault: step("vault.close") },
      serviceForwards: { beginShutdown: step("forwards.beginShutdown"), dispose: asyncStep("forwards.dispose") },
      flushLoggers: asyncStep("loggers.flush"),
      flushServices: asyncStep("services.flush"),
      exit: (code) => order.push(`exit:${code}`),
    });
    await shutdown();
    return order;
  };
  const expected = [...EXPECTED];
  expected.splice(expected.indexOf("http.drain"), 0, "forwards.beginShutdown");
  expected.splice(expected.indexOf("services.flush") + 1, 0, "forwards.dispose");
  assert.deepEqual(await run(), expected);
  assert.deepEqual(await run(["forwards.beginShutdown", "forwards.dispose"]), expected);
});
