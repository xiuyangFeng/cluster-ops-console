// 配置导出 / 导入的文件格式与比对（v2.64，纯函数）。业务编排在 service.mjs，接口在 http/routes/config-transfer.mjs。
//
// 导出文件 = 个人层配置里「换台电脑还想要」的那些字段 + 本机偏好（监控模块开关、界面面板显隐、各服务器的作业提醒规则）。
// 一律不含：任何令牌（auth-token、集群 / CLI 的 key）、代理口令（运行目录里的口令文件）、用密码登录的服务器的密码
//（在钥匙串 / 凭据库里，个人配置里只有 authRef 引用）、SSH 私钥与 ~/.ssh 下的任何文件、运行数据（日志 / 历史 / 用量 / 事件）。
// 字段按白名单取；取出来的值再过一道 scrubSecrets（名字像口令 / 令牌的键整个去掉，URL 里的 user:pass@ 抹掉，
// 以下划线开头的说明键去掉），手改过的个人配置里万一混进了这类东西也带不出去。
//
// 导入：parseImportDocument 校验格式与格式版本，按同一份白名单取值；planImport 与本机现状逐项比对，列出新增 / 修改 / 删除。
// 粒度：普通字段一项一条；servers 与 portOverrides 按服务器一条；servers 的端口（remotePort / localPort）单独成一条。
// 端口相关的改动都带 ports: true——换电脑导入后会改这台的隧道端口，界面默认不勾，用户勾了才导入。
// 「导出文件里没有的字段」不算删除（不动）；servers / portOverrides 里本机有、文件里没有的条目算删除——列出来，
// 但一律默认不勾（补齐与覆盖，不是镜像删除）；删的是带端口 / 隧道的服务器时同时标 ports。
import { normalizePreferenceIds, PREFERENCE_FIELDS, validatePreferenceIds } from "../modules/catalog.mjs";
import { WATCH_DEFAULT_SETTINGS } from "../jobs/watch-model.mjs";
import { DEFAULT_RULES, normalizeRules, patchRules } from "../jobs/watch-rules.mjs";
import { StatusError } from "../status-error.mjs";
import { isSafeServerId } from "../validators.mjs";

export const EXPORT_FORMAT = "cluster-workbench-config";
export const EXPORT_FORMAT_VERSION = 1;
// 导入请求体上限：正常的导出文件只有几 KB。
export const IMPORT_MAX_BYTES = 256 * 1024;

// 个人层里随导出走的字段（顺序即文件里的顺序）。不含 _serverTombstones（本机删服务器的回收站）、revision / updatedAt 等元数据。
export const EXPORT_PERSONAL_FIELDS = Object.freeze([
  "sshUser", "sshIdentityFile", "activeServerId", "activeAgentId",
  "servers", "portOverrides", "autoRepair", "storageBudgetBytes",
  "egress", "proxyAllowedTargets", "noProxyExtra",
]);
export const EXPORT_PREFERENCE_FIELDS = PREFERENCE_FIELDS;
// 写进导出文件、也在界面上照抄的「不包含」清单。
export const EXPORT_EXCLUDED = Object.freeze([
  "令牌与 auth-token（工作台自己的、集群上 CLI 的 key）",
  "代理口令",
  "用密码登录的服务器的密码（在系统钥匙串 / 凭据库里）",
  "SSH 私钥与 ~/.ssh 下的任何文件",
  "运行数据（日志、历史、用量、事件、作业记录）",
]);
export const EXPORT_NOTICE = "换电脑时 ~/.ssh 下的密钥要另外拷过来；用密码登录的服务器，导入后要在「服务器管理」里重新填一次密码。";

const PORT_FIELDS = ["remotePort", "localPort"];
// 比对 servers 条目时不看的字段：只是时间戳 / 版本记号，不代表配置不同。
const VOLATILE_SERVER_FIELDS = ["createdAt", "updatedAt", "schemaVersion"];
const SECRET_KEY_RE = /password|passwd|passphrase|secret|token|private|credential|cookie|authorization|identitydata|sshpass/i;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const MAX_DEPTH = 8;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export class ImportDocumentError extends StatusError {
  constructor(message, code) {
    super(400, message, { code });
  }
}

