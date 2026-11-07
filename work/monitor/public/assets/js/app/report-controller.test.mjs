import assert from "node:assert/strict";
import test from "node:test";
import { createReportController, finalizeReportDraft, REPORT_NOTES_HEADING } from "./report-controller.js";
import { fakeDocument, fakeElement, fakeDialog } from "./test-support.mjs";

const IDS = ["reportIncludeScript", "reportScriptOption", "reportPreview", "reportMeta", "reportCopyBtn", "reportDownloadBtn", "reportRefreshBtn", "reportHideBtn", "reportRestoreBtn", "reportDirty"];

function fixture(getJson, { confirm = () => true, execCommand } = {}) {
  const elements = Object.fromEntries(IDS.map((id) => [id, fakeElement()]));
  elements.reportPreview.setSelectionRange = (start, end) => { elements.reportPreview.selectionStart = start; elements.reportPreview.selectionEnd = end; };
  elements.reportDialog = fakeDialog();
  const doc = fakeDocument(elements);
  doc.addEventListener = () => {};
  if (execCommand) doc.execCommand = execCommand;
  const copied = [], downloads = [], confirms = [];
  const anchor = { click() { downloads.push(this); } };
  doc.createElement = () => anchor;
  const controller = createReportController({ doc, getJson, copy: async (text) => copied.push(text),
    confirm: (message) => { confirms.push(message); return confirm(message); },
    urlApi: { createObjectURL: (blob) => { anchor.blob = blob; return "blob:x"; }, revokeObjectURL() {} },
    BlobImpl: class { constructor(parts) { this.text = parts.join(""); } } });
  controller.bind();
  return { elements, controller, copied, downloads, anchor, confirms };
}

// 模拟用户在预览框里编辑：改值并触发 input。
const edit = (h, value) => { h.elements.reportPreview.value = value; return h.elements.reportPreview.dispatch("input"); };

test("旧请求晚到不会覆盖新目标；内容纯文本预览；复制的是当前脱敏报告", async () => {
  let resolveOld;
  const { controller, elements, copied } = fixture((url) => url.includes("jobId=1&") || url.endsWith("jobId=1")
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve({ markdown: "new <script>text</script>", filename: "job.md", redactions: 2 }));
  const old = controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  await controller.open({ kind: "job", serverId: "s2", jobId: "2" });
  resolveOld({ markdown: "old", filename: "old.md" });
  await old;
  assert.ok(elements.reportPreview.value.startsWith("new <script>text</script>\n"));
  assert.equal(elements.reportPreview.innerHTML, "");
  await controller.copyReport();
  assert.deepEqual(copied, ["new <script>text</script>\n"], "未编辑、现场说明留空时导出即生成稿");
  assert.equal(elements.reportCopyBtn.disabled, false);
});

test("失败不允许复制旧报告；脚本明确勾选后才请求；关闭后迟到结果丢弃", async () => {
  const urls = [];
  let fail = false;
  const { controller, elements } = fixture(async (url) => { urls.push(url); if (fail) throw new Error("unavailable"); return { markdown: "report", filename: "report.md" }; });
  await controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  assert.ok(!urls[0].includes("includeScript"));
  elements.reportIncludeScript.checked = true;
  await elements.reportIncludeScript.dispatch("change");
  assert.match(urls[1], /includeScript=1/);
  fail = true;
  await controller.load();
  assert.equal(elements.reportCopyBtn.disabled, true);
  assert.match(elements.reportPreview.value, /unavailable/);
});

test("关闭弹窗使当前请求和按钮失效，迟到数据不恢复复制状态", async () => {
  let resolve;
  const h = fixture(() => new Promise((done) => { resolve = done; }));
  const opening = h.controller.open({ kind: "job", serverId: "s1", jobId: "8" });
  await h.elements.reportDialog.dispatch("close");
  resolve({ markdown: "late report", filename: "late.md" });
  await opening;
  assert.equal(h.elements.reportCopyBtn.disabled, true);
  assert.notEqual(h.elements.reportPreview.value, "late report");
  await h.controller.copyReport();
  assert.equal(h.copied.length, 0);
  await h.controller.load();
  assert.equal(h.elements.reportCopyBtn.disabled, true);
});

