import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelfUpdateModel,
  buildUpdateBannerHtml,
  buildUpdateBannerModel,
  DATA_PLANE_SUPPRESS_MS,
  describeUpgradeResult,
  initUpdateBanner,
  LEGACY_HANDOFF_MESSAGE,
  normalizeDataPlanePending,
  PROXY_UPGRADE_NOTE,
  SELF_UPDATE_BODY,
  waitForServerRestart,
} from "./render/update-banner.js";

const restartInfo = {
  bundleOnDisk: { version: "2.26.0", gitCommit: "bbb" },
  compatibility: { state: "restart-monitor", reasons: ["restart-monitor", "supervisor-unknown"] },
};

test("restart-monitor → 桌面端出「重启界面（隧道不中断）」按钮", () => {
  const model = buildUpdateBannerModel(restartInfo, { desktop: true });
  assert.equal(model.kind, "control");
  assert.equal(model.title, "新版本 v2.26.0 已安装");
  assert.deepEqual(model.actions.map((a) => a.id), ["restart-ui"]);
  assert.match(model.actions[0].label, /隧道不中断/);
});

test("网页模式：只出说明，不给无法执行的按钮", () => {
  const model = buildUpdateBannerModel(restartInfo, { desktop: false });
  assert.equal(model.kind, "control");
  assert.equal(model.actions.length, 0);
});

test("主进程自检到的更新（build-info 仍 aligned）同样出重启横幅", () => {
  const model = buildUpdateBannerModel({ compatibility: { state: "aligned", reasons: [] } }, { desktop: true, desktopUpdate: { version: "2.27.0", gitCommit: "c" } });
  assert.equal(model.kind, "control");
  assert.equal(model.title, "新版本 v2.27.0 已安装");
});

test("控制面待重启时优先于数据面提示；重启后才出平滑升级", () => {
  const info = { ...restartInfo, dataPlane: { running: {}, bundle: {}, pending: ["supervisor"] } };
  assert.equal(buildUpdateBannerModel(info, { desktop: true }).kind, "control");
  const after = { compatibility: { state: "supervisor-older", reasons: ["supervisor-older"] }, dataPlane: { pending: ["supervisor", "proxy"] } };
  const model = buildUpdateBannerModel(after, { desktop: true });
  assert.equal(model.kind, "data");
  assert.equal(model.title, "后台组件有更新：平滑升级（隧道不中断）");
  assert.deepEqual(model.actions.map((a) => a.component), ["supervisor", "proxy"]);
  assert.equal(model.actions[1].note, PROXY_UPGRADE_NOTE);
  assert.match(model.body, /亚秒级/);
});

test("无 dataPlane（旧后端）/ pending 为空 / 接口 404 后 → 不出数据面横幅", () => {
  const aligned = { compatibility: { state: "aligned", reasons: [] } };
  assert.equal(buildUpdateBannerModel(aligned, { desktop: true }), null);
  assert.equal(buildUpdateBannerModel({ ...aligned, dataPlane: { pending: [] } }, { desktop: true }), null);
  assert.equal(buildUpdateBannerModel({ ...aligned, dataPlane: { pending: ["supervisor"] } }, { desktop: true, dataPlaneUnsupported: true }), null);
  assert.equal(buildUpdateBannerModel(null, { desktop: true }), null);
});

test("normalizeDataPlanePending：按后端给的顺序映射守护进程 / 代理，认不出的 id 丢弃", () => {
  const list = normalizeDataPlanePending({ pending: ["supervisor", "proxy"] });
  assert.deepEqual(list.map((p) => [p.id, p.kind]), [["supervisor", "supervisor"], ["proxy", "proxy"]]);
  assert.equal(list[1].note, PROXY_UPGRADE_NOTE);
  assert.deepEqual(normalizeDataPlanePending({ pending: ["x", "toString", 3, null] }), []);
  assert.deepEqual(normalizeDataPlanePending(undefined), []);
});

