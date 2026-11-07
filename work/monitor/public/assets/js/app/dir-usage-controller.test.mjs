import assert from "node:assert/strict";
import { test } from "node:test";

import { createDirUsageController, DIR_USAGE_PROGRESS_POLL_MS, dirUsageEligible } from "./dir-usage-controller.js";
import { fakeDocument, fakeElement, fakeTimers } from "./test-support.mjs";

const CONFIG = { servers: [{ id: "s1", source: "team" }, { id: "me", source: "personal" }] };
const flush = () => new Promise((r) => setImmediate(r));

function setup({ getJson, postJson }) {
  const section = fakeElement({ tag: "section" });
  section.hidden = true;
  const toggle = fakeElement({ tag: "button" });
  const body = fakeElement({ querySelectorAll: () => [] });
  body.hidden = true;
  const doc = fakeDocument({ resDirUsage: section, resDirUsageToggle: toggle, resDirUsageBody: body });
  const docListeners = {};
  doc.addEventListener = (type, fn) => { docListeners[type] = fn; };
  doc.hidden = false;
  const toasts = [];
  const copied = [];
  const timers = fakeTimers();
  const ctrl = createDirUsageController({
    doc, getJson, postJson, showToast: (t) => toasts.push(t), getConfig: () => CONFIG, now: () => 0,
    copyText: (text) => copied.push(text),
    setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  ctrl.bind();
  return { ctrl, section, toggle, body, toasts, copied, timers, doc, docListeners };
}

test("入口只对团队集群显示；切到个人服务器隐藏", () => {
  assert.equal(dirUsageEligible({ source: "personal" }), false);
  assert.equal(dirUsageEligible({ source: "team", disabled: true }), false);
  assert.equal(dirUsageEligible(null), false);
  const { ctrl, section } = setup({ getJson: async () => ({}), postJson: async () => ({}) });
  ctrl.onStatus({ activeServerId: "s1" });
  assert.equal(section.hidden, false);
  ctrl.onStatus({ activeServerId: "me" });
  assert.equal(section.hidden, true);
});

test("展开只读本机结果（不扫描）；点「开始扫描」才 POST，扫描根随请求带上", async () => {
  const gets = [];
  const posts = [];
  const { ctrl, toggle, body, toasts } = setup({
    getJson: async (url) => { gets.push(url); return { eligible: true, serverId: "s1", root: "", saved: [], scan: null }; },
    postJson: async (url, payload) => {
      posts.push([url, payload]);
      return { eligible: true, serverId: "s1", root: "", saved: [], scan: { complete: false, root: "", scanned: { entries: 20000, dirsDone: 10, pendingDirs: 3 }, totals: { blocks: 1, size: 1, files: 1, dirs: 0 }, rootFiles: { blocks: 0, size: 0, files: 0 }, children: [], childrenRest: { count: 0, blocks: 0, size: 0 }, topFiles: [], runs: 1, updatedAt: 0 } };
    },
  });
  ctrl.onStatus({ activeServerId: "s1" });
  assert.equal(gets.length, 0, "收起时不读");
  await toggle.dispatch("click");
  await flush();
  assert.deepEqual(gets, ["/api/dir-usage?serverId=s1"]);
  assert.equal(posts.length, 0, "展开不触发扫描");
  assert.equal(body.hidden, false);
  assert.match(body.innerHTML, /开始扫描/);

  const btn = fakeElement({ tag: "button", dataset: { duScan: "start" }, parent: body });
  await body.dispatch("click", { target: btn });
  await flush();
  assert.deepEqual(posts, [["/api/dir-usage/scan", { serverId: "s1", root: "", mode: "start", auto: true }]], "交给后端自动续扫");
  assert.match(body.innerHTML, /已扫描部分：20,000 个条目，覆盖 10 个目录/);
  assert.equal(toasts.length, 0);

  // 选子目录：只读本机结果（GET 带 root），不发扫描
  const open = fakeElement({ tag: "button", dataset: { duRoot: "Digital_twin" }, parent: body });
  const ev = await body.dispatch("click", { target: open });
  await flush();
  assert.equal(ev.defaultPrevented, true);
  assert.equal(gets.at(-1), "/api/dir-usage?serverId=s1&root=Digital_twin");
  assert.equal(posts.length, 1);
});

test("扫描失败：显示后端给的原因并提示，不清空已有结果", async () => {
  const { ctrl, toggle, body, toasts } = setup({
    getJson: async () => ({ eligible: true, serverId: "s1", root: "", saved: [], scan: null }),
    postJson: async () => { throw Object.assign(new Error("HTTP 409"), { serverMessage: "这台服务器正在扫描，请稍候" }); },
  });
  ctrl.onStatus({ activeServerId: "s1" });
  await toggle.dispatch("click");
  await flush();
  await body.dispatch("click", { target: fakeElement({ dataset: { duScan: "start" }, parent: body }) });
  await flush();
  assert.match(body.innerHTML, /这台服务器正在扫描，请稍候/);
  assert.equal(toasts[0].type, "warn");
});

test("后端自动续扫期间：每 2 秒读一次进度，扫完提示一次并停表；收起面板或窗口不可见时不读，回来补上", async () => {
  const view = (entries, complete) => ({ complete, root: "", scanned: { entries, dirsDone: 10, pendingDirs: complete ? 0 : 3 }, totals: { blocks: 1, size: 1, files: 1, dirs: 0 }, rootFiles: { blocks: 0, size: 0, files: 0 }, children: [], childrenRest: { count: 0, blocks: 0, size: 0, overflow: false }, topFiles: [], runs: 1, updatedAt: 0, lastRun: null });
  const running = (rounds) => ({ root: "", running: true, stopping: false, rounds, startedAt: 0, endedAt: null, reason: null, error: null });
  let reply = { eligible: true, serverId: "s1", root: "", saved: [], scan: null, auto: null };
  const gets = [];
  const posts = [];
  const { ctrl, toggle, body, toasts, timers, doc, docListeners } = setup({
    getJson: async (url) => { gets.push(url); return structuredClone(reply); },
    postJson: async (url, payload) => { posts.push([url, payload]); return structuredClone(reply); },
  });
  ctrl.onStatus({ activeServerId: "s1" });
  await toggle.dispatch("click");
  await flush();
  assert.equal(timers.timeouts.size, 0, "没在扫就不轮询");

  reply = { ...reply, scan: view(20000, false), auto: running(1) };
  await body.dispatch("click", { target: fakeElement({ dataset: { duScan: "start" }, parent: body }) });
  await flush();
  assert.match(body.innerHTML, /正在自动扫描 · 第 2 轮 · 已扫 20,000 个条目/);
  assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [DIR_USAGE_PROGRESS_POLL_MS]);

  reply = { ...reply, scan: view(40000, false), auto: running(2) };
  timers.runTimeouts();
  await flush();
  assert.match(body.innerHTML, /第 3 轮 · 已扫 40,000 个条目/);
  assert.equal(timers.timeouts.size, 1, "接着读");

  // 窗口不可见：停表；回到可见立即补读。
  doc.hidden = true;
  docListeners.visibilitychange();
  assert.equal(timers.timeouts.size, 0);
  reply = { ...reply, scan: view(90000, false), auto: running(5) };
  doc.hidden = false;
  docListeners.visibilitychange();
  await flush();
  assert.match(body.innerHTML, /已扫 90,000 个条目/);

  // 点「停止」。
  reply = { ...reply, auto: { ...running(5), stopping: true } };
  await body.dispatch("click", { target: fakeElement({ dataset: { duScan: "stop" }, parent: body }) });
  await flush();
  assert.deepEqual(posts.at(-1), ["/api/dir-usage/stop", { serverId: "s1" }]);
  assert.match(body.innerHTML, /正在停止/);

  // 扫完：提示一次，停表。
  reply = { ...reply, scan: view(120000, true), auto: { ...running(7), running: false, reason: "done", endedAt: 1 } };
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts.map((t) => [t.type, t.message]), [["success", "已扫完。"]]);
  assert.equal(timers.timeouts.size, 0);
  assert.match(body.innerHTML, /已扫完 ~：120,000 个条目/);
});

