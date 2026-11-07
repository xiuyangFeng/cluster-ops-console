// App 内接入引导（设计稿 2026-10-07 §H，第 3 期）：把命令行向导 `npm run setup` 的前半段——
// 核对指纹 → 专用密钥 → 用一次密码装公钥 → 保存连接配置 → 领端口 → 起隧道 → 出网自测 → 写集群侧配置——
// 做成界面能驱动的一串步骤。装 CLI 与登录不在这里：界面接着用已有的 /api/cli* 接口。
//
// 约定：
//   - 每一步幂等，可单独重跑；失败停在那一步，「重试」从它继续；
//   - 需要人回答的地方（指纹、密码、是否覆盖已有 Host 段、是否改用系统代理、是否注释旧代理导出）
//     以 prompt 交给界面，回答经 answer() 送回，流程从那一步接着走；
//   - 密码只在内存里走一趟（10 分钟不用就丢），不落盘、不进日志、不出现在状态里；
//   - 进度存 runtime/onboarding-guide.json（store.mjs），重启后从断点继续；
//   - fixture 模式（冒烟 / 预览）不发真实 SSH、不写任何文件，走一套脚本化的假流程。
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writePrivateFileAtomicSync } from "../atomic-file.mjs";
import { noProxyExtraFor } from "../cluster-env.mjs";
import { parseKeyscanLines } from "../host-key-policy.mjs";
import { appendKnownHosts, knownHostsLookupName } from "../known-hosts-file.mjs";
import { ensureWindowsOpenSshOnPath, windowsOpenSshDir } from "../platform.mjs";
import { TEAM_PRIMARY_SERVER_ID } from "../onboarding.mjs";
import { assertSafeHost, assertSafeSshUser } from "../ssh-args.mjs";
import { findSshHostSection, MANAGED_HOST_COMMENT, upsertSshConfigBlock } from "../ssh-config-block.mjs";
import { statusError } from "../status-error.mjs";
import { toPort } from "../validators.mjs";
import { buildManualAuthorizeCommand, installPublicKeyWithPassword, probeKeyLogin } from "./authorize-key.mjs";
import { createClusterEnvApplier } from "./cluster-env-apply.mjs";
import { DEDICATED_KEY_NAME, ensureDedicatedKey } from "./local-key.mjs";
import { createGuideStore, emptyGuideState } from "./store.mjs";

export const GUIDE_STEPS = Object.freeze([
  { id: "hostkey", title: "连接服务器并核对指纹" },
  { id: "key", title: "准备本机密钥" },
  { id: "authorize", title: "把公钥装到服务器" },
  { id: "identity", title: "保存连接配置" },
  { id: "port", title: "领取专属端口" },
  { id: "tunnel", title: "建立隧道" },
  { id: "egress", title: "出网自测" },
  { id: "clusterEnv", title: "写集群侧配置" },
]);
const STEP_IDS = GUIDE_STEPS.map((step) => step.id);

const PASSWORD_TTL_MS = 10 * 60 * 1000;
const TUNNEL_WAIT_MS = 120000;
const TUNNEL_POLL_MS = 1500;
// ~/.ssh/config 里写波浪线形式：路径里没有空格 / 反斜杠，Windows 与 macOS 的 ssh 都认。
const IDENTITY_FILE_IN_CONFIG = `~/.ssh/${DEDICATED_KEY_NAME}`;

const NETWORK_HINT = "最常见的原因是当前网络不在服务器的 SSH 白名单内（比如服务器只允许单位内网访问，而你在外网或手机热点上）。连上能访问它的网络（单位内网 / 校园网 / VPN）后点「重试」。";
const SSH_FAILURE_TEXT = {
  timeout: { message: "连接服务器超时", hint: NETWORK_HINT },
  refused: { message: "服务器拒绝了连接", hint: NETWORK_HINT },
  dns: { message: "找不到这台服务器", hint: "检查服务器地址有没有填错，以及本机网络是否正常。" },
  hostkey: { message: "服务器指纹和之前保存的不一致", hint: "可能是服务器重装过，也可能连到了别的机器。先和管理员确认，再删掉 ~/.ssh/known_hosts 里这台服务器的旧记录后重试。" },
  "rate-limit": { message: "尝试次数过多，服务器暂时拒绝连接", hint: "等几分钟再点「重试」。" },
};

const done = (detail = "") => ({ status: "done", detail });
const skipped = (detail = "") => ({ status: "skipped", detail });
const warn = (detail = "") => ({ status: "warn", detail });
const waiting = (prompt) => ({ status: "waiting", prompt });
const failed = (code, message, hint = "", extra = {}) => ({ status: "failed", error: { code, message, hint, detail: "", manual: "", ...extra } });
const sshFailed = (code, detail = "") => {
  const known = SSH_FAILURE_TEXT[code];
  return known ? failed(code, known.message, known.hint, { detail }) : failed(code || "unknown", "连接服务器失败", "把下面这行原始信息发给管理员。", { detail });
};

