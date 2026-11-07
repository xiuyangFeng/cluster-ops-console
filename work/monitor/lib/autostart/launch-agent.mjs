// macOS 源码安装的开机自启：用户级 LaunchAgent 的内容生成与识别（纯函数，不读写文件、不调用 launchctl）。
//
// 登录时 launchd 执行仓库的 start.sh，带 AUTOSTART_FLAG。几处取舍：
//   - 走 /bin/bash start.sh 而不是写死某个 node：start.sh 里有「系统 Node 不合适就用安装器放的私有 Node」
//     的选择逻辑（私有 Node 按 $HOME 找，launchd 会给登录用户的 HOME），nvm 换了版本、旧目录没了的时候还能起来。
//   - launchd 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin：找不到 Homebrew / nvm 的 node，git 会落到
//     /usr/bin/git（没装命令行工具时它只会弹安装框）。所以把启动器那一刻的 PATH 写进去，顺序原样保留——
//     调换顺序会让 ssh / git 换成另一份（Homebrew 的 ssh 不认 ~/.ssh/config 里 macOS 专有的 UseKeychain）。
//   - 不写 SSH_AUTH_SOCK：launchd 自己会给登录会话的那一个，写死的路径重启后就失效。
//   - RunAtLoad + KeepAlive.SuccessfulExit=false：登录时起一次，异常退出（非零 / 被信号杀掉）才重拉，
//     正常退出（已经有一份在跑、用户自己退出）不拉。ThrottleInterval 是两次拉起的最小间隔。
//   - ProcessType=Interactive：这个任务里跑的是桌面窗口或本机代理（集群上 Agent 的请求都经过它），
//     不写的话 launchd 按后台任务对 CPU 与磁盘读写限速。
//   - 输出丢弃：日志走运行时目录下的结构化日志——启动器的启动失败与「停止自动拉起」在 logs/launcher.ndjson
//     （scripts/launch.mjs），桌面壳自己的故障在 logs/desktop.ndjson（electron-main.mjs），页面脚本错误在 logs/renderer.ndjson。
import path from "node:path";

import { AUTOSTART_FLAG, AUTOSTART_MARKER } from "./launch-flag.mjs";

export const LAUNCH_AGENT_LABEL = "com.clusterworkbench.launcher";
export const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`;
export const LAUNCH_AGENT_THROTTLE_SECONDS = 60;
// PATH 里总要有的系统目录（ssh、bash 用到的基础命令都在这里）：原 PATH 里没有的补在最后。
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const DEFAULT_PATH_MAX_CHARS = 8192;

// 能原样写进 plist 的文本：没有控制字符（含换行、制表符）、没有 XML 不收的码位。
export function isPlistText(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要挡掉控制字符
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && !/[\u0000-\u001f\u007f\ufffe\uffff]/.test(value);
}

// 能写进 LaunchAgent 的安装目录：绝对路径且是普通文本。
export function isLaunchAgentRoot(repoRoot) {
  return isPlistText(repoRoot) && repoRoot.startsWith("/");
}

export function launchAgentPath(homeDir) {
  return path.join(homeDir, "Library", "LaunchAgents", LAUNCH_AGENT_FILE);
}

// 写进 plist 的 PATH：原样的顺序，去掉空的、相对的、带控制字符的条目，去重；缺的系统目录补在最后。
// 超长时从后往前丢（丢的是补系统目录之前的尾部条目），系统目录始终都在。
export function buildLaunchPath({ pathEnv = "", maxChars = DEFAULT_PATH_MAX_CHARS } = {}) {
  const kept = [];
  for (const raw of String(pathEnv ?? "").split(":")) {
    if (!isPlistText(raw) || !raw.startsWith("/")) continue;
    const dir = raw.length > 1 ? raw.replace(/\/+$/, "") || "/" : raw;
    if (!kept.includes(dir)) kept.push(dir);
  }
  const join = (dirs) => [...dirs, ...SYSTEM_PATH.filter((dir) => !dirs.includes(dir))].join(":");
  while (kept.length && join(kept).length > maxChars) kept.pop();
  return join(kept);
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (text) => text
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");

export function launchAgentProgram(repoRoot) {
  return ["/bin/bash", path.posix.join(repoRoot, "start.sh"), AUTOSTART_FLAG];
}

// repoRoot：安装目录（start.sh 所在）；pathEnv：buildLaunchPath 的结果。输入不合格直接抛错——
// 调用方（service.mjs）先用 isLaunchAgentRoot 判过，这里不生成半截文件。
export function buildLaunchAgentPlist({ repoRoot, pathEnv }) {
  if (!isLaunchAgentRoot(repoRoot)) throw new TypeError("安装目录不能写进 LaunchAgent");
  if (!isPlistText(pathEnv)) throw new TypeError("PATH 不能写进 LaunchAgent");
  const string = (value) => `<string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${AUTOSTART_MARKER}。由「集群运维工作台」的「配置 → 启动」生成：登录后执行安装目录里的 start.sh。关掉那个开关即删除本文件；手动改动会在下次打开开关时被覆盖。 -->`,
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t${string(LAUNCH_AGENT_LABEL)}`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...launchAgentProgram(repoRoot).map((arg) => `\t\t${string(arg)}`),
    "\t</array>",
    "\t<key>WorkingDirectory</key>",
    `\t${string(repoRoot)}`,
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>PATH</key>",
    `\t\t${string(pathEnv)}`,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>ThrottleInterval</key>",
    `\t<integer>${LAUNCH_AGENT_THROTTLE_SECONDS}</integer>`,
    "\t<key>ProcessType</key>",
    `\t${string("Interactive")}`,
    "\t<key>StandardOutPath</key>",
    `\t${string("/dev/null")}`,
    "\t<key>StandardErrorPath</key>",
    `\t${string("/dev/null")}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

// 读回一份 plist（只认 XML 文本）：是不是工作台放的、登录时执行的是什么。
// 不是通用 plist 解析器——只取 ProgramArguments 里的字符串，够用来判断「指向的是不是这个安装目录」。
// 被别的工具转成二进制、或去掉了注释的文件认不出标记，按「不是我们放的」处理：不改、不删。
export function parseLaunchAgentPlist(text) {
  const source = typeof text === "string" ? text : "";
  const args = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const program = args ? [...args[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1])) : [];
  return { managed: source.includes(AUTOSTART_MARKER), program };
}