test("buildUpdateBannerHtml：转义文案，并带「稍后」", () => {
  const html = buildUpdateBannerHtml({ kind: "data", key: "k", title: "<b>", body: "b", actions: [{ id: "upgrade", label: "升级 <x>", note: "" }] });
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /data-dismiss="1"/);
  assert.equal(buildUpdateBannerHtml(null), "");
});

const aligned = { compatibility: { state: "aligned", reasons: [] } };
const livePlane = (extra = {}) => ({ ...aligned, dataPlane: { pending: ["supervisor", "proxy"], snapshotAvailable: true, channelRunning: true, handoffSupported: true, proxyHandoffSupported: true, ...extra } });

test("旧 supervisor（handoffSupported=false）：不给升级按钮，如实提示重启一次通道", () => {
  const model = buildUpdateBannerModel(livePlane({ handoffSupported: false, proxyHandoffSupported: false }), { desktop: true });
  assert.equal(model.kind, "data");
  assert.deepEqual(model.actions, []);
  assert.equal(model.title, "后台组件有更新");
  assert.ok(model.body.includes(LEGACY_HANDOFF_MESSAGE));
  assert.match(LEGACY_HANDOFF_MESSAGE, /重启一次通道/);
});

test("旧代理（proxyHandoffSupported=false）：只隐藏代理按钮，守护进程照常可升级", () => {
  const model = buildUpdateBannerModel(livePlane({ proxyHandoffSupported: false }), { desktop: true });
  assert.deepEqual(model.actions.map((a) => a.component), ["supervisor"]);
  assert.ok(model.body.includes(LEGACY_HANDOFF_MESSAGE));
  assert.doesNotMatch(model.body, /亚秒级/);
  // 支持性变化要换 key：此前点过「稍后」不应把新情况也藏掉。
  assert.notEqual(model.key, buildUpdateBannerModel(livePlane(), { desktop: true }).key);
});

test("快照不可用/过期或通道已停止：两个组件都列 pending 只是未知 → 不出数据面横幅", () => {
  assert.equal(buildUpdateBannerModel(livePlane({ snapshotAvailable: false, handoffSupported: false }), { desktop: true }), null);
  assert.equal(buildUpdateBannerModel(livePlane({ channelRunning: false }), { desktop: true }), null);
  // 控制面横幅不受影响。
  assert.equal(buildUpdateBannerModel({ ...restartInfo, dataPlane: { pending: ["supervisor"], channelRunning: false } }, { desktop: true }).kind, "control");
});

test("刚升级成功的抑制窗口内不出数据面横幅", () => {
  assert.equal(buildUpdateBannerModel(livePlane(), { desktop: true, suppressDataPlane: true }), null);
  assert.equal(buildUpdateBannerModel(livePlane(), { desktop: true }).kind, "data");
});

test("describeUpgradeResult：HTTP 200 + ok:false 显示失败步骤详情", () => {
  assert.deepEqual(describeUpgradeResult({ ok: true, steps: [] }, "平滑升级守护进程"), { ok: true, message: "已完成：平滑升级守护进程（隧道不中断）" });
  const failed = describeUpgradeResult({ ok: false, steps: [{ name: "supervisor-handoff", ok: true }, { name: "proxy-handoff", ok: false, detail: "failed: running local proxy predates graceful handoff" }] }, "升级本地代理");
  assert.equal(failed.ok, false);
  assert.match(failed.message, /proxy-handoff：failed: running local proxy predates graceful handoff/);
  assert.equal(describeUpgradeResult(undefined, "x").ok, false);
});

