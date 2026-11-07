// usage-controller.js 的空状态动作接线：顶部说明与会话表空态里的按钮由 usage-view.js 渲染（会被就地修补替换），
// 点击委托在两个容器上，全部复用已有路径（立即同步 / 换范围 / 清除筛选 / 清除会话筛选）。纯 Node，假 DOM。
import assert from "node:assert/strict";
import test from "node:test";

import { createUsageController, USAGE_POLL_MS } from "./usage-controller.js";
import { deferred, fakeElement, flush, spy } from "./test-support.mjs";

const SUMMARY_PREFIX = "/api/usage/summary?";

// 任意 id 都给一个假元素（渲染层会写很多元素）；morphInnerHtml 经 ownerDocument 的 <template> 解析，记下写入的 HTML。
function autoDocument() {
  const elements = new Map();
  const make = (id) => {
    const el = fakeElement({ id, childNodes: [], isConnected: true, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {} });
    el.ownerDocument = {
      createElement: () => {
        const tpl = { content: { childNodes: [] } };
        Object.defineProperty(tpl, "innerHTML", { set: (value) => { el.html = value; } });
        return tpl;
      },
    };
    return el;
  };
  return {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
  };
}

function setup(summary = { disabled: true }, overrides = {}) {
  const doc = autoDocument();
  const deps = {
    doc,
    win: {},
    getJson: spy(async (path) => (path.startsWith(SUMMARY_PREFIX) ? structuredClone(summary) : { disabled: true })),
    postJson: spy(async () => ({})),
    showToast: spy(),
    isViewVisible: () => true,
    isHidden: () => false,
    onVisibilityChange: () => {},
    storage: null,
    ...overrides,
  };
  const controller = createUsageController(deps);
  controller.bind();
  return { doc, deps, controller };
}

// 点击目标：closest 按选择器列表精确匹配一个 data-* 属性或 #id。
function target({ attr = null, id = null, dataset = {} }) {
  const el = {
    id,
    dataset,
    closest: (selector) => (selector.split(",").map((s) => s.trim()).some((s) => (attr && s === `[${attr}]`) || (id && s === `#${id}`)) ? el : null),
  };
  return el;
}

const summaryCalls = (deps) => deps.getJson.calls.map((c) => c[0]).filter((p) => p.startsWith(SUMMARY_PREFIX));

const emptySummary = () => ({ sources: [], sessions: [], today: "2026-10-19", scope: null, kpis: null, trend: null, calendar: {}, projects: [] });

test("重进用量页复用刷新周期内的数据，反复往返不会推迟原定轮询", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  let visible = true;
  const { controller, deps } = setup(emptySummary(), { isViewVisible: () => visible });
  controller.enter(); await flush();
  assert.equal(summaryCalls(deps).length, 1);
  for (let i = 0; i < 4; i++) {
    visible = false; controller.leave();
    t.mock.timers.tick(3000);
    visible = true; controller.enter(); await flush();
  }
  assert.equal(summaryCalls(deps).length, 1);
  t.mock.timers.tick(3000); await flush();
  assert.equal(summaryCalls(deps).length, 2, "到原定 15 秒就更新");
  visible = false; controller.leave();
  t.mock.timers.tick(USAGE_POLL_MS * 2); await flush();
  assert.equal(summaryCalls(deps).length, 2, "隐藏期间不轮询");
  visible = true; controller.enter(); await flush();
  assert.equal(summaryCalls(deps).length, 3, "过期后重进立即刷新");
});

test("筛选变更、手动刷新与失败重试不被重进缓存挡住", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  let fails = true;
  const getJson = spy(async () => { if (fails) throw new Error("offline"); return emptySummary(); });
  const { controller, deps } = setup(undefined, { getJson });
  controller.enter(); await flush();
  fails = false;
  controller.enter(); await flush();
  assert.equal(summaryCalls(deps).length, 2);
  controller.state.range = 7;
  controller.enter(); await flush();
  assert.match(summaryCalls(deps).at(-1), /range=7/);
  assert.equal(summaryCalls(deps).length, 3);
  await controller.refresh();
  assert.equal(summaryCalls(deps).length, 4);
});

