// scripts/setup/local-config.mjs —— 向导对个人层 config.local.json 的读写。
//
// 两条落盘通路：
//   - 标量个人字段（sshUser / activeServerId / sshIdentityFile / portOverrides）走 config-loader 的
//     writeActiveSelection（字段级 patch，白名单与控制台同一份）；
//   - 结构化的 servers（个人服务器 / 屏蔽标记）不在那份白名单里（控制台只读原则），由向导自己
//     整份读改写：readLocalConfigObject → 纯函数变换 → persistLocalConfig 原子写回。
// 纯函数（upsertPersonalServer / disableTeamServer / enableTeamServer / buildPersonalIdentityPatch /
// readSshUserFromLocalConfig）不 SSH、不落盘、不读 process.argv，调用方负责副作用。
import fs from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../work/monitor/lib/atomic-file.mjs";
import { noProxyExtraFor } from "../../work/monitor/lib/cluster-env.mjs";
import { writeActiveSelection } from "../../work/monitor/lib/config-loader.mjs";
import { assertSafeHost, assertSafePort, assertSafeSshUser } from "../../work/monitor/lib/ssh-args.mjs";
import { DRY_RUN, dryRunLog, logError, logInfo, logSuccess, logWarning } from "./ui.mjs";
import { SERVER_ID_PATTERN } from "../../work/monitor/lib/validators.mjs";

// 与 lib/runtime-paths.mjs 同一个覆盖变量：打包 .app 的个人层在 Application Support 下，
// 不设它时向导写到 cwd，控制台读不到（引导卡永远不消失）。
export function defaultLocalConfigPath() {
  const override = process.env.CODEX_MONITOR_LOCAL_CONFIG_PATH;
  return path.resolve(override?.trim() ? override : path.join(process.cwd(), "config.local.json"));
}

// ---------------------------------------------------------------------------
// 个人身份（纯函数）
// ---------------------------------------------------------------------------

export function buildPersonalIdentityPatch(server, user, identityFile) {
  const patch = { activeServerId: server.id };
  if (typeof user === "string" && user.trim()) patch.sshUser = user.trim();
  if (identityFile) patch.sshIdentityFile = identityFile;
  return patch;
}

export function readSshUserFromLocalConfig(text) {
  try {
    const local = JSON.parse(text || "{}");
    if (typeof local.sshUser === "string" && /^[\w.-]+$/.test(local.sshUser.trim())) {
      return local.sshUser.trim();
    }
  } catch {
    // 个人层缺失或损坏时由调用方再从 ssh config / 交互补齐
  }
  return "";
}

// ---------------------------------------------------------------------------
// v2.18 个人服务器层（设计 §6.1）：servers 条目的纯函数变换，全部返回新对象、绝不修改入参。
// ---------------------------------------------------------------------------

// 个人层 servers 条目的 id：与 config-loader 的合并键同一把尺子。
export const PERSONAL_SERVER_ID_RE = SERVER_ID_PATTERN;
// 值"有内容"判定：空数组/空串/纯空白串按没写处理（比 config-loader 内部的 hasValue 多一步 trim，
// 向导的交互输入常带空白）。
const hasContent = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
};

function splitLocalConfig(localConfig) {
  const base = localConfig && typeof localConfig === "object" ? localConfig : {};
  const servers = Array.isArray(base.servers) ? base.servers : [];
  return { base, servers };
}

function assertServerId(id) {
  const key = typeof id === "string" ? id.trim() : "";
  if (!key || !PERSONAL_SERVER_ID_RE.test(key)) {
    throw new Error(`服务器 id 非法: ${JSON.stringify(id)}，只允许 [A-Za-z0-9_.-]`);
  }
  return key;
}

