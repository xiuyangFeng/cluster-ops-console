import * as nodeFs from "node:fs";
import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { isPlausibleHost, parseAllowlistEntry, parseHttpProxyUrl } from "./proxy/address.mjs";
import { REVERSE_PORT_BASE } from "./reverse-port.mjs";
import { assertSafeHost, assertSafePort, assertSafeSshUser, attachPersonalSsh } from "./ssh-args.mjs";
import { isAuthRef, isBoundedServerId, isSafeServerId, toPort } from "./validators.mjs";

export class ConfigValidationError extends Error {
  constructor(message, errors = [], status = 400) {
    super(message);
    this.name = "ConfigValidationError";
    this.errors = errors;
    this.status = status;
    this.code = status === 409 ? "revision-conflict" : "schema";
  }
}

// 个人层 config.local.json 允许读取的字段白名单。v2.18 起除了原有的身份/选择/端口覆盖，
// 还允许用户声明自己的服务器（servers）、自动修复开关（autoRepair）
// 与本地数据预算（storageBudgetBytes）——这些是"用户机器上的事实"，不该逼团队层 config.json 收录。
// v2.54 加入 egress（本机代理的出网方式）：每台电脑的网络环境不同，同样只属于个人层。
// storageAdmin：管理员存储视图要连的机器（root）与专用密钥路径（lib/storage-admin/config.mjs）。只属于管理员自己的电脑，
// 不放团队层：root 目标与非登录节点的公网地址不该随同事包分发。
export const PERSONAL_FIELDS = [
  "sshUser", "sshIdentityFile", "activeServerId", "activeAgentId", "portOverrides",
  "servers", "autoRepair", "storageBudgetBytes", "egress", "storageAdmin",
];

// 控制台（config-hot-reload 的 /api/config/active）唯一可以改写的两个原子字段。
export const ACTIVE_SELECTION_FIELDS = ["activeServerId", "activeAgentId"];

// writeActiveSelection 的落盘白名单：控制台选择字段 + 向导（setup-wizard）写入的个人身份与端口分配。
// 刻意不等于 PERSONAL_FIELDS —— servers / autoRepair / storageBudgetBytes 是"只读入、不写出"的
// 手编（或未来向导专用步骤）字段；若跟着 PERSONAL_FIELDS 走，控制台一次切换服务器就会把整份
// 合并后的 servers（含团队条目与 source/disabled 打标）复制进个人层，从此团队层再也改不动用户的配置。
const WRITABLE_PERSONAL_FIELDS = [...ACTIVE_SELECTION_FIELDS, "sshUser", "sshIdentityFile", "portOverrides"];

// 个人层同 id 覆盖团队服务器时允许出现的字段。host / sshHostName / sshPort 不在其中：
// 团队条目指向哪台机器由团队层说了算，否则个人层能把公共服务器悄悄改指到别处（凭证仍会送过去）。
const PERSONAL_OVERRIDE_FIELDS = new Set(["id", "disabled", "remotePort", "localPort", "tunnel"]);

// 个人层新增服务器只允许这些字段落盘/进运行快照。validationProfile / password
// 等其余键一律丢弃，避免个人配置变成可执行的远程命令或明文口令。
const PERSONAL_SERVER_FIELDS = new Set([
  "id", "name", "host", "address", "sshPort", "sshUser", "sshIdentityFile",
  "remotePort", "localPort", "disabled", "tunnel", "tags", "createdAt",
  "updatedAt", "schemaVersion", "authRef", "monitorEnabled",
  "description",
]);

const FORBIDDEN_PERSONAL_SERVER_FIELDS = new Set([
  "validationProfile", "password", "sshPassword", "sshpass", "identityData", "privateKey",
]);

// 服务器 id 会派生注册表记录名与 pid 文件名（monitor-core.tunnelRecordName），
// 与那边同一把尺子（validators.mjs）：只放行 [\w.-]，挡路径穿越，也保证 Windows 文件名合法。
// 团队层加载走 1–64 的有界口径，其余（个人层条目 / 隧道目标 / 回收站）沿用不限长口径。

export const PERSONAL_CONFIG_SCHEMA_VERSION = 1;

// 空数组按"没写"处理（个人层留了 "servers": [] 不该把团队层清空）；对象与数字一律放行，
// 否则 autoRepair 这类结构化字段与 storageBudgetBytes: 0 会被当成空值丢掉。
const hasValue = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

// 个人层/团队层文件"不存在"是正常场景（新机器/首次安装），要与"文件存在但解析失败"（损坏/半写）区分对待。
// 注入的 fake fs 在测试里常用 `throw new Error("ENOENT")`（无 .code），因此除了标准 err.code 外也兜底匹配错误信息。
function isNotFoundError(err) {
  return !!err && (err.code === "ENOENT" || /ENOENT/.test(String(err.message || err)));
}

