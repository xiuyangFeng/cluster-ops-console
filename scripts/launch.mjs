// scripts/launch.mjs
// `npm start` 的统一入口：环境闸门（Node 版本 / ssh 客户端）→ 首次运行检测（还没接入时说一句"页面里会引导"）
// → 按平台选择桌面壳或网页模式。纯判定逻辑都导出为纯函数供 launch.test.mjs 单测；
// 只有被直接执行时才会真的启动子进程（见文件末尾的 isMainModule 守卫）。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { waitForServerReady } from "../work/monitor/desktop-lifecycle.mjs";
import { AUTOSTART_ENV, AUTOSTART_FLAG, LAUNCHER_PATH_ENV } from "../work/monitor/lib/autostart/launch-flag.mjs";
import { mergeConfig } from "../work/monitor/lib/config-loader.mjs";
import { LAUNCHER_LOG_SOURCE } from "../work/monitor/lib/diagnostics/log-sources.mjs";
import { createLogger } from "../work/monitor/lib/logger.mjs";
import { assessSetup } from "../work/monitor/lib/onboarding.mjs";
import { decideLaunchMode, detectGui, isNodeVersionSupported, nodeVersionHint, sshMissingHint, whichCommand } from "../work/monitor/lib/platform.mjs";
import { resolveRuntimePaths } from "../work/monitor/lib/runtime-paths.mjs";
import { LAUNCHER_NODE_ENV, RESPAWN_ENV, RESTART_EXIT_CODE } from "../work/monitor/lib/self-update/restart-code.mjs";
import { readSshConfigUser } from "../work/monitor/lib/ssh-config-user.mjs";
import { isMainModule } from "./lib/is-main.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// 首次运行检测（纯函数）
// ---------------------------------------------------------------------------
// localState: "ok" | "missing" | "invalid"（个人层 config.local.json 读取结果）。
// 判定委托给 lib/onboarding.mjs 的 assessSetup——与 /api/status.onboarding 同一套逻辑：
//   - 个人层不存在：~/.ssh/config 能解析出主服务器 Host 别名的 User → 视为可用（只提示），否则引导；
//   - 个人层存在但 server-01 仍启用，且条目/全局/ssh config 都给不出 sshUser → 向导没走完；
//   - 个人层损坏 → 只提示修复，不引导重跑（向导读不了损坏文件，重跑也救不了）。
// resolveSshUser(hostAlias) 可注入（测试）；缺省不读盘。
export function detectSetupState({ team, local, localState = "ok", resolveSshUser = () => "" } = {}) {
  if (localState === "invalid") return { needsSetup: false, reason: "invalid-local-config" };
  const merged = mergeConfig(team || {}, localState === "ok" ? (local || {}) : {}, { warn: () => {} });
  const assessed = assessSetup({ localState, merged, resolveSshUser });
  if (assessed.state === "needs-setup" || assessed.state === "partial") return { needsSetup: true, reason: assessed.reason };
  if (assessed.reason === "no-local-config-ssh-ok") {
    return { needsSetup: false, reason: assessed.reason, host: assessed.host, sshUser: assessed.sshUser };
  }
  return { needsSetup: false, reason: null };
}

// 还没接入时终端里只说一句去向：页面打开后会自动进入接入引导（v2.60）。这里不再停下来问
// "要不要先跑命令行向导"——双击安装 / 双击启动的人面对的是一个等输入的终端窗口，而页面里能做完同样的事。
// 命令行向导仍在（npm run setup），作为页面打不开时的后备。
const GUIDE_HINT = "  页面打开后会自动进入接入引导，按提示填写集群用户名和密码即可。";
const WIZARD_FALLBACK = "  （页面打不开时的后备：在这个目录执行 npm run setup）";

