// scripts/setup/port-assignment.mjs —— P3：为本账号在服务器上领取不与他人冲突的反向端口。
//
// v2.54 起端口走集群上的登记目录（work/monitor/lib/port-registry.mjs，设计稿 2026-10-07 §5.A）：
// 一次 SSH 读齐 登记表 / 我是谁 / 当前监听 → 名下已有登记端口就沿用 → 否则按序原子领取 →
// 写个人层 portOverrides（localPort = remotePort + 1000）。
// 登记目录还没建（或当前账号写不进去）时回落旧的"只看谁在监听"分配，并醒目提示管理员建目录的命令。
// 建议值的尺子（pickReversePort / parseListeningPorts / 探测命令）仍在 work/monitor/lib/reverse-port.mjs，
// 与控制台"添加服务器建议端口 / 端口被占重新分配"共用。
import fs from "node:fs";
import path from "node:path";
import { writeActiveSelection } from "../../work/monitor/lib/config-loader.mjs";
import {
  buildClaimCommand,
  buildRegistryAdminCommand,
  buildRegistrySurveyCommand,
  DEFAULT_PORT_REGISTRY_DIR,
  ownRegisteredPorts,
  parseClaimResult,
  parseRegistrySurvey,
  pickClaimCandidates,
  registeredOwnerOf,
  normalizePortRegistryDir,
  resolvePortRegistryDir,
} from "../../work/monitor/lib/port-registry.mjs";
import { LOCAL_PORT_OFFSET, parseListeningPorts, pickReversePort, REMOTE_LISTEN_SURVEY_COMMAND, REVERSE_PORT_BASE, REVERSE_PORT_SPAN } from "../../work/monitor/lib/reverse-port.mjs";
import { toPort } from "../../work/monitor/lib/validators.mjs";
import { defaultLocalConfigPath, readLocalConfigObject } from "./local-config.mjs";
import { runSsh } from "./ssh-probe.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logHeader, logInfo, logSuccess, logWarning, printManualCommand } from "./ui.mjs";

// 纯函数：校验端口未被团队配置占用（尤其是生产 remotePort，如 7891）。手动输入端口必须过这一关。
export function assertPortNotTeamReserved(port, teamRemotePorts = []) {
  if ((teamRemotePorts || []).includes(port)) {
    throw new Error(`端口 ${port} 已被团队配置（remotePort）占用，不能分配给个人反向端口`);
  }
  return true;
}

// 探服务器当前正在监听的 78xx/79xx 端口，作为保留集的补充。`ss` 缺失时返回空数组（忽略，不报错）。
// （个人服务器步骤仍用它；团队服务器改走 survey，一次 SSH 连登记表一起读回。）
export async function readRemoteListeningPorts({ host, dryRun = DRY_RUN, ssh = runSsh, timeoutMs = 10000 } = {}) {
  const cmd = REMOTE_LISTEN_SURVEY_COMMAND;
  if (dryRun) {
    dryRunLog(`ssh ${host} "${cmd}"`);
    return [];
  }
  const res = ssh(host, cmd, { timeoutMs });
  if (res?.status !== 0) return [];
  return parseListeningPorts(res.stdout || "");
}

// 团队层 config.json 的 portRegistry.dir（缺省 /public/agent-hub/ports）。向导与 config.json 同在
// 仓库根运行（setup-wizard 同样按 cwd 读它）；读不到 / 写坏都回落默认目录，不让这一步拖垮向导。
export function readTeamPortRegistryDir({ configPath = path.resolve(process.cwd(), "config.json"), readFile = fs.readFileSync, warn = logWarning } = {}) {
  try {
    const config = JSON.parse(readFile(configPath, "utf8"));
    const raw = config?.portRegistry?.dir;
    if (config?.portRegistry?.required === true && raw != null && raw !== "" && !normalizePortRegistryDir(raw)) {
      warn(`portRegistry.dir ${JSON.stringify(raw)} 无法用于强制登记，已停止端口分配`);
      return null;
    }
    return resolvePortRegistryDir(config, { warn });
  } catch {
    return DEFAULT_PORT_REGISTRY_DIR;
  }
}