function readPersonalObject(localConfigPath, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(localConfigPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch (err) {
    if (isNotFoundError(err)) return {};
    throw new ConfigValidationError("个人配置无法读取，请修复后重试，原文件未改动", [{ field: "config", message: "配置必须是有效 JSON 对象" }]);
  }
}

export function mergeConfig(team, local, { warn = console.warn } = {}) {
  const merged = { ...(team || {}) };
  const l = local || {};
  for (const f of PERSONAL_FIELDS) {
    // servers 是唯一按条目合并的字段（同 id 覆盖 / 新增 / 屏蔽），整体覆盖会让个人层
    // 一写自己的服务器就把团队条目全部抹掉；下面 mergePersonalServers 单独处理。
    if (f === "servers") continue;
    if (hasValue(l[f])) merged[f] = l[f];
  }
  // proxyAllowedTargets（CONNECT 代理非 443 白名单）与 PERSONAL_FIELDS 的覆盖语义不同：
  // 个人层是在团队层基础上"追加"自己的 API 站，而不是整体替换——否则同事写个人白名单
  // 会悄悄丢掉团队公共条目（如 close-api），拿到一个看似生效实则残缺的策略。
  // 个人层类型写错时忽略个人层（保团队层），条目级校验在 proxy 侧 parseProxyAllowedTargets 做。
  if (Array.isArray(team?.proxyAllowedTargets) || Array.isArray(l.proxyAllowedTargets)) {
    merged.proxyAllowedTargets = [
      ...(Array.isArray(team?.proxyAllowedTargets) ? team.proxyAllowedTargets : []),
      ...(Array.isArray(l.proxyAllowedTargets) ? l.proxyAllowedTargets : []),
    ];
  }
  if (merged.portOverrides && typeof merged.portOverrides === "object" && Array.isArray(merged.servers)) {
    const serverIds = new Set(merged.servers.map((s) => s.id));
    for (const id of Object.keys(merged.portOverrides)) {
      if (!serverIds.has(id)) {
        warn(`[config-loader] portOverrides 中的 serverId "${id}" 未匹配任何团队层 servers，已忽略`);
      }
    }
    merged.servers = merged.servers.map((s) => {
      const o = merged.portOverrides[s.id];
      if (!o) return s;
      return {
        ...s,
        ...("remotePort" in o ? { remotePort: o.remotePort } : {}),
        ...("localPort" in o ? { localPort: o.localPort } : {}),
      };
    });
  }
  // 两层都没有 servers 时不要凭空写入 `servers: undefined`（会让下游的 `"servers" in config` 判定翻转）。
  const servers = mergePersonalServers(merged.servers, l.servers, warn);
  if (servers !== undefined) merged.servers = servers;
  return merged;
}

// 团队条目 + 个人条目 → 归一化后的 servers 数组。
// 只有个人层真的写了 servers 时才重建数组并打标（source/disabled/tunnel），
// 没写时保持团队数组原样透传：v2.17 之前的配置在合并结果里逐字不变，下游与
// /api/status 的旧字段零回归。缺打标的条目由 listEnabledServers / resolveTunnelTargets
// 兜底解释（无 disabled 即启用、无 tunnel 即建隧道、无 source 即团队条目）。
function mergePersonalServers(teamServers, localServers, warn) {
  if (localServers !== undefined && !Array.isArray(localServers)) {
    warn(`[config-loader] 个人层 servers 必须是数组（实际 ${typeof localServers}），已整体忽略，只用团队层服务器`);
    return teamServers;
  }
  if (!Array.isArray(localServers) || localServers.length === 0) return teamServers;

  const byId = new Map();
  for (const s of Array.isArray(teamServers) ? teamServers : []) {
    if (!s || typeof s !== "object") continue;
    // 没有 id 的团队条目用对象自身做键：保序原样保留（不丢数据），但个人层也无从覆盖它。
    const key = typeof s.id === "string" && s.id ? s.id : s;
    byId.set(key, { ...s, source: "team", disabled: s.disabled === true, tunnel: s.tunnel !== false });
  }
  for (const raw of localServers) {
    if (!raw || typeof raw !== "object") {
      warn("[config-loader] 个人层 servers 含非对象条目，已丢弃");
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (byId.has(id)) byId.set(id, overrideTeamServer(byId.get(id), raw, warn));
    else {
      const entry = buildPersonalServer(id, raw, warn);
      if (entry) byId.set(id, entry);
    }
  }
  return Array.from(byId.values());
}

// 同 id：只吃 PERSONAL_OVERRIDE_FIELDS，其余字段丢弃并把字段名报给用户
// （静默丢弃会让"我明明改了 host 却没生效"变成一次无从下手的排查）。
function overrideTeamServer(base, raw, warn) {
  const dropped = Object.keys(raw).filter((k) => !PERSONAL_OVERRIDE_FIELDS.has(k));
  if (dropped.length) {
    warn(`[config-loader] 个人层 servers "${base.id}" 不允许覆盖团队条目的 ${dropped.join(" / ")}，已丢弃这些字段（团队服务器的地址由团队层 config.json 决定；如需自己的机器请用新的 id）`);
  }
  const patch = {};
  if ("disabled" in raw) patch.disabled = raw.disabled === true;
  if ("tunnel" in raw) patch.tunnel = raw.tunnel !== false;
  for (const field of ["remotePort", "localPort"]) {
    if (!(field in raw)) continue;
    try {
      patch[field] = assertSafePort(raw[field], `servers["${base.id}"].${field}`);
    } catch (err) {
      warn(`[config-loader] 个人层 servers "${base.id}" 的 ${field} 非法，已保留团队层取值：${err.message}`);
    }
  }
  return { ...base, ...patch };
}

function personalHostValue(raw = {}) {
  if (hasValue(raw.address)) return raw.address;
  if (hasValue(raw.host)) return raw.host;
  return "";
}

function pickPersonalServerFields(raw = {}) {
  const out = {};
  for (const key of PERSONAL_SERVER_FIELDS) {
    if (Object.hasOwn(raw, key) && key !== "validationProfile") {
      out[key] = raw[key];
    }
  }
  return out;
}

// 新 id：id / host|address / remotePort 必填，host 与端口过 ssh-args 的硬校验（与探针、隧道同一把尺子）。
// 校验失败整条丢弃而不是抛异常——个人层写错不该让整个控制台起不来。
// 旧配置的 host 继续兼容；address 是同一地址的新名字。
function buildPersonalServer(id, raw, warn) {
  const missing = [];
  if (!id) missing.push("id");
  if (!hasValue(personalHostValue(raw))) missing.push("host");
  const tunnel = raw.tunnel !== false && raw.tunnelEnabled !== false;
  if (tunnel && !hasValue(raw.remotePort)) missing.push("remotePort");
  if (missing.length) {
    warn(`[config-loader] 个人层 servers 条目 "${id || raw.host || raw.address || "(无 id)"}" 缺少必填字段 ${missing.join(" / ")}，已整条丢弃`);
    return null;
  }
  if (!isSafeServerId(id)) {
    warn(`[config-loader] 个人层 servers 条目 id ${JSON.stringify(id)} 含非法字符（只允许字母/数字/下划线/点/连字符），已整条丢弃`);
    return null;
  }
  const droppedForbidden = Object.keys(raw).filter((key) => FORBIDDEN_PERSONAL_SERVER_FIELDS.has(key));
  if (droppedForbidden.length) {
    warn(`[config-loader] 个人层 servers 条目 "${id}" 不允许携带 ${droppedForbidden.join(" / ")}，已丢弃这些字段`);
  }
  let host;
  let remotePort;
  let localPort;
  let sshPort;
  let sshUser;
  try {
    host = assertSafeHost(personalHostValue(raw), `servers["${id}"].host`);
    if (hasValue(raw.remotePort)) remotePort = assertSafePort(raw.remotePort, `servers["${id}"].remotePort`);
    if (raw.localPort !== undefined && raw.localPort !== null && raw.localPort !== "") {
      localPort = assertSafePort(raw.localPort, `servers["${id}"].localPort`);
    }
    if (raw.sshPort !== undefined && raw.sshPort !== null && raw.sshPort !== "") {
      sshPort = assertSafePort(raw.sshPort, `servers["${id}"].sshPort`);
    }
  } catch (err) {
    warn(`[config-loader] 个人层 servers 条目 "${id}" 校验失败，已整条丢弃：${err.message}`);
    return null;
  }
  if (hasValue(raw.sshUser)) {
    try {
      sshUser = assertSafeSshUser(String(raw.sshUser).trim());
    } catch (err) {
      warn(`[config-loader] 个人层 servers 条目 "${id}" 的 sshUser 非法，已丢弃该字段：${err.message}`);
    }
  }
  if (!sshUser) {
    warn(`[config-loader] 个人层 servers 条目 "${id}" 未声明独立 sshUser，加载期回落全局身份；新增或改写时请填写本机用户名，避免把集群账号误用于个人机器`);
  }
  const clean = pickPersonalServerFields(raw);
  delete clean.validationProfile;
  delete clean.password;
  delete clean.sshPassword;
  delete clean.monitorEnabled;
  return {
    ...clean,
    id,
    name: hasValue(raw.name) ? raw.name : host,
    host,
    address: host,
    ...(remotePort === undefined ? {} : { remotePort }),
    ...(localPort === undefined ? {} : { localPort }),
    ...(sshPort === undefined ? {} : { sshPort }),
    ...(sshUser ? { sshUser } : {}),
    source: "personal",
    disabled: raw.disabled === true || raw.monitorEnabled === false,
    tunnel: raw.tunnel !== false && raw.tunnelEnabled !== false,
    schemaVersion: PERSONAL_CONFIG_SCHEMA_VERSION,
  };
}

// ---- 本机出网（egress）与个人代理白名单（v2.54）----
// egress = { mode: "direct" | "system" | "manual", url? }：
//   direct  本机代理直接拨号（默认；本机能直连外网或代理软件开了 TUN 时用）
//   system  经系统设置里的 HTTP 代理（代理软件只开"系统代理"时用；代理进程自己识别）
//   manual  经手填的上游 http://host:port（代理软件的 HTTP / 混合端口）
// 读取口径（代理进程用）宽松：写错就按直连并给出 issue，不抛——配置烂不能拖垮出网；
// 写入口径（设置页 / JSON 编辑器）严格：不合法整体拒绝，原文件不动。
export const EGRESS_MODES = Object.freeze(["direct", "system", "manual"]);
// 个人层白名单条数上限：白名单是给少数中转站开的口子，不是通配放行。
export const PERSONAL_ALLOWLIST_MAX = 32;

// 合并配置里的 egress → { mode, url, upstream, issue }。upstream 只在 manual 时给出
// （{ host, port, url }）；system 的上游由代理进程运行时识别。
export function resolveEgressSetting(raw) {
  const direct = (issue = null) => ({ mode: "direct", url: null, upstream: null, issue });
  if (raw === undefined || raw === null) return direct();
  if (typeof raw !== "object" || Array.isArray(raw)) return direct("egress 应为对象");
  const mode = raw.mode ?? "direct";
  if (!EGRESS_MODES.includes(mode)) return direct(`egress.mode ${JSON.stringify(mode)} 不是 direct / system / manual`);
  const upstream = parseHttpProxyUrl(raw.url);
  if (mode === "manual") {
    if (!upstream) return direct(`egress.url ${JSON.stringify(raw.url ?? "")} 不是 http://主机:端口`);
    return { mode, url: upstream.url, upstream, issue: null };
  }
  return { mode, url: upstream?.url ?? null, upstream: null, issue: null };
}

// 写入校验：返回归一化后的 { mode, url? }，不合法抛 ConfigValidationError（逐字段原因）。
// 非 manual 时也保留合法的 url，方便切回「手动」时不必重填。
export function normalizeEgressForWrite(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("出网设置未通过校验", [{ field: "egress", message: "egress 必须是对象，如 { \"mode\": \"system\" }" }]);
  }
  const mode = raw.mode ?? "direct";
  if (!EGRESS_MODES.includes(mode)) {
    throw new ConfigValidationError("出网设置未通过校验", [{ field: "egress.mode", message: "出网方式只能是 direct / system / manual" }]);
  }
  const hasUrl = raw.url !== undefined && raw.url !== null && raw.url !== "";
  const upstream = hasUrl ? parseHttpProxyUrl(raw.url) : null;
  if ((mode === "manual" && !upstream) || (hasUrl && !upstream)) {
    throw new ConfigValidationError("出网设置未通过校验", [{ field: "egress.url", message: "手动地址必须是 http://主机:端口（不支持 https、socks、路径或账号密码）" }]);
  }
  return upstream ? { mode, url: upstream.url } : { mode };
}

// 个人层 proxyAllowedTargets 写入校验：每条必须是显式非 443 端口的 host:port、主机名形态正常、
// 非私网；归一化（host 小写）后去重，最多 PERSONAL_ALLOWLIST_MAX 条。
// 返回 { ok, value, errors }（与 validatePersonalServersForWrite 同形）。
export function validateAllowlistForWrite(entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, value: null, errors: [{ field: "proxyAllowedTargets", message: "proxyAllowedTargets 必须是 \"host:port\" 字符串数组" }] };
  }
  const errors = [];
  const value = [];
  for (const [index, raw] of entries.entries()) {
    const field = `proxyAllowedTargets[${index}]`;
    const parsed = parseAllowlistEntry(raw);
    if (parsed.error === "private") {
      errors.push({ field, message: "内网 / 本机地址不能加入白名单（本机代理一律拒绝私网目标）" });
    } else if (parsed.error || !isPlausibleHost(parsed.host)) {
      errors.push({ field, message: "格式应为 主机名:端口，端口必须写出（1-65535）" });
    } else if (parsed.port === 443) {
      errors.push({ field, message: "443 端口默认放行，不需要加白名单" });
    } else if (!value.includes(parsed.entry)) {
      value.push(parsed.entry);
    }
  }
  if (value.length > PERSONAL_ALLOWLIST_MAX) {
    errors.push({ field: "proxyAllowedTargets", message: `个人白名单最多 ${PERSONAL_ALLOWLIST_MAX} 条` });
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

// 空串 / null / undefined 视为"没填"（端口类可选字段的写入口径）。
const isBlank = (v) => v === undefined || v === null || v === "";

// ---- 团队基准端口（7891）写入守卫（v2.54 终审）----
// 7891 是 kai 的生产反向端口（REVERSE_PORT_BASE）。v2.54 起团队层不再带 remotePort，
// "不与团队 remotePort 撞"的旧校验随之空转——个人层手填 7891 会把自己的隧道绑到 kai 的端口上，
// 先连上的一方独占、后连的一方一直失败，更糟的是 kai 离线时别人的集群流量会从 kai 的 Mac 出网。
// 规则：个人层任何写入（同 id 覆盖 / 个人服务器 / portOverrides）把 remotePort 写成 7891 一律拒绝，
// 除非该条目在个人层里原本就是 7891（kai 本人：沿用不受影响）。
export const BASE_PORT_WRITE_MESSAGE = `${REVERSE_PORT_BASE} 是团队最早的生产端口（已有人在用），不能写进个人配置；请改用配置向导领取或「重新分配端口」`;

// 个人层里 serverId 原本的反向端口（servers 条目与 portOverrides 两处，任一处为准；读不到给空数组）。
export function previousPersonalRemotePorts(personal, serverId) {
  const out = [];
  const servers = Array.isArray(personal?.servers) ? personal.servers : [];
  for (const s of servers) {
    if (s && s.id === serverId) out.push(toPort(s.remotePort));
  }
  const overrides = personal?.portOverrides;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) out.push(toPort(overrides[serverId]?.remotePort));
  return out.filter((p) => p !== null);
}

