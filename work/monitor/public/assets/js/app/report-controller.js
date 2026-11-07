// 报告只在用户点击时生成；纯文本预览与手动复制/下载，不向任何外部应用发送。
// 生成稿（result.markdown，服务端脱敏后的原始证据）只读保存、从不改写；
// 用户在预览框里编辑的是另一份草稿，两个出口（复制/下载）都取草稿。
import { copyText } from "../dom-utils.js";

export const REPORT_MASK = "[已隐藏]";
export const REPORT_NOTES_HEADING = "## 现场说明（用户补充，非采集证据）";
const EDITED_NOTE = `> 以上采集内容在导出前经人工删改；「${REPORT_MASK}」为手动隐藏。`;
const UNDO_LIMIT = 20;

// 草稿初值：生成稿末尾预留「现场说明」空小节，用户补充的话写在这里，与采集证据分开。
export const draftFromGenerated = (markdown) => `${markdown.trimEnd()}\n\n${REPORT_NOTES_HEADING}\n\n`;

// 导出文本：现场说明留空则省略该小节；采集部分与生成稿不同则在其后标注人工删改，
// 让接收者能区分“采集到的”与“人改过/人补充的”。
export function finalizeReportDraft(draft, generated) {
  const marker = `\n${REPORT_NOTES_HEADING}`;
  const at = draft.lastIndexOf(marker);
  const body = (at >= 0 ? draft.slice(0, at) : draft).trimEnd();
  const notes = at >= 0 ? draft.slice(at + marker.length).trim() : "";
  const parts = [body];
  if (body !== generated.trimEnd()) parts.push("", EDITED_NOTE);
  if (notes) parts.push("", REPORT_NOTES_HEADING, "", notes);
  return `${parts.join("\n")}\n`;
}

