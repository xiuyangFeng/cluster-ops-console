// scripts/setup/summary.mjs —— 收尾：Node 依赖检查与完成度摘要。
// dependenciesSatisfied / buildWizardSummary 是纯函数（供 setup-wizard.test.mjs 单测），
// installDependenciesIfNeeded / printWizardSummary 负责交互与打印。
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TEAM_PRIMARY_SERVER_ID } from "../../work/monitor/lib/onboarding.mjs";
import { askQuestion, bold, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

// 主服务器（端口分配 / 服务器侧路由只对它做）：与 /api/status.onboarding 判定用的是同一个 id。
export const PRIMARY_SERVER_ID = TEAM_PRIMARY_SERVER_ID;

// package.json 里声明的依赖是否都已装进 node_modules（只看目录里有没有 package.json，
// 不做版本比对——够用来避免"README 让装一遍、向导又装一遍"的重复等待）。
export function dependenciesSatisfied(pkg, { rootDir = ".", exists = fs.existsSync } = {}) {
  const names = Object.keys({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });
  return names.every((name) => exists(path.join(rootDir, "node_modules", name, "package.json")));
}

const INCOMPLETE_SERVER_STATUSES = new Set(["failed", "skipped"]);

// serverResults: [{ id, name, host, status: "ok"|"disabled"|"skipped"|"failed", reason? }]
// npm: "satisfied" | "installed" | "declined" | "failed" | "dry-run"
export function buildWizardSummary({ serverResults = [], npm = "satisfied", primaryServerId = PRIMARY_SERVER_ID } = {}) {
  const skipped = [];
  for (const r of serverResults) {
    if (!INCOMPLETE_SERVER_STATUSES.has(r.status)) continue;
    const label = r.name ? `${r.name}（${r.host || r.id}）` : (r.host || r.id);
    skipped.push(`服务器 ${label} 的免密登录未打通${r.reason ? `：${r.reason}` : ""}`);
    if (r.id === primaryServerId) {
      skipped.push(`把集群 SSH 用户名写入个人配置 config.local.json（${primaryServerId}）`);
      skipped.push(`为 ${primaryServerId} 分配专属反向端口（多人同服务器隔离）`);
      skipped.push("写入服务器侧 per-user 代理路由（codex / reclaude / zcode）");
    }
  }
  const notes = [];
  if (npm === "failed") notes.push("依赖安装失败：只影响 macOS 桌面窗口，网页模式不受影响；可稍后手动运行 npm install。");
  if (npm === "declined") notes.push("已跳过 npm install：网页模式无需依赖；需要 macOS 桌面窗口时再运行 npm install。");
  const complete = skipped.length === 0;
  return {
    complete,
    title: complete ? "配置完成！" : "配置未完成",
    configured: serverResults.filter((r) => r.status === "ok").length,
    disabled: serverResults.filter((r) => r.status === "disabled").length,
    total: serverResults.length,
    skipped,
    notes,
    rerunHint: complete ? "" : "请在 SSH 白名单网络下重跑 npm run setup（已完成的步骤会自动跳过或原样保留）。",
  };
}

export const MAC_APP_HINT = "macOS 桌面 App：仓库里不含 .app —— 从 GitHub Releases 下载 Codex Operations Console.app，或本地执行 bash scripts/build-macos-app.sh 构建";

export function printWizardSummary(summary) {
  logHeader(summary.title);
  const counts = `${summary.configured}/${summary.total} 台团队服务器已打通免密登录${summary.disabled ? `，${summary.disabled} 台按"我不在这个集群"屏蔽` : ""}。`;
  if (summary.complete) logSuccess(counts);
  else logWarning(counts);
  if (!summary.complete) {
    logError("以下步骤被跳过：");
    for (const item of summary.skipped) console.log(`  - ${item}`);
    logInfo(summary.rerunHint);
  }
  for (const note of summary.notes) logWarning(note);
  console.log("");
  logInfo(summary.complete ? "您现在可以启动控制台了：" : "控制台仍可启动查看状态，但上面未打通的服务器暂时不会建立隧道：");
  console.log(`  - 跨平台启动: ${bold("npm start")}（网页模式会自动打开浏览器）`);
  console.log(`  - Windows 双击: ${bold("start-console.cmd")}`);
  console.log(`  - ${MAC_APP_HINT}`);
  console.log("");
}

export async function installDependenciesIfNeeded() {
  logHeader("7. 检查 Node 依赖包");
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  if (dependenciesSatisfied(pkg, { rootDir: process.cwd() })) {
    logSuccess("依赖已就绪（node_modules 完整），跳过 npm install。");
    return "satisfied";
  }
  logInfo("网页模式不需要任何 npm 依赖；只有 macOS 桌面窗口（Electron）和开发工具需要。");
  const answer = await askQuestion("是否现在执行 npm install？(Y/n): ");
  if (String(answer).trim().toLowerCase() === "n") return "declined";
  if (DRY_RUN) {
    dryRunLog("npm install");
    return "dry-run";
  }
  logInfo("正在执行 npm install，请稍候...");
  try {
    execSync("npm install", { stdio: "inherit" });
    logSuccess("依赖包安装完成！");
    return "installed";
  } catch (err) {
    logError(`依赖包安装失败: ${err.message}`);
    logWarning("请检查网络连接，或稍后手动运行 npm install。");
    return "failed";
  }
}
