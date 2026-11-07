// scripts/setup-wizard.mjs —— `npm run setup`：交互式配置向导入口。
//
// 步骤实现按职责拆在 scripts/setup/ 下，本文件只负责编排（main）：
//   ui.mjs               彩色日志 / 提问 / --dry-run 开关
//   ssh-keys.mjs         1. 检测 / 生成本地 SSH 密钥（绝不覆盖既有私钥）
//   ssh-config.mjs       ~/.ssh 路径与 ~/.ssh/config Host 段的幂等 upsert + 原子写回
//   host-keys.mjs        首次连接的主机指纹确认与 known_hosts 写入
//   ssh-probe.mjs        免密探测 / 失败归因 / 远端命令执行
//   team-server.mjs      2. 逐台打通 config.json 里的团队服务器
//   local-config.mjs     个人层 config.local.json 的读写（个人身份 / 个人服务器 / 屏蔽标记）
//   port-assignment.mjs  3. 为本账号分配专属反向端口（P3）
//   routing.mjs          4. 服务器侧代理：集群侧受管配置 env.sh（v2.54，取代 P2 的 codex 注入）+ reclaude / zcode 路由
//   cli-install.mjs      5. 检测 / 安装集群上的 Codex 与 Claude Code（v2.57，可跳过；与设置页「命令行工具」同一套流程）
//   cli-login.mjs        6. 登录集群上的 codex / Claude Code（v2.57，可跳过）
//   personal-servers.mjs 可选：添加个人服务器
//   summary.mjs          7. 依赖检查 + 收尾完成度摘要
// 没有断点续接：中断后重跑，各步幂等。撤销集群侧写入见 scripts/setup-undo.mjs（npm run setup:undo）。
import fs from "node:fs";
import path from "node:path";
import { isNodeVersionSupported, nodeVersionHint } from "../work/monitor/lib/platform.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { defaultLocalConfigPath, readSshUserFromLocalConfig } from "./setup/local-config.mjs";
import { addPersonalServers } from "./setup/personal-servers.mjs";
import { assignReversePort } from "./setup/port-assignment.mjs";
import { installClis } from "./setup/cli-install.mjs";
import { loginStep } from "./setup/cli-login.mjs";
import { configureRouting } from "./setup/routing.mjs";
import { checkSshKeys, generateSshKey } from "./setup/ssh-keys.mjs";
import { buildWizardSummary, installDependenciesIfNeeded, PRIMARY_SERVER_ID, printWizardSummary } from "./setup/summary.mjs";
import { configureServer } from "./setup/team-server.mjs";
import { logError, logHeader, logInfo, logWarning } from "./setup/ui.mjs";

// 主入口
async function main() {
  logHeader("集群运维工作台 (Codex Operations Console) 快速配置向导");
  logInfo("本向导将帮助您快速配置本地环境，包括 Node 依赖安装与集群 SSH 免密连接。");

  if (!isNodeVersionSupported(process.version)) {
    logError(`当前 Node.js ${process.version} 不受支持。`);
    logError(nodeVersionHint());
    process.exit(1);
  }

  // Step 1: 检测 SSH Key（E6：checkSshKeys/generateSshKey 现在返回
  // { privateKeyPath, publicKeyPath, isDedicated } | null，绝不覆盖既有默认私钥）
  let keyInfo = checkSshKeys();
  if (!keyInfo) {
    keyInfo = await generateSshKey();
  }

  // Step 2: 加载服务器配置
  let servers = [];
  let requirePortRegistry = false;
  try {
    const configPath = path.resolve(process.cwd(), "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      servers = config.servers || [];
      requirePortRegistry = config?.portRegistry?.required === true;
    } else {
      logError("未在当前目录下找到 config.json。请确保在项目根目录运行此脚本。");
      process.exit(1);
    }
  } catch (err) {
    logError(`加载 config.json 失败: ${err.message}`);
    process.exit(1);
  }

  if (servers.length === 0) {
    logWarning("config.json 中未配置任何 servers。");
  }

  // Step 3: 配置各服务器
  const serverResults = [];
  let server01 = null;
  let server01Configured = false;
  for (const server of servers) {
    const result = await configureServer(server, keyInfo);
    serverResults.push({ id: server.id, name: server.name, host: server.host, ...result });
    if (server.id === PRIMARY_SERVER_ID) {
      server01 = server;
      server01Configured = result.status === "ok";
    }
  }

  // Step 3.5：server-01 配好且个人身份已写入后，为本账号分配专属反向端口 (P3)
  // 并把服务器侧 per-user 代理路由 SSH 写过去 (P2)。任一环节的真实副作用都在 --dry-run 下只打印不执行。
  const teamRemotePorts = servers.map((s) => s.remotePort).filter((p) => Number.isInteger(p));
  const dedicatedIdentityFile = keyInfo?.isDedicated ? keyInfo.privateKeyPath : undefined;

  if (server01 && server01Configured) {
    const { remotePort } = await assignReversePort(server01, teamRemotePorts, { requireRegistry: requirePortRegistry });
    await configureRouting(server01, remotePort);
    // v2.57：检测 / 安装集群上的 Codex 与 Claude Code。env.sh 刚写好，首选路径经隧道下载；
    // 每个 CLI 单独问、回车跳过；出错只提示，不影响后面的步骤。
    try {
      await installClis(server01);
    } catch (err) {
      logWarning(`检测 / 安装命令行工具出错，已跳过：${err.message}`);
    }

    // v2.57：登录集群上的 codex / Claude Code（可跳过）。账号授权在当前终端里完成；key 只经 ssh 标准输入。
    await loginStep(server01, remotePort);
  } else if (server01 && serverResults.some((r) => r.id === PRIMARY_SERVER_ID && (r.status === "failed" || r.status === "skipped"))) {
    logWarning(`${PRIMARY_SERVER_ID} 免密登录未打通，本次跳过"分配专属反向端口"与"服务器侧代理路由"两步（结尾会列出）。`);
  }

  // Step 3.6：添加个人服务器。刻意放在 server-01 分支之外 —— 选择"我不在这个集群"
  // 屏蔽了团队服务器的同事，同样需要给自己的机器建卡片。
  let teamSshUser = "";
  try {
    teamSshUser = readSshUserFromLocalConfig(fs.readFileSync(defaultLocalConfigPath(), "utf8"));
  } catch {
    teamSshUser = ""; // 个人层还不存在（新机器首次运行）：按"没有团队账号"处理
  }
  await addPersonalServers({
    localConfigPath: defaultLocalConfigPath(),
    teamRemotePorts,
    teamSshUser,
    identityFile: dedicatedIdentityFile,
  });

  // Step 4: 依赖检查。README 的快速上手不再单独要求 npm install；已装齐就直接跳过，
  // 缺失时先问一句（网页模式根本不需要依赖，不该让新人白等一次安装）。
  const npm = await installDependenciesIfNeeded();

  // Step 5: 如实汇总。免密没打通时后面的端口分配/路由都被跳过了，绝不能再宣告"配置完成"。
  printWizardSummary(buildWizardSummary({ serverResults, npm }));
}

// 仅当本文件是被直接执行（`node scripts/setup-wizard.mjs` / `npm run setup`）时才自动跑交互式向导；
// 被其他模块 import（例如测试文件为了单测下面抽出的纯函数）时绝不能顺带触发真实的 SSH/文件系统/readline 副作用。
// 判定比较真实路径（lib/is-main.mjs）：仓库路径含中文、可能经软链启动，手拼 file:// 串会导致 `npm run setup` 静默不启动。
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logError(`配置向导发生异常错误: ${err.message}`);
    process.exit(1);
  });
}
