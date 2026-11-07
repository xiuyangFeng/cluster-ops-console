import assert from "node:assert/strict";
import test from "node:test";
import { createJobWatchController } from "./job-watch-controller.js";
import { deferred, fakeElement, fakeTimers, flush } from "./test-support.mjs";

function fixture(options = {}) {
  const timers = fakeTimers();
  const controller = createJobWatchController({
    getJson: async () => ({ watches: [], resources: [] }), postJson: async () => ({ watches: [] }),
    setTimer: timers.setTimeout, clearTimer: timers.clearTimeout, ...options,
  });
  return { controller, timers };
}

test("切服务器时丢弃迟到读取，关注与资源不会串到新服务器", async () => {
  const old = deferred();
  const { controller } = fixture({ getJson: (url) => url.endsWith("old") ? old.promise : Promise.resolve({ serverId: "new", watches: [] }) });
  controller.setServer("old");
  const p = controller.refresh();
  controller.setServer("new");
  await controller.refresh();
  old.resolve({ serverId: "old", watches: [{ id: "old-watch" }] });
  await p;
  assert.equal(controller.state().data.serverId, "new");
  controller.stop();
});

test("已完成关注写入不会被较早的在途轮询覆盖", async () => {
  const old = deferred();
  const { controller } = fixture({ getJson: () => old.promise, postJson: async (_url, body) => ({ watches: [{ id: "w", jobIds: body.jobIds }] }) });
  controller.setServer("server");
  const pending = controller.refresh();
  assert.equal(await controller.watch(["12"], "experiment"), true);
  old.resolve({ watches: [] });
  await pending;
  assert.deepEqual([...controller.watchedIds()], ["12"]);
  controller.stop();
});

test("模块关闭后停止轮询且不允许关注写入，失败保存可重试", async () => {
  let writes = 0;
  const toasts = [];
  const { controller } = fixture({ postJson: async () => { writes += 1; throw new Error("offline"); }, showToast: (item) => toasts.push(item) });
  controller.setServer("server");
  assert.equal(await controller.watch(["12"], "x"), false);
  assert.match(toasts[0].message, /offline/);
  assert.equal(await controller.watch(["12"], "x"), false);
  assert.equal(writes, 2);
  controller.setEnabled(false);
  assert.equal(await controller.watch(["12"], "x"), false);
  assert.equal(writes, 2);
  controller.stop();
});

test("刷新通知调用方重新渲染时已有下轮计时器，不循环自刷新", async () => {
  let reads = 0;
  let controller;
  ({ controller } = fixture({ getJson: async () => { reads += 1; return { watches: [] }; }, onChange: () => controller.sync() }));
  controller.setServer("server");
  await controller.refresh();
  assert.equal(reads, 1);
  controller.stop();
});

test("关注写入期间的状态重绘或手动刷新不发起旧读取", async () => {
  let reads = 0;
  const response = deferred();
  const { controller } = fixture({ getJson: async () => { reads += 1; return { watches: [] }; }, postJson: () => response.promise });
  controller.setServer("server");
  const saving = controller.watch(["12"], "experiment");
  controller.sync();
  await controller.refresh();
  assert.equal(reads, 0);
  response.resolve({ watches: [{ id: "w", jobIds: ["12"] }] });
  await saving;
  assert.deepEqual([...controller.watchedIds()], ["12"]);
  controller.stop();
});

test("v2.62：队列里的「已关注」只认手动关注；自动组的移除是停用规则，提示照实说", async () => {
  const posts = [];
  const toasts = [];
  const watches = [
    { id: "m", label: "手动", jobIds: ["1", "2"], jobs: [] },
    { id: "a", label: "xp_*", jobIds: ["3", "4"], auto: { rule: "name:xp_*" }, jobs: [] },
  ];
  const { controller } = fixture({
    getJson: async () => ({ serverId: "server", watches, resources: [], rules: { failNotify: true, longRunMinutes: null, patterns: ["xp_*"] } }),
    postJson: async (url, body) => { posts.push([url, body]); return { serverId: "server", watches: watches.filter((w) => w.id !== body.watchId), resources: [] }; },
    showToast: (item) => toasts.push(item),
  });
  const root = fakeElement({ querySelector: () => null });
  controller.setServer("server");
  controller.bind(root);
  await controller.refresh();
  assert.deepEqual([...controller.watchedIds()].sort(), ["1", "2"], "自动关注着的作业仍可以手动关注（由手动组接管）");
  assert.deepEqual([...controller.watchedGroups()], ["1,2"]);

  await root.dispatch("click", { target: fakeElement({ dataset: { watchRemove: "a", watchAuto: "true" } }) });
  await flush();
  assert.deepEqual(posts.at(-1), ["/api/jobs/watch?serverId=server", { action: "unwatch", watchId: "a" }]);
  assert.match(toasts.at(-1).message, /已停用这条规则/);
  await root.dispatch("click", { target: fakeElement({ dataset: { watchRemove: "m" } }) });
  await flush();
  assert.equal(toasts.at(-1).message, "已取消关注");
  await root.dispatch("click", { target: fakeElement({ dataset: { watchMute: "a", muted: "false" } }) });
  await flush();
  assert.deepEqual(posts.at(-1)[1], { action: "mute", watchId: "a", muted: true }, "自动组照样可以静音");
  controller.stop();
});
