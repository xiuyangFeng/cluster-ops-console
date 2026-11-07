import assert from "node:assert/strict";
import test from "node:test";
import { LOG_STREAM_WAITING_HTML, buildStreamLineHtml, createLogStream, streamLevel, trimToMax } from "./render/log-stream.js";

// 最小 DOM 桩:只实现 trimToMax 用到的 children/removeChild
function makeEl(lines) {
  const el = {
    children: lines.map((t) => ({ text: t })),
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstElementChild() { return this.children[0] || null; },
  };
  return el;
}

test("trimToMax: 超出上限时从头部裁剪到 maxLines", () => {
  const el = makeEl(["1", "2", "3", "4", "5"]);
  trimToMax(el, 3);
  assert.equal(el.children.length, 3);
  assert.equal(el.children[0].text, "3");
});

test("trimToMax: 未超上限不动", () => {
  const el = makeEl(["1", "2"]);
  trimToMax(el, 3);
  assert.equal(el.children.length, 2);
});

// ---- append 合批 ----

// 一段 HTML 里有几行(日志行 / 日期分隔行;日志行里面还套着时刻、来源、正文的 <span>)
const countRows = (html) => (html.match(/class="(?:log-line|log-date-sep)[ "]/g) || []).length;

// 流容器桩:每行一个顶层元素,scrollHeight 读取计数用于断言"一批只读一次布局"。
function makeStreamEl({ scrollHeight = 100, clientHeight = 100, scrollTop = 0, childCount = 0 } = {}) {
  const el = {
    children: Array.from({ length: childCount }, (_, i) => ({ idx: i })),
    clientHeight,
    scrollTop,
    scrollHeightReads: 0,
    inserts: [],
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    _scrollHeight: scrollHeight,
    get scrollHeight() {
      this.scrollHeightReads += 1;
      return this._scrollHeight;
    },
    get firstElementChild() { return this.children[0] || null; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    insertAdjacentHTML(position, html) {
      assert.equal(position, "beforeend");
      this.inserts.push(html);
      const rows = countRows(html);
      for (let i = 0; i < rows; i++) this.children.push({ appended: true });
    },
    set innerHTML(html) {
      this.seededHtml = html;
      this.inserts = [];
      const rows = countRows(html);
      this.children = Array.from({ length: rows }, () => ({ seeded: true }));
    },
  };
  return el;
}

// 分隔行感知的容器桩:children 带 className 与 nextElementSibling,供 trimToMax 新语义测试。
// kinds: "sep" = 日期分隔行,其余为日志行文本。
function makeSepAwareEl(kinds) {
  const el = {
    children: [],
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
    },
    get firstElementChild() { return this.children[0] || null; },
  };
  for (const kind of kinds) {
    const node = { className: kind === "sep" ? "log-date-sep" : "log-line log-ok", label: kind };
    Object.defineProperty(node, "nextElementSibling", {
      get() {
        const i = el.children.indexOf(node);
        return i >= 0 ? el.children[i + 1] || null : null;
      },
    });
    el.children.push(node);
  }
  return el;
}

function withFakeTimers(fn) {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms) => {
    timers.push({ cb, ms });
    return timers.length;
  };
  try {
    return fn(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

const entry = (i) => ({ ts: i, source: "ops", level: "info", message: `line-${i}` });

test("append 合批: 窗口内多条只调度一次定时器、一次插入、贴底跟随", () => {
  withFakeTimers((timers) => {
    // scrollHeight === clientHeight → 视为贴底
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });

    stream.append(entry(1));
    stream.append(entry(2));
    stream.append(entry(3));

    assert.equal(timers.length, 1, "同一批只调度一次 flush 定时器");
    assert.equal(timers[0].ms, 250, "默认 250ms 合批窗口(与 logs-panel 一致)");
    assert.equal(el.inserts.length, 0, "flush 前不落 DOM");

    timers[0].cb();

    assert.equal(el.inserts.length, 1, "一批只做一次 insertAdjacentHTML");
    assert.equal(countRows(el.inserts[0]), 3, "三行拼进同一次插入");
    assert.match(el.inserts[0], /line-1/);
    assert.match(el.inserts[0], /line-3/);
    assert.equal(el.children.length, 3);
    // 布局读取:isAtBottom 一次 + 贴底回滚赋值一次,与批内行数无关
    assert.equal(el.scrollHeightReads, 2, "一批内 isAtBottom 只读一次 scrollHeight");
    assert.equal(el.scrollTop, el._scrollHeight, "贴底时跟随滚动到底部");
  });
});

