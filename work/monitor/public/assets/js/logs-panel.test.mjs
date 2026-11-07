// logs-panel 新逻辑测试:操作分组折叠 / 日期分隔行 / console:filter-logs 联动 / signal 锚点。
import assert from "node:assert/strict";
import test from "node:test";
import {
  groupLogEntries,
  summarizeOperation,
  buildGroupHtml,
  buildLogRowsHtml,
  buildDateSeparatorHtml,
  buildLineRows,
  entryKey,
  logDateKey,
  buildLogLineHtml,
  createLogsPanel,
} from "./logs-panel.js";

const dayTs = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();
const flat = (day, hour, msg) => ({ ts: dayTs(day, hour), source: "ops", level: "info", message: msg });
const opEntry = (op, msg, level = "info", day = 26, hour = 12) =>
  ({ ts: dayTs(day, hour), source: "ops", level, message: msg, operationId: op });

// ---- 分组纯函数 ----

test("groupLogEntries: 相邻同 operationId 折叠成组,隔断后各自成组,无 operationId 平铺", () => {
  const units = groupLogEntries([
    flat(26, 1, "plain-1"),
    opEntry("op-A", "start requested"),
    opEntry("op-A", "start completed"),
    flat(26, 2, "plain-2"),
    opEntry("op-A", "late line of op-A"),
    opEntry("op-B", "stop requested"),
  ]);
  assert.deepEqual(units.map((u) => u.type), ["flat", "group", "flat", "group", "group"]);
  assert.equal(units[1].operationId, "op-A");
  assert.equal(units[1].entries.length, 2, "相邻两条并入同组");
  assert.equal(units[3].operationId, "op-A");
  assert.equal(units[3].entries.length, 1, "被隔断的同 operationId 另起新组(严格相邻语义)");
  assert.equal(units[4].operationId, "op-B");
  assert.deepEqual(groupLogEntries([]), []);
  assert.deepEqual(groupLogEntries(null), []);
});

test("summarizeOperation: 首条关键词提炼;组内 stop+start 组合判为重启", () => {
  // /api/restart 全链路:首条是 stop requested,但组内含 start → 重启
  const restart = summarizeOperation([
    opEntry("op", "stop requested"),
    opEntry("op", "stop completed"),
    opEntry("op", "start requested"),
    opEntry("op", "start completed"),
  ]);
  assert.equal(restart.summary, "重启通道");
  assert.equal(restart.result, "成功");
  assert.equal(restart.level, "ok");

  assert.equal(summarizeOperation([opEntry("op", "start requested")]).summary, "启动通道");
  assert.equal(summarizeOperation([opEntry("op", "stop requested")]).summary, "停止通道");
  assert.equal(summarizeOperation([opEntry("op", "probe endpoint requested")]).summary, "手动探针");
  assert.equal(summarizeOperation([opEntry("op", "bootstrap step build-tarball requested")]).summary, "向导步骤");
  assert.equal(summarizeOperation([opEntry("op", "updated active server configuration to server-02")]).summary, "切换配置");
});

test("summarizeOperation: 结果按组内最高 level;无关键词时截取首条 message", () => {
  const warn = summarizeOperation([opEntry("op", "start requested"), opEntry("op", "slow spawn", "warn")]);
  assert.equal(warn.level, "warn");
  assert.equal(warn.result, "有警告");
  const err = summarizeOperation([
    opEntry("op", "start requested"),
    opEntry("op", "slow spawn", "warn"),
    opEntry("op", "spawn failed", "error"),
  ]);
  assert.equal(err.level, "error");
  assert.equal(err.result, "失败");

  const long = "x".repeat(40);
  const fb = summarizeOperation([opEntry("op", long)]);
  assert.equal(fb.summary, `${"x".repeat(32)}…`, "无关键词时截取首条 message 前 32 字符");
});

