// GET /api/tunnel-stability 的数据源：从磁盘上的断线账本（含轮转出的 .1）读出来的口径。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { recordedLedger, replaySleepScene, sceneConfig, sceneTime, SCENE_DAY } from "./supervisor/sleep-scene-fixture.mjs";
import { TUNNEL_LEDGER_FILENAME } from "./supervisor/tunnel-ledger.mjs";
import { createTunnelStabilityService, DAILY_DAYS } from "./tunnel-stability-service.mjs";

const toText = (rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

function makeService(t, { older = [], current, now }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-stability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (older.length) fs.writeFileSync(path.join(dir, `${TUNNEL_LEDGER_FILENAME}.1`), toText(older));
  fs.writeFileSync(path.join(dir, TUNNEL_LEDGER_FILENAME), toText(current));
  return createTunnelStabilityService({ runtimeDir: dir, getMergedConfig: sceneConfig, now: () => now });
}

test("休眠那天：近 24 小时 0 次断线，sleep 只留两个窗口，按天的休眠时长并进各服务器的 daily", async (t) => {
  const { rows } = await replaySleepScene();
  // 账本中途轮转过一次：前半在 .1、后半在当前文件，读侧拼起来用。
  const service = makeService(t, { older: rows.slice(0, 30), current: rows.slice(30), now: sceneTime("23:00:00") });
  const stats = JSON.parse(JSON.stringify(await service.get())); // 接口发出去的就是这份 JSON
  assert.deepEqual(Object.keys(stats.sleep).sort(), ["24h", "7d"]);
  assert.deepEqual(stats.sleep["24h"], { ms: 9_738_611, count: 1, lastWakeAt: sceneTime("21:45:57.611") });
  assert.deepEqual(stats.sleep["7d"], stats.sleep["24h"]);
  for (const id of ["server-01", "server-02"]) {
    const entry = stats.servers[id];
    assert.deepEqual(Object.keys(entry.windows).sort(), ["24h", "7d"]);
    assert.deepEqual([entry.windows["24h"].drops, entry.windows["24h"].downMs, entry.windows["24h"].availability], [0, 0, 1]);
    assert.equal(entry.daily.length, DAILY_DAYS);
    assert.equal(entry.daily.at(-1).day, SCENE_DAY, "按北京时间自然日，今天在最后");
    assert.deepEqual(entry.daily.map((d) => d.sleepMs), [0, 0, 0, 0, 0, 0, 9_738_611]);
    assert.deepEqual([entry.daily.at(-1).drops, entry.daily.at(-1).downMs], [0, 0]);
  }
  assert.equal(stats.servers["server-01"].name, "主集群服务器 (example-cluster)");
  assert.deepEqual(stats.recentDrops.map((d) => [d.serverId, d.cause, d.sleep, d.drops]), [["server-01", "sleep", true, 3], ["server-02", "sleep", true, 4]]);
});

test("旧版 supervisor 记的账本（没有 sleep / wake）：照旧是断线，daily 的 sleepMs 为 0", async (t) => {
  const service = makeService(t, { current: recordedLedger(), now: sceneTime("23:00:00") });
  const stats = await service.get();
  assert.deepEqual(stats.sleep, { "24h": { ms: 0, count: 0, lastWakeAt: null }, "7d": { ms: 0, count: 0, lastWakeAt: null } });
  assert.deepEqual(["server-01", "server-02"].map((id) => stats.servers[id].windows["24h"].drops), [3, 4]);
  assert.deepEqual(stats.servers["server-02"].daily.at(-1), { day: SCENE_DAY, availability: 0.9692783143924455, drops: 4, observedMs: 3_613_083, downMs: 111_000, sleepMs: 0 });
});
