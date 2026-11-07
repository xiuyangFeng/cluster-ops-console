// 反向端口分配的纯函数（setup 向导与控制台共用一把尺子）。
// 原先只在 scripts/setup-wizard.mjs 里；控制台"添加服务器建议端口 / 端口被占重新分配"
// 也要同一套规则，故下沉到 lib，向导那边改为从这里 re-export（导出名与行为逐字不变）。
import { toPort } from "./validators.mjs";

export const REVERSE_PORT_BASE = 7891; // 团队生产端口，本身绝不可被个人分配到
export const REVERSE_PORT_SPAN = 1000;
// 约定：本地转发端口 = 远端端口 + 1000（向导 assignReversePort 同一约定）。
export const LOCAL_PORT_OFFSET = 1000;

// 纯函数：从 inUse ∪ reserved 的并集之外，取 (base, base+span] 区间内最小的可用端口。
// 只用"活性探测"（谁在监听）来判定空闲会在对方离线时把同一端口分给两个人（离线者一上线，
// 流量就会经由错误的 Mac 出网，含凭证握手）——所以这里必须吃一个"已分配"集合（服务器侧注册表 ∪
// 团队配置里的 remotePort），取并集之外的最小端口，而不是单纯探测端口存活。
export function pickReversePort({ inUse = [], reserved = [], base = REVERSE_PORT_BASE, span = REVERSE_PORT_SPAN } = {}) {
  const taken = new Set([...(inUse || []), ...(reserved || [])]);
  for (let p = base + 1; p <= base + span; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error(`No available reverse port in range (${base + 1}-${base + span})`);
}

// 控制台建议端口的活性探测范围：与 pickReversePort 的候选区间 (BASE, BASE+SPAN] 对齐（外加 BASE 本身），
// 否则 8000-8891 段里正在监听的端口探得到却不进保留集，建议值照样可能撞上。
// 向导的 parseListeningPorts 默认值（7800-7999）保持原样，不改其导出行为。
export const REVERSE_PORT_LISTEN_RANGE = Object.freeze({ min: REVERSE_PORT_BASE, max: REVERSE_PORT_BASE + REVERSE_PORT_SPAN });

// 远端监听端口探测命令（控制台建议端口与 setup 向导共用）。`ss` 缺失时输出为空、退出码 0。
export const REMOTE_LISTEN_SURVEY_COMMAND = "command -v ss >/dev/null 2>&1 && ss -ltn || true";

// 纯函数：从 `ss -ltn` 输出里挑出反向隧道段（默认 7800-7999，即设计里的 78xx/79xx）的监听端口。
// 活性探测只做"补充保留集"用途，绝不单独用来判空闲——对方离线时端口看着空闲，分出去就是碰撞。
export function parseListeningPorts(text, { min = 7800, max = 7999 } = {}) {
  const ports = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    for (const m of line.matchAll(/:(\d{2,5})\b/g)) {
      const port = Number.parseInt(m[1], 10);
      if (port >= min && port <= max) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// 纯函数：只凭本机已知配置（合并后的 servers）给一个建议反向端口。
// 保留集 = 所有服务器（含禁用、含团队条目）已写的 remotePort ∪ 团队基准端口 ∪ extraInUse
// （远端 ss -ltn 探得的监听端口等）；localPort 同样避开已配置的本地端口。
// excludeServerId：为某台服务器"重新分配"时，它自己的旧端口不算占用者——但旧端口正是
// 出问题的那个（被别人占着），所以仍通过 avoid 显式排除。
export function suggestReversePort(merged = {}, { excludeServerId = null, extraInUse = [], avoid = [] } = {}) {
  const servers = Array.isArray(merged?.servers) ? merged.servers : [];
  const remoteTaken = new Set([REVERSE_PORT_BASE]);
  const localTaken = new Set();
  for (const server of servers) {
    if (!server) continue;
    if (excludeServerId && server.id === excludeServerId) continue;
    const r = toPort(server.remotePort);
    const l = toPort(server.localPort);
    if (r) remoteTaken.add(r);
    if (l) localTaken.add(l);
  }
  for (const p of [...(extraInUse || []), ...(avoid || [])]) {
    const n = toPort(p);
    if (n) remoteTaken.add(n);
  }
  // localPort 也必须空闲：跳过"远端空闲但本地转发端口撞车"的候选。
  const blocked = new Set(remoteTaken);
  for (let p = REVERSE_PORT_BASE + 1; p <= REVERSE_PORT_BASE + REVERSE_PORT_SPAN; p++) {
    if (localTaken.has(p + LOCAL_PORT_OFFSET)) blocked.add(p);
  }
  const remotePort = pickReversePort({ inUse: [...blocked] });
  return { remotePort, localPort: remotePort + LOCAL_PORT_OFFSET };
}
