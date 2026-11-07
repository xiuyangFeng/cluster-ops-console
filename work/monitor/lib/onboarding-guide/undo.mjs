// 撤销接入的编排：命令行 `npm run setup:undo`（scripts/setup-undo.mjs）与配置 →「接入引导」下面的「撤销接入」
// （./access.mjs）共用这一份。原先整段在 scripts/ 里；运行时代码不能 import scripts/，所以下沉到这里，
// 脚本改成只接终端的薄封装（行为与输出逐字不变）。
//
// 步骤与命令全部来自 lib/cluster-env.mjs 的 buildUndoCommands（与向导第 4 步互为逆操作，各步幂等、
// 可重复执行）：删各 shell 启动文件里的引入块 → 删 env.sh 与 keys/ → 恢复当初被注释掉的旧代理导出 →
// 从 ~/.claude/settings.json 的 env 里删掉我们写的代理键。之后可选释放端口登记（port-registry.mjs 的
// buildReleaseCommand，默认保留）；选择释放时同时把这个端口从本机个人配置里拿掉——否则下次启动仍会往这个
// 已经不属于自己的端口建隧道。
// 向导中途 Ctrl+C / 断网留下半截状态时也用它收拾：向导本身没有断点续接，重跑或撤销都从头逐步执行。
//
// 不在这里处理、只在结尾列出的：authorized_keys 里的公钥（删了本工具就连不上，属于"彻底退出"）、
// 集群上装好的 CLI 与登录凭证、本机的 config.local.json / 专用密钥 / ~/.ssh/config 条目。
//
// 执行器、日志、确认全部注入：
//   ssh(host, command, { timeoutMs, input }) → { status, stdout, stderr, error? }（同步值或 Promise 都行）
//   ui { header, line, info, success, warning, error, dryRun, manual }   终端输出；界面不传（静默）
//   confirm(question) → Promise<boolean>
//   clearLocalPort(localConfigPath, serverId) → 是否拿掉了（同步值或 Promise；抛错 = 没拿掉）
// 两个调用方的差别只在三个开关：
//   assumeYes      界面已经在确认框里确认过，不再问「确认撤销以上内容？」
//   releasePort    不给 = 问（命令行）；true / false = 已经选好（界面上的勾选）
//   stopOnFailure  界面：任何一步没做成就停在那里，后面的（含释放端口）都不做。命令行沿用原行为，继续做完。
import { buildUndoCommands, CLAUDE_SETTINGS_FILE, CLUSTER_ENV_DIR } from "../cluster-env.mjs";
import { buildReleaseCommand, parseReleaseResult } from "../port-registry.mjs";

export const UNDO_SSH_WRITE_TIMEOUT_MS = 20000;
export const UNDO_SSH_READ_TIMEOUT_MS = 15000;

const SILENT_UI = Object.freeze({ header() {}, line() {}, info() {}, success() {}, warning() {}, error() {}, dryRun() {}, manual() {} });

function sshError(res) {
  return String(res?.stderr || res?.error?.message || "").trim() || `退出码 ${res?.status ?? "未知"}`;
}

// 撤销之后仍留在两端的东西：逐条给出自查 / 清理命令，由用户自己决定删不删。带 id 是给界面用的——
// 界面知道隧道接下来会怎样（随端口一起停 / 端口保留所以还在跑），「隧道」那一条要换成对得上的说法。
export function leftoverItems({ host, port } = {}) {
  return [
    { id: "authorized-keys", text: `集群上的公钥（删掉后本工具无法再免密登录）：ssh ${host} 'grep -n "" ~/.ssh/authorized_keys'，找到本机那一行手动删除` },
    { id: "cli", text: "集群上装的命令行工具与登录凭证：~/.local/bin/{codex,claude}、~/.codex、~/.claude、~/.claude.json、~/.local/share/claude、~/.cache/cluster-workbench、~/.cache/claude" },
    { id: "downloads", text: `取消下载留下的半截文件：ssh ${host} 'ls -la ~/.cache/cluster-workbench ~/.local/share/claude 2>/dev/null'` },
    { id: "backups", text: `各 shell 启动文件与 settings.json 的备份：ssh ${host} 'ls -la ~/.bashrc.bak.* ~/.profile.bak.* ~/.bash_profile.bak.* ~/.claude/settings.json.bak.* 2>/dev/null'` },
    { id: "tunnel", text: port ? `确认隧道已停、端口不再监听：ssh ${host} 'ss -ltn | grep ${port}'（应无输出）` : "确认隧道已停：在工作台里停止隧道，或退出工作台" },
    { id: "local", text: "本机：config.local.json（个人配置）、~/.ssh/id_ed25519_codextunnel*（向导新建密钥时才有）、~/.ssh/config 里对应的 Host 段" },
  ];
}

