import assert from "node:assert/strict";
import test from "node:test";
import { createJobWatchService } from "./watch-service.mjs";
import { createJobWatchStore } from "./watch-store.mjs";

const NOW = 1791200000000;
const MIN = 60000;
const running = (id) => ({ id, name: `experiment_${id}`, state: "RUNNING", startAt: NOW - 3600000, endAt: null });
function harness({ initial = [running("1"), running("2")] } = {}) {
  let clock = NOW;
  let config = { servers: [{ id: "s1", host: "cluster" }] };
  let jobs = initial;
  let response = "";
  let execHook = null;
  const store = createJobWatchStore({ now: () => clock });
  const calls = [];
  const snapshot = () => ({ state: "ok", user: "me", checkedAt: clock, jobs });
  const service = createJobWatchService({
    store, getConfig: async () => config, getSnapshot: () => snapshot(), now: () => clock,
    registry: { lookup: (_serverId, id) => ({ jobId: id, user: "me", stdout: `/logs/${id}.log`, workDir: "/logs" }) },
    execCollector: async (inv) => { calls.push(inv); if (execHook) return execHook(); return { stdout: response, code: 0 }; },
  });
  return { store, service, calls, snapshot, time: (v) => { clock = v; }, jobs: (v) => { jobs = v; }, config: (v) => { config = v; }, response: (v) => { response = v; }, exec: (fn) => { execHook = fn; } };
}

test("关注立即返回waiting；批量新终态合并一条，已读/去重跨服务重建保持", async () => {
  const h = harness();
  const added = await h.service.change("s1", { action: "watch", jobIds: ["1", "2"], label: "实验组" });
  assert.equal(added.watches[0].jobs[0].progress.status, "waiting");
  assert.equal(h.calls.length, 0, "保存关注不发SSH");
  h.jobs([{ ...running("1"), state: "COMPLETED", endAt: NOW }, { ...running("2"), state: "FAILED", endAt: NOW }]);
  await h.service.scan("s1", h.snapshot());
  let v = await h.service.view("s1");
  assert.equal(v.notifications.length, 1);
  assert.deepEqual(v.notifications[0].jobIds, ["1", "2"]);
  assert.match(v.notifications[0].body, /1 完成 · 1 失败/);
  assert.match(v.notifications[0].title, /整组已结束/);
  await h.service.change(null, { action: "ack", notificationId: v.notifications[0].id });
  await h.service.scan("s1", h.snapshot());
  v = await h.service.view(null);
  assert.equal(v.notifications.length, 1);
  assert.equal(v.notifications[0].readAt, NOW);
  const restarted = createJobWatchService({ store: h.store, getConfig: async () => ({ servers: [{ id: "s1" }] }), getSnapshot: h.snapshot, registry: { lookup: () => null }, execCollector: async () => ({}), now: () => NOW });
  await restarted.scan("s1", h.snapshot());
  assert.equal((await restarted.view()).notifications.length, 1);
});

test("排队转运行只提醒一次，新增已运行关注不回放；全组完成有明确通知", async () => {
  const h = harness({ initial: [{ ...running("1"), state: "PENDING" }] });
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  h.jobs([running("1")]);
  await h.service.scan("s1", h.snapshot());
  await h.service.observeQueue("s1", { state: "ok", user: "me", jobs: [{ ...running("1"), user: "me" }] });
  assert.equal((await h.service.view()).notifications.filter((n) => n.kind === "started").length, 1);
  h.jobs([{ ...running("1"), state: "COMPLETED", endAt: NOW }]);
  await h.service.scan("s1", h.snapshot());
  assert.match((await h.service.view()).notifications[0].title, /全部完成/);
  const already = harness({ initial: [running("1")] });
  await already.service.change("s1", { action: "watch", jobIds: ["1"] });
  await already.service.scan("s1", already.snapshot());
  assert.equal((await already.service.view()).notifications.length, 0);
});

test("关注只接新鲜本人快照的具体作业，设置范围/重复关注/静音/全局免打扰", async () => {
  const h = harness();
  await assert.rejects(h.service.change("s1", { action: "watch", jobIds: ["9"] }), /本人作业/);
  await assert.rejects(h.service.change("s1", { action: "watch", jobIds: ["1_[1-9]"] }), /数组区间/);
  await assert.rejects(h.service.change("s1", { action: "settings", silenceMinutes: 1 }), /10–1440/);
  let v = await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  assert.equal((await h.service.view("s1")).watches.length, 1);
  await h.service.change("s1", { action: "mute", watchId: v.watches[0].id, muted: true });
  h.jobs([{ ...running("1"), state: "COMPLETED", endAt: NOW }]);
  await h.service.scan("s1", h.snapshot());
  assert.equal((await h.service.view()).notifications.length, 0);
  v = await h.service.change(null, { action: "settings", quietUntil: NOW + 3600000 });
  assert.equal(v.settings.quietUntil, NOW + 3600000);
  await assert.rejects(h.service.change(null, { action: "settings", quietUntil: NOW + 2 * 86400000 }), /24 小时/);
});

