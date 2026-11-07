// 磁盘增长归因：远端调用的组装与输出解析。
//
// 量大小复用目录占用的扫描器（remote/dir-usage.py，经 stdin 送达、服务器上不落文件）：把扫描根指到集合目录，
// 它回传的「扫描根下一层目录的累计」正好是每个直接子目录的大小；每轮 ≤ 2 万条目 / 8 秒、可续扫、
// 不跟随符号链接、不跨文件系统、只进 $HOME。这里只把单次 SSH 的时限收紧到 20 秒。
//
// 另有一条只读的常量命令探家目录：作业登记里的路径是绝对路径，要知道 $HOME 才能换成扫描器认的相对路径。
// 命令串不含任何插值；输出当不可信数据解析。
import { buildDirUsageInvocation } from "../dir-usage/scan.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";
import { buildProbeSshArgs } from "../ssh-args.mjs";
import { cleanHomePath } from "./store.mjs";

// 单次 SSH 的上限（远端自限 8 秒，余下是握手与回传）。
export const DISK_GROWTH_SSH_TIMEOUT_MS = 20_000;
const HOME_PROBE_MAX_OUT_BYTES = 8 * 1024;

// env = $HOME 原值；real = 它的物理路径（解析掉符号链接，与扫描器的 realpath 同一个结果）。
export const HOME_PROBE_COMMAND = wrapSh([
  `printf 'env=%s\\n' "$HOME"`,
  `cd "$HOME" 2>/dev/null && printf 'real=%s\\n' "$(pwd -P)"`,
]);

export function buildHomeProbeInvocation({ server = {}, parsed = {}, knownHostsPath, platform = process.platform } = {}) {
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), HOME_PROBE_COMMAND],
    input: "",
    timeoutMs: DISK_GROWTH_SSH_TIMEOUT_MS,
    maxOutputBytes: HOME_PROBE_MAX_OUT_BYTES,
  };
}

// → { home, homeEnv }：home 是物理路径；homeEnv 只在与它不同时给。读不出物理路径 → null。
export function parseHomeProbe(stdout) {
  let env = null;
  let real = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("env=") && env === null) env = cleanHomePath(line.slice(4));
    else if (line.startsWith("real=") && real === null) real = cleanHomePath(line.slice(5));
  }
  if (!real) return null;
  return { home: real, homeEnv: env && env !== real ? env : null };
}

// 一轮扫描：root 是集合目录（相对 $HOME），pending 是上一轮交回的游标（null = 从头）。
export function buildMeasureInvocation({ server, parsed, knownHostsPath, root, pending = null, platform = process.platform }) {
  return { ...buildDirUsageInvocation({ server, parsed, knownHostsPath, root, pending, platform }), timeoutMs: DISK_GROWTH_SSH_TIMEOUT_MS };
}
