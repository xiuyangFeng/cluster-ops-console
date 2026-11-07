import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureGpuTrend, GPU_TREND_REFRESH_MS, GPU_TREND_SPAN_MS, gpuCardSeries, gpuSeriesFor, gpuSparkSvg, gpuTrendRevision, isGpuIdleHoldingMemory, mergeGpuSamples, onGpuTrendChange } from "./gpu-trend.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

test("合并样本：按 ts 去重排序，丢窗口外与没有 gpuUtil 的", () => {
  const merged = mergeGpuSamples(
    [{ ts: NOW - 10 * MIN, util: [1] }],
    [{ ts: NOW - 5 * MIN, gpuUtil: [5] }, { ts: NOW - 10 * MIN, gpuUtil: [9] }, { ts: NOW - 2 * GPU_TREND_SPAN_MS, gpuUtil: [7] }, { ts: NOW, cpu: 3 }],
    NOW - GPU_TREND_SPAN_MS,
  );
  assert.deepEqual(merged, [{ ts: NOW - 10 * MIN, util: [9], nodes: null }, { ts: NOW - 5 * MIN, util: [5], nodes: null }]);
});

test("直连节点（node04）的各卡走势：nodeGpuUtil 单独成序列，只有节点数据的样本也收", () => {
  const base = Math.floor(NOW / (5 * MIN)) * 5 * MIN;
  const merged = mergeGpuSamples([], [
    { ts: base + MIN, gpuUtil: [90], nodeGpuUtil: { node04: [0, 30] } },
    { ts: base + 6 * MIN, nodeGpuUtil: { node04: [12, null] } },
    { ts: base + 7 * MIN, nodeGpuUtil: [1, 2] },
  ], base - GPU_TREND_SPAN_MS);
  assert.equal(merged.length, 2, "nodeGpuUtil 不是对象的样本丢掉");
  assert.deepEqual(gpuCardSeries(merged, 0, "node04"), [{ ts: base, v: 0 }, { ts: base + 5 * MIN, v: 12 }]);
  assert.deepEqual(gpuCardSeries(merged, 1, "node04"), [{ ts: base, v: 30 }]);
  assert.deepEqual(gpuCardSeries(merged, 0), [{ ts: base, v: 90 }], "本机序列不受影响");
  assert.deepEqual(gpuCardSeries(merged, 0, "node05"), []);
});

test("单卡序列：5 分钟一档取档内最高，缺值的样本跳过", () => {
  const base = Math.floor(NOW / (5 * MIN)) * 5 * MIN;
  const samples = [
    { ts: base + MIN, util: [10, 90] },
    { ts: base + 2 * MIN, util: [40, null] },
    { ts: base + 6 * MIN, util: [20] },
  ];
  assert.deepEqual(gpuCardSeries(samples, 0), [{ ts: base, v: 40 }, { ts: base + 5 * MIN, v: 20 }]);
  assert.deepEqual(gpuCardSeries(samples, 1), [{ ts: base, v: 90 }]);
});

test("走势 SVG：少于 2 点不画；超过 15 分钟的断档另起一段", () => {
  const start = NOW - GPU_TREND_SPAN_MS;
  assert.equal(gpuSparkSvg([{ ts: NOW - MIN, v: 50 }], { start, end: NOW }), "");
  const svg = gpuSparkSvg([
    { ts: NOW - 60 * MIN, v: 10 }, { ts: NOW - 55 * MIN, v: 80 },
    { ts: NOW - 20 * MIN, v: 100 }, { ts: NOW - 15 * MIN, v: 0 },
  ], { start, end: NOW });
  const line = /class="res-gpu-trend-line" d="([^"]+)"/.exec(svg)[1];
  assert.equal((line.match(/M/g) || []).length, 2, "断档处分两段");
  assert.doesNotMatch(svg, /NaN/);
});

test("按需拉取：首次整段、60 秒内不重复、之后从最新一条之后增量；到货递增版本并通知", async () => {
  const calls = [];
  let notified = 0;
  const off = onGpuTrendChange(() => { notified += 1; });
  const fetchMetrics = async ({ serverId, since }) => {
    calls.push({ serverId, since });
    return { samples: [{ ts: NOW - 1000 + calls.length, gpuUtil: [calls.length * 10] }] };
  };
  const before = gpuTrendRevision();
  ensureGpuTrend("srv-test", { now: NOW, fetchMetrics });
  await new Promise((r) => setTimeout(r, 0));
  ensureGpuTrend("srv-test", { now: NOW + 1000, fetchMetrics });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1, "60 秒内不重复拉");
  assert.equal(calls[0].since, NOW - GPU_TREND_SPAN_MS);
  ensureGpuTrend("srv-test", { now: NOW + GPU_TREND_REFRESH_MS, fetchMetrics });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls[1].since, NOW - 1000 + 1 + 1, "从最新一条之后增量");
  assert.ok(gpuTrendRevision() > before);
  assert.ok(notified >= 1);
  assert.equal(gpuSeriesFor("srv-test", 0).length >= 1, true);
  off();
});

test("isGpuIdleHoldingMemory：0% 利用率 + 显存占用 + 近 30 分钟采样桶全为 0% 时报 true", () => {
  const zeroSeries = [
    { ts: NOW - 25 * MIN, v: 0 },
    { ts: NOW - 15 * MIN, v: 0 },
    { ts: NOW - 5 * MIN, v: 0 },
  ];
  assert.equal(isGpuIdleHoldingMemory({ util: 0, memPct: 97, memUsedMb: 79410 }, zeroSeries, { now: NOW }), true);
  assert.equal(isGpuIdleHoldingMemory({ util: 12, memPct: 97, memUsedMb: 79410 }, zeroSeries, { now: NOW }), false, "当前有利用率不算空占");
  assert.equal(isGpuIdleHoldingMemory({ util: 0, memPct: 2, memUsedMb: 400 }, zeroSeries, { now: NOW }), false, "未占高显存不算空占");
  assert.equal(
    isGpuIdleHoldingMemory({ util: 0, memPct: 80, memUsedMb: 32000 }, [{ ts: NOW - 20 * MIN, v: 0 }, { ts: NOW - 10 * MIN, v: 35 }, { ts: NOW - 5 * MIN, v: 0 }], { now: NOW }),
    false,
    "近 30 分钟内有过算力活动不算空占",
  );
  assert.equal(
    isGpuIdleHoldingMemory({ util: 0, memPct: 80, memUsedMb: 32000 }, [{ ts: NOW - 5 * MIN, v: 0 }], { now: NOW }),
    false,
    "采样点不足 3 桶不误报",
  );
});

