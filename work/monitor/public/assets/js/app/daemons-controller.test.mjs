import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDaemonsHtml, buildServicesHtml, localForwardUrl } from "../render/daemons-view.js";
import { createDaemonsController, DAEMONS_POLL_MS, daemonsEligible, forwardToast, SERVICES_OPEN_STORAGE_KEY, startToast } from "./daemons-controller.js";
import { deferred, fakeDocument, fakeElement, fakeTimers, flush } from "./test-support.mjs";

const CONFIG = { servers: [{ id: "s1", name: "主集群", source: "team" }, { id: "s2", source: "team" }, { id: "me", source: "personal" }] };
const daemon = (id, state, extra = {}) => ({ id, label: id === "paseo" ? "Paseo" : "T3 Code", port: id === "paseo" ? 6767 : 3773, state, version: null, note: "", ...extra });
const view = (states, extra = {}) => ({
  eligible: true, serverId: "s1", serverName: "主集群", checkedAt: Date.UTC(2026, 9, 7, 4, 5, 6), reachable: true, error: null, starting: null,
  daemons: [daemon("paseo", states[0], { version: "0.10.3" }), daemon("t3code", states[1])],
  ...extra,
});

// 服务组默认收起；多数用例看的是展开后的行，所以这里默认给一份「上次展开过」的存储。
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
};

function setup({ getJson, postJson = async () => ({}), visibleViews = new Set(["servers"]), openUrl = null, storage = memoryStorage({ [SERVICES_OPEN_STORAGE_KEY]: "1" }) } = {}) {
  const panel = fakeElement({ tag: "article" });
  const body = fakeElement();
  const badge = fakeElement({ tag: "span" });
  const refreshBtn = fakeElement({ tag: "button" });
  const doc = fakeDocument({ daemonsPanel: panel, daemonsBody: body, daemonsServer: badge, daemonsRefreshBtn: refreshBtn });
  const timers = fakeTimers();
  const toasts = [];
  const gets = [];
  const posts = [];
  const opened = [];
  const copied = [];
  let panelHidden = false;
  let hidden = false;
  const visListeners = [];
  const ctrl = createDaemonsController({
    doc,
    getJson: async (url) => { gets.push(url); return getJson(url); },
    postJson: async (url, payload) => { posts.push([url, payload]); return postJson(url, payload); },
    showToast: (t) => toasts.push(t),
    getConfig: () => CONFIG,
    isViewVisible: (v) => visibleViews.has(v),
    isHidden: () => hidden,
    onVisibilityChange: (fn) => visListeners.push(fn),
    isPanelHidden: () => panelHidden,
    openUrl: openUrl ?? ((url) => opened.push(url)),
    copyText: (text) => copied.push(text),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    storage,
  });
  ctrl.bind();
  return {
    ctrl, panel, body, badge, refreshBtn, timers, toasts, gets, posts, opened, copied, visibleViews,
    setPanelHidden: (v) => { panelHidden = v; },
    setWindowHidden: (v) => { hidden = v; for (const fn of visListeners) fn(); },
  };
}

test("范围：只对团队集群显示；个人服务器把面板藏起来且不发请求", async () => {
  assert.equal(daemonsEligible({ source: "personal" }), false);
  assert.equal(daemonsEligible({ id: "x", monitorEnabled: false }), false);
  assert.equal(daemonsEligible(null), false);
  const h = setup({ getJson: async () => view(["running", "running"]) });
  h.ctrl.onStatus({ activeServerId: "me" });
  assert.equal(h.panel.hidden, true);
  assert.equal(h.gets.length, 0);
  assert.equal(h.timers.timeouts.size, 0, "不提供时不排轮询");
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.equal(h.panel.hidden, false);
  assert.deepEqual(h.gets, ["/api/daemons?serverId=s1"]);
  assert.equal(h.badge.textContent, "主集群");
  assert.match(h.body.innerHTML, /Paseo.*:6767.*运行中 · v0\.10\.3/);
  assert.doesNotMatch(h.body.innerHTML, /data-dm-start/, "都在运行时没有启动按钮");
});