test("append 合批: 非贴底时不改动 scrollTop(阅读位置保持)", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 1000, clientHeight: 100, scrollTop: 0 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    stream.append(entry(1));
    stream.append(entry(2));
    timers[0].cb();
    assert.equal(el.inserts.length, 1);
    assert.equal(el.scrollTop, 0, "用户上翻阅读时不被拽回底部");
  });
});

test("翻旧日志跨过整个窗口仍保留旧行；积压有界，回到底部才接上最新行", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 2000, clientHeight: 320, scrollTop: 500, childCount: 80 });
    const oldFirst = el.firstElementChild;
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    for (let i = 0; i < 200; i++) stream.append(entry(i));
    timers[0].cb();
    assert.equal(el.inserts.length, 0, "阅读期间不重排、裁剪或重建 DOM");
    assert.equal(el.firstElementChild, oldFirst);
    assert.equal(el.scrollTop, 500);
    el.scrollTop = 1680;
    el.listeners.scroll();
    assert.equal(timers.length, 2, "回到底部后无须等待下一条 SSE 就恢复");
    timers[1].cb();
    assert.equal(el.children.length, 80);
    assert.match(el.inserts[0], /line-199/);
    assert.doesNotMatch(el.inserts[0], /line-119</, "待显示缓冲也只保留最新 80 条");
  });
});

test("重连快照不能替换正在阅读的日志；回到底部补拉快照", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, headers: { get: () => null }, json: async () => ({ entries: [entry(999)] }) };
  };
  try {
    const el = makeStreamEl({ scrollHeight: 2000, clientHeight: 320, scrollTop: 500, childCount: 80 });
    const oldFirst = el.firstElementChild;
    const stream = createLogStream({ streamEl: el });
    await stream.refresh();
    assert.equal(el.firstElementChild, oldFirst);
    assert.equal(el.seededHtml, undefined);
    el.scrollTop = 1680;
    el.listeners.scroll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.match(el.seededHtml, /line-999/);
  } finally { globalThis.fetch = realFetch; }
});

test("append 合批: 上限行数不回归 —— 已满容器追加后仍裁剪到 maxLines", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100, childCount: 79 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    stream.append(entry(1));
    stream.append(entry(2));
    stream.append(entry(3));
    timers[0].cb();
    assert.equal(el.children.length, 80, "79 + 3 → 裁到 80");
  });
});

test("append 合批: 突发超过 maxLines 时缓冲封顶,只插入尾部 maxLines 行", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    for (let i = 0; i < 130; i++) stream.append(entry(i));
    assert.equal(timers.length, 1, "突发期间也只保持一个定时器");
    timers[0].cb();
    assert.equal(el.inserts.length, 1);
    assert.equal(countRows(el.inserts[0]), 80, "只插入最终会保留的尾部 80 行");
    assert.match(el.inserts[0], /line-129/, "保留最新一行");
    assert.ok(!el.inserts[0].includes("line-49<"), "更早的行不进 DOM");
    assert.equal(el.children.length, 80);
  });
});

test("append: 空 entry / 无容器时安全忽略", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl();
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    stream.append(null);
    stream.append(undefined);
    assert.equal(timers.length, 0, "无有效 entry 不调度 flush");

    const noEl = createLogStream({ streamEl: null, maxLines: 80 });
    noEl.append(entry(1)); // 不抛异常
    assert.equal(timers.length, 0);
  });
});

// ---- 日期分隔行 ----

const dayTs = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();
const dayEntry = (day, hour, msg) => ({ ts: dayTs(day, hour), source: "ops", level: "info", message: msg });

test("日期分隔: 合批跨天批次在同一次插入中带分隔行,流起点不加前导分隔", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    stream.append(dayEntry(26, 23, "before-midnight"));
    stream.append(dayEntry(27, 0, "after-midnight"));
    timers[0].cb();
    assert.equal(el.inserts.length, 1, "跨天批次仍是一次 insertAdjacentHTML");
    const html = el.inserts[0];
    assert.equal(html.split("log-date-sep").length - 1, 1, "只在跨天处插一条分隔行");
    assert.match(html, /8月27日/);
    assert.doesNotMatch(html, /8月26日/, "流起点(空 DOM)不加前导分隔");
    assert.ok(html.indexOf("log-date-sep") > html.indexOf("before-midnight"), "分隔行位于跨天点之后首行之前");
    assert.ok(html.indexOf("log-date-sep") < html.indexOf("after-midnight"));
    assert.equal(countRows(html), 3, "2 行日志 + 1 分隔行");
  });
});

