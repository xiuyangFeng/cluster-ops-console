// scripts/setup/ui.mjs —— 配置向导的终端交互基础件：彩色日志、提问、--dry-run 开关。
// 向导各步骤模块共用；DRY_RUN 在 import 时从 process.argv 读一次（`npm run setup -- --dry-run`），
// 需要单测的步骤另以 dryRun 参数注入，不依赖这里的全局值。
import { styleText } from "node:util";
import { askLine } from "../lib/prompt.mjs";

export const DRY_RUN = process.argv.includes("--dry-run");

// 终端彩色输出：util.styleText 在非 TTY / NO_COLOR 等环境下自动去色。
export const bold = (text) => styleText("bold", text);

export function logSuccess(msg) { console.log(styleText("green", `✔ ${msg}`)); }
export function logWarning(msg) { console.log(styleText("yellow", `⚠ ${msg}`)); }
export function logError(msg) { console.log(styleText("red", `✘ ${msg}`)); }
export function logInfo(msg) { console.log(styleText("cyan", `ℹ ${msg}`)); }
export function dryRunLog(msg) { console.log(styleText("yellow", `[dry-run] ${msg}`)); }
export function logHeader(msg) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(bold(styleText("blue", msg)));
  console.log(`${"=".repeat(60)}\n`);
}

// 手动兜底命令（自动写入失败/跳过时让用户复制执行）统一用青色整块打印。
export function printManualCommand(text) {
  console.log(styleText("cyan", text));
}

// 封装交互提问（回答去掉首尾空白）
export function askQuestion(query) {
  return askLine(query).then((ans) => ans.trim());
}
