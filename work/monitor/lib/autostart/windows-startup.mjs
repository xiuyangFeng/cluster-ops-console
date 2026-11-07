// Windows 的开机自启：「启动」文件夹里的一个 .cmd 的内容生成与识别（纯函数，任何系统上都能测）。
//
// 只写一个文件，不用计划任务、不用注册表。文件做的事只有一行：
//   start "" /d "<安装目录>" /min cmd /c .\start-console.cmd --autostart
// 即把新窗口的当前目录设成安装目录，最小化地在里面执行 start-console.cmd（它把参数原样传给 launch.mjs）。
// 这一轮没法在 Windows 上实测，所以尽量少、尽量不依赖编码与引号规则：
//   - 安装目录只出现在 /d 后面：它由执行这个脚本的 cmd 解析一次，交给 start 当作新窗口的当前目录。
//     不写成 start "" /min "<目录>\start-console.cmd" …——批处理要再经一个 cmd.exe /K 解析一遍，那一遍只在
//     「恰好两个引号、中间有空白、没有 &<>()@^|」时才保留引号：路径里既有空格又有括号（cluster-workbench (1)、
//     Program Files (x86)）或带 & ^ 时，新窗口里只会报「不是内部或外部命令」，登录后什么都没起来。
//     现在新窗口要解析的只剩 cmd /c .\start-console.cmd --autostart 这几个不带安装路径、不带引号的词
//     （写 .\ 是为了不依赖「在当前目录里找命令」这个可以被关掉的默认行为）。
//   - 安装目录在用户目录下（安装器的默认位置）时写成 %USERPROFILE%\…：中文用户名由 cmd 在运行时展开，
//     文件本身是纯 ASCII，不受系统代码页影响。
//   - 其余位置路径里有非 ASCII 字符时，先 chcp 65001 再执行（cmd 逐行读脚本，切换后的行按 UTF-8 解码；
//     start-console.cmd 与安装器用的是同一个办法）。标记行在 chcp 之前，所以只用 ASCII。
//   - 目录放在双引号里：& ^ ( ) 都按字面；% 写成 %%；双引号与控制字符写不进去，直接判不支持。
//   - 只认带盘符的本机路径：cmd 不能把网络路径（\\服务器\共享）当作当前目录，start-console.cmd 自己也进不去。
import path from "node:path";

import { AUTOSTART_FLAG, AUTOSTART_MARKER } from "./launch-flag.mjs";

export const STARTUP_FILE_NAME = "cluster-workbench-autostart.cmd";
const STARTUP_SCRIPT = "start-console.cmd";

// 当前用户的「启动」文件夹（默认位置；被组策略重定向到别处的不处理）。读不到 APPDATA 时为 null。
export function windowsStartupDir(env = {}) {
  const appData = typeof env.APPDATA === "string" ? env.APPDATA.trim() : "";
  return appData ? path.win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null;
}

export function startupTarget(repoRoot) {
  return path.win32.join(repoRoot, STARTUP_SCRIPT);
}

// 能写进 .cmd 的安装目录：带盘符的本机绝对路径（不是盘符根目录、不是网络路径），没有双引号与控制字符。
export function isStartupRoot(repoRoot) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要挡掉控制字符
  return typeof repoRoot === "string" && path.win32.isAbsolute(repoRoot) && /^[A-Za-z]:[\\/]+[^\\/]/.test(repoRoot) && !/["\u0000-\u001f\u007f]/.test(repoRoot);
}

const USERPROFILE_REF = "%USERPROFILE%";
// 用户目录归一成不带末尾分隔符的形式；没有或不是字符串时为空串。
const homeOf = (userProfile) => (typeof userProfile === "string" && userProfile.trim() ? path.win32.normalize(userProfile.trim()).replace(/[\\/]+$/, "") : "");

// 写进脚本的安装目录：在用户目录下时换成 %USERPROFILE% 开头（比较不分大小写）；% 一律加倍。
function scriptDir(repoRoot, userProfile) {
  const dir = path.win32.normalize(repoRoot).replace(/[\\/]+$/, "");
  const home = homeOf(userProfile);
  if (home && (dir.toLowerCase() === home.toLowerCase() || dir.toLowerCase().startsWith(`${home.toLowerCase()}\\`))) {
    return `${USERPROFILE_REF}${dir.slice(home.length).replaceAll("%", "%%")}`;
  }
  return dir.replaceAll("%", "%%");
}

export function buildStartupCmd({ repoRoot, userProfile = "" }) {
  if (!isStartupRoot(repoRoot)) throw new TypeError("安装目录不能写进启动脚本");
  const dir = scriptDir(repoRoot, userProfile);
  // 可打印 ASCII 之外的字符才需要切代码页。
  const needsUtf8 = /[^ -~]/.test(dir);
  return [
    "@echo off",
    `rem ${AUTOSTART_MARKER}. Written by Cluster Workbench (Settings - Startup): starts the workbench minimized after sign-in.`,
    "rem Turn that switch off to delete this file; manual edits are overwritten the next time the switch is turned on.",
    ...(needsUtf8 ? ["chcp 65001 >nul"] : []),
    `start "" /d "${dir}" /min cmd /c .\\${STARTUP_SCRIPT} ${AUTOSTART_FLAG}`,
    "",
  ].join("\r\n");
}

// 读回一份启动脚本：是不是工作台放的、启动的是哪个安装目录里的 start-console.cmd
// （读的是 /d 后面的目录；%USERPROFILE% 与 %% 还原成实际路径）。认不出启动行时 target 为 null。
export function parseStartupCmd(text, { userProfile = "" } = {}) {
  const source = typeof text === "string" ? text : "";
  const line = source.match(/^start "" \/d "([^"\r\n]*)" \/min cmd \/c \.\\start-console\.cmd(?=[ \r\n]|$)/m);
  let target = null;
  if (line) {
    const home = homeOf(userProfile);
    const raw = line[1];
    const underHome = raw.startsWith(USERPROFILE_REF) && Boolean(home);
    const rest = (underHome ? raw.slice(USERPROFILE_REF.length) : raw).replaceAll("%%", "%");
    target = path.win32.join(underHome ? `${home}${rest}` : rest, STARTUP_SCRIPT);
  }
  return { managed: source.includes(AUTOSTART_MARKER), target };
}

// 两个 Windows 路径是不是同一个文件（不分大小写、分隔符归一）。
export function sameWindowsPath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