// 纯函数：本次写入的 remotePort 是否撞上团队基准端口且没有"原本就是它"的豁免。
export function isBlockedBasePortWrite(port, previousPorts = []) {
  return toPort(port) === REVERSE_PORT_BASE && !(previousPorts || []).includes(REVERSE_PORT_BASE);
}

// portOverrides 写入校验（设置页 JSON 编辑器等直接提交整块 portOverrides 时）：端口须合法，
// 且不得新写 7891。与个人层原值逐字相同的条目跳过——控制台每次保存都会把整块 portOverrides
// 原样带回来，手写的旧条目不该因为这条新校验让所有保存都失败。
// 返回 { ok, value, errors }（与 validatePersonalServersForWrite 同形）。
export function validatePortOverridesForWrite(overrides, { previous = {} } = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return { ok: false, value: null, errors: [{ field: "portOverrides", message: "portOverrides 必须是 { serverId: { remotePort, localPort } } 对象" }] };
  }
  const errors = [];
  const before = previous?.portOverrides && typeof previous.portOverrides === "object" ? previous.portOverrides : {};
  for (const [id, entry] of Object.entries(overrides)) {
    const prefix = `portOverrides.${id}`;
    if (JSON.stringify(entry) === JSON.stringify(before[id])) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ field: prefix, message: "端口覆盖必须是对象" });
      continue;
    }
    for (const field of ["remotePort", "localPort"]) {
      if (!(field in entry) || isBlank(entry[field])) continue;
      try {
        assertSafePort(entry[field], `${prefix}.${field}`);
      } catch (err) {
        errors.push({ field: `${prefix}.${field}`, message: err.message });
      }
    }
    if (isBlockedBasePortWrite(entry.remotePort, previousPersonalRemotePorts(previous, id))) {
      errors.push({ field: `${prefix}.remotePort`, message: BASE_PORT_WRITE_MESSAGE });
    }
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? overrides : null, errors };
}

