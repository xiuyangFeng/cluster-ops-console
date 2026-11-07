import assert from "node:assert/strict";
import test from "node:test";

import { createIncidentsController, INCIDENT_SUMMARY_DAYS } from "./incidents-controller.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

const OPEN_PATH = "/api/incidents?state=open&limit=50";
const RESOLVED_PATH = "/api/incidents?state=resolved&group=cluster&limit=50";
const SUMMARY_PATH = `/api/incidents/summary?days=${INCIDENT_SUMMARY_DAYS}`;
const TYPE_KEY = "s1|agent:codex|DEGRADED";
const STATUS = { serversBrief: { s1: { displayName: "主集群服务器 (myserver)" } }, agents: [{ id: "codex", name: "Codex" }] };

const resolvedIncident = (incidentId, at) => ({
  incidentId, severity: "warn", component: "agent", agentId: "codex", reasonCode: "DEGRADED", serverId: "s1",
  firstSeenAt: at - 60_000, lastSeenAt: at - 30_000, resolvedAt: at, occurrences: 2, attention: {}, lifecycle: "resolved", relatedOperationIds: [],
});

// 一类 Codex 降级：窗口内 12 次、留存 12 条，汇总里带最近 2 条（第一条关联过一次处置）。
function summaryPayload(now = Date.now()) {
  const day = (offset) => new Date(now + 8 * 3600_000 - offset * 86400_000).toISOString().slice(0, 10);
  return {
    schemaVersion: 1, generatedAt: now, days: [day(1), day(0)], countingSince: now - 86400_000, keepPerType: 50, retained: 12, total: 12, capped: false,
    types: [{
      key: TYPE_KEY, serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED", severity: "warn",
      count: 12, capped: false, coverageStart: null, perDay: [5, 7], lastSeenAt: now - 60_000, lastResolvedAt: now - 30_000,
      medianMs: 60_000, longestMs: 120_000, samples: 12, retained: 12,
      recent: [
        { incidentId: "r-1", firstSeenAt: now - 90_000, lastSeenAt: now - 60_000, resolvedAt: now - 30_000, occurrences: 2, operationId: "op-7" },
        { incidentId: "r-2", firstSeenAt: now - 900_000, lastSeenAt: now - 880_000, resolvedAt: now - 840_000, occurrences: 1, operationId: null },
      ],
    }],
  };
}

function setup({ eventsVisible = false, filter = "open", openIncidents = [], elements = {}, summary = summaryPayload(), resolved = [], status = null } = {}) {
  const incidentStateFilter = fakeElement({ value: filter });
  const doc = fakeDocument({ incidentStateFilter, ...elements });
  let visible = eventsVisible;
  const deps = {
    doc,
    getJson: spy(async (path) => {
      if (path.startsWith("/api/incidents/summary")) {
        if (summary instanceof Error) throw summary;
        return summary;
      }
      if (path.includes("state=resolved")) {
        const incidents = path.includes("&type=") ? resolved.filter((item) => item.agentId === "codex") : resolved;
        return { incidents, total: incidents.length, state: "resolved" };
      }
      return { incidents: openIncidents, total: openIncidents.length, state: "open" };
    }),
    postJson: spy(async () => ({})),
    showToast: spy(),
    isViewVisible: (view) => view === "events" && visible,
    openLogsForOperation: spy(),
    getStatus: () => status,
  };
  return { deps, doc, incidentStateFilter, setVisible: (v) => { visible = v; }, incidents: createIncidentsController(deps) };
}

const paths = (deps) => deps.getJson.calls.map((c) => c[0]);
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 事件面板用到的元素；渲染层按 id 从全局 document 取，控制器用注入的 doc——测试里是同一份假文档。
function panelElements() {
  return {
    incidentList: fakeElement(),
    incidentSummary: fakeElement({ hidden: true }),
    incidentResolvedMode: fakeElement({ hidden: true }),
    incidentModeType: fakeElement({ tag: "button", dataset: { evMode: "type" } }),
    incidentModeEach: fakeElement({ tag: "button", dataset: { evMode: "each" } }),
    incidentListBadge: fakeElement(),
  };
}