export function setupHintLines(state, { localConfigPath = "config.local.json" } = {}) {
  if (!state?.reason) return [];
  if (state.reason === "no-local-config") {
    return [
      "ℹ 这台电脑还没有接入服务器。请先确认本机能连到服务器的 SSH（服务器只接受白名单网络时，先连上单位内网 / 校园网 / VPN）。",
      GUIDE_HINT,
      WIZARD_FALLBACK,
    ];
  }
  if (state.reason === "missing-ssh-user") {
    return [
      "ℹ 个人配置里还没有集群用户名，上次的接入可能没有走完（不在 SSH 白名单网络时会连不上，属预期）。",
      GUIDE_HINT,
      WIZARD_FALLBACK,
    ];
  }
  if (state.reason === "missing-port") {
    return [
      "ℹ 还没有领取集群上的专属反向端口，隧道不会建立（团队配置不预设端口，避免多人撞同一个）。",
      GUIDE_HINT,
      WIZARD_FALLBACK,
    ];
  }
  if (state.reason === "no-local-config-ssh-ok") {
    return [
      `ℹ 未找到个人配置 config.local.json，将直接使用 ~/.ssh/config 中 Host ${state.host || "?"} 的 User=${state.sshUser || "?"} 连接。`,
      "  如需专属反向端口，可在页面的「配置 → 接入引导」里领取。",
    ];
  }
  if (state.reason === "invalid-local-config") {
    return [
      `⚠ 个人配置 ${localConfigPath} 不是有效的 JSON，本次按团队默认配置运行。`,
      "  请修复该文件（或删除后在页面里重新走一遍接入引导；终端后备：npm run setup）。",
    ];
  }
  return [];
}

// 读盘版：团队层读不到时不做判断（不打扰，由 monitor-server 自己报错）。
export function readSetupState({ configPath, localConfigPath, readFile = readFileSync, resolveSshUser = () => "" } = {}) {
  let team;
  try {
    team = JSON.parse(readFile(configPath, "utf8"));
  } catch {
    return { needsSetup: false, reason: null };
  }
  let local = {};
  let localState = "ok";
  try {
    local = JSON.parse(readFile(localConfigPath, "utf8"));
    if (!local || typeof local !== "object" || Array.isArray(local)) localState = "invalid";
  } catch (err) {
    localState = err?.code === "ENOENT" ? "missing" : "invalid";
  }
  return detectSetupState({ team, local: localState === "ok" ? local : {}, localState, resolveSshUser });
}

// ---------------------------------------------------------------------------
// 网页模式：自动打开浏览器（纯函数）
// ---------------------------------------------------------------------------
export function shouldOpenBrowser({ argv = [], env = {}, platform = process.platform } = {}) {
  if (argv.includes("--no-open")) return false;
  // 开机自启（登录时由系统拉起）：在后台起，不弹浏览器；要看页面时点桌面图标。
  if (argv.includes(AUTOSTART_FLAG)) return false;
  if (/^(1|true|yes)$/i.test(String(env.CODEX_MONITOR_NO_OPEN ?? ""))) return false;
  if (env.CI) return false;
  if (platform === "darwin" || platform === "win32") return true;
  // Linux：没有图形会话（纯 SSH 登录等）时 xdg-open 只会报错，干脆不开。
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function browserOpenCommand(platform, url) {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` 是 cmd 内建命令；第一个带引号的参数会被当成窗口标题，所以显式传一个空标题 ""。
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", '""', url], options: { windowsVerbatimArguments: true } };
  return { command: "xdg-open", args: [url] };
}

export function consoleUrl(env = {}) {
  const port = Number(env.PORT);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 8877}`;
}

// ---------------------------------------------------------------------------
// 桌面壳没起来时回退网页模式（纯函数）
// ---------------------------------------------------------------------------
// macOS（尤其 Apple Silicon）上 node_modules 里的 Electron 壳会被系统拦下：签名失效 / 被隔离时一启动
// 就被 SIGKILL，或带着非零码秒退——用户在终端里只看到「启动桌面客户端…」，然后什么都没有。
// 判定"没起来"：启动后很短时间内就异常退出（被信号终止，或非零退出码）。正常关窗（code 0，含
// 单实例锁让第二次启动直接让位）不回退；跑了一阵之后才崩是另一类问题，回退只会让人更糊涂。
export const ELECTRON_BOOT_GRACE_MS = 15000;

export function shouldFallbackToWeb({ code, signal, elapsedMs, graceMs = ELECTRON_BOOT_GRACE_MS, argv = [] } = {}) {
  if (argv.includes("--no-web-fallback")) return false;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= graceMs) return false;
  return Boolean(signal) || (Number.isInteger(code) && code !== 0);
}

