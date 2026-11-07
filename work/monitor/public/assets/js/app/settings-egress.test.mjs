import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAllowlistHtml,
  buildEgressFactsHtml,
  buildSelfTestHtml,
  createSettingsEgress,
  describeEffective,
  describeSystemProxy,
} from "./settings-egress.js";
import { deferred, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const STATUS = {
  egress: { mode: "direct", url: null },
  configIssue: null,
  effective: { running: true, supportsEgress: true, mode: "direct", upstream: null },
  systemProxy: { source: "scutil", proxy: { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897" }, socks: null, pac: null },
  allowlist: { personal: ["api.relay-demo.example:9443"], team: ["team.example.com:8443"], max: 32 },
  proxyPort: 8888,
  revision: 0,
};

test("describeSystemProxy / describeEffective：一句话说清系统代理与代理此刻实际怎么出网", () => {
  assert.equal(describeSystemProxy(STATUS.systemProxy), "127.0.0.1:7897");
  assert.equal(describeSystemProxy({ socks: { host: "127.0.0.1", port: 7891 } }), "只有 SOCKS 代理 127.0.0.1:7891（暂不支持）");
  assert.equal(describeSystemProxy({ pac: "http://x/pac" }), "PAC 自动配置（暂不支持）");
  assert.equal(describeSystemProxy({ error: "ENOENT" }), "读取失败");
  assert.equal(describeSystemProxy({}), "未检测到");

  assert.equal(describeEffective(STATUS), "直连");
  assert.equal(describeEffective({ ...STATUS, egress: { mode: "system" }, effective: { running: true, supportsEgress: true, mode: "system", upstream: "127.0.0.1:7897" } }), "经 127.0.0.1:7897");
  assert.equal(describeEffective({ ...STATUS, egress: { mode: "system" }, effective: { running: true, supportsEgress: true, mode: "system", upstream: null } }), "系统代理不可用，暂按直连");
  assert.equal(describeEffective({ ...STATUS, egress: { mode: "system" } }), "直连（新设置几秒内生效）");
  assert.equal(describeEffective({ ...STATUS, effective: { running: false } }), "本机代理没有运行");
  assert.equal(describeEffective({ ...STATUS, effective: { running: true, supportsEgress: false } }), "本机代理是旧版本，更新后才支持出网设置");
});

test("buildEgressFactsHtml / buildAllowlistHtml：个人条目可删、团队条目只读、空列表提示、文案转义", () => {
  const facts = buildEgressFactsHtml({ ...STATUS, configIssue: "egress.mode \"tun\" 不是 direct / system / manual" });
  assert.match(facts, /<dt>系统代理<\/dt><dd>127\.0\.0\.1:7897<\/dd>/);
  assert.match(facts, /<dt>当前生效<\/dt><dd>直连<\/dd>/);
  assert.match(facts, /<dt>配置问题<\/dt><dd>egress\.mode &quot;tun&quot;/);

  const list = buildAllowlistHtml(STATUS.allowlist);
  assert.match(list, /<code>api\.relay-demo\.example:9443<\/code><button type="button" class="text-btn" data-egress-remove="api\.relay-demo\.example:9443"/);
  assert.match(list, /<code>team\.example\.com:8443<\/code><span class="eg-note">团队配置<\/span>/);
  assert.equal((list.match(/data-egress-remove/g) || []).length, 1, "团队条目不给删除");
  assert.match(buildAllowlistHtml({ personal: [], team: [] }), /还没有条目/);
  assert.doesNotMatch(buildAllowlistHtml({ personal: ["<b>:1"] }), /<b>/);
});

test("buildSelfTestHtml：逐项通 / 不通、建议（改用系统代理带按钮）、全链路一行", () => {
  const html = buildSelfTestHtml({
    results: [{ target: "api.openai.com", ok: true, ms: 230 }, { target: "chatgpt.com", ok: false, message: "本机代理连不上目标（HTTP 502）" }],
    suggestion: { kind: "use-system", action: "use-system", text: "直连不通，但系统代理 127.0.0.1:7897 能连上——建议把出网方式改为「系统代理」。" },
    full: { ok: true, message: "全链路通（HTTP 401，812ms）" },
  });
  assert.match(html, /eg-result is-ok"><span class="eg-target">api\.openai\.com<\/span><span class="eg-outcome">通 · 230 ms/);
  assert.match(html, /eg-result is-fail"><span class="eg-target">chatgpt\.com<\/span><span class="eg-outcome">本机代理连不上目标/);
  assert.match(html, /data-egress-mode="system">改用系统代理<\/button>/);
  assert.match(html, /eg-full is-ok"><span class="eg-target">集群全链路<\/span><span class="eg-outcome">全链路通/);
  assert.doesNotMatch(buildSelfTestHtml({ results: [], suggestion: { kind: "partial", text: "部分不通" } }), /data-egress-mode/, "其余建议不带按钮");
  assert.equal(buildSelfTestHtml(null), "");
});

// 假 DOM：index.html 里 #settingsEgress 的骨架。
function setup({ getJson, postJson, status = STATUS } = {}) {
  const timers = fakeTimers();
  const modeButtons = ["direct", "system", "manual"].map((mode) => fakeElement({ tag: "button", dataset: { egressMode: mode } }));
  const elements = {
    egressModes: fakeElement({ querySelectorAll: (sel) => (sel === "[data-egress-mode]" ? modeButtons : []) }),
    egressModeHint: fakeElement(),
    egressManualForm: fakeElement({ tag: "form", hidden: true }),
    egressManualUrl: fakeElement({ tag: "input" }),
    egressFacts: fakeElement(),
    egressTestBtn: fakeElement({ tag: "button" }),
    egressFullTestBtn: fakeElement({ tag: "button" }),
    egressTestResult: fakeElement(),
    egressAllowList: fakeElement({ tag: "ul" }),
    egressAllowForm: fakeElement({ tag: "form" }),
    egressAllowInput: fakeElement({ tag: "input" }),
  };
  for (const btn of modeButtons) btn.parent = elements.egressModes;
  const deps = {
    doc: fakeDocument(elements),
    getJson: getJson || spy(async () => structuredClone(status)),
    postJson: postJson || spy(async (_path, body) => ({ ...structuredClone(status), egress: { mode: body.mode || status.egress.mode, url: body.url || status.egress.url } })),
    showToast: spy(),
    onSaved: spy(),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  };
  const egress = createSettingsEgress(deps);
  const pressed = () => modeButtons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.egressMode);
  return { egress, elements, deps, modeButtons, pressed, timers };
}

test("打开配置：读 /api/egress，按下当前方式、说明随方式、手动地址框只在「手动」时出现，事实行与白名单渲染", async () => {
  const ctx = setup();
  ctx.egress.onOpen();
  await flush();
  assert.deepEqual(ctx.deps.getJson.calls, [["/api/egress"]]);
  assert.deepEqual(ctx.pressed(), ["direct"]);
  assert.match(ctx.elements.egressModeHint.textContent, /本机能直接上网/);
  assert.equal(ctx.elements.egressManualForm.hidden, true);
  assert.match(ctx.elements.egressFacts.innerHTML, /当前生效<\/dt><dd>直连/);
  assert.match(ctx.elements.egressAllowList.innerHTML, /api\.relay-demo\.example:9443/);

  const manual = setup({ status: { ...STATUS, egress: { mode: "manual", url: "http://127.0.0.1:7890" } } });
  manual.egress.onOpen();
  await flush();
  assert.equal(manual.elements.egressManualForm.hidden, false);
  assert.equal(manual.elements.egressManualUrl.value, "http://127.0.0.1:7890");

  const failing = setup({ getJson: spy(async () => { throw Object.assign(new Error("HTTP 503"), { serverMessage: "egress settings unavailable" }); }) });
  failing.egress.onOpen();
  await flush();
  assert.match(failing.elements.egressFacts.innerHTML, /读取失败：egress settings unavailable/);
});

test("切换方式：点「系统代理」即保存（在飞时按钮禁用），成功提示并回调 onSaved；失败提示且不回调", async () => {
  const pending = deferred();
  const ctx = setup({ postJson: spy(() => pending.promise) });
  ctx.egress.onOpen();
  await flush();
  const click = ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[1] });
  await flush();
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/egress", { mode: "system" }]]);
  assert.ok(ctx.modeButtons.every((b) => b.disabled), "在飞时禁用，避免连点交错");
  pending.resolve({ ...STATUS, egress: { mode: "system", url: null } });
  await click;
  assert.deepEqual(ctx.pressed(), ["system"]);
  assert.ok(ctx.modeButtons.every((b) => !b.disabled));
  assert.match(ctx.deps.showToast.calls[0][0].message, /已改为「系统代理」/);
  assert.equal(ctx.deps.onSaved.calls.length, 1);

  await ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[1] });
  assert.equal(ctx.deps.postJson.calls.length, 1, "已是当前方式：不重复保存");

  const failing = setup({ postJson: spy(async () => { throw Object.assign(new Error("HTTP 400"), { serverMessage: "出网设置未通过校验" }); }) });
  failing.egress.onOpen();
  await flush();
  await failing.elements.egressModes.dispatch("click", { target: failing.modeButtons[1] });
  assert.equal(failing.deps.showToast.calls[0][0].type, "error");
  assert.match(failing.deps.showToast.calls[0][0].message, /保存失败：出网设置未通过校验/);
  assert.deepEqual(failing.pressed(), ["direct"], "失败后仍按原状态显示");
  assert.equal(failing.deps.onSaved.calls.length, 0);
});

test("「手动」：没填过地址先展开输入框不保存；提交地址才保存；输入中的地址不被刷新覆盖", async () => {
  const ctx = setup();
  ctx.egress.onOpen();
  await flush();
  await ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[2] });
  assert.equal(ctx.deps.postJson.calls.length, 0);
  assert.equal(ctx.elements.egressManualForm.hidden, false);
  assert.equal(ctx.elements.egressManualUrl.focused, true);

  ctx.elements.egressManualUrl.value = "http://127.0.0.1:7890";
  await ctx.elements.egressManualUrl.dispatch("input");
  ctx.egress.load();
  await flush();
  assert.equal(ctx.elements.egressManualUrl.value, "http://127.0.0.1:7890", "未提交的编辑不被重读覆盖");

  const submit = await ctx.elements.egressManualForm.dispatch("submit");
  assert.equal(submit.defaultPrevented, true);
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/egress", { mode: "manual", url: "http://127.0.0.1:7890" }]]);
  assert.deepEqual(ctx.pressed(), ["manual"]);
});