test("过期重进仍保护向下翻阅的会话列表，新数据只提示待更新", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const summary = emptySummary();
  summary.sessions = [{ key: "A", day: summary.today, agent: "codex", status: "history", projectLabel: "reading-project", first: 1792224000, last: 1792224000, stats: { calls: 1, total: 10, fresh: 10, errors: 0 } }];
  let visible = true;
  const { controller, doc } = setup(summary, { isViewVisible: () => visible });
  controller.enter(); await flush();
  const rows = doc.getElementById("usageSessionRows");
  assert.match(rows.html, /reading-project/);
  const html = rows.html;
  doc.getElementById("usageSessionScroll").scrollTop = 400;
  visible = false; controller.leave();
  t.mock.timers.tick(USAGE_POLL_MS + 1);
  summary.sessions[0].stats.calls = 2;
  summary.sessions[0].projectLabel = "updated-project";
  visible = true; controller.enter(); await flush();
  assert.equal(rows.html, html, "过期刷新也不能强制重排正在阅读的会话");
  assert.equal(doc.getElementById("usageSessionScroll").scrollTop, 400);
});

test("空状态「看近 7 天」= 点顶部日期分段：范围换成 7 天、清掉单日并重新拉取", async () => {
  const { doc, deps, controller } = setup();
  controller.state.date = "2026-10-03";
  await doc.getElementById("usageSessionEmpty").dispatch("click", { target: target({ attr: "data-usage-jump-range", dataset: { usageJumpRange: "7" } }) });
  assert.equal(controller.state.range, 7);
  assert.equal(controller.state.date, null);
  assert.match(summaryCalls(deps).at(-1), /range=7&/);
});

test("空状态「清除筛选」：只清 Agent / 项目（保留日期范围），重新拉取", async () => {
  const { doc, deps, controller } = setup();
  Object.assign(controller.state, { range: 30, agent: "claude", project: "/p", projectLabel: "p" });
  await doc.getElementById("usageSessionEmpty").dispatch("click", { target: target({ attr: "data-usage-clear-filter", dataset: { usageClearFilter: "" } }) });
  assert.equal(controller.state.agent, "all");
  assert.equal(controller.state.project, "all");
  assert.equal(controller.state.range, 30);
  assert.match(summaryCalls(deps).at(-1), /range=30&agent=all&project=all/);
});

test("空状态「清除会话筛选」（#usageResetSessions 由空状态渲染）：搜索与会话筛选回到全部", async () => {
  const { doc, controller } = setup();
  Object.assign(controller.state, { search: "abc", sessionFilter: "error" });
  doc.getElementById("usageSearch").value = "abc";
  await doc.getElementById("usageSessionEmpty").dispatch("click", { target: target({ id: "usageResetSessions" }) });
  assert.equal(controller.state.search, "");
  assert.equal(controller.state.sessionFilter, "all");
  assert.equal(doc.getElementById("usageSearch").value, "");
});