// 同 id 覆盖团队服务器：只收屏蔽 / 隧道开关与端口覆盖（monitorEnabled / tunnelEnabled 是
// 设置页的新名字，折算成 disabled / tunnel）；其余字段一律报错。
// previousPorts：该 id 在个人层原本的反向端口（7891 豁免判定用）。
function teamOverrideForWrite(raw, id, prefix, errors, previousPorts = []) {
  const patch = { id };
  for (const key of Object.keys(raw)) {
    if (!PERSONAL_OVERRIDE_FIELDS.has(key) && !["monitorEnabled", "tunnelEnabled"].includes(key)) errors.push({ field: `${prefix}.${key}`, message: "团队服务器不允许覆盖该字段" });
  }
  if ("disabled" in raw || "monitorEnabled" in raw) patch.disabled = raw.disabled === true || raw.monitorEnabled === false;
  if ("tunnel" in raw || "tunnelEnabled" in raw) patch.tunnel = raw.tunnel !== false && raw.tunnelEnabled !== false;
  for (const field of ["remotePort", "localPort"]) {
    if (!(field in raw) || isBlank(raw[field])) continue;
    try {
      patch[field] = assertSafePort(raw[field], `${prefix}.${field}`);
    } catch (err) {
      errors.push({ field: `${prefix}.${field}`, message: err.message });
    }
  }
  if (isBlockedBasePortWrite(patch.remotePort, previousPorts)) errors.push({ field: `${prefix}.remotePort`, message: BASE_PORT_WRITE_MESSAGE });
  return patch;
}