// 纯函数：把一台个人服务器 upsert 进个人层配置对象，返回**新对象**（绝不修改入参）。
// 同 id 覆盖时保留原条目中本次没提供的字段（例如上次写过的 description 不会因为这次没问就丢）。
// id / host / remotePort 必填并过硬校验：这三个值会变成 ssh 的位置参数与 -R 串，
// 非法即 throw，由调用方捕获后提示用户重填（而不是把脏值写进 config.local.json）。
export function upsertPersonalServer(localConfig, entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  const id = typeof src.id === "string" ? src.id.trim() : "";
  if (!id || !PERSONAL_SERVER_ID_RE.test(id)) {
    throw new Error(`个人服务器 id 非法: ${JSON.stringify(src.id)}，只允许 [A-Za-z0-9_.-]`);
  }
  const patch = {
    id,
    host: assertSafeHost(src.host, `servers["${id}"].host`),
    remotePort: assertSafePort(src.remotePort, `servers["${id}"].remotePort`),
  };
  if (hasContent(src.name)) patch.name = String(src.name).trim();
  if (hasContent(src.localPort)) patch.localPort = assertSafePort(src.localPort, `servers["${id}"].localPort`);
  if (src.tunnel !== undefined) patch.tunnel = src.tunnel !== false;
  if (hasContent(src.description)) patch.description = String(src.description).trim();
  // sshUser 只在"这台机器的账号与团队账号不同"时写入条目，供 attachPersonalSsh 按条目优先取用。
  if (hasContent(src.sshUser)) patch.sshUser = assertSafeSshUser(String(src.sshUser).trim());

  const { base, servers } = splitLocalConfig(localConfig);
  let replaced = false;
  const next = servers.map((s) => {
    if (!s || typeof s !== "object" || s.id !== id) return s;
    replaced = true;
    return { ...s, ...patch };
  });
  if (!replaced) next.push(patch);
  return { ...base, servers: next };
}

// 纯函数：把团队服务器在个人层标记为屏蔽（"我不在这个集群"）。已有同 id 条目则合并，
// 否则追加一条只带 { id, disabled: true } 的最小条目 —— config-loader 同 id 覆盖只吃
// disabled/remotePort/localPort/tunnel，所以这条不会改动团队条目指向哪台机器。
export function disableTeamServer(localConfig, id) {
  const key = assertServerId(id);
  const { base, servers } = splitLocalConfig(localConfig);
  let found = false;
  const next = servers.map((s) => {
    if (!s || typeof s !== "object" || s.id !== key) return s;
    found = true;
    return { ...s, disabled: true };
  });
  if (!found) next.push({ id: key, disabled: true });
  return { ...base, servers: next };
}

// 纯函数：解除屏蔽（去掉 disabled）。若该条目去掉 disabled 后只剩一个 id（即它本来就只是
// 一枚屏蔽标记），整条移除，避免个人层里堆一串没有任何语义的空条目。
export function enableTeamServer(localConfig, id) {
  const key = assertServerId(id);
  const { base, servers } = splitLocalConfig(localConfig);
  const next = [];
  for (const s of servers) {
    if (!s || typeof s !== "object" || s.id !== key) {
      next.push(s);
      continue;
    }
    const rest = {};
    for (const [field, value] of Object.entries(s)) {
      if (field !== "disabled") rest[field] = value;
    }
    if (Object.keys(rest).length <= 1) continue; // 只剩 id：纯屏蔽标记，直接删掉
    next.push(rest);
  }
  return { ...base, servers: next };
}

// ---------------------------------------------------------------------------
// 个人层 config.local.json 的整份读写。writeActiveSelection 的落盘白名单刻意不含 servers
// （控制台只读原则），所以"个人服务器 / 屏蔽标记"这类结构化字段必须由向导自己原子写回。
// ---------------------------------------------------------------------------

// 文件不存在按空对象处理（新机器首次运行）；文件存在但不是合法 JSON 一律 throw ——
// 此时若按空对象继续写回，用户手编的个人配置会被静默清空。
export function readLocalConfigObject(localConfigPath) {
  let raw;
  try {
    raw = fs.readFileSync(localConfigPath, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`${localConfigPath} 不是合法 JSON（${err.message}）；为避免覆盖您的个人配置已中止写入，请先修复该文件再重跑向导`);
  }
}

