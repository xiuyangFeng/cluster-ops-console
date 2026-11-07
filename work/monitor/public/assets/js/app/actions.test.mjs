import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REQUEST_TIMEOUT_MS } from "../api.js";
import { ACTION_BUTTON_IDS, AUTH_FAILURE_BANNER, createActions, describeApiError, describeProbeNow, reportApiError, startButtonView, STOP_CONFIRM_TEXT, withErrorToast } from "./actions.js";
import { deferred, fakeDocument, fakeElement, spy } from "./test-support.mjs";

const httpError = (props) => Object.assign(new Error(props.message || "HTTP"), props);

test("describeApiError: 401 在动作与刷新两条通路给同一份鉴权失败横幅，只有动作弹 toast", () => {
  const refresh = describeApiError(httpError({ status: 401 }), "refresh");
  const action = describeApiError(httpError({ status: 401 }), "action");
  assert.equal(refresh.text, "鉴权失败");
  assert.equal(refresh.banner, AUTH_FAILURE_BANNER);
  assert.equal(action.banner, AUTH_FAILURE_BANNER);
  assert.equal(refresh.toast, null);
  assert.deepEqual(action.toast, { type: "error", message: "监控接口鉴权失败，请重新启动控制台", title: "鉴权失败" });
  assert.match(AUTH_FAILURE_BANNER.body, /npm run start/);
});

test("describeApiError: 后端报错 / 超时 / 断网的文案按通路区分", () => {
  const serverErr = httpError({ status: 500, serverMessage: "boom" });
  assert.deepEqual(describeApiError(serverErr, "refresh"), {
    text: "系统故障", banner: { title: "监测核心系统故障", body: "后台报告错误: boom" }, toast: null,
  });
  assert.deepEqual(describeApiError(serverErr, "action"), {
    text: "执行失败", banner: { title: "操作执行失败", body: "后台报告错误: boom" }, toast: { type: "error", message: "boom", title: "操作失败" },
  });
  const timeout = describeApiError(httpError({ timeout: true }), "refresh");
  assert.equal(timeout.text, "响应超时");
  assert.match(timeout.banner.body, new RegExp(`${DEFAULT_REQUEST_TIMEOUT_MS / 1000} 秒`));
  // 动作超时不单列（与此前一致：按普通失败提示 message）
  assert.equal(describeApiError(httpError({ timeout: true, message: "slow" }), "action").toast.message, "slow");
  assert.deepEqual(describeApiError(new Error("net"), "refresh"), { text: "通信阻断", banner: null, toast: null });
  assert.equal(describeApiError(null, "action").toast.message, "请求异常");
});

test("reportApiError: 标记数据过期 → 总体状态 → 横幅 → toast", () => {
  const order = [];
  const ui = {
    setStale: (v) => order.push(["stale", v]),
    setOverall: (h, t) => order.push(["overall", h, t]),
    renderAlertBanner: (h, b) => order.push(["banner", h, b.title]),
    showToast: (t) => order.push(["toast", t.title]),
  };
  reportApiError(httpError({ status: 401 }), "action", ui);
  assert.deepEqual(order, [["stale", true], ["overall", "down", "鉴权失败"], ["banner", "down", AUTH_FAILURE_BANNER.title], ["toast", "鉴权失败"]]);
  order.length = 0;
  reportApiError(new Error("x"), "refresh", ui);
  assert.deepEqual(order, [["stale", true], ["overall", "down", "通信阻断"]]);
});

test("withErrorToast: 成功透传参数与返回值；失败先 toast 服务端原因再原样抛出", async () => {
  const toasts = [];
  const ok = withErrorToast((t) => toasts.push(t), "远端动作", async (a, b) => a + b);
  assert.equal(await ok(1, 2), 3);
  const err = httpError({ status: 409, serverMessage: "预览已过期" });
  const bad = withErrorToast((t) => toasts.push(t), "远端动作", async () => { throw err; });
  await assert.rejects(bad(), (e) => e === err);
  assert.deepEqual(toasts, [{ type: "error", message: "预览已过期", title: "远端动作" }]);
});

