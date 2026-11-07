// scripts/setup/team-server.mjs —— 向导第 2 步：逐台打通 config.json 里的团队服务器
// （连通性检测 → 问用户名 / 地址 → 主机指纹确认 → 写 ~/.ssh/config → 部署公钥 → 复测 → 写个人身份）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { parseSshConfigUser } from "../../work/monitor/lib/ssh-config-user.mjs";
import { confirmAndPinHostKey } from "./host-keys.mjs";
import { markTeamServerDisabled, writePersonalIdentity } from "./local-config.mjs";
import { backupSshConfig, readSshConfigFile, sshConfigPath, upsertSshConfigBlock, writeSshConfigFile } from "./ssh-config.mjs";
import { confirmYes } from "../lib/prompt.mjs";
import { probeSshConnection, reportSshTestFailure } from "./ssh-probe.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

const ASK_CLUSTER_USER = "请输入集群 SSH 登录用户名（不要用本机系统用户名；直接回车 = 我不在这个集群，屏蔽这台服务器）: ";

// 引导配置某台服务器
// keyInfo：checkSshKeys()/generateSshKey() 的返回值 { privateKeyPath, publicKeyPath, isDedicated } | null。
// 返回 { status, reason? }：status ∈ ok（已打通）/ disabled（用户选"我不在这个集群"，属正常结果）/
// skipped（用户没给地址或拒绝主机指纹）/ failed（免密测试失败，reason 为归因）。
// 收尾摘要（buildWizardSummary）据此判断哪些步骤被跳过，不再一律宣告"配置完成"。
export async function configureServer(server, keyInfo) {
  logHeader(`配置服务器: ${server.name} (别名: ${server.host})`);
  const pubKeyPath = keyInfo ? keyInfo.publicKeyPath : null;
  const dedicatedIdentityFile = keyInfo?.isDedicated ? keyInfo.privateKeyPath : undefined;

  logInfo(`正在检测别名 "${server.host}" 的连通性...`);
  if (probeSshConnection(server.host).ok) {
    logSuccess(`服务器 "${server.host}" 已成功连通，无需重复配置。`);
    const sshUser = await resolveConnectedSshUser(server.host);
    writePersonalIdentity(server, sshUser, dedicatedIdentityFile);
    return { status: "ok" };
  }

  logWarning(`别名 "${server.host}" 目前无法免密连通。开始引导配置：`);

  let ipOrDomain;
  let port;
  let user;

  if (server.sshHostName && !server.sshHostName.startsWith("REPLACE_")) {
    // 已在 config.json 预烤 host/port，个人只需确认用户名
    ipOrDomain = server.sshHostName;
    port = server.sshPort || 22;
    logInfo(`已从 config.json 读取预烤连接信息 (Host: ${ipOrDomain}, Port: ${port})，仅需确认用户名。`);

    user = await askQuestion(ASK_CLUSTER_USER);
  } else {
    // 向后兼容：config.json 未提供 sshHostName 时保留旧的问 IP/端口/用户名流程
    ipOrDomain = await askQuestion(`请输入服务器的真实 IP 地址或域名 (当前别名: ${server.host}): `);
    if (!ipOrDomain) {
      logWarning("未输入 IP/域名，跳过此服务器配置。");
      return { status: "skipped", reason: "未输入服务器地址" };
    }

    const portInput = await askQuestion("请输入 SSH 端口号 (默认 22): ");
    port = portInput ? parseInt(portInput, 10) : 22;

    user = await askQuestion(ASK_CLUSTER_USER);
  }

  if (!user) {
    // "我不在这个集群"：v2.18 起不再只是"跳过"，而是在个人层写下 { id, disabled: true }。
    // 只跳过的话，这台连不通的团队服务器会一直被探针轮询、在控制台上恒红，成为噪音之源。
    logWarning("未输入 SSH 用户名，按\"我不在这个集群\"处理（绝不把本机 OS 用户名写入 sshUser）。");
    markTeamServerDisabled(server.id);
    return { status: "disabled" };
  }

  if (!await confirmAndPinHostKey(ipOrDomain, port)) return { status: "skipped", reason: "主机指纹未确认" };

  // 1. 写入 config（E1 修复：覆盖分支剥离旧段后立即原子写回；选择保留则整段跳过写入，
  // 不再像旧实现那样无条件 appendFileSync —— 那会让"已保留原有配置"的选择形同虚设，
  // 旧段因 ssh "首匹配优先" 继续生效，新追加的段变成死配置，且每次重跑都多一段）。
  backupSshConfig();

  let configContent = "";
  if (!fs.existsSync(sshConfigPath)) {
    // 确保文件存在
    if (DRY_RUN) {
      dryRunLog(`create ${sshConfigPath} (empty, mode 0600)`);
    } else {
      fs.writeFileSync(sshConfigPath, "", { mode: 0o600 });
    }
  } else {
    configContent = fs.readFileSync(sshConfigPath, "utf8");
  }

  const hostRegex = new RegExp(`^\\s*Host\\s+${server.host}\\b`, "mi");
  const hasExistingHost = hostRegex.test(configContent);
  let shouldWriteSshConfig = true;
  if (hasExistingHost) {
    logWarning(`检测到 ~/.ssh/config 中已存在 Host ${server.host} 的相关配置。`);
    if (!(await confirmYes("是否覆盖已有的该 Host 配置段？(y/N): "))) {
      logInfo("已保留原有配置。");
      shouldWriteSshConfig = false;
    }
  }

  if (shouldWriteSshConfig) {
    const nextConfigContent = upsertSshConfigBlock(configContent, {
      hostAlias: server.host,
      hostName: ipOrDomain,
      port,
      user,
      identityFile: dedicatedIdentityFile,
    });
    if (DRY_RUN) {
      dryRunLog(`atomic rewrite ${sshConfigPath}:\n${nextConfigContent}`);
    } else {
      writeSshConfigFile(sshConfigPath, nextConfigContent);
      logSuccess(hasExistingHost ? "已覆盖旧 Host 段并原子写回 ~/.ssh/config。" : "已成功向 ~/.ssh/config 写入别名配置。");
    }
  }

  // 2. 拷贝公钥
  if (pubKeyPath) {
    const copyKey = await askQuestion(`是否需要自动向服务器部署您的公钥实现免密登录？(需要输入一次 SSH 密码) (Y/n): `);
    if (copyKey.toLowerCase() !== "n") deployPublicKey({ pubKeyPath, port, user, ipOrDomain });
  } else {
    logWarning("由于未找到或生成 SSH 密钥，无法自动部署公钥。");
  }

  // 3. 重新校验
  logInfo("正在重新测试免密连通性...");
  const probe = probeSshConnection(server.host);
  if (probe.ok) {
    logSuccess(`免密登录配置成功！服务器 "${server.host}" 已可正常连通！`);
    writePersonalIdentity(server, user, dedicatedIdentityFile);
    return { status: "ok" };
  }
  const info = reportSshTestFailure(server.host, probe);
  return { status: "failed", reason: info.primary[0] || "免密测试失败" };
}