test("只提醒我的临近时限作业，同一组汇总且不随采样重复", async () => {
  const h = harness();
  await h.service.change("s1", { action: "watch", jobIds: ["1", "2"] });
  const q = { state: "ok", user: "me", jobs: [
    { ...running("1"), user: "me", timeLimitSec: 7200, elapsedSec: 6000 },
    { ...running("2"), user: "me", timeLimitSec: 7200, elapsedSec: 6500 },
    { ...running("3"), user: "other", timeLimitSec: 7200, elapsedSec: 7100 },
  ] };
  await h.service.observeQueue("s1", q);
  await h.service.observeQueue("s1", q);
  const v = await h.service.view();
  assert.equal(v.notifications.length, 1);
  assert.equal(v.notifications[0].kind, "limit");
  assert.deepEqual(v.notifications[0].jobIds, ["1", "2"]);
  await assert.rejects(h.service.change("s1", { action: "watch", jobIds: ["3"] }), /本人作业/);
});

test("运行日志连续安静才出一条疑似停滞；失败采样清除判断连续性", async () => {
  const h = harness({ initial: [running("1")] });
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  await h.service.change("s1", { action: "settings", silenceMinutes: 10 });
  const output = (t) => JSON.stringify({ k: "progress", id: "1", remoteNow: t / 1000, files: [{ p: "/logs/1.log", mt: NOW / 1000, sz: 300, t: "epoch 3 step 40" }] });
  for (const minutes of [0, 5, 10, 15]) {
    h.time(NOW + minutes * MIN); h.response(output(NOW + minutes * MIN));
    await h.service.scan("s1", h.snapshot());
  }
  let v = await h.service.view("s1");
  assert.equal(v.notifications.filter((n) => n.kind === "stalled").length, 1);
  assert.equal(v.watches[0].jobs[0].progress.status, "stalled");
  h.time(NOW + 20 * MIN); h.response(""); await h.service.scan("s1", h.snapshot());
  v = await h.service.view("s1");
  assert.equal(v.watches[0].jobs[0].progress.status, "unavailable");
  h.time(NOW + 25 * MIN); h.response(output(NOW + 25 * MIN)); await h.service.scan("s1", h.snapshot());
  assert.equal((await h.service.view("s1")).watches[0].jobs[0].progress.status, "ok");
});

test("模块关闭/服务器禁用过滤历史通知并禁止新采集；在途迟到结果不提醒", async () => {
  const h = harness({ initial: [running("1")] });
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  h.exec(async () => { h.config({ servers: [{ id: "s1", disabled: true }] }); return { stdout: "" }; });
  await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.length, 1);
  assert.deepEqual((await h.service.view()).notifications, []);
  assert.equal((await h.service.view("s1")).inactive, true);
  await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.length, 1);
  h.config({ servers: [{ id: "s1" }], modules: { jobs: false } });
  assert.deepEqual(await h.service.view(), { disabled: true });
  await assert.rejects(h.service.change("s1", { action: "watch", jobIds: ["1"] }), /模块已关闭/);
  h.config({ servers: [{ id: "s1" }] });
  h.jobs([{ ...running("1"), state: "COMPLETED", endAt: NOW }]);
  h.exec(async () => ({}));
  await h.service.scan("s1", h.snapshot());
  assert.deepEqual((await h.service.view()).notifications, [], "禁用期间的结束不在重新启用后补弹");
});

test("资源采集不要求关注，未知输出作业丢弃；复盘完成后不重复SSH", async () => {
  const h = harness({ initial: [{ ...running("1"), state: "COMPLETED", endAt: NOW }] });
  h.response(JSON.stringify({ k: "resource", id: "1", rows: [{ id: "1", cpus: "2", elapsed: "100", totalCpu: "00:02:00", maxRss: "" }, { id: "1.batch", maxRss: "1024K" }] }));
  await h.service.scan("s1", h.snapshot());
  let v = await h.service.view("s1");
  assert.equal(v.resources[0].cpuEfficiency, 0.6);
  assert.equal(v.resources[0].maxRssBytes, 1024 * 1024);
  assert.equal(v.watches.length, 0);
  await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.length, 1);
  v = await h.service.view("s1");
  assert.equal(v.resources.length, 1);
});

test("资源查询持续缺失最多重试3轮，明确给未知结果而非无限等候或填零", async () => {
  const h = harness({ initial: [{ ...running("1"), state: "COMPLETED", endAt: NOW }] });
  for (let i = 0; i < 4; i += 1) await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.length, 3);
  const v = await h.service.view("s1");
  assert.equal(v.resources[0].cpuEfficiency, null);
  assert.equal(v.resources[0].maxRssBytes, null);
  assert.match(v.resources[0].detail, /未能读取/);
});