function setup(overrides = {}) {
  const elements = Object.fromEntries([...ACTION_BUTTON_IDS, "clearLogBtn", "storagePruneBtn"].map((id) => [id, fakeElement()]));
  const doc = fakeDocument(elements);
  const deps = {
    doc,
    postAction: spy(async (name) => ({ done: name })),
    postJson: spy(async () => ({})),
    render: spy(),
    refresh: spy(),
    logsPanel: { refresh: spy(), clear: spy() },
    showToast: spy(),
    confirm: spy(() => true),
    copyText: spy(async () => true),
    reportError: spy(),
    setOverall: spy(),
    requestRepair: spy(),
    openDialog: spy(),
    reassignPort: spy(),
    confirmHostKey: spy(async () => {}),
    getStatus: () => ({ setupCommand: "npm run setup -- --x" }),
    activeServerId: () => "srv-a",
    ...overrides,
  };
  return { deps, elements, actions: createActions(deps) };
}

test("action: 成功渲染结果、刷新日志，执行期间按钮全部禁用、结束后恢复", async () => {
  const pending = deferred();
  const { deps, elements, actions } = setup({ postAction: spy(() => pending.promise) });
  const run = actions.action("start", { operationId: "op-1" });
  assert.ok(ACTION_BUTTON_IDS.every((id) => elements[id].disabled), "执行中全部禁用");
  assert.deepEqual(deps.setOverall.calls[0], ["waiting", "执行中"]);
  assert.equal(await actions.action("restart"), false, "在飞时拒绝第二个动作");
  pending.resolve({ health: "ready" });
  assert.equal(await run, true);
  assert.deepEqual(deps.postAction.calls, [["start", { operationId: "op-1" }]]);
  assert.deepEqual(deps.render.calls, [[{ health: "ready" }]]);
  assert.equal(deps.logsPanel.refresh.calls.length, 1);
  assert.ok(ACTION_BUTTON_IDS.every((id) => !elements[id].disabled), "结束后恢复");
});

test("action: stop 先确认，取消无任何副作用；失败交给 reportError 并返回 false", async () => {
  const { deps, actions } = setup({ confirm: spy(() => false) });
  assert.equal(await actions.action("stop"), false);
  assert.deepEqual(deps.confirm.calls, [[STOP_CONFIRM_TEXT]]);
  assert.equal(deps.postAction.calls.length, 0);
  assert.equal(deps.showToast.calls.length, 0);

  const err = httpError({ status: 401 });
  const failing = setup({ postAction: spy(async () => { throw err; }) });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await failing.actions.action("start"), false);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(failing.deps.reportError.calls, [[err, "action"]]);
});

test("handleBannerAction: 按 data-banner-action 分派", async () => {
  const { deps, actions } = setup();
  actions.handleBannerAction("reassign-port");
  assert.deepEqual(deps.reassignPort.calls, [["srv-a"]]);
  await actions.handleBannerAction("hostkey");
  assert.deepEqual(deps.openDialog.calls, [["dlgSettings"]]);
  assert.deepEqual(deps.confirmHostKey.calls, [["srv-a"]]);
  actions.handleBannerAction("doctor");
  assert.deepEqual(deps.openDialog.calls.at(-1), ["dlgDoctor"]);
  actions.handleBannerAction("whatever");
  assert.equal(deps.requestRepair.calls.length, 1, "未知/repair → runbook 预览");
  assert.equal(actions.handleBannerAction("none"), undefined);

  const noServer = setup({ activeServerId: () => "" });
  assert.equal(noServer.actions.handleBannerAction("reassign-port"), undefined);
  assert.equal(noServer.deps.reassignPort.calls.length, 0);
});

test("handleBannerAction(setup-hint): 复制后端给的向导命令；剪贴板兜底时不报已复制", async () => {
  const { deps, actions } = setup();
  await actions.handleBannerAction("setup-hint");
  assert.equal(deps.copyText.calls[0][0], "npm run setup -- --x");
  assert.match(deps.showToast.calls[0][0].message, /已复制「npm run setup -- --x」/);

  const fallback = setup({ copyText: spy(async () => false) });
  await fallback.actions.handleBannerAction("setup-hint");
  assert.equal(fallback.deps.showToast.calls.length, 0);
});

