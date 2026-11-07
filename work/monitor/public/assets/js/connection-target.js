// connection-target.js —— T01 连接目标解析与代理命令构造（纯逻辑，无 DOM、无 IO）。
//
// 背景（docs/reviews/2026-09-05/implementation/01 §3.1 / §4）：命令面板曾把
// status.remotePort（探针结论对象 { ok, code, output }）直接当端口拼进复制命令，
// 产出 [object Object]。本模块是全项目唯一的连接目标解析 / 命令构造入口：
//   - 端口只接受整数或规范十进制数字字符串（1–65535）；对象、浮点、空串、
//     非数字、NaN、Infinity 一律拒绝，绝不对任意对象做 Number/String 后放行。
//   - 实际本地代理端口只认 supervisor 运行快照（status.connectionTargets）；
//     配置里的 server.localPort 只能作为"配置值"标注，不得覆盖运行事实。
//   - 旧后端（无 connectionTargets）降级为 config-only：远端命令标"配置值"
//     仍可用；本机运行端口无法核实 → 禁用复制并给出 reasonCode。
//   - 远端 tunnel:false 的服务器只能给"配置示例"，不得描述为当前可用连接。

export const CONNECTION_TARGET_SCHEMA_VERSION = 1;

// 端口来源：runtime = supervisor 快照（运行事实）；config = 合并配置（待生效配置）。
export const PORT_SOURCE = Object.freeze({
  RUNTIME: "runtime",
  CONFIG: "config",
  UNKNOWN: "unknown",
});

export const REASON_CODE = Object.freeze({
  OK: "OK",
  OK_CONFIG_ONLY: "OK_CONFIG_ONLY",
  OK_TUNNEL_DISABLED: "OK_TUNNEL_DISABLED",
  ERR_NO_SERVER: "ERR_NO_SERVER",
  ERR_NO_TARGET_SELECTED: "ERR_NO_TARGET_SELECTED",
  ERR_LOCAL_PORT_UNCONFIRMED: "ERR_LOCAL_PORT_UNCONFIRMED",
  ERR_INVALID_REMOTE_PORT: "ERR_INVALID_REMOTE_PORT",
  ERR_CONTEXT_CHANGED: "ERR_CONTEXT_CHANGED",
  ERR_INVALID_INPUT: "ERR_INVALID_INPUT",
});

// ---- 端口校验（A04）----

// 只接受：整数（Number.isInteger）或十进制规范数字字符串（无符号、无空白、无前导 +）。
// "08888" 是规范十进制 → 通过并归一为 8888；浮点 / 对象 / 空串 / NaN / Infinity 拒绝。
export function normalizePortValue(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65535
      ? { ok: true, port: value }
      : { ok: false, reason: "invalid-port" };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return { ok: false, reason: "invalid-port" };
    const port = Number(trimmed);
    return port >= 1 && port <= 65535 ? { ok: true, port } : { ok: false, reason: "out-of-range" };
  }
  // 对象（含探针结论对象）、null、undefined、布尔等一律拒绝——这是 A01 [object Object]
  // 的根因防线：任何对象走到这里都不得被当作端口。
  return { ok: false, reason: "not-a-port" };
}

function portField({ configured, effective, effectiveSource } = {}) {
  const conf = normalizePortValue(configured);
  if (effective !== undefined) {
    const eff = normalizePortValue(effective);
    if (eff.ok) {
      return { value: eff.port, source: effectiveSource || PORT_SOURCE.RUNTIME, configured: conf.ok ? conf.port : null };
    }
  }
  if (conf.ok) {
    return { value: conf.port, source: PORT_SOURCE.CONFIG, configured: conf.port };
  }
  return { value: null, source: PORT_SOURCE.UNKNOWN, configured: null };
}

// ---- connectionTargets 投影读取 ----

function fromConnectionTargets(status, serverId) {
  const projection = status?.connectionTargets;
  if (!projection || projection.schemaVersion !== CONNECTION_TARGET_SCHEMA_VERSION) return null;
  const servers = projection.servers && typeof projection.servers === "object" ? projection.servers : {};
  const entry = Object.hasOwn(servers, serverId) ? servers[serverId] : null;
  if (!entry || typeof entry !== "object") return { missing: true, projection };
  return { entry, projection };
}

function serverFromConfig(config, serverId) {
  const servers = Array.isArray(config?.servers) ? config.servers : [];
  return servers.find((s) => s && s.id === serverId) || null;
}

/**
 * 解析指定服务器的连接目标。serverId 必须由调用方用"当前选择"传入；
 * 异步动作执行前应再次调用并比对 target.serverId（A05 的上下文绑定）。
 * @returns {{ ok: boolean, reasonCode: string, target: object|null, freshness: string, source: string }}
 */
