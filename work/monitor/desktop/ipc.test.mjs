import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createDesktopContext } from "./context.mjs";
import { isTrustedAppIpc, registerDesktopIpc } from "./ipc.mjs";

function fakeWindow(url, calls = []) {
  const mainFrame = { url };
  let destroyed = false;
  return {
    webContents: { mainFrame },
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    hide: () => calls.push("hide"),
  };
}

const eventFrom = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });

function makeHarness() {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const calls = [];
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, { kind: "handle", fn }),
    on: (channel, fn) => handlers.set(channel, { kind: "on", fn }),
  };
  Object.assign(ctx.actions, {
    createMainWindow: () => calls.push("createMainWindow"),
    requestQuit: () => calls.push("requestQuit"),
    requestQuitWithConfirm: () => calls.push("requestQuitWithConfirm"),
    restartFromRenderer: () => { calls.push("restartFromRenderer"); return { ok: true, reason: "ok" }; },
    getAutostart: () => { calls.push("getAutostart"); return { supported: true, enabled: false, status: "not-registered", error: null }; },
    setAutostart: (enabled) => { calls.push(["setAutostart", enabled]); return { supported: true, enabled, status: enabled ? "enabled" : "not-registered", error: null }; },
    saveDiagnosticsBundle: (payload) => { calls.push(["saveDiagnosticsBundle", payload]); return { saved: true, path: "/tmp/x.json" }; },
    saveExportFile: (payload) => { calls.push(["saveExportFile", payload]); return { saved: true, name: "x.json" }; },
    isIslandPinned: () => { calls.push("isIslandPinned"); return true; },
    setIslandPinned: (pinned) => { calls.push(["setIslandPinned", pinned]); return pinned; },
    resizeIslandWindow: (height) => calls.push(["resizeIslandWindow", height]),
  });
  registerDesktopIpc({ ipcMain, ctx });
  const main = fakeWindow("http://127.0.0.1:8877/", calls);
  const island = fakeWindow(pathToFileURL(ctx.islandHtmlPath).href, calls);
  ctx.state.mainWindow = main;
  ctx.state.islandWindow = island;
  const invoke = (channel, ...args) => handlers.get(channel).fn(...args);
  return { ctx, state: ctx.state, calls, handlers, main, island, invoke };
}

