import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeSnapshot, buildThreeServerConfig } from "../../../../lib/m1-fixtures.mjs";
import { buildConnectionTargetsProjection } from "../../../../lib/runtime-snapshot.mjs";
import { createServerActions } from "./server-actions.js";
import { createAppState } from "./state.js";
import { spy } from "./test-support.mjs";

function snapshotStatus(config, activeServerId = config.activeServerId, { snapshot = buildRuntimeSnapshot() } = {}) {
  const connectionTargets = buildConnectionTargetsProjection({ snapshot, snapshotState: snapshot ? "ok" : "missing", config });
  return { activeServerId, connectionTargets };
}

function setup(overrides = {}) {
  const elements = {};
  const state = createAppState();
  const config = buildThreeServerConfig();
  state.setConfig(config);
  state.setStatus(snapshotStatus(config));
  const deps = {
    state,
    showToast: spy(), confirm: spy(() => true),
    getJson: spy(async () => ({ suggested: { remotePort: 17990 }, revision: 3 })),
    postJson: spy(async (_url, body) => ({ remotePort: body.remotePort, registered: true, mode: "claimed" })),
    loadServers: spy(async () => {}),
    refresh: spy(async () => {}),
    requestScopedRestart: spy(),
    ...overrides,
  };
  return { deps, elements, state, config, actions: createServerActions(deps) };
}

test("服务器页「连接与修复」面板已移除：控制器只剩重新分配端口（复制命令与单隧道重启在命令面板）", () => {
  const { actions } = setup();
  assert.deepEqual(Object.keys(actions), ["reassignPort"]);
});

test("reassignPort: 无自动建议 → 说明原因不写配置；取消确认 → 不写；成功且有能力 → 只重启该隧道", async () => {
  const blocked = setup({ getJson: spy(async () => ({ suggested: null, probeError: "timeout" })) });
  await blocked.actions.reassignPort("fixture-a");
  assert.equal(blocked.deps.postJson.calls.length, 0);
  assert.equal(blocked.deps.showToast.calls[0][0].type, "warn");

  const cancelled = setup({ confirm: spy(() => false) });
  await cancelled.actions.reassignPort("fixture-a");
  assert.equal(cancelled.deps.postJson.calls.length, 0);
  assert.match(cancelled.deps.confirm.calls[0][0], /Fixture A/);

  const ok = setup();
  await ok.actions.reassignPort("fixture-a");
  // v2.54 终审：确认后走登记领取（claim-port），不再直接 PATCH 写端口
  assert.deepEqual(ok.deps.postJson.calls, [["/api/servers/fixture-a/claim-port", { remotePort: 17990, expectedRevision: 3 }]]);
  assert.match(ok.deps.showToast.calls.at(-1)[0].message, /17990（已在集群登记）/);
  assert.equal(ok.deps.loadServers.calls.length, 1);
  assert.deepEqual(ok.deps.refresh.calls, [[{ force: true }]]);
  assert.deepEqual(ok.deps.requestScopedRestart.calls, [["fixture-a"]]);
});

test("reassignPort: 领取时被人抢先 → 提示实际领到的端口；登记目录不可用 → 黄色提示「未登记」", async () => {
  const bumped = setup({ postJson: spy(async () => ({ remotePort: 17991, registered: true, mode: "claimed" })) });
  await bumped.actions.reassignPort("fixture-a");
  assert.match(bumped.deps.showToast.calls.at(-1)[0].message, /17991/);
  const legacy = setup({ postJson: spy(async () => ({ remotePort: 17990, registered: false, mode: "legacy" })) });
  await legacy.actions.reassignPort("fixture-a");
  const toast = legacy.deps.showToast.calls.find((c) => /反向端口改为/.test(c[0].message))[0];
  assert.equal(toast.type, "warn");
  assert.match(toast.message, /未登记/);
});

test("reassignPort: 旧 supervisor 无单隧道能力 → 提示守护进程会按新端口重建；在飞时拒绝重入", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = setup({ getJson: spy(async () => { await gate; return { suggested: { remotePort: 17990 }, revision: 1 }; }) });
  ctx.state.setStatus(snapshotStatus(ctx.config, "fixture-a", { snapshot: null }));
  const first = ctx.actions.reassignPort("fixture-a");
  await ctx.actions.reassignPort("fixture-a");
  assert.equal(ctx.deps.getJson.calls.length, 1, "在飞时第二次调用直接返回");
  release();
  await first;
  assert.equal(ctx.deps.requestScopedRestart.calls.length, 0);
  assert.match(ctx.deps.showToast.calls.at(-1)[0].message, /守护进程会按新端口重建该隧道/);
});