test("bindControls: 横幅按钮按 dataset 分派；清理本地数据先确认", async () => {
  const { deps, elements, actions } = setup({ confirm: spy(() => false) });
  actions.bindControls();
  elements.alertActionBtn.dataset.bannerAction = "open-settings";
  await elements.alertActionBtn.dispatch("click");
  assert.deepEqual(deps.openDialog.calls, [["dlgSettings"]]);
  await elements.restartBtn.dispatch("click");
  assert.equal(deps.requestRepair.calls.length, 1, "restart 按钮走 runbook 预览");
  await elements.storagePruneBtn.dispatch("click");
  assert.equal(deps.postJson.calls.length, 0, "取消确认不发请求");

  const accepted = setup();
  accepted.actions.bindControls();
  await accepted.elements.storagePruneBtn.dispatch("click");
  assert.deepEqual(accepted.deps.postJson.calls, [["/api/storage/prune", {}]]);
  assert.equal(accepted.deps.refresh.calls.length, 1);
  assert.equal(accepted.elements.storagePruneBtn.disabled, false);
});

test("startButtonView: 所有连接都在运行时是「已在运行」，其余状态是启动按钮", () => {
  assert.deepEqual(startButtonView({ shouldBeRunning: true, health: "ready" }), {
    idle: true, label: "已在运行", title: "所有连接都在运行；需要重建时用「重启所有连接」",
  });
  for (const status of [
    { shouldBeRunning: false, health: "stopped" },
    { shouldBeRunning: true, health: "degraded" },
    { shouldBeRunning: true, health: "down" },
    { shouldBeRunning: true, health: "waiting" },
    {}, null,
  ]) {
    const view = startButtonView(status);
    assert.equal(view.idle, false, JSON.stringify(status));
    assert.equal(view.label, "启动所有连接");
  }
});

test("onStatus: 已在运行 → 启动按钮禁用且不再是主按钮；动作结束后不会被重新点亮", async () => {
  const pending = deferred();
  const { elements, actions } = setup({ postAction: spy(() => pending.promise) });
  const start = elements.startBtn;
  start.classList.add("btn-primary");

  actions.onStatus({ shouldBeRunning: true, health: "ready" });
  assert.deepEqual([start.disabled, start.textContent, start.classList.contains("btn-primary"), start.classList.contains("btn-secondary")], [true, "已在运行", false, true]);
  assert.match(start.title, /重启所有连接/);
  assert.equal(elements.stopBtn.disabled, false, "其余按钮不受影响");

  // 执行别的动作：期间全部禁用，结束后启动按钮仍保持「已在运行」的禁用态
  const run = actions.action("stop");
  assert.ok(ACTION_BUTTON_IDS.every((id) => elements[id].disabled));
  pending.resolve({ health: "ready" });
  await run;
  assert.equal(start.disabled, true);
  assert.equal(elements.stopBtn.disabled, false);

  // 停止后：恢复成主按钮
  actions.onStatus({ shouldBeRunning: false, health: "stopped" });
  assert.deepEqual([start.disabled, start.textContent, start.classList.contains("btn-primary"), start.classList.contains("btn-secondary")], [false, "启动所有连接", true, false]);
});

test("onStatus: 动作在飞时来的状态不提前点亮启动按钮", async () => {
  const pending = deferred();
  const { elements, actions } = setup({ postAction: spy(() => pending.promise) });
  const run = actions.action("start");
  actions.onStatus({ shouldBeRunning: true, health: "down" });
  assert.equal(elements.startBtn.disabled, true, "在飞期间保持禁用");
  pending.resolve({});
  await run;
  assert.equal(elements.startBtn.disabled, false, "结束后按最近一次状态恢复");
});

// ---- 横幅「立即探测」（探针退避）----
const NEXT_PROBE_AT = new Date(2026, 9, 12, 14, 3, 20).getTime();
const backedOffStatus = { activeServerId: "srv-a", probeBackoff: { enabled: true, servers: { "srv-a": { nextProbeAt: NEXT_PROBE_AT } } } };