test("buildGroupHtml: 组头含摘要/起始时间/条数/结果,插值转义,expanded 纯 class 控制", () => {
  const unit = {
    type: "group",
    operationId: 'op"<1>',
    entries: [
      { ts: dayTs(26, 22, 50), source: "ops", level: "info", message: "start requested", operationId: 'op"<1>' },
      { ts: dayTs(26, 22, 51), source: "ops", level: "error", message: "<script>bad</script>", operationId: 'op"<1>' },
    ],
  };
  const collapsed = buildGroupHtml(unit, false);
  assert.match(collapsed, /log-group log-group-error/);
  assert.doesNotMatch(collapsed, /expanded/);
  assert.match(collapsed, /启动通道 · 22:50:00 · 2 条 · /);
  assert.match(collapsed, /<span class="log-group-result">失败<\/span>/);
  assert.match(collapsed, /data-count="2"/);
  assert.match(collapsed, /data-op="op&quot;&lt;1&gt;"/, "operationId 属性插值转义");
  assert.match(collapsed, /&lt;script&gt;bad&lt;\/script&gt;/, "明细行 message 经 escapeHtml");
  assert.doesNotMatch(collapsed, /<script>/);

  const expanded = buildGroupHtml(unit, true);
  assert.match(expanded, /log-group log-group-error expanded/);
});

// ---- 日期分隔纯函数 ----

test("logDateKey/buildDateSeparatorHtml: 本地日期 key 与 '—— 8月27日 ——' 分隔行", () => {
  assert.equal(logDateKey(dayTs(27, 0, 0)), "2026-08-27");
  const html = buildDateSeparatorHtml(dayTs(27, 6, 44));
  assert.match(html, /^<span class="log-date-sep" data-datekey="2026-08-27">—— 8月27日 ——<\/span>$/);
});

test("buildLogRowsHtml: 跨天处插分隔行,同日不插,prevDateKey 衔接窗口起点", () => {
  const cross = buildLogRowsHtml([flat(26, 23, "a"), flat(27, 0, "b")]);
  assert.equal(cross.rows.length, 3);
  assert.match(cross.rows[1], /log-date-sep/);
  assert.match(cross.rows[1], /8月27日/);
  assert.equal(cross.lastDateKey, "2026-08-27");

  const same = buildLogRowsHtml([flat(26, 1, "a"), flat(26, 2, "b")]);
  assert.equal(same.rows.length, 2, "同日不插分隔行");

  const seeded = buildLogRowsHtml([flat(27, 0, "b")], null, "2026-08-26");
  assert.equal(seeded.rows.length, 2);
  assert.match(seeded.rows[0], /log-date-sep/, "与 DOM 尾部日期不同:窗口起点补分隔");

  const fresh = buildLogRowsHtml([flat(27, 0, "b")], null, "");
  assert.equal(fresh.rows.length, 1, "无前置日期上下文(全量渲染起点)不加前导分隔");
});

test("buildLineRows / entryKey: 平铺行跨天插分隔、衔接尾部日期；去重 key 容忍缺字段", () => {
  const cross = buildLineRows([flat(26, 23, "a"), flat(27, 0, "b")], "2026-08-26");
  assert.equal(cross.rows.length, 3);
  assert.match(cross.rows[1], /8月27日/);
  assert.equal(cross.lastDateKey, "2026-08-27");
  assert.match(buildLineRows([flat(27, 0, "b")], "2026-08-26").rows[0], /log-date-sep/, "与尾部日期不同:补前导分隔");
  assert.equal(buildLineRows([flat(27, 0, "b")]).rows.length, 1, "起点不加前导分隔");
  assert.equal(entryKey({ ts: 1, source: "ops", message: "m" }), "1|ops|m");
  assert.equal(entryKey(null), "undefined||");
});

test("buildLogRowsHtml: 操作组吸收组内跨天(组头时间锚定),日期上下文推进到组内最后一条", () => {
  const { rows, lastDateKey } = buildLogRowsHtml([
    flat(26, 23, "before"),
    opEntry("op-X", "start requested", "info", 26, 23),
    { ...opEntry("op-X", "start completed", "info", 27, 0), ts: dayTs(27, 0, 10) },
    { ...flat(27, 0, "after"), ts: dayTs(27, 0, 20) },
  ]);
  assert.equal(rows.length, 3, "平铺 + 组 + 平铺,组内跨天不拆分隔");
  assert.ok(!rows.some((r) => r.includes("log-date-sep")), "跨天发生在组内:不插分隔行");
  assert.equal(lastDateKey, "2026-08-27", "组后续条目以组内最后一条的日期为上下文");
});