test("日期分隔: refresh seed 内跨天插分隔,后续合批延续 DOM 尾部日期上下文", async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ entries: [dayEntry(26, 23, "seed-26"), dayEntry(27, 1, "seed-27")] }),
  });
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  try {
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    await stream.refresh();
    assert.equal(el.seededHtml.split("log-date-sep").length - 1, 1, "seed 快照内跨天处插分隔行");
    assert.match(el.seededHtml, /8月27日/);
    assert.equal(el.children.length, 3, "2 行日志 + 1 分隔行");

    stream.append(dayEntry(27, 2, "same-day"));
    timers[0].cb();
    assert.doesNotMatch(el.inserts[0], /log-date-sep/, "与 seed 尾部同日:不重复插分隔");

    stream.append(dayEntry(28, 0, "next-day"));
    timers[1].cb();
    assert.match(el.inserts[1], /log-date-sep/);
    assert.match(el.inserts[1], /8月28日/, "跨天上下文跨越 seed 与合批边界正确延续");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test("trimToMax: 分隔行不计入 maxLines,裁剪后孤儿分隔行连带清理", () => {
  // [sep26] L1 L2 [sep27] L3 L4,maxLines=2 → 裁掉 L1/L2 后 sep26 已无所属行,连带清理
  const el = makeSepAwareEl(["sep", "L1", "L2", "sep", "L3", "L4"]);
  trimToMax(el, 2);
  assert.deepEqual(el.children.map((c) => c.label), ["sep", "L3", "L4"]);
});

test("trimToMax: 头部分隔行仍有所属行时保留(日期上下文不丢)", () => {
  const el = makeSepAwareEl(["sep", "L1", "L2", "L3"]);
  trimToMax(el, 2);
  assert.deepEqual(el.children.map((c) => c.label), ["sep", "L2", "L3"], "分隔行不占名额且保留");
});

test("trimToMax: 尾部无后续内容的分隔行清理", () => {
  const el = makeSepAwareEl(["L1", "sep"]);
  trimToMax(el, 5);
  assert.deepEqual(el.children.map((c) => c.label), ["L1"]);
});

test("refresh: seed 覆盖后,挂起增量与快照尾部去重再追加(不丢行、不重复)", async () => {
  const realFetch = globalThis.fetch;
  const seeded = entry(10);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ entries: [entry(9), seeded] }),
  });
  try {
    await withFakeTimers(async (timers) => {
      const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
      const stream = createLogStream({ streamEl: el, maxLines: 80 });
      // 拉取前经 SSE 到达:一条与快照尾部重复,一条是快照之后的新行
      stream.append(seeded);
      stream.append(entry(11));
      await stream.refresh();
      assert.equal(el.children.length, 3, "seed 合并快照与 SSE 新行");
      assert.equal(el.seededHtml.split("line-10<").length - 1, 1, "快照与 SSE 重复行只出现一次");
      assert.match(el.seededHtml, /line-11/);
      timers[0].cb();
      assert.equal(el.inserts.length, 0, "已合并的新行不重复追加");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("HTTP 快照迟到时不能抹掉已经 flush 的 SSE；后发快照优先", async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = () => new Promise((resolve) => requests.push(resolve));
  const response = (entries) => ({ ok: true, headers: { get: () => null }, json: async () => ({ entries }) });
  try {
    await withFakeTimers(async (timers) => {
      const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
      const stream = createLogStream({ streamEl: el });
      const first = stream.refresh();
      stream.append(entry(20));
      timers[0].cb();
      assert.match(el.inserts[0], /line-20/);
      requests[0](response([entry(19)]));
      await first;
      assert.match(el.seededHtml, /line-20/);
      const older = stream.refresh();
      const newer = stream.refresh();
      requests[2](response([entry(30)]));
      await newer;
      requests[1](response([entry(21)]));
      await older;
      assert.match(el.seededHtml, /line-30/);
      assert.doesNotMatch(el.seededHtml, /line-21/);
    });
  } finally { globalThis.fetch = realFetch; }
});

test("快照已超前于部分积压行：合并按时间排序，再保留最新 maxLines 条", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ entries: [entry(10), entry(11)] }) });
  try {
    await withFakeTimers(async () => {
      const el = makeStreamEl();
      const stream = createLogStream({ streamEl: el, maxLines: 3 });
      stream.append(entry(1));
      stream.append(entry(9));
      stream.append(entry(10));
      await stream.refresh();
      assert.equal(el.children.length, 3);
      assert.doesNotMatch(el.seededHtml, /line-1</);
      assert.ok(el.seededHtml.indexOf("line-9<") < el.seededHtml.indexOf("line-10<"));
      assert.ok(el.seededHtml.indexOf("line-10<") < el.seededHtml.indexOf("line-11<"));
    });
  } finally { globalThis.fetch = realFetch; }
});

// ---- 等待第一条日志（空状态） ----