export function electronFailureLines({ code, signal, platform = process.platform } = {}) {
  const how = signal ? `被系统终止（${signal}）` : `退出码 ${code}`;
  const lines = ["", `⚠ 桌面客户端没能启动（${how}），已改用网页模式——功能完全相同。`];
  if (platform === "darwin") {
    lines.push(
      "  macOS 上多半是 Electron 壳的签名失效或被隔离。在仓库根目录执行下面这条，下次就能用桌面窗口：",
      "    xattr -cr node_modules/electron/dist/Electron.app && codesign --force --deep --sign - node_modules/electron/dist/Electron.app",
      "  若系统弹出安全提示，请点「取消」或「好」，不要点「移到废纸篓」。",
    );
  } else {
    lines.push("  可执行 npm run electron:install 重装桌面壳后再试。");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 启动链路的结构化记录（v2.64，纯函数）：runtime/logs/launcher.ndjson
// ---------------------------------------------------------------------------
// 开机自启时 launchd 把本进程的输出丢弃（lib/autostart/launch-agent.mjs），启动失败、桌面壳起不来、
// 监控服务异常退出与「停止自动拉起」只打在终端里谁也看不见。这几件事另记一条结构化日志（不是重定向输出）。
// 正常启动、已经有一份在跑都不记：没出事时不建数据目录、不写任何文件。
// kind → { level, message, fields }；不需要记的返回 null。
export function launcherEvent(kind, details = {}) {
  const code = details.code ?? null;
  const signal = details.signal ?? null;
  const how = signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? "-"}`;
  switch (kind) {
    case "gate-node-version":
      return { level: "error", message: `启动失败：Node.js ${details.version || "?"} 不受支持`, fields: { version: details.version ?? null } };
    case "gate-ssh-missing":
      return { level: "error", message: "启动失败：未检测到 ssh 客户端", fields: {} };
    case "electron-spawn-failed":
    case "monitor-spawn-failed":
      return {
        level: "error",
        message: `启动失败：${kind === "electron-spawn-failed" ? "桌面客户端" : "监控服务"}没能拉起（${details.message || "未知原因"}）`,
        fields: { error: details.message ?? null, errorCode: details.errorCode ?? null },
      };
    case "electron-boot-failed":
      return { level: "warn", message: `桌面客户端没能启动（${how}），已改用网页模式`, fields: { code, signal, elapsedMs: details.elapsedMs ?? null } };
    case "electron-exited":
      if (!signal && (code ?? 0) === 0) return null;
      return { level: "error", message: `桌面客户端异常退出（${how}）`, fields: { code, signal, elapsedMs: details.elapsedMs ?? null } };
    case "monitor-respawn":
      return { level: "info", message: "监控服务请求重启，正在重新拉起", fields: { code } };
    case "monitor-exited":
      if (code === RESTART_EXIT_CODE && !signal) {
        return { level: "error", message: "监控服务一分钟内连续要求重启，已停止自动拉起", fields: { code, signal, respawned: details.respawned === true, gaveUp: true } };
      }
      if (!signal && !code) return null;
      return { level: "error", message: `监控服务异常退出（${how}）`, fields: { code, signal, respawned: details.respawned === true } };
    case "launcher-failed":
      return { level: "error", message: `启动失败：${details.message || "未知原因"}`, fields: {} };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 以下为有副作用的启动流程，仅在直接执行时运行
// ---------------------------------------------------------------------------
// launcher.ndjson 的写入：第一次真要记的时候才建日志器（createLogger 会建目录）。记录失败一律吞掉。
let launcherLogger = null;
let launcherAutostart = false;
function recordLauncherEvent(kind, details) {
  const event = launcherEvent(kind, details);
  if (!event) return;
  try {
    if (!launcherLogger) {
      const paths = resolveRuntimePaths({ appRoot: rootDir, env: process.env, homeDir: os.homedir() });
      launcherLogger = createLogger(LAUNCHER_LOG_SOURCE, { dir: paths.logsDir, defaultFields: { origin: "launch-script" } });
    }
    launcherLogger[event.level](event.message, { event: kind, autostart: launcherAutostart, ...event.fields });
  } catch {}
}

// 退出前把已记的写完（日志器是异步批量写的）；最多等 2 秒。
async function flushLauncherLog() {
  if (!launcherLogger) return;
  await Promise.race([launcherLogger.flush().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
}

function exitAfterLog(code) {
  flushLauncherLog().finally(() => process.exit(code));
}
function hasCommand(cmd) {
  return spawnSync(whichCommand(process.platform), [cmd], { stdio: "ignore" }).status === 0;
}

function electronAvailable() {
  try {
    const electronPath = createRequire(import.meta.url)("electron");
    return typeof electronPath === "string" && existsSync(electronPath);
  } catch {
    return false;
  }
}

function checkFirstRun({ dryRun }) {
  const skip = process.argv.includes("--skip-setup-check") || /^(1|true|yes)$/i.test(String(process.env.CODEX_MONITOR_SKIP_SETUP_CHECK ?? ""));
  if (skip) return null;
  const paths = resolveRuntimePaths({ appRoot: rootDir, env: process.env, homeDir: os.homedir() });
  const state = readSetupState({
    configPath: paths.configPath,
    localConfigPath: paths.localConfigPath,
    resolveSshUser: (hostAlias) => readSshConfigUser(hostAlias),
  });
  if (dryRun) return state;
  const lines = setupHintLines(state, { localConfigPath: paths.localConfigPath });
  if (lines.length === 0) return state;
  console.log("");
  for (const line of lines) console.log(line);
  console.log("");
  return state;
}

function openBrowser(url) {
  const { command, args, options = {} } = browserOpenCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, ...options });
    child.on("error", () => console.log(`未能自动打开浏览器，请手动访问 ${url}`));
    child.unref();
  } catch {
    console.log(`未能自动打开浏览器，请手动访问 ${url}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const forceWeb = argv.includes("--web");
  const verbose = argv.includes("--verbose");
  const autostart = argv.includes(AUTOSTART_FLAG);
  launcherAutostart = autostart;
  // 下面两道闸（Node 版本、ssh 客户端）过不去，不是隔一分钟再试就能好的。开机自启时以 0 结束：
  // launchd 只在非零退出时重拉（lib/autostart/launch-agent.mjs），否则它会每分钟空拉一次直到注销，
  // 输出又都丢弃，谁也看不见。平时（终端里启动）照旧以 1 结束。
  const gateExitCode = autostart ? 0 : 1;

  if (!isNodeVersionSupported(process.version)) {
    console.error(`✘ 当前 Node.js ${process.version} 不受支持。`);
    console.error(`  ${nodeVersionHint()}`);
    recordLauncherEvent("gate-node-version", { version: process.version });
    await flushLauncherLog();
    process.exit(gateExitCode);
  }
  // 过了上面这道闸的是「这个」Node；桌面模式下监控服务跑在 Electron 自带的 Node 上，看不到它。
  // 经环境变量带下去（两种模式的子进程都继承），自更新预检目标版本的 Node 要求时对的才是这道闸会看的版本。
  process.env[LAUNCHER_NODE_ENV] = process.versions.node;
  // 开机自启的两个约定同样经环境变量带下去（lib/autostart/launch-flag.mjs）：这一刻的 PATH（写自启文件时用，
  // 登录时 start.sh 按它找到的才是同一个 node / git / ssh），以及「这一份是不是开机自启拉起来的」。
  process.env[LAUNCHER_PATH_ENV] = process.env.PATH ?? "";
  if (autostart) process.env[AUTOSTART_ENV] = "1";
  else delete process.env[AUTOSTART_ENV];

  if (!hasCommand("ssh")) {
    console.error("✘ 未检测到 ssh 客户端。");
    console.error(`  ${sshMissingHint(process.platform)}`);
    recordLauncherEvent("gate-ssh-missing");
    await flushLauncherLog();
    process.exit(gateExitCode);
  }

  const setupState = checkFirstRun({ dryRun });

  const mode = forceWeb
    ? "web"
    : decideLaunchMode({
      platform: process.platform,
      hasGui: detectGui(),
      electronAvailable: electronAvailable(),
    });

  if (dryRun) {
    console.log(JSON.stringify({
      platform: process.platform,
      hasGui: detectGui(),
      mode,
      setup: setupState?.reason ?? "ok",
      openBrowser: mode === "web" && shouldOpenBrowser({ argv, env: process.env }),
    }, null, 2));
    process.exit(0);
  }

  if (mode === "electron") {
    console.log("启动桌面客户端 (Electron)...");
    const startedAt = Date.now();
    // 开机自启时桌面壳放进自己的进程组（detached）：launchd 在本进程退出时会清掉同一进程组里剩下的进程，
    // 而「重启界面」正是桌面壳以 0 退出（本进程随之退出）之后才由它的 relauncher 拉起新实例——不分开，新实例起不来。
    const child = spawn(process.execPath, [path.join(rootDir, "node_modules/electron/cli.js"), "."], { cwd: rootDir, stdio: "inherit", detached: autostart });
    child.on("error", (e) => {
      console.error("启动失败:", e.message);
      recordLauncherEvent("electron-spawn-failed", { message: e.message, errorCode: e.code });
      exitAfterLog(1);
    });
    child.on("exit", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      if (shouldFallbackToWeb({ code, signal, elapsedMs, argv })) {
        for (const line of electronFailureLines({ code, signal })) console.log(line);
        recordLauncherEvent("electron-boot-failed", { code, signal, elapsedMs });
        startWeb({ argv, verbose }).catch((err) => {
          console.error(`启动失败: ${err.message}`);
          recordLauncherEvent("launcher-failed", { message: err.message });
          exitAfterLog(1);
        });
        return;
      }
      recordLauncherEvent("electron-exited", { code, signal, elapsedMs });
      exitAfterLog(signal ? 1 : (code ?? 0));
    });
    return;
  }

  await startWeb({ argv, verbose });
}

