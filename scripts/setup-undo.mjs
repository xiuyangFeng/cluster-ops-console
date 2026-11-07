// scripts/setup-undo.mjs —— `npm run setup:undo`：撤销配置向导在集群上写下的受管配置。
//
// 编排在 work/monitor/lib/onboarding-guide/undo.mjs（配置 →「接入引导」下面的「撤销接入」用的是同一份）；
// 这里只把它接到终端上：SSH 执行器、彩色日志、y/N 提问、个人配置文件的读写，以及入口 main。
// 做什么、不做什么见那个文件的文件头；先看再做：`npm run setup:undo -- --dry-run`。
import fs from "node:fs";
import path from "node:path";
import { dropPortOverride, leftoverChecklist, undoClusterSetup as runUndo } from "../work/monitor/lib/onboarding-guide/undo.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { confirmYes } from "./lib/prompt.mjs";
import { defaultLocalConfigPath, persistLocalConfig, readLocalConfigObject, readNoProxyExtra } from "./setup/local-config.mjs";
import { readCurrentPortOverride, readTeamPortRegistryDir } from "./setup/port-assignment.mjs";
import { runSsh } from "./setup/ssh-probe.mjs";
import { PRIMARY_SERVER_ID } from "./setup/summary.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning, printManualCommand } from "./setup/ui.mjs";

// 纯函数原样转出（测试与其它脚本一直从这里取）。
export { dropPortOverride, leftoverChecklist };

// 编排的日志出口 → 终端。line 是不带样式的原样一行（步骤标题、收尾清单）；每次调用时才取 console.log。
const TERMINAL_UI = Object.freeze({
  header: logHeader,
  line: (text) => console.log(text),
  info: logInfo,
  success: logSuccess,
  warning: logWarning,
  error: logError,
  dryRun: dryRunLog,
  manual: printManualCommand,
});

function clearLocalPortOverride(localConfigPath, serverId) {
  const next = dropPortOverride(readLocalConfigObject(localConfigPath), serverId);
  if (next) persistLocalConfig(localConfigPath, next, false);
  return Boolean(next);
}

// 依赖全部可注入（测试用假 SSH / 假提问 / 假写盘）。返回 { status, steps, release, localPortCleared }：
//   status  "ok" | "failed" | "dry-run" | "declined"——任何一步（含释放端口、清本机端口）没做成都是 "failed"
//   steps   [{ id, status: "ok" | "failed" | "skipped" | "unchanged" | "dry-run" }]
//   release "kept" | "ok" | "absent" | "not-owner" | "failed" | "unknown" | "dry-run" | null（没有端口）
//   localPortCleared  本机个人配置里的端口是否已拿掉（只在选择释放、且集群侧结论明确时才动）
export async function undoClusterSetup(server, {
  port = null, noProxyExtra = [], registryDir, localConfigPath, dryRun = DRY_RUN, ssh = runSsh, ask = askQuestion, clearLocalPort = clearLocalPortOverride,
} = {}) {
  const result = await runUndo(server, {
    port,
    noProxyExtra,
    registryDir,
    localConfigPath,
    dryRun,
    ssh,
    clearLocalPort,
    ui: TERMINAL_UI,
    confirm: (question) => confirmYes(question, ask),
  });
  return {
    status: result.status,
    steps: result.steps.map(({ id, status }) => ({ id, status })),
    release: result.release,
    localPortCleared: result.localPortCleared,
  };
}

async function main() {
  let server;
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "config.json"), "utf8"));
    server = (config.servers || []).find((s) => s.id === PRIMARY_SERVER_ID);
  } catch (err) {
    logError(`加载 config.json 失败: ${err.message}。请在项目根目录运行。`);
    process.exit(1);
  }
  if (!server) {
    logError(`config.json 里没有团队服务器 ${PRIMARY_SERVER_ID}，没有可撤销的内容。`);
    process.exit(1);
  }
  const localConfigPath = defaultLocalConfigPath();
  const result = await undoClusterSetup(server, {
    localConfigPath,
    port: readCurrentPortOverride(localConfigPath, server.id),
    noProxyExtra: readNoProxyExtra(server.id, { localConfigPath }),
    registryDir: readTeamPortRegistryDir(),
  });
  if (result.status === "failed") process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logError(`撤销发生异常错误: ${err.message}`);
    process.exit(1);
  });
}