export function resolveConnectionTarget({ status, config, serverId } = {}) {
  if (typeof serverId !== "string" || serverId === "") {
    return { ok: false, reasonCode: REASON_CODE.ERR_NO_TARGET_SELECTED, target: null, freshness: "unknown", source: "none" };
  }
  const viaProjection = fromConnectionTargets(status, serverId);
  const configServer = serverFromConfig(config, serverId);

  if (viaProjection?.entry) {
    const { entry, projection } = viaProjection;
    const remotePort = portField({
      configured: entry.remotePort?.configured,
      effective: entry.remotePort?.effective,
      effectiveSource: PORT_SOURCE.RUNTIME,
    });
    // 本机端口：value 只来自运行快照（effectiveProxyPort）。configured 永远只进
    // configured 字段——它不是"可以用的端口"，只是待生效配置（A02/A03）。
    const localEff = normalizePortValue(projection.effectiveProxyPort?.value);
    const localConf = normalizePortValue(entry.localPort?.configured);
    const localPort = localEff.ok
      ? { value: localEff.port, source: PORT_SOURCE.RUNTIME, configured: localConf.ok ? localConf.port : null }
      : { value: null, source: PORT_SOURCE.UNKNOWN, configured: localConf.ok ? localConf.port : null };
    const tunnelEnabled = entry.tunnelEnabled !== false;
    const remoteOk = remotePort.value != null;
    const localOk = localPort.value != null && localPort.source === PORT_SOURCE.RUNTIME;
    const ok = remoteOk && (tunnelEnabled ? localOk : true);
    // source/reasonCode 跟随投影来源：config-only 投影（旧 supervisor/无有效快照）
    // 与纯 config 回落的语义一致——远端标"配置值"，本机运行端口未确认。
    const configOnly = projection.source !== "supervisor-snapshot";
    return {
      ok,
      reasonCode: !remoteOk
        ? REASON_CODE.ERR_INVALID_REMOTE_PORT
        : tunnelEnabled
          ? (localOk && !configOnly ? REASON_CODE.OK : REASON_CODE.OK_CONFIG_ONLY)
          : REASON_CODE.OK_TUNNEL_DISABLED,
      target: {
        serverId,
        host: typeof entry.host === "string" ? entry.host : "",
        tunnelEnabled,
        remotePort,
        localPort,
        signature: typeof entry.signature === "string" ? entry.signature : "",
      },
      freshness: projection.freshness === "stale" ? "stale" : (projection.freshness || "unknown"),
      source: configOnly ? "config-only" : "supervisor-snapshot",
    };
  }

  // config-only 降级（旧 supervisor / 无快照 / 旧 monitor）。远端配置端口仍可标注
  // "配置值" 出命令；本机运行端口无法核实，调用方按 reasonCode 禁用本地复制（A03）。
  if (!configServer) {
    return { ok: false, reasonCode: REASON_CODE.ERR_NO_SERVER, target: null, freshness: "unknown", source: "none" };
  }
  const remotePort = portField({ configured: configServer.remotePort });
  if (remotePort.value == null) {
    return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_REMOTE_PORT, target: null, freshness: "unknown", source: "none" };
  }
  const localPort = portField({ configured: configServer.localPort });
  const tunnelEnabled = configServer.tunnel !== false;
  return {
    ok: remotePort.value != null,
    reasonCode: tunnelEnabled ? REASON_CODE.OK_CONFIG_ONLY : REASON_CODE.OK_TUNNEL_DISABLED,
    target: {
      serverId,
      host: typeof configServer.host === "string" ? configServer.host : "",
      tunnelEnabled,
      remotePort,
      // 配置值只进 configured 字段；value 置 null 表示"运行端口未确认"，
      // buildProxyEnvCommand 据此拒绝本机命令（不假装 8888 已确认）。
      localPort: { value: null, source: PORT_SOURCE.UNKNOWN, configured: localPort.configured },
      signature: "",
    },
    freshness: "unknown",
    source: "config-only",
  };
}

// 面板打开时记住的选择与执行时不一致 → 拒绝（A05：不复制旧目标）。
export function assertSameContext(resolved, expectedServerId) {
  if (!resolved?.target) return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_INPUT };
  if (resolved.target.serverId !== expectedServerId) {
    return { ok: false, reasonCode: REASON_CODE.ERR_CONTEXT_CHANGED };
  }
  return { ok: true, reasonCode: REASON_CODE.OK };
}

// 异步动作执行时的上下文复核（A05）：按"此刻"正在查看的服务器重新解析，且必须仍是
// 发起时那一台。必须用当前选择去解析——用发起时记下的 serverId 解析永远"一致"，
// 切换了服务器也拦不住。选择规则与界面一致：运行状态优先，状态未到回落配置。
export function resolveCurrentTarget({ status, config, expectedServerId } = {}) {
  const serverId = status?.activeServerId || config?.activeServerId || "";
  const resolved = resolveConnectionTarget({ status, config, serverId });
  const check = assertSameContext(resolved, expectedServerId);
  return check.ok
    ? { ok: true, reasonCode: check.reasonCode, target: resolved.target }
    : { ok: false, reasonCode: check.reasonCode, target: null };
}

