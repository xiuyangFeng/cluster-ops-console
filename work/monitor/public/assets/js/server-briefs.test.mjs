import assert from "node:assert/strict";
import test from "node:test";
import { briefMetricRowHtml, renderServerBriefs, serverBriefsEmptyHtml } from "./render/overview.js";
import { RESOURCE_THRESHOLDS } from "./thresholds.js";

function domHarness(t) {
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.parentNode = null; this.className = ""; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    insertBefore(child, anchor) {
      child.remove();
      const index = anchor ? this.children.indexOf(anchor) : this.children.length;
      this.children.splice(index, 0, child); child.parentNode = this;
    }
    appendChild(child) { this.insertBefore(child, null); }
    querySelector(selector) { return this.children.find(child => child.className.split(" ").includes(selector.slice(1))); }
  }
  const container = new Element();
  const oldDocument = globalThis.document;
  globalThis.document = { getElementById: () => container, createElement: () => new Element() };
  t.after(() => { globalThis.document = oldDocument; });
  return container;
}

test("server cards reconcile 3 → 2 → 1 → 0 → restored without leaving cards or duplicate empty states", t => {
  const container = domHarness(t);
  const briefs = Object.fromEntries(["one", "two", "three"].map(id => [id, { name: id, ok: true, cpu: 5, ram: 10 }]));
  renderServerBriefs(briefs, "one");
  const retained = container.children[0];
  assert.equal(container.children.length, 3);
  renderServerBriefs({ one: briefs.one, two: briefs.two }, "one");
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0], retained);
  renderServerBriefs({ one: briefs.one }, "one");
  assert.equal(container.children.length, 1);
  renderServerBriefs({}, null);
  const empty = container.children[0];
  renderServerBriefs({}, null);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], empty, "空状态节点跨刷新保留（焦点不丢）");
  assert.equal(container.children[0].className, "server-briefs-empty");
  assert.match(container.children[0].innerHTML, /<p class="empty-state-title">还没有添加服务器<\/p>/);
  assert.match(container.children[0].innerHTML, /data-dialog="dlgSettings">添加服务器<\/button>/);
  renderServerBriefs({ two: briefs.two }, "two");
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].dataset.id, "two");
  assert.match(container.children[0].className, /active/);
});

test("deleted/disabled server cannot reappear from stale status; restored server waits for its first sample", t => {
  const container = domHarness(t);
  const staleBriefs = { deleted: { name: "old" }, disabled: { name: "off" }, current: { name: "current" } };
  const config = [{ id: "current", name: "Current" }, { id: "disabled", disabled: true }, { id: "restored", name: "Restored" }];
  renderServerBriefs(staleBriefs, "current", null, config);
  assert.deepEqual(container.children.map(child => child.dataset.id), ["current", "restored"]);
  assert.match(container.children[1].innerHTML, /Restored/);
  assert.doesNotMatch(container.children[1].innerHTML, /undefined%|null%/);
  renderServerBriefs(staleBriefs, null, null, []);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].className, "server-briefs-empty");
  assert.match(container.children[0].innerHTML, /还没有添加服务器/);
  // 配置里有服务器、但全部停用 / 关了监控：不是「还没有添加」，引导去设置里启用（同一节点换文案）。
  const empty = container.children[0];
  renderServerBriefs(staleBriefs, null, null, [{ id: "disabled", disabled: true }, { id: "quiet", monitorEnabled: false }]);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], empty);
  assert.match(empty.innerHTML, /<p class="empty-state-title">没有在监控的服务器<\/p>/);
  assert.match(empty.innerHTML, /data-dialog="dlgSettings">打开设置<\/button>/);
  assert.doesNotMatch(empty.innerHTML, /还没有添加服务器/);
  // 有服务器了：空状态让位给卡片。
  renderServerBriefs({}, null, null, [{ id: "current", name: "Current" }]);
  assert.deepEqual(container.children.map(child => child.className.trim()), ["server-brief-card"]);
});

test("serverBriefsEmptyHtml: 不承诺建隧道（新服务器默认只监控），写真实采样节奏", () => {
  const html = serverBriefsEmptyHtml([]);
  assert.match(html, /data-tone="neutral"/);
  assert.match(html, /每分钟经 SSH 采一次资源/);
  assert.doesNotMatch(html, /为它建隧道/);
  assert.equal(serverBriefsEmptyHtml(null), html, "配置还没到时按「还没有添加」处理");
});

test("服务器卡指标条：配色走 thresholds.js 统一分档，条本体用 .bar-progress + scaleX（无内联颜色/宽度百分比）", () => {
  const cls = (html) => html.match(/class="bar-progress color-(\w+)"/)[1];
  const { cpu, memory } = RESOURCE_THRESHOLDS;
  assert.equal(cls(briefMetricRowHtml("CPU", "cpu", cpu.warn - 1)), "green");
  assert.equal(cls(briefMetricRowHtml("CPU", "cpu", cpu.warn)), "yellow");
  assert.equal(cls(briefMetricRowHtml("CPU", "cpu", cpu.critical)), "red");
  assert.equal(cls(briefMetricRowHtml("内存", "memory", memory.warn - 1)), "green");
  assert.equal(cls(briefMetricRowHtml("内存", "memory", memory.critical - 1)), "yellow");
  assert.equal(cls(briefMetricRowHtml("内存", "memory", memory.critical)), "red");
  const row = briefMetricRowHtml("CPU", "cpu", 42);
  assert.match(row, /style="width: 100%; transform: scaleX\(0\.42\)"/);
  assert.match(row, /<span class="brief-metric-value">42<small>%<\/small><\/span>/);
  assert.doesNotMatch(row, /background|var\(--/);
  const offline = briefMetricRowHtml("内存", "memory", null);
  assert.match(offline, /scaleX\(0\)/);
  assert.match(offline, /<span class="brief-metric-value">-<\/span>/);
  assert.doesNotMatch(offline, /null%|undefined%/);
});

test("离线服务器卡：指标条为空、数值显示 -", t => {
  const container = domHarness(t);
  renderServerBriefs({ one: { name: "one", ok: false, cpu: 90, ram: 95 } }, "one");
  const html = container.children[0].innerHTML;
  assert.equal((html.match(/scaleX\(0\)/g) || []).length, 2);
  assert.doesNotMatch(html, /90%|95%/);
});
