import assert from "node:assert/strict";
import test from "node:test";

import { buildModulesHtml, buildPanelsHtml, createSettingsModules, moduleToastText, panelCheckStates } from "./settings-modules.js";
import { deferred, fakeDialog, fakeDocument, fakeElement, flush, spy } from "./test-support.mjs";

const CATALOG = [
  { id: "agent:codex", group: "agent", label: "Codex", description: "Doctor 与端点", cost: "每 90 秒两次 SSH", warning: "", enabled: true, locked: false },
  { id: "agent:claude-codewing", group: "agent", label: "ReClaude", description: "", cost: "", warning: "关闭后不再检测账号层信号（设备解绑/封禁）", enabled: true, locked: false },
  { id: "agent:zcode", group: "agent", label: "Zcode", description: "", cost: "每 90 秒一次 SSH", warning: "", enabled: false, locked: false },
  { id: "usage", group: "data", label: "Agent 用量统计", description: "", cost: "每 60 秒一次 SSH", warning: "", enabled: true, locked: false },
  { id: "core.tunnel", group: "core", label: "隧道与本地代理", description: "", cost: "", warning: "", enabled: true, locked: true },
  { id: "core.signals", group: "core", label: "日志信号与远端端口", description: "", cost: "", warning: "", enabled: true, locked: true },
];

