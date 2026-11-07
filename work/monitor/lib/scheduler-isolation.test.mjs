// 探针隔离与物理记账测试（T08，验收 A29/A30/A31 核心层）。
// 用可手动结算的延迟 Promise 模拟慢 SSH，不连真实集群。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createProbeScheduler } from "./probe-scheduler.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("A29: 慢主机占满自身槽位时，其它主机仍可进入空闲全局槽位（每主机上限隔离）", async () => {
  const scheduler = createProbeScheduler({ now: () => Date.now(), perHostSshLimit: 1, sshConcurrency: 3 });
  const gate = deferred();
  let slowRuns = 0;
  let otherRuns = 0;
  let sameHostRuns = 0;
  // host-slow：一次 25s 级别的慢探针（手动放行）。
  scheduler.registerProbe({
    id: "slow-a", layer: "resources", intervalMs: 60000, timeoutMs: 30000, usesSsh: true, hostKey: "host-slow",
    run: async () => { slowRuns += 1; await gate.promise; return { level: "ok" }; },
  });
  // host-slow 的第二个探针：应被每主机上限挡住。
  scheduler.registerProbe({
    id: "slow-a-2", layer: "resources", intervalMs: 60000, timeoutMs: 30000, usesSsh: true, hostKey: "host-slow",
    run: async () => { sameHostRuns += 1; return { level: "ok" }; },
  });
  // host-fast：应正常启动（同样门控，避免它先跑完释放槽位干扰计数）。
  const fastGate = deferred();
  scheduler.registerProbe({
    id: "fast-b", layer: "resources", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, hostKey: "host-fast",
    run: async () => { otherRuns += 1; await fastGate.promise; return { level: "ok" }; },
  });

  scheduler.tick();
  await sleep(30);
  assert.equal(slowRuns, 1);
  assert.equal(otherRuns, 1, "其它主机不受慢主机影响");
  assert.equal(sameHostRuns, 0, "同主机第二个探针被每主机上限挡住");
  assert.equal(scheduler.getMetrics().sshActive, 2);
  assert.equal(scheduler.getMetrics().hostActive["host-slow"], 1);

  gate.resolve();
  fastGate.resolve();
  await sleep(30);
  // 放行后 host-slow 槽位释放，同主机第二个探针下一拍可执行。
  scheduler.tick();
  await sleep(30);
  assert.equal(sameHostRuns, 1);
  scheduler.stop();
});

test("A31: 超时返回结果后，物理执行结算前槽位不释放", async () => {
  const scheduler = createProbeScheduler({ now: () => Date.now(), sshConcurrency: 1, perHostSshLimit: 3 });
  const gate = deferred();
  let physicalSettled = false;
  scheduler.registerProbe({
    id: "leaky", layer: "resources", intervalMs: 60000, timeoutMs: 60, usesSsh: true, hostKey: "host-x",
    run: async () => {
      await gate.promise; // 调度器 60ms 就放弃等待，但底层"进程"300ms 后才结束
      physicalSettled = true;
      return { level: "ok" };
    },
  });
  const resultPromise = scheduler.forceRun("leaky", { overrideBreaker: true });
  const timeoutResult = await Promise.race([resultPromise, sleep(200).then(() => null)]);
  assert.ok(timeoutResult, "60ms 后应得到超时结果");
  assert.equal(timeoutResult.level, "error");

  // 物理执行尚未结算：全局并发 1 已被占用 → 新探针不能启动。
  let otherRuns = 0;
  scheduler.registerProbe({
    id: "other", layer: "resources", intervalMs: 60000, timeoutMs: 5000, usesSsh: true, hostKey: "host-y",
    run: async () => { otherRuns += 1; return { level: "ok" }; },
  });
  scheduler.tick();
  await sleep(30);
  assert.equal(otherRuns, 0, "物理执行结算前槽位不得复用（A31）");

  // 结算后释放。
  gate.resolve();
  await sleep(50);
  scheduler.tick();
  await sleep(30);
  assert.equal(otherRuns, 1);
  assert.ok(physicalSettled);
  scheduler.stop();
});

