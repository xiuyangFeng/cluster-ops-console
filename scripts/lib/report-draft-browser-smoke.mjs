// 真实 Chromium 中验证排障报告草稿：隐藏所选走原生编辑命令（可原生撤销）、现场说明、
// 复制/下载都取草稿、生成稿不被改写、有未导出修改时关闭先确认；两种主题 × 两种宽度截图。
// 前置：报告弹层已用隔离夹具的真实 /api/reports 打开且可导出。零 SSH。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const NOTE = "现场：重启节点后可复现。";

export async function runReportDraftSmoke({ win, pageEval, waitFor, screenshotDir = null }) {
  const edit = await pageEval(`(async () => {
    const box = document.getElementById("reportPreview");
    const before = box.value;
    const at = before.indexOf("KeyError: 'arm'");
    box.focus();
    box.setSelectionRange(at, at + "KeyError".length);
    document.getElementById("reportHideBtn").click();
    const hidden = box.value;
    const dirtyAfterHide = !document.getElementById("reportDirty").hidden;
    document.execCommand("undo");
    const undone = box.value === before;
    const dirtyAfterUndo = !document.getElementById("reportDirty").hidden;
    box.setSelectionRange(at, at + "KeyError".length);
    document.getElementById("reportHideBtn").click();
    box.setSelectionRange(box.value.length, box.value.length);
    document.execCommand("insertText", false, ${JSON.stringify(NOTE)});
    // 拦截两个出口，读出实际导出的文本。
    let copied = null, blob = null;
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text) => { copied = text; } });
    const createObjectURL = URL.createObjectURL, anchorClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (value) => { blob = value; return "blob:report-smoke"; };
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.getElementById("reportCopyBtn").click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.getElementById("reportDownloadBtn").click();
    } finally {
      URL.createObjectURL = createObjectURL;
      HTMLAnchorElement.prototype.click = anchorClick;
      delete navigator.clipboard.writeText;
    }
    return { before, hidden, dirtyAfterHide, undone, dirtyAfterUndo, draft: box.value, copied, downloaded: blob ? await blob.text() : null,
      hideMaskCount: (box.value.match(/\\[已隐藏\\]/g) || []).length };
  })()`);
  assert.ok(edit.hidden.includes("[已隐藏]: 'arm'") && edit.dirtyAfterHide, "隐藏所选替换为 [已隐藏] 并显示已修改");
  assert.ok(edit.undone && !edit.dirtyAfterUndo, "隐藏所选进入原生撤销栈，undo 回到生成稿");
  assert.ok(edit.before.includes("## 现场说明（用户补充，非采集证据）"), "草稿末尾预留现场说明");
  assert.equal(edit.copied, edit.downloaded, "复制与下载导出同一份草稿");
  assert.match(edit.copied, /\[已隐藏\]: 'arm'/);
  assert.match(edit.copied, /> 以上采集内容在导出前经人工删改/);
  assert.ok(edit.copied.trimEnd().endsWith(`## 现场说明（用户补充，非采集证据）\n\n${NOTE}`), "现场说明单列在末尾");

  // 导出后再改动 → 点 ✕ 先确认；取消则弹层与草稿保持。
  await pageEval(`(() => {
    const box = document.getElementById("reportPreview");
    box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    document.execCommand("insertText", false, "补充");
    window.__reportConfirms = [];
    window.confirm = (message) => { window.__reportConfirms.push(message); return false; };
    document.querySelector("#reportDialog [data-close]").click();
    return true;
  })()`);
  const kept = await pageEval('({ open: document.getElementById("reportDialog").open, confirms: window.__reportConfirms.length, tail: document.getElementById("reportPreview").value.endsWith("补充") })');
  assert.deepEqual(kept, { open: true, confirms: 1, tail: true }, "有未导出修改时关闭需确认，取消不丢草稿");
  await pageEval('window.confirm = () => true; true');

  const layout = async () => pageEval(`(() => {
    const dlg = document.getElementById("reportDialog");
    return { overflow: dlg.scrollWidth - dlg.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })()`);
  const originalTheme = await pageEval('document.body.getAttribute("data-theme")');
  for (const [width, theme] of [[1028, "dark"], [1028, "light"], [520, "dark"], [520, "light"]]) {
    win.setSize(width, 820);
    await waitFor(() => pageEval(`window.innerWidth <= ${width}`), `report resize to ${width} did not apply`);
    await pageEval(`(() => {
      if (${JSON.stringify(theme)} === "light") document.body.setAttribute("data-theme", "light"); else document.body.removeAttribute("data-theme");
      document.querySelectorAll(".toast-item").forEach((el) => el.remove());
      return true;
    })()`);
    const box = await layout();
    assert.ok(box.overflow <= 2 && box.page <= 2, `报告弹层 ${width}px 不得横向溢出: ${JSON.stringify(box)}`);
    if (screenshotDir) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(path.join(screenshotDir, `report-edit-${width}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }
  await pageEval(`(() => { const theme = ${JSON.stringify(originalTheme)}; if (theme) document.body.setAttribute("data-theme", theme); else document.body.removeAttribute("data-theme"); return true; })()`);
  win.setSize(1100, 820);
  await waitFor(() => pageEval("window.innerWidth >= 1000"), "wide window resize did not apply");
}
