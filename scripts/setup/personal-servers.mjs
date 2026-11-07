// scripts/setup/personal-servers.mjs —— 可选步骤：添加个人服务器（可重复）。设计 §6.9。
// 个人服务器只写进用户自己的 config.local.json，不进团队 config.json —— 同事克隆仓库后
// 既看不到、也不会去探测它（这正是 v2.17 之前把腾讯云/阿里云塞进团队层的毛病）。
// 所有外部依赖（提问 / SSH / 连通性探测 / 路径 / 时间）都可注入：单测里用假实现即可完整
// 走完一遍流程，既不连任何服务器，也不碰真实 ~/.ssh/config 与真实 config.local.json。
import { pickReversePort } from "../../work/monitor/lib/reverse-port.mjs";
import { assertSafeHost, assertSafePort, assertSafeSshUser } from "../../work/monitor/lib/ssh-args.mjs";
import { confirmYes } from "../lib/prompt.mjs";
import { confirmAndPinHostKey } from "./host-keys.mjs";
import { defaultLocalConfigPath, PERSONAL_SERVER_ID_RE, persistLocalConfig, readLocalConfigObject, upsertPersonalServer } from "./local-config.mjs";
import { assertPortNotTeamReserved, readRemoteListeningPorts } from "./port-assignment.mjs";
import { readSshConfigFile, sshConfigPath, upsertSshConfigBlock, writeSshConfigFile } from "./ssh-config.mjs";
import { probeSshConnection, runSsh } from "./ssh-probe.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

export async function addPersonalServers({
  localConfigPath = defaultLocalConfigPath(),
  sshConfigPath: sshConfigTarget = sshConfigPath,
  teamRemotePorts = [],
  teamSshUser = "",
  identityFile = undefined,
  dryRun = DRY_RUN,
  ask = askQuestion,
  ssh = runSsh,
  testSsh = (alias) => probeSshConnection(alias).ok,
  pinHostKey = confirmAndPinHostKey,
} = {}) {
  logHeader("添加个人服务器（可选，可重复）");
  logInfo("这里加的服务器只写进您自己的 config.local.json（.gitignore 已排除），不会进团队 config.json，同事看不到也不会探测它。");
  logInfo(`控制台会给它们打上"个人"徽标；选择"只监控不建隧道"的条目写入 tunnel:false，只出现在面板上，不占反向端口。`);

  const ctx = { localConfigPath, sshConfigTarget, teamRemotePorts, teamSshUser, identityFile, dryRun, ask, ssh, testSsh, pinHostKey };
  let added = 0;
  for (;;) {
    const go = await confirmYes(added === 0
      ? "是否现在添加一台只属于您自己的服务器？(y/N): "
      : "继续添加下一台个人服务器？(y/N): ", ask);
    if (!go) break;
    // 单台失败（输入非法/用户中途放弃）不该终止整个步骤，用户可以接着再试一台。
    const ok = await addOnePersonalServer(ctx);
    if (ok) added++;
  }
  if (added === 0) logInfo("未添加个人服务器（随时可以重跑 npm run setup 再加）。");
  else logSuccess(`本次写入 ${added} 台个人服务器；启动控制台后可在服务器卡上看到"个人"徽标。`);
  return added;
}

// 第 1-2 步：逐项提问并校验。不合法的输入由校验函数抛错（调用方统一报错、跳过本台）；
// 用户留空 / 选择不覆盖等主动放弃返回 null。这一段只有提问与读个人层，不碰 SSH。
async function askPersonalServerInput({ localConfigPath, ask }) {
  // ---- 1. 别名 / id ----
  const alias = String(await ask("请输入这台服务器的 SSH 别名（会写进 ~/.ssh/config 的 Host，例如 tengxunserver）: ")).trim();
  if (!alias) {
    logWarning("未输入别名，已跳过本次添加。");
    return null;
  }
  assertSafeHost(alias, "个人服务器别名");
  let id = alias;
  if (!PERSONAL_SERVER_ID_RE.test(id)) {
    id = String(await ask("该别名不能直接当配置 id（只允许字母/数字/. _ -），请另外输入一个 id: ")).trim();
    if (!PERSONAL_SERVER_ID_RE.test(id)) {
      logError(`id ${JSON.stringify(id)} 非法，已跳过本次添加。`);
      return null;
    }
  }

  const local = readLocalConfigObject(localConfigPath);
  const existing = (Array.isArray(local.servers) ? local.servers : []).find((s) => s?.id === id);
  if (existing) {
    if (!(await confirmYes(`个人层已存在 id "${id}"（${existing.host || "无 host"}），是否覆盖它？(y/N): `, ask))) {
      logInfo("已保留原有条目，跳过本次添加。");
      return null;
    }
    logWarning(`将覆盖个人层条目 "${id}"（本次没问到的字段保留原值）。`);
  }

  // ---- 2. 真实地址 / 端口 / 用户名 ----
  const hostName = String(await ask("请输入服务器的真实 IP 地址或域名: ")).trim();
  if (!hostName) {
    logWarning("未输入 IP/域名，已跳过本次添加。");
    return null;
  }
  assertSafeHost(hostName, "个人服务器地址");
  const portInput = String(await ask("请输入 SSH 端口号 (默认 22): ")).trim();
  const sshPort = portInput ? assertSafePort(portInput, "个人服务器 SSH 端口") : 22;
  const sshUser = String(await ask("请输入该服务器的 SSH 登录用户名（不要用本机系统用户名）: ")).trim();
  if (!sshUser) {
    logWarning("未输入 SSH 用户名，已跳过本次添加（绝不把本机 OS 用户名写进配置）。");
    return null;
  }
  assertSafeSshUser(sshUser);
  const displayName = String(await ask(`请输入显示名称（回车用 "${alias}"）: `)).trim() || alias;
  return { alias, id, local, hostName, sshPort, sshUser, displayName };
}