// 旧条目未声明 sshUser 且身份四要素（地址 / 端口 / 钥匙）都没改：放行（兼容存量配置），
// 否则新增或改写个人服务器必须填独立用户名，避免把集群账号误用于个人机器。
function hasUnchangedLegacyIdentity(previousServers, id, host, raw) {
  const previous = previousServers.find((s) => s?.id === id);
  return Boolean(previous && !hasValue(previous.sshUser)
    && personalHostValue(previous) === host
    && String(previous.sshPort || 22) === String(raw.sshPort || 22)
    && String(previous.sshIdentityFile || "") === String(raw.sshIdentityFile || ""));
}

// 个人新增服务器：host / 端口 / 用户名过硬校验，返回落盘条目；校验失败把原因记进 errors 并返回 null。
function personalServerForWrite(raw, id, prefix, previousServers, errors, previousPorts = []) {
  try {
    const host = assertSafeHost(personalHostValue(raw), `${prefix}.host`);
    const tunnel = raw.tunnel !== false && raw.tunnelEnabled !== false;
    const remotePort = hasValue(raw.remotePort) || tunnel ? assertSafePort(raw.remotePort, `${prefix}.remotePort`) : undefined;
    if (isBlockedBasePortWrite(remotePort, previousPorts)) {
      errors.push({ field: `${prefix}.remotePort`, message: BASE_PORT_WRITE_MESSAGE });
      return null;
    }
    const entry = {
      id,
      name: hasValue(raw.name) ? String(raw.name) : host,
      host,
      address: host,
      ...(remotePort === undefined ? {} : { remotePort }),
      disabled: raw.disabled === true || raw.monitorEnabled === false,
      tunnel,
      schemaVersion: PERSONAL_CONFIG_SCHEMA_VERSION,
    };
    if (!isBlank(raw.localPort)) entry.localPort = assertSafePort(raw.localPort, `${prefix}.localPort`);
    if (!isBlank(raw.sshPort)) entry.sshPort = assertSafePort(raw.sshPort, `${prefix}.sshPort`);
    if (hasValue(raw.sshUser)) {
      entry.sshUser = assertSafeSshUser(String(raw.sshUser).trim());
    } else if (!hasUnchangedLegacyIdentity(previousServers, id, host, raw)) {
      errors.push({ field: `${prefix}.sshUser`, message: "个人服务器必须填写独立 SSH 用户名" });
      return null;
    }
    if (hasValue(raw.sshIdentityFile)) entry.sshIdentityFile = String(raw.sshIdentityFile).trim();
    if (hasValue(raw.authRef)) {
      if (!isAuthRef(raw.authRef)) throw new Error("无效凭据引用");
      entry.authRef = raw.authRef;
    }
    if (hasValue(raw.description)) entry.description = String(raw.description);
    if (Array.isArray(raw.tags)) entry.tags = raw.tags.filter((tag) => typeof tag === "string").slice(0, 8);
    if (hasValue(raw.createdAt)) entry.createdAt = String(raw.createdAt);
    if (hasValue(raw.updatedAt)) entry.updatedAt = String(raw.updatedAt);
    return entry;
  } catch (err) {
    errors.push({ field: `${prefix}`, message: err.message });
    return null;
  }
}