test("自动续扫中途失败：读进度时看到就提示原因；展开面板时后端正在扫会先重读现状", async () => {
  const running = { root: "", running: true, stopping: false, rounds: 3, startedAt: 0, endedAt: null, reason: null, error: null };
  let reply = { eligible: true, serverId: "s1", root: "", saved: [], scan: null, auto: running };
  const gets = [];
  const { ctrl, toggle, toasts, timers } = setup({ getJson: async (url) => { gets.push(url); return structuredClone(reply); }, postJson: async () => ({}) });
  ctrl.onStatus({ activeServerId: "s1" });
  await toggle.dispatch("click");
  await flush();
  assert.equal(timers.timeouts.size, 1, "打开时后端已经在扫：直接开始读进度");
  await toggle.dispatch("click"); // 收起
  assert.equal(timers.timeouts.size, 0, "收起不读");
  await toggle.dispatch("click"); // 再展开
  await flush();
  assert.equal(gets.length, 2, "展开时重读一次现状");
  reply = { ...reply, auto: { ...running, running: false, reason: "error", error: "扫描超时（SSH 未在 25 秒内返回）", endedAt: 1 } };
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts.map((t) => [t.type, t.message]), [["warn", "扫描超时（SSH 未在 25 秒内返回）"]]);
  assert.equal(timers.timeouts.size, 0);
});