test("报告点击只使用按钮绑定的服务器，缺少服务器时拒绝，不回落变化中的全局选择", async () => {
  const elements = Object.fromEntries(IDS.map((id) => [id, fakeElement()]));
  elements.reportDialog = fakeDialog();
  const doc = fakeDocument(elements);
  let click;
  doc.addEventListener = (_name, callback) => { click = callback; };
  const urls = [], toasts = [];
  const controller = createReportController({ doc, getStatus: () => ({ activeServerId: "wrong-server" }),
    getJson: async (url) => { urls.push(url); return { markdown: "report" }; }, toast: (value) => toasts.push(value) });
  controller.bind();
  const target = (dataset) => ({ target: { closest: () => ({ dataset }) } });
  click(target({ jobReport: "1", reportServer: "s1" }));
  await Promise.resolve();
  assert.match(urls[0], /serverId=s1/);
  click(target({ jobReport: "1" }));
  assert.equal(urls.length, 1);
  assert.match(toasts[0].message, /缺少服务器/);
});

test("草稿与生成稿分离：编辑只改草稿，复制和下载都取草稿，现场说明单列且标注人工删改", async () => {
  const generated = "# 作业排障报告\n\n证据 token=[凭据已隐藏] 节点 gpu07\n";
  const h = fixture(async () => ({ markdown: generated, filename: "job-1-report.md", redactions: 1 }));
  await h.controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  assert.equal(h.elements.reportPreview.readOnly, false);
  assert.ok(h.elements.reportPreview.value.endsWith(`${REPORT_NOTES_HEADING}\n\n`), "草稿末尾预留现场说明小节");
  assert.equal(h.elements.reportDirty.hidden, true);
  assert.equal(h.elements.reportRestoreBtn.disabled, true);

  await edit(h, `${h.elements.reportPreview.value.replace(" 节点 gpu07", "")}重启节点后复现。`);
  assert.equal(h.elements.reportDirty.hidden, false, "有修改时显示「已修改」");
  assert.equal(h.elements.reportRestoreBtn.disabled, false);

  await h.controller.copyReport();
  h.controller.download();
  const expected = "# 作业排障报告\n\n证据 token=[凭据已隐藏]\n\n> 以上采集内容在导出前经人工删改；「[已隐藏]」为手动隐藏。\n\n"
    + `${REPORT_NOTES_HEADING}\n\n重启节点后复现。\n`;
  assert.deepEqual(h.copied, [expected]);
  assert.equal(h.anchor.blob.text, expected, "下载与复制使用同一份草稿");
  assert.equal(h.anchor.download, "job-1-report.md");
  assert.equal(generated, "# 作业排障报告\n\n证据 token=[凭据已隐藏] 节点 gpu07\n", "生成稿不被改写");

  // 恢复生成稿要确认；取消则草稿不动，确认后回到初值。
  const kept = h.elements.reportPreview.value;
  const cancel = fixture(async () => ({ markdown: generated, filename: "a.md" }), { confirm: () => false });
  await cancel.controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  await edit(cancel, "改过");
  await cancel.controller.restore();
  assert.equal(cancel.elements.reportPreview.value, "改过");
  assert.equal(cancel.confirms.length, 1);
  await h.controller.restore();
  assert.notEqual(h.elements.reportPreview.value, kept);
  assert.equal(h.elements.reportDirty.hidden, true);
  await h.controller.copyReport();
  assert.equal(h.copied[1], generated, "恢复后导出回到生成稿");
});

test("现场说明留空省略；删掉小节标题时整段按采集内容处理并标注删改", () => {
  const generated = "# 报告\n\n证据\n";
  assert.equal(finalizeReportDraft(`# 报告\n\n证据\n\n${REPORT_NOTES_HEADING}\n\n  \n`, generated), generated);
  assert.match(finalizeReportDraft("# 报告\n\n证据\n补一句", generated), /补一句\n\n> 以上采集内容在导出前经人工删改/);
});