// previousPortOverrides：个人层原本的 portOverrides（7891 豁免："原本就是 7891" 也可能只记在这里）。
export function validatePersonalServersForWrite(servers, { teamServerIds = [], previousServers = [], previousPortOverrides = {} } = {}) {
  const errors = [];
  if (servers !== undefined && !Array.isArray(servers)) {
    return { ok: false, value: null, errors: [{ field: "servers", message: "servers 必须是数组" }] };
  }
  const teamIds = new Set(teamServerIds);
  const seen = new Set();
  const value = [];
  for (const [index, raw] of (servers || []).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ field: `servers[${index}]`, message: "服务器条目必须是对象" });
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const prefix = `servers[${index}]`;
    if (!id) {
      errors.push({ field: `${prefix}.id`, message: "缺少 id" });
      continue;
    }
    if (!isSafeServerId(id)) {
      errors.push({ field: `${prefix}.id`, message: "id 只允许字母/数字/下划线/点/连字符" });
      continue;
    }
    if (seen.has(id)) errors.push({ field: `${prefix}.id`, message: "服务器 id 重复" });
    seen.add(id);
    for (const key of ["disabled", "tunnel", "monitorEnabled", "tunnelEnabled"]) {
      if (raw[key] !== undefined && typeof raw[key] !== "boolean") errors.push({ field: `${prefix}.${key}`, message: "开关必须是布尔值" });
    }
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN_PERSONAL_SERVER_FIELDS.has(key)) {
        errors.push({ field: `${prefix}.${key}`, message: "个人层不能提交该字段" });
      }
    }
    const previousPorts = previousPersonalRemotePorts({ servers: previousServers, portOverrides: previousPortOverrides }, id);
    if (teamIds.has(id)) {
      if (hasValue(raw.host) || hasValue(raw.address)) {
        errors.push({ field: `${prefix}.id`, message: "团队服务器只能提交屏蔽或隧道端口覆盖，不能用同 id 改写地址" });
      } else {
        value.push(teamOverrideForWrite(raw, id, prefix, errors, previousPorts));
      }
      continue;
    }
    const entry = personalServerForWrite(raw, id, prefix, previousServers, errors, previousPorts);
    if (entry) value.push(entry);
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

// 未被屏蔽的服务器（保持配置顺序）：探针注册、前端服务器卡、资源层都用它取代裸 config.servers。
// 空洞条目（null 等假值）与屏蔽条目一样跳过——下游一律直接读 s.id，不必各自再判空。
export function listEnabledServers(merged) {
  const servers = Array.isArray(merged?.servers) ? merged.servers : [];
  return servers.filter((s) => Boolean(s) && s.disabled !== true);
}

// 服务器条目未被屏蔽（disabled !== true）。
export function isServerEnabled(merged, serverId) {
  return listEnabledServers(merged).some((s) => s.id === serverId);
}

// 「主服务器」= 查看视角：未屏蔽条目里 activeServerId → server-01 → 第一条；都没有则 undefined。
// 探针、状态仓、远端动作共用这条回落链（本地代理端口的 resolveProxyPort 另有自己的规则：
// 它不过滤屏蔽条目，保持现网 8888 不漂移）。
export function selectMainServer(merged) {
  const servers = listEnabledServers(merged);
  const activeId = merged?.activeServerId;
  return (activeId ? servers.find((s) => s.id === activeId) : undefined)
    ?? servers.find((s) => s.id === "server-01")
    ?? servers[0];
}

// 没写反向端口（undefined / null / 空串）：v2.54 起团队层不再预烤 remotePort，端口只来自个人层
// portOverrides（端口登记领到的），所以"还没领端口"是正常状态，不是配置错误。
const isPortUnset = (v) => v === undefined || v === null || v === "";
// 与 validators.toPort 同一口径（1–65535 的整数，数字串先归一）；本地写一份是为了不动本文件的 import 行。
const isUsablePort = (v) => {
  const n = isPortUnset(v) ? Number.NaN : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
};

// 启用、要建隧道、却还没有可用反向端口的服务器（保持配置顺序）。端口写了但不合法的也算——
// 它同样建不了隧道（normalizeAgentConfig 会把非法值剔掉并告警）。onboarding 据此给出 missing-port。
export function listServersMissingPort(merged) {
  return listEnabledServers(merged).filter((s) => s.tunnel !== false && !isUsablePort(s.remotePort));
}