test("白名单：提交添加（成功清空输入框、失败保留）；点删除只删那一条", async () => {
  let fail = false;
  const ctx = setup({
    postJson: spy(async () => {
      if (fail) throw Object.assign(new Error("HTTP 400"), { serverMessage: "443 端口默认放行，不需要加白名单" });
      return STATUS;
    }),
  });
  ctx.egress.onOpen();
  await flush();
  ctx.elements.egressAllowInput.value = " https://relay.example.com:9443/v1 ";
  await ctx.elements.egressAllowForm.dispatch("submit");
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/egress/allowlist", { add: "https://relay.example.com:9443/v1" }]);
  assert.equal(ctx.elements.egressAllowInput.value, "");

  fail = true;
  ctx.elements.egressAllowInput.value = "relay.example.com:443";
  await ctx.elements.egressAllowForm.dispatch("submit");
  assert.equal(ctx.elements.egressAllowInput.value, "relay.example.com:443", "失败时保留输入，方便改");
  assert.match(ctx.deps.showToast.calls.at(-1)[0].message, /443 端口默认放行/);

  fail = false;
  const removeBtn = fakeElement({ tag: "button", dataset: { egressRemove: "api.relay-demo.example:9443" } });
  await ctx.elements.egressAllowList.dispatch("click", { target: removeBtn });
  assert.deepEqual(ctx.deps.postJson.calls.at(-1), ["/api/egress/allowlist", { remove: "api.relay-demo.example:9443" }]);
});