// 发布给多人使用时可以把端口登记设为强制：登记目录不可用就停止向导，
// 绝不回落到只能看到「当前在线监听」的旧分配方式。默认仍保持兼容，
// 由 setup-wizard 显式把团队层的开关传进来，避免测试/第三方调用方被隐式改变。
export function readTeamPortRegistryRequired({ configPath = path.resolve(process.cwd(), "config.json"), readFile = fs.readFileSync } = {}) {
  try {
    return JSON.parse(readFile(configPath, "utf8"))?.portRegistry?.required === true;
  } catch {
    return false;
  }
}

// 个人层里这台服务器已有的端口（旧向导分配 / 手写 / 上次领的），没有返回 null。
// 读坏不阻断：只是少一个"沿用"候选，真正写回时 writeActiveSelection 会再次严格读取。
export function readCurrentPortOverride(localConfigPath, serverId, { readLocal = readLocalConfigObject } = {}) {
  try {
    return toPort(readLocal(localConfigPath)?.portOverrides?.[serverId]?.remotePort);
  } catch {
    return null;
  }
}

// 纯函数：手动输入的端口能不能拿去登记。返回 { ok, port } 或 { ok:false, reason }（reason 直接给用户看）。
// 自己名下的、或个人层原本就在用的端口正在监听属正常（多半就是自己的隧道），其余监听中的端口不收。
// existing = 个人层这台服务器原本的端口（readCurrentPortOverride）。
export function checkManualPort(answer, { survey, teamRemotePorts = [], existing = null } = {}) {
  const port = /^\d+$/.test(String(answer).trim()) ? toPort(String(answer).trim()) : null;
  if (port === null) return { ok: false, reason: `输入的端口无效 ("${answer}")` };
  // 团队基准端口（7891，kai 的生产隧道）永不分给新登记：只有个人层原本就用它时才能沿用。
  if (port === REVERSE_PORT_BASE && existing !== REVERSE_PORT_BASE) {
    return { ok: false, reason: `${REVERSE_PORT_BASE} 是团队最早的生产端口，向导不会把它分给新登记` };
  }
  try {
    assertPortNotTeamReserved(port, teamRemotePorts);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const owner = registeredOwnerOf(survey, port);
  if (owner !== null && owner !== survey?.me) return { ok: false, reason: `端口 ${port} 已被 ${owner || "他人"} 登记` };
  if (owner === null && port !== existing && (survey?.listening || []).includes(port)) {
    return { ok: false, reason: `端口 ${port} 正被服务器监听（可能是还没登记的旧隧道）` };
  }
  return { ok: true, port };
}

// 纯函数：个人层原有端口（旧向导分配 / 手写、还没登记）能否作为默认值直接登记。
// 沿用的好处是集群上按旧端口写好的代理设置不必改；但只在确定安全时默认沿用（v2.54 终审）：
//   - 已登记的（不论属主）不沿用：别人的不能占，自己名下的已在上一步 reused 分支处理；
//   - 团队保留端口不沿用；团队基准端口 7891 与控制台写入守卫同一条规则：只有个人层原本就是它
//     （existing 恒为个人层原值，即 kai 本人）才可能沿用，buildReservedPorts 据此决定是否把它算进保留集；
//   - 正在被监听的不默认沿用：分不清是自己的隧道还是别人没登记的旧隧道，交给用户确认（见调用处提示）。
export function pickPreferredPort({ existing, survey, teamRemotePorts = [] } = {}) {
  const port = toPort(existing);
  if (port === null) return null;
  if (registeredOwnerOf(survey, port) !== null) return null;
  if ((teamRemotePorts || []).includes(port)) return null;
  if ((survey?.listening || []).includes(port)) return null;
  return port;
}

// 团队保留集：团队层 remotePort（v2.54 起团队层通常不再带）∪ 团队基准端口 7891——后者保证
// assertPortNotTeamReserved / pickClaimCandidates 不因团队层没端口而空转；个人层原本就是 7891 的
// （kai 本人）不把它算进保留集，沿用与手动输入照常放行。
export function buildReservedPorts(teamRemotePorts = [], existing = null) {
  const reserved = (teamRemotePorts || []).map(toPort).filter((p) => p !== null);
  if (toPort(existing) !== REVERSE_PORT_BASE && !reserved.includes(REVERSE_PORT_BASE)) reserved.push(REVERSE_PORT_BASE);
  return reserved;
}

const DEFAULT_UI = { logHeader, logInfo, logSuccess, logWarning, printManualCommand, dryRunLog };

function readPortOverrides(localConfigPath, readLocal) {
  try {
    const overrides = readLocal(localConfigPath)?.portOverrides;
    return overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  } catch {
    return {};
  }
}

// 登记目录不可用时的醒目提示：说清楚风险（可能与他人撞端口）与管理员要跑的那一条命令。
function warnRegistryUnavailable(ui, { dir, state }) {
  const why = state === "readonly"
    ? `集群上的端口登记目录 ${dir} 存在，但当前账号写不进去（权限应为 1777）。`
    : `集群上还没有端口登记目录 ${dir}。`;
  ui.logWarning(`未启用端口登记：${why}`);
  ui.logWarning("本次只能按\"当前谁在监听\"分配端口——对方离线时看不出占用，可能与他人分到同一个端口，导致你或对方的集群流量从别人的电脑出网。");
  ui.logInfo("请联系集群管理员执行一次（需要 root）：");
  ui.printManualCommand(`    ${buildRegistryAdminCommand(dir, { state })}`);
  ui.logInfo("目录就绪后重跑 npm run setup，向导会把你的端口登记下来（已在用的端口会优先沿用）。");
}

// 旧分配（登记目录不可用时的回落）：保留集 = 团队 remotePort ∪ 当前监听端口，取并集之外最小的端口作建议值。
// 手动输入同样要过 assertPortNotTeamReserved + 不与正在监听的端口碰撞；团队基准端口同登记模式一样不收。
async function assignWithoutRegistry({ listening, teamRemotePorts, existing, ask, ui }) {
  if (listening.length) {
    ui.logInfo(`服务器当前监听的反向端口段占用: ${listening.join(", ")}（已并入保留集）`);
  }
  const suggested = pickReversePort({ inUse: listening, reserved: teamRemotePorts, base: REVERSE_PORT_BASE, span: REVERSE_PORT_SPAN });
  const answer = await ask(`请输入要为您的账号分配的反向端口 (直接回车使用建议值 ${suggested}，已避开服务器上正在监听的端口): `);
  let remotePort = answer ? Number.parseInt(answer, 10) : suggested;
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    ui.logWarning(`输入的端口无效 ("${answer}")，回退使用建议值 ${suggested}。`);
    remotePort = suggested;
  } else {
    // 先判 7891（给出准确原因），再判团队保留集（buildReservedPorts 已把 7891 并入保留集）。
    if (remotePort === REVERSE_PORT_BASE && existing !== REVERSE_PORT_BASE) {
      ui.logWarning(`${REVERSE_PORT_BASE} 是团队最早的生产端口，向导不会分配它，回退使用建议值 ${suggested}。`);
      remotePort = suggested;
    }
    try {
      assertPortNotTeamReserved(remotePort, teamRemotePorts);
    } catch (err) {
      ui.logWarning(`${err.message}，回退使用建议值 ${suggested}。`);
      remotePort = suggested;
    }
    if (listening.includes(remotePort)) {
      ui.logWarning(`端口 ${remotePort} 正被服务器监听，回退使用建议值 ${suggested}。`);
      remotePort = suggested;
    }
  }
  return remotePort;
}

