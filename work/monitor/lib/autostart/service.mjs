// 「登录电脑后自动启动」的业务层（GET / POST /api/autostart，v2.62）。
//
// 按安装形态各走各的办法：
//   macOS 源码安装  用户级 LaunchAgent（launch-agent.mjs）。开 = 写 plist，下次登录由 launchd 自己加载；
//                   关 = 先 launchctl bootout 再删 plist。
//   Windows         「启动」文件夹里的一个 .cmd（windows-startup.mjs）。开 = 写文件，关 = 删文件。
//   打包的 .app     Electron 的登录项接口，在桌面壳里（desktop/login-item.mjs，页面经 IPC 调）；这里只如实
//                   回「归桌面窗口管」，POST 一律 409。
//   Linux           不支持，给一条手动命令。
//
// 两条不变的规矩：
//   - 只动带标记的文件。同名文件不是工作台放的（没有 AUTOSTART_MARKER）→ 不改、不删，开和关都 409。
//   - 开关不影响正在跑的这一份。打开时只写文件、不调 launchctl（当场 bootstrap 会让 launchd 立刻再起一份）；
//     关闭时，这一份如果就是开机自启拉起来的（启动器带下来的 AUTOSTART_ENV，或 launchd 给的
//     XPC_SERVICE_NAME），不执行 bootout——那等于把正在用的这一份结束掉——只删 plist，下次登录不再启动。
//
// 写文件、launchctl 都经注入的 fs / exec，路径可注入；fixture 模式下文件只在内存里、launchctl 不执行。
import * as nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { execFileWithTimeout } from "../exec.mjs";
import { shellSingleQuote } from "../shell/quote.mjs";
import { statusError } from "../status-error.mjs";
import {
  buildLaunchAgentPlist,
  buildLaunchPath,
  isLaunchAgentRoot,
  LAUNCH_AGENT_LABEL,
  launchAgentPath,
  launchAgentProgram,
  parseLaunchAgentPlist,
} from "./launch-agent.mjs";
import { AUTOSTART_ENV, AUTOSTART_FLAG, LAUNCHER_PATH_ENV } from "./launch-flag.mjs";
import {
  buildStartupCmd,
  isStartupRoot,
  parseStartupCmd,
  STARTUP_FILE_NAME,
  sameWindowsPath,
  startupTarget,
  windowsStartupDir,
} from "./windows-startup.mjs";

const LAUNCHCTL_TIMEOUT_MS = 15000;
// launchctl bootout 对「没加载过」的退出码：3（No such process）；个别系统版本报 113（找不到服务）。
const LAUNCHCTL_NOT_LOADED_CODES = new Set([3, 113]);
// 登录时由 launchd 起的 bash 读这些目录里的文件，macOS 会先问用户是否允许（终端里启动时问的是「终端」）。
const PROTECTED_HOME_DIRS = ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"];

