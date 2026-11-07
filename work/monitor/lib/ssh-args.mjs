import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { buildHostKeyArgs, resolveKnownHostsIfPresent } from "./host-key-policy.mjs";
import { knownHostsRevision as readKnownHostsRevision } from "./stat-cache.mjs";
import { toPort } from "./validators.mjs";

// 探针 SSH 与 supervisor 探测共用的身份 / ControlMaster 片段。
// 反向隧道本身禁止加 ControlMaster（路径空格 + ControlPersist 会把 -R 孤儿化），
// 见 channel-supervisor.buildTunnelArgs。ControlPath 固定家目录，不要落到 runtimeDir。

export const SSH_CONTROL_ARGS = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.ssh/control-%r@%h:%p",
  "-o", "ControlPersist=5m",
];

// 显式关闭复用：一次独立握手。
export const SSH_NO_MUX_ARGS = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

// macOS sun_path 上限 104 字节（含结尾 NUL）；ssh 建 master 时先 bind 到
// "<ControlPath>.<16 位随机>" 临时名再 rename，所以要给后缀留 17 字节。超长时
// unix_listener 失败会让 ssh 直接 exit 255（不是"降级为不复用"），必须在这里预判。
const UNIX_SOCKET_PATH_MAX = 103;
const MUX_TEMP_SUFFIX_LEN = 17;
const PERCENT_C_LEN = 40; // %C = SHA1(%l%h%p%r) 的 40 位 hex

// 绑定主机密钥钉扎的探针复用参数（仅 probe/exec 命令用，绝不用于常驻隧道进程——
// 隧道加 ControlMaster 曾是 P0：ControlPersist 把 -R 后台化成 supervisor 追踪不到的
// master，且路径含空格时 exit 255，见 channel-supervisor.buildTunnelArgs）。
//
// 为什么以前一见钉扎就 ControlMaster=no：共享 master 只在首次连接时校验主机密钥，
// 之后复用它的调用不再校验——若 socket 早于钉扎（或按旧钉扎）建立，新钉扎就被绕过。
// 现在把 socket 名绑定到（known_hosts 内容修订号 + 路径 + 身份 + 端口 + host）的短哈希：
// 钉扎内容一变 → 换一个全新 socket → 首次连接必然按新钉扎校验；未钉扎调用走另一条
// control-%r@%h:%p 路径，两者永不共用。%C 再把 ssh_config 解析后的真实端点并入路径。
//   - win32：OpenSSH 无 unix socket 复用，整组剔除；
//   - 取不到修订号（文件消失/不可读）、家目录含空白或路径可能超长：保守回落不复用。
export function buildProbeControlArgs({
  platform = process.platform,
  knownHostsPath,
  knownHostsRevision,
  identity = {},
  homeDir,
} = {}) {
  if (platform === "win32") return [];
  if (!knownHostsPath) return SSH_CONTROL_ARGS;
  const revision = knownHostsRevision || readKnownHostsRevision(knownHostsPath);
  if (!revision) return SSH_NO_MUX_ARGS;
  let home = homeDir;
  if (home === undefined) {
    try { home = homedir(); } catch { home = ""; }
  }
  const tag = createHash("sha256").update(JSON.stringify([
    String(revision), String(knownHostsPath), identity.sshIdentityFile || "", identity.sshUser || "",
    identity.sshPort || "", identity.host || "",
  ])).digest("hex").slice(0, 8);
  const suffix = `/.ssh/cm-${tag}-`;
  // sun_path 上限按**字节**算：非 ASCII 家目录（如中文用户名）按 UTF-8 编码后远长于 JS 字符串 length。
  if (!home || /\s/.test(home) || Buffer.byteLength(home, "utf8") + Buffer.byteLength(suffix, "utf8") + PERCENT_C_LEN + MUX_TEMP_SUFFIX_LEN > UNIX_SOCKET_PATH_MAX) {
    return SSH_NO_MUX_ARGS;
  }
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=~/.ssh/cm-${tag}-%C`,
    "-o", "ControlPersist=5m",
  ];
}

// ---------------------------------------------------------------------------
// 纵深防御硬校验：配置正常应先经 monitor-core.normalizeAgentConfig 收口（非法值
// 回落默认），但 port/host 最终会被插进远端 shell 命令串或做 ssh 位置参数——
// 即使未来又出现绕过归一化的调用方，这里也直接 throw，绝不让可注入值出门。
// ---------------------------------------------------------------------------
// host 放行合法 ssh 目标：别名、域名、user@host、IPv6 冒号/方括号形式；
// 拒绝空白/引号/分号/$(){}/反引号等 shell 元字符，以及以 "-" 开头的选项注入形态。
const SAFE_HOST_RE = /^[\w.@:[\]-]+$/;
const SAFE_SSH_USER_RE = /^[\w.-]+$/;

export function assertSafePort(value, label = "port") {
  const port = toPort(value);
  if (port === null) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}，必须是 1-65535 的整数（配置应先经 normalizeAgentConfig 收口）`);
  }
  return port;
}