// 登记目录可用：沿用名下端口，或交互选定后原子领取。返回 { remotePort, mode } 或 { fallback: state }
//（领取时目录刚好消失 / 变只读，交回调用方走旧分配）。
async function assignWithRegistry({ host, dir, survey, teamRemotePorts, existing, ssh, ask, dryRun, ui }) {
  if (survey.sticky === false) {
    ui.logWarning(`端口登记目录 ${dir} 没有粘滞位，别人可以删除你的登记文件。请管理员执行：${buildRegistryAdminCommand(dir, { state: "no-sticky" })}`);
  }
  const own = ownRegisteredPorts(survey);
  if (own.length > 0) {
    const port = own.includes(existing) ? existing : own[0];
    ui.logSuccess(`登记目录里已有你名下的端口 ${port}，直接沿用。`);
    if (own.length > 1) ui.logInfo(`你名下共登记了 ${own.join(", ")}；多余的可以之后释放。`);
    if (survey.listening.includes(port) && port !== existing) {
      ui.logInfo(`端口 ${port} 此刻正在被监听，而这台电脑的配置里还没有它——多半是你另一台电脑在用。两台电脑共用这个端口即可（v2.88 起自动接力）：同一时刻一台承载、另一台待命，承载的那台睡眠或断网时待命的自动接上；想换到这台时在控制台点「让这台承载」。集群上的代理设置不用改。`);
    }
    return { remotePort: port, mode: "reused" };
  }

  const registered = survey.entries.map((e) => e.port);
  const reservedWithRoster = [...teamRemotePorts, ...(survey.rosterOtherPorts || [])];
  const candidates = pickClaimCandidates({ registered, listening: survey.listening, reserved: reservedWithRoster });
  const preferred = pickPreferredPort({ existing, survey, teamRemotePorts: reservedWithRoster })
    ?? pickPreferredPort({ existing: survey.rosterAssignedPort, survey, teamRemotePorts: reservedWithRoster });
  const suggested = preferred ?? candidates[0];
  if (suggested === undefined) {
    throw new Error(`反向端口区间 ${REVERSE_PORT_BASE + 1}-${REVERSE_PORT_BASE + REVERSE_PORT_SPAN} 已全部被登记或占用，请联系管理员清理登记目录 ${dir}`);
  }
  if (registered.length) ui.logInfo(`已登记的端口: ${registered.join(", ")}（不会再分给你）`);
  // 个人层原端口没登记、却正在被监听：可能是自己这台电脑正在跑的隧道，也可能是别人还没登记的旧隧道——
  // 向导分不清，不替用户默认沿用；说清楚，让用户确认是自己的再手动输入它（checkManualPort 放行原端口）。
  if (preferred === null && existing !== null && registeredOwnerOf(survey, existing) === null && survey.listening.includes(existing)) {
    ui.logWarning(`你当前配置的端口 ${existing} 还没登记，且此刻正在被监听：如果是你这台电脑正在运行的隧道，请在下面输入 ${existing} 沿用并登记；否则直接回车登记新端口 ${suggested}。`);
  }
  const hint = preferred !== null ? `沿用你当前配置的 ${preferred} 并登记` : `登记建议值 ${suggested}`;
  const answer = await ask(`请输入要登记的反向端口 (直接回车${hint}): `);
  let chosen = suggested;
  if (answer) {
    const checked = checkManualPort(answer, { survey, teamRemotePorts, existing });
    if (checked.ok) chosen = checked.port;
    else ui.logWarning(`${checked.reason}，回退使用 ${suggested}。`);
  }
  // 选定的端口排第一，其余候选兜底：领取前一刻被别人抢先登记时自动顺延到下一个空闲端口。
  const order = [chosen, ...candidates.filter((p) => p !== chosen)];
  const command = buildClaimCommand(dir, order);
  if (dryRun) {
    ui.dryRunLog(`ssh ${host} <在 ${dir} 里按序原子领取: ${order.slice(0, 5).join(", ")}${order.length > 5 ? " …" : ""}>`);
    return { remotePort: chosen, mode: "claimed" };
  }
  const res = ssh(host, command, { timeoutMs: 15000 });
  const result = parseClaimResult(res?.status === 0 ? res.stdout : "");
  if (result.status === "claimed") {
    if (result.port !== chosen) ui.logWarning(`端口 ${chosen} 刚被别人抢先登记，已改领 ${result.port}。`);
    ui.logSuccess(`已在 ${host}:${dir} 登记端口 ${result.port}（文件属主是你，别人删不掉也领不走）。`);
    return { remotePort: result.port, mode: "claimed" };
  }
  if (result.status === "absent" || result.status === "readonly") return { fallback: result.status };
  if (result.status === "exhausted") {
    throw new Error(`候选端口在领取时全部被别人抢先登记，请稍后重跑 npm run setup`);
  }
  const detail = String(res?.stderr || res?.error?.message || "").trim().split(/\r?\n/).filter(Boolean).pop() || `ssh 退出码 ${res?.status}`;
  throw new Error(`在 ${host} 上登记端口失败（${detail}），请确认网络在 SSH 白名单内后重跑 npm run setup`);
}

