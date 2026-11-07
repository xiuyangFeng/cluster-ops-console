import assert from "node:assert/strict";
import { test } from "node:test";

import { createDirUsageController } from "./dir-usage-controller.js";
import { createDiskGrowthController, DISK_GROWTH_PROGRESS_POLL_MS } from "./disk-growth-controller.js";
import { fakeDocument, fakeElement, fakeTimers, flush } from "./test-support.mjs";

const GIB = 2 ** 30;
const growth = (over = {}) => ({
  measuredAt: 1000, complete: true, stop: null, trigger: "schedule", refAt: null, spanMs: null, label: "",
  roots: [{ root: "proj/outputs", jobs: 12, state: "ok", error: null, at: 1000, children: 2, bytes: 5 * GIB, delta: null, partial: false }],
  rows: [{ root: "proj/outputs", name: "b1", bytes: 5 * GIB, partial: false, at: 1000, delta: null, lowerBound: false, isNew: false }],
  rowCount: 1, total: { bytes: 5 * GIB, delta: null, partial: false }, share: null, attempt: { at: 1000, outcome: "ok", error: null }, ...over,
});
const idle = (over = {}) => ({ eligible: true, serverId: "s1", running: false, run: null, growth: growth(), ...over });
const measuring = (rounds, over = {}) => idle({ running: true, run: { trigger: "manual", startedAt: 0, rounds, rootIndex: 0, rootCount: 1 }, ...over });

function setup({ getJson, postJson, host = fakeElement() }) {
  if (host) host.hidden = true;
  const doc = fakeDocument(host ? { resDiskGrowth: host } : {});
  doc.hidden = false;
  const toasts = [];
  const timers = fakeTimers();
  const ctrl = createDiskGrowthController({
    doc, getJson, postJson, showToast: (t) => toasts.push(t), now: () => 2000,
    setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  ctrl.bind();
  return { ctrl, host, doc, toasts, timers };
}
const clickScan = (host) => host.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dgScan: "" }, parent: host }) });

test("展开才读本机结果（不发扫描）；没有集合目录时整块不显示；收起即藏", async () => {
  const gets = [];
  const posts = [];
  let reply = { eligible: true, serverId: "s1", running: false, run: null, growth: null };
  const { ctrl, host } = setup({ getJson: async (url) => { gets.push(url); return structuredClone(reply); }, postJson: async (...args) => { posts.push(args); return {}; } });
  ctrl.setServer("s1");
  assert.deepEqual(gets, [], "收起时不读");
  ctrl.setExpanded(true);
  await flush();
  assert.deepEqual(gets, ["/api/disk-growth?serverId=s1"]);
  assert.deepEqual([host.hidden, host.innerHTML], [true, ""], "没有集合目录：不占地方");

  reply = idle();
  ctrl.setExpanded(false);
  ctrl.setExpanded(true);
  await flush();
  assert.equal(gets.length, 2, "每次展开都重读");
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /作业产出目录/);
  assert.match(host.innerHTML, /outputs\/b1/);
  ctrl.setExpanded(false);
  assert.deepEqual([host.hidden, host.innerHTML], [true, ""]);
  assert.equal(posts.length, 0, "展开 / 收起都不触发测量");
});

test("现在量一次：POST 后每 3 秒读进度，量完提示一次并停表；窗口不可见时不读，回来补上", async () => {
  let reply = idle();
  const gets = [];
  const posts = [];
  const { ctrl, host, doc, toasts, timers } = setup({
    getJson: async (url) => { gets.push(url); return structuredClone(reply); },
    postJson: async (url, body) => { posts.push([url, body]); return structuredClone(reply); },
  });
  ctrl.setServer("s1");
  ctrl.setExpanded(true);
  await flush();
  assert.equal(timers.timeouts.size, 0, "没在量就不轮询");

  reply = measuring(0);
  await clickScan(host);
  await flush();
  assert.deepEqual(posts, [["/api/disk-growth/scan", { serverId: "s1" }]]);
  assert.match(host.innerHTML, /正在量 · 第 1 轮/);
  assert.match(host.innerHTML, /data-dg-scan disabled/);
  assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [DISK_GROWTH_PROGRESS_POLL_MS]);
  await clickScan(host);
  assert.equal(posts.length, 1, "正在量时再点不重复发");

  reply = measuring(4);
  timers.runTimeouts();
  await flush();
  assert.match(host.innerHTML, /正在量 · 第 5 轮/);
  assert.equal(timers.timeouts.size, 1);

  doc.hidden = true;
  ctrl.onVisibilityChange();
  assert.equal(timers.timeouts.size, 0, "窗口不可见：停表");
  reply = measuring(9);
  doc.hidden = false;
  ctrl.onVisibilityChange();
  await flush();
  assert.match(host.innerHTML, /正在量 · 第 10 轮/);

  reply = idle({ growth: growth({ measuredAt: 1900 }) });
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts.map((t) => [t.type, t.message]), [["success", "已量完。"]]);
  assert.equal(timers.timeouts.size, 0);
  assert.match(host.innerHTML, /data-dg-scan>现在量一次/);
});

