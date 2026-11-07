// diagnostics-save.mjs —— 「导出诊断包」在桌面壳里的保存（v2.64）：系统保存对话框 → 写文件。
//
// 页面从监控服务取到已脱敏的诊断包（GET /api/diagnostics/bundle），经 IPC `save-diagnostics` 交过来
// { filename, text }。这里只做三件事：校验（文件名只收安全字符、内容是字符串且不超过 32 MB）、
// 弹保存框（默认放到「下载」）、按用户选的位置写入（0600）。取消不算错。
// 不 import electron：app / dialog 由入口注入。
import { writeFile as defaultWriteFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DIAGNOSTICS_SAVE_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_DIAGNOSTICS_FILENAME = "cluster-workbench-diagnostics.json";

// → { filename, text }；不合格抛错（IPC 那头收到的是拒绝）。
export function validateDiagnosticsSave(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.text !== "string") throw new TypeError("诊断包内容无效");
  if (Buffer.byteLength(payload.text) > DIAGNOSTICS_SAVE_MAX_BYTES) throw new RangeError("诊断包过大");
  const name = typeof payload.filename === "string" ? payload.filename : "";
  const filename = /^[\w.-]{1,120}\.json$/.test(name) && !name.startsWith(".") ? name : DEFAULT_DIAGNOSTICS_FILENAME;
  return { filename, text: payload.text };
}

export function createDiagnosticsSaver({ ctx, app, dialog, writeFile = defaultWriteFile, homeDir = os.homedir(), logger = null }) {
  const { state } = ctx;

  async function saveDiagnosticsBundle(payload) {
    const { filename, text } = validateDiagnosticsSave(payload);
    let dir = homeDir;
    try { dir = app.getPath("downloads") || homeDir; } catch {}
    const options = {
      title: "保存诊断包",
      defaultPath: path.join(dir, filename),
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const win = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : null;
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result?.canceled || !result?.filePath) return { saved: false, canceled: true };
    await writeFile(result.filePath, text, { mode: 0o600 });
    try { logger?.info("诊断包已保存", { event: "diagnostics-saved", origin: "main", bytes: Buffer.byteLength(text) }); } catch {}
    return { saved: true, path: result.filePath };
  }

  return { saveDiagnosticsBundle };
}
