import assert from "node:assert/strict";
import test from "node:test";

import { buildSettingsConfigHtml, createSettingsDialog, LOCAL_RESOURCE_REFRESH_MS } from "./settings-dialog.js";
import { createAppState } from "./state.js";
import { fakeDialog, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

function setup({ hidden = false, getJson } = {}) {
  const elements = {
    dlgSettings: fakeDialog(),
    settingsVersionBody: fakeElement(),
    settingsVersionState: fakeElement(),
    settingsConfigBody: fakeElement(),
    personalConfigEditor: fakeElement({ value: "" }),
    savePersonalConfigBtn: fakeElement(),
    reloadPersonalConfigBtn: fakeElement(),
    configSaveHint: fakeElement(),
  };
  const doc = fakeDocument(elements);
  const win = fakeElement();
  const timers = fakeTimers();
  const state = createAppState();
  state.setConfig({ servers: [{ id: "a", source: "team" }, { id: "b", source: "personal" }] });
  let registryDeps = null;
  const registry = { refresh: spy(async () => {}), refreshLocal: spy(async () => {}), confirmHostKey: spy() };
  const deps = {
    doc, win, state, timers,
    getJson: getJson || spy(async (path) => (path === "/api/build-info"
      ? { compatibility: { state: "compatible" } }
      : { config: { revision: 7, servers: [] } })),
    postJson: spy(async () => ({ restartRequired: false })),
    patchJson: spy(), deleteJson: spy(), showToast: spy(), confirm: spy(() => true),
    isHidden: () => hidden,
    initRegistryUi: (d) => {
      registryDeps = d;
      return registry;
    },
    getClientVersion: () => "9.9.9",
    loadServers: spy(async () => {}),
    refresh: spy(async () => {}),
    fetchIncidents: spy(async () => {}),
  };
  const settings = createSettingsDialog(deps);
  return { deps, elements, win, timers, registry, registryDeps: () => registryDeps, settings };
}

test("本机资源定时器：打开浮层启动（重复打开不叠加），关闭即停，页面卸载也停", async () => {
  const ctx = setup();
  ctx.elements.dlgSettings.showModal();
  ctx.settings.onOpen();
  ctx.settings.onOpen();
  assert.equal(ctx.timers.intervals.size, 1);
  assert.equal([...ctx.timers.intervals.values()][0].ms, LOCAL_RESOURCE_REFRESH_MS);
  ctx.timers.tickIntervals();
  assert.equal(ctx.registry.refreshLocal.calls.length, 3, "两次打开各拉一次 + 一次定时");
  await ctx.elements.dlgSettings.close();
  assert.equal(ctx.timers.intervals.size, 0, "close 事件停掉定时器");
  ctx.settings.onOpen();
  await ctx.win.dispatch("pagehide");
  assert.equal(ctx.timers.intervals.size, 0);
});

test("本机资源定时器：浮层已被关掉（未收到 close）时下一拍自停；页面隐藏时跳过拉取", () => {
  const hiddenCtx = setup({ hidden: true });
  hiddenCtx.elements.dlgSettings.open = true;
  hiddenCtx.settings.onOpen();
  const before = hiddenCtx.registry.refreshLocal.calls.length;
  hiddenCtx.timers.tickIntervals();
  assert.equal(hiddenCtx.registry.refreshLocal.calls.length, before, "隐藏期不拉");
  hiddenCtx.elements.dlgSettings.open = false;
  hiddenCtx.timers.tickIntervals();
  assert.equal(hiddenCtx.timers.intervals.size, 0);
});

test("onOpen: 版本详情取页面加载时的前端版本；配置摘要与个人配置一并加载", async () => {
  const ctx = setup();
  ctx.elements.dlgSettings.showModal();
  ctx.settings.onOpen();
  await flush();
  assert.match(ctx.elements.settingsVersionBody.innerHTML, /9\.9\.9/);
  assert.equal(ctx.elements.settingsVersionState.textContent, "compatible");
  assert.match(ctx.elements.settingsConfigBody.innerHTML, /团队层服务器/);
  assert.equal(ctx.elements.personalConfigEditor.value, JSON.stringify({ revision: 7, servers: [] }, null, 2));
  assert.equal(ctx.elements.savePersonalConfigBtn.disabled, false);
});

test("onStatus: 只在浮层打开时重算配置摘要", () => {
  const ctx = setup();
  ctx.settings.onStatus();
  assert.equal(ctx.elements.settingsConfigBody.innerHTML, "");
  ctx.elements.dlgSettings.open = true;
  ctx.settings.onStatus();
  assert.match(ctx.elements.settingsConfigBody.innerHTML, /个人层服务器/);
});

test("个人配置：有未保存编辑时服务器变更不覆盖编辑；保存带 revision 做乐观并发检查", async () => {
  const ctx = setup();
  ctx.settings.onOpen();
  await flush();
  ctx.elements.personalConfigEditor.value = '{"sshUser":"me"}';
  await ctx.elements.personalConfigEditor.dispatch("input");
  await ctx.registryDeps().onChanged();
  assert.equal(ctx.elements.personalConfigEditor.value, '{"sshUser":"me"}', "未保存编辑保留");
  assert.match(ctx.elements.configSaveHint.textContent, /已保留你的未保存编辑/);

  await ctx.elements.savePersonalConfigBtn.dispatch("click");
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/config/personal", { sshUser: "me", expectedRevision: 7 }]);
  assert.match(ctx.elements.configSaveHint.textContent, /已保存并重新加载/);

  ctx.elements.personalConfigEditor.value = "[1]";
  await ctx.elements.savePersonalConfigBtn.dispatch("click");
  assert.match(ctx.elements.configSaveHint.textContent, /保存失败：配置必须是 JSON 对象/);
  assert.equal(ctx.elements.savePersonalConfigBtn.disabled, false);
});

test("「出网」写入个人层后重读 JSON 编辑器（避免之后保存撞版本冲突）；编辑器有未保存编辑时只提示不覆盖", async () => {
  const ctx = setup();
  ctx.settings.onOpen();
  await flush();
  assert.ok(ctx.deps.getJson.calls.some(([p]) => p === "/api/egress"), "打开配置时一并读取出网设置");
  const personalReads = () => ctx.deps.getJson.calls.filter(([p]) => p === "/api/config/personal").length;
  const before = personalReads();
  await ctx.settings.egress.setMode("system");
  await flush();
  assert.deepEqual(ctx.deps.postJson.calls.at(-1), ["/api/egress", { mode: "system" }]);
  assert.equal(personalReads(), before + 1, "保存成功后重读个人配置");

  ctx.elements.personalConfigEditor.value = '{"sshUser":"me"}';
  await ctx.elements.personalConfigEditor.dispatch("input");
  await ctx.settings.egress.setMode("direct");
  await flush();
  assert.equal(personalReads(), before + 1, "有未保存编辑时不重读");
  assert.equal(ctx.elements.personalConfigEditor.value, '{"sshUser":"me"}');
  assert.match(ctx.elements.configSaveHint.textContent, /出网设置已写入个人配置/);
});

// ---- v2.57：个人层版本号在浮层之外变了（切换查看的服务器 / Agent、开关监控模块、另一个窗口……）----

// 带版本号的假服务器登记 + 可变的个人层版本号。
function setupWithRevision() {
  let serverRevision = 7;
  const registryState = { revision: null, busy: false };
  const ctx = setup({
    getJson: spy(async (path) => (path === "/api/build-info"
      ? { compatibility: { state: "compatible" } }
      : { config: { revision: serverRevision, servers: [] } })),
  });
  ctx.registry.refresh = spy(async () => { registryState.revision = serverRevision; });
  ctx.registry.getRevision = () => registryState.revision;
  ctx.registry.isBusy = () => registryState.busy;
  const personalReads = () => ctx.deps.getJson.calls.filter(([p]) => p === "/api/config/personal").length;
  return { ...ctx, registryState, personalReads, bump: () => { serverRevision += 1; return serverRevision; } };
}

test("版本号变了：自动重读服务器登记与 JSON 编辑器；版本号没变不重复读", async () => {
  const ctx = setupWithRevision();
  ctx.elements.dlgSettings.open = true;
  ctx.settings.onOpen();
  await flush();
  const reads = ctx.personalReads();
  const refreshes = ctx.registry.refresh.calls.length;
  ctx.settings.onStatus({ personalRevision: 7 });
  await flush();
  assert.equal(ctx.personalReads(), reads, "版本一致：不重读");
  assert.equal(ctx.registry.refresh.calls.length, refreshes);

  const next = ctx.bump(); // 例如从页头切换了查看的服务器
  ctx.settings.onStatus({ personalRevision: next });
  await flush();
  assert.equal(ctx.personalReads(), reads + 1, "JSON 编辑器重读");
  assert.equal(ctx.registry.refresh.calls.length, refreshes + 1, "服务器登记重读");
  assert.equal(ctx.elements.personalConfigEditor.value, JSON.stringify({ revision: next, servers: [] }, null, 2));

  ctx.settings.onStatus({ personalRevision: next });
  ctx.settings.onStatus({ personalRevision: next });
  await flush();
  assert.equal(ctx.personalReads(), reads + 1, "同一版本后续几轮状态不再重读");
  assert.equal(ctx.registry.refresh.calls.length, refreshes + 1);

  await ctx.elements.savePersonalConfigBtn.dispatch("click");
  assert.equal(ctx.deps.postJson.calls.at(-1)[1].expectedRevision, next, "之后保存用的是新版本号，不再撞冲突");
});

test("版本号变了但 JSON 编辑器有未保存的编辑：不覆盖，只提示一次", async () => {
  const ctx = setupWithRevision();
  ctx.elements.dlgSettings.open = true;
  ctx.settings.onOpen();
  await flush();
  ctx.elements.personalConfigEditor.value = '{"sshUser":"me"}';
  await ctx.elements.personalConfigEditor.dispatch("input");
  const reads = ctx.personalReads();
  const next = ctx.bump();
  ctx.settings.onStatus({ personalRevision: next });
  await flush();
  assert.equal(ctx.elements.personalConfigEditor.value, '{"sshUser":"me"}');
  assert.equal(ctx.personalReads(), reads);
  assert.match(ctx.elements.configSaveHint.textContent, /个人配置已在别处更新；已保留你的未保存编辑/);
  ctx.elements.configSaveHint.textContent = "";
  ctx.settings.onStatus({ personalRevision: next });
  await flush();
  assert.equal(ctx.elements.configSaveHint.textContent, "", "同一版本不反复提示");
});

test("版本号变了：服务器登记提交在飞时不打断，结束后的下一轮状态再重读；浮层关着不动", async () => {
  const ctx = setupWithRevision();
  const next = ctx.bump();
  ctx.settings.onStatus({ personalRevision: next });
  await flush();
  assert.equal(ctx.registry.refresh.calls.length, 0, "浮层没打开：什么都不读");

  ctx.elements.dlgSettings.open = true;
  ctx.settings.onOpen();
  await flush();
  const refreshes = ctx.registry.refresh.calls.length;
  const later = ctx.bump();
  ctx.registryState.busy = true;
  ctx.settings.onStatus({ personalRevision: later });
  await flush();
  assert.equal(ctx.registry.refresh.calls.length, refreshes, "提交在飞：不重读");
  ctx.registryState.busy = false;
  ctx.settings.onStatus({ personalRevision: later });
  await flush();
  assert.equal(ctx.registry.refresh.calls.length, refreshes + 1);
});

test("状态里没有版本号（旧后端 / 个人层不存在）：不触发任何重读", async () => {
  const ctx = setupWithRevision();
  ctx.elements.dlgSettings.open = true;
  ctx.settings.onOpen();
  await flush();
  const reads = ctx.personalReads();
  const refreshes = ctx.registry.refresh.calls.length;
  for (const status of [{}, { personalRevision: null }, undefined]) ctx.settings.onStatus(status);
  await flush();
  assert.equal(ctx.personalReads(), reads);
  assert.equal(ctx.registry.refresh.calls.length, refreshes);
});

test("buildSettingsConfigHtml: 分层计数、覆盖字段、默认预算与读取失败提示（转义）", () => {
  const html = buildSettingsConfigHtml({
    servers: [{ source: "team" }, { source: "team" }, { source: "personal" }, null],
    activeServerId: "x", sshUser: "me",
    _configLoadError: true, _configLoadErrorMessage: "<bad>",
  });
  assert.match(html, /团队层服务器<\/span><span>3</);
  assert.match(html, /个人层服务器（含屏蔽）<\/span><span>1</);
  assert.match(html, /activeServerId、sshUser/);
  assert.match(html, /50 MB/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(buildSettingsConfigHtml({ servers: [] }), /个人配置读取失败/);
});
