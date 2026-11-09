import assert from "node:assert/strict";
import test from "node:test";

import { createServerSwitch } from "./server-switch.js";
import { createAppState } from "./state.js";
import { deferred, fakeDocument, fakeElement, flush, spy } from "./test-support.mjs";

function setup({ postJson = spy(async () => ({})), getStatus = spy(async () => ({ activeServerId: "b" })), config } = {}) {
  const elements = { serverSelect: fakeElement(), connectionProfileSelect: fakeElement(), agentOverviewGrid: fakeElement(), serverBriefsContainer: fakeElement(), agentSelect: fakeElement() };
  const doc = fakeDocument(elements);
  const state = createAppState();
  const pending = { show: spy(), hide: spy() };
  const deps = {
    doc, state, postJson, getStatus, pending,
    getConfig: spy(async () => config),
    render: spy((s) => state.setStatus(s)),
    showToast: spy(),
    logsPanel: { refresh: spy() },
    renderServerBriefs: spy(),
    resetCharts: spy(),
    seedFromMetrics: spy(),
  };
  return { deps, elements, state, pending, switcher: createServerSwitch(deps) };
}

test("switchActiveServer: 连点两台时先发后到的响应被丢弃，遮罩按次数收起", async () => {
  const slow = deferred();
  const posts = [];
  const postJson = spy((_path, body) => {
    posts.push(body.activeServerId);
    return body.activeServerId === "a" ? slow.promise : Promise.resolve({});
  });
  const ctx = setup({ postJson });
  const first = ctx.switcher.switchActiveServer("a");
  const second = ctx.switcher.switchActiveServer("b");
  await second;
  slow.resolve({});
  await first;
  assert.deepEqual(posts, ["a", "b"]);
  assert.deepEqual(postJson.calls[1], ["/api/config/active", { activeServerId: "b" }]);
  assert.equal(ctx.deps.render.calls.length, 1, "只渲染最后一次切换");
  assert.equal(ctx.deps.resetCharts.calls.length, 1, "过期的切换不清图表");
  assert.deepEqual(ctx.deps.seedFromMetrics.calls, [["b"]]);
  assert.deepEqual(ctx.pending.show.calls, [["server"], ["server"]], "等待态按切换种类进入");
  assert.equal(ctx.pending.hide.calls.length, 2);
  assert.equal(ctx.deps.showToast.calls.length, 1);
});

test("switchActiveAgent: 写 agent-active 后渲染；失败 toast 原因", async () => {
  const ctx = setup();
  await ctx.switcher.switchActiveAgent("claude");
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/config/agent-active", { activeAgentId: "claude" }]]);
  assert.equal(ctx.deps.render.calls.length, 1);
  assert.equal(ctx.deps.resetCharts.calls.length, 0, "切 Agent 不动图表");

  const failing = setup({ postJson: spy(async () => { throw new Error("offline"); }) });
  const origError = console.error;
  console.error = () => {};
  try {
    await failing.switcher.switchActiveAgent("claude");
  } finally {
    console.error = origError;
  }
  assert.deepEqual(failing.deps.showToast.calls[0][0], { type: "error", message: "切换 Agent 失败: offline", title: "切换失败" });
  assert.deepEqual(failing.pending.hide.calls, [["agent"]], "失败也要退出等待态");
});

test("loadServers: 只列启用且监控中的服务器（转义），记下 config；正在看的服务器被移除时清图表", async () => {
  const config = {
    activeServerId: "b",
    servers: [
      { id: "a", name: "<b>A</b>" },
      { id: "b", displayName: "B 显示名" },
      { id: "off", disabled: true },
      { id: "quiet", monitorEnabled: false },
    ],
  };
  const ctx = setup({ config });
  ctx.state.setStatus({ activeServerId: "off", serversBrief: {}, layers: null });
  await ctx.switcher.loadServers();
  const select = ctx.elements.serverSelect;
  assert.equal(select.innerHTML, '<option value="a">&lt;b&gt;A&lt;/b&gt;</option><option value="b">B 显示名</option>');
  assert.equal(select.value, "b");
  assert.equal(select.disabled, false);
  assert.equal(ctx.elements.connectionProfileSelect.innerHTML, select.innerHTML);
  assert.equal(ctx.elements.connectionProfileSelect.value, "b");
  assert.equal(ctx.state.getConfig(), config);
  assert.equal(ctx.deps.resetCharts.calls.length, 1);
  assert.equal(ctx.deps.renderServerBriefs.calls[0][1], "b");
  select.value = "a";
  select.onchange();
  await flush();
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/config/active", { activeServerId: "a" }]);
});

test("顶部连接选择可切换 master 和 node04，分别保存的用户名与密钥留在各自配置", async () => {
  const config = { activeServerId: "master", servers: [
    { id: "master", name: "master", host: "master.example", sshUser: "root", sshIdentityFile: "/keys/master" },
    { id: "node04", name: "node04", host: "node04.example", sshUser: "lin", sshIdentityFile: "/keys/node04" },
  ] };
  const ctx = setup({ config });
  await ctx.switcher.loadServers();
  ctx.elements.connectionProfileSelect.value = "node04";
  ctx.elements.connectionProfileSelect.onchange();
  await flush();
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/config/active", { activeServerId: "node04" }]);
  assert.deepEqual(config.servers.map((s) => [s.sshUser, s.sshIdentityFile]), [["root", "/keys/master"], ["lin", "/keys/node04"]]);
});

test("bindSwitchers: Agent 卡与服务器卡点击切换；点当前服务器不重复切换", async () => {
  const ctx = setup();
  ctx.state.setStatus({ activeServerId: "a" });
  ctx.switcher.bindSwitchers();
  await ctx.elements.serverBriefsContainer.dispatch("click", { target: fakeElement({ dataset: { id: "a" } }) });
  assert.equal(ctx.deps.postJson.calls.length, 0);
  const card = fakeElement({ dataset: { id: "b" } });
  await ctx.elements.serverBriefsContainer.dispatch("click", { target: fakeElement({ parent: card }) });
  await ctx.elements.agentOverviewGrid.dispatch("click", { target: fakeElement({ dataset: { agentId: "claude" } }) });
  ctx.elements.agentSelect.value = "codex";
  await ctx.elements.agentSelect.dispatch("change");
  await flush();
  assert.deepEqual(ctx.deps.postJson.calls.map((c) => c[1]), [{ activeServerId: "b" }, { activeAgentId: "claude" }, { activeAgentId: "codex" }]);
});