test("量完的三种结果各说各的；定时的那种量完不弹提示", async () => {
  for (const [end, expected] of [
    [idle({ growth: growth({ complete: false, stop: "deadline", attempt: { at: 1, outcome: "partial", error: null } }) }), ["info", "这次没量完，没量完的目录已标出。"]],
    [idle({ growth: growth({ measuredAt: null, attempt: { at: 1, outcome: "error", error: "SSH 在 20 秒内没有返回" } }) }), ["warn", "SSH 在 20 秒内没有返回"]],
  ]) {
    let reply = idle();
    const { ctrl, host, toasts, timers } = setup({ getJson: async () => structuredClone(reply), postJson: async () => structuredClone(reply) });
    ctrl.setServer("s1");
    ctrl.setExpanded(true);
    await flush();
    reply = measuring(0);
    await clickScan(host);
    await flush();
    reply = end;
    timers.runTimeouts();
    await flush();
    assert.deepEqual(toasts.map((t) => [t.type, t.message]), [expected]);
  }
  // 展开时后端正好在定时测量：照样跟进度，量完不打扰
  let reply = measuring(2, { run: { trigger: "schedule", startedAt: 0, rounds: 2, rootIndex: 0, rootCount: 1 } });
  const { ctrl, host, toasts, timers } = setup({ getJson: async () => structuredClone(reply), postJson: async () => ({}) });
  ctrl.setServer("s1");
  ctrl.setExpanded(true);
  await flush();
  assert.match(host.innerHTML, /正在量 · 第 3 轮/);
  assert.equal(timers.timeouts.size, 1);
  reply = idle();
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts, []);
  assert.equal(timers.timeouts.size, 0);
});

test("量不了：显示后端给的原因并提示，已有结果留着；读不到接口时安静地不显示", async () => {
  const { ctrl, host, toasts } = setup({
    getJson: async () => idle(),
    postJson: async () => { throw Object.assign(new Error("HTTP 409"), { serverMessage: "这台服务器正在扫描目录占用，等它结束再量" }); },
  });
  ctrl.setServer("s1");
  ctrl.setExpanded(true);
  await flush();
  await clickScan(host);
  await flush();
  assert.match(host.innerHTML, /data-level="warn">这台服务器正在扫描目录占用，等它结束再量</);
  assert.match(host.innerHTML, /outputs\/b1/, "原来的结果还在");
  assert.match(host.innerHTML, /data-dg-scan>现在量一次/, "可以再点");
  assert.deepEqual(toasts.map((t) => t.type), ["warn"]);

  const quiet = setup({ getJson: async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); }, postJson: async () => ({}) });
  quiet.ctrl.setServer("s1");
  quiet.ctrl.setExpanded(true);
  await flush();
  assert.deepEqual([quiet.host.hidden, quiet.host.innerHTML, quiet.toasts.length], [true, "", 0]);
});

