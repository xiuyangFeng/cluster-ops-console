import assert from "node:assert/strict";
import { test } from "node:test";

import { createCodexAppServerRestart, restartToast, RESTART_CONFIRM_TEXT } from "./codex-app-server.js";

const button = { disabled: false, isConnected: true, getAttribute: () => "s1", closest: () => button };
const clickEvent = { target: { closest: (selector) => (selector === "[data-codex-app-server-restart]" ? button : null) } };

function setup({ confirm = () => true, postJson = async () => ({ ok: true, result: "restarted", message: "已重启" }) } = {}) {
  const toasts = [];
  const posts = [];
  const refreshes = [];
  const timers = [];
  const ctrl = createCodexAppServerRestart({
    doc: { addEventListener() {} },
    postJson: async (url, body) => { posts.push([url, body]); return postJson(url, body); },
    showToast: (toast) => toasts.push(toast),
    confirm,
    refresh: async (options) => { refreshes.push(options); },
    getActiveServerId: () => "s1",
    setTimer: (_fn, ms) => { timers.push(ms); },
  });
  return { ctrl, toasts, posts, refreshes, timers };
}

test("toast 文案：成功 / 失败各有明确结论", () => {
  assert.equal(restartToast({ ok: true, message: "已重启" }).type, "success");
  assert.match(restartToast({ ok: false, error: "ssh exit 255" }).message, /ssh exit 255/);
});

test("点击：先确认，再 POST 只带 serverId；成功后立即刷新并排两拍补刷", async () => {
  const h = setup();
  await h.ctrl.handleClick(clickEvent);
  assert.deepEqual(h.posts, [["/api/codex/app-server/restart", { serverId: "s1" }]]);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].type, "success");
  assert.deepEqual(h.refreshes, [{ force: true }]);
  assert.deepEqual(h.timers, [3000, 8000]);
  assert.equal(button.disabled, false);
});

test("点击：取消不发请求；接口失败给 warn，不刷新", async () => {
  const canceled = setup({ confirm: () => false });
  await canceled.ctrl.handleClick(clickEvent);
  assert.deepEqual(canceled.posts, []);
  assert.equal(RESTART_CONFIRM_TEXT.includes("中断"), true);

  const failing = setup({ postJson: async () => { throw Object.assign(new Error("nope"), { serverMessage: "SSH 连不上服务器" }); } });
  await failing.ctrl.handleClick(clickEvent);
  assert.equal(failing.toasts[0].type, "warn");
  assert.match(failing.toasts[0].message, /SSH 连不上服务器/);
  assert.deepEqual(failing.refreshes, []);
  assert.equal(button.disabled, false);
});

test("点击：正在进行时忽略第二次，避免重复重启", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = setup({ postJson: async () => { await gate; return { ok: true, result: "restarted" }; } });
  const first = h.ctrl.handleClick(clickEvent);
  await h.ctrl.handleClick(clickEvent);
  release();
  await first;
  assert.equal(h.posts.length, 1);
});