// 去掉像口令 / 令牌的键、URL 里的账号口令、以下划线开头的说明键；只留 JSON 原生值。
export function scrubSecrets(value, depth = 0) {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") return value.replace(URL_USERINFO_RE, "$1");
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1)).filter((item) => item !== undefined);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("_") || SECRET_KEY_RE.test(key)) continue;
      const cleaned = scrubSecrets(item, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

// 键排好序的 JSON：比对用（对象键的先后不算不同）。
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const same = (a, b) => stable(a) === stable(b);
// 字符串列表按集合比（白名单、面板 id 的先后不算不同）。
const sameSet = (a, b) => same([...(Array.isArray(a) ? a : [])].sort(), [...(Array.isArray(b) ? b : [])].sort());

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !keys.includes(key)));
const pick = (obj, keys) => Object.fromEntries(keys.filter((key) => obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== "").map((key) => [key, obj[key]]));
const hasAny = (obj) => Object.keys(obj).length > 0;

// ---- 作业提醒规则（每台服务器一份：rules + 两个进度提醒的分钟数）----

function cleanJobAlert(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    rules: normalizeRules(raw.rules),
    silenceMinutes: Number.isInteger(raw.silenceMinutes) ? raw.silenceMinutes : WATCH_DEFAULT_SETTINGS.silenceMinutes,
    limitMinutes: Number.isInteger(raw.limitMinutes) ? raw.limitMinutes : WATCH_DEFAULT_SETTINGS.limitMinutes,
  };
}

// 导入时的严格校验：与界面改规则同一套（patchRules），不合格整份拒绝，不静默丢。
function checkJobAlert(serverId, raw) {
  const where = `jobAlerts.${serverId}`;
  if (!isPlainObject(raw)) throw new ImportDocumentError(`${where} 应为对象`, "bad-job-alerts");
  const rulesRaw = raw.rules ?? {};
  if (!isPlainObject(rulesRaw)) throw new ImportDocumentError(`${where}.rules 应为对象`, "bad-job-alerts");
  let rules;
  try {
    rules = patchRules(DEFAULT_RULES, {
      failNotify: rulesRaw.failNotify ?? DEFAULT_RULES.failNotify,
      longRunMinutes: rulesRaw.longRunMinutes ?? null,
      patterns: Array.isArray(rulesRaw.patterns) ? rulesRaw.patterns : [],
    });
  } catch (error) {
    throw new ImportDocumentError(`${where}：${error.message}`, "bad-job-alerts");
  }
  const minutes = (key, min) => {
    const value = raw[key] ?? WATCH_DEFAULT_SETTINGS[key];
    if (!Number.isInteger(value) || value < min || value > 1440) throw new ImportDocumentError(`${where}.${key} 必须是 ${min}–1440 分钟`, "bad-job-alerts");
    return value;
  };
  return { rules, silenceMinutes: minutes("silenceMinutes", 10), limitMinutes: minutes("limitMinutes", 1) };
}

// ---- 导出 ----

// personal：个人层原始对象；preferences：{ disabledModules, enabledModules, hiddenPanels }（已物化的显式选择）；
// jobAlerts：{ serverId: { rules, silenceMinutes, limitMinutes } }。
export function buildExportDocument({ personal = {}, preferences = {}, jobAlerts = {}, appVersion = null, now = Date.now() } = {}) {
  const pickedPersonal = {};
  for (const field of EXPORT_PERSONAL_FIELDS) {
    if (!isPlainObject(personal) || !Object.hasOwn(personal, field) || personal[field] === undefined) continue;
    const cleaned = scrubSecrets(personal[field]);
    if (cleaned !== undefined) pickedPersonal[field] = cleaned;
  }
  const pickedPreferences = Object.fromEntries(EXPORT_PREFERENCE_FIELDS.map((field) => [field, normalizePreferenceIds(preferences?.[field])]));
  const alerts = {};
  for (const [serverId, raw] of Object.entries(isPlainObject(jobAlerts) ? jobAlerts : {})) {
    const cleaned = isSafeServerId(serverId) ? cleanJobAlert(raw) : null;
    if (cleaned) alerts[serverId] = cleaned;
  }
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date(now).toISOString(),
    appVersion: typeof appVersion === "string" ? appVersion : null,
    notice: EXPORT_NOTICE,
    excluded: [...EXPORT_EXCLUDED],
    personal: pickedPersonal,
    preferences: pickedPreferences,
    jobAlerts: alerts,
  };
}

// ---- 导入：校验 ----

