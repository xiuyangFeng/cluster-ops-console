// scripts/setup/host-keys.mjs —— 首次连接的主机密钥确认：ssh-keyscan 扫描 → 打印指纹让用户人工确认 →
// 追加进 ~/.ssh/known_hosts。生产默认 StrictHostKeyChecking=yes，不再 accept-new。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { appendKnownHosts } from "../../work/monitor/lib/known-hosts-file.mjs";
import { confirmYes } from "../lib/prompt.mjs";
import { sshDir } from "./ssh-config.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logInfo, logSuccess, logWarning } from "./ui.mjs";

export { appendKnownHosts };

export function scanHostKeyLines(hostName, port, { spawnImpl = spawnSync } = {}) {
  const scan = spawnImpl("ssh-keyscan", ["-T", "5", "-p", String(port || 22), hostName], { encoding: "utf8" });
  return String(scan.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export async function confirmAndPinHostKey(hostName, port, { ask = askQuestion, dryRun = DRY_RUN } = {}) {
  if (dryRun) {
    dryRunLog(`ssh-keyscan -T 5 -p ${port || 22} ${hostName} && confirm fingerprint`);
    return true;
  }
  const lines = scanHostKeyLines(hostName, port);
  if (!lines.length) {
    logError(`未能扫描 ${hostName} 的主机密钥，已拒绝自动接受。请人工核对指纹后写入 ~/.ssh/known_hosts。`);
    return false;
  }
  const printed = spawnSync("ssh-keygen", ["-lf", "-"], { encoding: "utf8", input: `${lines.join("\n")}\n` });
  logInfo("首次连接需要确认主机密钥（生产默认不再 accept-new）：");
  console.log(String(printed.stdout || lines.join("\n")).trim());
  if (!(await confirmYes("确认以上指纹并写入 ~/.ssh/known_hosts？(y/N): ", ask))) {
    logWarning("未确认主机密钥，已中止自动写入。");
    return false;
  }
  try {
    appendKnownHosts(path.join(sshDir, "known_hosts"), lines);
  } catch (error) {
    // 读不出（权限 / 是个目录）时一个字节都没写，原有内容不受影响；写到一半失败的极少见情况同样如实报。
    logError(`没能把主机密钥写进 ~/.ssh/known_hosts：${error.message}`);
    logWarning("请检查这个文件的权限（应当属于你自己、可读写；也可以是指向别处的软链接），修好后重新运行 npm run setup。");
    return false;
  }
  logSuccess("已写入主机密钥，后续 SSH 使用 StrictHostKeyChecking=yes。");
  return true;
}
