// export-file.mjs —— 桌面窗口里的「导出配置」另存为（v2.64）：弹系统保存对话框，把页面给的 JSON 文本写到用户选的位置。
//
// 只收 .json 文件名与不超过 1 MB、解析得了的 JSON 文本；写出的文件 0600（里面是个人配置，虽然不含口令）。
// 不 import electron：dialog 由入口注入；对话框挂在主窗口上（没有主窗口时不挂）。网页模式不经这里，页面自己走浏览器下载。
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXPORT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_NAME = "cluster-workbench-config.json";

// 文件名只留一层名字、去掉路径与控制字符，强制 .json 结尾。
export function safeExportName(raw) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符就是要去掉的
  const base = path.basename(String(raw || "")).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "").trim().slice(0, 120);
  if (!base || base.startsWith(".")) return DEFAULT_NAME;
  return base.toLowerCase().endsWith(".json") ? base : `${base}.json`;
}

export function createExportFileSaver({ ctx, dialog, fs = nodeFs, homeDir = os.homedir() }) {
  // → { saved: true, name } | { saved: false, canceled: true } | { saved: false, error }
  async function saveExportFile(payload) {
    const content = typeof payload?.content === "string" ? payload.content : "";
    if (!content || Buffer.byteLength(content) > EXPORT_FILE_MAX_BYTES) return { saved: false, error: "导出内容不对或太大" };
    try {
      JSON.parse(content);
    } catch {
      return { saved: false, error: "导出内容不是 JSON" };
    }
    const options = {
      title: "导出配置",
      defaultPath: path.join(homeDir, "Downloads", safeExportName(payload?.defaultName)),
      buttonLabel: "导出",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const owner = ctx.state.mainWindow && !ctx.state.mainWindow.isDestroyed?.() ? ctx.state.mainWindow : null;
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (!result || result.canceled || !result.filePath) return { saved: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, content, { mode: 0o600 });
      try { fs.chmodSync(result.filePath, 0o600); } catch {}
    } catch (error) {
      return { saved: false, error: `写不进 ${path.basename(result.filePath)}（${error?.code || "错误"}）` };
    }
    return { saved: true, name: path.basename(result.filePath) };
  }

  return { saveExportFile };
}
