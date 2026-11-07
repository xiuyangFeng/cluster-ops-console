import assert from "node:assert/strict";
import test from "node:test";

import { createCommandPalette } from "./command-palette.js";
import { fakeDialog, fakeDocument, fakeElement } from "./app/test-support.mjs";

function setup({ activeElement = null } = {}) {
  const doc = fakeDocument({});
  const opener = fakeElement({ tag: "button" });
  doc.activeElement = activeElement || opener;
  const dialogEl = fakeDialog({ ownerDocument: doc, querySelector: () => null });
  const inputEl = fakeElement({ tag: "input", ownerDocument: doc });
  const listEl = fakeElement({ tag: "div", ownerDocument: doc, querySelector: () => null });
  return { doc, opener, dialogEl, inputEl, listEl };
}

const withWindow = async (fn) => {
  const saved = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    return await fn();
  } finally {
    globalThis.window = saved;
  }
};

test("命令面板：combobox / listbox / aria-activedescendant 完整，上下键与 Home/End 更新活动项", () => withWindow(async () => {
  const { dialogEl, inputEl, listEl } = setup();
  const palette = createCommandPalette({ dialogEl, inputEl, listEl, getStatus: () => null, getConfig: () => null });
  assert.equal(inputEl.getAttribute("role"), "combobox");
  assert.equal(inputEl.getAttribute("aria-haspopup"), "listbox");
  assert.equal(inputEl.getAttribute("aria-controls"), "cmdList");
  assert.equal(listEl.getAttribute("role"), "listbox");

  palette.open();
  assert.equal(inputEl.getAttribute("aria-expanded"), "true");
  assert.equal(inputEl.getAttribute("aria-activedescendant"), "cmd-opt-0");
  assert.match(listEl.innerHTML, /id="cmd-opt-0" data-index="0" role="option" aria-selected="true"/);

  await inputEl.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(inputEl.getAttribute("aria-activedescendant"), "cmd-opt-1");
  assert.match(listEl.innerHTML, /id="cmd-opt-1" data-index="1" role="option" aria-selected="true"/);
  await inputEl.dispatch("keydown", { key: "End" });
  assert.match(inputEl.getAttribute("aria-activedescendant"), /^cmd-opt-\d+$/);
  await inputEl.dispatch("keydown", { key: "Home" });
  assert.equal(inputEl.getAttribute("aria-activedescendant"), "cmd-opt-0");
}));

test("命令面板：Esc / 关闭按钮关闭后焦点回到打开前的元素", () => withWindow(async () => {
  const { doc, opener, dialogEl, inputEl, listEl } = setup();
  const palette = createCommandPalette({ dialogEl, inputEl, listEl, getStatus: () => null, getConfig: () => null });
  palette.open();
  opener.focused = false;
  await inputEl.dispatch("keydown", { key: "Escape" });
  assert.equal(dialogEl.open, false);
  assert.equal(opener.focused, true, "Esc 关闭后焦点回到打开者");
  assert.equal(doc.activeElement, opener);

  // 再次打开后从 close 按钮（或外部 close()）关闭也一样
  palette.open();
  opener.focused = false;
  palette.close();
  assert.equal(opener.focused, true, "close() 关闭后焦点回到打开者");
}));

test("命令面板：执行完命令后打开了别的模态浮层时，不把焦点抢回旧元素", () => withWindow(() => {
  const { doc, opener, dialogEl, inputEl, listEl } = setup();
  // 模拟另一个模态浮层已经打开：dialog.close() 的 close 事件晚于命令执行
  let otherModal = null;
  doc.querySelector = (selector) => (selector === "dialog:modal" ? otherModal : null);
  const palette = createCommandPalette({ dialogEl, inputEl, listEl, getStatus: () => null, getConfig: () => null });
  palette.open();
  opener.focused = false;
  otherModal = fakeDialog({ ownerDocument: doc, querySelector: () => null });
  palette.close();
  assert.equal(opener.focused, false, "别的浮层开着时焦点留在新浮层里");
}));
