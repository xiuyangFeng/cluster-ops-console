import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingGuideUi, GUIDE_POLL_MS } from "./onboarding-guide.js";
import { deferred, fakeDialog, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const STEP_IDS = ["hostkey", "key", "authorize", "identity", "port", "tunnel", "egress", "clusterEnv"];
const guideState = (patch = {}) => ({
  available: true, phase: "idle", busy: false, dismissed: false, platform: "darwin",
  server: { id: "server-01", name: "主集群", alias: "myserver" },
  form: { sshUser: "", hostName: "10.0.0.8", hostNameLocked: true, sshPort: 22 },
  steps: STEP_IDS.map((id) => ({ id, title: id, status: "pending", detail: "", error: null })),
  prompt: null, result: { sshUser: "", remotePort: null, registered: null, warnings: [] },
  ...patch,
});

function setup({ get = async () => guideState(), post = async () => guideState() } = {}) {
  const timers = fakeTimers();
  const main = fakeElement();
  const els = {
    dlgOnboarding: fakeDialog(),
    onboardingMain: main,
    onboardingSub: fakeElement(),
    onboardingNext: fakeElement({ hidden: true }),
    onboardingFooter: fakeElement({ hidden: true }),
    onboardingLater: fakeElement({ tag: "button" }),
    onboardingFinish: fakeElement({ tag: "button" }),
    onboardingRoute: fakeElement(), onboardingLogin: fakeElement(), onboardingCheck: fakeElement(),
  };
  const doc = fakeDocument(els);
  const docListeners = [];
  doc.addEventListener = (type, fn) => docListeners.push([type, fn]);
  const getJson = spy(get);
  const postJson = spy(post);
  const showToast = spy();
  const refresh = spy(async () => {});
  const cliSection = { load: spy() };
  const copyText = spy(async () => true);
  const ui = createOnboardingGuideUi({ doc, getJson, postJson, showToast, copyText, refresh, cliSection, setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
  ui.init();
  // 主区域里某个带 data-* 的按钮被点
  const click = (dataset) => main.dispatch("click", { target: fakeElement({ tag: "button", dataset, parent: main }) });
  const submit = (kind, values) => {
    const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
    const form = fakeElement({ tag: "form", dataset: { obForm: kind }, parent: main, elements });
    return main.dispatch("submit", { target: form }).then((event) => ({ event, elements }));
  };
  return { ui, els, doc, docListeners, timers, getJson, postJson, showToast, refresh, cliSection, copyText, click, submit };
}

test("接入后检查网络与工具，复制集群启动命令；其他服务器的状态不能混入", async () => {
  const guide = guideState({ phase: "done", result: { remotePort: 8123 } });
  const h = setup({ get: async p => p === "/api/status" ? { activeServerId: "server-01" } : guide,
    post: async p => p === "/api/egress/self-test" ? { full: { serverId: "server-01", ok: true, message: "full chain" }, results: [] } : {} });
  await h.ui.open();
  assert.equal(h.cliSection.load.calls.length, 1, "打开完成页只加载一次");
  h.ui.onCliOverview({ serverId: "other", clis: { codex: { installed: true } } });
  assert.doesNotMatch(h.els.onboardingLogin.innerHTML, /data-cli-login/);
  h.ui.onCliOverview({ serverId: "server-01", clis: { codex: { installed: true } } });
  assert.match(h.els.onboardingLogin.innerHTML, /data-cli-method="relay"/);
  await h.click({ obCheck: "" });
  assert.deepEqual(h.postJson.calls.map(c => c[0]).sort(), ["/api/egress/self-test", "/api/probe/cli%3Aserver-01/run"]);
  assert.match(h.els.onboardingCheck.innerHTML, /full chain/);
  await h.click({ obCopyStart: "claude" });
  assert.deepEqual(h.copyText.calls.at(-1), [". ~/.config/cluster-workbench/env.sh\nclaude"]);
});

test("检查期间切服、重启引导时拒绝过期检查结果", async () => {
  const guide = guideState({ phase: "done" });
  let current = "other";
  const waiting = deferred();
  const h = setup({ get: async p => p === "/api/status" ? { activeServerId: current } : guide,
    post: p => p === "/api/egress/self-test" ? waiting.promise : Promise.resolve(guideState()) });
  await h.ui.open(); await h.click({ obCheck: "" });
  assert.equal(h.postJson.calls.length, 0);
  assert.match(h.els.onboardingCheck.innerHTML, /当前查看的服务器已改变/);
  current = "server-01";
  const checking = h.click({ obCheck: "" }); await flush();
  await h.click({ obRestart: "" });
  waiting.resolve({ full: { ok: true, message: "old result" } }); await checking;
  assert.doesNotMatch(h.els.onboardingCheck.innerHTML, /old result/);
});

test("自动弹出：首包状态说没配置好时弹一次；关掉后同一次页面加载不再弹", async () => {
  const h = setup();
  h.ui.onStatus({ onboarding: "ready", onboardingGuide: { phase: "idle", dismissed: false } });
  assert.equal(h.els.dlgOnboarding.open, false);
  h.ui.onStatus({ onboarding: "needs-setup", onboardingGuide: { phase: "idle", dismissed: false } });
  await flush();
  assert.equal(h.els.dlgOnboarding.open, true);
  assert.deepEqual(h.getJson.calls, [["/api/onboarding"]]);
  assert.match(h.els.onboardingMain.innerHTML, /data-ob-form="start"/);
  assert.equal(h.els.onboardingSub.textContent, "主集群 · 10.0.0.8");

  h.els.dlgOnboarding.close();
  h.ui.onStatus({ onboarding: "needs-setup", onboardingGuide: { phase: "idle", dismissed: false } });
  await flush();
  assert.equal(h.els.dlgOnboarding.showCount, 1);
});

test("开始接入：提交用户名和密码，密码框立即清空；执行期间每秒取一次状态，停下来就不再取", async () => {
  const running = guideState({ phase: "running", busy: true, form: { sshUser: "amy", hostName: "10.0.0.8", hostNameLocked: true } });
  const asking = guideState({ phase: "waiting", busy: false, prompt: { step: "hostkey", kind: "hostkey", host: "10.0.0.8", linesHash: "abc", fingerprints: [] }, steps: guideState().steps.map((s) => (s.id === "hostkey" ? { ...s, status: "waiting" } : s)) });
  const gets = [guideState(), running, asking];
  const h = setup({ get: async () => gets.shift(), post: async () => running });
  await h.ui.open();

  const { event, elements } = await h.submit("start", { sshUser: " amy ", password: "s3cret" });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.postJson.calls[0], ["/api/onboarding/start", { sshUser: "amy", password: "s3cret" }]);
  assert.equal(elements.password.value, "", "密码不留在页面上");
  assert.equal(h.ui.getState().polling, true);
  assert.equal([...h.timers.timeouts.values()][0].ms, GUIDE_POLL_MS);

  h.timers.runTimeouts();
  await flush();
  assert.equal(h.ui.getState().polling, true, "还在跑，继续取");
  h.timers.runTimeouts();
  await flush();
  assert.equal(h.ui.getState().polling, false, "等回答时不轮询（输入中途不会被重画）");
  assert.match(h.els.onboardingMain.innerHTML, /data-ob-answer="hostkey-accept"/);
  assert.ok(h.refresh.calls.length >= 1, "一轮告一段落后让背后的工作台跟上");
});

test("表单校验没过：错误留在表单上、保留填过的用户名，不弹提示；其它失败弹提示并重新对状态", async () => {
  const h = setup({ post: async () => { throw Object.assign(new Error("HTTP 400"), { status: 400, field: "sshUser", serverMessage: "请填写集群用户名" }); } });
  await h.ui.open();
  await h.submit("start", { sshUser: "a b", password: "" });
  assert.match(h.els.onboardingMain.innerHTML, /role="alert">请填写集群用户名</);
  assert.match(h.els.onboardingMain.innerHTML, /name="sshUser" value="a b"/);
  assert.equal(h.showToast.calls.length, 0);
  assert.deepEqual(h.postJson.calls[0][1], { sshUser: "a b" }, "没填密码就不带 password 字段");

  const busy = setup({ post: async () => { throw Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "引导正在执行上一步，请稍候" }); } });
  await busy.ui.open();
  await busy.click({ obRetry: "" });
  await flush();
  assert.equal(busy.showToast.calls[0][0].message, "引导正在执行上一步，请稍候");
  assert.equal(busy.getJson.calls.length, 2, "失败后重新取一次状态");
});