export function assertSafeHost(value, label = "host") {
  if (typeof value !== "string" || !value || value.startsWith("-") || !SAFE_HOST_RE.test(value)) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}，只允许 [\\w.@:\\[\\]-] 字符且不得以 "-" 开头（防 ssh 选项/shell 注入）`);
  }
  return value;
}

export function assertSafeSshUser(value) {
  if (typeof value !== "string" || !value || value.startsWith("-") || !SAFE_SSH_USER_RE.test(value)) {
    throw new Error(`unsafe sshUser: ${JSON.stringify(value)}，只允许 [\\w.-] 字符且不得以 "-" 开头`);
  }
  return value;
}

// 合法即返回归一化后的 sshUser，否则 null（"静默丢弃"，见下）。
function safeSshUserOrNull(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s && !s.startsWith("-") && SAFE_SSH_USER_RE.test(s) ? s : null;
}

// server 是某台服务器的条目，parsed 是分层合并后的整份配置（个人层 sshUser / sshIdentityFile 在顶层）。
//
// v2.18 多隧道：条目自带的身份优先于全局个人字段。个人层新增的服务器（腾讯云/阿里云）
// 很可能在另一个集群、另一个用户名、另一把钥匙上——若继续无条件用顶层 sshUser 覆盖，
// 给这些机器建隧道会拿集群账号去登陆，必然认证失败。条目没写（或写坏）时才回落全局。
export function attachPersonalSsh(server = {}, parsed = {}) {
  const out = { ...server };

  // sshIdentityFile 作为 -i 的独立参数传递，无注入面，只做 trim 与非空判定。
  const ownIdentity = typeof server.sshIdentityFile === "string" ? server.sshIdentityFile.trim() : "";
  const globalIdentity = typeof parsed.sshIdentityFile === "string" ? parsed.sshIdentityFile.trim() : "";
  if (ownIdentity) out.sshIdentityFile = ownIdentity;
  else if (globalIdentity) out.sshIdentityFile = globalIdentity;

  // 个人层字段保持"静默丢弃"语义（本机自己的配置写错不该让 supervisor 崩），
  // 但收紧到与 assertSafeSshUser 同一规则：以 "-" 开头的值一并丢弃。
  const ownUser = safeSshUserOrNull(server.sshUser);
  const globalUser = safeSshUserOrNull(parsed.sshUser);
  if (ownUser) out.sshUser = ownUser;
  else if (globalUser) out.sshUser = globalUser;
  else if (server.sshUser !== undefined) delete out.sshUser; // 条目自带的非法值不能顺着 ...server 流到 -l

  // sshPort 只认条目自己的值，不从全局回落：端口是这台机器的连接参数。
  if (server.sshPort !== undefined && server.sshPort !== null && server.sshPort !== "") {
    try {
      out.sshPort = assertSafePort(server.sshPort, "sshPort");
    } catch {
      delete out.sshPort;
    }
  } else {
    delete out.sshPort;
  }

  return out;
}

export function buildSshPortArgs(sshPort) {
  if (sshPort === undefined || sshPort === null || sshPort === "") return [];
  return ["-p", String(assertSafePort(sshPort, "sshPort"))];
}

export function buildSshIdentityArgs(config = {}) {
  const args = [];
  if (config.sshIdentityFile) {
    // sshIdentityFile 作为 -i 的独立参数传递（非选项位、不进 shell 串），
    // 无选项注入面，允许任意路径（可含空格）。
    args.push("-i", config.sshIdentityFile, "-o", "IdentitiesOnly=yes");
  }
  if (config.sshUser) {
    args.push("-l", assertSafeSshUser(config.sshUser));
  }
  return args;
}

// server 是活跃服务器条目，parsed 是分层合并后的整份配置（个人层 sshUser / sshIdentityFile 在顶层）。
// platform 可注入（默认 process.platform）：Windows OpenSSH 没有 Unix domain socket，
// ControlMaster/ControlPath/ControlPersist 这套连接复用不可用，带上去有让每次探测直接
// 报错的风险（设计 §6.4 列为待真机实测项）。win32 上整组剔除，退化为"每次独立连接"
// ——慢一点但确定能跑通；其它平台行为一字不变。
export function buildProbeSshArgs(server = {}, parsed = {}, { platform = process.platform, knownHostsPath, homeDir } = {}) {
  const identity = attachPersonalSsh(server, parsed);
  // host 做 ssh 位置参数：缺失时保持旧行为（filter 掉，让 ssh 自己报错），
  // 但存在即必须通过硬校验——"-oProxyCommand=..." 形态的选项注入在这里被拒。
  if (identity.host !== undefined && identity.host !== "") assertSafeHost(identity.host);
  // A shared ControlMaster can skip host-key verification after its first
  // connection. Pinned calls therefore use a socket bound to the pin revision
  // and identity (see buildProbeControlArgs): a changed pin can never reuse a
  // master verified against another key. Unpinned calls keep the normal mux.
  const controlArgs = buildProbeControlArgs({ platform, knownHostsPath, identity, homeDir });
  return [
    ...controlArgs,
    ...buildHostKeyArgs({ knownHostsPath }),
    ...buildSshPortArgs(identity.sshPort),
    ...buildSshIdentityArgs(identity),
    identity.host,
  ].filter((part) => part !== undefined && part !== "");
}

// 按服务器钉扎的探针参数：dataDir 下有该服务器已确认的 known_hosts（host-key-store 写入）
// 时带 UserKnownHostsFile，并据其内容修订号绑定独立 ControlPath；没有就是未钉扎的常规形态。
// 探针与 bootstrap 向导共用这一处，不再各自拼 resolveKnownHostsIfPresent。
export function buildPinnedProbeSshArgs(server = {}, config = {}, { dataDir, platform = process.platform } = {}) {
  return buildProbeSshArgs(server, config, {
    platform,
    knownHostsPath: resolveKnownHostsIfPresent(dataDir, server?.id),
  });
}

// 返回值自带一层括号，调用方不得再包一层：远端登录 shell 为 bash 时
// `((...))` 会被解析成算术表达式而非嵌套子 shell，直接语法报错、探测恒失败。
// remotePort 会被拼进远端 shell 命令串，必须先过 assertSafePort（注入即 throw）。
export function buildRemotePortProbeCommand(remotePort) {
  const port = assertSafePort(remotePort, "remotePort");
  return `(ss -lnt | grep -q :${port} || nc -z 127.0.0.1 ${port} || lsof -i:${port} -sTCP:LISTEN)`;
}

export function classifySshFailure(text) {
  const s = String(text || "");
  if (/Permission denied|publickey|Authentication failed/i.test(s)) {
    return { code: "auth", nextAction: "检查 ssh 用户名与密钥，或重跑 npm run setup" };
  }
  if (/Could not resolve hostname|Name or service not known/i.test(s)) {
    return { code: "dns", nextAction: "检查 ~/.ssh/config 的 Host 别名或集群地址" };
  }
  if (/Connection refused/i.test(s)) {
    return { code: "refused", nextAction: "确认集群 sshd 可达，以及当前网络是否在 SSH 白名单内" };
  }
  if (/Connection timed out|Operation timed out/i.test(s)) {
    return { code: "timeout", nextAction: "网络不通或未在白名单网段，可暂停通道避免空打" };
  }
  if (/Remote forwarding|bind: Address already in use|forwarding request failed/i.test(s)) {
    return { code: "remote-port", nextAction: "远端反向端口被占用，重跑 npm run setup 重新分配端口" };
  }
  if (/Too many authentication|MaxStartups/i.test(s)) {
    return { code: "rate-limit", nextAction: "SSH 尝试过多，等待退避结束；确认只用一把专用密钥" };
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|please contact your system administrator/i.test(s)) {
    return { code: "hostkey", nextAction: "主机密钥变化或尚未确认，请人工核对指纹后更新 known_hosts，不要自动重连" };
  }
  return null;
}