// lib/exec.mjs 把"命令不存在"结算成 code 1 + stderr 里的 ENOENT。
const toolMissing = (res) => res?.code !== 0 && /ENOENT/.test(String(res?.stderr || ""));
const sshMissing = (platform) => failed(
  "ssh-missing",
  "这台电脑上没有 ssh 命令",
  platform === "win32"
    ? "点下面的「安装 OpenSSH 客户端」（Windows 自带的组件，会请求一次管理员确认，装好后自动继续）；也可以打开「设置 → 系统 → 可选功能」添加「OpenSSH 客户端」，装好后点「重试」。WinSCP、PuTTY 自带的 SSH 不能代替它。"
    : "先安装 OpenSSH 客户端，再点「重试」。",
);

// Windows：以管理员身份装系统自带的 OpenSSH 客户端（会弹一次 UAC）。外层 PowerShell 不需要管理员，
// 由它 Start-Process -Verb RunAs 起一个提权的 PowerShell 执行 Add-WindowsCapability，等它结束后带回退出码。
export const OPENSSH_CAPABILITY = "OpenSSH.Client~~~~0.0.1.0";
const OPENSSH_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
export function buildOpenSshInstallInvocation(env = process.env) {
  const powershell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const inner = `Add-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath '${powershell}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-Command','${inner}'`,
    "exit $p.ExitCode",
  ].join("; ");
  return { file: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", script] };
}

// 没装上时给人看的原因（UAC 点了「否」最常见；公司电脑可能不允许从 Windows 更新取可选功能）。
export function describeOpenSshInstallFailure(res) {
  const text = String(res?.stderr || res?.stdout || "").trim();
  if (/cancel|取消/i.test(text)) return "没有获得管理员确认，OpenSSH 客户端没有安装。再点一次，在弹出的窗口里选「是」。";
  if (res?.timedOut) return "安装等了 20 分钟还没结束。打开「设置 → 系统 → 可选功能」看看「OpenSSH 客户端」的安装进度，装好后点「重试」。";
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 300);
  return `OpenSSH 客户端没有装上${tail ? `（${tail}）` : ""}。可以改在「设置 → 系统 → 可选功能 → 添加功能」里手动安装；公司或学校统一管理的电脑可能要找管理员。`;
}

// known_hosts 的一行（host keytype base64）→ 指纹。与 `ssh-keygen -lf` 给出的 SHA256 一致。
export function fingerprintOfKeyLine(line) {
  const parts = String(line || "").trim().split(/\s+/);
  if (parts.length < 3 || !/^[A-Za-z0-9+/]+=*$/.test(parts[2])) return null;
  const digest = createHash("sha256").update(Buffer.from(parts[2], "base64")).digest("base64").replace(/=+$/, "");
  return { type: parts[1], sha256: `SHA256:${digest}` };
}

function usableHostName(value) {
  return typeof value === "string" && value.trim() && !value.trim().startsWith("REPLACE_") ? value.trim() : "";
}

// 团队配置的 host 写的就是域名 / IP（而不是 ~/.ssh/config 里的别名）时，它本身就是地址。
const looksLikeAddress = (host) => /[.:]/.test(String(host || ""));

