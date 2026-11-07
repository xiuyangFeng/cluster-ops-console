// scripts/setup/routing.mjs —— 把服务器侧的代理配置 SSH 写过去：集群侧受管配置（v2.54，取代 P2 的
// codex 包装脚本 / .bashrc 注入）+ reclaude drop-in + zcode 设置文件。
// 远端写文件一律由 lib/shell/remote-file.mjs 生成的单条原子命令完成（E4：备份 + tmp+mv，慢网下 ssh
// 被超时杀死也绝不截断目标文件）；探测不到目标或写入失败时打印可直接复制执行的手动命令，绝不静默。
// 交给 ssh 的命令一律经 lib/shell/wrap-sh.mjs 包成 `sh -c '…'`（v2.54 终审）：对方登录 shell 是 tcsh / csh
// 时，`2>/dev/null`、`command -v` 都不是合法语法——zcode 的回读会"成功"返回空，接着把设置文件覆盖成只剩代理键。
import {
  buildClusterEnvSteps,
  buildCommentOutCommand,
  buildEnvPortReadCommand,
  buildStrayScanCommand,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_SETTINGS_READ_COMMAND,
  claudeSettingsProxyEnv,
  CLUSTER_ENV_PATH,
  credentialForEnvRewrite,
  groupStraysByFile,
  maskProxyCredential,
  parseEnvCredentialRead,
  parseEnvPortRead,
  parseStrayProxyExports,
  planClaudeSettingsMerge,
  STRAY_DISABLED_PREFIX,
  STRAY_SCAN_DONE,
} from "../../work/monitor/lib/cluster-env.mjs";
import { mergeZcodeSettings, RECLAUDE_PROXY_DROPIN_DIR, RECLAUDE_PROXY_DROPIN_FILE, renderReclaudeProxyDropin, zcodeProxySettingsPatch } from "../../work/monitor/lib/proxy-config.mjs";
import { buildRemoteReplaceFileCommand } from "../../work/monitor/lib/shell/remote-file.mjs";
import { wrapSh } from "../../work/monitor/lib/shell/wrap-sh.mjs";
import { confirmYes } from "../lib/prompt.mjs";
import { readNoProxyExtra } from "./local-config.mjs";
import { PROXY_AUTH_MODE_LABELS, readLocalProxyAuth } from "./proxy-credential.mjs";
import { runSsh } from "./ssh-probe.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning, printManualCommand } from "./ui.mjs";

// 远端写文件的命令生成已下沉到 lib（App 内引导复用）；导出名不变，向导测试与旧调用方照常从这里取。
export { buildRemoteReplaceFileCommand, buildRemoteUpsertCommand } from "../../work/monitor/lib/shell/remote-file.mjs";

// E4：慢网下 runSsh 默认 8s 预算不够写完 + mv，远端写文件统一调大到 20s。
const SSH_WRITE_TIMEOUT_MS = 20000;
// 只读探测（扫描旧导出 / 回读 settings.json）同样走慢网，给足预算。
const SSH_READ_TIMEOUT_MS = 15000;
const RECLAUDE_RESTART = "systemctl --user daemon-reload && systemctl --user restart reclaude";

// 用分配到的 remotePort，把服务器侧的代理配置 SSH 写过去。
// 集群侧受管配置（env.sh + 标记块）管 shell 里的 codex / claude / npm 等 CLI；reclaude 走 systemd --user
// drop-in；zcode 写它自己的设置文件。未探测到目标时都跳过自动写入并打印手动命令，绝不静默。
export async function configureRouting(server, remotePort) {
  logHeader("4. 配置服务器侧代理（集群侧受管配置 + reclaude / zcode 路由）");
  configureReclaudeRouting(server, remotePort);
  // 登录引导测通的内网中转站（个人层 noProxyExtra）随 env.sh 一起重写，不会被这一步覆盖掉；
  // 工作台里的代理口令（v2.64）同样：口令模式打开着、或集群上原来带着，就一并写入，重跑不会把它冲掉。
  await configureClusterEnv(server, remotePort, { noProxyExtra: readNoProxyExtra(server.id), proxyAuth: readLocalProxyAuth() });
  configureZcodeRouting(server, remotePort);
}

