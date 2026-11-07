import assert from "node:assert/strict";
import test from "node:test";

import { QUIT_CONFIRM_TEXT } from "../ui-labels.js";
import { initSession } from "./session.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

function desktopDoc() {
  return fakeDocument({ desktopControls: fakeElement(), desktopHideBtn: fakeElement(), desktopQuitBtn: fakeElement() });
}

test("桌面模式：显示窗口按钮，Token 走 IPC；退出先确认", async () => {
  const doc = desktopDoc();
  const electronAPI = { hideWindow: spy(), quitApp: spy(), getAuthToken: async () => "ipc-token" };
  const configure = spy();
  let answer = false;
  const confirm = spy(() => answer);
  const fetchSession = spy(async () => ({ token: "web" }));
  await initSession({ doc, electronAPI, configure, confirm, fetchSession });
  assert.equal(doc.elements.desktopControls.style.display, "flex");
  assert.deepEqual(configure.calls, [[{ token: "ipc-token" }]]);
  assert.equal(fetchSession.calls.length, 0);
  await doc.elements.desktopHideBtn.dispatch("click");
  assert.equal(electronAPI.hideWindow.calls.length, 1);
  await doc.elements.desktopQuitBtn.dispatch("click");
  assert.deepEqual(confirm.calls, [[QUIT_CONFIRM_TEXT]]);
  assert.equal(electronAPI.quitApp.calls.length, 0, "取消确认不退出");
  answer = true;
  await doc.elements.desktopQuitBtn.dispatch("click");
  assert.equal(electronAPI.quitApp.calls.length, 1);
});

test("Web 模式：从同源 /api/session 取 Token；取不到或失败都静默", async () => {
  const doc = desktopDoc();
  const configure = spy();
  await initSession({ doc, configure, confirm: () => true, fetchSession: async () => ({ token: "web-token" }) });
  assert.deepEqual(configure.calls, [[{ token: "web-token" }]]);
  assert.equal(doc.elements.desktopControls.style.display, undefined, "Web 模式不显示桌面按钮");
  await initSession({ doc, configure, confirm: () => true, fetchSession: async () => null });
  await initSession({ doc, configure, confirm: () => true, fetchSession: async () => { throw new Error("offline"); } });
  const failingIpc = { hideWindow() {}, quitApp() {}, getAuthToken: async () => { throw new Error("ipc"); } };
  await initSession({ doc: desktopDoc(), electronAPI: failingIpc, configure, confirm: () => true });
  assert.equal(configure.calls.length, 1);
});