test("回答与重试：各按钮发对应的请求；密码提问提交后清空输入框", async () => {
  const asking = guideState({ phase: "waiting", prompt: { step: "hostkey", kind: "hostkey", linesHash: "abc", fingerprints: [] } });
  const h = setup({ get: async () => asking, post: async () => asking });
  await h.ui.open();
  await h.click({ obAnswer: "hostkey-accept" });
  await h.click({ obAnswer: "strays-comment" });
  await h.click({ obRetry: "" });
  await h.click({ obRetryStep: "egress" });
  await h.click({ obRestart: "" });
  const { elements } = await h.submit("password", { password: "pw" });
  await h.submit("password", { password: "" });
  assert.deepEqual(h.postJson.calls, [
    ["/api/onboarding/answer", { kind: "hostkey", accept: true, linesHash: "abc" }],
    ["/api/onboarding/answer", { kind: "strays", action: "comment" }],
    ["/api/onboarding/retry", {}],
    ["/api/onboarding/retry", { step: "egress" }],
    ["/api/onboarding/reset", {}],
    ["/api/onboarding/answer", { kind: "password", password: "pw" }],
  ]);
  assert.equal(elements.password.value, "");
  // 按住的按钮点了不发请求
  const disabled = fakeElement({ tag: "button", dataset: { obRetry: "" }, parent: h.els.onboardingMain, disabled: true });
  await h.els.onboardingMain.dispatch("click", { target: disabled });
  assert.equal(h.postJson.calls.length, 6);
});

