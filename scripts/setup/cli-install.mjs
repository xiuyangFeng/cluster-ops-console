// scripts/setup/cli-install.mjs —— 向导第 5 步（可跳过）：检测 / 安装集群上的 Codex 与 Claude Code（v2.57 第 2 期）。
//
// 流程与工作台设置页「命令行工具」完全同一套（work/monitor/lib/cli/）：预检 → 首选在集群上经隧道跑官方
// 安装器（后台，SSH 断开不影响）→ 失败 / 卡住回退本机下载官方同款产物、校验后经 stdin 上传 → 旧版本保留。
// 这里只负责：查最新版（按个人层的出网设置）、逐个显示现状、问要不要装 / 更新、在终端里刷进度。
// 只读检测在 --dry-run 下照常执行（与 routing 的扫描一致）；安装一律只打印、不执行。
// 远端命令都来自 lib/cli/remote-scripts.mjs（已经 wrapSh 包成 sh -c）；SSH 用 BatchMode（密钥已在第 2 步打通）。
// 安装进行中按 Ctrl+C：走与工作台「取消」同一条清理路径（runInstallJob 的取消信号——结束集群上的官方安装
// 任务 / 停下载并删掉本机的半截文件 / 杀上传并清集群上的半截文件），清理完以 130 退出向导；落盘 / 切软链
// 期间不可取消，只提示等它跑完。再按一次 Ctrl+C 不等清理直接退出。
import os from "node:os";
import path from "node:path";

import { CLI_IDS, getCli, isUpdateAvailable } from "../../work/monitor/lib/cli/catalog.mjs";
import { cancelBlockReason, createJobState, runInstallJob, uploadViaSsh } from "../../work/monitor/lib/cli/install.mjs";
import { resolveEgressUpstream } from "../../work/monitor/lib/cli/net.mjs";
import { buildPreflightCommand, parsePreflight } from "../../work/monitor/lib/cli/remote-scripts.mjs";
import { buildInstallDeps, newJobId } from "../../work/monitor/lib/cli/install-service.mjs";
import { createCliVersionsService } from "../../work/monitor/lib/cli/versions.mjs";
import { execFileWithInput } from "../../work/monitor/lib/exec.mjs";
import { createSystemProxyDetector } from "../../work/monitor/lib/proxy/system-proxy.mjs";
import { defaultLocalConfigPath, readLocalConfigObject } from "./local-config.mjs";
import { askQuestion, bold, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

// 本机下载缓存（可续传）：向导与工作台分开放，向导不碰 App 的数据目录。
export const WIZARD_DOWNLOAD_DIR = path.join(os.tmpdir(), "cluster-workbench-cli-downloads");

export function sshArgsForHost(hostAlias) {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "-o", "ServerAliveInterval=30", hostAlias];
}

// 向导用的远端执行器：异步（安装要边轮询边刷进度），永不 reject。
export function wizardRemote(hostAlias, { exec = execFileWithInput } = {}) {
  return (command, { timeoutMs = 60000 } = {}) => exec("ssh", [...sshArgsForHost(hostAlias), command], { input: "", timeoutMs, maxOutputBytes: 256 * 1024 });
}

// 纯函数：一行现状。
export function describePreflight(id, pf, latest) {
  const label = getCli(id).label;
  if (!pf?.complete) return `${label}：检测失败（连不上服务器）`;
  const installed = pf.currentVersion ? `已装 ${pf.currentVersion}` : pf.visible === "file" || pf.npmPaths.length ? "有非官方独立安装的版本" : "未安装";
  const tail = !latest ? "（最新版本查不到）" : pf.currentVersion && !isUpdateAvailable(pf.currentVersion, latest) ? "，已是最新" : `，最新 ${latest}`;
  return `${label}：${installed}${tail}`;
}

// 纯函数：这次要不要问、怎么问（null = 不用问）。
export function installPrompt(id, pf, latest) {
  if (!pf?.complete) return null;
  const label = getCli(id).label;
  if (!pf.currentVersion) return `在集群上安装 ${label}${latest ? ` ${latest}` : ""}？[y/N]（回车跳过）`;
  if (latest && isUpdateAvailable(pf.currentVersion, latest)) return `把 ${label} 从 ${pf.currentVersion} 更新到 ${latest}？[y/N]（回车跳过）`;
  return null;
}

// 进度一行（\r 覆盖刷新）。
function progressLine(job) {
  const p = job.progress;
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  let text = `  ${job.phaseText}`;
  if (p) {
    text += ` ${p.total ? `${mb(p.bytes)}/${mb(p.total)}` : mb(p.bytes)}`;
    if (p.speedBps) text += ` ${Math.round(p.speedBps / 1024)}KB/s`;
    if (p.etaSec != null) text += ` 剩余约 ${Math.max(1, Math.round(p.etaSec / 60))} 分钟`;
  }
  return text;
}