// 点击委托按 instanceof Element 判定事件目标；假 DOM 用 hasInstance 认领带 closest 的对象。
async function withFakeDom(ctx, run) {
  const saved = { document: globalThis.document, Element: globalThis.Element };
  globalThis.document = ctx.doc;
  globalThis.Element = { [Symbol.hasInstance]: (value) => typeof value?.closest === "function" };
  try {
    await run();
  } finally {
    globalThis.document = saved.document;
    globalThis.Element = saved.Element;
  }
}
// 一个只认某几个 data-* 的点击目标（等价于真实 DOM 里点在带该属性的元素上）。
const clickTarget = (dataset) => {
  const target = { dataset, closest: (selector) => (Object.keys(dataset).some((key) => selector.includes(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)) ? target : null) };
  return target;
};

test("fetch: 常态只拉 open；事件页可见且筛选\"已恢复\"时才拉已恢复的数据——缺省按类型，只拉汇总", async () => {
  const ctx = setup();
  await ctx.incidents.fetch();
  assert.deepEqual(paths(ctx.deps), [OPEN_PATH]);

  const resolvedHidden = setup({ filter: "resolved" });
  await resolvedHidden.incidents.fetch();
  assert.equal(paths(resolvedHidden.deps).length, 1, "事件页不可见不拉已恢复的数据");

  const resolvedVisible = setup({ filter: "resolved", eventsVisible: true });
  await resolvedVisible.incidents.fetch();
  assert.deepEqual(paths(resolvedVisible.deps), [OPEN_PATH, SUMMARY_PATH], "按类型时不拉逐条列表");
  assert.equal(SUMMARY_PATH, "/api/incidents/summary?days=14");
});

test("筛选切到\"已恢复\"时按需强制拉取；切回\"未解决\"不额外请求", async () => {
  const ctx = setup({ eventsVisible: true });
  ctx.incidents.bindFilter();
  await ctx.incidentStateFilter.dispatch("change");
  assert.equal(ctx.deps.getJson.calls.length, 0);
  ctx.incidentStateFilter.value = "resolved";
  await ctx.incidentStateFilter.dispatch("change");
  await settle();
  assert.equal(ctx.deps.getJson.calls.length, 2);
  ctx.incidentStateFilter.value = "open";
  await ctx.incidentStateFilter.dispatch("change");
  await settle();
  assert.equal(ctx.deps.getJson.calls.length, 2);
});

test("分段控件: 切到「逐条」改拉逐条列表、不再拉汇总；切回「按类型」反之；点当前选中的一项不重复请求", async () => {
  const elements = panelElements();
  const ctx = setup({ eventsVisible: true, filter: "resolved", elements, resolved: [resolvedIncident("x-1", Date.now())] });
  await withFakeDom(ctx, async () => {
    ctx.incidents.bindFilter();
    await ctx.incidents.fetch();
    assert.deepEqual(paths(ctx.deps), [OPEN_PATH, SUMMARY_PATH]);
    assert.equal(elements.incidentSummary.hidden, false);
    assert.equal(elements.incidentList.hidden, true);
    assert.equal(elements.incidentResolvedMode.hidden, false, "筛选为已恢复时才出现分段控件");
    assert.equal(elements.incidentModeType.getAttribute("aria-pressed"), "true");
    assert.equal(elements.incidentModeEach.getAttribute("aria-pressed"), "false");

    await elements.incidentResolvedMode.dispatch("click", { target: elements.incidentModeType });
    await settle();
    assert.equal(ctx.deps.getJson.calls.length, 2, "已经是按类型");

    await elements.incidentResolvedMode.dispatch("click", { target: elements.incidentModeEach });
    await settle();
    assert.deepEqual(paths(ctx.deps).slice(2), [OPEN_PATH, RESOLVED_PATH]);
    assert.equal(elements.incidentSummary.hidden, true);
    assert.equal(elements.incidentList.hidden, false);
    assert.equal(elements.incidentModeEach.getAttribute("aria-pressed"), "true");
    assert.equal(elements.incidentListBadge.textContent, "已恢复 1");
    assert.match(elements.incidentList.innerHTML, /data-incident-id="x-1"/);

    await elements.incidentResolvedMode.dispatch("click", { target: elements.incidentModeType });
    await settle();
    assert.deepEqual(paths(ctx.deps).slice(4), [OPEN_PATH, SUMMARY_PATH]);
    assert.equal(elements.incidentSummary.hidden, false);

    // 回到未解决：分段控件收起，卡片列表回来，徽标换回未解决。
    ctx.incidentStateFilter.value = "open";
    await ctx.incidentStateFilter.dispatch("change");
    assert.equal(elements.incidentResolvedMode.hidden, true);
    assert.equal(elements.incidentSummary.hidden, true);
    assert.equal(elements.incidentList.hidden, false);
    assert.equal(elements.incidentListBadge.textContent, "未解决 0");
    assert.match(elements.incidentList.innerHTML, /<p class="empty-state-title">没有未解决的事件<\/p>/);
  });
});

