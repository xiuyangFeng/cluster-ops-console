import { test } from "node:test";
import assert from "node:assert/strict";

import { inEveryTimeZone } from "../../../lib/test-timezones.mjs";
import { createElementLookup, copyText, setAttr, setText } from "./dom-utils.js";
import { formatBytePair, formatBytes, formatClock, formatGb } from "./store.js";
import { ALERT_THRESHOLDS, RESOURCE_THRESHOLDS, clampPct, colorFor, finite, levelFor, worstLevel } from "./thresholds.js";

test("formatClock 固定 24 小时快路径：午夜、非法日期和时区切换", async () => {
  await inEveryTimeZone((tz) => {
    for (const ts of [new Date(2026, 9, 18, 0, 0, 1).getTime(), 1792224000000, 1793512800000]) {
      const expected = new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
      assert.equal(formatClock(ts, { locale: "zh-CN", hour12: false }), expected, tz);
    }
    assert.equal(formatClock(Infinity), "—");
    assert.equal(formatClock(1e20, { fallback: "--" }), "--");
    assert.equal(formatClock(1e20, { locale: "zh-CN", hour12: false }), "—");
  });
});

test("createElementLookup: 无 document 返回 null；有则缓存，断开后重查", () => {
  assert.equal(createElementLookup(null)("x"), null);
  let calls = 0;
  const el = { isConnected: true };
  const doc = { getElementById: (id) => { calls += 1; return id === "x" ? el : null; } };
  const getEl = createElementLookup(doc);
  assert.equal(getEl("x"), el);
  assert.equal(getEl("x"), el);
  assert.equal(calls, 1, "命中缓存不再查询");
  el.isConnected = false;
  getEl("x");
  assert.equal(calls, 2, "节点断开后重新查询");
  assert.equal(getEl("missing"), null);
});

test("createElementLookup: 不传 doc 时按调用时刻解析全局 document；换 document 后缓存作废", (t) => {
  const had = Object.hasOwn(globalThis, "document");
  const saved = globalThis.document;
  t.after(() => {
    if (had) globalThis.document = saved;
    else delete globalThis.document;
  });
  delete globalThis.document;
  const getEl = createElementLookup(); // 模块顶层建 lookup 时通常还没有 document
  assert.equal(getEl("x"), null);
  const a = { isConnected: true };
  globalThis.document = { getElementById: () => a };
  assert.equal(getEl("x"), a, "document 后挂上也能查到");
  const b = { isConnected: true };
  globalThis.document = { getElementById: () => b };
  assert.equal(getEl("x"), b, "不返回旧 document 的缓存节点");
});

test("copyText: 剪贴板成功返回 true；失败走 prompt 兜底返回 false", async () => {
  const saved = { navigator: globalThis.navigator, window: globalThis.window };
  const prompts = [];
  try {
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true });
    globalThis.window = { prompt: (msg, text) => prompts.push([msg, text]) };
    assert.equal(await copyText("a"), true);
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, configurable: true });
    assert.equal(await copyText("b", { fallbackMessage: "手动复制" }), false);
    assert.deepEqual(prompts, [["手动复制", "b"]]);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true });
    globalThis.window = saved.window;
  }
});

test("formatBytes / formatClock: 1024 进制、整数去小数、非法值为 —", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1536 * 1024 * 1024), "1.5 GiB");
  assert.equal(formatBytes(1.8 * 1024 ** 4), "1.8 TiB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes("x"), "—");
  assert.equal(formatClock(null), "—");
  assert.equal(formatClock("abc"), "—");
  assert.match(formatClock(Date.UTC(2026, 0, 1, 12, 0, 0)), /\d/);
});

test("formatBytes(compact/maxUnit) / formatBytePair / formatGb: 资源面板与集群面板共用一套字节格式", () => {
  const GiB = 1024 ** 3;
  assert.equal(formatBytes(152.8 * GiB), "152.8 GiB");
  assert.equal(formatBytes(152.8 * GiB, { compact: true }), "153 GiB", "compact：≥100 取整");
  assert.equal(formatBytes(1536 * GiB, { compact: true }), "1.5 TiB");
  assert.equal(formatBytes(1536 * GiB, { compact: true, maxUnit: "GiB" }), "1536 GiB", "maxUnit 封顶，不进位");
  assert.equal(formatBytePair(98.2 * GiB, 251 * GiB, { compact: true }), "98.2 / 251 GiB");
  assert.equal(formatBytePair(null, GiB), "");
  assert.equal(formatBytePair(-1, GiB), "");
  assert.equal(formatGb(24576), "24.0");
});

test("thresholds 数值小工具：finite 挡空值、clampPct 夹到 0–100、worstLevel 取最严重", () => {
  assert.equal(finite(null), null);
  assert.equal(finite(""), null);
  assert.equal(finite(true), null);
  assert.equal(finite("12.5"), 12.5);
  assert.equal(finite(Number.NaN), null);
  assert.equal(clampPct(-3), 0);
  assert.equal(clampPct(140), 100);
  assert.equal(clampPct("x"), 0);
  assert.equal(worstLevel("ok", "critical", "warn"), "critical");
  assert.equal(worstLevel("unknown", "ok"), "ok");
  assert.equal(worstLevel(), "unknown");
});

test("setText / setAttr: 值没变不写，元素缺失安全忽略", () => {
  let writes = 0;
  const el = {
    _text: "a",
    get textContent() { return this._text; },
    set textContent(v) { writes += 1; this._text = v; },
    attrs: { title: "t" },
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, v) { writes += 1; this.attrs[name] = v; },
  };
  setText(el, "a");
  setAttr(el, "title", "t");
  assert.equal(writes, 0);
  setText(el, "b");
  setAttr(el, "title", "u");
  assert.equal(writes, 2);
  assert.doesNotThrow(() => { setText(null, "x"); setAttr(null, "a", "b"); });
});

test("formatClock: 默认同 toLocaleTimeString()；可固定 24 小时制、可换兜底文案", () => {
  const ts = new Date(2026, 0, 1, 21, 5, 7).getTime();
  assert.equal(formatClock(ts), new Date(ts).toLocaleTimeString());
  assert.equal(formatClock(ts, { locale: "zh-CN", hour12: false }), "21:05:07");
  assert.equal(formatClock(undefined, { fallback: "--:--:--" }), "--:--:--");
});

test("thresholds: 分档边界与颜色映射", () => {
  assert.equal(levelFor("cpu", RESOURCE_THRESHOLDS.cpu.warn - 1), "ok");
  assert.equal(levelFor("cpu", RESOURCE_THRESHOLDS.cpu.warn), "warn");
  assert.equal(levelFor("cpu", RESOURCE_THRESHOLDS.cpu.critical), "critical");
  assert.equal(levelFor("disk", 95), "critical");
  assert.equal(levelFor("memory", null), "unknown");
  assert.equal(levelFor("nope", 50), "unknown");
  assert.equal(colorFor("ok"), "green");
  assert.equal(colorFor("warn"), "yellow");
  assert.equal(colorFor("critical"), "red");
  assert.equal(colorFor("unknown"), "gray");
});

test("ALERT_THRESHOLDS: 注意力队列告警门槛（高于配色红档）且不可改写", () => {
  assert.deepEqual({ ...ALERT_THRESHOLDS }, { diskWarn: 90, diskCrit: 95, ramWarn: 92, cpuWarn: 95, cpuStreakFrames: 2 });
  assert.ok(Object.isFrozen(ALERT_THRESHOLDS));
  assert.ok(ALERT_THRESHOLDS.diskCrit > RESOURCE_THRESHOLDS.disk.critical);
});