test("空状态「立即同步」/「重试」= 顶部「立即同步」：逐台触发 usage 探针后重新拉取", async () => {
  const summary = { sources: [{ id: "s1", name: "主集群", lastError: "ssh 超时" }], coverageStart: null, sessions: [], today: "2026-10-06", scope: null, kpis: null, trend: null, calendar: {}, projects: [] };
  const { doc, deps, controller } = setup(summary);
  await controller.refresh({ forceSessions: true });
  const page = doc.getElementById("usageEmptyState");
  assert.equal(page.hidden, false);
  assert.match(page.html, /暂时取不到用量数据/);
  assert.match(page.html, /主集群：ssh 超时。会话日志每分钟同步一次，下一轮会再试。/);
  const before = summaryCalls(deps).length;
  await page.dispatch("click", { target: target({ attr: "data-usage-sync", dataset: { usageSync: "" } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deps.postJson.calls.map((c) => c[0]), ["/api/probe/usage%3As1/run"]);
  assert.equal(summaryCalls(deps).length, before + 1);
});

test("用量模块关闭：顶部换成「用量模块已关闭」说明", async () => {
  const { doc, controller } = setup({ disabled: true });
  await controller.refresh();
  const page = doc.getElementById("usageEmptyState");
  assert.equal(page.hidden, false);
  assert.match(page.html, /<p class="empty-state-title">用量模块已关闭<\/p>/);
});

// 会话详情：成功与 404 两个分支用同一请求序号 + 目标校验。先开 A（请求在飞）再开 B，
// A 的迟到 404 不得把已打开的 B 改成「会话不存在」；同一会话的较旧回包也不得盖掉较新的。
test("会话详情：A 的迟到 404 不覆盖已打开的 B；同一会话的旧回包不盖新回包", async () => {
  const replies = new Map();
  const ctx = setup();
  const getJson = spy((path) => {
    if (path.startsWith(SUMMARY_PREFIX)) return Promise.resolve({ disabled: true });
    const key = new URL(path, "http://x").searchParams.get("key");
    const reply = deferred();
    if (!replies.has(key)) replies.set(key, []);
    replies.get(key).push(reply);
    return reply.promise;
  });
  const doc = autoDocument();
  const controller = createUsageController({ ...ctx.deps, doc, getJson });
  controller.bind();
  doc.getElementById("dlgUsageSession").open = true;
  const rows = doc.getElementById("usageSessionRows");
  const open = (key) => rows.dispatch("click", { target: { closest: (sel) => (sel === "[data-session]" ? { dataset: { session: key } } : null) } });
  const detailOf = (key, label) => ({ key, projectLabel: label, status: "history", turns: [], stats: { calls: 0, errors: 0, total: 0, fresh: 0, output: 0 }, context: {} });
  const body = doc.getElementById("usageSessionDetail");
  const title = doc.getElementById("usageSessionTitle");

  await open("A");
  await open("B");
  replies.get("B")[0].resolve(detailOf("B", "proj-B"));
  await flush();
  assert.equal(title.textContent, "proj-B");
  const shown = body.innerHTML;
  replies.get("A")[0].reject(Object.assign(new Error("HTTP 404"), { status: 404 }));
  await flush();
  assert.equal(body.innerHTML, shown, "A 的迟到 404 不得把 B 改成不存在");
  assert.doesNotMatch(body.innerHTML, /会话不存在/);

  // 同一会话 B 再开一次（新请求）后，第一次之前发出的旧回包（这里第二个回包先到、第一个 404 后到）
  await open("B");
  await open("B");
  replies.get("B")[2].resolve(detailOf("B", "proj-B-new"));
  await flush();
  replies.get("B")[1].reject(Object.assign(new Error("HTTP 404"), { status: 404 }));
  await flush();
  assert.equal(title.textContent, "proj-B-new");
  assert.doesNotMatch(body.innerHTML, /会话不存在/, "同一会话较旧的 404 也不得盖掉较新的详情");
});

test("会话详情：轮询回来的内容没变就不重建（选中的文字与焦点留得住）；重新打开时不会卡在「加载中」", async () => {
  const replies = [];
  const ctx = setup();
  const getJson = spy((path) => {
    if (path.startsWith(SUMMARY_PREFIX)) return Promise.resolve({ disabled: true });
    const reply = deferred();
    replies.push(reply);
    return reply.promise;
  });
  const doc = autoDocument();
  const controller = createUsageController({ ...ctx.deps, doc, getJson });
  controller.bind();
  doc.getElementById("dlgUsageSession").open = true;
  const body = doc.getElementById("usageSessionDetail");
  let html = "";
  let writes = 0;
  Object.defineProperty(body, "innerHTML", { get: () => html, set: (value) => { html = value; writes += 1; } });
  const rows = doc.getElementById("usageSessionRows");
  const open = (key) => rows.dispatch("click", { target: { closest: (sel) => (sel === "[data-session]" ? { dataset: { session: key } } : null) } });
  const detailOf = (calls) => ({ key: "A", sid: "sid-A", projectLabel: "proj-A", status: "history", turns: [], stats: { calls, errors: 0, total: 0, fresh: 0, output: 0 }, context: {} });
  const reply = async (detail) => { replies.at(-1).resolve(detail); await flush(); };

  await open("A");
  await reply(detailOf(3));
  assert.match(html, /sid-A/);
  const afterFirst = writes;

  controller.refresh();
  await reply(detailOf(3));
  assert.equal(writes, afterFirst, "同样的内容不再写 innerHTML");

  controller.refresh();
  await reply(detailOf(4));
  assert.equal(writes, afterFirst + 1, "内容变了照常更新");

  await open("A");
  assert.match(html, /加载中/);
  await reply(detailOf(4));
  assert.match(html, /sid-A/, "重新打开同一会话：先显示加载中，回包后要画回详情");
});

test("成本洞察：模型筛选进入请求、再点取消与清除恢复", async () => {
  const { doc, deps, controller } = setup();
  const panel = doc.getElementById("usageInsights");
  const model = target({ attr: "data-cost-kind", dataset: { costKind: "model", costKey: "model <demo>" } });
  await panel.dispatch("click", { target: model }); await flush();
  assert.equal(controller.state.model, "model <demo>");
  assert.equal(new URL(summaryCalls(deps).at(-1), "http://x").searchParams.get("model"), "model <demo>");
  await panel.dispatch("click", { target: model }); await flush();
  assert.equal(controller.state.model, "all");
  assert.equal(new URL(summaryCalls(deps).at(-1), "http://x").searchParams.has("model"), false);
  await panel.dispatch("click", { target: model }); await flush();
  await doc.getElementById("usageClearFilter").dispatch("click"); await flush();
  assert.equal(controller.state.model, "all");
});