test("A30: 同上下文 forceRun 合并计数、外部借槽纳入每主机记账", async () => {
  const scheduler = createProbeScheduler({ now: () => Date.now(), sshConcurrency: 2, perHostSshLimit: 1 });
  const gate = deferred();
  let runs = 0;
  scheduler.registerProbe({
    id: "p", layer: "resources", intervalMs: 60000, timeoutMs: 30000, usesSsh: true, hostKey: "host-p",
    run: async () => { runs += 1; await gate.promise; return { level: "ok" }; },
  });
  // 不 await 首个 forceRun（其 Promise 要等门控放行才结算——这正是物理记账语义）。
  const firstRun = scheduler.forceRun("p");
  await sleep(20);
  assert.equal(runs, 1);
  // 同探针 in-flight 期间：任何 forceRun（含不同 contextKey）都复用同一运行，
  // 不可能并发第二个 run（per-probe 单飞契约）。
  scheduler.forceRun("p").catch(() => {});
  await sleep(20);
  assert.equal(scheduler.getMetrics().forceRunMerges >= 1, true, "in-flight 复用计入合并");

  // 外部借槽（bootstrap 等）与探针共享每主机记账：host-p 被探针占用 → 外部借 host-p
  // 排队；host-q 空闲 → 立即授予。
  const releaseQ = await scheduler.acquireSshSlot({ hostKey: "host-q" });
  assert.equal(scheduler.getMetrics().hostActive["host-q"], 1);
  const pendingP = scheduler.acquireSshSlot({ hostKey: "host-p" });
  await sleep(10);
  assert.equal(scheduler.getMetrics().queuedWaiters, 1, "host-p 的外部借槽在每主机上限下排队");
  releaseQ();

  // 结算后：host-p 释放、排队的借槽被授予；新 contextKey 得到真实新检查。
  gate.resolve();
  await firstRun;
  const releaseP = await pendingP;
  releaseP();
  await scheduler.forceRun("p", { contextKey: "rev-1" });
  assert.equal(runs, 2, "新 contextKey 得到新检查");
  scheduler.stop();
});

test("优先级 + 老化: override 等待者优先获得释放的槽位；同 rank FIFO", async () => {
  const scheduler = createProbeScheduler({ now: () => Date.now(), sshConcurrency: 1, perHostSshLimit: 3 });
  const gate = deferred();
  scheduler.registerProbe({
    id: "holder", layer: "resources", intervalMs: 60000, timeoutMs: 30000, usesSsh: true, hostKey: "h0",
    run: async () => { await gate.promise; return { level: "ok" }; },
  });
  // 不 await：holder 的 forceRun Promise 在门控放行前不会结算。
  const holderRun = scheduler.forceRun("holder");
  await sleep(20);

  const order = [];
  const makeQueued = (id, { override }) => {
    scheduler.registerProbe({
      id, layer: "resources", intervalMs: 60000, timeoutMs: 30000, usesSsh: true, hostKey: `hk-${id}`,
      run: async () => { order.push(id); return { level: "ok" }; },
    });
    scheduler.forceRun(id, { overrideBreaker: override }).catch(() => {});
  };
  makeQueued("normal-waiter", { override: false });
  await sleep(5);
  makeQueued("override-waiter", { override: true });
  await sleep(20);

  gate.resolve();
  await sleep(80);
  await holderRun.catch(() => {});
  assert.ok(order.indexOf("override-waiter") !== -1, "override 等待者应被授予");
  assert.ok(
    order.indexOf("override-waiter") < order.indexOf("normal-waiter"),
    `override 应先于 normal 启动，实际顺序 ${order.join(",")}`,
  );
  scheduler.stop();
});

test("插桩: getMetrics 只含有界聚合字段，不含命令串/主机外身份", () => {
  const scheduler = createProbeScheduler({ now: () => Date.now() });
  scheduler.registerProbe({ id: "x", layer: "resources", intervalMs: 1000, timeoutMs: 1000, run: async () => ({ level: "ok" }) });
  scheduler.tick();
  const m = scheduler.getMetrics();
  assert.equal(m.registeredProbes, 1);
  assert.ok(m.launches >= 1);
  assert.ok(!JSON.stringify(m).includes("secret"));
  scheduler.stop();
});
