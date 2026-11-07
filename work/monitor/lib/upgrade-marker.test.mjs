// 数据面升级在飞标记 + 重启界面在升级中的拒绝/宽限接线。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDataPlaneUpgrader } from "./data-plane-upgrade.mjs";
import {
  isDataPlaneUpgradeInFlight,
  isUpgradeMarkerActive,
  readUpgradeMarker,
  removeUpgradeMarker,
  UPGRADE_MARKER_FRESH_MS,
  upgradeMarkerPath,
  writeUpgradeMarker,
} from "./upgrade-marker.mjs";


function tmpRuntime() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "upgrade-marker-")), "runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("isUpgradeMarkerActive：pid 存活 + 60s 内才算在飞", () => {
  const alive = () => true;
  const dead = () => false;
  const marker = { pid: 42, startedAt: 1_000_000 };
  assert.equal(isUpgradeMarkerActive(marker, { now: 1_000_000 + 1000, pidAlive: alive }), true);
  assert.equal(isUpgradeMarkerActive(marker, { now: 1_000_000 + UPGRADE_MARKER_FRESH_MS - 1, pidAlive: alive }), true);
  assert.equal(isUpgradeMarkerActive(marker, { now: 1_000_000 + UPGRADE_MARKER_FRESH_MS, pidAlive: alive }), false);
  assert.equal(isUpgradeMarkerActive(marker, { now: 1_000_000 + 1000, pidAlive: dead }), false);
  assert.equal(isUpgradeMarkerActive(marker, { now: 1_000_000 - 10_000, pidAlive: alive }), false);
  assert.equal(isUpgradeMarkerActive(null, { now: 1, pidAlive: alive }), false);
  assert.equal(isUpgradeMarkerActive({ pid: "x", startedAt: 1 }, { now: 1, pidAlive: alive }), false);
});

test("写 / 读 / 只删自己的；runtimeDir 不存在时不落盘", () => {
  const runtimeDir = tmpRuntime();
  assert.equal(writeUpgradeMarker({ runtimeDir, pid: process.pid, components: ["proxy"] }), true);
  assert.deepEqual(readUpgradeMarker({ runtimeDir }).components, ["proxy"]);
  assert.equal(isDataPlaneUpgradeInFlight({ runtimeDir }), true);
  assert.equal(removeUpgradeMarker({ runtimeDir, pid: process.pid + 1 }), false);
  assert.equal(existsSync(upgradeMarkerPath(runtimeDir)), true);
  assert.equal(removeUpgradeMarker({ runtimeDir, pid: process.pid }), true);
  assert.equal(isDataPlaneUpgradeInFlight({ runtimeDir }), false);
  const missing = path.join(runtimeDir, "nope");
  assert.equal(writeUpgradeMarker({ runtimeDir: missing }), false);
  assert.equal(existsSync(missing), false);
});

test("data-plane upgrade 编排期间标记存在，结束（含异常）后删除", async () => {
  const runtimeDir = tmpRuntime();
  let seenDuringRun = null;
  const upgrader = createDataPlaneUpgrader({
    registry: { readMeta: () => null, verifyProcess: async () => ({ verified: false, meta: null }), verifyProcesses: async () => new Map() },
    runtimeDir,
    readdir: async () => [],
    readSnapshot: async () => {
      if (seenDuringRun === null) seenDuringRun = JSON.parse(readFileSync(upgradeMarkerPath(runtimeDir), "utf8"));
      return { snapshot: null, stale: false };
    },
    spawnSupervisor: async () => ({ pid: null }),
    shouldBeRunning: () => false,
    sleep: async () => {},
  });
  const res = await upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(res.status, 200);
  assert.equal(seenDuringRun.pid, process.pid);
  assert.deepEqual(seenDuringRun.components, ["supervisor"]);
  assert.equal(existsSync(upgradeMarkerPath(runtimeDir)), false);

  // 编排抛异常：标记仍被清掉
  const boom = createDataPlaneUpgrader({
    registry: { readMeta: () => { throw new Error("boom"); } },
    runtimeDir,
    readdir: async () => [],
    readSnapshot: async () => ({ snapshot: null, stale: false }),
    spawnSupervisor: async () => ({ pid: null }),
  });
  await assert.rejects(boom.upgrade({ components: ["supervisor"] }));
  assert.equal(existsSync(upgradeMarkerPath(runtimeDir)), false);
});