// 已连通的别名：个人身份里的用户名优先取 ~/.ssh/config 的 User，读不到再问。
async function resolveConnectedSshUser(hostAlias) {
  const fromConfig = parseSshConfigUser(readSshConfigFile(), hostAlias);
  if (fromConfig) {
    logInfo(`已从 ~/.ssh/config 的 Host ${hostAlias} 读取 User=${fromConfig}`);
    return fromConfig;
  }
  const userInput = await askQuestion("未能从 ~/.ssh/config 读到 User，请输入集群 SSH 登录用户名（不要用本机系统用户名）: ");
  return userInput;
}

// 交互式部署公钥（用户会被 ssh 提示输入一次密码）：优先 ssh-copy-id，失败/缺失时回退到
// 经 stdin 把公钥交给远端 cat 追加。
function deployPublicKey({ pubKeyPath, port, user, ipOrDomain }) {
  if (DRY_RUN) {
    dryRunLog(`ssh-copy-id -p ${port} ${user}@${ipOrDomain}`);
    dryRunLog(`fallback via stdin: ssh -p ${port} ${user}@${ipOrDomain} 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' (公钥内容通过 stdin 传入)`);
    return;
  }
  logInfo("正在尝试分发公钥，请在提示时输入服务器 SSH 密码...");

  // 优先尝试使用 ssh-copy-id
  let success = false;
  try {
    const result = spawnSync("ssh-copy-id", ["-p", String(port), `${user}@${ipOrDomain}`], {
      stdio: "inherit"
    });
    if (result.status === 0) {
      success = true;
    }
  } catch {
    // 忽略，回退到管道模式
  }

  if (!success) {
    // Windows 只带 OpenSSH Client，无 ssh-copy-id；echo 内联在 Windows 上引号处理不一致，
    // 改为通过 stdin 传入公钥内容，交给远端 cat 追加，避免跨平台转义问题。
    logInfo("系统未安装 ssh-copy-id 或分发失败，正在使用 SSH 管道分发公钥（通过 stdin）...");
    const pubKeyContent = fs.readFileSync(pubKeyPath, "utf8").trim();
    const remoteCmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys";

    const result = spawnSync("ssh", ["-p", String(port), `${user}@${ipOrDomain}`, remoteCmd], {
      input: `${pubKeyContent}\n`,
      stdio: ["pipe", "inherit", "inherit"]
    });
    if (result.status === 0) {
      success = true;
    }
  }

  if (success) {
    logSuccess("公钥分发成功！");
  } else {
    logError("公钥分发失败，请确认密码正确或网络可达。");
  }
}