// ---- initUpdateBanner 端到端（假 DOM）----
function fakeRoot() {
  const listeners = {};
  return {
    style: { display: "" },
    innerHTML: "",
    listeners,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function clickFirstAction(root) {
  class FakeElement {
    closest() { return { dataset: { index: "0" } }; }
  }
  const saved = globalThis.Element;
  globalThis.Element = FakeElement;
  try {
    root.listeners.click({ target: new FakeElement() });
  } finally {
    globalThis.Element = saved;
  }
  await flush();
}

test("initUpdateBanner：ok:false 报错并保留横幅；ok:true 报完成并在抑制窗口内不再出现", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let clock = 1_000;
  let upgradeResult = { ok: false, steps: [{ name: "supervisor-handoff", ok: false, detail: "old supervisor pid 9 did not exit within 5000ms" }] };
  const toasts = [];
  const posts = [];
  const root = fakeRoot();
  const banner = initUpdateBanner({
    root,
    getJson: async () => livePlane({ pending: ["supervisor"] }),
    postJson: async (url, body) => { posts.push([url, body]); return upgradeResult; },
    toast: (entry) => toasts.push(entry),
    now: () => clock,
  });
  t.after(() => banner.stop());
  await flush();
  assert.equal(root.style.display, "", "初始出横幅");
  assert.match(root.innerHTML, /平滑升级守护进程/);

  await clickFirstAction(root);
  assert.deepEqual(posts.at(-1), ["/api/data-plane/upgrade", { components: ["supervisor"] }]);
  assert.equal(toasts.at(-1).type, "error");
  assert.match(toasts.at(-1).message, /did not exit within 5000ms/);
  assert.doesNotMatch(toasts.at(-1).message, /已发起/);
  await flush();
  assert.equal(root.style.display, "", "失败后横幅仍在");

  upgradeResult = { ok: true, steps: [] };
  await clickFirstAction(root);
  assert.equal(toasts.at(-1).type, "success");
  await banner.refresh();
  assert.equal(root.style.display, "none", "抑制窗口内（快照缓存未刷新）不闪回");
  clock += DATA_PLANE_SUPPRESS_MS + 1;
  await banner.refresh();
  assert.equal(root.style.display, "", "窗口过后若仍 pending 如实再出");
});

test("describeUpgradeResult：后端 noop（已是新包代码）提示无需升级，而不是已完成", () => {
  assert.deepEqual(describeUpgradeResult({ ok: true, noop: true, steps: [] }, "平滑升级守护进程"), { ok: true, message: "无需升级：平滑升级守护进程——后台组件已是新版本" });
});

// v2.56.0 热更新后多出的一次 supervisor 交接：横幅是控制面刚重启时（快照缓存还是旧 supervisor）拿到的，
// 60s 内一直显示；热更新脚本已交接完，点按钮又交接了一遍。点击前现查一次即可挡住。
test("initUpdateBanner：点击前现查 build-info，组件已不在 pending → 不发交接、提示无需升级并收起横幅", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let info = livePlane({ pending: ["supervisor", "proxy"] });
  const toasts = [];
  const posts = [];
  const root = fakeRoot();
  const banner = initUpdateBanner({
    root,
    getJson: async () => info,
    postJson: async (url, body) => { posts.push([url, body]); return { ok: true, steps: [] }; },
    toast: (entry) => toasts.push(entry),
  });
  t.after(() => banner.stop());
  await flush();
  assert.match(root.innerHTML, /平滑升级守护进程/, "横幅停留在旧判断上");

  info = livePlane({ pending: [] }); // 热更新脚本已经交接完
  await clickFirstAction(root);
  await flush();
  assert.deepEqual(posts, [], "不得再发一次交接");
  assert.equal(toasts.at(-1).type, "info");
  assert.match(toasts.at(-1).message, /无需升级/);
  assert.equal(root.style.display, "none", "现查结果没有 pending → 横幅收起");

  // 对照：仍 pending 时照常交接。
  info = livePlane({ pending: ["supervisor"] });
  await banner.refresh();
  await clickFirstAction(root);
  assert.deepEqual(posts.at(-1), ["/api/data-plane/upgrade", { components: ["supervisor"] }]);
});

// ---- v2.59 自更新：源码安装发现 GitHub 上有更高的版本 ----