// P3：为当前账号在目标服务器上领取一个不与他人冲突的反向端口，并写入个人层 portOverrides。
// 依赖全部可注入（测试用假 SSH / 假提问 / 假写盘）；返回 { remotePort, localPort, registry, mode }：
//   registry ∈ ok | absent | readonly（dry-run 下为 unknown）；
//   mode ∈ reused（沿用名下登记）| claimed（新领取）| legacy（登记不可用，按监听分配）。
export async function assignReversePort(server, teamRemotePorts = [], deps = {}) {
  const {
    ssh = runSsh,
    ask = askQuestion,
    dryRun = DRY_RUN,
    localConfigPath = defaultLocalConfigPath(),
    registryDir = readTeamPortRegistryDir(),
    requireRegistry = false,
    writeConfig = writeActiveSelection,
    readLocal = readLocalConfigObject,
  } = deps;
  const ui = { ...DEFAULT_UI, ...(deps.ui || {}) };
  const host = server.host;
  if (!registryDir) {
    throw new Error("强制端口登记已启用，但 portRegistry.dir 无效；请修正团队 config.json 后重试");
  }
  const existing = readCurrentPortOverride(localConfigPath, server.id, { readLocal });
  const reserved = buildReservedPorts(teamRemotePorts, existing);

  ui.logHeader("3. 领取专属反向端口 (P3：多人同服务器隔离，集群端口登记)");

  let survey;
  if (dryRun) {
    ui.dryRunLog(`ssh ${host} <读端口登记目录 ${registryDir} + 当前账号 + ss -ltn>`);
    survey = { registry: "unknown", sticky: null, me: "", entries: [], listening: [] };
  } else {
    const res = ssh(host, buildRegistrySurveyCommand(registryDir), { timeoutMs: 15000 });
    survey = parseRegistrySurvey(res?.status === 0 ? res.stdout : "");
    if (survey.registry === "unknown") {
      const detail = String(res?.stderr || res?.error?.message || "").trim().split(/\r?\n/).filter(Boolean).pop() || `ssh 退出码 ${res?.status}`;
      // 读不到就不分配：目录可能存在只是这次没读到，按"没有登记"回落会把别人登记的端口分出去。
      throw new Error(`无法读取 ${host} 上的端口登记信息（${detail}），请确认网络在 SSH 白名单内后重跑 npm run setup`);
    }
  }

  let outcome = null;
  if (survey.registry === "ok" || (dryRun && survey.registry === "unknown")) {
    outcome = await assignWithRegistry({ host, dir: registryDir, survey, teamRemotePorts: reserved, existing, ssh, ask, dryRun, ui });
  }
  let registry = dryRun ? "unknown" : survey.registry;
  if (!outcome || outcome.fallback) {
    registry = outcome?.fallback || survey.registry;
    warnRegistryUnavailable(ui, { dir: registryDir, state: registry });
    if (requireRegistry) {
      throw new Error(`端口登记目录 ${registryDir} 不可用，已停止分配以避免与离线同事撞端口。请管理员先执行：${buildRegistryAdminCommand(registryDir, { state: registry })}`);
    }
    outcome = { remotePort: await assignWithoutRegistry({ listening: survey.listening, teamRemotePorts: reserved, existing, ask, ui }), mode: "legacy" };
  }

  const remotePort = outcome.remotePort;
  const localPort = remotePort + LOCAL_PORT_OFFSET;
  ui.logSuccess(`已分配端口: remotePort=${remotePort} → localPort=${localPort}（本地转发端口 = 远端端口 + ${LOCAL_PORT_OFFSET}）`);

  // portOverrides 整体落盘（writeActiveSelection 按字段整体替换）：先并入个人层已有的其他服务器条目，
  // 免得为 server-01 领端口时把别的团队服务器的端口覆盖抹掉。
  const patch = { portOverrides: { ...readPortOverrides(localConfigPath, readLocal), [server.id]: { remotePort, localPort } } };
  if (dryRun) {
    ui.dryRunLog(`write config.local.json patch=${JSON.stringify(patch)}`);
  } else {
    writeConfig({ localConfigPath, patch });
    ui.logSuccess(`已将端口分配写入个人层配置: ${localConfigPath}`);
  }

  return { remotePort, localPort, registry, mode: outcome.mode };
}