test("高密度小文件（Inode 预警）与一键复制精准清理命令", async () => {
  const scanData = {
    complete: true,
    root: "",
    scanned: { entries: 80000, dirsDone: 50, pendingDirs: 0 },
    totals: { blocks: 10000, size: 9000, files: 75000, dirs: 50 },
    rootFiles: { blocks: 0, size: 0, files: 0 },
    children: [
      {
        name: ".conda",
        rel: ".conda",
        blocks: 9000,
        size: 8500,
        files: 65000,
        dirs: 40,
        highFileDensity: true,
        partial: false,
        queued: false,
        sub: [],
        subRest: { blocks: 9000, size: 8500, dirs: 0 },
      },
    ],
    childrenRest: { count: 0, blocks: 0, size: 0, overflow: false },
    knownCaches: [
      {
        rel: ".conda",
        label: "Conda 环境与包缓存",
        hint: "可用 conda clean -a 清理",
        cleanCmd: "conda clean -a -y",
        blocks: 9000,
        size: 8500,
        files: 65000,
        dirs: 40,
        highFileDensity: true,
      },
    ],
    topFiles: [],
    runs: 1,
    updatedAt: 0,
  };
  const { ctrl, toggle, body, toasts, copied } = setup({
    getJson: async () => ({ eligible: true, serverId: "s1", root: "", saved: [], scan: scanData }),
    postJson: async () => ({}),
  });
  ctrl.onStatus({ activeServerId: "s1" });
  await toggle.dispatch("click");
  await flush();
  assert.match(body.innerHTML, /du-inode-warn[^>]*>小文件密集<\/span>/);
  assert.match(body.innerHTML, /data-du-copy-cmd="conda clean -a -y"[^>]*>复制清理命令<\/button>/);

  const copyBtn = fakeElement({ tag: "button", dataset: { duCopyCmd: "conda clean -a -y" }, parent: body });
  await body.dispatch("click", { target: copyBtn });
  await flush();
  assert.deepEqual(copied, ["conda clean -a -y"]);
  assert.equal(toasts.at(-1)?.type, "success");
  assert.match(toasts.at(-1)?.message || "", /conda clean -a -y/);
});

