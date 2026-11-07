// 服务直达（v2.62）的转发参数：ssh 参数、要避开的本机端口、命令行特征、登记名（纯函数，零 IO）。
// 管理器（起进程、等就绪、收回）在 forwards.mjs；分工同 supervisor 的 tunnel-spec.mjs 与 tunnel-controller.mjs。
//
// 这条 ssh 与现役隧道（supervisor 的 ssh -R）没有任何关系：
//   - 不复用连接：-S none + ControlMaster=no，探针参数里的 ControlMaster / ControlPath / ControlPersist 先剥掉。
//     复用的话 -L 会挂在常驻的 master 上，结束这条 ssh 之后本机端口还被 master 占着。
//   - 只有一条 -L 127.0.0.1:<本机端口>:<回环>:<远端端口>：本机固定绑 127.0.0.1（另加 GatewayPorts=no），
//     远端目标只在两个回环常量里选；没有 -R、-D，没有远端命令（-N）。
//   - 本机端口避开 8877、8888、1455 与配置里出现过的所有端口。这不只是不抢端口：进程探针按
//     「127.0.0.1:<反向端口>:127.0.0.1:<代理端口>」认隧道，本机端口不等于任何已配置的端口，-L 的转发串就
//     不可能被认成某条 -R 隧道。
import { assertSafeHost } from "../ssh-args.mjs";
import { assertSafeServerId, isPort } from "../validators.mjs";

export const FORWARD_RECORD_PREFIX = "service-forward.";
export const MIN_FORWARD_PORT = 1024;
// 转发的远端目标只在这两个回环地址里选（由服务列表里监听地址的归类决定，见 services.mjs 的 classifyBind）；
// 请求里的字符串、远端报上来的地址都到不了 ssh 的参数。
export const FORWARD_REMOTE_HOSTS = Object.freeze(["127.0.0.1", "[::1]"]);

// 心跳 20s × 3：约一分钟收不到服务器回应就判定连接已死、ssh 自己退出（这条转发随之从列表里消失）。
const ALIVE_INTERVAL_S = 20;
const ALIVE_COUNT_MAX = 3;
// 任何情况下都不用的本机端口：控制面默认端口、本机代理默认端口、Codex 登录回调端口。
const ALWAYS_RESERVED_PORTS = Object.freeze([8877, 8888, 1455]);

// 配置里出现过的所有端口 ∪ 固定保留的端口 ∪ extra。宁可多排除：名字里带 port 的字段（含其下的整棵子树，
// 如 portOverrides）、任何字符串里「:数字」形态的端口（上游代理地址、白名单条目）都算。
export function collectReservedPorts(config, extra = []) {
  const reserved = new Set(ALWAYS_RESERVED_PORTS);
  for (const value of extra) if (isPort(Number(value))) reserved.add(Number(value));
  const seen = new Set();
  const visit = (value, portish, depth) => {
    if (value == null || depth > 8) return;
    if (typeof value === "number") {
      if (portish && isPort(value)) reserved.add(value);
      return;
    }
    if (typeof value === "string") {
      if (portish && /^\d{1,5}$/.test(value) && isPort(Number(value))) reserved.add(Number(value));
      for (const match of value.matchAll(/:(\d{2,5})(?!\d)/g)) if (isPort(Number(match[1]))) reserved.add(Number(match[1]));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, portish, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, portish || /port/i.test(key), depth + 1);
  };
  visit(config, false, 0);
  return reserved;
}

// 探针的钉扎参数（known_hosts / 端口 / 身份 / 主机，主机在最后一位）→ 转发用的公共选项 + 主机。
// 复用参数剥掉；我们自己的选项排在前面（ssh 对同名选项取第一个，压过钉扎参数与用户的 ssh 配置）。
const CONTROL_OPTION = /^Control(?:Master|Path|Persist)=/i;
export function buildForwardBase(pinnedArgs, expectedHost) {
  const list = Array.isArray(pinnedArgs) ? pinnedArgs : [];
  const host = assertSafeHost(list.at(-1));
  if (expectedHost !== undefined && host !== expectedHost) throw new Error("SSH 参数里没有这台服务器的主机");
  const kept = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i] === "-o" && CONTROL_OPTION.test(String(list[i + 1] ?? ""))) {
      i += 1;
      continue;
    }
    kept.push(list[i]);
  }
  return {
    host,
    options: [
      "-S", "none",
      "-o", "ControlMaster=no",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "GatewayPorts=no",
      "-o", `ServerAliveInterval=${ALIVE_INTERVAL_S}`,
      "-o", `ServerAliveCountMax=${ALIVE_COUNT_MAX}`,
      "-o", "TCPKeepAlive=yes",
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=VERBOSE",
      ...kept,
    ],
  };
}

// -L 的转发串：本机固定绑 127.0.0.1，远端目标只能是两个回环常量之一，端口都得是合法整数。
export function forwardSpec({ localPort, remotePort, remoteHost = "127.0.0.1" } = {}) {
  if (!isPort(localPort) || !isPort(remotePort)) throw new Error("转发端口不合法");
  if (!FORWARD_REMOTE_HOSTS.includes(remoteHost)) throw new Error("转发目标只能是集群本机的回环地址");
  return `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`;
}

export function buildForwardSshArgs(base, target) {
  return ["-N", ...base.options, "-L", forwardSpec(target), base.host];
}

// 进程注册表里的命令行特征（cmdlineMatches 要求每一段都出现在进程的命令行里）。
export function forwardSignature(base, target) {
  return `-N ExitOnForwardFailure=yes -L ${forwardSpec(target)} ${base.host}`;
}

export function forwardRecordName(serverId, remotePort) {
  if (!isPort(remotePort)) throw new Error("转发端口不合法");
  return `${FORWARD_RECORD_PREFIX}${assertSafeServerId(serverId)}.${remotePort}`;
}

// 登记名的形状（运行目录里按文件名找上次留下的转发时用）。
const RECORD_NAME_RE = /^service-forward\.[\w.-]+\.\d{1,5}$/;
export function isForwardRecordName(name) {
  return typeof name === "string" && RECORD_NAME_RE.test(name);
}

// `ssh -G` 的输出里这台主机生效的端口转发（用户 ssh 配置写的）；没有返回空数组。
const AMBIENT_LABELS = Object.freeze({ localforward: "LocalForward", remoteforward: "RemoteForward", dynamicforward: "DynamicForward" });
export function findAmbientForwards(configDump) {
  const found = [];
  for (const line of String(configDump ?? "").split(/\r?\n/)) {
    const match = /^\s*(localforward|remoteforward|dynamicforward)\s+(\S.*)$/i.exec(line);
    if (match) found.push(`${AMBIENT_LABELS[match[1].toLowerCase()]} ${match[2].trim().slice(0, 80)}`);
  }
  return found;
}