// fixture 模式（冒烟 / 界面预览）：文件只在内存里——真实的登录启动项一个字节都不碰。
function createMemoryFs() {
  const files = new Map();
  const missing = (file) => Object.assign(new Error(`ENOENT: no such file, ${file}`), { code: "ENOENT" });
  return {
    readFile: async (file) => {
      if (!files.has(file)) throw missing(file);
      return files.get(file);
    },
    writeFile: async (file, body) => {
      files.set(file, String(body));
    },
    rename: async (from, to) => {
      if (!files.has(from)) throw missing(from);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlink: async (file) => {
      if (!files.delete(file)) throw missing(file);
    },
    mkdir: async () => {},
    chmod: async () => {},
  };
}

// dir 是不是 parent 本身或在它里面。按字面比较、两种分隔符都认：测试在任何系统上都能拿 macOS 形状的路径跑。
function isInside(dir, parent) {
  if (typeof dir !== "string" || typeof parent !== "string") return false;
  const base = parent.replace(/[\\/]+$/, "");
  if (!base) return false;
  return dir === base || (dir.startsWith(base) && /^[\\/]/.test(dir.slice(base.length)));
}

export function createAutostartService({
  platform = process.platform,
  // 打包的 App（lib/runtime-paths.mjs 的 isPackagedApp：macOS .app 与 Windows 安装版）：登录项归桌面壳。
  packaged = false,
  fixtureMode = false,
  rootDir,
  homeDir = os.homedir(),
  env = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  // 这份监控服务是不是跑在桌面壳里（Electron 自带的 Node）：那时它自己的 PATH 被入口改过顺序。
  desktopShell = Boolean(process.versions.electron),
  // node:fs/promises 的形状：readFile / writeFile / rename / unlink / mkdir / chmod。
  fs = nodeFs,
  // (command, args, { timeoutMs }) → { code, stdout, stderr, timedOut }，永不 reject（lib/exec.mjs）。
  exec = execFileWithTimeout,
  launchAgentFile = launchAgentPath(homeDir),
  startupDir = windowsStartupDir(env),
  log = () => {},
} = {}) {
  const io = fixtureMode ? createMemoryFs() : fs;
  const run = fixtureMode ? async () => ({ code: 0, stdout: "", stderr: "" }) : exec;
  // 这一份是不是开机自启拉起来的。两个信号任一成立就算：宁可多判成「是」（少做一次 bootout，
  // 留下一个到注销为止的空登记），也不能漏判（bootout 会把自己结束掉）。
  const fromAutostart = env?.[AUTOSTART_ENV] === "1" || (platform === "darwin" && env?.XPC_SERVICE_NAME === LAUNCH_AGENT_LABEL);
  const home = String(homeDir ?? "").replace(/[\\/]+$/, "");
  // 给人看的位置：macOS 上把用户目录缩成 ~。
  const displayPath = (file) => (platform !== "win32" && isInside(file, home) ? `~${file.slice(home.length)}` : file);

  async function readText(file) {
    try {
      return { text: String(await io.readFile(file, "utf8")), error: null };
    } catch (err) {
      if (err?.code === "ENOENT") return { text: null, error: null };
      return { text: null, error: err?.code || err?.message || "read failed" };
    }
  }

  // 同目录临时文件 + rename；目录没有就建（新账号下 ~/Library/LaunchAgents 默认不存在）。
  async function writeText(file, text, mode) {
    await io.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, text, { fs: io });
    try {
      await io.chmod(file, mode);
    } catch {}
  }

  async function removeFile(file) {
    try {
      await io.unlink(file);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  // ---- 各形态的后端：{ method, file, mode, caveats, enableBlocked?, render(), classify(text), beforeRemove? }；
  // 这台电脑上用不了时是 { method, unsupported: 原因 } ----
  function launchAgentBackend() {
    if (!isLaunchAgentRoot(rootDir)) return { method: "launch-agent", unsupported: "unsafe-path" };
    const script = launchAgentProgram(rootDir)[1];
    const caveats = [];
    if ((home && PROTECTED_HOME_DIRS.some((name) => isInside(rootDir, `${home}/${name}`))) || rootDir.startsWith("/Volumes/")) {
      caveats.push("protected-folder");
    }
    // 写进 plist 的 PATH 取启动器当时的那一份（经环境变量带下来，顺序与手动启动时一致）。
    // 网页模式下没带（监控服务换成了新版、启动器还是更新前的）可以用自己的：两者本来就是同一份。
    // 桌面壳里不行：入口往 PATH 最前面插过一串目录（desktop/context.mjs 的 buildDesktopPathEnv），拿它写 plist，
    // 登录时 start.sh 先找到的可能是 Homebrew / /usr/local 的 node，版本不对就起不来，而且这个顺序会一直传下去。
    // 新版的桌面壳入口会把原来的 PATH 取回来带下；只有入口还是旧代码时才会缺——那就不猜，打开开关时拒绝并说明怎么办。
    const launcherPath = env?.[LAUNCHER_PATH_ENV] || "";
    const pathUnknown = desktopShell && !launcherPath;
    if (pathUnknown) caveats.push("launcher-path-unknown");
    return {
      method: "launch-agent",
      file: launchAgentFile,
      mode: 0o644,
      caveats,
      enableBlocked: pathUnknown
        ? () => statusError("这一份工作台拿不到启动时的 PATH（多半是更新之后还没有完整重启），现在写开机自启可能找错 Node。请完全退出工作台，从桌面图标再启动一次，然后回来打开这个开关。", 409, { code: "launcher-path-unknown" })
        : null,
      render: () => buildLaunchAgentPlist({ repoRoot: rootDir, pathEnv: buildLaunchPath({ pathEnv: launcherPath || env?.PATH || "" }) }),
      classify(text) {
        const { managed, program } = parseLaunchAgentPlist(text);
        if (!managed) return { state: "foreign" };
        if (program.includes(script)) return { state: "on" };
        return { state: "other-install", target: program.find((arg) => arg.endsWith("/start.sh")) ?? program[1] ?? null };
      },
      // 先让 launchd 放下这个任务，再删文件。任务没加载过是最常见的情况（开关是这次登录里才打开的）。
      async beforeRemove() {
        if (fromAutostart) return "left-running";
        // 拿不到用户号就拼不出 launchd 的目标（macOS 上不会发生）：不猜，只删文件。
        if (!Number.isInteger(uid)) return "skipped";
        const result = await run("launchctl", ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
        if (result?.code === 0) return "booted-out";
        if (LAUNCHCTL_NOT_LOADED_CODES.has(result?.code) && !result?.timedOut) return "not-loaded";
        log(`autostart: launchctl bootout exited ${result?.code}${result?.timedOut ? " (timed out)" : ""}: ${String(result?.stderr || "").trim().slice(0, 200)}`, { level: "warn", event: "autostart" });
        return "failed";
      },
    };
  }

  function startupFolderBackend() {
    if (!startupDir) return { method: "startup-folder", unsupported: "no-startup-folder" };
    if (!isStartupRoot(rootDir)) return { method: "startup-folder", unsupported: "unsafe-path" };
    const target = startupTarget(rootDir);
    const userProfile = env?.USERPROFILE || "";
    return {
      method: "startup-folder",
      file: path.join(startupDir, STARTUP_FILE_NAME),
      mode: 0o644,
      caveats: [],
      render: () => buildStartupCmd({ repoRoot: rootDir, userProfile }),
      classify(text) {
        const parsed = parseStartupCmd(text, { userProfile });
        if (!parsed.managed) return { state: "foreign" };
        if (sameWindowsPath(parsed.target, target)) return { state: "on" };
        return { state: "other-install", target: parsed.target };
      },
    };
  }

  function pickBackend() {
    if (packaged) return { method: "login-item", desktop: true };
    if (platform === "darwin") return launchAgentBackend();
    if (platform === "win32") return startupFolderBackend();
    return {
      method: "none",
      unsupported: "platform",
      // 关掉终端也不停的后台运行；开机自启由用户自己加进桌面环境的自启动项。
      manualCommand: `nohup bash ${shellSingleQuote(path.posix.join(String(rootDir ?? ""), "start.sh"))} ${AUTOSTART_FLAG} >/dev/null 2>&1 &`,
    };
  }
  const backend = pickBackend();

  const payload = (fields) => ({
    supported: !backend.unsupported,
    method: backend.method,
    enabled: false,
    state: "off",
    file: backend.file ? displayPath(backend.file) : null,
    target: null,
    fromAutostart,
    caveats: backend.caveats ?? [],
    reason: backend.unsupported ?? null,
    manualCommand: backend.manualCommand ?? null,
    detail: null,
    ...fields,
  });

  async function inspect() {
    if (backend.unsupported) return { state: "off" };
    const { text, error } = await readText(backend.file);
    if (error) return { state: "unknown", detail: error };
    if (text == null) return { state: "off" };
    return { ...backend.classify(text), text };
  }

  async function status() {
    // 登录项的开 / 关在桌面壳那边：这里不知道，如实给 null。
    if (backend.desktop) return payload({ enabled: null });
    const { state, target = null, detail = null } = await inspect();
    return payload({ enabled: state === "on", state, target, detail });
  }

  const refuse = (current) => {
    if (current.state === "foreign") {
      return statusError(`${displayPath(backend.file)} 已经存在，但不是工作台放的，没有改动它。要用这个开关，请先自己把它移走。`, 409, { code: "foreign-file" });
    }
    return statusError(`读不出 ${displayPath(backend.file)}（${current.detail}），没有改动它。`, 409, { code: "unreadable" });
  };

  // 写 / 删没做成（目录不可写、被别的东西占着……）：说清是哪个文件、什么原因，而不是把一条裸的系统报错抛给页面。
  const ioFailure = (verb, err) => statusError(`${verb} ${displayPath(backend.file)}（${err?.code || err?.message || "未知错误"}）。`, 500, { code: "io-failed" });

  async function apply(enabled) {
    if (backend.desktop) throw statusError("打包的 App 的登录项在它的桌面窗口里设置（配置 → 启动）。", 409, { code: "desktop-only" });
    if (backend.unsupported) throw statusError("这台电脑上不支持自动设置开机自启。", 409, { code: backend.unsupported });
    const current = await inspect();
    if (current.state === "foreign" || current.state === "unknown") throw refuse(current);
    if (enabled) {
      if (backend.enableBlocked) throw backend.enableBlocked();
      const desired = backend.render();
      // 内容没变不重写（重复打开）；指向别的安装目录、或 PATH 变了，才改写。
      const changed = current.text !== desired;
      if (changed) {
        try {
          await writeText(backend.file, desired, backend.mode);
        } catch (err) {
          throw ioFailure("写不了", err);
        }
      }
      return { ...(await status()), changed, launchd: null };
    }
    // 关：只处理指向这个安装目录的那一份。指向别处的不是这一份开的，对这一份来说本来就是关着的。
    if (current.state !== "on") return { ...(await status()), changed: false, launchd: null };
    const launchd = backend.beforeRemove ? await backend.beforeRemove() : null;
    try {
      await removeFile(backend.file);
    } catch (err) {
      throw ioFailure("删不掉", err);
    }
    return { ...(await status()), changed: true, launchd };
  }

  // 开 / 关串行：连点两下、两个窗口同时点，后一次看到的是前一次做完之后的文件。
  let queue = Promise.resolve();
  function setEnabled(enabled) {
    const next = queue.then(() => apply(enabled === true));
    queue = next.catch(() => {});
    return next;
  }

  return { status, setEnabled };
}
