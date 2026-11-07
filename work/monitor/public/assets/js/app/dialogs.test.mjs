import assert from "node:assert/strict";
import test from "node:test";

import { createDialogs } from "./dialogs.js";
import { fakeDialog, fakeDocument, fakeElement, spy } from "./test-support.mjs";

function setup() {
  const dlgSettings = fakeDialog();
  const dlgLogs = fakeDialog();
  const endpointContent = fakeElement({ parent: fakeDialog() });
  const toolbar = fakeElement();
  const content = fakeElement({ tag: "main" });
  const doc = fakeDocument(
    { dlgSettings, dlgLogs, endpointContent },
    { ".sidebar-nav": [toolbar], "main.console": [content], "dialog.hud-dialog": [dlgSettings, dlgLogs] },
  );
  const logsPanel = { openOperation: spy() };
  return { doc, dlgSettings, dlgLogs, endpointContent, toolbar, content, logsPanel, dialogs: createDialogs({ doc, logsPanel }) };
}

test("openDialog: 先打开再按登记顺序执行该浮层的钩子；不存在的浮层静默忽略", () => {
  const { dialogs, dlgSettings } = setup();
  const order = [];
  dialogs.onDialogOpen("dlgSettings", () => order.push(["a", dlgSettings.open]));
  dialogs.onDialogOpen("dlgSettings", () => order.push(["b", dlgSettings.open]));
  dialogs.onDialogOpen("dlgLogs", () => order.push(["logs"]));
  dialogs.openDialog("dlgSettings");
  assert.deepEqual(order, [["a", true], ["b", true]]);
  assert.doesNotThrow(() => dialogs.openDialog("missing"));
});

test("isPanelOpen: 以面板所在 dialog 的 open 为准", () => {
  const { dialogs, endpointContent } = setup();
  assert.equal(dialogs.isPanelOpen("endpointContent"), false);
  endpointContent.parent.open = true;
  assert.equal(dialogs.isPanelOpen("endpointContent"), true);
  assert.equal(dialogs.isPanelOpen("missing"), false);
});

test("openLogsForOperation: 按 operationId 过滤并打开日志浮层，不触发 dlgLogs 的无过滤刷新钩子", () => {
  const { dialogs, dlgLogs, logsPanel } = setup();
  const hook = spy();
  dialogs.onDialogOpen("dlgLogs", hook);
  dialogs.openLogsForOperation("op-9");
  assert.deepEqual(logsPanel.openOperation.calls, [["op-9"]]);
  assert.equal(dlgLogs.open, true);
  assert.equal(hook.calls.length, 0);
  dialogs.openLogsForOperation("op-10");
  assert.equal(dlgLogs.showCount, 1, "已打开时不重复 showModal");
});

test("initDialogChrome: 内容区里渲染出来的 [data-dialog]（如空状态的「添加服务器」）同样打开浮层", async () => {
  const { dialogs, content, dlgSettings } = setup();
  dialogs.initDialogChrome();
  await content.dispatch("click", { target: fakeElement({ dataset: { dialog: "dlgSettings" }, parent: content }) });
  assert.equal(dlgSettings.open, true);
});

test("initDialogChrome: 侧栏 [data-dialog] 打开浮层；[data-close] 或点遮罩关闭，点内容不关", async () => {
  const { dialogs, toolbar, dlgSettings } = setup();
  dialogs.initDialogChrome();
  const trigger = fakeElement({ dataset: { dialog: "dlgSettings" }, parent: toolbar });
  await toolbar.dispatch("click", { target: trigger });
  assert.equal(dlgSettings.open, true);
  await dlgSettings.dispatch("click", { target: fakeElement({ parent: dlgSettings }) });
  assert.equal(dlgSettings.open, true, "点浮层内容不关");
  await dlgSettings.dispatch("click", { target: fakeElement({ dataset: { close: "" }, parent: dlgSettings }) });
  assert.equal(dlgSettings.open, false);
  dlgSettings.open = true;
  await dlgSettings.dispatch("click", { target: dlgSettings });
  assert.equal(dlgSettings.open, false, "点遮罩（dialog 本身）关闭");
});

test("initDialogChrome: 浮层里的 [data-dialog] 入口先关掉所在浮层，再打开目标并执行它的钩子", async () => {
  const { dialogs, dlgSettings, dlgLogs } = setup();
  const hook = spy();
  dialogs.onDialogOpen("dlgLogs", hook);
  dialogs.initDialogChrome();
  dialogs.openDialog("dlgSettings");
  const entry = fakeElement({ dataset: { dialog: "dlgLogs" }, parent: dlgSettings });
  await dlgSettings.dispatch("click", { target: entry });
  assert.equal(dlgSettings.open, false, "所在浮层关闭，两个模态不叠在一起");
  assert.equal(dlgLogs.open, true);
  assert.equal(hook.calls.length, 1);
});