// 命令行结尾打印的那份清单（只要文字）。
export function leftoverChecklist(options) {
  return leftoverItems(options).map((item) => item.text);
}

// 纯函数：从个人层对象里拿掉这台服务器的端口分配（portOverrides 删空则去掉这个键）。没有可删的返回 null。
export function dropPortOverride(localConfig, serverId) {
  const overrides = localConfig?.portOverrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || !Object.hasOwn(overrides, serverId)) return null;
  const { [serverId]: _dropped, ...rest } = overrides;
  const next = { ...localConfig, portOverrides: rest };
  if (!Object.keys(rest).length) delete next.portOverrides;
  return next;
}

// 这一次撤销要做的集群侧步骤（buildUndoCommands 的原样产物）。
// 没有端口时 settings.json 里哪些键是我们写的无从比对（比的是"值仍等于我们写的代理地址"），这一步跳过。
export function planUndoSteps({ port = null, noProxyExtra = [] } = {}) {
  return buildUndoCommands({ port, noProxyExtra }).filter((step) => port != null || step.kind !== "settings-edit");
}

// 返回 { status, steps, release, releaseError, localPortCleared, localPortError, stoppedAt }：
//   status  "ok" | "failed" | "dry-run" | "declined"——任何一步（含释放端口、清本机端口）没做成都是 "failed"
//   steps   [{ id, status: "ok" | "failed" | "skipped" | "unchanged" | "dry-run", error?, exitCode?, manual?, changedKeys?, reason? }]
//           error 是失败原因的原文，exitCode 是那条命令的退出码（255 / 没有 = ssh 自己没连上；其余 = 命令在服务器上
//           跑了、是它自己失败的），manual 是失败时可以手动执行的命令，changedKeys 是 settings.json 里（将）删的键，
//           reason 是跳过 / 没读到的原因
//   release "kept" | "ok" | "absent" | "not-owner" | "failed" | "unknown" | "dry-run" | null（没有端口，或没走到这一步）
//   localPortCleared  本机个人配置里的端口是否已拿掉（只在选择释放、且集群侧结论明确时才动）
//   stoppedAt  stopOnFailure 下停在了哪一步（步骤 id / "release-port"）；没停是 null
// onProgress 在每一步开始与结束时各调用一次（界面逐步显示用）：
//   { phase: "step", id, status: "running" | 上面的结果… } / { phase: "release", status, error?, exitCode? } / { phase: "local-port", status, error? }
export async function undoClusterSetup(server, {
  port = null,
  noProxyExtra = [],
  registryDir,
  localConfigPath,
  dryRun = false,
  ssh,
  ui = SILENT_UI,
  confirm = async () => false,
  clearLocalPort = () => false,
  assumeYes = false,
  releasePort,
  stopOnFailure = false,
  onProgress = () => {},
} = {}) {
  const host = server.host;
  ui.header(`撤销 ${host} 上的集群侧受管配置`);
  const steps = planUndoSteps({ port, noProxyExtra });
  for (const step of steps) ui.line(`  · ${step.title}`);
  if (port == null) ui.warning(`个人配置里没有这台服务器的反向端口，~/${CLAUDE_SETTINGS_FILE} 里的代理键不会自动删除，请自行检查。`);
  ui.info("只影响新开的 shell；已在运行的 codex / claude 与 Slurm 作业不受影响。装好的命令行工具、登录凭证与公钥不会动。");

  const result = { status: dryRun ? "dry-run" : "ok", steps: [], release: null, releaseError: null, localPortCleared: false, localPortError: null, stoppedAt: null };
  if (!dryRun && !assumeYes && !(await confirm("确认撤销以上内容？(y/N): "))) {
    ui.info("已取消，什么都没改。");
    result.status = "declined";
    return result;
  }

  // 进度回调出错不该打断撤销本身。
  const notify = (event) => {
    try {
      onProgress(event);
    } catch {}
  };
  const record = (entry) => {
    result.steps.push(entry);
    notify({ phase: "step", ...entry });
  };
  const fail = (at) => {
    result.status = "failed";
    if (stopOnFailure) result.stoppedAt = at;
  };

  for (const step of steps) {
    if (result.stoppedAt) break;
    if (!dryRun) notify({ phase: "step", id: step.id, status: "running" });
    if (step.kind === "remote") {
      if (dryRun) {
        ui.dryRun(`${step.title}\nssh ${host}:\n${step.command}`);
        record({ id: step.id, status: "dry-run" });
        continue;
      }
      const res = await ssh(host, step.command, { timeoutMs: UNDO_SSH_WRITE_TIMEOUT_MS });
      if (res?.status === 0) {
        ui.success(step.title);
        record({ id: step.id, status: "ok" });
      } else {
        ui.error(`${step.title} 失败: ${sshError(res)}`);
        ui.warning("请在服务器上手动执行：");
        ui.manual(step.command);
        record({ id: step.id, status: "failed", error: sshError(res), exitCode: res?.status ?? null, manual: step.command });
        fail(step.id);
      }
      continue;
    }
    // settings-edit：回读是只读的，dry-run 下照常执行，预览里列出的就是真实要删的键。
    const read = await ssh(host, step.readCommand, { timeoutMs: UNDO_SSH_READ_TIMEOUT_MS });
    const plan = read?.status === 0 ? step.plan(read.stdout) : { action: "error" };
    if (plan.action === "write" && dryRun) {
      ui.dryRun(`${step.title}：将删除 ${plan.changedKeys.join(", ")}\nssh ${host}:\n${plan.command}`);
      record({ id: step.id, status: "dry-run", changedKeys: plan.changedKeys });
    } else if (plan.action === "write") {
      const res = await ssh(host, plan.command, { input: plan.input, timeoutMs: UNDO_SSH_WRITE_TIMEOUT_MS });
      if (res?.status === 0) {
        ui.success(`已从 ~/${CLAUDE_SETTINGS_FILE} 的 env 删除 ${plan.changedKeys.join(", ")}（其余键保留，旧文件已备份）`);
        record({ id: step.id, status: "ok", changedKeys: plan.changedKeys });
      } else {
        ui.error(`改写 ~/${CLAUDE_SETTINGS_FILE} 失败: ${sshError(res)}（原文件未改动）`);
        record({ id: step.id, status: "failed", error: sshError(res), exitCode: res?.status ?? null });
        fail(step.id);
      }
    } else if (plan.action === "error") {
      ui.warning(`回读 ~/${CLAUDE_SETTINGS_FILE} 失败（${sshError(read)}），这一步没做，请自行检查其中的代理键。`);
      record({ id: step.id, status: "failed", error: sshError(read), exitCode: read?.status ?? null, reason: "unreadable" });
      if (!dryRun) fail(step.id);
    } else if (plan.action === "skip") {
      ui.info(`~/${CLAUDE_SETTINGS_FILE}：${plan.reason === "no-claude" ? "集群上没有 Claude Code，无需处理" : `已跳过（${plan.reason}），保持不动`}。`);
      record({ id: step.id, status: "skipped", reason: plan.reason });
    } else {
      ui.success(`~/${CLAUDE_SETTINGS_FILE} 里没有我们写入的代理键，无需改动。`);
      record({ id: step.id, status: "unchanged" });
    }
  }

  if (port != null && !result.stoppedAt) {
    const released = await releaseRegistration({ host, port, registryDir, dryRun, ssh, ui, confirm, decided: releasePort, notify });
    result.release = released.status;
    result.releaseError = released.error;
    if (result.release === "failed" || result.release === "unknown") fail("release-port");
    // 集群侧结论明确（已释放 / 本来就没登记 / 登记在别人名下）：这个端口都不该再留在本机配置里。
    // 释放失败时不动本机——登记还在自己名下，配置与登记保持一致，修好网络后重跑即可。
    if (["ok", "absent", "not-owner"].includes(result.release)) {
      try {
        result.localPortCleared = await clearLocalPort(localConfigPath, server.id);
        if (result.localPortCleared) {
          ui.success(`已从本机个人配置里拿掉端口 ${port}：下次启动不会再往这个端口建隧道，引导卡会提示重新领取（npm run setup）。`);
          ui.warning("工作台如果还开着，请现在停止隧道或退出工作台——正在运行的隧道仍占着这个端口。");
        }
        notify({ phase: "local-port", status: result.localPortCleared ? "ok" : "unchanged" });
      } catch (err) {
        ui.error(`没能从本机个人配置里拿掉端口 ${port}（${err.message}）。请手动删除 ${localConfigPath} 里 portOverrides 的 "${server.id}" 一项，否则下次启动仍会使用这个端口。`);
        result.status = "failed";
        result.localPortError = err.message;
        notify({ phase: "local-port", status: "failed", error: err.message });
      }
    }
  }

  if (!dryRun && result.status === "ok") ui.success(`集群侧受管配置已撤销（~/${CLUSTER_ENV_DIR} 已删除）。想恢复：重跑 npm run setup。`);
  ui.info("以下内容不会自动处理，按需自查：");
  for (const line of leftoverChecklist({ host, port })) ui.line(`  · ${line}`);
  return result;
}

