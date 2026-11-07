// 前端性能接线测试（opt/w3-frontend-perf）：modulepreload 与模块图一致、事件列表渲染签名、
// 日志浮层收起期不拉取/不渲染、样式层不再对健康态做滤镜动画。纯 Node，无真实 DOM。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIncidentRenderSignature } from "./render/incidents.js";
import { createLogsPanel } from "./logs-panel.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function staticModuleGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);
  return [...seen].map((f) => `/${relative(publicDir, f).split("\\").join("/")}`);
}

test("index.html: modulepreload 覆盖 app.js 的完整静态模块图，且每个 href 都真实存在", () => {
  const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const preloads = [...head.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of preloads) {
    assert.ok(existsSync(resolve(publicDir, `.${href}`)), `modulepreload 指向不存在的文件：${href}`);
  }
  const graph = staticModuleGraph(resolve(publicDir, "app.js"));
  const missing = graph.filter((m) => !preloads.includes(m));
  assert.deepEqual(missing, [], "新增静态模块后请同步 index.html 的 modulepreload 列表");
});

test("buildIncidentRenderSignature: 数据不变则签名不变；确认/lastSeen/时间桶变化才变", () => {
  const nowMs = 1_800_000_000_000;
  const payload = {
    state: "open",
    total: 1,
    incidents: [{ incidentId: "i1", lastSeenAt: nowMs - 60000, occurrences: 2, severity: "error", attention: {} }],
  };
  const base = buildIncidentRenderSignature(payload, { nowMs });
  assert.equal(buildIncidentRenderSignature(structuredClone(payload), { nowMs: nowMs + 1000 }), base);
  const acked = structuredClone(payload);
  acked.incidents[0].attention.acknowledgedAt = nowMs;
  assert.notEqual(buildIncidentRenderSignature(acked, { nowMs }), base);
  const seen = structuredClone(payload);
  seen.incidents[0].lastSeenAt = nowMs;
  assert.notEqual(buildIncidentRenderSignature(seen, { nowMs }), base);
  // 相对时间文案（"X 分钟前"）随时间桶刷新
  assert.notEqual(buildIncidentRenderSignature(payload, { nowMs: nowMs + 60000 }), base);
  // 稍后提醒到期（snoozed → 不再 snoozed）也要重渲
  const snoozed = structuredClone(payload);
  snoozed.incidents[0].attention.snoozedUntil = nowMs + 500;
  assert.notEqual(
    buildIncidentRenderSignature(snoozed, { nowMs }),
    buildIncidentRenderSignature(snoozed, { nowMs: nowMs + 1000 }),
  );
  // 畸形载荷不抛错
  for (const bad of [null, undefined, {}, { incidents: "junk" }, { incidents: [42] }]) {
    assert.equal(typeof buildIncidentRenderSignature(bad, { nowMs }), "string");
  }
});

function makeLogEl() {
  return {
    htmlSets: [],
    inserts: [],
    set innerHTML(html) { this.htmlSets.push(html); },
    get innerHTML() { return this.htmlSets[this.htmlSets.length - 1] || ""; },
    insertAdjacentHTML(position, html) { this.inserts.push({ position, html }); },
    firstElementChild: null,
    querySelector() { return null; },
    addEventListener() {},
    textContent: "",
  };
}

function stubFetch() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries: [], windows: [] }) };
  };
  return urls;
}