// 监控服务以 RESTART_EXIT_CODE 结束 = 「请把我重新拉起来」（自更新后重启；守护进程、本地代理与隧道是
// 分离的进程，不受影响，新进程按热启动接管）。一分钟内连着要了 max 次说明新代码起来就退，不再空转。
export function shouldRespawn({ code, signal, recent = [], now = Date.now(), windowMs = 60_000, max = 3 } = {}) {
  if (signal || code !== RESTART_EXIT_CODE) return false;
  return recent.filter((t) => now - t < windowMs).length < max;
}

// 监控服务异常退出时给终端的一句话。respawned：这个进程是自更新后重新拉起的那一个——新版本一起来就退，
// 最可能是这次更新的问题，直接给出回退命令（自检只起了监控服务的演示模式，盖不住所有启动路径）。
export function monitorExitMessage({ code, signal, respawned = false } = {}) {
  if (code === RESTART_EXIT_CODE) {
    return "监控服务一分钟内连续要求重启，已停止自动拉起。要回到上一个版本：npm run update -- --rollback，然后重新 npm run start";
  }
  if (!code && !signal) return null;
  const base = `监控服务退出（code=${code ?? "-"} signal=${signal ?? "-"}）。请查看终端输出或 work/runtime/logs/ops.ndjson`;
  return respawned
    ? `${base}\n这是刚更新完的新版本，隧道不受影响。要回到上一个版本：npm run update -- --rollback，然后重新 npm run start`
    : base;
}

