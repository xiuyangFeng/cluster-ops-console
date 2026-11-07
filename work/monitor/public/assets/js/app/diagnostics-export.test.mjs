import assert from "node:assert/strict";
import test from "node:test";

import { buildDiagnosticsExportHtml, createDiagnosticsExport, DIAGNOSTICS_EXPORT_CONTENTS, DIAGNOSTICS_EXPORT_PRIVACY, describeExportResult } from "./diagnostics-export.js";

function makeDoc() {
  const listeners = {};
  const elements = {
    diagExportPanel: { hidden: true, innerHTML: "", addEventListener: (name, fn) => { listeners[`panel:${name}`] = fn; } },
    diagExportOpenBtn: { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener: (name, fn) => { listeners[`open:${name}`] = fn; } },
  };
  const anchors = [];
  const doc = {
    getElementById: (id) => elements[id] || null,
    createElement: () => {
      const anchor = { clicked: false, click() { this.clicked = true; } };
      anchors.push(anchor);
      return anchor;
    },
  };
  const clickButton = (id, disabled = false) => listeners["panel:click"]({ target: { closest: () => ({ id, disabled }) } });
  return { doc, elements, listeners, anchors, clickButton };
}

const BUNDLE = { filename: "cluster-workbench-diagnostics-20261014-020509.json", bundle: { schema: "cluster-workbench-diagnostics", app: { version: "2.64.0" } }, bytes: 2048, redactions: 5 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("展开的说明：列出包里的每一项与隐藏规则；桌面壳 / 网页模式各自说清怎么落地；忙时按钮禁用", () => {
  const html = buildDiagnosticsExportHtml({});
  for (const item of DIAGNOSTICS_EXPORT_CONTENTS) assert.ok(html.includes(item), item);
  assert.ok(html.includes(DIAGNOSTICS_EXPORT_PRIVACY));
  assert.match(html, /由浏览器下载/);
  assert.match(buildDiagnosticsExportHtml({ desktop: true }), /保存到你选的位置/);
  assert.match(html, /不会自动上传/);
  const busy = buildDiagnosticsExportHtml({ busy: true, status: "<b>x</b>" });
  assert.match(busy, /id="diagExportConfirmBtn" disabled>正在整理…/);
  assert.match(busy, /&lt;b&gt;x&lt;\/b&gt;/, "状态文字转义");
});

test("describeExportResult：大小、隐藏处数与保存位置；取消说清楚", () => {
  assert.equal(describeExportResult({ bytes: 2048, redactions: 5, path: "/Users/a/Downloads/d.json" }), "已导出（2 KiB，隐藏了 5 处敏感信息）：/Users/a/Downloads/d.json");
  assert.equal(describeExportResult({ bytes: 2048, redactions: 0 }), "已导出（2 KiB）。");
  assert.equal(describeExportResult({ saved: false }), "已取消，没有保存。");
});

test("网页模式：点「导出诊断包…」就地展开，确认后取包、按服务端给的文件名由浏览器下载，再点收起", async () => {
  const d = makeDoc();
  const requests = [];
  const toasts = [];
  const blobs = [];
  const revoked = [];
  const ui = createDiagnosticsExport({
    doc: d.doc,
    getJson: async (path, options) => { requests.push([path, options]); return BUNDLE; },
    showToast: (t) => toasts.push(t),
    electronAPI: null,
    urlApi: { createObjectURL: (blob) => { blobs.push(blob); return "blob:1"; }, revokeObjectURL: (url) => revoked.push(url) },
    BlobImpl: class { constructor(parts, options) { this.text = parts.join(""); this.type = options.type; } },
    setTimeoutFn: (fn) => fn(),
  });
  ui.bind();
  d.listeners["open:click"]();
  assert.equal(d.elements.diagExportPanel.hidden, false);
  assert.equal(d.elements.diagExportOpenBtn.attrs["aria-expanded"], "true");
  assert.equal(requests.length, 0, "展开只是说明，不取数据");
  d.clickButton("diagExportConfirmBtn");
  await flush();
  assert.deepEqual(requests, [["/api/diagnostics/bundle", { timeoutMs: 60000 }]]);
  assert.equal(d.anchors.length, 1);
  assert.equal(d.anchors[0].download, BUNDLE.filename);
  assert.equal(d.anchors[0].clicked, true);
  assert.deepEqual(JSON.parse(blobs[0].text), BUNDLE.bundle, "文件内容就是诊断包本身");
  assert.equal(blobs[0].type, "application/json;charset=utf-8");
  assert.deepEqual(revoked, ["blob:1"]);
  const fileBytes = Buffer.byteLength(blobs[0].text);
  assert.ok(d.elements.diagExportPanel.innerHTML.includes(`已导出（${fileBytes} B，隐藏了 5 处敏感信息）`), "显示的是落盘文件的大小");
  assert.equal(toasts.at(-1).type, "success");
  d.clickButton("diagExportCancelBtn");
  assert.equal(d.elements.diagExportPanel.hidden, true);
  assert.equal(d.elements.diagExportOpenBtn.attrs["aria-expanded"], "false");
});

test("桌面壳：交给保存对话框；取消不提示成功", async () => {
  const d = makeDoc();
  const saves = [];
  let answer = { saved: true, path: "/Users/a/Downloads/x.json" };
  const toasts = [];
  const ui = createDiagnosticsExport({
    doc: d.doc,
    getJson: async () => BUNDLE,
    showToast: (t) => toasts.push(t),
    electronAPI: { saveDiagnosticsBundle: async (payload) => { saves.push(payload); return answer; } },
  });
  ui.bind();
  ui.setOpen(true);
  assert.match(d.elements.diagExportPanel.innerHTML, /保存到你选的位置/);
  await ui.exportNow();
  assert.equal(saves[0].filename, BUNDLE.filename);
  assert.deepEqual(JSON.parse(saves[0].text), BUNDLE.bundle);
  assert.match(d.elements.diagExportPanel.innerHTML, /：\/Users\/a\/Downloads\/x\.json/);
  assert.equal(toasts.length, 1);
  answer = { saved: false, canceled: true };
  await ui.exportNow();
  assert.match(d.elements.diagExportPanel.innerHTML, /已取消，没有保存/);
  assert.equal(toasts.length, 1);
  assert.equal(d.anchors.length, 0, "桌面壳不走浏览器下载");
});

test("取包失败：说明原因，按钮恢复可点；重复点击在忙时不重入", async () => {
  const d = makeDoc();
  let calls = 0;
  let release;
  const ui = createDiagnosticsExport({
    doc: d.doc,
    getJson: () => { calls += 1; return new Promise((_, reject) => { release = () => reject(Object.assign(new Error("HTTP 500"), { serverMessage: "disk" })); }); },
    showToast: () => {},
  });
  ui.bind();
  ui.setOpen(true);
  const first = ui.exportNow();
  ui.exportNow();
  d.clickButton("diagExportConfirmBtn", true);
  assert.equal(calls, 1);
  assert.match(d.elements.diagExportPanel.innerHTML, /disabled>正在整理…/);
  release();
  await first;
  assert.match(d.elements.diagExportPanel.innerHTML, /导出失败：disk/);
  assert.doesNotMatch(d.elements.diagExportPanel.innerHTML, /disabled/);
});
