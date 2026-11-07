// 通道 ↔ 执行器的双向互斥判据。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunners, dataPlaneBusyReason, isAnyRunnerInFlight } from "./runners.mjs";

const runner = (inFlight) => ({ isInFlight: () => inFlight });

test("isAnyRunnerInFlight：槽位未绑定时为 false；任一执行器在飞即挡下通道重启", () => {
  const late = { operationsRunner: null, dataPlaneUpgrader: null };
  assert.equal(isAnyRunnerInFlight(late), false, "首拍之前槽位为空，不得抛 TDZ/TypeError");
  late.operationsRunner = runner(false);
  late.dataPlaneUpgrader = runner(false);
  assert.equal(isAnyRunnerInFlight(late), false);
  for (const key of ["operationsRunner", "dataPlaneUpgrader"]) {
    late[key] = runner(true);
    assert.equal(isAnyRunnerInFlight(late), true, key);
    late[key] = runner(false);
  }
});

test("dataPlaneBusyReason：按 通道修复 → 单隧道操作 的优先级给出拒绝原因", () => {
  const channel = (busy) => ({ getRepairInFlight: () => busy });
  assert.equal(dataPlaneBusyReason({ channel: channel(false), operationsRunner: runner(false) }), "");
  assert.equal(dataPlaneBusyReason({ channel: channel(true), operationsRunner: runner(true) }), "channel repair/restart in progress");
  assert.equal(dataPlaneBusyReason({ channel: channel(false), operationsRunner: runner(true) }), "tunnel operation in progress");
});

// v2.57：数据面升级结束后立即重读快照进缓存（/api/build-info 不再拿 5s 前的旧 supervisor 催第二次交接），
// 且新包指纹与 /api/build-info 的 dataPlane.bundle 同源。
test("createRunners：数据面升级结束即 snapshots.poll()；新包指纹取自 build-info", async (t) => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "runners-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const polls = [];
  const { dataPlaneUpgrader } = createRunners({
    channel: {
      getRepairInFlight: () => false,
      spawnSupervisor: async () => { throw new Error("must not spawn"); },
      holdAutoRepair: () => () => {},
      getShouldBeRunning: () => false,
    },
    getConfig: () => ({}),
    runtimeDir,
    registry: { readMeta: () => null, verifyProcess: async () => ({ verified: false }), verifyProcesses: async () => new Map() },
    fixtureMode: false,
    appendLog: () => {},
    writeTimeline: () => {},
    snapshots: { getUsableSnapshot: () => null, readFresh: async () => ({ snapshot: null }), poll: async () => { polls.push("poll"); } },
    getBundleComponents: async () => ({ supervisor: "cccccccccccc", proxy: "dddddddddddd" }),
  });
  const { status, body } = await dataPlaneUpgrader.upgrade({ components: ["supervisor"] });
  assert.equal(status, 200);
  assert.equal(body.ok, true, JSON.stringify(body.steps));
  assert.deepEqual(polls, ["poll"]);
  const start = readFileSync(new URL("./start.mjs", import.meta.url), "utf8");
  assert.match(start, /getBundleComponents: async \(\) => \(await getBuildInfo\(\)\)\.dataPlane\?\.bundle/);
});