test("describeProbeNow: 恢复 / 仍连不上（带下次探测时刻）/ 这次没有发出探测", () => {
  assert.deepEqual(describeProbeNow({ ran: true, backoff: null }), { type: "success", message: "服务器已经能连上，探测回到正常节奏。" });
  assert.deepEqual(describeProbeNow({ ran: true, backoff: { nextProbeAt: NEXT_PROBE_AT } }), { type: "warn", message: "还是连不上。工作台会继续自动重试，下次 14:03:20。" });
  assert.equal(describeProbeNow({ ran: false, backoff: { nextProbeAt: NEXT_PROBE_AT } }).type, "info");
});

test("probeNow: 探 fast 采集 → 刷新状态 → 按刷新后的退避状态提示；探测期间按钮禁用、重复点击不重复发", async () => {
  const pending = deferred();
  let status = backedOffStatus;
  const probeBtn = fakeElement();
  const { deps, elements, actions } = setup({ postJson: spy(() => pending.promise), getStatus: () => status });
  elements.alertProbeBtn = probeBtn;
  const run = actions.probeNow("srv-a");
  assert.equal(probeBtn.disabled, true, "探测中禁用");
  await actions.probeNow("srv-a");
  assert.equal(deps.postJson.calls.length, 1, "在飞时不重复发");
  status = { activeServerId: "srv-a", probeBackoff: { enabled: true, servers: {} } };
  pending.resolve({ ok: true, result: { level: "ok", data: { remotePortOpen: true } } });
  await run;
  assert.deepEqual(deps.postJson.calls, [["/api/probe/log-signals/run", {}]]);
  assert.deepEqual(deps.refresh.calls, [[{ force: true }]]);
  assert.deepEqual(deps.showToast.calls, [[{ type: "success", message: "服务器已经能连上，探测回到正常节奏。", title: "立即探测" }]]);
  assert.equal(probeBtn.disabled, false, "结束后恢复");
});

test("probeNow: 仍连不上给出下次探测时刻；fast 采集被跳过（只监控的服务器）时改探 slow 采集；两条都跳过说明没有可发的探测", async () => {
  const still = setup({ postJson: spy(async () => ({ ok: true, result: { level: "error", data: null } })), getStatus: () => backedOffStatus });
  await still.actions.probeNow("srv-a");
  assert.deepEqual(still.deps.showToast.calls, [[{ type: "warn", message: "还是连不上。工作台会继续自动重试，下次 14:03:20。", title: "立即探测" }]]);

  const replies = [{ ok: true, result: { level: "skipped" } }, { ok: true, result: { level: "error", data: null } }];
  const fallback = setup({ postJson: spy(async () => replies.shift()), getStatus: () => backedOffStatus });
  await fallback.actions.probeNow("srv a");
  assert.deepEqual(fallback.deps.postJson.calls.map((call) => call[0]), ["/api/probe/log-signals/run", "/api/probe/collect%3Aslow%3Asrv%20a/run"]);
  assert.equal(fallback.deps.showToast.calls[0][0].type, "warn");

  const idle = setup({ postJson: spy(async () => ({ ok: true, result: { level: "skipped" } })), getStatus: () => backedOffStatus });
  await idle.actions.probeNow("srv-a");
  assert.equal(idle.deps.postJson.calls.length, 2);
  assert.equal(idle.deps.showToast.calls[0][0].type, "info");
});

test("probeNow: 请求失败给出原因、不刷新状态，按钮恢复可点；bindControls 把按钮接到它上面", async () => {
  const probeBtn = fakeElement();
  const failing = setup({ postJson: spy(async () => { throw httpError({ status: 500, serverMessage: "boom" }); }), getStatus: () => backedOffStatus });
  failing.elements.alertProbeBtn = probeBtn;
  await failing.actions.probeNow("srv-a");
  assert.deepEqual(failing.deps.showToast.calls, [[{ type: "error", message: "探测没有发出去：boom", title: "立即探测" }]]);
  assert.equal(failing.deps.refresh.calls.length, 0);
  assert.equal(probeBtn.disabled, false);

  const bound = setup({ postJson: spy(async () => ({ ok: true, result: { level: "ok", data: {} } })), getStatus: () => ({ activeServerId: "srv-a" }) });
  const btn = fakeElement();
  bound.elements.alertProbeBtn = btn;
  bound.actions.bindControls();
  btn.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bound.deps.postJson.calls, [["/api/probe/log-signals/run", {}]]);
});