export function createReportController({ doc, getJson, toast = () => {}, confirm = () => true, copy = copyText, urlApi = globalThis.URL, BlobImpl = globalThis.Blob }) {
  const el = (id) => doc.getElementById(id);
  let target = null;
  let result = null;
  let base = "";          // 草稿初值（生成稿 + 空现场说明），判断“已修改”的基准
  let lastExported = null; // 最近一次复制/下载时的草稿；导出过的内容关闭时不再追问
  let generation = 0;
  let allowClose = false;
  // execCommand 不可用时「隐藏所选」只能直接改值，这会清空原生撤销栈；留快照供 Cmd/Ctrl+Z 撤回。
  let undoStack = [];

  const area = () => el("reportPreview");
  const draft = () => (result ? area().value : "");
  const isEdited = () => Boolean(result) && draft() !== base;
  const hasUnexportedEdits = () => isEdited() && draft() !== lastExported;

  function syncDraftState() {
    const edited = isEdited();
    if (el("reportDirty")) el("reportDirty").hidden = !edited;
    if (el("reportRestoreBtn")) el("reportRestoreBtn").disabled = !edited;
  }

  function controls(ready) {
    for (const id of ["reportCopyBtn", "reportDownloadBtn", "reportHideBtn"]) if (el(id)) el(id).disabled = !ready;
    area().readOnly = !ready;
    syncDraftState();
  }

  async function confirmDiscard(message) {
    if (!hasUnexportedEdits()) return true;
    return Boolean(await confirm(message));
  }

  async function generate() {
    if (!target) return;
    const request = ++generation;
    result = null;
    undoStack = [];
    lastExported = null;
    controls(false);
    area().value = "正在整理本机已采集的证据…";
    el("reportMeta").textContent = "";
    const params = new URLSearchParams(target);
    if (el("reportIncludeScript")?.checked) params.set("includeScript", "1");
    try {
      const data = await getJson(`/api/reports?${params}`);
      if (request !== generation) return;
      if (typeof data?.markdown !== "string") throw new Error("报告内容不可用");
      result = data;
      base = draftFromGenerated(data.markdown);
      area().value = base;
      el("reportMeta").textContent = `已隐藏 ${data.redactions || 0} 处常见敏感信息${data.truncated ? " · 内容已按大小截断" : ""}`;
      controls(true);
    } catch (error) {
      if (request !== generation) return;
      area().value = `报告生成失败：${error.serverMessage || error.message || "请稍后重试"}`;
    }
  }

  // 重新生成：草稿有未导出的修改时先确认；返回 false 表示用户取消。
  async function load() {
    if (!(await confirmDiscard("重新生成会用新的生成稿覆盖当前草稿（含现场说明）。确定重新生成？"))) return false;
    await generate();
    return true;
  }

  async function open(next) {
    const dialog = el("reportDialog");
    if (dialog.open && !(await confirmDiscard("打开另一份报告会丢弃当前草稿的修改。确定继续？"))) return;
    target = next;
    el("reportIncludeScript").checked = false;
    el("reportScriptOption").hidden = next.kind !== "job";
    if (!dialog.open) dialog.showModal();
    await generate();
  }

  function hideSelection() {
    const box = area();
    if (!result || box.readOnly) return;
    const start = box.selectionStart, end = box.selectionEnd;
    if (!(end > start)) { toast({ type: "warn", message: "请先在报告中选中要隐藏的文字" }); return; }
    const before = box.value;
    const expected = before.slice(0, start) + REPORT_MASK + before.slice(end);
    box.focus();
    box.setSelectionRange?.(start, end);
    // 优先走浏览器编辑命令：替换进入原生撤销栈，Cmd/Ctrl+Z 可撤回。
    let native = false;
    try { native = doc.execCommand?.("insertText", false, REPORT_MASK) === true; } catch { native = false; }
    if (!native || box.value !== expected) {
      box.value = expected;
      undoStack.push({ before, after: expected, start, end });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      box.setSelectionRange?.(start + REPORT_MASK.length, start + REPORT_MASK.length);
    }
    syncDraftState();
  }

  // 只在草稿仍停留在回退替换后的样子时接管撤销；其余情况交给原生撤销。
  function onKeydown(event) {
    const key = String(event.key || "").toLowerCase();
    if (key !== "z" || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    const last = undoStack[undoStack.length - 1];
    if (!last || area().value !== last.after) { undoStack = []; return; }
    event.preventDefault();
    undoStack.pop();
    area().value = last.before;
    area().setSelectionRange?.(last.start, last.end);
    syncDraftState();
  }

  async function restore() {
    if (!isEdited()) return;
    if (!(await confirm("恢复为生成稿？当前草稿的修改（含现场说明）会丢失。"))) return;
    undoStack = [];
    area().value = base;
    syncDraftState();
  }

  function exportText() {
    if (!result) return null;
    lastExported = draft();
    return finalizeReportDraft(lastExported, result.markdown);
  }

  async function copyReport() {
    const text = exportText();
    if (text == null) return;
    try {
      const copied = await copy(text);
      if (copied !== false) toast({ type: "success", message: "排障报告已复制" });
    } catch { toast({ type: "error", message: "复制失败，请下载 Markdown 文件" }); }
  }

  function download() {
    const text = exportText();
    if (text == null) return;
    const url = urlApi.createObjectURL(new BlobImpl([text], { type: "text/markdown;charset=utf-8" }));
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    setTimeout(() => urlApi.revokeObjectURL(url), 1000);
  }

  async function requestClose() {
    if (!(await confirmDiscard("报告草稿有未导出的修改，关闭后会丢弃。确定关闭？"))) return false;
    allowClose = true;
    el("reportDialog").close();
    return true;
  }

  async function onClose() {
    const dialog = el("reportDialog");
    // 兜底：其它途径（如无法取消的 Esc）直接关掉了弹层，草稿仍在 DOM 里，未确认就重新打开。
    if (!allowClose && hasUnexportedEdits() && !(await confirm("报告草稿有未导出的修改，关闭后会丢弃。确定关闭？"))) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    allowClose = false;
    generation += 1; target = null; result = null; base = ""; lastExported = null; undoStack = [];
    controls(false);
  }

  function bind() {
    doc.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-job-report],[data-incident-report]");
      if (!button) return;
      const serverId = button.dataset.reportServer;
      if (!serverId) { toast({ type: "warn", message: "报告缺少服务器信息，请刷新对应作业后重试。" }); return; }
      open(button.dataset.jobReport
        ? { kind: "job", serverId, jobId: button.dataset.jobReport }
        : { kind: "incident", serverId, incidentId: button.dataset.incidentReport });
    });
    el("reportCopyBtn")?.addEventListener("click", copyReport);
    el("reportDownloadBtn")?.addEventListener("click", download);
    el("reportRefreshBtn")?.addEventListener("click", load);
    el("reportHideBtn")?.addEventListener("click", hideSelection);
    el("reportRestoreBtn")?.addEventListener("click", restore);
    const script = el("reportIncludeScript");
    script?.addEventListener("change", async () => { if (!(await load())) script.checked = !script.checked; });
    area()?.addEventListener("input", syncDraftState);
    area()?.addEventListener("keydown", onKeydown);
    const dialog = el("reportDialog");
    // 捕获阶段先于 dialogs.js 的统一关闭委托：有未导出修改时拦下 ✕ / 点遮罩，确认后再关。
    dialog?.addEventListener("click", (event) => {
      if (!hasUnexportedEdits() || (event.target !== dialog && !event.target?.closest?.("[data-close]"))) return;
      event.stopImmediatePropagation?.();
      event.preventDefault?.();
      requestClose();
    }, true);
    dialog?.addEventListener("cancel", (event) => {
      if (!hasUnexportedEdits()) return;
      event.preventDefault();
      requestClose();
    });
    dialog?.addEventListener("close", onClose);
  }
  return { bind, open, load, copyReport, download, hideSelection, restore, requestClose };
}