// 单隧道重启能力（T04b）：只有 supervisor 运行快照明确声明 scopedTunnelRestart 且
// controlProtocol>=1 才可用；旧 supervisor / config-only 投影一律不可用，也绝不为升级
// 协议而自动重启它。按服务器的条件（该服务器是否建隧道）由调用方另行判断。
export function canScopedRestart(status) {
  const projection = status?.connectionTargets;
  const caps = projection?.capabilities;
  return caps?.scopedTunnelRestart === true
    && Number(caps?.controlProtocol) >= 1
    && projection?.source === "supervisor-snapshot";
}

// ---- 命令构造 ----

// 变量集合行为锁定（设计 §4.2 第 6 条）：ALL_PROXY / HTTP_PROXY / HTTPS_PROXY
// 及小写兼容变量。刻意不设置 NO_PROXY——用户已有的 NO_PROXY 不应被无提示覆盖。
export const PROXY_ENV_VAR_NAMES = Object.freeze([
  "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
]);

// 支持的 shell（M1）：远端固定 POSIX sh；本机 bash / zsh。PowerShell / cmd 未实现，
// 调用方不得为它们渲染可点击入口（LOCAL_SHELLS 不包含它们）。
export const LOCAL_SHELLS = Object.freeze(["bash", "zsh"]);
export const REMOTE_SHELL = "posix-sh";

// 端口经 normalizePortValue 校验后是纯数字，直接拼接、无需引号。
function proxyExportLine(port) {
  return PROXY_ENV_VAR_NAMES.map((name) => `export ${name}=http://127.0.0.1:${port};`).join(" ");
}

/**
 * 构造代理环境变量命令。
 * @param {{ target: object, scope: "remote"|"local", shell?: string }} options
 * @returns {{ ok: boolean, reasonCode: string, command: string, shell: string, sourceLabel: string }}
 */
export function buildProxyEnvCommand({ target, scope, shell } = {}) {
  if (!target || typeof target !== "object") {
    return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_INPUT, command: "", shell: "", sourceLabel: "" };
  }
  if (scope === "remote") {
    const port = target.remotePort?.value;
    const checked = normalizePortValue(port);
    if (!checked.ok) {
      return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_REMOTE_PORT, command: "", shell: REMOTE_SHELL, sourceLabel: "" };
    }
    return {
      ok: true,
      reasonCode: REASON_CODE.OK,
      command: proxyExportLine(checked.port),
      shell: REMOTE_SHELL,
      sourceLabel: portSourceLabel(target.remotePort),
    };
  }
  if (scope === "local") {
    if (!LOCAL_SHELLS.includes(shell)) {
      // 未实现的 shell 不显示入口：调用方按 ok:false 处理。
      return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_INPUT, command: "", shell: String(shell || ""), sourceLabel: "" };
    }
    const port = target.localPort?.value;
    const checked = normalizePortValue(port);
    if (!checked.ok) {
      return { ok: false, reasonCode: REASON_CODE.ERR_LOCAL_PORT_UNCONFIRMED, command: "", shell, sourceLabel: "" };
    }
    if (target.tunnelEnabled === false) {
      return { ok: false, reasonCode: REASON_CODE.OK_TUNNEL_DISABLED, command: "", shell, sourceLabel: "" };
    }
    return {
      ok: true,
      reasonCode: REASON_CODE.OK,
      command: proxyExportLine(checked.port),
      shell,
      sourceLabel: portSourceLabel(target.localPort),
    };
  }
  return { ok: false, reasonCode: REASON_CODE.ERR_INVALID_INPUT, command: "", shell: "", sourceLabel: "" };
}

const SOURCE_LABELS = Object.freeze({
  [PORT_SOURCE.RUNTIME]: "运行值",
  [PORT_SOURCE.CONFIG]: "配置值",
  [PORT_SOURCE.UNKNOWN]: "未确认",
});

export function portSourceLabel(field) {
  if (!field || typeof field !== "object") return SOURCE_LABELS[PORT_SOURCE.UNKNOWN];
  return SOURCE_LABELS[field.source] || SOURCE_LABELS[PORT_SOURCE.UNKNOWN];
}

// 预览行（设计 §4.2 第 8 条）："服务器名 · 远端/本机 · 端口 · 数据来源"。
export function formatConnectionTargetLine({ target, scope, serverName } = {}) {
  if (!target) return "";
  const name = serverName || target.serverId;
  if (scope === "remote") {
    return `${name} · 远端 :${target.remotePort?.value ?? "?"} · ${portSourceLabel(target.remotePort)}`;
  }
  return `${name} · 本机 :${target.localPort?.value ?? "?"} · ${portSourceLabel(target.localPort)}`;
}