// 不认识的格式 / 更新版本的格式 / 字段形状不对 → ImportDocumentError（400，带 code）。
export function parseImportDocument(raw) {
  if (!isPlainObject(raw)) throw new ImportDocumentError("这不是工作台导出的配置文件（应当是一个 JSON 对象）", "not-object");
  if (raw.format !== EXPORT_FORMAT) throw new ImportDocumentError("这不是工作台导出的配置文件（format 不对）", "bad-format");
  if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) throw new ImportDocumentError("配置文件的格式版本不对", "bad-version");
  if (raw.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new ImportDocumentError(`这份文件来自更新版本的工作台（格式 ${raw.formatVersion}，这里只认到 ${EXPORT_FORMAT_VERSION}）：先把这台的工作台更新到最新再导入`, "newer-version");
  }
  for (const key of ["personal", "preferences", "jobAlerts"]) {
    if (raw[key] !== undefined && !isPlainObject(raw[key])) throw new ImportDocumentError(`${key} 应为对象`, "bad-shape");
  }
  const personal = {};
  for (const field of EXPORT_PERSONAL_FIELDS) {
    if (!raw.personal || !Object.hasOwn(raw.personal, field) || raw.personal[field] === undefined) continue;
    const cleaned = scrubSecrets(raw.personal[field]);
    if (cleaned !== undefined) personal[field] = cleaned;
  }
  if (personal.servers !== undefined) {
    if (!Array.isArray(personal.servers) || personal.servers.some((s) => !isPlainObject(s) || typeof s.id !== "string" || !isSafeServerId(s.id))) {
      throw new ImportDocumentError("personal.servers 应为服务器条目数组，每条都要有合法的 id", "bad-servers");
    }
    const ids = personal.servers.map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new ImportDocumentError("personal.servers 里有重复的服务器 id", "bad-servers");
  }
  if (personal.portOverrides !== undefined) {
    if (!isPlainObject(personal.portOverrides) || Object.entries(personal.portOverrides).some(([id, entry]) => !isSafeServerId(id) || !isPlainObject(entry))) {
      throw new ImportDocumentError("personal.portOverrides 应为 { 服务器 id: { remotePort, localPort } }", "bad-ports");
    }
  }
  const preferences = {};
  for (const field of EXPORT_PREFERENCE_FIELDS) {
    if (!raw.preferences || raw.preferences[field] === undefined) continue;
    const checked = validatePreferenceIds(raw.preferences[field]);
    if (!checked.ok) throw new ImportDocumentError(`preferences.${field}：${checked.message}`, "bad-preferences");
    preferences[field] = checked.value;
  }
  const jobAlerts = {};
  for (const [serverId, value] of Object.entries(raw.jobAlerts || {})) {
    if (!isSafeServerId(serverId)) throw new ImportDocumentError(`jobAlerts 里的服务器 id 不合法：${JSON.stringify(serverId).slice(0, 80)}`, "bad-job-alerts");
    jobAlerts[serverId] = checkJobAlert(serverId, value);
  }
  return {
    meta: {
      exportedAt: typeof raw.exportedAt === "string" && !Number.isNaN(Date.parse(raw.exportedAt)) ? raw.exportedAt : null,
      appVersion: typeof raw.appVersion === "string" && raw.appVersion.length <= 40 ? raw.appVersion : null,
      formatVersion: raw.formatVersion,
    },
    personal,
    preferences,
    jobAlerts,
  };
}

// ---- 导入：比对 ----

const FIELD_LABELS = {
  sshUser: "集群用户名",
  sshIdentityFile: "SSH 密钥路径",
  activeServerId: "正在查看的服务器",
  activeAgentId: "正在查看的 Agent",
  autoRepair: "自动修复",
  storageBudgetBytes: "本地数据预算",
  egress: "出网方式",
  proxyAllowedTargets: "代理端口白名单",
  noProxyExtra: "内网直连名单",
  disabledModules: "关掉的监控模块",
  enabledModules: "打开的监控模块",
  hiddenPanels: "隐藏的界面面板",
};
const SET_FIELDS = new Set(["proxyAllowedTargets"]);
const WHOLE_FIELDS = ["sshUser", "sshIdentityFile", "activeServerId", "activeAgentId", "autoRepair", "storageBudgetBytes", "egress", "proxyAllowedTargets", "noProxyExtra"];
const NOTE_IDENTITY = "这个路径要在这台电脑上存在：~/.ssh 下的密钥要另外拷过来。";
const NOTE_PASSWORD = "用密码登录：密码不随导出，导入后在「服务器管理」里重新填一次。";
// 端口一组的说明（界面上写在这一组的开头，不在每一条下面重复）。
export const PORTS_NOTE = "这些会改这台电脑的隧道端口。端口在集群上按人登记，同一个账号换电脑、要沿用原来的端口才勾；拿不准就别勾，导入后在「服务器管理」里重新领取。";
const NOTE_NEW_TUNNEL = "建隧道的服务器离不开反向端口：勾上它会连端口一起导入。";
const NOTE_REMOVE = "导出文件里没有这一条；不勾就留在这台电脑上。";
const NOTE_REMOVE_TUNNEL = "导出文件里没有这一条；勾上会把它从这台电脑删掉，它的隧道随即断开、反向端口也从这台的配置里去掉。不勾就保留。";

