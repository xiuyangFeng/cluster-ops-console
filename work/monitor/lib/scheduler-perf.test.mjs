// T08 探针调度性能矩阵（等比缩小的可重复模拟；不连接任何真实主机）。
//
// 设计（01-详细实施方案 §11.1）：3/10/30 台模拟服务器 × 三种网络状态
//（正常 / 一台慢 / 多台离线）。客户端（1/3/8 个 SSE 消费者）维度需要 HTTP 层
// 模拟，本轮未覆盖——见实施记录"性能验证"。
//
// 等比缩小：真实节奏 slow 60s/fast 10s/慢探针 25s → 模拟 slow 240ms/fast 8ms/
// 慢探针 300ms，tick 50ms（真实 1000ms 的 1/20）。结论只用于相对比较与上限
// 校验（tick 事件循环开销、并发上限、公平性），不宣称绝对生产性能。
//
// 工程目标验证点（§11.3）：
//   1) 单个慢探针不阻塞其它主机进入空闲槽位（A29 的规模化版）；
//   2) 调度 tick 的事件循环开销 p95 < 100ms（正常交互 p95 目标）；
//   3) 物理/在途并发永不突破全局 3 与每主机上限（A30）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createProbeScheduler } from "./probe-scheduler.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

const SIZES = [3, 10, 30];
const SCENARIOS = {
  normal: () => 8,
  "one-slow": (hostIndex) => (hostIndex === 0 ? 300 : 8),
  // 多台离线：1/3 的主机立即失败（SSH 拒连的模拟），其余正常。
  "multi-offline": (hostIndex) => (hostIndex % 3 === 0 ? -1 : 8),
};

async function runMatrixOnce({ hostCount, scenarioName, wallMs = 1600, tickMs = 50 }) {
  const scenario = SCENARIOS[scenarioName];
  const scheduler = createProbeScheduler({ tickMs, sshConcurrency: 3, perHostSshLimit: 2, jitterRatio: 0 });
  const perHostLaunched = new Map();
  let concurrent = 0;
  let maxConcurrent = 0;
  let maxHostConcurrent = 0;
  const hostConcurrent = new Map();
  const tickDurations = [];

  for (let h = 0; h < hostCount; h += 1) {
    perHostLaunched.set(`host-${h}`, 0);
    scheduler.registerProbe({
      id: `probe-${h}`,
      layer: "resources",
      intervalMs: 120, // 等比 fast 节奏（真实 10s → 模拟 120ms tick 尺度）
      timeoutMs: 10_000,
      usesSsh: true,
      hostKey: `host-${h}`,
      run: async () => {
        perHostLaunched.set(`host-${h}`, perHostLaunched.get(`host-${h}`) + 1);
        concurrent += 1;
        hostConcurrent.set(`host-${h}`, (hostConcurrent.get(`host-${h}`) || 0) + 1);
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        maxHostConcurrent = Math.max(maxHostConcurrent, hostConcurrent.get(`host-${h}`));
        try {
          const duration = scenario(h);
          if (duration < 0) throw new Error("ssh connect refused (simulated)");
          await sleep(duration);
          return { level: "ok" };
        } finally {
          concurrent -= 1;
          hostConcurrent.set(`host-${h}`, hostConcurrent.get(`host-${h}`) - 1);
        }
      },
    });
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < wallMs) {
    const t0 = process.hrtime.bigint();
    scheduler.tick();
    const t1 = process.hrtime.bigint();
    tickDurations.push(Number(t1 - t0) / 1e6); // ms
    await sleep(tickMs);
  }
  // 收尾：等在途运行结算，再取最终计数。
  await sleep(350);

  return {
    perHostLaunched: Object.fromEntries(perHostLaunched),
    totalLaunched: [...perHostLaunched.values()].reduce((a, b) => a + b, 0),
    maxConcurrent,
    maxHostConcurrent,
    tickP95: p95(tickDurations),
    tickCount: tickDurations.length,
    metrics: scheduler.getMetrics(),
  };
}

for (const hostCount of SIZES) {
  for (const scenarioName of Object.keys(SCENARIOS)) {
    test(`性能矩阵: ${hostCount} 台 × ${scenarioName}`, { timeout: 30_000 }, async () => {
      const result = await runMatrixOnce({ hostCount, scenarioName });

      // 上限校验：全局 3、每主机 2 永不突破。
      assert.ok(result.maxConcurrent <= 3, `全局并发 ${result.maxConcurrent} 超限`);
      assert.ok(result.maxHostConcurrent <= 2, `每主机并发 ${result.maxHostConcurrent} 超限`);
      // tick 事件循环开销：p95 < 100ms（正常交互目标）。
      assert.ok(result.tickP95 < 100, `tick p95 ${result.tickP95?.toFixed(2)}ms 超过 100ms 目标`);
      // 皆有产出（调度器活着且真实启动了探针）。
      assert.ok(result.totalLaunched > 0);

      if (scenarioName === "one-slow" && hostCount > 1) {
        // A29 规模化：慢主机（host-0，300ms/次）不该吃满全部产出——
        // 其余主机合计启动次数必须显著高于慢主机。
        const slow = result.perHostLaunched["host-0"];
        const others = result.totalLaunched - slow;
        assert.ok(others > slow, `慢主机隔离失效：慢主机 ${slow} 次 vs 其余合计 ${others} 次`);
      }
      if (scenarioName === "multi-offline") {
        // 离线主机失败后仍应持续重试（不因失败而停止调度），且在线主机有产出。
        const offline = Object.entries(result.perHostLaunched)
          .filter(([host]) => Number(host.split("-")[1]) % 3 === 0)
          .reduce((a, [, n]) => a + n, 0);
        const online = result.totalLaunched - offline;
        assert.ok(offline > 0, "离线主机应持续重试");
        assert.ok(online > 0, "在线主机必须有产出");
      }
      // 汇总一行供实施记录引用（不打印主机身份等高基数信息）。
      console.log(`[perf] hosts=${hostCount} scenario=${scenarioName} total=${result.totalLaunched} maxConcurrent=${result.maxConcurrent} tickP95=${result.tickP95?.toFixed(2)}ms`);
    });
  }
}

test("性能矩阵汇总: 30 台 × one-slow 的公平性抽查（最坏规模点复测）", { timeout: 30_000 }, async () => {
  const result = await runMatrixOnce({ hostCount: 30, scenarioName: "one-slow", wallMs: 1600 });
  const slow = result.perHostLaunched["host-0"];
  const others = result.totalLaunched - slow;
  assert.ok(others > slow * 2, `30 台规模下慢主机仍不得霸占（慢 ${slow} vs 其余 ${others}）`);
  console.log(`[perf] 30×one-slow fair-share: slow=${slow} others=${others} tickP95=${result.tickP95?.toFixed(2)}ms`);
});