test("轮询：只在服务器页可见时排 60 秒一轮；离开 / 窗口隐藏 / 面板隐藏 / 模块关闭即停表", async () => {
  const h = setup({ getJson: async () => view(["running", "running"]) });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.equal(h.timers.timeouts.size, 1);
  assert.equal([...h.timers.timeouts.values()][0].ms, DAEMONS_POLL_MS);
  h.timers.runTimeouts();
  await flush();
  assert.equal(h.gets.length, 2);
  assert.equal(h.timers.timeouts.size, 1, "一轮结束续上下一轮");

  h.visibleViews.clear();
  h.ctrl.leave();
  assert.equal(h.timers.timeouts.size, 0, "离开服务器页停表");
  h.visibleViews.add("servers");
  h.ctrl.enter();
  await flush();
  assert.equal(h.gets.length, 3, "回到服务器页立即读一次");
  assert.equal(h.timers.timeouts.size, 1);

  h.setWindowHidden(true);
  assert.equal(h.timers.timeouts.size, 0, "窗口隐藏停表");
  h.setWindowHidden(false);
  await flush();
  assert.equal(h.gets.length, 4);

  h.setPanelHidden(true);
  h.ctrl.leave();
  assert.equal(h.timers.timeouts.size, 0, "面板被隐藏停表");
  h.setPanelHidden(false);

  h.ctrl.onStatus({ activeServerId: "s1", modules: { daemons: false } });
  assert.equal(h.timers.timeouts.size, 0, "模块关闭停表");
  const before = h.gets.length;
  h.ctrl.onStatus({ activeServerId: "s1", modules: { daemons: true } });
  await flush();
  assert.equal(h.gets.length, before + 1, "模块重新打开立即读一次");
});

test("启动：先行内确认，确认后才 POST（带 serverId），进行中按钮禁用；用返回的状态重绘并 toast", async () => {
  const pending = deferred();
  const h = setup({ getJson: async () => view(["running", "stopped"]), postJson: () => pending.promise });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.match(h.body.innerHTML, /data-dm-start="t3code"/);
  assert.doesNotMatch(h.body.innerHTML, /data-dm-start="paseo"/, "运行中的不给启动按钮");

  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmStart: "t3code" }, parent: h.body }) });
  assert.equal(h.posts.length, 0, "点「启动」只进入确认");
  assert.match(h.body.innerHTML, /在 主集群 上启动 T3 Code？/);
  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmCancel: "t3code" }, parent: h.body }) });
  assert.doesNotMatch(h.body.innerHTML, /确认启动/, "取消回到原样");

  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmStart: "t3code" }, parent: h.body }) });
  h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmConfirm: "t3code" }, parent: h.body }) });
  await flush();
  assert.deepEqual(h.posts, [["/api/daemons/start", { daemon: "t3code", serverId: "s1" }]]);
  assert.match(h.body.innerHTML, /正在启动…/);
  assert.equal(h.refreshBtn.disabled, true);
  // 进行中再点确认不会发第二个请求
  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmConfirm: "t3code" }, parent: h.body }) });
  assert.equal(h.posts.length, 1);

  pending.resolve({ daemon: "t3code", result: "started", ok: true, status: view(["running", "running"]) });
  await flush();
  assert.equal(h.toasts[0].type, "success");
  assert.match(h.toasts[0].message, /T3 Code 已启动/);
  assert.doesNotMatch(h.body.innerHTML, /正在启动|data-dm-start/);
  assert.equal(h.refreshBtn.disabled, false);
});

test("启动：没有返回状态（结果不确定 / 请求失败）时强制重读一次", async () => {
  const h = setup({ getJson: async () => view(["stopped", "running"]), postJson: async () => { throw Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "正在启动 T3 Code，请稍候" }); } });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmStart: "paseo" }, parent: h.body }) });
  await h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset: { dmConfirm: "paseo" }, parent: h.body }) });
  await flush();
  assert.equal(h.toasts[0].message, "正在启动 T3 Code，请稍候");
  assert.equal(h.gets.at(-1), "/api/daemons?serverId=s1&fresh=1");
});