function validPassword(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

export function createOnboardingGuide({
  fixtureMode = false,
  platform = process.platform,
  homeDir = os.homedir(),
  statePath,
  helperDir,
  teamConfigPath,
  getMergedConfig,
  getConfig = async () => getMergedConfig(),
  getPersonalConfig = () => ({}),
  savePersonalConfig,
  refreshConfigIntoKernel = async () => {},
  serverRegistry,
  acquireSshSlot = null,
  exec,
  runRemote,
  getStatus = () => ({}),
  getTunnelFailure = () => null,
  getShouldBeRunning = () => true,
  startChannel = async () => {},
  egressService = null,
  clusterEnvSync = null,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  fs = nodeFs,
} = {}) {
  const sshDir = path.join(homeDir, ".ssh");
  const sshConfigPath = path.join(sshDir, "config");
  const knownHostsPath = path.join(sshDir, "known_hosts");
  const store = createGuideStore({ filePath: fixtureMode ? null : statePath, stepIds: STEP_IDS, fs, log, now });
  let state = store.load();
  let running = false;
  // Windows 上在后台装 OpenSSH 客户端（installOpenSsh）：{ running, error }。
  let sshInstall = { running: false, error: null };
  // 当前这一轮执行（跑到完成 / 失败 / 提问为止）。测试等它，生产代码不等。
  let currentRun = Promise.resolve();
  // 只活在内存里的东西：密码、扫到的主机密钥行、各个问题的回答、生成的密钥信息。
  let mem = {};

  const readText = (filePath) => {
    try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
  };

  function readTeamServer(serverId) {
    try {
      const team = JSON.parse(fs.readFileSync(teamConfigPath, "utf8"));
      return (team.servers || []).find((s) => s?.id === serverId) || null;
    } catch {
      return null;
    }
  }

  // 引导要接的那台团队服务器 + 连接参数。团队配置预烤了 sshHostName 时地址不可改（界面只问用户名）。
  function resolveTarget(config, form = state.form) {
    const server = (config?.servers || []).find((s) => s?.id === TEAM_PRIMARY_SERVER_ID && s.source !== "personal");
    if (!server?.host) return null;
    const team = readTeamServer(server.id);
    const block = findSshHostSection(readText(sshConfigPath), server.host);
    const baked = usableHostName(team?.sshHostName);
    const pinned = Array.isArray(team?.sshHostKeyFingerprints)
      ? team.sshHostKeyFingerprints.filter((f) => typeof f === "string" && /^SHA256:[A-Za-z0-9+/]+$/.test(f.trim())).map((f) => f.trim())
      : [];
    return {
      server,
      alias: server.host,
      hostName: baked || usableHostName(form.hostName) || usableHostName(block?.hostName) || (looksLikeAddress(server.host) ? server.host : ""),
      hostNameLocked: Boolean(baked),
      // 地址是表单里填的（没预烤）时，端口也以表单为准。
      port: (baked ? null : toPort(form.sshPort)) ?? toPort(team?.sshPort) ?? toPort(server.sshPort) ?? block?.port ?? 22,
      user: form.sshUser || "",
      userDefault: server.sshUser || config?.sshUser || block?.user || "",
      pinnedFingerprints: pinned,
      block,
    };
  }

  function touch() {
    state.updatedAt = now();
    store.save(state);
  }

  function setStep(id, patch) {
    state.steps[id] = { ...state.steps[id], ...patch };
    touch();
  }

  function publicState() {
    const config = getMergedConfig?.() || null;
    const target = resolveTarget(config);
    return {
      available: Boolean(target),
      phase: state.phase,
      busy: running || sshInstall.running,
      dismissed: state.dismissed,
      simulated: fixtureMode,
      platform,
      // Windows 才有：OpenSSH 客户端一键安装的进度（installing）与没装上的原因（error）。
      openSsh: platform === "win32" ? { installing: sshInstall.running, error: sshInstall.error } : null,
      server: target ? { id: target.server.id, name: target.server.name || target.server.id, alias: target.alias } : null,
      form: {
        sshUser: state.form.sshUser || target?.userDefault || "",
        hostName: target?.hostName || "",
        hostNameLocked: target?.hostNameLocked ?? false,
        sshPort: target?.port ?? 22,
      },
      steps: GUIDE_STEPS.map((step) => ({ id: step.id, title: step.title, ...state.steps[step.id] })),
      prompt: state.prompt,
      result: state.result,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
    };
  }

  let passwordTimer = null;
  const forgetPassword = () => {
    if (passwordTimer) clearTimeout(passwordTimer);
    passwordTimer = null;
    mem.password = null;
    mem.passwordExpiresAt = 0;
  };
  // 记下密码并定时丢弃：流程停在别的步骤（失败 / 等回答）时，它不该一直留在内存里。
  const rememberPassword = (value) => {
    forgetPassword();
    mem.password = value;
    mem.passwordExpiresAt = now() + PASSWORD_TTL_MS;
    passwordTimer = setTimeout(forgetPassword, PASSWORD_TTL_MS);
    passwordTimer.unref?.();
  };
  const takePassword = () => {
    const value = mem.password && mem.passwordExpiresAt > now() ? mem.password : null;
    forgetPassword();
    return value;
  };

  const withSlot = async (host, task) => {
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: host }) : null;
    try { return await task(); } finally { if (typeof release === "function") release(); }
  };

  function passwordPrompt(target, error = null) {
    return waiting({
      kind: "password",
      user: target.user,
      host: target.hostName,
      error,
      attempts: mem.passwordAttempts || 0,
      // 密码通道走不通（或用户不想在页面里输密码）时的退路：自己在终端里跑这一行，再点「我已完成」。
      manualCommand: mem.key ? buildManualAuthorizeCommand({ publicKeyPath: mem.key.publicKeyPath, hostName: target.hostName, port: target.port, user: target.user, platform }) : "",
    });
  }

  // 核对过的指纹写进 ~/.ssh/known_hosts（只追加）。读不出这份文件时一个字节都不写、原样报错（known-hosts-file.mjs），
  // 这里把它变成这一步的失败：成功返回 null。
  function pinKnownHosts(lines) {
    try {
      appendKnownHosts(knownHostsPath, lines, { mkdirSync: fs.mkdirSync, readFileSync: fs.readFileSync, appendFileSync: fs.appendFileSync });
      return null;
    } catch (error) {
      return failed(
        "known-hosts",
        `没能把指纹写进 ~/.ssh/known_hosts（${error.errno || error.code || "未知错误"}）`,
        "读不出这份文件时不会改动它，原有内容都还在。检查它的权限（应当属于你自己、可读写；也可以是指向别处的软链接），修好后点「重试」。",
        { detail: error.message },
      );
    }
  }

  // ---- 各步骤（真实执行）----
  const handlers = {
    // 已经能用这个别名免密登录（老用户 / 手动配过 ssh config）：前三步都不用做。
    async hostkey({ target }) {
      if (mem.shortcut) return skipped("已经能免密登录，沿用现有配置");
      const lookup = knownHostsLookupName(target.hostName, target.port);
      const known = await exec("ssh-keygen", ["-F", lookup, "-f", knownHostsPath], { timeoutMs: 8000 });
      if (known.code === 0 && String(known.stdout || "").trim()) return done("这台服务器的指纹之前已经确认过");

      if (!mem.hostKey) {
        const scan = await exec("ssh-keyscan", ["-T", "5", "-p", String(target.port), target.hostName], { timeoutMs: 15000 });
        if (toolMissing(scan)) return sshMissing(platform);
        const scanned = parseKeyscanLines(scan.stdout).map((line) => ({ line, fp: fingerprintOfKeyLine(line) })).filter((item) => item.fp);
        if (!scanned.length) return failed("unreachable", `连不上 ${target.hostName}:${target.port}`, NETWORK_HINT);
        if (target.pinnedFingerprints.length) {
          // 团队配置里写了指纹：对得上的才写入，一把都对不上就是连错了机器，不给人工放行。
          const matched = scanned.filter((item) => target.pinnedFingerprints.includes(item.fp.sha256));
          if (!matched.length) {
            return failed("hostkey-mismatch", "服务器指纹和团队配置里登记的不一致", "可能连到了别的机器，不要继续。把这条信息发给管理员。", {
              detail: scanned.map((item) => `${item.fp.type} ${item.fp.sha256}`).join("\n"),
            });
          }
          return pinKnownHosts(matched.map((item) => item.line)) || done("指纹与团队配置一致，已保存");
        }
        const lines = scanned.map((item) => item.line);
        mem.hostKey = {
          lines,
          linesHash: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24),
          fingerprints: scanned.map((item) => item.fp),
          accepted: false,
        };
      }
      if (!mem.hostKey.accepted) {
        return waiting({ kind: "hostkey", host: target.hostName, port: target.port, fingerprints: mem.hostKey.fingerprints, linesHash: mem.hostKey.linesHash });
      }
      // 写不进去时 mem.hostKey（已确认）留着：修好文件权限后点「重试」直接再写，不用重新确认一遍。
      const pinFailed = pinKnownHosts(mem.hostKey.lines);
      if (pinFailed) return pinFailed;
      mem.hostKey = null;
      return done("指纹已确认并保存");
    },

    async key() {
      if (mem.shortcut) return skipped("沿用现有的登录方式");
      try {
        mem.key = await ensureDedicatedKey({ sshDir, exec, fs });
      } catch (error) {
        if (/ENOENT/.test(error.message)) return sshMissing(platform);
        return failed(error.code || "keygen-failed", error.message, "");
      }
      return done(mem.key.created ? `已生成专用密钥 ~/.ssh/${DEDICATED_KEY_NAME}` : "沿用已有的专用密钥");
    },

    async authorize({ target }) {
      if (mem.shortcut) return skipped("沿用现有的登录方式");
      if (!mem.key) mem.key = await ensureDedicatedKey({ sshDir, exec, fs });
      const connection = { exec, hostName: target.hostName, port: target.port, user: target.user };
      const probe = await probeKeyLogin({ ...connection, privateKeyPath: mem.key.privateKeyPath });
      if (probe.ok) {
        forgetPassword();
        return done("公钥已在服务器上，免密登录正常");
      }
      if (probe.code !== "auth" && probe.code !== "unknown") return sshFailed(probe.code, probe.detail);
      if (mem.manualDone) {
        // 用户说已经在终端里装好了，但还是登不上。
        mem.manualDone = false;
        return passwordPrompt(target, "still-missing");
      }
      const password = takePassword();
      if (!password) return passwordPrompt(target);
      const installed = await installPublicKeyWithPassword({ ...connection, password, publicKey: mem.key.publicKey, helperDir, platform });
      if (installed.ok) {
        const verify = await probeKeyLogin({ ...connection, privateKeyPath: mem.key.privateKeyPath });
        if (verify.ok) return done("公钥已装好，之后不再需要密码");
        return failed("verify-failed", "公钥已经写到服务器上，但免密登录还是不行", "服务器可能关掉了公钥登录，或者你的家目录权限过宽（别人可写）。把下面这行发给管理员。", { detail: verify.detail });
      }
      if (installed.code === "wrong-password") {
        mem.passwordAttempts = (mem.passwordAttempts || 0) + 1;
        return passwordPrompt(target, "wrong-password");
      }
      if (installed.code === "channel") return passwordPrompt(target, "channel");
      if (installed.code === "remote-write") return failed("remote-write", installed.detail, "清理家目录空间或联系管理员后点「重试」。");
      return sshFailed(installed.code, installed.detail);
    },

    async identity({ target }) {
      if (!mem.shortcut) {
        if (!mem.key) mem.key = await ensureDedicatedKey({ sshDir, exec, fs });
        const content = readText(sshConfigPath);
        const existing = findSshHostSection(content, target.alias);
        const desired = { hostAlias: target.alias, hostName: target.hostName, port: target.port, user: target.user, identityFile: IDENTITY_FILE_IN_CONFIG };
        const same = existing && existing.hostName === desired.hostName && existing.user === desired.user
          && (existing.port ?? 22) === desired.port && existing.identityFile === desired.identityFile;
        // 用户自己手写过这个别名的段：先给他看，要不要覆盖由他定（可能有 ProxyJump 之类我们不知道的设置）。
        if (existing && !existing.managed && !same && !mem.sshConfigDecision) {
          // 给人看的"要写成"只留 Host 段本身，不带那行受管标记注释。
          const proposed = upsertSshConfigBlock("", desired).trim().split("\n").filter((line) => line !== MANAGED_HOST_COMMENT).join("\n");
          return waiting({ kind: "ssh-config", alias: target.alias, existing: existing.text, proposed });
        }
        if (!same && mem.sshConfigDecision !== "keep") {
          if (content) {
            try { fs.copyFileSync(sshConfigPath, `${sshConfigPath}.bak.${now()}`); } catch {}
          }
          writePrivateFileAtomicSync(sshConfigPath, upsertSshConfigBlock(content, desired), { fs, chmodDir: false });
        }
      }
      const patch = { activeServerId: target.server.id, sshUser: target.user };
      if (!mem.shortcut) patch.sshIdentityFile = mem.key.privateKeyPath;
      try {
        await savePersonalConfig(patch);
        // 之前在向导里选过"我不在这个集群"的，这次配通了就把屏蔽撤掉。
        if (target.server.disabled === true) await serverRegistry.enable(target.server.id, {});
        await refreshConfigIntoKernel();
      } catch (error) {
        return failed("save-failed", `保存个人配置失败：${error.message}`, "");
      }
      // 用工作台自己连服务器的那套参数再试一次：这一步过了，隧道和探针才连得上。
      const test = await serverRegistry.testConnection(target.server.id);
      if (!test.ok) {
        mem.sshConfigDecision = null;
        const base = sshFailed(test.code, test.nextAction || "");
        if (test.code === "auth") {
          return failed("auth", "配置已保存，但工作台用它登录服务器失败", "如果刚才选择了保留自己的 Host 段，点「重试」后改选覆盖。", { detail: test.nextAction || "" });
        }
        return base;
      }
      state.result.sshUser = target.user;
      return done(`已保存：${target.user}@${target.alias}`);
    },

    async port({ target }) {
      const config = await getConfig();
      const current = toPort((config?.servers || []).find((s) => s?.id === target.server.id)?.remotePort);
      if (current) {
        state.result.remotePort = current;
        return done(`已有专属端口 ${current}`);
      }
      try {
        const suggestion = await serverRegistry.suggestPort(target.server.id, { acquireSshSlot });
        if (!suggestion.probed || !suggestion.suggested) {
          return failed("survey-failed", "读不到服务器上的端口登记信息", suggestion.probeError === "auth" ? "登录服务器失败，点「重试」；仍不行就从头再走一遍引导。" : NETWORK_HINT, { detail: String(suggestion.probeError || "") });
        }
        const claimed = await serverRegistry.claimPort(target.server.id, { remotePort: suggestion.suggested.remotePort, acquireSshSlot });
        state.result.remotePort = claimed.remotePort;
        state.result.registered = claimed.registered === true;
        if (!claimed.registered) {
          state.result.warnings = [
            ...state.result.warnings.filter((w) => w.code !== "port-unregistered"),
            { code: "port-unregistered", text: claimed.warning || "集群还没有启用端口登记，这个端口没有登记，可能与他人冲突。", command: claimed.adminCommand || "" },
          ];
          return done(`已分配端口 ${claimed.remotePort}（未登记）`);
        }
        return done(claimed.mode === "reused" ? `沿用你名下已登记的端口 ${claimed.remotePort}` : `已领取并登记端口 ${claimed.remotePort}`);
      } catch (error) {
        return failed(error.code || "claim-failed", error.message || "领取端口失败", "");
      }
    },

    async tunnel({ target }) {
      try {
        if (!getShouldBeRunning()) await startChannel();
      } catch (error) {
        return failed("start-failed", `启动连接失败：${error.message}`, "");
      }
      const deadline = now() + TUNNEL_WAIT_MS;
      while (now() < deadline) {
        const status = getStatus() || {};
        if (status.tunnelUp && status.remotePortOpen) return done("隧道已连通");
        const progress = !status.localProxyUp ? "正在启动本机代理…" : !status.tunnelUp ? "本机代理已启动，正在连接服务器…" : "隧道已建立，正在确认服务器端口…";
        if (state.steps.tunnel.detail !== progress) setStep("tunnel", { detail: progress });
        await sleep(TUNNEL_POLL_MS);
      }
      const failure = getTunnelFailure(target.server.id);
      if (failure?.code) return sshFailed(failure.code, failure.nextAction || "");
      return failed("tunnel-timeout", "隧道在两分钟内没有建立", "点「重试」再等一轮；仍不行可以先进入工作台，首页会给出具体原因。");
    },

    async egress() {
      if (!egressService) return skipped("当前模式下不做出网自测");
      const summarize = (report) => {
        if (report.full?.ok) {
          const bad = (report.results || []).filter((r) => !r.ok);
          return bad.length ? warn(`全链路已通，但 ${bad.map((r) => r.target).join("、")} 访问不了：${bad[0].message}`) : done(report.full.message || "全链路已通");
        }
        return null;
      };
      let report = await egressService.runSelfTest({ scope: "full" });
      let outcome = summarize(report);
      if (outcome) return outcome;
      if (report.suggestion?.action === "use-system" && !mem.egressDecision) {
        return waiting({ kind: "egress", text: report.suggestion.text, failures: (report.results || []).filter((r) => !r.ok).map((r) => ({ target: r.target, message: r.message })) });
      }
      if (mem.egressDecision === "use-system") {
        mem.egressDecision = "applied";
        try {
          await egressService.setMode({ mode: "system" });
          await sleep(2500); // 本机代理约 2 秒内热载出网设置
          report = await egressService.runSelfTest({ scope: "full" });
          outcome = summarize(report);
          if (outcome) return outcome;
        } catch (error) {
          return warn(`切换到系统代理失败：${error.message}`);
        }
      }
      // 出网不通不拦后面的步骤（集群配置照写），但装 CLI 和登录都要用到它，结尾会再提醒一次。
      return warn(report.suggestion?.text || report.full?.message || "出网自测没有通过");
    },

    async clusterEnv({ target }) {
      const config = await getConfig();
      const server = (config?.servers || []).find((s) => s?.id === target.server.id);
      const port = toPort(server?.remotePort);
      if (!port) return failed("no-port", "还没有反向端口，写不了集群配置", "回到「领取专属端口」一步重试。");
      const applier = createClusterEnvApplier({
        runRemote: (command, options) => withSlot(server.host, () => runRemote(server, config, command, options)),
      });
      // 代理口令（与命令行向导同一条规则，见 cluster-env.mjs 的 credentialForEnvRewrite）：本机口令模式打开着，
      // 或集群上原来那份 env.sh 带着口令，就一并写入本机当前的口令——重跑引导别把口令写没了（「强制」下那等于断网）。
      // 本机没有口令（或模式是关、集群上也没带过）时拿到的是 null，写出来的与以前逐字相同。
      // 写完后面的 check 会现读一次集群，出网设置页「集群上是哪一个口令」随之变成当前的。
      const credential = (await clusterEnvSync?.credentialForRewrite?.(server.id)) ?? null;
      const opts = { port, noProxyExtra: noProxyExtraFor(getPersonalConfig() || {}, server.id), ...(credential ? { credential } : {}) };
      const written = await applier.write(opts);
      if (!written.ok) {
        return failed("write-failed", `${written.failed.title}没有成功`, "点「重试」；仍不行可以在服务器上手动执行下面的内容。", { detail: written.failed.detail, manual: written.failed.manual });
      }
      if (!mem.straysDecision) {
        const scan = await applier.scanStrays();
        if (scan.status === "found") {
          mem.strays = scan.items;
          return waiting({ kind: "strays", items: scan.items.map(({ file, line, text }) => ({ file, line, text })) });
        }
      }
      let strayNote = "";
      if (mem.straysDecision === "comment" && mem.strays?.length) {
        const result = await applier.commentStrays(mem.strays);
        strayNote = result.status === "commented" ? "，旧的代理设置已注释（原文件有备份）" : `，${result.failedFiles.map((f) => `~/${f}`).join("、")} 里的旧代理设置没能注释`;
      }
      mem.strays = null;
      const claude = await applier.syncClaudeSettings(opts);
      clusterEnvSync?.check?.(server.id)?.catch?.(() => {});
      const claudeNote = claude.action === "written" ? "，Claude Code 的代理设置已同步" : "";
      return done(`已写入 ~/.config/cluster-workbench/env.sh${strayNote}${claudeNote}；新开的终端生效`);
    },
  };

  // ---- fixture 模式：不碰网络与文件的假流程，给冒烟测试和界面预览用 ----
  const simulated = {
    async hostkey({ target }) {
      if (!mem.hostKey?.accepted) {
        mem.hostKey = { accepted: false, linesHash: "fixture" };
        return waiting({ kind: "hostkey", host: target.hostName || "cluster.example", port: target.port, fingerprints: [{ type: "ssh-ed25519", sha256: "SHA256:fixtureFixtureFixtureFixtureFixtureFixture0" }], linesHash: "fixture" });
      }
      return done("指纹已确认并保存");
    },
    async key() { return done(`已生成专用密钥 ~/.ssh/${DEDICATED_KEY_NAME}`); },
    async authorize({ target }) {
      const password = takePassword();
      const prompt = (error) => waiting({ kind: "password", user: target.user, host: target.hostName || "cluster.example", error, attempts: mem.passwordAttempts || 0, manualCommand: `cat ~/.ssh/${DEDICATED_KEY_NAME}.pub | ssh ${target.user}@cluster.example "…"` });
      if (mem.manualDone) return done("公钥已在服务器上，免密登录正常");
      if (!password) return prompt(null);
      if (password === "wrong") {
        mem.passwordAttempts = (mem.passwordAttempts || 0) + 1;
        return prompt("wrong-password");
      }
      return done("公钥已装好，之后不再需要密码");
    },
    async identity({ target }) {
      state.result.sshUser = target.user;
      return done(`已保存：${target.user}@${target.alias}`);
    },
    async port() {
      state.result.remotePort = 7892;
      state.result.registered = true;
      return done("已领取并登记端口 7892");
    },
    async tunnel() { return done("隧道已连通"); },
    async egress() { return done("全链路通（HTTP 401，420ms）"); },
    async clusterEnv() { return done("已写入 ~/.config/cluster-workbench/env.sh；新开的终端生效"); },
  };

  async function detectShortcut(target) {
    if (fixtureMode || !target.block) return false;
    if (target.block.user && target.block.user !== target.user) return false;
    const res = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=yes", "-l", target.user, target.alias, "echo CWB_LOGIN_OK"], { timeoutMs: 15000 });
    return res.code === 0 && String(res.stdout || "").includes("CWB_LOGIN_OK");
  }

  const isSettled = (id) => ["done", "skipped", "warn"].includes(state.steps[id].status);

  // 从第一个没做完的步骤开始往下走，直到全部完成、某一步失败、或某一步要人回答。
  async function runLoop({ only = null } = {}) {
    running = true;
    state.phase = "running";
    state.prompt = null;
    touch();
    try {
      const target = resolveTarget(await getConfig());
      if (!target?.hostName || !target.user) throw statusError("缺少服务器地址或用户名", 400, { code: "form" });
      if (!only && mem.shortcut === undefined) mem.shortcut = await detectShortcut(target);
      const table = fixtureMode ? simulated : handlers;
      for (const step of GUIDE_STEPS) {
        if (only ? step.id !== only : isSettled(step.id)) continue;
        setStep(step.id, { status: "running", error: null, detail: "" });
        if (fixtureMode) await sleep(350);
        let outcome;
        try {
          outcome = await table[step.id]({ target });
        } catch (error) {
          log(`onboarding guide: step ${step.id} threw: ${error.message}`);
          outcome = failed(error.code || "unexpected", error.message || "这一步出错了", "");
        }
        if (outcome.status === "waiting") {
          setStep(step.id, { status: "waiting" });
          state.phase = "waiting";
          state.prompt = { ...outcome.prompt, step: step.id };
          touch();
          return;
        }
        setStep(step.id, { status: outcome.status, detail: outcome.detail || "", error: outcome.error || null });
        if (outcome.status === "failed") {
          state.phase = "failed";
          touch();
          return;
        }
      }
      state.phase = "done";
      state.completedAt = state.completedAt || now();
      forgetPassword();
      mem = {};
      touch();
    } catch (error) {
      log(`onboarding guide: ${error.message}`);
      state.phase = "failed";
      touch();
    } finally {
      running = false;
    }
  }

  function launch(options) {
    currentRun = runLoop(options);
  }

  function assertIdle() {
    if (running) throw statusError("引导正在执行上一步，请稍候", 409, { code: "busy" });
    if (sshInstall.running) throw statusError("正在安装 OpenSSH 客户端，请稍候", 409, { code: "busy" });
  }

  const openSshPresent = () => fs.existsSync(path.win32.join(windowsOpenSshDir(), "ssh.exe"));

  // Windows：后台装系统自带的 OpenSSH 客户端（弹一次 UAC），装好后把它的目录补进本进程 PATH（不必重启），
  // 引导正停在「没有 ssh 命令」那一步时自动从断点继续。界面轮询 GET 看 openSsh.installing / error。
  function installOpenSsh() {
    if (platform !== "win32") throw statusError("只有 Windows 需要单独安装 OpenSSH 客户端", 400, { code: "unsupported" });
    if (fixtureMode) throw statusError("预览模式不安装系统组件", 409, { code: "fixture" });
    assertIdle();
    sshInstall = { running: true, error: null };
    const { file, args } = buildOpenSshInstallInvocation();
    log("onboarding: installing Windows OpenSSH client (UAC prompt)");
    currentRun = (async () => {
      let res;
      try {
        res = await exec(file, args, { timeoutMs: OPENSSH_INSTALL_TIMEOUT_MS });
      } catch (error) {
        res = { code: 1, stdout: "", stderr: String(error?.message || error) };
      }
      ensureWindowsOpenSshOnPath("ssh");
      if (!openSshPresent()) {
        sshInstall = { running: false, error: describeOpenSshInstallFailure(res) };
        log(`onboarding: OpenSSH client install failed (code ${res?.code ?? "?"})`, { level: "warn" });
        return;
      }
      sshInstall = { running: false, error: null };
      log("onboarding: OpenSSH client installed");
      const stuck = state.phase === "failed" && STEP_IDS.some((id) => state.steps[id].status === "failed" && state.steps[id].error?.code === "ssh-missing");
      if (stuck && state.form.sshUser) {
        retry();
        await currentRun;
      }
    })();
    return publicState();
  }

  // 新开一轮：记下表单，所有步骤回到待执行。password 可以不给——需要时页面会再问。
  function start(input = {}) {
    assertIdle();
    const config = getMergedConfig?.() || null;
    const sshUser = typeof input.sshUser === "string" ? input.sshUser.trim() : "";
    try { assertSafeSshUser(sshUser); } catch {
      throw statusError("请填写集群用户名（只能包含字母、数字、点、下划线和短横线）", 400, { code: "form", field: "sshUser" });
    }
    const form = { sshUser, hostName: typeof input.hostName === "string" ? input.hostName.trim() : "", sshPort: toPort(input.sshPort) };
    const target = resolveTarget(config, form);
    if (!target) throw statusError("团队配置里没有可接入的集群服务器", 409, { code: "unavailable" });
    if (!target.hostName) throw statusError("请填写集群地址（IP 或域名）", 400, { code: "form", field: "hostName" });
    try { assertSafeHost(target.hostName, "hostName"); } catch {
      throw statusError("集群地址里有不允许的字符", 400, { code: "form", field: "hostName" });
    }
    if (input.password != null && input.password !== "" && !validPassword(input.password)) {
      throw statusError("密码格式不对（不能为空或包含换行）", 400, { code: "form", field: "password" });
    }
    state = { ...emptyGuideState(STEP_IDS), dismissed: false, form, startedAt: now() };
    forgetPassword();
    mem = {};
    if (input.password) rememberPassword(input.password);
    launch();
    return publicState();
  }

  // 回答当前的问题，流程从提问的那一步接着走。
  function answer(input = {}) {
    assertIdle();
    const prompt = state.prompt;
    if (state.phase !== "waiting" || !prompt) throw statusError("现在没有等待回答的问题", 409, { code: "no-prompt" });
    if (input.kind !== prompt.kind) throw statusError("回答与当前的问题对不上，请刷新后重试", 409, { code: "prompt-mismatch" });
    if (prompt.kind === "hostkey") {
      if (input.accept !== true) {
        setStep("hostkey", { status: "failed", error: { code: "hostkey-declined", message: "没有确认服务器指纹", hint: "和管理员核对指纹后点「重试」。指纹不确认，后面的步骤不会执行。", detail: "", manual: "" } });
        state.phase = "failed";
        state.prompt = null;
        mem.hostKey = null;
        touch();
        return publicState();
      }
      if (!mem.hostKey || input.linesHash !== mem.hostKey.linesHash) throw statusError("指纹信息已过期，请重试这一步", 409, { code: "hostkey-stale" });
      mem.hostKey.accepted = true;
    } else if (prompt.kind === "password") {
      if (input.manualDone === true) {
        mem.manualDone = true;
      } else {
        if (!validPassword(input.password)) throw statusError("请输入密码", 400, { code: "form", field: "password" });
        rememberPassword(input.password);
      }
    } else if (prompt.kind === "ssh-config") {
      if (input.action !== "overwrite" && input.action !== "keep") throw statusError("请选择覆盖或保留", 400, { code: "form" });
      mem.sshConfigDecision = input.action;
    } else if (prompt.kind === "egress") {
      mem.egressDecision = input.action === "use-system" ? "use-system" : "skip";
    } else if (prompt.kind === "strays") {
      mem.straysDecision = input.action === "comment" ? "comment" : "keep";
    }
    launch();
    return publicState();
  }

  // 重试：失败 / 暂停时从第一个没做完的步骤继续；流程已走完时可以单独重跑一个"有提醒"的步骤（如出网自测）。
  function retry({ step = null } = {}) {
    assertIdle();
    if (state.phase === "idle") throw statusError("引导还没有开始", 409, { code: "not-started" });
    if (!state.form.sshUser) throw statusError("缺少用户名，请重新开始引导", 409, { code: "form" });
    if (step != null && !STEP_IDS.includes(step)) throw statusError("没有这个步骤", 400, { code: "form" });
    if (step && state.phase === "done") {
      mem.egressDecision = null;
      launch({ only: step });
      return publicState();
    }
    for (const id of STEP_IDS) {
      if (state.steps[id].status === "failed") state.steps[id] = { status: "pending", detail: "", error: null };
    }
    launch();
    return publicState();
  }

  function setDismissed(dismissed) {
    state.dismissed = dismissed === true;
    touch();
    return publicState();
  }

  // 清掉进度（设置页「重新运行引导」）。不撤销已经写下的任何东西——各步骤幂等，再走一遍只会确认一次。
  function reset() {
    assertIdle();
    state = emptyGuideState(STEP_IDS);
    forgetPassword();
    mem = {};
    store.clear();
    return publicState();
  }

  return {
    getState: publicState,
    // /api/status 用的精简摘要：界面据此决定要不要自动打开引导。
    getBrief: () => ({ phase: state.phase, dismissed: state.dismissed, busy: running }),
    start,
    answer,
    retry,
    installOpenSsh,
    setDismissed,
    reset,
    // 测试用：等当前这一轮执行告一段落。
    whenIdle: () => currentRun,
  };
}