test("空状态: 空容器建流时放「等待第一条日志」；已有内容不覆盖", () => {
  const el = makeStreamEl();
  createLogStream({ streamEl: el, maxLines: 80 });
  assert.equal(el.seededHtml, LOG_STREAM_WAITING_HTML);
  assert.match(LOG_STREAM_WAITING_HTML, /data-tone="wait"/);
  assert.match(LOG_STREAM_WAITING_HTML, /<p class="empty-state-title">等待第一条日志<\/p>/);
  assert.doesNotMatch(LOG_STREAM_WAITING_HTML, /每轮/, "日志只记变化，不是每轮检查都写一行");
  const busy = makeStreamEl({ childCount: 3 });
  createLogStream({ streamEl: busy, maxLines: 80 });
  assert.equal(busy.seededHtml, undefined);
});

test("空状态: 第一批行到达时先拿掉占位，再追加（占位不算日志行）", () => {
  withFakeTimers((timers) => {
    const el = makeStreamEl({ scrollHeight: 100, clientHeight: 100 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    const placeholder = { classList: { contains: (c) => c === "empty-state" } };
    el.children = [placeholder];
    stream.append(entry(1));
    timers[0].cb();
    assert.ok(!el.children.includes(placeholder), "占位被移除");
    assert.equal(el.children.length, 1);
    assert.match(el.inserts[0], /line-1/);
    // 之后的批次不再动第一行
    stream.append(entry(2));
    timers[1].cb();
    assert.equal(el.children.length, 2);
  });
});

test("空状态: seed 拉回空列表时显示等待占位（取代旧的「暂无日志」）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries: [] }) });
  try {
    const el = makeStreamEl({ childCount: 2 });
    const stream = createLogStream({ streamEl: el, maxLines: 80 });
    await stream.refresh();
    assert.equal(el.seededHtml, LOG_STREAM_WAITING_HTML);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamLevel: 状态变更按变到了什么算（恢复不标红），其余看 level 与文案", () => {
  assert.equal(streamLevel({ message: "channel: error -> ok reason=通道全链路正常" }), "ok");
  assert.equal(streamLevel({ message: "res:validation:server-01: skipped -> warn reason=x" }), "warn", "键里带冒号也认得出");
  assert.equal(streamLevel({ message: "agent:codex: ok -> error" }), "error");
  assert.equal(streamLevel({ message: "agent:codex: ok -> skipped" }), "info");
  assert.equal(streamLevel({ message: "egress health: warn (target-failures)", level: "warn" }), "warn");
  assert.equal(streamLevel({ message: "scoped-restart server-01: failed" }), "error");
  assert.equal(streamLevel({ message: "egress health: ok" }), "info");
});

test("buildStreamLineHtml: 时刻 · 来源标签 · 正文三栏；变更拆成键与前后状态，reason 另起弱化，长 UUID 缩短", () => {
  const ts = Date.UTC(2026, 9, 2, 1, 21, 45);
  const transition = buildStreamLineHtml({ ts, source: "timeline", message: "res:server-01: error -> ok reason=负载已更新" });
  assert.match(transition, /^<span class="log-line ls-row" data-level="ok" title="res:server-01: error -&gt; ok reason=负载已更新">/);
  assert.match(transition, /<span class="ls-src" data-src="timeline" title="timeline">状态<\/span>/);
  assert.match(transition, /<span class="ls-key">res:server-01<\/span><span class="ls-state" data-level="error">error<\/span><span class="ls-arrow">→<\/span><span class="ls-state" data-level="ok">ok<\/span>/);
  assert.match(transition, /<span class="ls-reason">负载已更新<\/span>/);

  const op = buildStreamLineHtml({ ts, source: "ops", message: "operation 2695a3b2-60e5-43a2-b97e-d22947f55231 phase=executing", trigger: "auto" });
  assert.match(op, /<span class="ls-id" title="2695a3b2-60e5-43a2-b97e-d22947f55231">2695a3b2<\/span>/);
  assert.match(op, /<span class="ls-kv"><i>phase=<\/i>executing<\/span>/);
  assert.match(op, /class="auto-badge"/);
  assert.doesNotMatch(op, /ls-kv"><i>class=/, "键值标注不会误配到生成的标签属性上");

  const extra = buildStreamLineHtml({ ts, source: "custom", message: "自动修复 <x>", reason: "已持续 40s" });
  assert.match(extra, /data-src="custom"[^>]*>custom</, "没有中文名的来源原样显示");
  assert.match(extra, /自动修复 &lt;x&gt;/);
  assert.match(extra, /<span class="ls-reason">已持续 40s<\/span>/);
});