test("复制手动命令：提问里的那一行 / 失败说明里的手动内容", async () => {
  const state = guideState({
    phase: "waiting", prompt: { step: "authorize", kind: "password", manualCommand: "cat k.pub | ssh amy@h" },
    steps: guideState().steps.map((s) => (s.id === "clusterEnv" ? { ...s, status: "failed", error: { message: "x", manual: "mkdir -p ~/.config" } } : s)),
  });
  const h = setup({ get: async () => state });
  await h.ui.open();
  await h.click({ obCopy: "manual" });
  await h.click({ obCopy: "error-manual" });
  assert.deepEqual(h.copyText.calls, [["cat k.pub | ssh amy@h"], ["mkdir -p ~/.config"]]);
  assert.equal(h.showToast.calls.length, 2);
});

test("走完：显示装 CLI / 登录两段与「进入工作台」，加载命令行工具状态；隐藏「稍后再说」", async () => {
  const done = guideState({ phase: "done", result: { sshUser: "amy", remotePort: 7892, registered: true, warnings: [] } });
  const h = setup({ get: async () => done });
  await h.ui.open();
  assert.equal(h.els.onboardingNext.hidden, false);
  assert.equal(h.els.onboardingFooter.hidden, false);
  assert.equal(h.els.onboardingLater.hidden, true);
  assert.ok(h.cliSection.load.calls.length >= 1);
  await h.els.onboardingFinish.dispatch("click");
  assert.equal(h.els.dlgOnboarding.open, false);
  assert.equal(h.postJson.calls.length, 0, "走完之后关闭不算「稍后」");
});