test("切换服务器：清掉旧数据与确认态，晚到的旧服务器结果不覆盖新服务器", async () => {
  const slow = deferred();
  const h = setup({ getJson: (url) => (url.includes("s1") ? slow.promise : Promise.resolve(view(["stopped", "stopped"], { serverId: "s2", serverName: "s2" }))) });
  h.ctrl.onStatus({ activeServerId: "s1" });
  h.ctrl.onStatus({ activeServerId: "s2" });
  await flush();
  slow.resolve(view(["running", "running"]));
  await flush();
  assert.match(h.body.innerHTML, /未运行/);
  assert.doesNotMatch(h.body.innerHTML, /运行中/);
  assert.equal(h.badge.textContent, "s2");
});

test("视图：读失败无旧数据 → 说明；SSH 取不到 → 状态未知 + 原因；missing 不给启动；文案转义", () => {
  assert.match(buildDaemonsHtml(null, { error: "读取守护进程状态失败" }), /读取守护进程状态失败/);
  assert.match(buildDaemonsHtml(null, { loading: true }), /正在检查/);
  const unreachable = buildDaemonsHtml(view(["unknown", "unknown"], { reachable: false, error: "auth: <检查密钥>" }));
  assert.match(unreachable, /这一轮取不到状态：auth: &lt;检查密钥&gt;/);
  assert.match(unreachable, /状态未知/);
  assert.doesNotMatch(unreachable, /data-dm-start/);
  const missing = buildDaemonsHtml(view(["missing", "stopped"]));
  assert.doesNotMatch(missing, /data-dm-start="paseo"/);
  assert.match(missing, /未安装 · v0\.10\.3 · 服务器上没找到程序/);
  const starting = buildDaemonsHtml(view(["stopped", "stopped"], { starting: "paseo" }));
  assert.match(starting, /正在启动…/);
  assert.match(starting, /data-dm-start="t3code" disabled/, "另一窗口在启动时其余按钮也禁用");
  assert.doesNotMatch(buildDaemonsHtml(view(["running", "running"])), /dm-foot/, "说明挪进刷新按钮的悬停提示，不再占一行");
});

test("启动结果文案", () => {
  assert.equal(startToast({ result: "alreadyRunning" }, "Paseo").type, "info");
  assert.match(startToast({ result: "failed", detail: "EADDRINUSE" }, "Paseo").message, /EADDRINUSE/);
  assert.match(startToast({ result: "missing" }, "Paseo").message, /需先安装/);
  assert.match(startToast({ result: "unknown", error: "SSH 未在 115 秒内返回" }, "Paseo").message, /SSH 未在 115 秒内返回。稍后刷新/);
});

// ---- v2.62 服务直达：「我在这台服务器上的服务」一组 ----

const svc = (port, extra = {}) => ({
  port, name: "python", pid: 3301234, procCount: 1, binds: ["127.0.0.1"], scope: "loopback", forwardable: true,
  cmdline: `python -m http.server ${port} --bind 127.0.0.1`, cwd: "~/Digital_twin/GNN/outputs/report", uptimeSec: 11520, ...extra,
});
const fwd = (port, localPort, extra = {}) => ({ serverId: "s1", port, localPort, url: `http://127.0.0.1:${localPort}/`, startedAt: Date.UTC(2026, 9, 12, 2, 0, 0), expiresAt: Date.UTC(2026, 9, 12, 4, 0, 0), ...extra });
const withServices = (services, forwards = [], extra = {}) => view(["running", "running"], { services, servicesState: "ok", servicesMore: 0, forwardBlocked: null, forwards, forwardLimit: 4, ...extra });
const clickOn = (h, dataset) => h.body.dispatch("click", { target: fakeElement({ tag: "button", dataset, parent: h.body }) });