test("buildModulesHtml：Agent / 数据采集两组带开关，警示与采集代价照列，核心部分只列名字不给开关，文案转义", () => {
  const html = buildModulesHtml(CATALOG);
  assert.match(html, /<h3 class="mod-group-title">Agent<\/h3>/);
  assert.match(html, /<h3 class="mod-group-title">数据采集<\/h3>/);
  assert.equal((html.match(/data-module-id=/g) || []).length, 4, "core 不给开关");
  assert.match(html, /data-module-id="agent:zcode"[^>]*aria-label="监控 Zcode">/, "关闭的模块不带 checked");
  assert.match(html, /data-module-id="agent:codex"[^>]* checked>/);
  assert.match(html, /mod-warn">关闭后不再检测账号层信号/);
  assert.match(html, /采集代价 · 每 60 秒一次 SSH/);
  assert.match(html, /始终开启：隧道与本地代理、日志信号与远端端口/);
  assert.doesNotMatch(buildModulesHtml([{ id: "x", group: "agent", label: "<b>" }]), /<b>/);
  assert.match(buildModulesHtml([]), /没有配置 Agent/);
  // v2.57：团队默认关的 Agent 注明，旧目录（无 defaultEnabled 字段）不出现
  assert.doesNotMatch(html, /团队默认关闭/);
  assert.match(buildModulesHtml([{ ...CATALOG[1], defaultEnabled: false }]), /团队默认关闭，按需打开/);
});

test("moduleToastText：Agent 与数据采集两种说法", () => {
  assert.equal(moduleToastText(CATALOG[2], false), "已关闭 Zcode 监控，相关检查已停止");
  assert.equal(moduleToastText(CATALOG[3], true), "已开启「Agent 用量统计」，正在重新检查");
});

test("panelCheckStates：锁定项勾选且禁用；整页隐藏时页内面板禁用；用量模块关闭时用量页随之隐藏、不可勾选", () => {
  const states = panelCheckStates({ hiddenPanels: ["view.servers", "overview.brief"], modules: { usage: false } });
  assert.deepEqual(states["overview.chain"], { checked: true, disabled: true, note: "始终显示" });
  assert.deepEqual(states["view.overview"], { checked: true, disabled: true, note: "始终显示" });
  assert.deepEqual(states["overview.brief"], { checked: false, disabled: false, note: "" });
  assert.deepEqual(states["view.servers"], { checked: false, disabled: false, note: "" });
  assert.deepEqual(states["servers.cluster"], { checked: true, disabled: true, note: "整页已隐藏" });
  assert.deepEqual(states["view.usage"], { checked: false, disabled: true, note: "用量模块已关闭" });
  assert.deepEqual(panelCheckStates({})["view.usage"], { checked: true, disabled: false, note: "" }, "缺字段视为全开");
  const html = buildPanelsHtml();
  assert.match(html, /data-panel-id="overview.chain" checked disabled/);
  assert.match(html, /data-panels-reset/);
});

// 假 DOM：两段的容器 + 按 data-* 查找的输入框。
function setup({ postJson, getJson, status = { hiddenPanels: [], modules: {} } } = {}) {
  const moduleInputs = CATALOG.filter((m) => !m.locked).map((m) => fakeElement({ tag: "input", dataset: { moduleId: m.id }, checked: m.enabled }));
  const panelInputs = ["overview.brief", "view.usage"].map((id) => fakeElement({ tag: "input", dataset: { panelId: id }, checked: true }));
  const settingsModulesBody = fakeElement({ querySelectorAll: (sel) => (sel === "[data-module-id]" ? moduleInputs : []) });
  const settingsPanelsBody = fakeElement({ querySelectorAll: (sel) => (sel === "[data-panel-id]" ? panelInputs : []) });
  const dlgSettings = fakeDialog();
  dlgSettings.open = true;
  const doc = fakeDocument({ settingsModulesBody, settingsPanelsBody, dlgSettings });
  let current = status;
  const applied = [];
  const deps = {
    doc,
    getJson: getJson || spy(async () => ({ modules: CATALOG })),
    postJson: postJson || spy(async (path, body) => (path === "/api/modules"
      ? { success: true, modules: CATALOG.map((m) => (m.id === body.id ? { ...m, enabled: body.enabled } : m)) }
      : { success: true, hiddenPanels: body.hiddenPanels })),
    showToast: spy(),
    getStatus: () => current,
    onModulesChanged: spy(async () => {}),
    onPanelsSaved: spy(),
    onHiddenPanels: (list) => {
      applied.push(list);
      current = { ...current, hiddenPanels: list };
    },
  };
  const section = createSettingsModules(deps);
  const input = (id) => moduleInputs.find((el) => el.dataset.moduleId === id);
  const panelInput = (id) => panelInputs.find((el) => el.dataset.panelId === id);
  return { deps, section, settingsModulesBody, settingsPanelsBody, input, panelInput, applied };
}

test("监控模块开关：在飞时禁用；成功后按回显同步、提示并全量刷新", async () => {
  const pending = deferred();
  const ctx = setup({ postJson: spy(() => pending.promise) });
  ctx.section.onOpen();
  await flush();
  assert.match(ctx.settingsModulesBody.innerHTML, /data-module-id="agent:zcode"/);
  const codex = ctx.input("agent:codex");
  codex.checked = false;
  const done = ctx.settingsModulesBody.dispatch("change", { target: codex });
  await flush();
  assert.equal(codex.disabled, true, "请求在飞时禁用开关");
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/modules", { id: "agent:codex", enabled: false }]);
  pending.resolve({ success: true, modules: CATALOG.map((m) => (m.id === "agent:codex" ? { ...m, enabled: false } : m)) });
  await done;
  assert.equal(codex.disabled, false);
  assert.equal(codex.checked, false);
  assert.equal(ctx.deps.showToast.calls[0][0].type, "success");
  assert.equal(ctx.deps.showToast.calls[0][0].message, "已关闭 Codex 监控，相关检查已停止");
  assert.equal(ctx.deps.onModulesChanged.calls.length, 1);
});

// 假后端：按收到的顺序依次处理开关、各自回显处理那一刻的整张模块表；回包可以乱序送达。
function fakeModulesServer() {
  const enabled = new Map(CATALOG.map((m) => [m.id, m.enabled]));
  const inFlight = [];
  const snapshot = () => CATALOG.map((m) => ({ ...m, enabled: enabled.get(m.id) }));
  const postJson = spy((_path, body) => {
    enabled.set(body.id, body.enabled); // 服务端按到达顺序生效
    const reply = deferred();
    inFlight.push({ body, reply, modules: snapshot() });
    return reply.promise;
  });
  return { postJson, inFlight, snapshot };
}

test("监控模块开关：两个模块先后关闭，较旧的整表回显后到也不能把已关闭项重新勾上（串行写入）", async () => {
  const server = fakeModulesServer();
  const ctx = setup({ postJson: server.postJson });
  ctx.section.onOpen();
  await flush();
  const codex = ctx.input("agent:codex");
  const usage = ctx.input("usage");
  codex.checked = false;
  const first = ctx.settingsModulesBody.dispatch("change", { target: codex });
  usage.checked = false;
  const second = ctx.settingsModulesBody.dispatch("change", { target: usage });
  await flush();
  assert.equal(server.inFlight.length, 1, "同一时刻只有一个模块写入在飞（第二个排队）");
  assert.equal(usage.disabled, true, "排队中的开关同样禁用");
  // 逐个放行：凡有多个在飞的回包，一律后发先到（旧实现在这里被旧整表回显覆盖）
  while (server.inFlight.length) {
    const next = server.inFlight.pop();
    next.reply.resolve({ success: true, modules: next.modules });
    await flush();
    await flush();
  }
  await Promise.all([first, second]);
  assert.equal(codex.checked, false);
  assert.equal(usage.checked, false, "后关闭的模块保持关闭");
  assert.equal(codex.disabled || usage.disabled, false);
  assert.deepEqual(server.postJson.calls.map(([, body]) => body), [{ id: "agent:codex", enabled: false }, { id: "usage", enabled: false }]);
});

test("监控模块开关：打开配置时的旧 GET 晚于开关保存返回，不回写旧开关状态", async () => {
  const slowGet = deferred();
  const server = fakeModulesServer();
  const ctx = setup({ postJson: server.postJson, getJson: spy(() => slowGet.promise) });
  ctx.section.onOpen(); // GET 在飞
  await flush();
  const codex = ctx.input("agent:codex");
  codex.checked = false;
  const done = ctx.settingsModulesBody.dispatch("change", { target: codex });
  await flush();
  const reply = server.inFlight.shift();
  reply.reply.resolve({ success: true, modules: reply.modules });
  await done;
  assert.equal(codex.checked, false);
  slowGet.resolve({ modules: CATALOG }); // 写入前读到的旧表（codex 仍开）
  await flush();
  assert.equal(codex.checked, false, "旧读取不得把刚关闭的模块重新勾上");
});

test("监控模块开关：保存失败回滚开关并提示错误，不刷新", async () => {
  const err = Object.assign(new Error("HTTP 400"), { serverMessage: "unknown or locked module" });
  const ctx = setup({ postJson: spy(async () => { throw err; }) });
  ctx.section.onOpen();
  await flush();
  const usage = ctx.input("usage");
  usage.checked = false;
  await ctx.settingsModulesBody.dispatch("change", { target: usage });
  assert.equal(usage.checked, true, "回滚到开启");
  assert.equal(usage.disabled, false);
  assert.equal(ctx.deps.showToast.calls[0][0].type, "error");
  assert.match(ctx.deps.showToast.calls[0][0].message, /unknown or locked module/);
  assert.equal(ctx.deps.onModulesChanged.calls.length, 0);
});

test("界面面板：取消勾选先乐观应用再保存；失败回滚到原列表；恢复默认提交空列表", async () => {
  const ctx = setup();
  ctx.section.onOpen();
  const brief = ctx.panelInput("overview.brief");
  brief.checked = false;
  await ctx.settingsPanelsBody.dispatch("change", { target: brief });
  assert.deepEqual(ctx.deps.postJson.calls.at(-1), ["/api/ui-prefs", { hiddenPanels: ["overview.brief"] }]);
  assert.deepEqual(ctx.applied, [["overview.brief"], ["overview.brief"]], "乐观应用 + 服务器回显");
  assert.equal(brief.checked, false);
  assert.equal(ctx.deps.onPanelsSaved.calls.length, 1, "保存成功立即全量刷新（不等 SSE）");

  await ctx.settingsPanelsBody.dispatch("click", { target: fakeElement({ dataset: { panelsReset: "" } }) });
  assert.deepEqual(ctx.deps.postJson.calls.at(-1), ["/api/ui-prefs", { hiddenPanels: [] }]);
  assert.equal(brief.checked, true);

  const failing = setup({ postJson: spy(async () => { throw new Error("HTTP 500"); }), status: { hiddenPanels: ["view.events"] } });
  failing.section.onOpen();
  const usage = failing.panelInput("view.usage");
  usage.checked = false;
  await failing.settingsPanelsBody.dispatch("change", { target: usage });
  assert.deepEqual(failing.applied, [["view.events", "view.usage"], ["view.events"]], "失败回滚到保存前的列表");
  assert.equal(usage.checked, true);
  assert.equal(failing.deps.showToast.calls[0][0].type, "error");
  assert.equal(failing.deps.onPanelsSaved.calls.length, 0);
});