test("createLogsPanel: 宿主 dlgLogs 关着时 refresh 只记脏不拉取，SSE append 不渲染；强制/打开后才拉", async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const urls = stubFetch();
  try {
    const dialog = { open: false };
    const logBox = { scrollHeight: 0, clientHeight: 0, scrollTop: 0, closest: (sel) => (sel === "dialog" ? dialog : null) };
    const logEl = makeLogEl();
    const panel = createLogsPanel({ logEl, logBox });

    await panel.refresh();
    assert.equal(urls.filter((u) => u.includes("/api/logs?") || u.endsWith("/api/logs")).length, 0, "浮层关着不拉 500 条日志");
    assert.equal(panel.isDirty(), true);

    let timers = 0;
    globalThis.setTimeout = (fn, ms) => { timers += 1; return realSetTimeout(fn, ms); };
    panel.appendEntry({ ts: Date.now(), source: "ops", level: "info", message: "hidden line" });
    assert.equal(timers, 0, "浮层关着时 append 不排渲染节流");
    assert.equal(logEl.inserts.length + logEl.htmlSets.length, 0, "浮层关着时不碰 DOM");
    globalThis.setTimeout = realSetTimeout;

    dialog.open = true;
    await panel.refresh();
    assert.ok(urls.some((u) => u.includes("/api/logs")), "浮层打开后正常拉取");
    assert.equal(panel.isDirty(), false);

    dialog.open = false;
    const before = urls.length;
    await panel.openOperation("op-1");
    assert.ok(urls.length > before, "openOperation 先于 showModal 调用：必须强制拉取");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

// index.html 按 <link rel="stylesheet"> 顺序链接的样式表（styles.css + assets/css/ 下各区块文件）
function linkedStylesheets() {
  const html = readFileSync(resolve(publicDir, "index.html"), "utf8");
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
}

test("index.html: 样式表链接齐全——每个 href 都存在，assets/css 下没有未被链接的孤儿文件", () => {
  const hrefs = linkedStylesheets();
  assert.equal(hrefs[0], "/styles.css", "styles.css（令牌 / 主题 / 原语）必须最先加载，区块文件靠后加载覆写");
  for (const href of hrefs) assert.ok(existsSync(resolve(publicDir, `.${href}`)), `stylesheet 指向不存在的文件：${href}`);
  const cssDir = resolve(publicDir, "assets/css");
  const onDisk = readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => `/assets/css/${f}`);
  assert.deepEqual(onDisk.filter((f) => !hrefs.includes(f)), [], "assets/css 下新增样式文件后请在 index.html 链接");
});

test("样式层（全部链接的样式表）：健康态圆点不再对 filter 做无限动画；数据过期弱化不再用 blur 滤镜", () => {
  const css = linkedStylesheets()
    .map((href) => readFileSync(resolve(publicDir, `.${href}`), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /\.brief-dot\.online\s*\{[^}]*animation/, "健康态圆点应静止");
  // 逐个取出 @keyframes 块（花括号配对），块内不得出现 filter。
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    assert.doesNotMatch(css.slice(m.index, i), /filter\s*:/, `@keyframes ${m[1]} 不应动画 filter`);
  }
  const stale = css.match(/body\.data-stale \.panel\s*\{([^}]*)\}/);
  assert.ok(stale, "data-stale 规则存在");
  assert.doesNotMatch(stale[1], /filter/);
  // 吸顶 / 固定的外壳元素：backdrop-filter 会让每次滚动都重算背后区域的模糊，一律用实心底色。
  for (const name of ["pagebar", "sidebar"]) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `.${name} 规则存在`);
    assert.doesNotMatch(rule[1], /backdrop-filter/, `.${name} 不用 backdrop-filter`);
  }
});

test("活链路动效只动 transform / opacity（合成线程完成，不触发重排重绘）", () => {
  const css = readFileSync(resolve(publicDir, "assets/css/overview.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = ["roadRun", "roadFanY", "roadFanX", "roadBreathe", "roadRipple", "roadPulse", "roadStep"];
  for (const name of names) {
    const m = css.match(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    assert.ok(m, `@keyframes ${name} 存在`);
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    const props = [...css.slice(m.index + m[0].length, i).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
    assert.ok(props.length > 0);
    assert.deepEqual(props.filter((p) => p !== "transform" && p !== "opacity"), [], `@keyframes ${name} 只允许 transform/opacity`);
  }
  // 无限动画必须包在 reduced-motion 守卫里
  const guard = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(guard >= 0);
  for (const name of names) {
    const use = css.indexOf(`animation: ${name} `);
    assert.ok(use > guard, `${name} 的使用处应在 reduced-motion 守卫内`);
  }
});
