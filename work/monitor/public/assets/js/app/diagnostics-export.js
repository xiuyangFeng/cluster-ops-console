// app/diagnostics-export.js —— 配置浮层「版本与更新」里的「导出诊断包」（v2.64）。
//
// 工作台自己出了问题（白屏、反复退出、启动不了之后又好了）时，把排查要用的东西打成一个 JSON 文件发给发布方。
// 不另开卡片：入口是「版本与更新」面板头上的一个文字按钮，点开在同一块里就地展开——先列出包里有什么、
// 哪些会被隐藏，确认后才去取（GET /api/diagnostics/bundle，服务端已脱敏）。
// 桌面壳里走系统保存对话框（electronAPI.saveDiagnosticsBundle）；网页模式（或更新前的旧桌面壳）用浏览器下载。
import { escapeHtml, formatBytes } from "../store.js";

// 与服务端 lib/diagnostics/bundle.mjs 的 DIAGNOSTICS_CONTENTS / DIAGNOSTICS_PRIVACY_NOTE 逐字一致（diagnostics-export.test.mjs 守着）。
export const DIAGNOSTICS_EXPORT_CONTENTS = Object.freeze([
  "版本与构建信息、操作系统与架构、Node / Electron 版本",
  "合并后的配置（团队层 + 个人层，已脱敏）",
  "当前状态快照与未结事件",
  "各日志（runtime/logs/*.ndjson）末尾各至多 300 行",
  "隧道断线账本末尾至多 200 行",
  "后台进程登记摘要与本地存储占用",
]);
export const DIAGNOSTICS_EXPORT_PRIVACY = "令牌、口令、代理口令、保管库、认证头与 Cookie、URL 中的口令、常见服务商密钥已替换为「[已隐藏]」；主机名、账号名与路径保留，便于排查。";

const BUNDLE_TIMEOUT_MS = 60_000;

// 纯函数：展开后的那一块。busy：正在整理；status：上一次的结果（一句话）。
export function buildDiagnosticsExportHtml({ busy = false, status = "", desktop = false } = {}) {
  return `
    <p class="diag-export-lead">把排查工作台自身问题要用的信息打成一个 JSON 文件，${desktop ? "保存到你选的位置" : "由浏览器下载"}，不会自动上传到任何地方。包含：</p>
    <ul class="diag-export-list">${DIAGNOSTICS_EXPORT_CONTENTS.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p class="diag-export-note">${escapeHtml(DIAGNOSTICS_EXPORT_PRIVACY)}</p>
    <div class="diag-export-actions">
      <button type="button" class="btn btn-primary" id="diagExportConfirmBtn"${busy ? " disabled" : ""}>${busy ? "正在整理…" : "导出"}</button>
      <button type="button" class="text-btn" id="diagExportCancelBtn"${busy ? " disabled" : ""}>收起</button>
      <span class="diag-export-status" id="diagExportStatus" role="status">${escapeHtml(status)}</span>
    </div>`;
}

// 纯函数：导出成功后的一句话。
export function describeExportResult({ bytes, redactions, saved = true, path = "" } = {}) {
  const size = Number.isFinite(bytes) ? formatBytes(bytes) : "";
  const hidden = Number.isFinite(redactions) && redactions > 0 ? `，隐藏了 ${redactions} 处敏感信息` : "";
  if (!saved) return "已取消，没有保存。";
  return `已导出${size ? `（${size}${hidden}）` : hidden ? `（${hidden.slice(1)}）` : ""}${path ? `：${path}` : "。"}`;
}

export function createDiagnosticsExport({
  doc,
  getJson,
  showToast = () => {},
  electronAPI = null,
  urlApi = globalThis.URL,
  BlobImpl = globalThis.Blob,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
}) {
  const el = (id) => doc.getElementById(id);
  const desktop = typeof electronAPI?.saveDiagnosticsBundle === "function";
  let busy = false;
  let status = "";

  function render() {
    const panel = el("diagExportPanel");
    if (!panel) return;
    panel.innerHTML = buildDiagnosticsExportHtml({ busy, status, desktop });
  }

  function setOpen(open) {
    const panel = el("diagExportPanel");
    const toggle = el("diagExportOpenBtn");
    if (!panel) return;
    if (open) render();
    panel.hidden = !open;
    toggle?.setAttribute("aria-expanded", String(open));
  }

  function download(filename, text) {
    const url = urlApi.createObjectURL(new BlobImpl([text], { type: "application/json;charset=utf-8" }));
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeoutFn(() => urlApi.revokeObjectURL(url), 1000);
  }

  async function exportNow() {
    if (busy) return;
    busy = true;
    status = "";
    render();
    try {
      const result = await getJson("/api/diagnostics/bundle", { timeoutMs: BUNDLE_TIMEOUT_MS });
      const text = `${JSON.stringify(result?.bundle ?? null, null, 2)}\n`;
      const filename = typeof result?.filename === "string" && result.filename ? result.filename : "cluster-workbench-diagnostics.json";
      // 显示的是落盘文件的大小（带缩进），不是接口响应的紧凑体积。
      const bytes = new TextEncoder().encode(text).length;
      if (desktop) {
        const saved = await electronAPI.saveDiagnosticsBundle({ filename, text });
        status = describeExportResult({ bytes, redactions: result?.redactions, saved: saved?.saved === true, path: saved?.path || "" });
        if (saved?.saved) showToast({ type: "success", title: "导出诊断包", message: "已保存，可以把这个文件发给发布方。" });
      } else {
        download(filename, text);
        status = describeExportResult({ bytes, redactions: result?.redactions });
        showToast({ type: "success", title: "导出诊断包", message: `已开始下载 ${filename}` });
      }
    } catch (err) {
      status = `导出失败：${err?.serverMessage || err?.message || "未知原因"}`;
      showToast({ type: "error", title: "导出诊断包", message: status });
    } finally {
      busy = false;
      render();
    }
  }

  function bind() {
    el("diagExportOpenBtn")?.addEventListener("click", () => setOpen(Boolean(el("diagExportPanel")?.hidden)));
    el("diagExportPanel")?.addEventListener("click", (event) => {
      const target = event.target?.closest?.("button");
      if (!target || target.disabled) return;
      if (target.id === "diagExportConfirmBtn") exportNow();
      else if (target.id === "diagExportCancelBtn") setOpen(false);
    });
  }

  return { bind, exportNow, setOpen };
}