test("服务组：没有服务也没有转发时整组不出现；有服务时一行一个——进程、端口、监听地址、运行时长、工作目录、「打开」", () => {
  assert.equal(buildServicesHtml(withServices([])), "");
  assert.doesNotMatch(buildDaemonsHtml(view(["running", "running"])), /dm-group|dm-svc/, "旧版后端的响应没有 services 字段，照常只画两行");
  const html = buildDaemonsHtml(withServices([svc(8814), svc(8765, { binds: ["0.0.0.0", "::"], scope: "all", cwd: "", procCount: 3, uptimeSec: 190000 })]));
  assert.match(html, /<h3 class="dm-group"><button type="button" class="text-btn dm-group-toggle" data-dm-toggle aria-expanded="true">我在这台服务器上的服务<\/button><span class="dm-count">2 个<\/span><span class="dm-tag" data-level="warn">1 个对所有网卡开放<\/span><\/h3><ul class="dm-list">/);
  assert.equal(html.match(/class="dm-row dm-svc"/g).length, 2);
  assert.match(html, /<span class="dm-name" title="python -m http\.server 8814 --bind 127\.0\.0\.1">python<\/span><span class="dm-addr">:8814<\/span><span class="dm-sub">127\.0\.0\.1 · 已运行 3 小时 12 分<\/span><\/div>/, "命令行在进程名的悬停提示里");
  assert.match(html, /<div class="dm-note-line dm-cwd" title="工作目录">~\/Digital_twin\/GNN\/outputs\/report<\/div>/);
  assert.match(html, /<button type="button" class="btn btn-secondary dm-btn" data-dm-open="8814" title="临时转发到这台电脑并在浏览器打开；最长 2 小时，可以随时关闭">打开<\/button>/);
  assert.match(html, /<span class="dm-sub">0\.0\.0\.0、:: · 已运行 2 天 4 小时 · 3 个进程<\/span><span class="dm-tag" data-level="warn" title="[^"]*不是只有集群本机能访问">对所有网卡开放<\/span>/);
  assert.equal(html.match(/>对所有网卡开放</g).length, 1, "只绑回环的不标（组名那一行另有一句合计）");
  assert.equal(html.match(/dm-cwd/g).length, 1, "没有工作目录就不占一行");
  assert.match(buildServicesHtml(withServices([svc(8815, { cwd: "~", kind: { id: "jupyter", label: "Jupyter" } })])), /<span class="dm-tag" data-kind="jupyter">Jupyter<\/span>[\s\S]*title="工作目录">~（家目录）<\/div>/);
  // 守护进程两行还在最前面。
  assert.ok(html.indexOf("Paseo") < html.indexOf("dm-group") && html.indexOf("T3 Code") < html.indexOf("dm-group"));
});

test("服务组：已转发的显示本机地址（可点、新标签页打开）、「复制」与「关闭」；转发不了、密码连接、开满、没列全各有说法", () => {
  const forwarded = buildServicesHtml(withServices([svc(8814), svc(8815)], [fwd(8814, 51814)]));
  assert.match(forwarded, /<li class="dm-row dm-svc" data-state="forwarded">/);
  assert.match(forwarded, /<a class="dm-fwd" href="http:\/\/127\.0\.0\.1:51814\/" target="_blank" rel="noopener noreferrer" title="在浏览器打开。[^"]*自动收回，也可以随时关闭">127\.0\.0\.1:51814<\/a><button type="button" class="text-btn dm-copy" data-dm-copy="http:\/\/127\.0\.0\.1:51814\/"[^>]*>复制<\/button><button type="button" class="text-btn dm-cancel" data-dm-close="8814">关闭<\/button>/);
  assert.doesNotMatch(forwarded, /data-dm-open="8814"/, "已转发的不再给「打开」");
  assert.match(forwarded, /data-dm-open="8815"/);
  // 响应里的 url 不被采用：地址只用端口号现拼。
  assert.doesNotMatch(buildServicesHtml(withServices([svc(8814)], [fwd(8814, 51814, { url: "http://evil.example/" })])), /evil/);
  assert.equal(localForwardUrl(51814), "http://127.0.0.1:51814/");
  for (const bad of ["51814/evil", 0, 70000, null, "x", 1.5]) assert.equal(localForwardUrl(bad), "", String(bad));

  const stuck = buildServicesHtml(withServices([svc(7100, { binds: ["10.1.2.3"], scope: "address", forwardable: false })]));
  assert.match(stuck, /<span class="dm-busy" title="只绑定在 10\.1\.2\.3，[^"]*转发不了">不能转发<\/span>/);
  assert.doesNotMatch(stuck, /data-dm-open/);
  const password = buildServicesHtml(withServices([svc(8814)], [], { forwardBlocked: "password" }));
  assert.match(password, /<p class="dm-note">这台服务器用密码连接，不能转发到本机；改用密钥登录后可用。<\/p>/);
  assert.doesNotMatch(password, /data-dm-open/);
  assert.doesNotMatch(buildServicesHtml(withServices([svc(8814)], [], { forwardBlocked: "unavailable" })), /data-dm-open|class="dm-note"/, "这个运行环境不提供转发：只列服务");
  const full = buildServicesHtml(withServices([svc(8814), svc(8815)], [fwd(8814, 51814)], { forwardLimit: 1 }));
  assert.match(full, /data-dm-open="8815" title="转发已经开满，先关掉一条" disabled>打开/);
  assert.match(buildServicesHtml(withServices([svc(8814)], [], { servicesMore: 6 })), /<p class="dm-note">另有 6 个没有列出（按端口从小到大，最多列 1 个）。<\/p>/);
  // 这一轮没取到列表，但转发还开着：仍给一行，保证能关。
  const stray = buildDaemonsHtml(view(["unknown", "unknown"], { reachable: false, error: "SSH 未返回结果", services: [], forwards: [fwd(8814, 51814)], forwardLimit: 4 }));
  assert.match(stray, /这一轮取不到状态/);
  assert.match(stray, /<span class="dm-name">转发中<\/span><span class="dm-addr">:8814<\/span><span class="dm-sub">这一轮的列表里没有它<\/span>/);
  assert.match(stray, /data-dm-close="8814"/);
});

