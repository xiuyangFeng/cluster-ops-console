// A09：forceRun 防抖缓存按 contextKey 区分（T02）。配置热载后新上下文的请求
// 不得被旧上下文的 5s 防抖缓存吞掉。假时钟驱动，无真实 SSH。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createProbeScheduler } from "./probe-scheduler.mjs";

test("A09: 同 contextKey 防抖合并；换 contextKey 立即得到新检查", async () => {
  let clock = 1_000;
  const scheduler = createProbeScheduler({ now: () => clock, forceRunDebounceMs: 5000 });
  let runs = 0;
  scheduler.registerProbe({
    id: "doctor",
    layer: "agents",
    intervalMs: 90000,
    timeoutMs: 1000,
    usesSsh: false,
    run: async () => {
      runs += 1;
      return { level: "ok", reason: `run-${runs}`, data: { runs } };
    },
  });

  const first = await scheduler.forceRun("doctor", { contextKey: "rev-1" });
  assert.equal(runs, 1);
  assert.equal(first.data.runs, 1);

  // 防抖窗口内、同一上下文 → 返回缓存结果，不重跑。
  clock += 1000;
  const cached = await scheduler.forceRun("doctor", { contextKey: "rev-1" });
  assert.equal(runs, 1, "同上下文防抖窗口内不得重复执行");
  assert.equal(cached.data.runs, 1);

  // 配置热载（contextKey 变化）→ 新上下文得到真实检查，不被旧缓存吞掉。
  clock += 1000;
  const refreshed = await scheduler.forceRun("doctor", { contextKey: "rev-2" });
  assert.equal(runs, 2, "新上下文必须发起新检查");
  assert.equal(refreshed.data.runs, 2);

  // 不传 contextKey 的旧调用方形状：防抖键保持既有形状（与旧实现一致）。
  clock += 1000;
  await scheduler.forceRun("doctor");
  assert.equal(runs, 3);
  clock += 1000;
  const legacyCached = await scheduler.forceRun("doctor");
  assert.equal(runs, 3, "无 contextKey 时维持旧防抖语义");
  assert.equal(legacyCached.data.runs, 3);
});