// ---- signal 锚点 ----

test("buildLogLineHtml: source=signal 追加 log-signal 锚点类,其余来源不受影响", () => {
  const signal = buildLogLineHtml({ ts: dayTs(26, 1), source: "signal", level: "warn", message: "上游 429 限流" });
  assert.match(signal, /class="log-line log-warn log-signal"/);
  const ops = buildLogLineHtml({ ts: dayTs(26, 1), source: "ops", level: "warn", message: "plain" });
  assert.doesNotMatch(ops, /log-signal/);
});

// ---- DOM 绑定层(桩) ----

function makeLogEl() {
  const listeners = {};
  return {
    htmlSets: [],
    inserts: [],
    listeners,
    set innerHTML(html) { this.htmlSets.push(html); },
    get innerHTML() { return this.htmlSets[this.htmlSets.length - 1] || ""; },
    insertAdjacentHTML(position, html) { this.inserts.push({ position, html }); },
    firstElementChild: null,
    querySelector() { return null; },
    addEventListener(type, fn) { listeners[type] = fn; },
    textContent: "",
  };
}

function makeLogBox({ dialog = null } = {}) {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { listeners[type] = fn; },
    scrollHeight: 100,
    clientHeight: 100,
    scrollTop: 0,
    scrolledInto: 0,
    closest(sel) { return sel === "dialog" ? dialog : null; },
    scrollIntoView() { this.scrolledInto += 1; },
  };
}

function makeSourceSelect() {
  return {
    value: "",
    options: [{ value: "" }, { value: "ops" }, { value: "supervisor" }, { value: "timeline" }, { value: "signal" }],
    addEventListener() {},
  };
}

function stubFetch(entriesByCall) {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ entries: entriesByCall() }),
    };
  };
  return urls;
}

