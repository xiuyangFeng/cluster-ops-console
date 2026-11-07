import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMethodsHtml,
  buildRelayNotesHtml,
  buildResultHtml,
  cliIdForAgent,
  createCliLoginDialog,
  describePhase,
  POLL_CLOSED_MS,
} from "./cli-login-dialog.js";
import { deferred, fakeDialog, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const KEY = "sk-test-SECRET-1234567890";
const URL_CODEX = "https://auth.openai.com/oauth/authorize?state=abc";

test("纯函数：Agent → CLI、方式列表、中转站说明、进度与结果（全部转义）", () => {
  assert.equal(cliIdForAgent({ id: "codex", kind: "codex" }), "codex");
  assert.equal(cliIdForAgent({ id: "cc", kind: "claude-code" }), "claude");
  assert.equal(cliIdForAgent({ id: "claude-codewing", kind: "reclaude" }), null);
  const methods = buildMethodsHtml("claude", "setup-token");
  assert.equal((methods.match(/data-cl-method=/g) || []).length, 4);
  assert.match(methods, /aria-checked="true" data-cl-method="setup-token"/);
  assert.equal((buildMethodsHtml("codex", "account").match(/data-cl-method=/g) || []).length, 3);
  assert.match(buildRelayNotesHtml({ ok: false, error: "<x>" }), /is-warn">&lt;x&gt;/);
  assert.match(buildRelayNotesHtml({ ok: true, notes: ["http:// 是明文", "普通说明"] }), /cl-note is-warn">http:\/\/ 是明文<\/span><span class="cl-note">普通说明/);
  assert.equal(describePhase({ state: "running", phaseText: "等授权" }), "等授权");
  assert.equal(describePhase({ state: "timeout" }), "已超时");
  const ok = buildResultHtml({ state: "succeeded", message: "已登录", notes: ["n<1>"], warnings: ["w"], status: { detail: "ChatGPT 账号" } });
  assert.match(ok, /cl-message is-ok">已登录/);
  assert.match(ok, /<li class="is-warn">w<\/li><li class="">n&lt;1&gt;<\/li><li class="">当前登录：ChatGPT 账号<\/li>/);
  assert.match(buildResultHtml({ state: "failed", error: { message: "不行" } }), /is-fail">不行/);
});

function setup({ getJson, postJson, onCliChanged = () => {} } = {}) {
  const els = {};
  const el = (id, props = {}) => {
    els[id] = fakeElement(props);
    return els[id];
  };
  const cliBtns = [fakeElement({ tag: "button", dataset: { cli: "codex" } }), fakeElement({ tag: "button", dataset: { cli: "claude" } })];
  el("cliLoginCli", { querySelectorAll: () => cliBtns });
  for (const id of ["cliLoginTitle", "cliLoginServer", "cliLoginMethods", "cliLoginFields", "cliLoginUrlField", "cliLoginProviderField", "cliLoginRelayNotes", "cliLoginPlainField", "cliLoginKeyLabel", "cliLoginStart", "cliLoginHint", "cliLoginForm", "cliLoginProgress", "cliLoginPhase", "cliLoginLink", "cliLoginUrl", "cliLoginCodeForm", "cliLoginResult", "cliLoginCancel", "cliLoginAgain", "cliLoginCopy"]) el(id);
  for (const id of ["cliLoginKey", "cliLoginBaseUrl", "cliLoginProvider", "cliLoginCode"]) el(id, { tag: "input" });
  el("cliLoginPlain", { tag: "input", checked: false });
  els.dlgCliLogin = fakeDialog();
  const doc = fakeDocument(els);
  const docListeners = [];
  doc.addEventListener = (type, fn) => docListeners.push([type, fn]);
  const timers = fakeTimers();
  const toasts = [];
  const openDialog = spy((id) => els[id].showModal());
  const dialog = createCliLoginDialog({
    doc,
    getJson: getJson || (async () => ({ job: null })),
    postJson: postJson || (async () => ({})),
    showToast: (t) => toasts.push(t),
    copyText: async () => true,
    openDialog,
    onCliChanged,
    getActiveServerId: () => "server-01",
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  dialog.init();
  return { dialog, els, doc, docListeners, timers, toasts, openDialog, cliBtns };
}

const methodClick = (els, method) => els.cliLoginMethods.dispatch("click", { target: fakeElement({ dataset: { clMethod: method } }) });

test("引导可直达中转站并指定服务器，旧打开请求不能覆盖新目标", async () => {
  const old = deferred();
  const h = setup({ getJson: p => p.endsWith("serverId=old") ? old.promise : Promise.resolve({ job: null }) });
  const first = h.dialog.open({ cli: "claude", serverId: "old", method: "relay" });
  await h.dialog.open({ cli: "codex", serverId: "new", method: "relay" });
  old.resolve({ job: { jobId: "stale", cli: "claude", state: "running" } }); await first;
  assert.match(h.els.cliLoginServer.textContent, /new/);
  assert.match(h.els.cliLoginMethods.innerHTML, /aria-checked="true" data-cl-method="relay"/);
  assert.equal(h.els.cliLoginProgress.hidden, true);
});

test("中转地址清空后，前一个在途检查不能重新显示旧地址的结果", async () => {
  const pending = deferred();
  const h = setup({ postJson: () => pending.promise });
  await h.dialog.open({ method: "relay" });
  h.els.cliLoginBaseUrl.value = "https://old.example";
  await h.els.cliLoginBaseUrl.dispatch("input"); h.timers.runTimeouts();
  h.els.cliLoginBaseUrl.value = ""; await h.els.cliLoginBaseUrl.dispatch("input");
  pending.resolve({ ok: true, notes: ["old address"] }); await flush();
  assert.doesNotMatch(h.els.cliLoginRelayNotes.innerHTML, /old address/);
});

test("快速完成或取消任务也通知引导刷新，解除工具忙碌状态", async () => {
  const onCliChanged = spy();
  const job = { jobId: "quick", cli: "codex", serverId: "server-01", method: "relay", state: "succeeded" };
  const h = setup({ postJson: async () => ({ job }), onCliChanged });
  await h.dialog.open({ method: "relay" });
  h.els.cliLoginKey.value = KEY;
  h.els.cliLoginBaseUrl.value = "https://relay.example/v1";
  await h.els.cliLoginForm.dispatch("submit");
  assert.deepEqual(onCliChanged.calls, [[job]]);
});

test("打开：预选 CLI、默认账号授权、带上当前服务器；有进行中的任务就接着显示进度", async () => {
  const gets = [];
  const running = { jobId: "j1", cli: "claude", method: "account", state: "running", phase: "waiting-code", phaseText: "粘贴授权码", url: "https://claude.ai/oauth/authorize?x", needsCode: true, warnings: [], notes: [] };
  const { dialog, els, openDialog, cliBtns, timers } = setup({ getJson: async (url) => { gets.push(url); return url.includes("current") ? { job: running } : { job: running }; } });
  await dialog.open({ cli: "claude" });
  assert.deepEqual(openDialog.calls, [["dlgCliLogin"]]);
  assert.equal(els.cliLoginServer.textContent, "服务器 server-01");
  assert.equal(cliBtns[1].getAttribute("aria-pressed"), "true");
  assert.deepEqual(gets, ["/api/cli/login/current?serverId=server-01"]);
  assert.equal(els.cliLoginForm.hidden, true);
  assert.equal(els.cliLoginProgress.hidden, false);
  assert.equal(els.cliLoginLink.hidden, false);
  assert.equal(els.cliLoginUrl.getAttribute("href"), running.url);
  assert.equal(els.cliLoginCodeForm.hidden, false);
  assert.equal(timers.timeouts.size, 1, "开始轮询");
});

test("API key：提交时先清空输入框再发请求；key 不进任何状态；轮询到成功后提示", async () => {
  let posted;
  let keyAtPost;
  let pollJob = { jobId: "j2", cli: "codex", method: "api", state: "running", phaseText: "写入中", warnings: [], notes: [] };
  const { dialog, els, timers, toasts } = setup({
    getJson: async (url) => (url.includes("current") ? { job: null } : { job: pollJob }),
    postJson: async (url, body) => {
      posted = [url, { ...body }];
      keyAtPost = els.cliLoginKey.value;
      return { jobId: "j2", job: pollJob };
    },
  });
  await dialog.open({ cli: "codex" });
  await methodClick(els, "api");
  assert.equal(els.cliLoginFields.hidden, false);
  assert.equal(els.cliLoginUrlField.hidden, true);
  assert.equal(els.cliLoginStart.textContent, "保存到集群");
  els.cliLoginKey.value = `  ${KEY} `;
  await els.cliLoginForm.dispatch("submit");
  assert.equal(keyAtPost, "", "发请求时输入框已清空");
  assert.deepEqual(posted, ["/api/cli/codex/login", { method: "api", serverId: "server-01", apiKey: KEY }]);
  assert.ok(!JSON.stringify(dialog._state).includes(KEY), "状态里没有 key");
  assert.equal(els.cliLoginProgress.hidden, false);
  assert.equal(els.cliLoginCancel.hidden, true, "API 任务不能中途取消");
  pollJob = { ...pollJob, state: "succeeded", message: "codex 已用官方 API key 登录", status: { detail: "API key" } };
  timers.runTimeouts();
  await flush();
  await flush();
  assert.match(els.cliLoginResult.innerHTML, /codex 已用官方 API key 登录/);
  assert.equal(els.cliLoginAgain.hidden, false);
  assert.equal(toasts.at(-1).type, "success");
  assert.equal(timers.timeouts.size, 0, "结束后停止轮询");
  await els.cliLoginAgain.dispatch("click");
  assert.equal(els.cliLoginForm.hidden, false);
});

test("空 key 不发请求；409 busy 把原因写在提示行；字段错误聚焦对应输入框", async () => {
  const posts = [];
  const { dialog, els } = setup({
    postJson: async (_url, body) => {
      posts.push(body);
      const err = new Error("HTTP 409");
      err.status = 409;
      err.code = "busy";
      err.serverMessage = "服务器 server-01 上已有一个登录任务在进行";
      throw err;
    },
  });
  await dialog.open({ cli: "codex" });
  await methodClick(els, "relay");
  await els.cliLoginForm.dispatch("submit");
  assert.equal(posts.length, 0);
  assert.equal(els.cliLoginHint.textContent, "请填写 key");
  els.cliLoginKey.value = KEY;
  els.cliLoginBaseUrl.value = "https://r.example.com";
  await els.cliLoginForm.dispatch("submit");
  assert.equal(posts[0].baseUrl, "https://r.example.com");
  assert.equal(posts[0].acknowledgePlaintext, false);
  assert.equal(posts[0].providerId, "");
  assert.match(els.cliLoginHint.textContent, /已有一个登录任务/);
  assert.equal(els.cliLoginKey.value, "", "失败也不把 key 填回去");
});

test("中转站地址：停顿后预检，http 明文时出现确认勾选；过期响应丢弃", async () => {
  const checks = [];
  const { dialog, els, timers } = setup({
    postJson: async (_url, body) => {
      checks.push(body.baseUrl);
      return body.baseUrl.startsWith("http:")
        ? { ok: true, action: "allowlist", warnings: ["plaintext-http"], notes: ["非 443 端口：会加白名单", "http:// 是明文"] }
        : { ok: true, action: "none", warnings: [], notes: ["https 的 443 端口：经隧道直接可用"] };
    },
  });
  await dialog.open({ cli: "claude" });
  await methodClick(els, "relay");
  assert.equal(els.cliLoginProviderField.hidden, true, "Claude 中转站不需要名称");
  els.cliLoginBaseUrl.value = "http://r.example.com:8080";
  await els.cliLoginBaseUrl.dispatch("input");
  assert.equal(checks.length, 0, "停顿前不发");
  timers.runTimeouts();
  await flush();
  assert.deepEqual(checks, ["http://r.example.com:8080"]);
  assert.equal(els.cliLoginPlainField.hidden, false);
  assert.match(els.cliLoginRelayNotes.innerHTML, /is-warn">http:\/\/ 是明文/);
});

test("账号授权：显示授权链接与复制；Claude 授权码提交后清空输入框；取消调用后端", async () => {
  let job = { jobId: "j3", cli: "claude", method: "account", state: "running", phase: "connecting", phaseText: "连接集群", url: null, needsCode: false, warnings: [], notes: [] };
  const posts = [];
  const { dialog, els, timers } = setup({
    getJson: async (url) => (url.includes("current") ? { job: null } : { job }),
    postJson: async (url, body) => {
      posts.push([url, body]);
      if (url.endsWith("/code")) return { job: { ...job, phase: "verifying", phaseText: "已提交授权码", needsCode: false } };
      if (url.endsWith("/cancel")) return { job: { ...job, state: "cancelled", error: { message: "已取消" } } };
      return { jobId: "j3", job };
    },
  });
  await dialog.open({ cli: "claude" });
  await els.cliLoginForm.dispatch("submit");
  assert.equal(els.cliLoginLink.hidden, true);
  job = { ...job, phase: "waiting-code", phaseText: "粘贴授权码", url: "https://claude.ai/oauth/authorize?s=1", needsCode: true };
  timers.runTimeouts();
  await flush();
  assert.equal(els.cliLoginLink.hidden, false);
  assert.equal(els.cliLoginCodeForm.hidden, false);
  els.cliLoginCode.value = " CODE#1 ";
  await els.cliLoginCodeForm.dispatch("submit");
  assert.equal(els.cliLoginCode.value, "");
  assert.deepEqual(posts.at(-1), ["/api/cli/login/jobs/j3/code", { code: "CODE#1" }]);
  assert.equal(els.cliLoginPhase.textContent, "已提交授权码");
  await els.cliLoginCancel.dispatch("click");
  assert.equal(posts.at(-1)[0], "/api/cli/login/jobs/j3/cancel");
  assert.equal(els.cliLoginPhase.textContent, "已取消");
});

test("Agent 详情的 [data-cli-login] 整页委托打开；关闭对话框清空输入框、放慢接着盯，有了结果照样提示", async () => {
  const running = { jobId: "j4", cli: "codex", method: "account", state: "running", phaseText: "等浏览器", url: URL_CODEX, warnings: [], notes: [] };
  let reply = running;
  const { els, docListeners, timers, toasts, openDialog } = setup({ getJson: async () => ({ job: reply }) });
  const click = docListeners.find(([type]) => type === "click")[1];
  click({ target: fakeElement({ dataset: { cliLogin: "codex" } }) });
  await flush();
  assert.deepEqual(openDialog.calls, [["dlgCliLogin"]]);
  assert.equal(timers.timeouts.size, 1);
  els.cliLoginKey.value = "leftover";
  els.dlgCliLogin.close();
  assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [POLL_CLOSED_MS], "登录还在进行：不停表，换成慢速");
  assert.equal(els.cliLoginKey.value, "");
  click({ target: fakeElement({ dataset: {} }) });
  assert.equal(openDialog.calls.length, 1, "别处点击不打开");

  // 对话框关着时在浏览器里授权完成：照样提示、通知 Agent 卡片，然后停表。
  const before = toasts.length;
  reply = { ...running, state: "succeeded", message: "Codex 已登录" };
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts.slice(before).map((t) => [t.type, t.message]), [["success", "Codex 已登录"]]);
  assert.equal(timers.timeouts.size, 0);
});

test("对话框关着时登录超时 / 失败：另外提示一声；开着时结果写在对话框里，不重复弹", async () => {
  const running = { jobId: "j5", cli: "codex", method: "account", state: "running", phaseText: "等浏览器", url: URL_CODEX, warnings: [], notes: [] };
  let reply = running;
  const { els, docListeners, timers, toasts } = setup({ getJson: async () => ({ job: reply }) });
  docListeners.find(([type]) => type === "click")[1]({ target: fakeElement({ dataset: { cliLogin: "codex" } }) });
  await flush();
  els.dlgCliLogin.close();
  reply = { ...running, state: "timeout", message: "10 分钟内没有完成授权" };
  timers.runTimeouts();
  await flush();
  assert.deepEqual(toasts.map((t) => [t.type, t.title, t.message]), [["warn", "登录没有完成", "10 分钟内没有完成授权"]]);

  const open = setup({ getJson: async () => ({ job: reply }) });
  reply = { ...running, jobId: "j6" };
  open.docListeners.find(([type]) => type === "click")[1]({ target: fakeElement({ dataset: { cliLogin: "codex" } }) });
  await flush();
  reply = { ...running, jobId: "j6", state: "failed", message: "授权码不对" };
  open.timers.runTimeouts();
  await flush();
  assert.deepEqual(open.toasts, [], "对话框开着：只在对话框里显示");
});