test("连通测试：测试中禁用两个按钮并显示进行中；结果渲染后建议里的「改用系统代理」可直接切换", async () => {
  const pending = deferred();
  const ctx = setup({
    postJson: spy((path, body) => {
      if (path === "/api/egress/self-test") return pending.promise;
      return Promise.resolve({ ...STATUS, egress: { mode: body.mode, url: null } });
    }),
  });
  ctx.egress.onOpen();
  await flush();
  const run = ctx.elements.egressTestBtn.dispatch("click");
  await flush();
  assert.equal(ctx.elements.egressTestBtn.disabled, true);
  assert.equal(ctx.elements.egressFullTestBtn.disabled, true);
  assert.match(ctx.elements.egressTestResult.innerHTML, /正在测试本机出网/);
  await ctx.egress.runTest("full");
  assert.equal(ctx.deps.postJson.calls.filter(([p]) => p === "/api/egress/self-test").length, 1, "进行中不重复发起");

  pending.resolve({
    results: [{ target: "api.openai.com", ok: false, message: "本机代理连不上目标（HTTP 502）" }],
    suggestion: { kind: "use-system", action: "use-system", text: "直连不通，但系统代理能连上" },
    effective: { running: true, supportsEgress: true, mode: "direct", upstream: null },
  });
  await run;
  assert.deepEqual(ctx.deps.postJson.calls[0], ["/api/egress/self-test", { scope: "local" }]);
  assert.equal(ctx.elements.egressTestBtn.disabled, false);
  assert.match(ctx.elements.egressTestResult.innerHTML, /改用系统代理/);

  const suggestionBtn = fakeElement({ tag: "button", dataset: { egressMode: "system" } });
  await ctx.elements.egressTestResult.dispatch("click", { target: suggestionBtn });
  assert.deepEqual(ctx.deps.postJson.calls.at(-1), ["/api/egress", { mode: "system" }]);
  assert.deepEqual(ctx.pressed(), ["system"]);
});

// ---- 过期响应（v2.57 第二轮）：按请求序号 / 配置 revision 丢弃，保存后刷新最终生效状态 ----
const SYSTEM_ON = { running: true, supportsEgress: true, mode: "system", upstream: "127.0.0.1:7897" };
const savedSystem = (effective = SYSTEM_ON) => ({ ...structuredClone(STATUS), egress: { mode: "system", url: null }, effective, revision: 1 });