// 需要常驻反向隧道的目标：未屏蔽且未声明 tunnel:false（"只监控不建隧道"）。
// host/port 在合并期已校验过一次，这里再过一遍是纵深防御——团队层 config.json 是手编文件，
// 而这些值马上要变成 ssh 的位置参数与 -R 串。不合法条目丢弃而非抛异常：一台写错不能拖垮其余隧道。
// 缺 remotePort 的条目静默跳过（不建隧道，也不每拍 warn 刷屏）：没领端口时界面走 onboarding 的
// missing-port 提示；端口写了但非法才 warn。
export function resolveTunnelTargets(merged, { warn = console.warn } = {}) {
  const targets = [];
  for (const s of listEnabledServers(merged)) {
    if (s?.tunnel === false) continue;
    if (isPortUnset(s?.remotePort)) continue;
    if (!isSafeServerId(String(s?.id ?? ""))) {
      warn(`[config-loader] 服务器 id ${JSON.stringify(s?.id)} 含非法字符，已跳过该隧道`);
      continue;
    }
    try {
      // 只取身份两字段（不整条 attach）：这里要产出固定形状的隧道目标，
      // 不该把 server 条目的其余字段（name/validationProfile…）也带进来。
      const identity = attachPersonalSsh(
        { sshUser: s?.sshUser, sshIdentityFile: s?.sshIdentityFile, sshPort: s?.sshPort },
        merged || {},
      );
      targets.push({
        serverId: s.id,
        host: assertSafeHost(s?.host, `servers["${s?.id}"].host`),
        remotePort: assertSafePort(s?.remotePort, `servers["${s?.id}"].remotePort`),
        localPort: s?.localPort === undefined || s?.localPort === null || s?.localPort === ""
          ? undefined
          : assertSafePort(s.localPort, `servers["${s?.id}"].localPort`),
        // 条目自带的合法 sshUser / sshIdentityFile 优先于全局个人字段：个人层新增的
        // 服务器可能在另一个集群、另一个用户名、另一把钥匙上。判定规则与探针共用
        // attachPersonalSsh，避免隧道与探针对同一台机器用两套身份。
        sshUser: identity.sshUser,
        sshIdentityFile: identity.sshIdentityFile,
        ...(identity.sshPort ? { sshPort: identity.sshPort } : {}),
        ...(isAuthRef(s.authRef) ? { authRef: s.authRef } : {}),
        source: s?.source ?? "team",
      });
    } catch (err) {
      warn(`[config-loader] 服务器 "${s?.id}" 的隧道参数非法，已跳过该隧道：${err.message}`);
    }
  }
  return targets;
}

// 本地代理端口。v2.18 起所有隧道共用同一个本地代理（策略对所有服务器相同），
// 端口沿用活跃服务器的 localPort 以保证 kai 现网仍是 8888；其它服务器的 localPort 只作展示。
// 活跃 id 找不到时回落 server-01（团队主服务器）再回落第一条，最后回落 8888。
export function resolveProxyPort(merged) {
  const servers = Array.isArray(merged?.servers) ? merged.servers : [];
  const activeId = merged?.activeServerId;
  // activeId 为空时不要走 find：`s.id === undefined` 会误命中缺 id 的条目，直接落到下面的回落链。
  const active = (activeId ? servers.find((s) => s?.id === activeId) : undefined)
    ?? servers.find((s) => s?.id === "server-01")
    ?? servers[0];
  const port = Number(active?.localPort);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8888;
}

export function applyValidationPort(profile, remotePort) {
  if (!profile) return profile;
  const out = { ...profile };
  if (typeof out.remoteProxyTest === "string") out.remoteProxyTest = out.remoteProxyTest.replaceAll("{{remotePort}}", String(remotePort));
  return out;
}

// onLocalError({ error, path }) 在个人层"文件存在但解析失败"时被调用（默认 console.warn，不抛异常）。
// 返回的 merged 对象在该场景下会挂 `_localConfigError: true`，供上层（前端/日志）亮黄条提示，
// 而不是像旧实现那样静默吞掉、悄悄回落成团队层裸默认（会让用户在无自建隧道的情况下误以为一切正常）。
// "文件不存在"（ENOENT）仍是正常场景，保持静默，不调用 onLocalError，不挂标记 —— 保证新机器首次运行无告警噪音。
export function loadLayeredConfig({ configPath, localConfigPath, readFileSync = nodeFs.readFileSync, onLocalError = console.warn, onPersonalConfig }) {
  const team = JSON.parse(readFileSync(configPath, "utf8"));
  if (!team || typeof team !== "object" || Array.isArray(team)) throw new ConfigValidationError("团队配置必须是 JSON 对象");
  if (team.servers !== undefined && (!Array.isArray(team.servers)
    || team.servers.some(server => !isBoundedServerId(server?.id)))) {
    throw new ConfigValidationError("团队服务器必须是包含有效 id 的数组");
  }
  let local = {};
  let localConfigError = false;
  let raw;
  let missing = false;
  try {
    raw = readFileSync(localConfigPath, "utf8");
  } catch (err) {
    if (isNotFoundError(err)) {
      missing = true;
    } else {
      onLocalError({ error: err, path: localConfigPath });
      localConfigError = true;
    }
  }
  if (!missing && !localConfigError) {
    try {
      local = JSON.parse(raw);
      if (!local || typeof local !== "object" || Array.isArray(local)) throw new ConfigValidationError("个人配置必须是 JSON 对象");
    } catch (err) {
      onLocalError({ error: err, path: localConfigPath });
      localConfigError = true;
      local = {};
    }
  }
  const merged = mergeConfig(team, local);
  if (localConfigError) merged._localConfigError = true;
  // 私有删除记录只交给同一次读取的内部消费者，不混入 /api/config 合并载荷。
  else if (typeof onPersonalConfig === "function") onPersonalConfig(local);
  return merged;
}

