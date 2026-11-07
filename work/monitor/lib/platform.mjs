import nodeFs from "node:fs";
import path from "node:path";

const ARCH_MAP = { x64: "x86_64", arm64: "aarch64" };

export function archLabel(arch = process.arch) {
  return ARCH_MAP[arch] || arch;
}

export function detectGui({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function decideLaunchMode({ platform, hasGui, electronAvailable }) {
  if (platform === "darwin" && hasGui && electronAvailable) return "electron";
  return "web";
}

export function whichCommand(platform = process.platform) {
  return platform === "win32" ? "where" : "which";
}

export function sshMissingHint(platform = process.platform) {
  if (platform === "win32") return "Windows:设置 → 应用 → 可选功能 → 添加功能 → 安装『OpenSSH 客户端』,然后重开终端。";
  return "请安装 OpenSSH 客户端后重试。";
}

// Windows 自带的 OpenSSH 客户端所在目录（%SystemRoot%\System32\OpenSSH）。
export function windowsOpenSshDir(env = process.env) {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows", "System32", "OpenSSH");
}

const SSH_TOOLS = new Set(["ssh", "scp", "sftp", "ssh-keygen", "ssh-keyscan", "ssh-add"]);

// 工作台运行中装好 OpenSSH 客户端（设置里的「可选功能」或安装器 / 页面上的一键安装）后，系统 PATH 里多了
// System32\OpenSSH，但已经在运行的进程拿的还是旧 PATH，找不到 ssh，要重启才行。启动 ssh 系列命令之前调用它：
// 目录里有 ssh.exe、而本进程 PATH 里没有这个目录时补到末尾（不抢在已有的 ssh 前面），之后的子进程都能找到。
// → 这次补了没有。非 Windows、不是 ssh 系列命令、已经在 PATH 里、目录里没有 ssh.exe 都不动。
export function ensureWindowsOpenSshOnPath(command = "ssh", { platform = process.platform, env = process.env, exists = nodeFs.existsSync } = {}) {
  if (platform !== "win32" || !SSH_TOOLS.has(String(command).replace(/\.exe$/i, "").toLowerCase())) return false;
  const dir = windowsOpenSshDir(env);
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") || "Path";
  const parts = String(env[key] || "").split(";").filter(Boolean);
  const norm = (value) => value.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
  if (parts.some((part) => norm(part) === norm(dir))) return false;
  if (!exists(path.win32.join(dir, "ssh.exe"))) return false;
  env[key] = [...parts, dir].join(";");
  return true;
}

export function nodeVersionHint() {
  return "需要 Node.js 22.12 及以上、低于 27（推荐 24，见仓库 .nvmrc）。可用 nvm install && nvm use，或从 https://nodejs.org 安装后重开终端。";
}

export function parseNodeVersion(version) {
  const match = String(version || "").replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// 与 package.json engines.node（>=22.12.0 <27）对齐；不引入 semver 依赖。
// 上界跟着"实测过的最新大版本"走：v2.57 在 26.11 下跑通全量测试后从 <26 放到 <27。
export function isNodeVersionSupported(version, { min = [22, 12, 0], maxMajor = 27 } = {}) {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major >= maxMajor || parsed.major < min[0]) return false;
  if (parsed.major > min[0]) return true;
  if (parsed.minor > min[1]) return true;
  if (parsed.minor < min[1]) return false;
  return parsed.patch >= min[2];
}

// package.json 的 engines.node → isNodeVersionSupported 的第二个参数 { min, maxMajor }；没有上界时 maxMajor
// 是 Infinity。只认本仓库固定的那种写法 ">=22.12.0 <27"（scripts/installer.test.mjs 守着；下界的次版本 / 补丁号、
// 上界可省）。别的写法（^、||、x 通配…）与缺失一律 null——这里不是 semver 解析器，调用方按「读不懂就不拦」处理。
// 自更新用它在动手之前拿目标版本的要求对一遍（lib/self-update/service.mjs）。
export function parseNodeEngineRange(range) {
  if (typeof range !== "string") return null;
  const match = range.trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s+<\s*(\d+)(?:\.0){0,2})?$/);
  if (!match) return null;
  return {
    min: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    maxMajor: match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4]),
  };
}

// { min, maxMajor } → 给人看的说法：「22.12 及以上、低于 27」（补丁号为 0 不写）。
export function nodeRangeText({ min, maxMajor }) {
  const low = min[2] ? min.join(".") : `${min[0]}.${min[1]}`;
  return `${low} 及以上${Number.isFinite(maxMajor) ? `、低于 ${maxMajor}` : ""}`;
}
