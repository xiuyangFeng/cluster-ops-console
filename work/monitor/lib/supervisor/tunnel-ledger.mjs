// 断线账本写入端（supervisor 进程内）：隧道会话的建立 / 结束、supervisor 启动与存活心跳，
// 逐行追加到 runtime/tunnel-ledger.ndjson。monitor 侧只读它算稳定性（lib/tunnel-ledger-stats.mjs）。
//
// 为什么不复用 supervisor.ndjson：那份日志 2MB 轮转，阿里云这类每天断十几次的隧道加上快照心跳，
// 一两天就被冲掉；账本每行几十字节，同样的预算能留几周，"改完到底稳没稳"才有得比。
// 写失败一律吞掉：簿记绝不允许影响保活主循环。
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export const TUNNEL_LEDGER_FILENAME = "tunnel-ledger.ndjson";
export const TUNNEL_LEDGER_SCHEMA = 1;
// 超过上限就把当前文件改名为 .1（只留一代）：两份合计约 1MB，按每天几百行约够一个月。
export const TUNNEL_LEDGER_MAX_BYTES = 512 * 1024;
// 存活心跳间隔：读侧据此区分"supervisor 一直在看着"与"没在运行 / Mac 在睡眠"（后者不计入可用率）。
export const TUNNEL_LEDGER_ALIVE_MS = 5 * 60 * 1000;

// 休眠归因（v2.62）在账本里多出两样，旧行都没有、读侧按「没有」处理：
//   - down 行的 sleep：这次断线是电脑休眠造成的（在挂钟跳变期间、或醒来后短时间内被发现）；
//   - wake 行：隧道控制器发现了一次挂钟跳变，at = 醒来后第一次 ensure 的时刻，sleptMs = 跳变长度
//     （at - sleptMs 即睡前最后一次 ensure）。每个控制器各记一行、都不带 serverId——休眠是整台电脑的事，
//     读侧把它们并起来用。
// 旧版读侧按「start / alive / 本服务器的事件」筛选，看不到 wake 行；sleep 字段它直接忽略。
// v2.88 handover 行：同账号多台 Mac 的承载切换。role = standby（本机转为待命，另一台 Mac 在承载）/
// active（本机从另一台 Mac 手里接过来）；reason = holder-active / holder-unresponsive / yielded / manual / unresponsive；
// peer = 对方的机器名。旧版读侧不认这一类型，直接跳过。
const EVENT_TYPES = new Set(["up", "down", "start", "alive", "wake", "handover"]);
const STRING_FIELDS = { serverId: 64, host: 255, via: 32, cause: 32, detail: 200, signal: 16, role: 16, reason: 32, peer: 64 };
const NUMBER_FIELDS = ["pid", "downMs", "uptimeMs", "attempts", "code", "sleptMs"];
const BOOLEAN_FIELDS = ["planned", "networkChange", "sleep"];

// 只落白名单字段，长度封顶：账本会被 HTTP 读出去，不让任意对象原样穿透。
export function sanitizeLedgerEvent(event, nowMs = Date.now()) {
  if (!event || !EVENT_TYPES.has(event.type)) return null;
  const out = { v: TUNNEL_LEDGER_SCHEMA, type: event.type, at: Number.isFinite(event.at) ? Math.trunc(event.at) : nowMs };
  for (const [field, max] of Object.entries(STRING_FIELDS)) {
    if (typeof event[field] === "string" && event[field]) out[field] = event[field].slice(0, max);
  }
  for (const field of NUMBER_FIELDS) {
    if (Number.isFinite(event[field])) out[field] = Math.trunc(event[field]);
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof event[field] === "boolean") out[field] = event[field];
  }
  return out;
}

export function createTunnelLedgerWriter({ runtimeDir, maxBytes = TUNNEL_LEDGER_MAX_BYTES, now = Date.now } = {}) {
  const filePath = path.join(runtimeDir, TUNNEL_LEDGER_FILENAME);
  // 串行写：同一拍里多条隧道同时上报时保持行完整、顺序与发生顺序一致。
  let chain = Promise.resolve();

  async function writeLine(line) {
    try {
      const info = await stat(filePath).catch(() => null);
      if (info && info.size + line.length > maxBytes) await rename(filePath, `${filePath}.1`).catch(() => {});
      await mkdir(runtimeDir, { recursive: true });
      await appendFile(filePath, line, { mode: 0o600 });
    } catch {
      // 忽略
    }
  }

  function append(event) {
    const clean = sanitizeLedgerEvent(event, now());
    if (!clean) return chain;
    const line = `${JSON.stringify(clean)}\n`;
    chain = chain.then(() => writeLine(line));
    return chain;
  }

  return { filePath, append, flush: () => chain };
}