const available = { supported: true, available: true, canApply: true, localVersion: "2.58.1", remoteVersion: "2.59.0", blockers: [], respawn: false };

test("有新版本且能一键更新 → 出「更新（隧道不中断）」；不能时把原因写出来、不给按钮", () => {
  const model = buildSelfUpdateModel(available);
  assert.equal(model.kind, "available");
  assert.equal(model.title, "有新版本 v2.59.0（当前 v2.58.1）");
  assert.equal(model.body, SELF_UPDATE_BODY);
  assert.deepEqual(model.actions, [{ id: "self-update", label: "更新（隧道不中断）", toVersion: "2.59.0" }]);

  const blocked = buildSelfUpdateModel({ ...available, canApply: false, blockers: [{ code: "needs-install", message: "这个版本改了依赖，需要在终端里更新" }] });
  assert.equal(blocked.actions.length, 0);
  assert.match(blocked.body, /需要在终端里更新/);
  assert.notEqual(blocked.key, model.key, "能不能更新变了要重新提示（之前点过「稍后」也再出一次）");

  assert.equal(buildSelfUpdateModel(null), null);
  assert.equal(buildSelfUpdateModel({ ...available, available: false }), null);
  assert.equal(buildSelfUpdateModel({ supported: false, unsupportedReason: "打包安装" }), null, "不支持的安装方式不出横幅");
  // /api/build-info 的载荷误当成自更新状态传进来（旧测试桩对任何地址都回同一份）也不出横幅。
  assert.equal(buildSelfUpdateModel(restartInfo), null);
});

test("三条横幅的先后：已安装待重启 > 有新版本 > 后台组件", () => {
  const pendingData = { compatibility: { reasons: [] }, dataPlane: { pending: ["supervisor"] } };
  assert.equal(buildUpdateBannerModel(restartInfo, { desktop: true, selfUpdate: available }).kind, "control");
  assert.equal(buildUpdateBannerModel(pendingData, { desktop: true, selfUpdate: available }).kind, "available");
  assert.equal(buildUpdateBannerModel(pendingData, { desktop: true, selfUpdate: { ...available, available: false } }).kind, "data");
});

test("网页模式：监控服务是启动器起的才给「重启监控服务」按钮", () => {
  const withRespawn = buildUpdateBannerModel(restartInfo, { desktop: false, selfUpdate: { respawn: true } });
  assert.deepEqual(withRespawn.actions, [{ id: "restart-server", label: "重启监控服务（隧道不中断）" }]);
  assert.match(withRespawn.body, /重启监控服务即可生效/);
  assert.equal(buildUpdateBannerModel(restartInfo, { desktop: false, selfUpdate: { respawn: false } }).actions.length, 0);
  assert.deepEqual(buildUpdateBannerModel(restartInfo, { desktop: true, selfUpdate: { respawn: true } }).actions.map((a) => a.id), ["restart-ui"], "桌面壳仍用重启界面");
});

test("等监控服务回来：进程换了（startedAt 变了）才算；中途连不上接着等；超时返回 false", async () => {
  const answers = [new Error("ECONNREFUSED"), { monitorRunning: { startedAt: 100 } }, new Error("ECONNREFUSED"), { monitorRunning: { startedAt: 200 } }];
  let clock = 0;
  const getJson = async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms) => { clock += ms; };
  assert.equal(await waitForServerRestart({ getJson, before: 100, now: () => clock, sleep }), true);
  assert.equal(answers.length, 0, "旧进程还在应答（startedAt 没变）不算回来");
  assert.equal(await waitForServerRestart({ getJson: async () => ({ monitorRunning: { startedAt: 100 } }), before: 100, timeoutMs: 5000, now: () => clock, sleep }), false);
});