test("换服务器：旧结果立刻清掉，迟到的回应不会画到新服务器上；页面上没有这块容器时什么都不做", async () => {
  const pending = [];
  const { ctrl, host } = setup({
    getJson: (url) => new Promise((resolve) => { pending.push({ url, resolve }); }),
    postJson: async () => ({}),
  });
  ctrl.setServer("s1");
  ctrl.setExpanded(true);
  ctrl.setServer("s2");
  assert.deepEqual(pending.map((p) => p.url), ["/api/disk-growth?serverId=s1", "/api/disk-growth?serverId=s2"]);
  pending[1].resolve(idle({ serverId: "s2", growth: growth({ rows: [{ ...growth().rows[0], name: "from-s2" }] }) }));
  await flush();
  pending[0].resolve(idle({ growth: growth({ rows: [{ ...growth().rows[0], name: "from-s1" }] }) }));
  await flush();
  assert.match(host.innerHTML, /from-s2/);
  assert.ok(!host.innerHTML.includes("from-s1"));
  ctrl.setServer(null);
  assert.deepEqual([host.hidden, host.innerHTML], [true, ""], "切到个人服务器：不显示");

  const gets = [];
  const bare = setup({ host: null, getJson: async (url) => { gets.push(url); return idle(); }, postJson: async () => ({}) });
  bare.ctrl.setServer("s1");
  bare.ctrl.setExpanded(true);
  bare.ctrl.onVisibilityChange();
  await flush();
  assert.deepEqual(gets, []);
});

test("接线：跟着目录占用面板的服务器与展开状态走，各读各的接口，互不影响", async () => {
  const section = fakeElement({ tag: "section" });
  const toggle = fakeElement({ tag: "button" });
  const body = fakeElement({ querySelectorAll: () => [] });
  const host = fakeElement();
  host.hidden = true;
  const doc = fakeDocument({ resDirUsage: section, resDirUsageToggle: toggle, resDirUsageBody: body, resDiskGrowth: host });
  let onVisibility = null;
  doc.addEventListener = (type, fn) => { if (type === "visibilitychange") onVisibility = fn; };
  doc.hidden = false;
  const gets = [];
  const posts = [];
  let growthReply = idle();
  const timers = fakeTimers();
  const ctrl = createDirUsageController({
    doc,
    getJson: async (url) => {
      gets.push(url);
      return url.startsWith("/api/disk-growth") ? structuredClone(growthReply) : { eligible: true, serverId: "s1", root: "", saved: [], scan: null, auto: null };
    },
    postJson: async (url, payload) => { posts.push([url, payload]); return structuredClone(growthReply); },
    showToast: () => {},
    getConfig: () => ({ servers: [{ id: "s1", source: "team" }, { id: "s2", source: "team" }, { id: "me", source: "personal" }] }),
    now: () => 2000,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  ctrl.bind();
  ctrl.onStatus({ activeServerId: "s1" });
  assert.deepEqual(gets, []);
  await toggle.dispatch("click");
  await flush();
  assert.deepEqual([...gets].sort(), ["/api/dir-usage?serverId=s1", "/api/disk-growth?serverId=s1"]);
  assert.match(host.innerHTML, /作业产出目录/);
  assert.match(body.innerHTML, /开始扫描/);
  assert.ok(!body.innerHTML.includes("作业产出目录"), "两块各画各的容器");

  // 点「现在量一次」只发磁盘增长的 POST；窗口回到可见时两边各自补读
  growthReply = measuring(0);
  await clickScan(host);
  await flush();
  assert.deepEqual(posts, [["/api/disk-growth/scan", { serverId: "s1" }]]);
  doc.hidden = true;
  onVisibility();
  assert.equal(timers.timeouts.size, 0);
  doc.hidden = false;
  gets.length = 0;
  onVisibility();
  await flush();
  assert.deepEqual(gets, ["/api/disk-growth?serverId=s1"], "目录占用没在扫，只有这一块补读进度");

  // 切服务器、切到个人服务器、收起
  growthReply = idle({ serverId: "s2" });
  gets.length = 0;
  ctrl.onStatus({ activeServerId: "s2" });
  await flush();
  assert.deepEqual([...gets].sort(), ["/api/dir-usage?serverId=s2", "/api/disk-growth?serverId=s2"]);
  ctrl.onStatus({ activeServerId: "me" });
  assert.deepEqual([section.hidden, host.hidden], [true, true]);
  ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.equal(host.hidden, false);
  await toggle.dispatch("click");
  assert.deepEqual([host.hidden, body.hidden], [true, true]);
});