// 安装期间临时接管 Ctrl+C（SIGINT），返回解除函数。终端里按 Ctrl+C 时前台进程组里的 ssh 子进程也会收到
// SIGINT 而退出——在途的那条远端命令就此中断，流程会按「回话丢了」处理；清理用的命令是之后新起的，不受影响。
function onSigint(handler) {
  process.on("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

// 返回 { status: "ok" | "skipped" | "dry-run" | "failed" | "cancelled", results: [{ id, action, status, version?, error? }] }。
// cancelled：安装途中按了 Ctrl+C，清理完成后经 exit(130) 退出向导（exit 可注入，单测里不真退）。
export async function installClis(server, {
  dryRun = DRY_RUN,
  ask = askQuestion,
  remote = wizardRemote(server.host),
  upload = ({ command, filePath, onProgress, signal }) => uploadViaSsh({ args: [...sshArgsForHost(server.host), command], filePath, onProgress, signal }),
  getUpstream = async () => resolveEgressUpstream({ egress: readLocalConfigObject(defaultLocalConfigPath()).egress, detector: createSystemProxyDetector() }),
  versions = createCliVersionsService({ getUpstream }),
  runJob = runInstallJob,
  downloadDir = WIZARD_DOWNLOAD_DIR,
  write = (text) => process.stdout.write(text),
  onInterrupt = onSigint,
  exit = (code) => process.exit(code),
} = {}) {
  logHeader("5. 检测 / 安装命令行工具（Codex / Claude Code，可跳过）");
  const latest = await versions.getLatest({ waitMs: 20000 });
  const results = [];
  const deps = buildInstallDeps({ remote, upload, getUpstream, downloadDir, makeJobId: newJobId });
  for (const id of CLI_IDS) {
    const pf = parsePreflight(id, (await remote(buildPreflightCommand(id), { timeoutMs: 60000 }))?.stdout);
    const target = latest[id]?.latest ?? null;
    logInfo(describePreflight(id, pf, target));
    for (const p of pf.npmPaths || []) logWarning(`  检测到 npm 全局安装：${p}（与独立安装并存时 PATH 里靠前的那个生效；向导不会卸载它）`);
    const question = installPrompt(id, pf, target);
    if (!question) {
      results.push({ id, action: "none", status: pf.complete ? "ok" : "failed" });
      continue;
    }
    if (dryRun) {
      dryRunLog(`将询问：${question}；确认后在集群上经隧道运行官方安装器（失败回退本机下载 → 上传）`);
      results.push({ id, action: "dry-run", status: "dry-run" });
      continue;
    }
    const answer = String(await ask(question)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      results.push({ id, action: "skip", status: "skipped" });
      continue;
    }
    const verb = pf.currentVersion ? "更新" : "安装";
    logInfo(`开始${verb} ${bold(getCli(id).label)}：官方安装包${id === "claude" ? "约 250MB" : "约 160MB"}，隧道慢时要等较久。想中止按 Ctrl+C（会先停掉集群上的安装任务、清理半截文件再退出）。`);
    const job = createJobState({ jobId: newJobId(), serverId: server.id, cli: id, targetVersion: target });
    let lastLine = "";
    let lastPhase = "";
    let lastAt = 0;
    // 换阶段立即刷；同一阶段内的进度至多每秒刷一次。
    const onUpdate = (j) => {
      const line = progressLine(j);
      const now = Date.now();
      if (line === lastLine || (j.phase === lastPhase && now - lastAt < 1000)) return;
      lastLine = line;
      lastPhase = j.phase;
      lastAt = now;
      write(`\r${line.padEnd(72).slice(0, 100)}`);
    };
    // Ctrl+C：第一次 = 请求取消（能取消就发信号，流程自己清理；落盘 / 切软链期间只说明原因）；
    // 第二次 = 不等了，直接退出。
    const controller = new AbortController();
    let presses = 0;
    const unhook = onInterrupt(() => {
      presses += 1;
      write("\n");
      if (presses > 1) {
        logWarning("再次收到 Ctrl+C：不等清理，直接退出。集群上若还有没停掉的安装任务，之后在工作台「配置 → 命令行工具」点安装会接着跟踪它。");
        exit(130);
        return;
      }
      const blocked = cancelBlockReason(job);
      if (blocked) {
        logWarning(`${blocked}。（再按一次 Ctrl+C 强制退出，可能停在切换到一半的状态）`);
        return;
      }
      logInfo("收到 Ctrl+C：正在取消并清理（停掉集群上的安装任务 / 删除半截文件），请稍等；再按一次直接退出。");
      controller.abort();
    });
    try {
      await runJob(job, deps, { onUpdate, signal: controller.signal });
    } finally {
      unhook();
    }
    write("\n");
    for (const w of job.warnings) logWarning(`  ${w}`);
    if (job.status === "cancelled") {
      logWarning(`${getCli(id).label} 的${verb}${job.events.at(-1)?.text || "已取消。"}`);
      results.push({ id, action: pf.currentVersion ? "update" : "install", status: "cancelled" });
      // Ctrl+C 的本意是退出向导：清理做完了，按惯例以 130 退出，后面的步骤不再继续。
      exit(130);
      return { status: "cancelled", results };
    }
    if (job.status === "succeeded") {
      logSuccess(`${getCli(id).label} ${job.installedVersion} 已就绪（${job.path === "official" ? "集群经隧道运行官方安装器" : "本机下载后上传"}${job.fellBack ? `；首选路径：${job.fallbackReason}` : ""}）`);
      results.push({ id, action: pf.currentVersion ? "update" : "install", status: "ok", version: job.installedVersion });
    } else {
      logError(`${getCli(id).label} 没有装好：${job.error}`);
      logInfo("可以稍后在工作台「配置 → 命令行工具」里重试，进度会接着显示。");
      results.push({ id, action: pf.currentVersion ? "update" : "install", status: "failed", error: job.error });
    }
  }
  const status = dryRun ? "dry-run" : results.some((r) => r.status === "failed") ? "failed" : results.every((r) => r.status === "skipped" || r.action === "none") ? "skipped" : "ok";
  return { status, results };
}
