// control-plane-restart.mjs —— 热更新 B：控制面（Electron 主进程 + monitor-server）重启的纯决策逻辑。
//
// 背景：数据面（channel-supervisor / local-proxy / ssh 隧道）是 detached 进程，
// cleanupBackground() 在 !isQuitting 时只停 monitor-server、保留数据面（热接管）。
// "重启界面"就是走这条隐式路径 → app.relaunch() + app.exit(0)，隧道全程不断。
//
// 三组标志的语义（electron-main.mjs）：
//   isQuitting          显式退出：会停止数据面。重启界面绝不置它。
//   quitConfirmed       W5 退出确认已通过（仅显式退出路径使用）。
//   cleanupStarted      显式退出的清理已开始（防重入）。
//   controlPlaneRestarting  重启界面进行中：before-quit 一律拦下（重启路径自己 app.exit），
//                       既不弹 W5 确认框，也不被当成显式退出去停数据面。
// 本模块零副作用，便于 node:test 直接覆盖状态机。

import { computeBuildCompatibility } from "./build-info.mjs";

export const DESKTOP_MAIN_RECORD = "desktop-main";
// 重启时写入环境变量（relaunch 出来的新实例继承），新实例据此在单实例锁暂未释放时短暂重试。
export const RELAUNCH_MARKER_ENV = "CODEX_CONSOLE_RELAUNCHED_AT";
const RELAUNCH_MARKER_WINDOW_MS = 60_000;
export const BUNDLE_UPDATE_CHECK_MS = 30_000;

// before-quit 决策：
//   "block-restarting" 重启界面进行中 → preventDefault 并忽略（重启路径用 app.exit 结束进程）
//   "pass-through"     显式退出清理已在进行 → 放行
//   "prompt-open"      确认框已弹出 → preventDefault，不重复弹
//   "prompt"           未确认的退出（Cmd+Q 等）→ preventDefault 并弹 W5 确认框
//   "cleanup"          已确认的显式退出 → 置 isQuitting，异步清理（停数据面）后 app.exit
export function decideBeforeQuit({ controlPlaneRestarting, cleanupStarted, quitConfirmed, quitPromptOpen } = {}) {
  if (controlPlaneRestarting) return "block-restarting";
  if (cleanupStarted) return "pass-through";
  if (!quitConfirmed) return quitPromptOpen ? "prompt-open" : "prompt";
  return "cleanup";
}

// 是否可以开始重启界面。重复触发（信号 + 托盘 + 按钮同时到）只执行第一次；
// 显式退出已在清理 / W5 确认框正开着时不抢（让用户的退出决定优先，更新横幅之后会再提示）。
// dataPlaneUpgrading：数据面升级（supervisor/代理交接）正在进行（runtime 下有新鲜的在飞标记）。
// 此时重启控制面会让旧 monitor 带着交接中途被停、守护巡检的 hold 丢失，新 monitor 看到
// "没有 supervisor" → 可能误判为需要清场。拒绝并提示稍候（信号触发的重启由调用方稍后重试）。
export const DATA_PLANE_UPGRADING_MESSAGE = "后台组件升级中，请稍候";
export function decideControlPlaneRestart({ ready, controlPlaneRestarting, cleanupStarted, isQuitting, quitPromptOpen, dataPlaneUpgrading } = {}) {
  if (controlPlaneRestarting) return { ok: false, reason: "already-restarting" };
  if (cleanupStarted || isQuitting) return { ok: false, reason: "quitting" };
  if (quitPromptOpen) return { ok: false, reason: "quit-prompt-open" };
  if (!ready) return { ok: false, reason: "not-ready" };
  if (dataPlaneUpgrading) return { ok: false, reason: "data-plane-upgrading", message: DATA_PLANE_UPGRADING_MESSAGE };
  return { ok: true, reason: "ok" };
}

const hasBuild = (b) => Boolean(b && (b.version || b.gitCommit));

// 运行构建（启动时冻结）vs 磁盘构建（周期重读）：不同 → 返回待生效更新，否则 null。
// 规则直接复用 build-info.mjs computeBuildCompatibility 的 restart-monitor（commit 优先，其次 version）；
// 额外：运行包无元信息而磁盘有（老构建被覆盖升级）也视为有更新。磁盘读不到 → null（不猜）。
export function detectBundleUpdate({ running, disk } = {}) {
  if (!hasBuild(disk)) return null;
  const changed = !hasBuild(running)
    || computeBuildCompatibility({ monitorBuild: running, bundleBuild: disk }).reasons.includes("restart-monitor");
  if (!changed) return null;
  const update = { version: disk.version || "", gitCommit: disk.gitCommit || "", builtAt: disk.builtAt || "" };
  update.key = `${update.version}|${update.gitCommit}|${update.builtAt}`;
  return update;
}

export function formatUpdateVersion(update) {
  if (!update) return "";
  if (update.version) return `v${String(update.version).replace(/^v/, "")}`;
  return update.gitCommit ? `commit ${String(update.gitCommit).slice(0, 8)}` : "";
}

export function buildUpdateMenuLabel(update) {
  const version = formatUpdateVersion(update);
  return `新版本${version ? ` ${version}` : ""} 已安装 · 重启界面（隧道不中断）`;
}

// 新实例拿不到单实例锁时：只有带着"刚由重启界面拉起"的标记（且在时间窗内）才值得重试；
// 普通的重复启动仍按原逻辑立即退出、把焦点交给已在运行的实例。
export function shouldRetrySingleInstanceLock({ gotLock, marker, now = Date.now(), windowMs = RELAUNCH_MARKER_WINDOW_MS } = {}) {
  if (gotLock) return false;
  const ts = Number(marker);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return now - ts >= -5_000 && now - ts <= windowMs;
}

// desktop-main 注册记录的元数据（供 A 的 bundle 替换脚本按 pid 校验后发 SIGUSR2）：
// command = 应用主可执行文件本身、args 为空（无脚本参数）——与 ELECTRON_RUN_AS_NODE 起的
// monitor-server / supervisor（同一可执行文件 + .mjs 脚本参数）区分开。
//
// signature：execPath 含非 ASCII（安装目录带中文等）时，附带其最长的纯 ASCII 尾段（例如
// "Codex Operations Console.app/Contents/MacOS/Codex Operations Console"）。cmdlineMatches
// 有 signature 时优先按它逐段匹配——即便某处 ps 仍在 C 区域下把中文转义成 "M-..."，
// ASCII 尾段依然命中，desktop-main 记录不会被 60s GC 误删。纯 ASCII 路径不需要签名。
export function desktopMainSignature(execPath) {
  const value = String(execPath || "");
  let lastNonAscii = -1;
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) > 0x7f) lastNonAscii = i;
  if (lastNonAscii < 0) return "";
  const tail = value.slice(lastNonAscii + 1).replace(/^[^/\\]*(?=[/\\])/, "").replace(/^[/\\]+/, "");
  // 太短 / 不含路径分隔（只剩可执行文件名）不足以当强特征，宁可不给（回落 command 匹配）。
  if (tail.length < 12 || !/[/\\]/.test(tail)) return "";
  return tail;
}

export function buildDesktopMainMeta({ execPath, rootDir, parentPid } = {}) {
  const signature = desktopMainSignature(execPath);
  return { command: execPath, args: [], cwd: rootDir, parentPid, ...(signature ? { signature } : {}) };
}

// 退出时只删"自己的"记录：若重启后新实例已写入自己的 pid，旧实例不能把它删掉。
export function isOwnDesktopMainRecord(meta, pid) {
  return Boolean(meta && Number(meta.pid) === Number(pid));
}