// 端口登记默认保留：只是暂时不用的话，下次向导会沿用同一个端口；释放后别人可以领走它。
// decided：不给 = 问；true / false = 调用方已经选好。→ { status, error }
async function releaseRegistration({ host, port, registryDir, dryRun, ssh, ui, confirm, decided, notify }) {
  const command = buildReleaseCommand(registryDir, port);
  if (dryRun) {
    ui.dryRun(`可选（默认不做）：释放端口登记 ${port}，并从本机个人配置的 portOverrides 里拿掉它\nssh ${host}:\n${command}`);
    return { status: "dry-run", error: null };
  }
  const yes = decided === undefined
    ? await confirm(`是否同时释放端口登记 ${port}？释放后别人可以领走它，本机配置里的这个端口也会一并拿掉；释放前请先停掉本机隧道。(y/N): `)
    : decided === true;
  if (!yes) {
    ui.info(`端口登记 ${port} 保留，下次运行 npm run setup 会沿用。`);
    return { status: "kept", error: null };
  }
  notify({ phase: "release", status: "running" });
  const res = await ssh(host, command, { timeoutMs: UNDO_SSH_WRITE_TIMEOUT_MS });
  const status = res?.status === 0 ? parseReleaseResult(res.stdout).status : "failed";
  let error = null;
  if (status === "ok") ui.success(`已释放端口登记 ${port}。`);
  else if (status === "absent") ui.info(`登记目录里没有端口 ${port} 的登记（可能是登记目录建好之前分配的），无需释放。`);
  else if (status === "not-owner") ui.warning(`端口 ${port} 登记在别人名下，没有动那份登记——本机不该继续用它。`);
  else {
    error = res?.status === 0 ? "服务器没有给出明确结论" : sshError(res);
    ui.error(`释放端口登记 ${port} 失败（${error}）。登记与本机配置都没有改动，网络恢复后重跑 npm run setup:undo。`);
  }
  notify({ phase: "release", status, error, exitCode: res?.status ?? null });
  return { status, error };
}
