// scripts/setup/ssh-probe.mjs —— 向导发起的 SSH 调用：免密连通性探测、失败归因、远端命令执行。
// 三者共用同一套免密假设（BatchMode=yes 需要密码时立即失败而不是挂起、StrictHostKeyChecking=yes、
// 带建连超时），所以放在一处。
import { spawnSync } from "node:child_process";
import { classifySshFailure } from "../../work/monitor/lib/ssh-args.mjs";
import { logError, logInfo } from "./ui.mjs";

// 检查某个 SSH Host 的免密连通性，并保留 stderr 供失败归因（describeSshTestFailure）。
// ConnectTimeout=3 限制建连超时，外层 timeout 兜住"连上了但远端卡住"的情况。
export function probeSshConnection(hostAlias) {
  const result = runSsh(hostAlias, "echo ok", { timeoutMs: 15000, connectTimeoutSec: 3 });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    ok: result.status === 0,
    stderr: String(result.stderr || result.error?.message || ""),
    timedOut,
  };
}

// 纯函数：把一次免密测试失败翻译成"最可能的原因 + 其他常见原因 + 下一步"。
// 归因复用 ssh-args.mjs 的 classifySshFailure（与控制台注意力队列同一套判定），这里只负责措辞。
const SSH_FAILURE_CAUSES = {
  network: "当前网络不在集群 SSH 白名单内——白名单外 SSH 被拒绝或超时属预期，不是故障",
  password: "刚才输入的 SSH 密码或用户名不对，公钥因此没能部署上去",
  pubkey: "公钥还没加入服务器的 ~/.ssh/authorized_keys（自动部署失败或被跳过）",
};

export function describeSshTestFailure({ stderr = "", timedOut = false } = {}) {
  const classified = timedOut ? { code: "timeout" } : classifySshFailure(stderr);
  const code = classified?.code ?? "unknown";
  let primary;
  if (code === "refused" || code === "timeout") primary = [SSH_FAILURE_CAUSES.network];
  else if (code === "auth") primary = [SSH_FAILURE_CAUSES.pubkey, SSH_FAILURE_CAUSES.password];
  else if (code === "dns") primary = ["SSH 别名解析失败：~/.ssh/config 里的 Host 段或服务器地址有误"];
  else if (code === "hostkey") primary = ["服务器主机密钥未确认或发生了变化：请人工核对指纹后更新 ~/.ssh/known_hosts"];
  else if (code === "rate-limit") primary = ["SSH 尝试次数过多被服务器限流：稍等几分钟再试"];
  else primary = [];
  const others = Object.values(SSH_FAILURE_CAUSES).filter((c) => !primary.includes(c));
  const detail = String(stderr || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  return {
    code,
    primary,
    others,
    detail,
    nextAction: classified?.nextAction || "换到白名单网络、确认用户名与密码后重跑 npm run setup",
  };
}

export function reportSshTestFailure(hostAlias, probe) {
  const info = describeSshTestFailure(probe);
  logError(`免密测试失败：暂时无法以免密方式登录 "${hostAlias}"。`);
  if (info.primary.length > 0) {
    console.log("  最可能的原因：");
    for (const c of info.primary) console.log(`    - ${c}`);
  }
  console.log(info.primary.length > 0 ? "  其他常见原因：" : "  常见原因：");
  for (const c of info.others) console.log(`    - ${c}`);
  if (info.detail) console.log(`  ssh 输出：${info.detail}`);
  logInfo(`下一步：${info.nextAction}`);
  return info;
}

// 统一封装本向导对服务器的 SSH 调用（含上面的连通性探测）：BatchMode=yes 需要密码时立即失败
// 而不是挂起等输入、StrictHostKeyChecking=yes、带连接超时、可选 stdin、可选整体超时。
export function runSsh(hostAlias, remoteCommand, { input, timeoutMs = 8000, connectTimeoutSec = 6 } = {}) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSec}`,
    "-o", "StrictHostKeyChecking=yes",
    hostAlias,
    remoteCommand,
  ];
  const opts = { encoding: "utf8", timeout: timeoutMs };
  if (input !== undefined) opts.input = input;
  return spawnSync("ssh", args, opts);
}