test("服务组：远端来的文字一律转义；进行中的动作显示进度、不给按钮", () => {
  const nasty = buildServicesHtml(withServices([svc(8814, { name: '<img src=x onerror=alert(1)>', cmdline: 'a "quoted" <b>', cwd: "~/<script>", binds: ["<i>"] })]));
  assert.doesNotMatch(nasty, /<img|<b>|<script>|<i>/);
  assert.match(nasty, /title="a &quot;quoted&quot; &lt;b&gt;">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  const opening = buildServicesHtml(withServices([svc(8814), svc(8815)], [fwd(8815, 51815)]), { pending: new Map([[8814, "open"], [8815, "close"]]) });
  assert.match(opening, /<span class="dm-busy" role="status">正在转发…<\/span>/);
  assert.match(opening, /<span class="dm-busy" role="status">正在关闭…<\/span>/);
  assert.doesNotMatch(opening, /data-dm-open|data-dm-close/);
  assert.match(buildServicesHtml(withServices([svc(8814, { name: "", cmdline: "", uptimeSec: null })])), /<span class="dm-name">进程<\/span><span class="dm-addr">:8814<\/span><span class="dm-sub">127\.0\.0\.1<\/span>/, "没拿到名字 / 时长时不编");
});

test("打开：POST 只带 serverId 与端口（数字）；成功后在浏览器打开按端口现拼的本机地址，用返回的状态重绘", async () => {
  const pending = deferred();
  const h = setup({ getJson: async () => withServices([svc(8814), svc(8815)]), postJson: () => pending.promise });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  clickOn(h, { dmOpen: "8814" });
  await flush();
  assert.deepEqual(h.posts, [["/api/daemons/forward", { serverId: "s1", port: 8814 }]]);
  assert.match(h.body.innerHTML, /正在转发…/);
  assert.match(h.body.innerHTML, /data-dm-open="8815"/, "别的行不受影响");
  await clickOn(h, { dmOpen: "8814" });
  assert.equal(h.posts.length, 1, "进行中再点不重复发");
  assert.deepEqual(h.opened, [], "转发建好之前不打开任何地址");

  pending.resolve({ forward: fwd(8814, 51814, { url: "http://evil.example/" }), status: withServices([svc(8814), svc(8815)], [fwd(8814, 51814)]) });
  await flush();
  assert.deepEqual(h.opened, ["http://127.0.0.1:51814/"], "打开的是按端口现拼的地址，不是响应里的字符串");
  assert.deepEqual([h.toasts[0].type, h.toasts[0].title], ["success", "已转发到这台电脑"]);
  assert.match(h.toasts[0].message, /:8814 → 127\.0\.0\.1:51814。浏览器没有自动打开时，点这一行的本机地址；最长 2 小时/);
  assert.match(h.body.innerHTML, /href="http:\/\/127\.0\.0\.1:51814\/"/);
  assert.doesNotMatch(h.body.innerHTML, /正在转发/);
  assert.equal(h.gets.length, 1, "有返回状态就不用再读一次");
  assert.deepEqual(forwardToast(8814, { localPort: 51814 }).duration, 6000);
});

test("打开失败：把后端的原因告诉用户，并强制重读一次列表；返回里的本机端口不对也算失败、不打开", async () => {
  const h = setup({
    getJson: async () => withServices([svc(8814)]),
    postJson: async () => { throw Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "端口 8814 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」" }); },
  });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  await clickOn(h, { dmOpen: "8814" });
  await flush();
  assert.deepEqual([h.toasts[0].type, h.toasts[0].title, h.toasts[0].message], ["warn", "没有转发成功", "端口 8814 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」"]);
  assert.deepEqual(h.opened, []);
  assert.equal(h.gets.at(-1), "/api/daemons?serverId=s1&fresh=1");
  assert.match(h.body.innerHTML, /data-dm-open="8814"/, "回到可以再点的状态");

  const odd = setup({ getJson: async () => withServices([svc(8814)]), postJson: async () => ({ forward: { localPort: "51814/x" }, status: null }) });
  odd.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  await clickOn(odd, { dmOpen: "8814" });
  await flush();
  assert.deepEqual([odd.opened, odd.toasts[0].type], [[], "warn"]);
  // 按钮上的端口不是数字：不发请求。
  await clickOn(odd, { dmOpen: "abc" });
  assert.equal(odd.posts.length, 1);

  // 转发建好了、但新标签页没打开（浏览器拦了 / 抛错）：不算失败，本机地址就在这一行上。
  const blocked = setup({
    getJson: async () => withServices([svc(8814)]),
    postJson: async () => ({ forward: fwd(8814, 51814), status: withServices([svc(8814)], [fwd(8814, 51814)]) }),
    openUrl: () => { throw new Error("popup blocked"); },
  });
  blocked.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  await clickOn(blocked, { dmOpen: "8814" });
  await flush();
  assert.equal(blocked.toasts[0].type, "success");
  assert.match(blocked.body.innerHTML, /href="http:\/\/127\.0\.0\.1:51814\/"/);
});