test("出网：旧 GET 晚于保存成功返回，不回写旧模式（带 revision / 不带 revision 两种回包都丢弃）", async () => {
  for (const withRevision of [true, false]) {
    const lateGet = deferred();
    const strip = (body) => {
      if (!withRevision) delete body.revision;
      return body;
    };
    let gets = 0;
    const ctx = setup({
      getJson: spy(() => (++gets === 1 ? Promise.resolve(strip(structuredClone(STATUS))) : lateGet.promise)),
      postJson: spy(async () => strip(savedSystem())),
    });
    ctx.egress.onOpen();
    await flush();
    ctx.egress.onOpen(); // 重新打开：第二次读取在飞
    await flush();
    await ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[1] });
    assert.deepEqual(ctx.pressed(), ["system"]);
    lateGet.resolve(strip(structuredClone(STATUS))); // 保存前就发出的读取：仍是直连
    await flush();
    assert.deepEqual(ctx.pressed(), ["system"], `旧读取不得把方式改回直连（revision ${withRevision ? "有" : "无"}）`);
    assert.match(ctx.elements.egressFacts.innerHTML, /当前生效<\/dt><dd>经 127\.0\.0\.1:7897/);
  }
});

test("出网：旧 GET 读取失败晚于新数据返回，不把事实行换成读取失败", async () => {
  const lateGet = deferred();
  let gets = 0;
  const ctx = setup({ getJson: spy(() => (++gets === 1 ? lateGet.promise : Promise.resolve(structuredClone(STATUS)))) });
  ctx.egress.onOpen();
  ctx.egress.onOpen();
  await flush();
  lateGet.reject(new Error("HTTP 500"));
  await flush();
  assert.doesNotMatch(ctx.elements.egressFacts.innerHTML, /读取失败/);
});

test("出网：自测在飞期间改了方式，旧自测结果不回写旧 effective", async () => {
  const selfTest = deferred();
  const ctx = setup({
    postJson: spy((path) => (path === "/api/egress/self-test" ? selfTest.promise : Promise.resolve(savedSystem()))),
  });
  ctx.egress.onOpen();
  await flush();
  const run = ctx.egress.runTest("local");
  await ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[1] });
  assert.match(ctx.elements.egressFacts.innerHTML, /经 127\.0\.0\.1:7897/);
  selfTest.resolve({ results: [{ target: "api.openai.com", ok: true, ms: 80 }], effective: { running: true, supportsEgress: true, mode: "direct", upstream: null } });
  await run;
  assert.match(ctx.elements.egressTestResult.innerHTML, /api\.openai\.com/, "测得的结果照常显示");
  assert.match(ctx.elements.egressFacts.innerHTML, /当前生效<\/dt><dd>经 127\.0\.0\.1:7897/, "旧自测的 effective 不得盖掉保存后的状态");

  // 没有改动时，自测带回的 effective 照常更新事实行
  const quiet = setup({ postJson: spy(async () => ({ results: [], effective: { running: false } })) });
  quiet.egress.onOpen();
  await flush();
  await quiet.egress.runTest("local");
  assert.match(quiet.elements.egressFacts.innerHTML, /本机代理没有运行/);
});

test("出网：保存后几秒再读一次，刷新到代理热载后的最终生效状态；对齐后不再重读", async () => {
  const pendingEffective = { running: true, supportsEgress: true, mode: "direct", upstream: null }; // 代理还没热载
  let gets = 0;
  const ctx = setup({
    getJson: spy(async () => {
      gets += 1;
      if (gets === 1) return structuredClone(STATUS);
      return savedSystem(gets === 2 ? pendingEffective : SYSTEM_ON); // 第一次重读仍未生效，第二次生效
    }),
    postJson: spy(async () => savedSystem(pendingEffective)),
  });
  ctx.egress.onOpen();
  await flush();
  await ctx.elements.egressModes.dispatch("click", { target: ctx.modeButtons[1] });
  assert.match(ctx.elements.egressFacts.innerHTML, /新设置几秒内生效/);
  assert.equal(ctx.timers.timeouts.size, 1, "保存成功后排一次重读");
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(gets, 2);
  assert.match(ctx.elements.egressFacts.innerHTML, /新设置几秒内生效/);
  assert.equal(ctx.timers.timeouts.size, 1, "仍未生效：再排一次");
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(gets, 3);
  assert.match(ctx.elements.egressFacts.innerHTML, /当前生效<\/dt><dd>经 127\.0\.0\.1:7897<\/dd>/);
  assert.equal(ctx.timers.timeouts.size, 0, "已对齐：不再重读");
});
