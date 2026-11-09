import assert from "node:assert/strict";
import test from "node:test";
import { waitForPackageUpdate } from "./render/package-update.js";
import { buildSelfUpdateModel, buildUpdateBannerModel } from "./render/update-banner.js";

test("热更新阶段轮询至就绪，失败显示原因；超时保留后台任务", async () => {
  const states = [{ phase: "download", running: true }, { phase: "smoke", running: true }, { phase: "ready", ready: true }];
  const messages = [];
  const ready = await waitForPackageUpdate({ getJson: async () => ({ packageUpdate: states.shift() }), sleep: async () => {}, onProgress: (s) => messages.push(s) });
  assert.equal(ready.ready, true);
  assert.match(messages.join(" "), /下载.*启动.*重启/);
  await assert.rejects(waitForPackageUpdate({ getJson: async () => ({ packageUpdate: { error: "SHA 校验失败" } }) }), /SHA 校验失败/);
  let now = 0;
  await assert.rejects(waitForPackageUpdate({ getJson: async () => ({ packageUpdate: { running: true } }), now: () => now, timeoutMs: 10, sleep: async () => { now += 20; } }), /后台进行/);
});

test("Windows 有可用热更新包时可更新并保留完整安装包入口；进行中隐藏重启动作", () => {
  const state = { kind: "packaged", available: true, canApply: true, remoteVersion: "2.95.1", releaseUrl: "https://github.com/a/b/releases/tag/v2.95.1" };
  assert.deepEqual(buildSelfUpdateModel(state).actions.map((a) => a.id), ["self-update", "open-release"]);
  const progress = buildUpdateBannerModel({ compatibility: { reasons: ["restart-monitor"] } }, { desktop: true, selfUpdate: { ...state, packageUpdate: { running: true, phase: "install" } } });
  assert.match(progress.body, /应用更新/);
  assert.deepEqual(progress.actions, []);
});