// 监控服务退出后本进程用什么退出码结束。开机自启时本进程由 launchd 看着（非零退出才重拉，见
// lib/autostart/launch-agent.mjs）：监控服务异常退出时照旧把退出码带出去，由 launchd 隔一阵再拉一次；
// 但「一分钟内连着要求重启、这里已经判定不该再拉」的那一次要以 0 结束——否则 launchd 接着拉、
// 拉起来又是三连退，变成两头轮流拉一个起来就退的版本。平时（终端里启动）退出码原样不变。
export function launcherExitCode({ code, signal, autostart = false } = {}) {
  if (signal) return 1;
  if (autostart && code === RESTART_EXIT_CODE) return 0;
  return code ?? 0;
}

// 网页模式：起 monitor-server（带随机鉴权 token），就绪后按需打开浏览器。
async function startWeb({ argv, verbose }) {
  // C3 修复：Web 模式（无桌面客户端）此前从不设置 AUTH_TOKEN，monitor-server 的鉴权因此
  // 整体短路——写端点（/api/start /api/stop /api/restart 等）任何人免鉴权可调用，恶意网页
  // 可 CSRF、同机其他用户可直接 curl DoS 全队隧道。这里补齐：若未从环境变量显式传入
  // AUTH_TOKEN（例如受控部署场景显式指定，此时尊重之不覆盖），则生成随机 token，经环境变量
  // 注入子进程，并落盘 runtime/auth-token（0600）供人工 / 脚本读取。
  // 浏览器页面自己经 /api/session 取 token，普通用户用不到它，所以默认不在终端打印（--verbose 才打印）。
  // 生成与落盘留到确认「得自己起服务」之后（下面探测过后才调用）：已经有一份在跑时这里什么都不写——
  // 那一份用的是它自己的 token，覆盖掉 runtime/auth-token 会让照着文件调写接口的脚本拿到一个没人认的 token。
  let authToken = process.env.AUTH_TOKEN || "";
  let tokenFilePath = null;
  const prepareAuthToken = () => {
    if (authToken) return;
    authToken = randomBytes(16).toString("hex");
    try {
      const paths = resolveRuntimePaths({ appRoot: rootDir, env: process.env, homeDir: os.homedir() });
      mkdirSync(paths.runtimeDir, { recursive: true });
      tokenFilePath = path.join(paths.runtimeDir, "auth-token");
      writeFileSync(tokenFilePath, authToken, { mode: 0o600 });
    } catch (e) {
      console.error("警告：无法写入 auth-token 文件（写操作鉴权仍然生效）：", e.message);
    }
  };
  if (process.platform === "darwin" && detectGui() && !electronAvailable()) {
    console.log("桌面壳未就绪，已回退网页模式。需要窗口时执行: npm run electron:install");
  }
  // PORT=0 只适合 fixture/冒烟测试：monitor-server 会随机监听，但启动器无法在
  // 子进程 ready 行里可靠传回端口，继续使用 0 会把浏览器探测到错误的 8877。
  // 网页启动路径因此把它收口到默认控制面端口；fixture 直接启动 server，不经过这里。
  const webEnv = { ...process.env };
  if (String(webEnv.PORT ?? "").trim() === "0") delete webEnv.PORT;
  const url = consoleUrl(webEnv);
  const autoOpen = shouldOpenBrowser({ argv, env: webEnv });
  // 桌面壳刚死但它拉起的后台服务还活着（端口仍在应答）：再起一份只会撞端口，直接用现成的那份。
  // 只探一次（timeoutMs: 0）：没有服务时连接立刻被拒，不拖慢正常启动。
  if (await waitForServerReady({ url: `${url}/api/session`, timeoutMs: 0, intervalMs: 200 })) {
    console.log(`控制台已在运行：${url}`);
    if (autoOpen) openBrowser(url);
    return;
  }
  prepareAuthToken();
  console.log("");
  console.log("==================================================");
  console.log("  集群运维工作台 (Codex Operations Console) — 网页模式");
  console.log(`  控制台地址:  ${url}`);
  console.log(autoOpen
    ? "  服务就绪后会自动在浏览器中打开（不想自动打开: --no-open 或 CODEX_MONITOR_NO_OPEN=1）"
    : "  请在浏览器中打开上面的地址");
  console.log("  提示: 若本机挂着代理/梯子打不开页面，请将代理设为「规则模式 (Rule)」让 127.0.0.1 直连");
  console.log("  按 Ctrl+C 停止");
  console.log("==================================================");
  console.log("");
  if (verbose) {
    console.log(`鉴权 Token（脚本调用写接口时经 x-auth-token 请求头传入）：${authToken}`);
    if (tokenFilePath) console.log(`Token 已写入：${tokenFilePath}`);
  }
  const respawnedAt = [];
  const spawnMonitor = () => {
    const child = spawn(process.execPath, [path.join(rootDir, "work/monitor/monitor-server.mjs")], {
      cwd: rootDir,
      stdio: "inherit",
      // RESPAWN_ENV：告诉监控服务「我退出后有人会把我拉起来」，它才提供「重启监控服务」这个动作。
      env: { ...webEnv, AUTH_TOKEN: authToken, [RESPAWN_ENV]: "1" },
    });
    // 子进程出错/退出时本进程随之退出，等待就绪的轮询不会空转到超时。
    child.on("error", (e) => {
      console.error("启动失败:", e.message);
      recordLauncherEvent("monitor-spawn-failed", { message: e.message, errorCode: e.code });
      exitAfterLog(1);
    });
    child.on("exit", (code, signal) => {
      if (shouldRespawn({ code, signal, recent: respawnedAt })) {
        respawnedAt.push(Date.now());
        console.log("监控服务请求重启（刚更新过），正在重新拉起；隧道保持连接。");
        recordLauncherEvent("monitor-respawn", { code });
        spawnMonitor();
        return;
      }
      // 更新后拉起的进程一分钟内就退才提回退：跑了很久之后的退出（比如被手动结束）与这次更新无关。
      const respawned = respawnedAt.length > 0 && Date.now() - respawnedAt.at(-1) < 60_000;
      const message = monitorExitMessage({ code, signal, respawned });
      if (message) console.error(message);
      recordLauncherEvent("monitor-exited", { code, signal, respawned });
      flushLauncherLog().finally(() => {
        process.exit(launcherExitCode({ code, signal, autostart: argv.includes(AUTOSTART_FLAG) }));
      });
    });
  };
  spawnMonitor();
  if (autoOpen) {
    const ready = await waitForServerReady({ url: `${url}/api/session`, timeoutMs: 20000, intervalMs: 400 });
    if (ready) openBrowser(url);
  }
}

// 只在被直接执行时启动；被测试 import 时不得产生任何副作用（判定见 lib/is-main.mjs）。
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`启动失败: ${err.message}`);
    recordLauncherEvent("launcher-failed", { message: err.message });
    exitAfterLog(1);
  });
}