async function addOnePersonalServer(ctx) {
  const { localConfigPath, sshConfigTarget, teamRemotePorts, teamSshUser, identityFile, dryRun, ask, ssh, testSsh, pinHostKey } = ctx;

  let input;
  try {
    input = await askPersonalServerInput(ctx);
  } catch (err) {
    logError(err.message);
    return false;
  }
  if (!input) return false;
  const { alias, id, local, hostName, sshPort, sshUser, displayName } = input;

  if (!await pinHostKey(hostName, sshPort, { ask, dryRun })) return false;

  // ---- 3. 写 ~/.ssh/config 块（复用团队服务器同一套 upsert：剥旧段 + 原子写回，幂等）----
  const nextSshConfig = upsertSshConfigBlock(readSshConfigFile(sshConfigTarget), {
    hostAlias: alias, hostName, port: sshPort, user: sshUser, identityFile,
  });
  if (dryRun) {
    dryRunLog(`atomic rewrite ${sshConfigTarget}:\n${nextSshConfig}`);
  } else {
    try {
      writeSshConfigFile(sshConfigTarget, nextSshConfig);
      logSuccess(`已把 Host ${alias} 写入 ${sshConfigTarget}。`);
    } catch (err) {
      logError(`写入 ${sshConfigTarget} 失败: ${err.message}`);
      return false;
    }
  }

  // ---- 4. 连通性测试 ----
  if (dryRun) {
    dryRunLog(`ssh -o BatchMode=yes -o ConnectTimeout=3 ${alias} "echo ok"`);
  } else if (testSsh(alias)) {
    logSuccess(`服务器 "${alias}" 免密连通正常。`);
  } else {
    logWarning(`"${alias}" 目前无法免密连通（公钥可能还没部署到该机器）。`);
    if (!(await confirmYes("仍然把它写进个人层配置吗？(y/N): ", ask))) {
      logInfo("已放弃本次添加（~/.ssh/config 的别名段保留，修好后可重跑向导）。");
      return false;
    }
  }

  // ---- 5. 反向端口：在这台机器上探一个空闲值做默认 ----
  const listening = await readRemoteListeningPorts({ host: alias, dryRun, ssh });
  let suggested;
  try {
    suggested = pickReversePort({ inUse: listening, reserved: teamRemotePorts });
  } catch (err) {
    logError(err.message);
    return false;
  }
  const portAnswer = String(await ask(`请输入该服务器上的反向端口 (回车用建议值 ${suggested}): `)).trim();
  let remotePort = suggested;
  if (portAnswer) {
    try {
      remotePort = assertSafePort(portAnswer, "个人服务器 remotePort");
      assertPortNotTeamReserved(remotePort, teamRemotePorts);
    } catch (err) {
      logWarning(`${err.message}，回退使用建议值 ${suggested}。`);
      remotePort = suggested;
    }
  }
  const localPort = remotePort + 1000;

  // ---- 6. 是否建隧道 ----
  const tunnelAnswer = String(await ask("是否为这台服务器建立常驻反向隧道？(Y/n，n = 只监控不建隧道): ")).trim().toLowerCase();
  const tunnel = tunnelAnswer !== "n";

  // ---- 7. 写回个人层 ----
  const entry = { id, name: displayName, host: alias, remotePort, localPort, tunnel };
  // 只有当这台机器的账号与团队账号不同才写 sshUser：相同时留空，继续吃顶层的个人身份，
  // 避免同一个值在配置里出现两份、改一份忘一份。
  if (sshUser && sshUser !== String(teamSshUser || "").trim()) entry.sshUser = sshUser;
  let nextLocal;
  try {
    nextLocal = upsertPersonalServer(local, entry);
  } catch (err) {
    logError(`写入个人服务器失败: ${err.message}`);
    return false;
  }
  try {
    persistLocalConfig(localConfigPath, nextLocal, dryRun);
  } catch (err) {
    logError(`写入 ${localConfigPath} 失败: ${err.message}`);
    return false;
  }
  logSuccess(`已写入个人服务器 "${id}"：host=${alias} remotePort=${remotePort} localPort=${localPort} tunnel=${tunnel}`);
  if (!tunnel) logInfo("该条目声明了 tunnel:false —— 控制台只监控它，不为它建反向隧道、不占端口。");
  return true;
}