test("点「更新」：失败给出后端的说明并恢复横幅；成功后桌面壳自动重启界面", async (t) => {
  const posts = [];
  const toasts = [];
  let restarted = 0;
  let applyError = Object.assign(new Error("HTTP 422"), { serverMessage: "新版本 v2.59.0 自检没有通过，没有更新" });
  const root = fakeRoot();
  const banner = initUpdateBanner({
    root,
    getJson: async (url) => (url === "/api/self-update" ? available : { compatibility: { reasons: [] } }),
    postJson: async (url, body) => {
      posts.push([url, body]);
      if (applyError) throw applyError;
      return { ok: true, fromVersion: "2.58.1", toVersion: "2.59.0", respawn: false };
    },
    electronAPI: { restartControlPlane: async () => { restarted += 1; return { ok: true }; }, getBundleUpdate: async () => null },
    toast: (entry) => toasts.push(entry),
    intervalMs: 3_600_000,
  });
  t.after(() => banner.stop());
  await flush();
  assert.match(root.innerHTML, /有新版本 v2\.59\.0（当前 v2\.58\.1）/);
  assert.match(root.innerHTML, /更新（隧道不中断）/);

  await clickFirstAction(root);
  assert.deepEqual(posts.at(-1), ["/api/self-update/apply", {}]);
  assert.equal(restarted, 0, "没更新成：不重启");
  assert.equal(toasts.at(-1).type, "error");
  assert.match(toasts.at(-1).message, /自检没有通过/);
  await flush();
  assert.match(root.innerHTML, /更新（隧道不中断）/, "横幅恢复，可以再点");

  applyError = null;
  await clickFirstAction(root);
  assert.equal(restarted, 1, "更新成功后自动重启界面");
});

test("点「更新」（网页模式）：应用后让监控服务重启，等它换了进程再刷新页面", async (t) => {
  const posts = [];
  let reloaded = 0;
  let startedAt = 100;
  const root = fakeRoot();
  const banner = initUpdateBanner({
    root,
    getJson: async (url) => (url === "/api/self-update" ? { ...available, respawn: true } : { compatibility: { reasons: [] }, monitorRunning: { startedAt } }),
    postJson: async (url, body) => {
      posts.push([url, body]);
      if (url === "/api/self-update/restart") startedAt = 200; // 新进程
      return { ok: true, fromVersion: "2.58.1", toVersion: "2.59.0", respawn: true };
    },
    toast: () => {},
    intervalMs: 3_600_000,
    reload: () => { reloaded += 1; },
  });
  t.after(() => banner.stop());
  await flush();
  await clickFirstAction(root);
  for (let i = 0; i < 30 && !reloaded; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(posts.map((p) => p[0]), ["/api/self-update/apply", "/api/self-update/restart"]);
  assert.equal(reloaded, 1);
});

test("安装包版本有新版本：只给「去下载」，不给一键更新；只认 GitHub 的 https 地址", () => {
  const base = { available: true, remoteVersion: "2.94.0", localVersion: "2.93.2", canApply: false, blockers: [{ code: "packaged", message: "这是安装包版本：下载新的安装包覆盖安装即可" }] };
  const model = buildSelfUpdateModel({ ...base, releaseUrl: "https://github.com/someone/cluster-ops-console/releases/tag/v2.94.0" });
  assert.equal(model.title, "有新版本 v2.94.0（当前 v2.93.2）");
  assert.match(model.body, /安装包版本/);
  assert.deepEqual(model.actions, [{ id: "open-release", label: "去下载", url: "https://github.com/someone/cluster-ops-console/releases/tag/v2.94.0" }]);
  assert.match(buildUpdateBannerHtml(model), />去下载</);
  for (const releaseUrl of ["javascript:alert(1)", "http://github.com/a/b/releases", "https://evil.example/releases", 'https://github.com/a"><x', null]) {
    assert.deepEqual(buildSelfUpdateModel({ ...base, releaseUrl }).actions, [], String(releaseUrl));
  }
  assert.equal(buildSelfUpdateModel({ ...base, available: false, releaseUrl: "https://github.com/a/b/releases" }), null);
});