test("「稍后再说」/ Esc：记一次 dismissed 并关闭；关闭即停表，在途的旧响应不再采用", async () => {
  const pending = deferred();
  const running = guideState({ phase: "running", busy: true });
  let first = true;
  const h = setup({ get: async () => { if (first) { first = false; return running; } return pending.promise; } });
  await h.ui.open();
  assert.equal(h.ui.getState().polling, true);
  h.timers.runTimeouts(); // 发出一次轮询，还没回来
  await h.els.onboardingLater.dispatch("click");
  assert.deepEqual(h.postJson.calls, [["/api/onboarding/dismiss", { dismissed: true }]]);
  assert.equal(h.els.dlgOnboarding.open, false);
  assert.equal(h.ui.getState().polling, false);
  pending.resolve(guideState({ phase: "done" }));
  await flush();
  assert.equal(h.ui.getState().guide.phase, "running", "关掉之后回来的响应被丢弃");
  assert.equal(h.ui.getState().polling, false);

  const esc = setup();
  await esc.ui.open();
  await esc.els.dlgOnboarding.dispatch("cancel");
  await esc.els.dlgOnboarding.dispatch("cancel");
  assert.equal(esc.postJson.calls.length, 1, "只记一次");
});

test("别处的入口：[data-onboarding-open] 整页委托；入口在别的浮层里时先关掉那个浮层", async () => {
  const h = setup();
  const [type, handler] = h.docListeners[0];
  assert.equal(type, "click");
  const settings = fakeDialog();
  settings.open = true;
  const opener = fakeElement({ tag: "button", dataset: { onboardingOpen: "" }, parent: settings });
  handler({ target: opener });
  await flush();
  assert.equal(settings.open, false);
  assert.equal(h.els.dlgOnboarding.open, true);
  handler({ target: fakeElement({ tag: "button" }) });
  assert.equal(h.getJson.calls.length, 1);
});

test("下一步高亮：对话框打上 data-ob-focus、提示与段标题跟着走；测试对话带服务器与放宽的超时，跳过后高亮「进入工作台」", async () => {
  const guide = guideState({ phase: "done" });
  const h = setup({ get: async () => guide, post: async (p) => (p === "/api/cli/claude/smoke-test" ? { ok: true, code: "ok", message: "收到回复", seconds: 5, tail: [] } : {}) });
  h.els.onboardingHint = fakeElement();
  for (const n of [2, 3, 4]) h.els[`onboardingStage${n}`] = fakeElement();
  await h.ui.open();
  h.ui.onCliOverview({ serverId: "server-01", clis: { codex: { installed: false }, claude: { installed: false } } });
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "install");
  assert.match(h.els.onboardingHint.textContent, /第 2 步/);
  assert.equal(h.els.onboardingStage2.classList.contains("is-active"), true);
  // 安装任务一开始（settings-cli 的 onJobChange）：高亮挪到「正在安装」，不用等概览重读。
  h.ui.onCliJob({ jobId: "j1", serverId: "server-01", status: "running", action: "install", label: "Claude Code" });
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "installing");
  h.ui.onCliJob({ jobId: "j1", serverId: "server-01", status: "succeeded", action: "install" });
  h.ui.onCliOverview({ serverId: "server-01", clis: { codex: { installed: false }, claude: { installed: true, login: "api" } } });
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "smoke smoke-claude");
  assert.equal(h.els.onboardingStage2.classList.contains("is-done"), true);
  assert.equal(h.els.onboardingStage4.classList.contains("is-active"), true);
  await h.click({ obSmoke: "claude" });
  await flush();
  assert.deepEqual(h.postJson.calls.at(-1), ["/api/cli/claude/smoke-test", { serverId: "server-01" }, { timeoutMs: 180000 }]);
  assert.match(h.els.onboardingCheck.innerHTML, /✓ 收到回复/);
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "finish");
  assert.equal(h.ui.getState().focus.stage, 5);
});

test("测试对话失败显示原因；点「跳过测试」也能进入完成", async () => {
  const guide = guideState({ phase: "done" });
  const h = setup({ get: async () => guide, post: async () => { throw Object.assign(new Error("x"), { serverMessage: "这台服务器上正在进行 codex 的安装 / 更新，请等它结束再试" }); } });
  await h.ui.open();
  h.ui.onCliOverview({ serverId: "server-01", clis: { codex: { installed: true, login: "apikey" } } });
  await h.click({ obSmoke: "codex" });
  await flush();
  assert.match(h.els.onboardingCheck.innerHTML, /正在进行 codex 的安装/);
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "smoke smoke-codex");
  await h.click({ obSmokeSkip: "" });
  assert.equal(h.els.dlgOnboarding.dataset.obFocus, "finish");
});