// 给人看的值：紧凑 JSON，过长截断。
export function summarize(value) {
  if (value === undefined) return "（没有）";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// 作业提醒给人看的一句话（比 JSON 好读）。
export function describeJobAlert(alert) {
  const rules = alert?.rules || {};
  const patterns = Array.isArray(rules.patterns) && rules.patterns.length ? rules.patterns.join("、") : "无";
  return `失败提醒${rules.failNotify === false ? "关" : "开"}；长作业${rules.longRunMinutes ? ` ${rules.longRunMinutes} 分钟` : "不提醒"}；名字规则：${patterns}；日志静默 ${alert?.silenceMinutes} 分钟、临近时限 ${alert?.limitMinutes} 分钟提醒`;
}

const kindOf = (before, after) => (before === undefined ? "added" : after === undefined ? "removed" : "changed");

// current：{ personal: 个人层原始对象, preferences, jobAlerts: { id: { rules, silenceMinutes, limitMinutes } },
//            teamServerIds: [...], jobAlertServerIds: [...]（作业提醒现在管得到的服务器） }
// incoming：parseImportDocument 的结果。
// → [{ id, section, field, label, kind, ports, before, after, note, available, reason }]
export function planImport(current, incoming) {
  const changes = [];
  const personal = isPlainObject(current?.personal) ? current.personal : {};
  const next = incoming?.personal || {};
  const add = (change) => changes.push({ ports: false, note: "", available: true, reason: "", ...change });

  for (const field of WHOLE_FIELDS) {
    if (!Object.hasOwn(next, field)) continue;
    const before = personal[field];
    const after = next[field];
    if (SET_FIELDS.has(field) ? sameSet(before, after) : same(before, after)) continue;
    add({
      id: `personal.${field}`, section: "personal", field, label: FIELD_LABELS[field], kind: kindOf(before, after),
      before: summarize(before), after: summarize(after), note: field === "sshIdentityFile" ? NOTE_IDENTITY : "",
    });
  }

  if (Object.hasOwn(next, "servers")) {
    const teamIds = new Set(current?.teamServerIds || []);
    const local = new Map((Array.isArray(personal.servers) ? personal.servers : []).filter((s) => isPlainObject(s) && typeof s.id === "string").map((s) => [s.id, s]));
    for (const entry of next.servers) {
      const cur = local.get(entry.id);
      const name = typeof entry.name === "string" && entry.name ? `${entry.name}（${entry.id}）` : entry.id;
      const ports = pick(entry, PORT_FIELDS);
      const passwordNote = entry.authRef ? NOTE_PASSWORD : "";
      if (!cur) {
        // 新的个人服务器建隧道就离不开反向端口：整条算端口改动，勾上才连端口一起导入。
        const needsPort = !teamIds.has(entry.id) && entry.tunnel !== false && entry.tunnelEnabled !== false;
        if (needsPort) {
          add({ id: `servers.${entry.id}`, section: "personal", field: "servers", label: `服务器 ${name}`, kind: "added", ports: true, before: summarize(undefined), after: summarize(entry), note: [NOTE_NEW_TUNNEL, passwordNote].filter(Boolean).join("") });
          continue;
        }
        add({ id: `servers.${entry.id}`, section: "personal", field: "servers", label: `服务器 ${name}`, kind: "added", before: summarize(undefined), after: summarize(omit(entry, PORT_FIELDS)), note: passwordNote });
        if (hasAny(ports)) add({ id: `servers.${entry.id}.ports`, section: "personal", field: "servers", label: `服务器 ${entry.id} 的隧道端口`, kind: "added", ports: true, before: summarize(undefined), after: summarize(ports) });
        continue;
      }
      const beforeRest = omit(cur, [...PORT_FIELDS, ...VOLATILE_SERVER_FIELDS]);
      const afterRest = omit(entry, [...PORT_FIELDS, ...VOLATILE_SERVER_FIELDS]);
      if (!same(beforeRest, afterRest)) {
        add({ id: `servers.${entry.id}`, section: "personal", field: "servers", label: `服务器 ${name}`, kind: "changed", before: summarize(beforeRest), after: summarize(afterRest), note: passwordNote });
      }
      const curPorts = pick(cur, PORT_FIELDS);
      if (!same(curPorts, ports)) {
        add({
          id: `servers.${entry.id}.ports`, section: "personal", field: "servers", label: `服务器 ${entry.id} 的隧道端口`, ports: true,
          kind: !hasAny(curPorts) ? "added" : !hasAny(ports) ? "removed" : "changed",
          before: summarize(hasAny(curPorts) ? curPorts : undefined), after: summarize(hasAny(ports) ? ports : undefined),
        });
      }
    }
    // 本机有、文件里没有：列出来但默认不勾（defaultSelection）——换电脑导入是补齐与覆盖，不是镜像删除。
    // 带反向端口 / 建隧道的那些同时算端口改动：删掉会让这台的隧道断开、端口从这台的配置里消失。
    const incomingIds = new Set(next.servers.map((s) => s.id));
    for (const [id, cur] of local) {
      if (incomingIds.has(id)) continue;
      const hasPorts = hasAny(pick(cur, PORT_FIELDS));
      const tunnel = cur.tunnel !== false && cur.tunnelEnabled !== false && (hasPorts || teamIds.has(id));
      add({
        id: `servers.${id}`, section: "personal", field: "servers", label: `服务器 ${cur.name ? `${cur.name}（${id}）` : id}`, kind: "removed",
        ports: tunnel || hasPorts, before: summarize(cur), after: summarize(undefined),
        note: tunnel || hasPorts ? NOTE_REMOVE_TUNNEL : NOTE_REMOVE,
      });
    }
  }

  if (Object.hasOwn(next, "portOverrides")) {
    const local = isPlainObject(personal.portOverrides) ? personal.portOverrides : {};
    for (const id of [...new Set([...Object.keys(next.portOverrides), ...Object.keys(local)])].sort()) {
      const before = local[id];
      const after = next.portOverrides[id];
      if (same(before, after)) continue;
      add({ id: `portOverrides.${id}`, section: "personal", field: "portOverrides", label: `${id} 的隧道端口（portOverrides）`, kind: kindOf(before, after), ports: true, before: summarize(before), after: summarize(after) });
    }
  }

  const prefs = current?.preferences || {};
  for (const field of EXPORT_PREFERENCE_FIELDS) {
    if (!Object.hasOwn(incoming?.preferences || {}, field)) continue;
    const before = normalizePreferenceIds(prefs[field]);
    const after = incoming.preferences[field];
    if (sameSet(before, after)) continue;
    add({ id: `preferences.${field}`, section: "preferences", field, label: FIELD_LABELS[field], kind: "changed", before: summarize(before), after: summarize(after) });
  }

  const reachable = new Set(current?.jobAlertServerIds || []);
  const addedServers = new Set(changes.filter((c) => c.field === "servers" && c.kind === "added" && !c.id.endsWith(".ports")).map((c) => c.id.slice("servers.".length)));
  for (const [serverId, after] of Object.entries(incoming?.jobAlerts || {})) {
    const before = cleanJobAlert(current?.jobAlerts?.[serverId]) || cleanJobAlert({});
    if (same(before, after)) continue;
    const available = current?.jobsEnabled !== false && (reachable.has(serverId) || addedServers.has(serverId));
    add({
      id: `jobAlerts.${serverId}`, section: "jobAlerts", field: "jobAlerts", label: `${serverId} 的作业提醒规则`, kind: "changed",
      before: summarize(describeJobAlert(before)), after: summarize(describeJobAlert(after)),
      available,
      reason: available ? "" : current?.jobsEnabled === false ? "「我的 Slurm 作业」模块关着" : "这台电脑上还没有这台服务器",
      note: available && !reachable.has(serverId) ? "随这台服务器一起导入后生效。" : "",
    });
  }
  return changes;
}

// 界面默认勾选：端口改动、一切「删除」、暂时用不上的都不勾，其余（新增与修改）都勾。
// 换电脑导入的语义是补齐与覆盖：本机有、文件里没有的东西默认保留，用户勾了才删。
export function defaultSelection(changes) {
  return changes.filter((change) => change.available && !change.ports && change.kind !== "removed").map((change) => change.id);
}

// ---- 导入：把选中的个人层改动叠到现状上 ----

// → { patch: 交给 writePersonalConfig 的补丁（只含动到的字段）, applied: [id], skipped: [{ id, reason }] }
export function buildPersonalPatch(current, incoming, changes, selectedIds) {
  const selected = new Set(selectedIds);
  const personal = isPlainObject(current?.personal) ? current.personal : {};
  const next = incoming?.personal || {};
  const patch = {};
  const applied = [];
  const skipped = [];
  const picked = changes.filter((change) => change.section === "personal" && selected.has(change.id) && change.available);

  for (const change of picked.filter((c) => c.id.startsWith("personal."))) {
    patch[change.field] = clone(next[change.field]);
    applied.push(change.id);
  }

  const overrides = picked.filter((c) => c.field === "portOverrides");
  if (overrides.length) {
    const draft = clone(isPlainObject(personal.portOverrides) ? personal.portOverrides : {});
    for (const change of overrides) {
      const id = change.id.slice("portOverrides.".length);
      if (next.portOverrides[id] === undefined) delete draft[id];
      else draft[id] = clone(next.portOverrides[id]);
      applied.push(change.id);
    }
    patch.portOverrides = draft;
  }

  const serverChanges = picked.filter((c) => c.field === "servers");
  if (serverChanges.length) {
    let draft = clone(Array.isArray(personal.servers) ? personal.servers : []);
    const incomingById = new Map(next.servers.map((s) => [s.id, s]));
    const indexOf = (id) => draft.findIndex((s) => s?.id === id);
    // 先条目本身（增 / 改 / 删），再端口——同一台的两条都勾了时，端口落在改好的条目上。
    for (const change of serverChanges.filter((c) => !c.id.endsWith(".ports"))) {
      const id = change.id.slice("servers.".length);
      const entry = incomingById.get(id);
      if (change.kind === "removed") {
        draft = draft.filter((s) => s?.id !== id);
      } else if (change.kind === "added") {
        draft.push(change.ports ? clone(entry) : clone(omit(entry, PORT_FIELDS)));
      } else {
        const at = indexOf(id);
        draft[at] = { ...clone(omit(entry, PORT_FIELDS)), ...pick(draft[at], PORT_FIELDS) };
      }
      applied.push(change.id);
    }
    for (const change of serverChanges.filter((c) => c.id.endsWith(".ports"))) {
      const id = change.id.slice("servers.".length, -".ports".length);
      const at = indexOf(id);
      if (at === -1) {
        skipped.push({ id: change.id, reason: "这台服务器没有导入（没勾它本身），端口也就不导了" });
        continue;
      }
      const ports = pick(incomingById.get(id), PORT_FIELDS);
      draft[at] = { ...omit(draft[at], PORT_FIELDS), ...ports };
      applied.push(change.id);
    }
    patch.servers = draft;
  }
  return { patch, applied, skipped };
}

// 选中的偏好改动 → writePersonalPreferences 的补丁（整字段替换）。
export function buildPreferencesPatch(incoming, changes, selectedIds) {
  const selected = new Set(selectedIds);
  const patch = {};
  const applied = [];
  for (const change of changes) {
    if (change.section !== "preferences" || !selected.has(change.id)) continue;
    patch[change.field] = [...incoming.preferences[change.field]];
    applied.push(change.id);
  }
  return { patch, applied };
}

// 选中的作业提醒改动 → [{ id, serverId, value: { rules, silenceMinutes, limitMinutes } }]。
export function pickJobAlertChanges(incoming, changes, selectedIds) {
  const selected = new Set(selectedIds);
  return changes
    .filter((change) => change.section === "jobAlerts" && selected.has(change.id) && change.available)
    .map((change) => {
      const serverId = change.id.slice("jobAlerts.".length);
      return { id: change.id, serverId, value: incoming.jobAlerts[serverId] };
    });
}