test("注册的通道与 preload.js 暴露的调用一一对应（handle ↔ invoke，on ↔ send）", () => {
  const h = makeHarness();
  const preload = readFileSync(new URL("../../../preload.js", import.meta.url), "utf8");
  const expected = new Map();
  for (const m of preload.matchAll(/ipcRenderer\.(invoke|send)\("([^"]+)"/g)) expected.set(m[2], m[1] === "invoke" ? "handle" : "on");
  assert.deepEqual(
    Object.fromEntries([...h.handlers].map(([channel, { kind }]) => [channel, kind]).sort()),
    Object.fromEntries([...expected].sort()),
  );
});

test("isTrustedAppIpc：只认本应用两个窗口的主 frame，且主窗口 origin / 悬浮岛文件都要对", () => {
  const h = makeHarness();
  const opts = { mainWindow: h.main, islandWindow: h.island, islandHtmlPath: h.ctx.islandHtmlPath };
  assert.equal(isTrustedAppIpc(eventFrom(h.main), opts), true);
  assert.equal(isTrustedAppIpc(eventFrom(h.island), opts), true);
  assert.equal(isTrustedAppIpc(eventFrom(h.main, { url: "http://127.0.0.1:8877/" }), opts), false, "子 frame 不可信");
  assert.equal(isTrustedAppIpc({ sender: {}, senderFrame: {} }, opts), false, "其它 webContents 不可信");
  const navigatedMain = fakeWindow("https://evil.example/");
  assert.equal(isTrustedAppIpc(eventFrom(navigatedMain), { ...opts, mainWindow: navigatedMain }), false);
  const otherFile = fakeWindow(pathToFileURL("/tmp/poisoned.html").href);
  assert.equal(isTrustedAppIpc(eventFrom(otherFile), { ...opts, islandWindow: otherFile }), false, "file: 只放行 island.html 这一个文件");
  h.main.destroy();
  assert.equal(isTrustedAppIpc(eventFrom(h.main), opts), false, "已销毁的窗口不可信");
});

test("get-auth-token / restart-control-plane / get-bundle-update：不可信调用方直接抛错", async () => {
  const h = makeHarness();
  const stranger = { sender: {}, senderFrame: {} };
  assert.equal(h.invoke("get-auth-token", eventFrom(h.island)), h.ctx.authToken);
  for (const channel of ["get-auth-token", "restart-control-plane", "get-bundle-update"]) {
    assert.throws(() => h.invoke(channel, stranger), /仅接受应用窗口调用/, channel);
  }
  assert.deepEqual(h.invoke("restart-control-plane", eventFrom(h.main)), { ok: true, reason: "ok" });
  assert.deepEqual(h.calls, ["restartFromRenderer"]);
  assert.equal(h.invoke("get-bundle-update", eventFrom(h.main)), null);
  h.state.pendingBundleUpdate = { version: "2.29.0", key: "k" };
  const copy = h.invoke("get-bundle-update", eventFrom(h.main));
  assert.deepEqual(copy, { version: "2.29.0", key: "k" });
  copy.version = "tampered";
  assert.equal(h.state.pendingBundleUpdate.version, "2.29.0", "返回副本，渲染层改不到主进程状态");
});

test("窗口 / 退出通道：可信时转给对应动作，不可信时静默忽略", () => {
  const h = makeHarness();
  const stranger = { sender: {}, senderFrame: {} };
  for (const channel of ["open-main-window", "quit-app", "request-quit", "hide-window"]) h.invoke(channel, stranger);
  assert.deepEqual(h.calls, []);
  h.invoke("open-main-window", eventFrom(h.island));
  assert.deepEqual(h.calls, ["createMainWindow", "hide"], "打开大窗口后收起悬浮岛");
  h.invoke("quit-app", eventFrom(h.main));
  h.invoke("request-quit", eventFrom(h.island));
  h.invoke("hide-window", eventFrom(h.main));
  assert.deepEqual(h.calls.slice(2), ["requestQuit", "requestQuitWithConfirm", "hide"]);
});

test("get-autostart / set-autostart：不可信调用方直接抛错；可信时转给登录项动作，写入只认布尔 true", () => {
  const h = makeHarness();
  const stranger = { sender: {}, senderFrame: {} };
  for (const channel of ["get-autostart", "set-autostart"]) {
    assert.throws(() => h.invoke(channel, stranger, true), /仅接受应用窗口调用/, channel);
  }
  assert.deepEqual(h.calls, [], "不可信的调用一个动作都没触发");
  assert.deepEqual(h.invoke("get-autostart", eventFrom(h.main)), { supported: true, enabled: false, status: "not-registered", error: null });
  assert.equal(h.invoke("set-autostart", eventFrom(h.main), true).enabled, true);
  assert.equal(h.invoke("set-autostart", eventFrom(h.main), false).enabled, false);
  // 渲染层传来别的东西（字符串、对象、缺省）一律当成关，不会误开。
  for (const junk of ["true", 1, { enabled: true }, undefined]) h.invoke("set-autostart", eventFrom(h.main), junk);
  assert.deepEqual(h.calls, ["getAutostart", ["setAutostart", true], ["setAutostart", false], ["setAutostart", false], ["setAutostart", false], ["setAutostart", false], ["setAutostart", false]]);
});

test("save-diagnostics：不可信调用方直接抛错；可信时把 { filename, text } 原样交给保存动作（校验在 diagnostics-save.mjs）", () => {
  const h = makeHarness();
  assert.throws(() => h.invoke("save-diagnostics", { sender: {}, senderFrame: {} }, { filename: "a.json", text: "{}" }), /仅接受应用窗口调用/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.invoke("save-diagnostics", eventFrom(h.main), { filename: "a.json", text: "{}" }), { saved: true, path: "/tmp/x.json" });
  assert.deepEqual(h.calls, [["saveDiagnosticsBundle", { filename: "a.json", text: "{}" }]]);
});

test("save-export-file：不可信调用方直接抛错；可信时只把文件名与文本交给导出动作（别的字段不往下传）", () => {
  const h = makeHarness();
  assert.throws(() => h.invoke("save-export-file", { sender: {}, senderFrame: {} }, { content: "{}" }), /仅接受应用窗口调用/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.invoke("save-export-file", eventFrom(h.main), { defaultName: "a.json", content: "{}", filePath: "/etc/passwd" }), { saved: true, name: "x.json" });
  assert.deepEqual(h.calls, [["saveExportFile", { defaultName: "a.json", content: "{}" }]]);
});

test("悬浮岛通道：只认悬浮岛自己——主窗口与不可信调用方都被拒；钉住只收布尔 true", async () => {
  const h = makeHarness();
  const fromIsland = eventFrom(h.island);
  const fromMain = eventFrom(h.main);
  assert.deepEqual(await h.invoke("island-get-state", fromIsland), { pinned: true });
  assert.deepEqual(await h.invoke("island-set-pinned", fromIsland, true), { pinned: true });
  assert.deepEqual(await h.invoke("island-set-pinned", fromIsland, "yes"), { pinned: false });
  h.invoke("island-resize", fromIsland, "280");
  for (const event of [fromMain, { sender: {}, senderFrame: {} }]) {
    assert.throws(() => h.invoke("island-get-state", event), /仅接受悬浮岛调用/);
    assert.throws(() => h.invoke("island-set-pinned", event, true), /仅接受悬浮岛调用/);
    h.invoke("island-resize", event, 500);
  }
  assert.deepEqual(h.calls, ["isIslandPinned", ["setIslandPinned", true], ["setIslandPinned", false], ["resizeIslandWindow", 280]]);
});