test("createLogsPanel: 操作组默认折叠渲染;点击展开状态在增量渲染间保持(按 operationId)", async () => {
  const realFetch = globalThis.fetch;
  const groupEntries = [
    flat(26, 1, "plain"),
    opEntry("op-1", "stop requested"),
    opEntry("op-1", "start completed"),
  ];
  stubFetch(() => groupEntries);
  try {
    const logEl = makeLogEl();
    const panel = createLogsPanel({ logEl, logBox: makeLogBox(), sourceSelect: makeSourceSelect() });
    await panel.refresh();
    assert.match(logEl.innerHTML, /log-group log-group-ok/);
    assert.match(logEl.innerHTML, /重启通道 · .* · 2 条 · /);
    assert.doesNotMatch(logEl.innerHTML, /expanded/, "默认折叠");

    // 模拟点击组头(容器级委托):class 翻转 + expandedOps 记忆
    const groupNode = {
      classes: new Set(["log-group", "log-group-ok"]),
      classList: {
        toggle(cls) {
          if (groupNode.classes.has(cls)) { groupNode.classes.delete(cls); return false; }
          groupNode.classes.add(cls);
          return true;
        },
      },
      getAttribute: (name) => (name === "data-op" ? "op-1" : null),
    };
    const headNode = { closest: (sel) => (sel === ".log-group" ? groupNode : null) };
    logEl.listeners.click({ target: { closest: (sel) => (sel === ".log-group-head" ? headNode : null) } });
    assert.ok(groupNode.classes.has("expanded"), "点击即时翻转 class");

    await panel.refresh();
    assert.match(logEl.innerHTML, /log-group log-group-ok expanded/, "全量重渲染后展开状态按 operationId 恢复");

    // 再点一次收起,重渲染后不再展开
    logEl.listeners.click({ target: { closest: (sel) => (sel === ".log-group-head" ? headNode : null) } });
    await panel.refresh();
    assert.doesNotMatch(logEl.innerHTML, /expanded/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createLogsPanel: 增量快路径 —— 平铺批次跨天时随批插入分隔行,不整页重建", async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  stubFetch(() => [flat(26, 22, "seed-a"), flat(26, 23, "seed-b")]);
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  try {
    const logEl = makeLogEl();
    const panel = createLogsPanel({ logEl, logBox: makeLogBox(), sourceSelect: makeSourceSelect() });
    await panel.refresh();
    const fullRenders = logEl.htmlSets.length;

    panel.appendEntry(flat(27, 0, "after-midnight"));
    assert.equal(timers.length, 1, "250ms 合批调度一次");
    assert.equal(timers[0].ms, 250);
    timers[0].cb();

    assert.equal(logEl.htmlSets.length, fullRenders, "平铺批次走增量插入,不触发全量 innerHTML 重建");
    assert.equal(logEl.inserts.length, 1);
    assert.match(logEl.inserts[0].html, /log-date-sep/);
    assert.match(logEl.inserts[0].html, /8月27日/);
    assert.match(logEl.inserts[0].html, /after-midnight/);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test("createLogsPanel: 含 operationId 的批次退回全量渲染,新组按相邻语义并入展示", async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  stubFetch(() => [flat(26, 22, "seed-a")]);
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  try {
    const logEl = makeLogEl();
    const panel = createLogsPanel({ logEl, logBox: makeLogBox(), sourceSelect: makeSourceSelect() });
    await panel.refresh();
    const fullRenders = logEl.htmlSets.length;

    panel.appendEntry(opEntry("op-9", "restart requested"));
    panel.appendEntry(opEntry("op-9", "stop completed"));
    timers[0].cb();

    assert.equal(logEl.htmlSets.length, fullRenders + 1, "操作批次触发一次全量渲染(组头计数/结果统一重算)");
    assert.match(logEl.innerHTML, /log-group/);
    assert.match(logEl.innerHTML, /重启通道 · .* · 2 条 · /);
    assert.equal(logEl.inserts.length, 0, "未走增量插入路径");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

// ---- console:filter-logs 联动 ----

test("applySourceFilter: 已知 source 设入过滤器并走现有 apply 路径(带 source 参数拉取)", async () => {
  const realFetch = globalThis.fetch;
  const urls = stubFetch(() => []);
  try {
    const sourceSelect = makeSourceSelect();
    const dialog = { open: false, shown: 0, showModal() { this.shown += 1; } };
    const logBox = makeLogBox({ dialog });
    const panel = createLogsPanel({ logEl: makeLogEl(), logBox, sourceSelect });

    assert.equal(panel.applySourceFilter("signal"), true);
    assert.equal(sourceSelect.value, "signal");
    assert.ok(urls.some((u) => u.includes("source=signal")), "触发现有 refresh 拉取路径");
    assert.equal(dialog.shown, 1, "面板在 dlgLogs 浮层内:打开浮层进入视口");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("applySourceFilter: 未知 source 安全忽略(不改过滤器/不拉取/不报错);内联布局走 scrollIntoView", async () => {
  const realFetch = globalThis.fetch;
  const urls = stubFetch(() => []);
  try {
    const sourceSelect = makeSourceSelect();
    const logBox = makeLogBox(); // closest → null:非浮层布局
    const panel = createLogsPanel({ logEl: makeLogEl(), logBox, sourceSelect });
    const before = urls.length;

    assert.equal(panel.applySourceFilter("mystery-src"), false);
    assert.equal(sourceSelect.value, "", "未知 source 不改动过滤器");
    assert.equal(urls.length, before, "未知 source 不触发拉取");

    assert.equal(panel.applySourceFilter("ops"), true);
    assert.equal(sourceSelect.value, "ops");
    assert.equal(logBox.scrolledInto, 1, "无浮层时 scrollIntoView 进入视口");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("openOperation: 清掉来源/级别/关键词/时间范围再按 operationId 拉取;清除操作过滤不动可见过滤器", async () => {
  const realFetch = globalThis.fetch;
  const urls = stubFetch(() => []);
  try {
    const control = (value) => ({ value, addEventListener() {} });
    const sourceSelect = { ...makeSourceSelect(), value: "supervisor" };
    const levelSelect = control("error");
    const searchInput = control("timeout");
    const rangeSelect = control("15m");
    const opFilterChip = { style: {}, addEventListener() {} };
    const panel = createLogsPanel({ logEl: makeLogEl(), logBox: makeLogBox(), sourceSelect, levelSelect, searchInput, rangeSelect, opFilterChip });
    const lastLogsQuery = () => new URL(urls.filter((u) => u.includes("/api/logs?")).at(-1), "http://x").searchParams;

    // 事件「查看处置日志」：一次操作的日志分散在 ops/timeline 等来源、可能早于时间范围——
    // 残留的来源/级别/关键词/时间范围会把它整批滤掉。
    await panel.openOperation("op-7");
    assert.deepEqual([sourceSelect.value, levelSelect.value, searchInput.value, rangeSelect.value], ["", "", "", ""]);
    const query = lastLogsQuery();
    assert.equal(query.get("operationId"), "op-7");
    for (const key of ["source", "level", "q", "since"]) assert.equal(query.has(key), false, `不带 ${key}`);
    assert.equal(opFilterChip.style.display, "", "操作过滤 chip 可见");

    sourceSelect.value = "ops";
    await panel.openOperation("");
    assert.equal(sourceSelect.value, "ops", "清除操作过滤不改可见过滤器");
    assert.equal(lastLogsQuery().get("source"), "ops");
    assert.equal(lastLogsQuery().has("operationId"), false);
    assert.equal(opFilterChip.style.display, "none");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("console:filter-logs 事件监听: 有 document 时注册,detail.source 走 applySourceFilter", async () => {
  const realFetch = globalThis.fetch;
  stubFetch(() => []);
  const listeners = {};
  globalThis.document = { addEventListener(type, fn) { listeners[type] = fn; } };
  try {
    const sourceSelect = makeSourceSelect();
    createLogsPanel({ logEl: makeLogEl(), logBox: makeLogBox(), sourceSelect });
    assert.equal(typeof listeners["console:filter-logs"], "function", "createLogsPanel 时注册联动监听");

    listeners["console:filter-logs"]({ detail: { source: "timeline" } });
    assert.equal(sourceSelect.value, "timeline");

    listeners["console:filter-logs"]({ detail: { source: "not-a-source" } });
    assert.equal(sourceSelect.value, "timeline", "未知 source 安全忽略");

    listeners["console:filter-logs"]({}); // 无 detail 不抛
    listeners["console:filter-logs"]({ detail: {} }); // 无 source 字段不抛
    assert.equal(sourceSelect.value, "timeline");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    delete globalThis.document;
    globalThis.fetch = realFetch;
  }
});

test("createLogsPanel: 两次查询重叠时，以后发起的那次为准（先回来的旧条件结果不落地，也不拖垮后回来的）", async () => {
  const realFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (url) => new Promise((resolve) => {
    pending.push({ url: String(url), reply: (entries) => resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries }) }) });
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const logEl = makeLogEl();
    const sourceSelect = makeSourceSelect();
    const panel = createLogsPanel({ logEl, logBox: makeLogBox(), sourceSelect });
    const first = panel.refresh();
    sourceSelect.value = "ops";
    const second = panel.refresh();
    const logCalls = pending.filter((call) => call.url.includes("/api/logs?"));
    assert.equal(logCalls.length, 2);
    assert.ok(logCalls[1].url.includes("source=ops"));
    // 旧条件的那份先回来。
    logCalls[0].reply([flat(26, 1, "from-old-filter")]);
    await tick();
    logCalls[1].reply([flat(26, 2, "from-current-filter")]);
    await tick();
    for (const call of pending) call.reply([]);
    await Promise.all([first, second]);
    assert.match(logEl.innerHTML, /from-current-filter/);
    assert.ok(!logEl.htmlSets.some((html) => html.includes("from-old-filter")), "旧条件的结果从未画上去");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("createLogsPanel: 往上翻着读旧日志时不从头部裁掉（窗口放宽到整份缓存）；在底部时照旧只留最近 300 条", async () => {
  const realFetch = globalThis.fetch;
  const many = Array.from({ length: 420 }, (_, i) => ({ ts: dayTs(26, 1) + i * 1000, source: "timeline", level: "info", message: `m${i}` }));
  stubFetch(() => many);
  try {
    const atBottomEl = makeLogEl();
    await createLogsPanel({ logEl: atBottomEl, logBox: makeLogBox() }).refresh();
    assert.match(atBottomEl.innerHTML, /已省略更早 120 条日志/, "在底部：300 条窗口");

    const readingEl = makeLogEl();
    const box = Object.assign(makeLogBox(), { scrollHeight: 5000, clientHeight: 400, scrollTop: 800 });
    await createLogsPanel({ logEl: readingEl, logBox: box }).refresh();
    assert.doesNotMatch(readingEl.innerHTML, /已省略更早/, "读旧日志：420 条全留着，正在读的行不被裁掉");
    assert.match(readingEl.innerHTML, />.*m0</);
    assert.equal(box.scrollTop, 800, "不在底部时不强行贴底");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("持续读旧日志：超过缓存容量及操作组更新均保留 DOM，回到底部立即接上最新行", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  const entry = i => ({ ...flat(26, 1, `entry-${i}`), ts: dayTs(26, 1) + i * 1000, ...(i >= 300 ? { operationId: "new-op" } : {}) });
  const urls = stubFetch(() => Array.from({ length: 300 }, (_, i) => entry(i)));
  try {
    const logEl = makeLogEl();
    const box = makeLogBox();
    const panel = createLogsPanel({ logEl, logBox: box });
    await panel.refresh();
    const initial = logEl.innerHTML;
    Object.assign(box, { scrollHeight: 5000, clientHeight: 400, scrollTop: 800 });
    for (let i = 300; i < 1000; i++) {
      panel.appendEntry(entry(i));
      if (i % 50 === 0) t.mock.timers.tick(250);
    }
    t.mock.timers.tick(250);
    assert.equal(logEl.innerHTML, initial);
    assert.equal(logEl.htmlSets.length, 1);
    assert.equal(logEl.inserts.length, 0);
    const fetched = urls.length;
    await panel.refresh();
    assert.equal(urls.length, fetched, "阅读中后台重连快照延后");
    stubFetch(() => Array.from({ length: 500 }, (_, i) => entry(500 + i)));
    box.scrollTop = 4600;
    box.listeners.scroll();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.match(logEl.innerHTML, /entry-999/);
    assert.doesNotMatch(logEl.innerHTML, /entry-699/);
    assert.equal((logEl.innerHTML.match(/class="log-line /g) || []).length, 300);
  } finally { globalThis.fetch = realFetch; }
});

test("请求期间开始阅读不替换旧 DOM；主动筛选仍可生效，清空使在途快照失效", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  try {
    stubFetch(() => [flat(26, 1, "original")]);
    const logEl = makeLogEl();
    const box = makeLogBox();
    const panel = createLogsPanel({ logEl, logBox: box });
    await panel.refresh();
    let reply;
    globalThis.fetch = () => new Promise(resolve => { reply = entries => resolve({ ok: true, headers: { get: () => null }, json: async () => ({ entries }) }); });
    const inflight = panel.refresh();
    Object.assign(box, { scrollHeight: 1000, clientHeight: 100, scrollTop: 100 });
    reply([flat(26, 2, "snapshot")]); await inflight;
    assert.match(logEl.innerHTML, /original/);
    stubFetch(() => [flat(26, 3, "filtered")]);
    await panel.refresh({ force: true });
    assert.match(logEl.innerHTML, /filtered/);
    globalThis.fetch = () => new Promise(resolve => { reply = () => resolve({ ok: true, headers: { get: () => null }, json: async () => ({ entries: [flat(26, 4, "late")] }) }); });
    const late = panel.refresh({ force: true });
    const writes = logEl.htmlSets.length;
    panel.clear(); reply(); await late;
    assert.equal(logEl.htmlSets.length, writes);
    assert.equal(logEl.textContent, "操作日志已手动清空。");
  } finally { globalThis.fetch = realFetch; }
});
