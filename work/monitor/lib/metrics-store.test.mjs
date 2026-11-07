// metrics-store 落盘节奏测试（W1 磁盘写放大修复）：整份快照 5 分钟最多重写一次，
// 无变化不写，正常退出立即冲刷，旧格式文件照常加载。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { createMetricsStore, METRICS_FLUSH_DEBOUNCE_MS } from "./metrics-store.mjs";

function makeCountingIo() {
  const calls = { writes: 0 };
  return {
    calls,
    io: {
      mkdir: async () => {},
      unlink,
      writeFile: async (path, data, opts) => { calls.writes += 1; writeFileSync(path, data, opts); },
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("metrics 默认去抖为 5 分钟：60s 内不重写，满 5 分钟写一次", async (t) => {
  assert.equal(METRICS_FLUSH_DEBOUNCE_MS, 300000);
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const filePath = join(mkdtempSync(join(tmpdir(), "metrics-w1-")), "metrics.json");
  const { calls, io } = makeCountingIo();
  const store = createMetricsStore({ filePath, io, now: () => 1_000_000 });
  store.addSample({ serverId: "s1", ts: 1_000_000, cpu: 1 });
  mock.timers.tick(60000);
  await settle();
  assert.equal(calls.writes, 0, "旧的 60s 节奏不再触发整份重写");
  for (let i = 0; i < 20; i += 1) store.addSample({ serverId: "s1", ts: 1_000_000 - i - 1, cpu: i });
  mock.timers.tick(METRICS_FLUSH_DEBOUNCE_MS - 60000);
  await settle();
  assert.equal(calls.writes, 1, "5 分钟窗口内的所有采样合并为一次写入");
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).servers.s1.length, 21);
  assert.equal(store.stats().dirty, false);
});

test("metrics 无变化不写；dispose 立即冲刷未落盘采样", async () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "metrics-w1-")), "metrics.json");
  const { calls, io } = makeCountingIo();
  const store = createMetricsStore({ filePath, io, now: () => 1_000_000 });
  await store.flush();
  assert.equal(calls.writes, 0, "干净状态 flush 不写");
  store.addSample({ serverId: "s1", ts: 1_000_000, cpu: 7 });
  await store.flush();
  assert.equal(calls.writes, 1);
  await store.flush();
  assert.equal(calls.writes, 1, "已持久化的修订号不重复写");
  store.addSample({ serverId: "s1", ts: 1_000_001, cpu: 8 });
  assert.equal(store.stats().dirty, true);
  await store.dispose();
  assert.equal(calls.writes, 2, "退出冲刷不等待 5 分钟去抖");
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).servers.s1.length, 2);
});

test("metrics 兼容加载：带 version 包装与旧版裸对象格式", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-w1-"));
  const wrapped = join(dir, "wrapped.json");
  const legacy = join(dir, "legacy.json");
  writeFileSync(wrapped, JSON.stringify({ version: 1, servers: { s1: [{ ts: 999_000, cpu: 3 }] } }));
  writeFileSync(legacy, JSON.stringify({ s2: [{ ts: 999_500, cpu: 4 }] }));
  const a = createMetricsStore({ filePath: wrapped, now: () => 1_000_000 });
  a.load();
  assert.equal(a.query({ serverId: "s1" }).samples[0].cpu, 3);
  const b = createMetricsStore({ filePath: legacy, now: () => 1_000_000 });
  b.load();
  assert.equal(b.query({ serverId: "s2" }).samples[0].cpu, 4);
});

test("nodeGpuUtil：按节点名存各卡利用率；非法节点名、全空的节点、非对象一律不存", () => {
  const store = createMetricsStore({ now: () => 1_000_000 });
  store.addSample({ serverId: "s", ts: 1_000_000, cpu: 1, nodeGpuUtil: { node04: [0, 12.6], "bad name": [50], node05: [null] } });
  store.addSample({ serverId: "s", ts: 1_000_001, cpu: 1, nodeGpuUtil: [1, 2] });
  store.addSample({ serverId: "s", ts: 1_000_002, cpu: 1, nodeGpuUtil: { node06: [null, null] } });
  const [a, b, c] = store.query({ serverId: "s" }).samples;
  assert.deepEqual(a.nodeGpuUtil, { node04: [0, 13] });
  assert.equal("nodeGpuUtil" in b, false);
  assert.equal("nodeGpuUtil" in c, false);
});

test("gpuUtil：只收有限数数组（取整、夹到 0–100、最多 16 张卡），全空 / 非数组不存", () => {
  const store = createMetricsStore({ now: () => 1_000_000 });
  store.addSample({ serverId: "s", ts: 1_000_000, cpu: 1, gpuUtil: [97.4, "x", -5, 130] });
  store.addSample({ serverId: "s", ts: 1_000_001, cpu: 1, gpuUtil: [null, null] });
  store.addSample({ serverId: "s", ts: 1_000_002, cpu: 1, gpuUtil: "97" });
  store.addSample({ serverId: "s", ts: 1_000_003, cpu: 1, gpuUtil: Array.from({ length: 20 }, () => 50) });
  const [a, b, c, d] = store.query({ serverId: "s" }).samples;
  assert.deepEqual(a.gpuUtil, [97, null, 0, 100]);
  assert.equal("gpuUtil" in b, false);
  assert.equal("gpuUtil" in c, false);
  assert.equal(d.gpuUtil.length, 16);
});