// 个人层里这台服务器的内网直连名单（noProxyExtra，v2.57：登录引导测通的内网中转站）。
// 重跑集群侧受管配置时要带上，否则 env.sh 的 NO_PROXY 会被覆盖掉这些条目。读不到 / 形状不对按没有。
export function readNoProxyExtra(serverId, { localConfigPath = defaultLocalConfigPath(), readLocal = readLocalConfigObject } = {}) {
  try {
    return noProxyExtraFor(readLocal(localConfigPath), serverId);
  } catch {
    return [];
  }
}

// 整份原子写回（tmp+rename，失败清掉临时文件）。文件 0600，与 config-loader 的
// writeActiveSelection / writePersonalConfig 写同一个文件时的权限一致；chmodDir:false ——
// 开发模式下个人层就在仓库根，不去改已有目录的权限。
export function persistLocalConfig(localConfigPath, nextLocal, dryRun = DRY_RUN) {
  const body = `${JSON.stringify(nextLocal, null, 2)}\n`;
  if (dryRun) {
    dryRunLog(`atomic write ${localConfigPath}:\n${body}`);
    return;
  }
  writePrivateFileAtomicSync(localConfigPath, body, { chmodDir: false });
}

// 团队服务器步骤里"我不在这个集群"的落地动作：个人层写 { id, disabled: true }。
export function markTeamServerDisabled(serverId, { localConfigPath = defaultLocalConfigPath(), dryRun = DRY_RUN } = {}) {
  if (!serverId) return false;
  try {
    const next = disableTeamServer(readLocalConfigObject(localConfigPath), serverId);
    persistLocalConfig(localConfigPath, next, dryRun);
    logInfo(`已在个人层把 "${serverId}" 标记为屏蔽（disabled）：控制台不再展示它、不为它建隧道、也不再注册探针。`);
    logInfo(`恢复方式：重跑 npm run setup 并正常填写用户名，或手动删掉 ${localConfigPath} 中该条目的 "disabled": true。`);
    return true;
  } catch (err) {
    logError(`写入屏蔽标记失败: ${err.message}`);
    return false;
  }
}

// 团队服务器这次配通了：把上次留下的屏蔽标记撤掉（"重跑向导即可恢复"）。没有标记则什么都不做。
function clearTeamServerDisabled(serverId, { localConfigPath = defaultLocalConfigPath(), dryRun = DRY_RUN } = {}) {
  if (!serverId) return false;
  let current;
  try {
    current = readLocalConfigObject(localConfigPath);
  } catch (err) {
    logWarning(`读取个人层配置失败，跳过解除屏蔽: ${err.message}`);
    return false;
  }
  const entry = (Array.isArray(current.servers) ? current.servers : []).find((s) => s?.id === serverId);
  if (entry?.disabled !== true) return false;
  try {
    persistLocalConfig(localConfigPath, enableTeamServer(current, serverId), dryRun);
    logSuccess(`已解除对 "${serverId}" 的屏蔽（上次向导标记过 disabled）。`);
    return true;
  } catch (err) {
    logWarning(`解除屏蔽失败: ${err.message}`);
    return false;
  }
}

// 把本次配置使用的个人身份（用户名 + 当前激活服务器 + 若用了专属密钥则含其路径）写入个人层
// config.local.json 的 sshIdentityFile 字段（该字段已在 config-loader.mjs 的 PERSONAL_FIELDS
// 白名单中）。identityFile 缺省时不写该字段，保持旧行为（依赖默认密钥/ssh-agent）不变。
export function writePersonalIdentity(server, user, identityFile) {
  const localConfigPath = defaultLocalConfigPath();
  // 这台团队服务器这次配通了：撤掉上一轮"我不在这个集群"留下的 disabled 标记（先整份原子写回，
  // 再走 writeActiveSelection 的字段级 patch —— 两者都是同步读改写，不会互相覆盖）。
  clearTeamServerDisabled(server.id, { localConfigPath });
  const patch = buildPersonalIdentityPatch(server, user, identityFile);
  if (DRY_RUN) {
    dryRunLog(`write config.local.json ${JSON.stringify(patch)}`);
    return;
  }
  writeActiveSelection({ localConfigPath, patch });
  logSuccess(`已将个人身份写入 ${localConfigPath}`);
}