// tmp+rename 原子写（atomic-file）：先把完整内容写到同目录下的临时文件，再 rename 到目标路径。
// rename 在同一文件系统内是原子操作，避免慢写入/进程被杀在半写状态截断 config.local.json
// （截断后 JSON.parse 失败会被 loadLayeredConfig 的 onLocalError 路径捕获，而不是静默回落）。
// 开发模式目录是用户的仓库，不能为了保存一个文件改写整个仓库的访问权限（chmodDir:false）。
export function writeActiveSelection({ localConfigPath, patch, fs = nodeFs }) {
  const current = readPersonalObject(localConfigPath, fs.readFileSync);
  for (const f of WRITABLE_PERSONAL_FIELDS) {
    if (f in (patch || {}) && hasValue(patch[f])) current[f] = patch[f];
  }
  current.revision = (Number(current.revision) || 0) + 1;
  writePrivateFileAtomicSync(localConfigPath, `${JSON.stringify(current, null, 2)}\n`, { fs, chmodDir: false });
  return current;
}

// 设置页保存个人层配置：只接受个人字段，写入前做 schema 校验，目录 0700 / 文件 0600，
// 写前留一份 .bak，成功后递增 revision。坏配置不得静默写成可执行命令。
export function writePersonalConfig({
  localConfigPath,
  patch,
  expectedRevision,
  teamServerIds,
  fs = nodeFs,
}) {
  const current = readPersonalObject(localConfigPath, fs.readFileSync);
  if (expectedRevision != null && String(current.revision ?? 0) !== String(expectedRevision)) {
    throw new ConfigValidationError("配置已被修改，请重新加载后保存", [{ field: "revision", message: "expectedRevision 不匹配" }], 409);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigValidationError("配置必须是 JSON 对象");
  const input = { ...patch };
  for (const field of FORBIDDEN_PERSONAL_SERVER_FIELDS) {
    if (Object.hasOwn(input, field)) throw new ConfigValidationError("个人层不能提交敏感字段", [{ field, message: "不能保存明文凭据或远端命令" }]);
  }
  delete input.expectedRevision;
  delete input.revision;
  if (Object.hasOwn(input, "servers")) {
    const checked = validatePersonalServersForWrite(input.servers, {
      teamServerIds,
      previousServers: Array.isArray(current.servers) ? current.servers : [],
      previousPortOverrides: current.portOverrides,
    });
    if (!checked.ok) throw new ConfigValidationError("个人服务器配置未通过校验", checked.errors);
    input.servers = checked.value;
  }
  if (Object.hasOwn(input, "portOverrides") && !isBlank(input.portOverrides)) {
    const checked = validatePortOverridesForWrite(input.portOverrides, { previous: current });
    if (!checked.ok) throw new ConfigValidationError("端口覆盖未通过校验", checked.errors);
  }
  if (Object.hasOwn(input, "egress")) input.egress = normalizeEgressForWrite(input.egress);
  // proxyAllowedTargets 不在 PERSONAL_FIELDS（合并语义是与团队层取并集，见 mergeConfig），
  // 这里单独校验后落盘；本机代理约 2 秒内热载，无需重启。
  if (Object.hasOwn(input, "proxyAllowedTargets")) {
    const checked = validateAllowlistForWrite(input.proxyAllowedTargets);
    if (!checked.ok) throw new ConfigValidationError("代理白名单未通过校验", checked.errors);
    current.proxyAllowedTargets = checked.value;
  }
  for (const field of PERSONAL_FIELDS) {
    if (Object.hasOwn(input, field)) current[field] = input[field];
  }
  if (Object.hasOwn(input, "_serverTombstones") && Array.isArray(input._serverTombstones)) {
    current._serverTombstones = input._serverTombstones.filter((item) => item && isSafeServerId(item.id)
      && Number.isFinite(item.removedAt))
      .slice(-100).map((item) => ({
        id: item.id,
        name: String(item.name || item.id),
        removedAt: item.removedAt,
        ...(item.snapshot && typeof item.snapshot === "object" ? { snapshot: pickPersonalServerFields(item.snapshot) } : {}),
      }));
  }
  current.schemaVersion = PERSONAL_CONFIG_SCHEMA_VERSION;
  current.revision = (Number(current.revision) || 0) + 1;
  current.updatedAt = new Date().toISOString();

  // 写前备份一份（设置页提示用户可从 .bak 恢复）。写临时文件或 rename 失败时原文件本就
  // 未被改动，无需再从 .bak 回写（那样反而可能盖掉并发写者的新内容）。
  const backupPath = `${localConfigPath}.bak`;
  try {
    fs.copyFileSync(localConfigPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  } catch {}

  writePrivateFileAtomicSync(localConfigPath, `${JSON.stringify(current, null, 2)}\n`, { fs, chmodDir: false });
  return current;
}