test("重新生成、切换目标、关闭在有未导出修改时都先确认，取消不覆盖草稿", async () => {
  let answer = false;
  let n = 0;
  const h = fixture(async () => ({ markdown: `报告 ${++n}`, filename: "r.md" }), { confirm: () => answer });
  await h.controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  await edit(h, "我的修改");

  assert.equal(await h.controller.load(), false);
  assert.equal(h.elements.reportPreview.value, "我的修改", "取消重新生成不覆盖草稿");
  h.elements.reportIncludeScript.checked = true;
  await h.elements.reportIncludeScript.dispatch("change");
  assert.equal(h.elements.reportIncludeScript.checked, false, "取消时勾选状态回滚");
  await h.controller.open({ kind: "job", serverId: "s1", jobId: "2" });
  assert.equal(h.elements.reportPreview.value, "我的修改", "取消切换目标不覆盖草稿");
  assert.equal(await h.controller.requestClose(), false);
  assert.equal(h.elements.reportDialog.open, true);
  // 兜底：其它途径直接关闭（如无法取消的 Esc）时也先确认，取消则重新打开。
  h.elements.reportDialog.close();
  await Promise.resolve();
  assert.equal(h.elements.reportDialog.open, true);
  assert.equal(h.elements.reportPreview.value, "我的修改");
  const cancelEvent = await h.elements.reportDialog.dispatch("cancel");
  assert.equal(cancelEvent.defaultPrevented, true, "Esc 被拦下");
  assert.equal(h.confirms.length, 6);
  assert.equal(n, 1, "取消期间没有发起新的生成请求");

  // 导出过当前草稿后不再追问；再改动则重新需要确认。
  await h.controller.copyReport();
  assert.equal(await h.controller.load(), true);
  assert.equal(h.confirms.length, 6);
  assert.match(h.elements.reportPreview.value, /^报告 2/);
  await edit(h, "又改了");
  answer = true;
  assert.equal(await h.controller.load(), true);
  assert.equal(h.confirms.length, 7);
  assert.match(h.elements.reportPreview.value, /^报告 3/);
});

test("隐藏所选：替换为 [已隐藏]；优先原生编辑命令，回退时 Cmd/Ctrl+Z 仍可撤回", async () => {
  const generated = "密码 hunter2 结束\n";
  // 回退路径：环境没有 execCommand。
  const h = fixture(async () => ({ markdown: generated, filename: "r.md" }));
  await h.controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  const box = h.elements.reportPreview;
  box.selectionStart = box.selectionEnd = 2;
  h.controller.hideSelection();
  assert.ok(box.value.startsWith("密码 hunter2"), "未选中时不改动");
  box.selectionStart = 3; box.selectionEnd = 10;
  h.controller.hideSelection();
  assert.ok(box.value.startsWith("密码 [已隐藏] 结束\n"));
  assert.equal(h.elements.reportDirty.hidden, false);
  await h.controller.copyReport();
  assert.match(h.copied[0], /^密码 \[已隐藏\] 结束\n/);
  assert.ok(!h.copied[0].includes("hunter2"));
  const undo = await box.dispatch("keydown", { key: "z", metaKey: true });
  assert.equal(undo.defaultPrevented, true);
  assert.ok(box.value.startsWith("密码 hunter2 结束"), "回退替换可以撤回");
  assert.equal(h.elements.reportDirty.hidden, true);
  const again = await box.dispatch("keydown", { key: "z", ctrlKey: true });
  assert.equal(again.defaultPrevented, false, "快照用完后交还原生撤销");

  // 原生路径：execCommand 成功时不接管撤销。
  const commands = [];
  const n = fixture(async () => ({ markdown: generated, filename: "r.md" }), { execCommand(name, _ui, text) {
    commands.push([name, text]);
    const el = n.elements.reportPreview;
    el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
    return true;
  } });
  await n.controller.open({ kind: "job", serverId: "s1", jobId: "1" });
  n.elements.reportPreview.selectionStart = 3; n.elements.reportPreview.selectionEnd = 10;
  n.controller.hideSelection();
  assert.deepEqual(commands, [["insertText", "[已隐藏]"]]);
  assert.ok(n.elements.reportPreview.value.startsWith("密码 [已隐藏] 结束"));
  assert.equal((await n.elements.reportPreview.dispatch("keydown", { key: "z", metaKey: true })).defaultPrevented, false);
});