// reclaude / zcode 两步的共同原则（v2.57）：**服务器上已经有它才写**。同事默认不用这两样
// （团队配置里默认关闭），不能因为跑了一次向导就在别人的家目录里凭空建出 ~/.zcode、或刷一屏
// "请手动执行"的 reclaude 命令。返回值是这一步的结论，供测试断言：
//   "dry-run" | "absent"（没装，跳过）| "written" | "failed" | "invalid-json"（仅 zcode）

// ---- reclaude: systemd --user drop-in ----
// 写入与 zcode 同走 buildRemoteReplaceFileCommand 的单条原子命令（mkdir + 备份 + tmp+mv）。
// 备份 / 临时文件名以 .bak.<epoch> / .tmp.<pid> 结尾，systemd 只加载 *.conf，不会被当成 drop-in。
export function configureReclaudeRouting(server, remotePort, { ssh = runSsh, dryRun = DRY_RUN } = {}) {
  // 路径常量与 drop-in 文本统一来自 proxy-config.mjs，不在这里另写一份。
  const dropinDir = `~/${RECLAUDE_PROXY_DROPIN_DIR}`;
  const dropinPath = `${dropinDir}/${RECLAUDE_PROXY_DROPIN_FILE}`;
  const dropinContent = renderReclaudeProxyDropin(remotePort);
  const writeDropin = wrapSh(buildRemoteReplaceFileCommand({ targetFile: dropinPath, content: dropinContent }));
  const manualReclaude = [
    `mkdir -p ${dropinDir}`,
    `cat > ${dropinPath} <<'EOF'`,
    dropinContent.replace(/\n$/, ""),
    "EOF",
    RECLAUDE_RESTART,
  ].join("\n");

  if (dryRun) {
    dryRunLog(`仅当服务器上有 reclaude 的 systemd --user 服务时：原子写入 ${dropinPath}（mkdir + 备份 + tmp+mv）并重启 reclaude；没有则跳过。内容:\n${dropinContent}ssh ${server.host}:\n${writeDropin}`);
    dryRunLog(`ssh ${server.host}:\n${wrapSh(RECLAUDE_RESTART)}`);
    return "dry-run";
  }

  logInfo("正在检测服务器上的 reclaude systemd --user 服务...");
  const check = ssh(
    server.host,
    wrapSh("command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q '^reclaude\\.service' && echo HAS_RECLAUDE || echo NO_RECLAUDE")
  );
  const hasReclaude = check.status === 0 && /HAS_RECLAUDE/.test(check.stdout || "");
  if (!hasReclaude) {
    logInfo("未检测到 reclaude（没有它的 systemd --user 服务），跳过它的代理设置。以后装了 reclaude，重跑 npm run setup 即可。");
    return "absent";
  }
  const write = ssh(server.host, writeDropin, { timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (write.status !== 0) {
    logError(`写入 ${dropinPath} 失败: ${(write.stderr || "").trim()}`);
    logWarning("请在服务器上手动执行：");
    printManualCommand(manualReclaude);
    return "failed";
  }
  const restart = ssh(server.host, wrapSh(RECLAUDE_RESTART), { timeoutMs: 15000 });
  if (restart.status === 0) {
    logSuccess(`已写入 ${dropinPath} 并重启 reclaude（反向端口 ${remotePort}）`);
    return "written";
  }
  logError(`重启 reclaude 失败: ${(restart.stderr || "").trim()}`);
  logWarning("请在服务器上手动重启：");
  printManualCommand(RECLAUDE_RESTART);
  return "failed";
}

// ---- 集群侧受管配置（v2.54 第 1 期 W-C）----
// 步骤与命令全部来自 lib/cluster-env.mjs 的纯函数（第 3 期 App 内引导复用同一份），这里只负责执行、
// 交互与措辞。顺序有讲究：env.sh 与两处引入块都落地之后，才去注释散落的旧导出——反过来的话中途失败，
// 新开的 shell 会一个代理变量都没有。旧导出不注释也不坏事：引入块在各文件末尾、晚于它们执行，照样覆盖。
// dryRun：写入一律只打印；两次只读探测（扫描旧导出、回读 settings.json）照常执行，预览里列出的就是
// 真实要注释的行与真实要改的键（probeInDryRun:false 关掉探测、只打印模板；连不上服务器时同样退回提示）。
// proxyAuth（v2.64，proxy-credential.mjs 的 readLocalProxyAuth 读出来的 { mode, credential, issue }）：本机的
// 代理口令。按 cluster-env.mjs 的 credentialForEnvRewrite 决定带不带（与 App 内接入引导同一条规则）；带的话
// env.sh 与 settings.json 的内容与 App「把口令写到集群」逐字相同（同一个 buildClusterEnvSteps / planClaudeSettingsMerge），
// 全文经 ssh 的标准输入送达；终端里给人看的预览、手动命令一律打码。不带（没传、本机没有口令、模式是关且集群上
// 没带过）时与以前逐字相同。
// 返回 { status: "ok" | "failed" | "dry-run", steps, strays, claude, proxyCredential }，供测试与调用方汇总；
// proxyCredential 是带口令的原因（"enabled" | "kept" | "unknown"），不带时为 null。
export async function configureClusterEnv(server, remotePort, { dryRun = DRY_RUN, ssh = runSsh, ask = askQuestion, noProxyExtra = [], probeInDryRun = true, proxyAuth = null } = {}) {
  const host = server.host;
  const result = { status: dryRun ? "dry-run" : "ok", steps: [], strays: null, claude: null, proxyCredential: null };
  logInfo(`集群侧受管配置：~/${CLUSTER_ENV_PATH}（反向端口 ${remotePort}）`);
  if (proxyAuth?.issue) {
    logWarning(`本机的代理口令文件${proxyAuth.issue.state === "unreadable" ? "读不出来" : "内容损坏"}（${proxyAuth.issue.reason}），这次写入不带口令。修好后在工作台配置「出网 → 代理口令」里点「把口令写到集群」。`);
  }
  const { credential, reason } = resolveProxyCredential({ host, proxyAuth, ssh, probe: !dryRun || probeInDryRun });
  const opts = { port: remotePort, noProxyExtra, ...(credential ? { credential } : {}) };
  if (credential) {
    result.proxyCredential = reason;
    const note = `一并写入本机的代理口令（${CREDENTIAL_REASONS[reason](proxyAuth.mode)}）：内容经 ssh 的标准输入送达，不进命令行`;
    if (dryRun) dryRunLog(`${note}；下面预览里的口令已打码。`);
    else logInfo(`${note}，终端里也不显示。`);
  }

  for (const step of buildClusterEnvSteps(opts)) {
    if (dryRun) {
      const preview = step.preview ? `写入内容:\n${step.preview}` : "";
      dryRunLog(`${step.title}\n${preview}ssh ${host}:\n${step.command}`);
      result.steps.push({ id: step.id, status: "dry-run" });
      continue;
    }
    // 带口令时 write-env 一步多一个 input（全文经标准输入送达）；其余步骤与不带口令时逐字相同。
    const res = ssh(host, step.command, { timeoutMs: SSH_WRITE_TIMEOUT_MS, ...(step.input != null ? { input: step.input } : {}) });
    if (res?.status === 0) {
      logSuccess(step.id === "write-env" && credential ? `${step.done}，带本机当前的代理口令` : step.done);
      result.steps.push({ id: step.id, status: "ok" });
      continue;
    }
    logError(`${step.title} 失败: ${sshError(res)}`);
    logWarning("请在服务器上手动执行：");
    printManualCommand(step.manual);
    result.steps.push({ id: step.id, status: "failed" });
    if (step.required) {
      logWarning("已中止后续步骤：受管配置没有完整落地之前，不去动散落的旧代理导出与 Claude 设置。");
      result.status = "failed";
      return result;
    }
  }

  if (dryRun && !probeInDryRun) {
    dryRunLog(`ssh ${host}:\n${buildStrayScanCommand()}\n若发现受管块以外的 *_proxy 导出，将逐行列出并询问；确认后逐文件注释掉（先备份）。`);
    dryRunLog(`ssh ${host}:\n${CLAUDE_SETTINGS_READ_COMMAND}\n集群上有 Claude Code 且不是 reclaude 接管时，把代理键合并进 ~/${CLAUDE_SETTINGS_FILE} 的 env（其余键原样保留）。`);
    return result;
  }
  result.strays = await disableStrayProxyExports({ host, dryRun, ssh, ask });
  result.claude = syncClaudeSettings({ host, dryRun, ssh, opts });
  if (!dryRun) {
    logInfo("只对新开的 shell 生效；已在运行的 claude / codex / reclaude 与 Slurm 作业不受影响。");
    // 带口令时只回显 @ 后面的部分：自检不该把口令打到屏幕上。
    logInfo(credential
      ? `自检：ssh ${host} 'bash -lc "echo \\\${HTTPS_PROXY##*@}"'（应为 127.0.0.1:${remotePort}；这样查不会把口令显示出来）`
      : `自检：ssh ${host} 'bash -lc "echo \\$HTTPS_PROXY"'（应为 http://127.0.0.1:${remotePort}）`);
  }
  return result;
}

// 带口令的原因（给人看的那句话）。
const CREDENTIAL_REASONS = {
  enabled: (mode) => `工作台的口令模式是「${PROXY_AUTH_MODE_LABELS[mode] ?? mode}」`,
  kept: () => "口令模式是「关」，集群上那份原来带着口令：照带，以后再打开不用重写",
  unknown: () => "口令模式是「关」，没查到集群上那份带没带口令：照带，多带一个不影响出网",
};

// 这次重写 env.sh 带不带本机的代理口令（规则见 cluster-env.mjs 的 credentialForEnvRewrite）。
// 口令模式打开着就带，不看集群；是关时要看集群上那份原来带没带——只读探测一次，与工作台的只读检测
// （cluster-env-sync 的 inspect）是同一条命令、同一种解析。本机没有口令时一条 SSH 都不多发。
// → { credential, reason: "enabled" | "kept" | "unknown" | null }
function resolveProxyCredential({ host, proxyAuth, ssh, probe }) {
  const stored = proxyAuth?.credential ?? null;
  if (!stored) return { credential: null, reason: null };
  // 集群上明确没带也要带 = 模式打开着。
  const enabled = credentialForEnvRewrite({ stored, mode: proxyAuth.mode, clusterCredential: "none" });
  if (enabled) return { credential: enabled, reason: "enabled" };
  const clusterCredential = probe ? readClusterCredential(host, ssh) : null;
  const credential = credentialForEnvRewrite({ stored, mode: proxyAuth.mode, clusterCredential });
  if (!credential) return { credential: null, reason: null };
  return { credential, reason: clusterCredential === null ? "unknown" : "kept" };
}

// 集群上那份 env.sh 带的口令：指纹 | "nohash" | "none"（没带，或没有这份文件）| null（没查到）。
// 远端只回报指纹，口令不离开集群。
function readClusterCredential(host, ssh) {
  const res = ssh(host, buildEnvPortReadCommand(), { timeoutMs: SSH_READ_TIMEOUT_MS });
  const parsed = res?.status === 0 ? parseEnvPortRead(res.stdout) : null;
  if (!parsed) return null;
  return parsed.present ? parseEnvCredentialRead(res.stdout) : "none";
}

function sshError(res) {
  return String(res?.stderr || res?.error?.message || "").trim() || `退出码 ${res?.status ?? "未知"}`;
}

// 散落的旧代理导出：只读扫描 → 列给用户看 → 确认后逐文件注释掉（默认不做，回车即保留）。
async function disableStrayProxyExports({ host, dryRun, ssh, ask }) {
  const scanCommand = buildStrayScanCommand();
  logInfo("正在扫描各 shell 启动文件里受管块以外的 *_proxy 导出（只读）...");
  const scan = ssh(host, scanCommand, { timeoutMs: SSH_READ_TIMEOUT_MS });
  if (scan?.status !== 0 || !String(scan.stdout || "").includes(STRAY_SCAN_DONE)) {
    logWarning(`扫描失败（${sshError(scan)}），本次不处理散落的旧代理导出。可在服务器上自查：`);
    printManualCommand(scanCommand);
    return { status: "scan-failed", items: [] };
  }
  const items = parseStrayProxyExports(scan.stdout);
  if (!items.length) {
    logSuccess("未发现受管块以外的代理导出。");
    return { status: "none", items };
  }
  logWarning(`发现 ${items.length} 行受管块以外的代理导出（会与受管配置互相覆盖；socks5h:// 本机代理不支持）：`);
  for (const s of items) console.log(`    ~/${s.file}:${s.line}  ${s.text}`);
  const plan = groupStraysByFile(items).map((g) => ({ ...g, command: buildCommentOutCommand(g.file, g.lines) }));
  const label = STRAY_DISABLED_PREFIX.trim();
  if (dryRun) {
    for (const p of plan) dryRunLog(`确认后注释掉 ~/${p.file} 第 ${p.lines.join("、")} 行（先备份，行首加「${label}」）:\nssh ${host}:\n${p.command}`);
    return { status: "dry-run", items };
  }
  if (!(await confirmYes(`是否注释掉以上 ${items.length} 行（行首加「${label}」，先备份原文件，撤销时可原样恢复）？(y/N): `, ask))) {
    logInfo("已保留这些行。受管配置的引入块在各文件末尾、晚于它们执行，新开的 shell 仍以受管配置为准。");
    return { status: "declined", items };
  }
  let failed = 0;
  for (const p of plan) {
    const res = ssh(host, p.command, { timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.status === 0) {
      logSuccess(`已注释掉 ~/${p.file} 第 ${p.lines.join("、")} 行（原文件已备份）`);
      continue;
    }
    failed += 1;
    logError(`注释 ~/${p.file} 失败: ${sshError(res)}`);
    printManualCommand(`请手动在 ~/${p.file} 第 ${p.lines.join("、")} 行行首加 "# "`);
  }
  return { status: failed ? "partial" : "commented", items };
}

// Claude Code：集群上有 claude 时把代理键合并进 ~/.claude/settings.json 的 env；reclaude 接管时不动。
// opts 带口令时（v2.64）写进去的地址带口令：内容照旧经标准输入送达，文件与备份收到 600；给人复制的键打码。
function syncClaudeSettings({ host, dryRun, ssh, opts }) {
  const target = `~/${CLAUDE_SETTINGS_FILE}`;
  const read = ssh(host, CLAUDE_SETTINGS_READ_COMMAND, { timeoutMs: SSH_READ_TIMEOUT_MS });
  const plan = read?.status === 0 ? planClaudeSettingsMerge(read.stdout, opts) : { action: "error", reason: "unreadable" };
  const summary = { action: plan.action, reason: plan.reason, changedKeys: plan.changedKeys };
  // 给人手动加的键：带口令时打码，并说清完整地址去哪找（不带口令时与以前逐字相同）。
  const printManualKeys = () => {
    printManualCommand(maskProxyCredential(JSON.stringify(claudeSettingsProxyEnv(opts), null, 2)));
    if (opts.credential) logInfo(`（口令已打码：完整的地址与集群上 ~/${CLUSTER_ENV_PATH} 里 HTTPS_PROXY 的值相同。）`);
  };
  if (plan.action === "skip" && plan.reason === "no-claude") {
    logInfo("集群上未检测到 Claude Code，跳过 settings.json。");
  } else if (plan.action === "skip" && plan.reason === "reclaude-managed") {
    logInfo(`${target} 的代理由 reclaude 接管（HTTPS_PROXY 指向 reclaude、NODE_EXTRA_CA_CERTS 是 reclaude 证书），保持不动。`);
  } else if (plan.action === "skip") {
    logWarning(`${target} 不是合法 JSON，已跳过以免写坏。需要时手动在顶层 env 对象里加入：`);
    printManualKeys();
  } else if (plan.action === "error") {
    logWarning(`回读 ${target} 失败（${sshError(read)}），跳过 Claude Code 设置。`);
  } else if (plan.action === "unchanged") {
    logSuccess(`${target} 的代理键已是目标值，无需改动。`);
  } else if (dryRun) {
    const mode = opts.credential ? "旧文件备份；带口令，文件与备份的权限收到 600" : "旧文件备份、权限不变";
    dryRunLog(`将改写 ${target} 的 env 键 ${plan.changedKeys.join(", ")}（其余键原样保留；内容经标准输入送达，共 ${Buffer.byteLength(plan.input, "utf8")} 字节，${mode}）:\nssh ${host}:\n${plan.command}`);
  } else {
    const res = ssh(host, plan.command, { input: plan.input, timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.status === 0) {
      logSuccess(`已把代理键 ${plan.changedKeys.join(", ")} 合并进 ${target}（其余键保留，旧文件已备份）。`);
    } else {
      summary.action = "failed";
      logError(`写入 ${target} 失败: ${sshError(res)}（原文件未改动）`);
      logWarning("需要时手动在顶层 env 对象里加入：");
      printManualKeys();
    }
  }
  return summary;
}

// ---- zcode: 设置文件合并写入（v2.13.0）----
// ZCode 远程模式的模型请求发自集群上的 zcode-server；它的代理配置不走环境变量，
// 而是读自己的 $HOME/.zcode/v2/setting.json（schema 键 httpProxy / httpProxyNoProxy）。
// server 由 sshd 非交互拉起，.bashrc 的交互守卫注入对它不生效，必须直接写设置文件。
// 流程：SSH 读回现有内容 → 本地浅合并（其余键保留）→ 原子替换写回。远端文件损坏
// （非法 JSON）时告警跳过，绝不覆盖写坏。
// 是否用过 ZCode：它的一切都在 ~/.zcode 下（server 在 ~/.zcode/server，设置在 ~/.zcode/v2）。
// 目录不存在 = 这个账号没用过 ZCode，不替他建。
export const ZCODE_DETECT_COMMAND = wrapSh('if [ -d "$HOME/.zcode" ]; then echo HAS_ZCODE; else echo NO_ZCODE; fi');

export function configureZcodeRouting(server, remotePort, { ssh = runSsh, dryRun = DRY_RUN } = {}) {
  const zcodeSettingsPath = "~/.zcode/v2/setting.json";
  const zcodePatch = zcodeProxySettingsPatch(remotePort);
  const zcodeReadCmd = wrapSh(`cat ${zcodeSettingsPath} 2>/dev/null || printf ''`);

  if (dryRun) {
    dryRunLog(`ssh ${server.host}:\n${ZCODE_DETECT_COMMAND}`);
    dryRunLog(`仅当服务器上已有 ~/.zcode（用过 ZCode）时：把代理键 ${JSON.stringify(zcodePatch)} 浅合并进 ${zcodeSettingsPath}（备份 + tmp+mv 原子替换，其余键原样保留）；没有则跳过。\n${wrapSh(buildRemoteReplaceFileCommand({ targetFile: zcodeSettingsPath, content: mergeZcodeSettings("", zcodePatch) }))}`);
    return "dry-run";
  }

  const detect = ssh(server.host, ZCODE_DETECT_COMMAND);
  if (!(detect.status === 0 && /HAS_ZCODE/.test(detect.stdout || ""))) {
    logInfo("未检测到 ZCode（服务器上没有 ~/.zcode），跳过它的代理设置。以后用上了 ZCode，重跑 npm run setup 即可。");
    return "absent";
  }

  logInfo(`正在读取服务器上 ${zcodeSettingsPath} 并注入 zcode 反向通道代理...`);
  const current = ssh(server.host, zcodeReadCmd, { timeoutMs: SSH_WRITE_TIMEOUT_MS });
  const merged = mergeZcodeSettings(current.stdout ?? "", zcodePatch);
  if (!merged) {
    logWarning(`${zcodeSettingsPath} 不是合法 JSON，已跳过自动写入以免破坏现有配置。请手动在顶层对象加入：${JSON.stringify(zcodePatch)}`);
    return "invalid-json";
  }
  const write = ssh(server.host, wrapSh(buildRemoteReplaceFileCommand({ targetFile: zcodeSettingsPath, content: merged })), { timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (write.status === 0) {
    logSuccess(`已向 ${zcodeSettingsPath} 合并写入 httpProxy=http://127.0.0.1:${remotePort}（其余键保留，旧文件已备份）。重连 ZCode 远程会话后生效。`);
    return "written";
  }
  logError(`写入 ${zcodeSettingsPath} 失败: ${(write.stderr || "").trim()}`);
  logWarning("请在服务器上手动在该文件顶层对象加入：");
  printManualCommand(JSON.stringify(zcodePatch));
  return "failed";
}