test("关闭：POST /api/daemons/forward/close，用返回的状态重绘；切换服务器时丢掉进行中的标记", async () => {
  const pending = deferred();
  const h = setup({
    getJson: async (url) => (url.includes("s2") ? withServices([svc(9000)], [], { serverId: "s2", serverName: "s2" }) : withServices([svc(8814)], [fwd(8814, 51814)])),
    postJson: () => pending.promise,
  });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  clickOn(h, { dmClose: "8814" });
  await flush();
  assert.deepEqual(h.posts, [["/api/daemons/forward/close", { serverId: "s1", port: 8814 }]]);
  assert.match(h.body.innerHTML, /正在关闭…/);
  pending.resolve({ closed: true, serverId: "s1", port: 8814, status: withServices([svc(8814)]) });
  await flush();
  assert.match(h.body.innerHTML, /data-dm-open="8814"/);
  assert.doesNotMatch(h.body.innerHTML, /dm-fwd|正在关闭/);
  assert.deepEqual(h.opened, [], "关闭不打开任何地址");

  // 打开途中切到另一台：晚到的结果不改新服务器的画面。
  const slow = deferred();
  const sw = setup({ getJson: async (url) => (url.includes("s2") ? withServices([svc(9000)], [], { serverId: "s2", serverName: "s2" }) : withServices([svc(8814)])), postJson: () => slow.promise });
  sw.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  clickOn(sw, { dmOpen: "8814" });
  await flush();
  sw.ctrl.onStatus({ activeServerId: "s2" });
  await flush();
  assert.match(sw.body.innerHTML, /data-dm-open="9000"/);
  assert.doesNotMatch(sw.body.innerHTML, /正在转发/);
  slow.resolve({ forward: fwd(8814, 51814), status: withServices([svc(8814)], [fwd(8814, 51814)]) });
  await flush();
  assert.match(sw.body.innerHTML, /data-dm-open="9000"/, "仍是 s2 的列表");
  assert.doesNotMatch(sw.body.innerHTML, /51814/);
});