test("按类型汇总: 用界面上的名字渲染；点一行展开 / 收起这一类最近的逐条记录；「相关日志」按 operationId 打开日志", async () => {
  const elements = panelElements();
  const ctx = setup({ eventsVisible: true, filter: "resolved", elements, status: STATUS });
  await withFakeDom(ctx, async () => {
    // 还没拿到数据：占位而不是空表。
    ctx.incidents.render();
    assert.match(elements.incidentSummary.innerHTML, /正在加载事件…/);
    assert.equal(elements.incidentListBadge.textContent, "已恢复");

    await ctx.incidents.fetch();
    const html = () => elements.incidentSummary.innerHTML;
    assert.equal(elements.incidentListBadge.textContent, "近 2 天 12 次 · 1 类");
    assert.match(html(), /<span class="ev-title">Codex · 降级<\/span>/);
    assert.match(html(), /<td>主集群<\/td>/);
    assert.match(html(), /aria-expanded="false"/);
    assert.doesNotMatch(html(), /ev-children/, "收起时不渲染逐条记录");

    await elements.incidentSummary.dispatch("click", { target: clickTarget({ typeKey: TYPE_KEY }) });
    assert.match(html(), /data-open="true"/);
    assert.match(html(), /aria-expanded="true"/);
    assert.equal(html().match(/<li><span class="ev-when">/g).length, 2);
    assert.match(html(), /还有 10 条更早的记录/);
    assert.deepEqual([...html().matchAll(/data-view-ops="([^"]+)"/g)].map((m) => m[1]), ["op-7"], "只有关联过处置的那条有日志入口");

    await elements.incidentSummary.dispatch("click", { target: clickTarget({ viewOps: "op-7" }) });
    assert.deepEqual(ctx.deps.openLogsForOperation.calls, [["op-7"]]);
    assert.match(html(), /data-open="true"/, "点日志入口不会把这一行收起来");

    // 展开状态跨刷新保留。
    await ctx.incidents.fetch({ force: true });
    assert.match(html(), /data-open="true"/);
    await elements.incidentSummary.dispatch("click", { target: clickTarget({ typeKey: TYPE_KEY }) });
    assert.doesNotMatch(html(), /data-open="true"/);
    assert.equal(ctx.deps.getJson.calls.filter((c) => c[0].includes("state=resolved")).length, 0, "按类型时始终不拉逐条列表");
  });
});

test("按类型汇总 → 「查看这一类留存的全部 N 条」: 切到逐条并只看这一类；「显示全部类型」或再点「逐条」回到全部", async () => {
  const now = Date.now();
  const elements = panelElements();
  const other = { ...resolvedIncident("t-1", now - 5000), component: "tunnel", agentId: null, reasonCode: "TUNNEL_DOWN" };
  const ctx = setup({ eventsVisible: true, filter: "resolved", elements, status: STATUS, resolved: [resolvedIncident("x-1", now), other] });
  await withFakeDom(ctx, async () => {
    ctx.incidents.bindFilter();
    await ctx.incidents.fetch();
    await elements.incidentSummary.dispatch("click", { target: clickTarget({ viewType: "no-such-type" }) });
    await settle();
    assert.equal(elements.incidentSummary.hidden, false, "汇总里没有的类型：不切换");

    await elements.incidentSummary.dispatch("click", { target: clickTarget({ viewType: TYPE_KEY }) });
    // 新列表还没到：先显示加载，而不是别的类型的记录。
    assert.equal(elements.incidentSummary.hidden, true);
    assert.equal(elements.incidentList.hidden, false);
    assert.match(elements.incidentList.innerHTML, /只看这一类：Codex · 降级 · 主集群/);
    assert.match(elements.incidentList.innerHTML, /正在加载事件…/);
    assert.equal(elements.incidentModeEach.getAttribute("aria-pressed"), "true");
    assert.equal(elements.incidentModeEach.focused, true, "原来的按钮随汇总表隐藏了，焦点交给分段控件");
    await settle();
    assert.equal(paths(ctx.deps).at(-1), `${RESOLVED_PATH}&type=${encodeURIComponent(TYPE_KEY)}`);
    assert.match(elements.incidentList.innerHTML, /data-incident-id="x-1"/);
    assert.doesNotMatch(elements.incidentList.innerHTML, /data-incident-id="t-1"/);
    assert.equal(elements.incidentListBadge.textContent, "已恢复 1");

    await elements.incidentList.dispatch("click", { target: clickTarget({ clearType: "" }) });
    await settle();
    assert.equal(paths(ctx.deps).at(-1), RESOLVED_PATH);
    assert.doesNotMatch(elements.incidentList.innerHTML, /只看这一类/);
    assert.match(elements.incidentList.innerHTML, /data-incident-id="t-1"/);
    assert.equal(elements.incidentListBadge.textContent, "已恢复 2");

    // 再进一次，然后直接点分段控件里已经选中的「逐条」：同样回到全部类型。
    await elements.incidentResolvedMode.dispatch("click", { target: elements.incidentModeType });
    await settle();
    await elements.incidentSummary.dispatch("click", { target: clickTarget({ viewType: TYPE_KEY }) });
    await settle();
    assert.match(elements.incidentList.innerHTML, /只看这一类/);
    await elements.incidentResolvedMode.dispatch("click", { target: elements.incidentModeEach });
    await settle();
    assert.equal(paths(ctx.deps).at(-1), RESOLVED_PATH);
    assert.doesNotMatch(elements.incidentList.innerHTML, /只看这一类/);
  });
});

test("按类型汇总取不到: 从没成功过时如实说明并指到「逐条」；成功过就继续显示上一次的数据", async () => {
  const elements = panelElements();
  const failing = setup({ eventsVisible: true, filter: "resolved", elements, summary: new Error("404") });
  await withFakeDom(failing, async () => {
    await failing.incidents.fetch();
    assert.match(elements.incidentSummary.innerHTML, /暂时取不到按类型汇总/);
    assert.match(elements.incidentSummary.innerHTML, /稍后会自动重试；也可以先切到「逐条」查看。/);
    assert.equal(elements.incidentListBadge.textContent, "已恢复");
    // 「改看逐条」= 点分段控件里的「逐条」：换成逐条列表、拉逐条接口，焦点交给分段控件。
    await elements.incidentSummary.dispatch("click", { target: clickTarget({ showEach: "" }) });
    await settle();
    assert.equal(paths(failing.deps).at(-1), RESOLVED_PATH);
    assert.equal(elements.incidentSummary.hidden, true);
    assert.equal(elements.incidentList.hidden, false);
    assert.equal(elements.incidentModeEach.getAttribute("aria-pressed"), "true");
    assert.equal(elements.incidentModeEach.focused, true);
  });

  const flakyElements = panelElements();
  let fail = false;
  const flaky = setup({ eventsVisible: true, filter: "resolved", elements: flakyElements });
  const original = flaky.deps.getJson;
  const getJson = spy(async (path) => {
    if (fail && path.startsWith("/api/incidents/summary")) throw new Error("timeout");
    return original(path);
  });
  const controller = createIncidentsController({ ...flaky.deps, getJson });
  await withFakeDom(flaky, async () => {
    await controller.fetch();
    assert.match(flakyElements.incidentSummary.innerHTML, /ev-table/);
    fail = true;
    await controller.fetch({ force: true });
    assert.match(flakyElements.incidentSummary.innerHTML, /ev-table/, "偶发失败不清空已有的表");
    assert.equal(flakyElements.incidentListBadge.textContent, "近 2 天 12 次 · 1 类");
  });
});

test("查看处置日志：按钮带最近一次处置的 operationId，点击以它打开日志浮层", async () => {
  const incidentList = fakeElement();
  const now = Date.now();
  const ctx = setup({
    elements: { incidentList },
    status: STATUS,
    openIncidents: [{
      incidentId: "inc-1", severity: "error", component: "tunnel", reasonCode: "TUNNEL_DOWN", serverId: "s1",
      firstSeenAt: now, lastSeenAt: now, occurrences: 1, attention: {}, lifecycle: "open",
      relatedOperationIds: ["op-old", "op-mid", "op-new"], // 后端按关联先后追加，最后一个最近
    }],
  });
  await withFakeDom(ctx, async () => {
    // 未解决列表也是：数据到之前是加载占位，不是「没有事件」。
    ctx.incidents.render();
    assert.match(incidentList.innerHTML, /正在加载事件…/);
    await ctx.incidents.fetch();
    const ids = [...incidentList.innerHTML.matchAll(/data-view-ops="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["op-new"], "只有一个按钮，指向最近一次处置");
    assert.match(incidentList.innerHTML, />查看处置日志</);
    assert.match(incidentList.innerHTML, /<span class="incident-title">隧道 · 连接断开<\/span>/);
    assert.match(incidentList.innerHTML, /<span class="incident-server">主集群<\/span>/);
    assert.doesNotMatch(incidentList.innerHTML, /TUNNEL_DOWN|>s1</, "卡片上不外露内部写法");

    await incidentList.dispatch("click", { target: clickTarget({ viewOps: ids[0] }) });
    assert.deepEqual(ctx.deps.openLogsForOperation.calls, [["op-new"]]);

    await incidentList.dispatch("click", { target: clickTarget({ attention: "snooze", id: "inc-1" }) });
    assert.deepEqual(ctx.deps.postJson.calls, [["/api/incidents/inc-1/attention", { action: "snooze", durationMs: 3600_000 }]]);
  });
});

test("空状态「查看已恢复事件」：把筛选器切到「已恢复」走同一条按需拉取路径，焦点交给筛选器", async () => {
  const elements = panelElements();
  const ctx = setup({ eventsVisible: true, elements });
  await withFakeDom(ctx, async () => {
    ctx.incidents.bindFilter();
    await ctx.incidents.fetch();
    assert.deepEqual(paths(ctx.deps), [OPEN_PATH]);
    assert.match(elements.incidentList.innerHTML, /data-show-resolved/);
    await elements.incidentList.dispatch("click", { target: clickTarget({ showResolved: "" }) });
    await settle();
    assert.equal(ctx.incidentStateFilter.value, "resolved");
    assert.equal(ctx.incidentStateFilter.focused, true);
    assert.deepEqual(paths(ctx.deps).slice(1), [OPEN_PATH, SUMMARY_PATH], "与手动切筛选器同样只拉汇总");
    assert.equal(elements.incidentSummary.hidden, false);
    assert.equal(elements.incidentResolvedMode.hidden, false);
    assert.match(elements.incidentSummary.innerHTML, /ev-table/);
  });
});

test("未解决列表从没取到过：不再停在「正在加载」，红色说明 + 原因；取到过之后偶发失败继续显示上一次的列表", async () => {
  const elements = panelElements();
  let fail = true;
  const ctx = setup({ eventsVisible: true, elements });
  const original = ctx.deps.getJson;
  const getJson = spy(async (path) => {
    if (fail && path === OPEN_PATH) throw Object.assign(new Error("boom"), { serverMessage: "monitor 未就绪" });
    return original(path);
  });
  const controller = createIncidentsController({ ...ctx.deps, getJson });
  await withFakeDom(ctx, async () => {
    await controller.fetch();
    assert.match(elements.incidentList.innerHTML, /data-tone="error"/);
    assert.match(elements.incidentList.innerHTML, /<p class="empty-state-title">暂时取不到事件列表<\/p>/);
    assert.match(elements.incidentList.innerHTML, /monitor 未就绪；稍后会自动重试。/);
    fail = false;
    await controller.fetch({ force: true });
    assert.match(elements.incidentList.innerHTML, /没有未解决的事件/);
    fail = true;
    await controller.fetch({ force: true });
    assert.match(elements.incidentList.innerHTML, /没有未解决的事件/, "取到过就保留上一次的结果");
  });
});

test("前后经过：展开即取 /api/incidents/:id/context，30 秒内再展开不重取；收起后再展开过期才重取；取不到如实显示", async () => {
  const elements = panelElements();
  const { incidentList } = elements;
  let clock = 1_000_000;
  const open = [{ incidentId: "i1", severity: "error", component: "tunnel", reasonCode: "TUNNEL_DOWN", serverId: "s1", firstSeenAt: clock - 60_000, lastSeenAt: clock, occurrences: 2, attention: {}, lifecycle: "open" }];
  const { deps, doc } = setup({ eventsVisible: true, openIncidents: open, elements });
  const contextCalls = () => deps.getJson.calls.map(([path]) => path).filter((path) => path.endsWith("/context"));
  deps.getJson = spy(async (path) => (path.endsWith("/context") ? { from: clock - 600_000, to: clock, entries: [{ at: clock - 60_000, kind: "incident-open", self: true }] } : { incidents: open, total: 1, state: "open" }));
  await withFakeDom({ doc }, async () => {
  const controller = createIncidentsController({ ...deps, now: () => clock });
  await controller.fetch({ force: true });
  await controller.toggleContext("i1");
  assert.deepEqual(contextCalls(), ["/api/incidents/i1/context"]);
  assert.match(incidentList.innerHTML, /本事件开始/);
  await controller.toggleContext("i1"); // 收起
  assert.doesNotMatch(incidentList.innerHTML, /本事件开始/);
  await controller.toggleContext("i1"); // 30 秒内再展开：不重取
  assert.equal(contextCalls().length, 1);
  clock += 31_000;
  await controller.toggleContext("i1");
  await controller.toggleContext("i1");
  assert.equal(contextCalls().length, 2, "过期后重取");

  const failing = createIncidentsController({ ...deps, getJson: spy(async (path) => { if (path.endsWith("/context")) throw new Error("boom"); return { incidents: open, total: 1, state: "open" }; }), now: () => clock });
  await failing.fetch({ force: true });
  await failing.toggleContext("i1");
  assert.match(incidentList.innerHTML, /暂时取不到前后经过/);
  });
});

test("复制排障信息：把事件事实 + 前后经过复制到剪贴板并提示；建议处置按钮交给 onRemedy", async () => {
  const clock = 1_000_000;
  const open = [{ incidentId: "i1", severity: "error", component: "tunnel", reasonCode: "TUNNEL_DOWN", serverId: "s1", firstSeenAt: clock - 60_000, lastSeenAt: clock, occurrences: 2, attention: {}, lifecycle: "open" }];
  const { deps } = setup({ eventsVisible: true, openIncidents: open, status: STATUS });
  const copied = [];
  const onRemedy = spy();
  deps.getJson = spy(async (path) => (path.endsWith("/context") ? { entries: [{ at: clock - 90_000, kind: "sleep", sleptMs: 60_000, scope: "local" }] } : { incidents: open, total: 1, state: "open" }));
  const controller = createIncidentsController({ ...deps, now: () => clock, copyText: async (text) => { copied.push(text); return true; }, onRemedy, canScopedRestart: () => true });
  await controller.fetch({ force: true });
  await controller.copyIncident("i1");
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^【事件】隧道 · 连接断开（TUNNEL_DOWN）\n服务器：主集群/);
  assert.match(copied[0], /电脑休眠 1 分钟（本机）/);
  assert.equal(deps.showToast.calls.at(-1)[0].type, "success");
  await controller.copyIncident("missing");
  assert.equal(copied.length, 1, "找不到的事件不复制");
});