test("服务组收起：只留组名（个数、对所有网卡开放的提醒）与转发中 / 动作中的行，说明文字不出现", () => {
  const data = withServices([svc(8765, { scope: "all" }), svc(8814), svc(8815)], [fwd(8814, 51814), fwd(9000, 51900)], { servicesMore: 6, forwardBlocked: "password" });
  const html = buildServicesHtml(data, { collapsed: true, pending: new Map([[8815, "open"]]) });
  assert.match(html, /aria-expanded="false">我在这台服务器上的服务<\/button><span class="dm-count">9 个<\/span><span class="dm-tag" data-level="warn">1 个对所有网卡开放<\/span>/, "个数含没列出的");
  assert.equal(html.match(/class="dm-row dm-svc"/g).length, 3, "转发中的、正在转发的、列表外的转发各一行");
  assert.doesNotMatch(html, /:8765|class="dm-note"/);
  assert.match(html, /data-dm-close="8814"/);
  assert.match(html, /data-dm-close="9000"/);
  assert.match(html, /正在转发…/);
  const bare = buildServicesHtml(withServices([svc(8814), svc(8815)]), { collapsed: true });
  assert.doesNotMatch(bare, /dm-list|dm-svc/, "没有转发时收起后只剩组名一行");
  assert.match(bare, /<span class="dm-count">2 个<\/span><\/h3>$/);
});

test("服务组：默认收起；点组名展开 / 收起并记在本机，不发请求；取不到存储也照常能用", async () => {
  const storage = memoryStorage();
  const h = setup({ getJson: async () => withServices([svc(8814), svc(8815)], [fwd(8815, 51815)]), storage });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.match(h.body.innerHTML, /aria-expanded="false"/);
  assert.doesNotMatch(h.body.innerHTML, /data-dm-open="8814"/);
  assert.match(h.body.innerHTML, /data-dm-close="8815"/, "收起时开着的转发仍然关得掉");
  clickOn(h, { dmToggle: "" });
  assert.match(h.body.innerHTML, /aria-expanded="true"/);
  assert.match(h.body.innerHTML, /data-dm-open="8814"/);
  assert.equal(storage.map.get(SERVICES_OPEN_STORAGE_KEY), "1");
  clickOn(h, { dmToggle: "" });
  assert.doesNotMatch(h.body.innerHTML, /data-dm-open="8814"/);
  assert.equal(storage.map.get(SERVICES_OPEN_STORAGE_KEY), "0");
  assert.equal(h.gets.length, 1);
  assert.deepEqual(h.posts, []);

  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const b = setup({ getJson: async () => withServices([svc(8814)]), storage: broken });
  b.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  assert.match(b.body.innerHTML, /aria-expanded="false"/);
  clickOn(b, { dmToggle: "" });
  assert.match(b.body.innerHTML, /data-dm-open="8814"/);
});

test("复制本机地址：点「复制」按钮将本机地址写入剪贴板并给出 toast 提示，不发任何请求", async () => {
  const h = setup({ getJson: async () => withServices([svc(8814)], [fwd(8814, 51814)]) });
  h.ctrl.onStatus({ activeServerId: "s1" });
  await flush();
  await clickOn(h, { dmCopy: "http://127.0.0.1:51814/" });
  await flush();
  assert.deepEqual(h.copied, ["http://127.0.0.1:51814/"]);
  assert.equal(h.toasts.at(-1)?.type, "success");
  assert.match(h.toasts.at(-1)?.message || "", /127\.0\.0\.1:51814/);
  assert.deepEqual(h.posts, []);
});

