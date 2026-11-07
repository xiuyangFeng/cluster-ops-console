import { readFileSync as fsRead } from "node:fs";

import { BASE_PORT_WRITE_MESSAGE, isBlockedBasePortWrite, previousPersonalRemotePorts } from "./config-loader.mjs";
import { writePersonalConfig as defaultWritePersonalConfig } from "./personal-config-write.mjs";
import {
  buildClaimCommand,
  buildRegistryAdminCommand,
  buildRegistrySurveyCommand,
  buildReleaseCommand,
  ownRegisteredPorts,
  parseClaimResult,
  parseRegistrySurvey,
  pickClaimCandidates,
  registeredOwnerOf,
  resolvePortRegistryDir,
} from "./port-registry.mjs";
import { assertSafeHost, assertSafePort, attachPersonalSsh, buildSshIdentityArgs, buildSshPortArgs, classifySshFailure } from "./ssh-args.mjs";
import { suggestReversePort } from "./reverse-port.mjs";
import { execFileWithTimeout } from "./exec.mjs";
import { buildHostKeyArgs } from "./host-key-policy.mjs";
import { createMemoryVault, isPersistedAuthRef } from "./credential-vault.mjs";
import { runWithPasswordSsh } from "./ssh-askpass.mjs";
import { statusError } from "./status-error.mjs";
import { summarizeServer } from "./servers/summary.mjs";
import { isOverrideOnly, sanitizeEntry, validateServerInput } from "./servers/validate.mjs";
import { isAuthRef, toPort } from "./validators.mjs";

const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_TTL_MS = 15 * 60 * 1000;

// 没能核对服务器上的端口占用时的统一提示（建议端口接口 / 新增表单共用）。
export const PORT_UNCHECKED_WARNING = "未核对服务器上的端口占用，请手动填写反向端口";
// 登记目录不可用、回落"只看监听"分配时的统一提示（返回里 registered:false 同时给出）。
export const PORT_UNREGISTERED_WARNING = "未登记：服务器上没有可用的端口登记目录，只按当前监听避开占用——对方离线时看不出占用，可能与他人撞端口";
export const PORT_REGISTRY_REQUIRED_MESSAGE = "端口登记目录不可用，已停止分配以避免与离线同事撞端口；请管理员先创建并设置为 1777";

export function createServerRegistry({
  localConfigPath,
  writePersonalConfigImpl = defaultWritePersonalConfig,
  readPersonalConfigImpl,
  getMergedConfig,
  refreshConfigIntoKernel,
  execFileImpl = execFileWithTimeout,
  audit = () => {},
  now = Date.now,
  fixtureMode = false,
  hostKeyStore = null,
  credentialVault = null,
  askpassDir = null,
} = {}) {
  const runtime = new Map();
  const secrets = new Map();
  const vault = credentialVault || createMemoryVault({ now });
  let mutationQueue = Promise.resolve();
  const serialize = (fn) => (...args) => {
    const result = mutationQueue.then(() => fn(...args));
    mutationQueue = result.catch(() => {});
    return result;
  };
  // 对外与 claimPort 共用的串行写入口（函数声明已提升）。
  const serializedUpdate = serialize((...args) => update(...args));

  function checkRevision(personal, expectedRevision) {
    if (expectedRevision != null && String(expectedRevision) !== String(personal.revision ?? 0)) {
      throw statusError("配置已被修改，请重新加载后保存", 409, { code: "revision-conflict" });
    }
  }

  function readPersonal() {
    if (typeof readPersonalConfigImpl === "function") return readPersonalConfigImpl() || {};
    try {
      return JSON.parse(fsRead(localConfigPath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return {};
      throw statusError("个人配置无法读取，请检查文件格式", 400, { code: "personal-config" });
    }
  }

  function merged() {
    return getMergedConfig?.() || { servers: [] };
  }

  function personalServers(personal = readPersonal()) {
    return Array.isArray(personal.servers) ? personal.servers : [];
  }

  function isTeam(server, personal = readPersonal()) {
    return Boolean(server) && (server.source === "team" || (server.source !== "personal"
      && !personalServers(personal).some((s) => s.id === server.id && !isOverrideOnly(s))));
  }

  function liveTombstones(personal = readPersonal()) {
    return rawLiveTombstones(personal)
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        removedAt: item.removedAt,
        tombstoneUntil: Number(item.removedAt || 0) + TOMBSTONE_TTL_MS,
        // 删除恢复仅在服务端需要快照；绝不通过 list API 返回凭据引用、身份文件或完整条目。
        canRestore: Boolean(item.snapshot),
      }));
  }

  function rawLiveTombstones(personal = readPersonal()) {
    const cutoff = now() - TOMBSTONE_TTL_MS;
    return (Array.isArray(personal._serverTombstones) ? personal._serverTombstones : [])
      .filter((item) => item && Number.isFinite(item.removedAt) && item.removedAt <= now() && item.removedAt > cutoff);
  }

  async function persist(patch) {
    const current = readPersonal();
    const nextPatch = {
      ...current,
      ...patch,
      expectedRevision: patch.expectedRevision ?? current.revision,
    };
    if (Array.isArray(nextPatch.servers)) nextPatch.servers = nextPatch.servers.map(sanitizeEntry);
    return await writePersonalConfigImpl({
      localConfigPath,
      patch: nextPatch,
      expectedRevision: patch.expectedRevision ?? current.revision,
      teamServerIds: (merged().servers || []).filter((s) => isTeam(s, current)).map((s) => s.id),
    });
  }

  function findMerged(id) {
    return (merged().servers || []).find((s) => s.id === id) || null;
  }

  function findPersonal(id, personal = readPersonal()) {
    return personalServers(personal).find((s) => s.id === id) || null;
  }

  async function refresh() {
    if (typeof refreshConfigIntoKernel === "function") {
      const applied = await refreshConfigIntoKernel();
      if (applied?._configLoadError || applied?._localConfigError) throw statusError("配置已保存，但重新加载失败；请检查配置后重试", 503, { code: "config-reload" });
    }
  }

  function list({ includeDisabled = true } = {}) {
    const personal = readPersonal();
    const servers = (merged().servers || [])
      .filter((s) => includeDisabled || s.disabled !== true)
      .map((s) => summarizeServer({ ...s, source: isTeam(s, personal) ? "team" : "personal" }, {
        runtime: runtime.get(s.id),
        revision: personal.revision,
        hostKeyConfirmed: hostKeyStore?.hasConfirmed?.(s.id) === true,
      }));
    return {
      schemaVersion: 1,
      revision: personal.revision ?? 0,
      servers,
      tombstones: liveTombstones(personal),
      // W5 追加字段：新增服务器表单的反向端口参考值（只凭本机已知配置，不发 SSH）。
      // 没核对远端监听 → 不是可直接采用的建议（checked=false + warning，前端不预填）。
      suggestedPorts: withUncheckedWarning(safeSuggest(merged())),
    };
  }

  function safeSuggest(config, options) {
    try { return suggestReversePort(config, options); } catch { return null; }
  }

  function withUncheckedWarning(suggested) {
    return suggested ? { ...suggested, checked: false, warning: PORT_UNCHECKED_WARNING } : null;
  }

  // 所有控制台发起的 SSH 都占调度器的并发槽（全局上限 3 是硬约束）。槽位函数由
  // 路由按请求传入（http-router 手里有 scheduler）。
  async function withSshSlot(host, acquire, fn) {
    const release = typeof acquire === "function" ? await acquire({ hostKey: host }) : null;
    try { return await fn(); }
    finally { if (typeof release === "function") release(); }
  }

  // 控制台一次性 SSH（端口探测 / 连接测试）的参数：8s 连接超时 + 该服务器的主机密钥策略。
  // usePassword 时放开 BatchMode 并允许一次密码提示（由 askpass 应答）。
  function oneShotSshArgs(id, identity, command, { usePassword = false } = {}) {
    const host = assertSafeHost(identity.host || identity.address);
    return {
      host,
      args: [
        "-o", usePassword ? "BatchMode=no" : "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        "-o", usePassword ? "NumberOfPasswordPrompts=1" : "NumberOfPasswordPrompts=0",
        ...((hostKeyStore && typeof hostKeyStore.buildArgs === "function") ? hostKeyStore.buildArgs(id) : buildHostKeyArgs()),
        ...buildSshPortArgs(identity.sshPort),
        ...buildSshIdentityArgs(identity),
        host,
        command,
      ],
    };
  }

  // 在该服务器上跑一条只读 / 领取脚本（BatchMode、占调度器 SSH 槽位）。返回 { ok, stdout, error }。
  async function runRemote(id, server, command, { acquireSshSlot, timeoutMs = 15000 } = {}) {
    try {
      const { host, args } = oneShotSshArgs(id, attachPersonalSsh(server, merged()), command);
      const result = await withSshSlot(host, acquireSshSlot, () => execFileImpl("ssh", args, { timeoutMs }));
      if (result && result.code === 0 && !result.timedOut) return { ok: true, stdout: result.stdout || "" };
      return { ok: false, error: classifySshFailure(`${result?.stderr || ""}`)?.code || (result?.timedOut ? "timeout" : "unknown") };
    } catch (err) {
      return { ok: false, error: classifySshFailure(String(err?.message || err))?.code || "unknown" };
    }
  }

  // 本机配置里其他服务器已写的反向端口（登记模式下也避开：同一台机器上自己的另一条隧道）。
  function configuredRemotePorts(config, excludeId) {
    return (config.servers || []).filter((s) => s && s.id !== excludeId).map((s) => toPort(s.remotePort)).filter((p) => p !== null);
  }

  // 一次 survey（port-registry.mjs：登记表 + 我是谁 + ss -ltn）→ 建议值。
  //   登记目录可用：优先沿用名下"没在监听、也不是出问题那个"的登记端口，否则取
  //     已登记 ∪ 监听 ∪ 本机配置 ∪ 当前端口 之外最小的端口（7891 永不是候选）；
  //   目录不存在 / 不可写：回落旧的 suggestReversePort（只看监听），registered:false 标明"未登记"；
  //   读不到登记信息（输出缺 REGISTRY 行）：不给建议——目录可能在，只是这次没读到。
  async function surveyForReassign(id, server, { acquireSshSlot } = {}) {
    const config = merged();
    const dir = resolvePortRegistryDir(config);
    if (!dir) {
      return { config, dir: null, probed: true, registry: "invalid", survey: null, picked: null, probeError: "invalid-registry-dir" };
    }
    const remote = await runRemote(id, server, buildRegistrySurveyCommand(dir), { acquireSshSlot });
    if (!remote.ok) return { config, dir, probed: false, probeError: remote.error };
    const survey = parseRegistrySurvey(remote.stdout);
    if (survey.registry === "unknown") return { config, dir, probed: false, probeError: "registry-unreadable" };
    const currentRemote = toPort(server.remotePort);
    const avoid = currentRemote ? [currentRemote] : [];
    if (survey.registry !== "ok") {
      const picked = safeSuggest(config, { excludeServerId: id, extraInUse: survey.listening, avoid });
      return { config, dir, survey, probed: true, registry: survey.registry, picked: picked ? { remotePort: picked.remotePort, mode: "legacy" } : null };
    }
    const reusable = ownRegisteredPorts(survey).filter((p) => p !== currentRemote && !survey.listening.includes(p));
    const reserved = [...configuredRemotePorts(config, id), ...avoid, ...(survey.rosterOtherPorts || [])];
    const rawCandidates = pickClaimCandidates({
      registered: survey.entries.map((e) => e.port),
      listening: survey.listening,
      reserved,
    });
    const rosterPort = toPort(survey.rosterAssignedPort);
    const canUseRoster = rosterPort !== null
      && rosterPort !== currentRemote
      && registeredOwnerOf(survey, rosterPort) === null
      && !survey.listening.includes(rosterPort)
      && !reserved.includes(rosterPort);
    const candidates = canUseRoster ? [rosterPort, ...rawCandidates.filter((p) => p !== rosterPort)] : rawCandidates;
    const port = reusable[0] ?? candidates[0];
    return {
      config, dir, survey, probed: true, registry: "ok", candidates,
      picked: port === undefined ? null : { remotePort: port, mode: reusable.length ? "reused" : "claim" },
    };
  }

  // W5：为已有服务器"重新分配反向端口"给出建议（端口被占时的 L2 处置第一步，只读）。
  // v2.54 终审：改走集群端口登记目录（survey），与向导同一把尺子；真正的领取在 claimPort（确认之后）。
  // 远端探测只走密钥/agent 认证（BatchMode）并占调度器 SSH 槽位；探测不到（密码认证/fixture/SSH 失败）时
  // **不给自动建议**（suggested=null + warning）。
  async function suggestPort(id, { acquireSshSlot } = {}) {
    const server = findMerged(id) || findPersonal(id);
    if (!server) throw statusError("服务器不存在", 404, { code: "not-found" });
    let outcome = { probed: false, probeError: null };
    if (fixtureMode) outcome.probeError = "fixture";
    else if (server.authRef) outcome.probeError = "password-auth";
    else outcome = await surveyForReassign(id, server, { acquireSshSlot });
    let suggested = null;
    if (outcome.probed) {
      if (outcome.config?.portRegistry?.required === true && outcome.registry !== "ok") {
        throw statusError(PORT_REGISTRY_REQUIRED_MESSAGE, 503, { code: "port-registry-required" });
      }
      if (!outcome.picked) throw statusError("反向端口段已无可用端口，请联系管理员", 409, { code: "port-exhausted" });
      // 只换远端端口：所有隧道共用同一个本机代理（端口取活跃服务器的 localPort），
      // 改 localPort 会连带重启本机代理、波及其它连接——这不是"只修这一条"该有的副作用。
      suggested = { remotePort: outcome.picked.remotePort };
    }
    const registered = outcome.probed ? outcome.registry === "ok" : null;
    return {
      serverId: id,
      current: { remotePort: server.remotePort ?? null, localPort: server.localPort ?? null },
      suggested,
      probed: outcome.probed,
      probeError: outcome.probeError ?? null,
      listening: outcome.survey?.listening || [],
      // 登记目录状态：ok | absent | readonly（未探测为 null）；registered=false 即"未登记"回落。
      registry: outcome.registry ?? null,
      registered,
      mode: outcome.picked?.mode ?? null,
      ...(registered === false ? { adminCommand: buildRegistryAdminCommand(outcome.dir, { state: outcome.registry }) } : {}),
      warning: !outcome.probed ? PORT_UNCHECKED_WARNING : registered ? null : PORT_UNREGISTERED_WARNING,
      revision: readPersonal().revision ?? 0,
      source: isTeam(server) ? "team" : "personal",
    };
  }

  // 确认后的"重新分配"：在该服务器上 survey + 原子领取（port-registry.mjs），领到的端口写个人配置。
  //   remotePort = 预览给出的建议值（优先领它；被人抢先时按候选顺延）。
  //   登记目录不可用 → 回落：核对该端口没在监听后直接写配置，返回 registered:false（"未登记"）。
  //   领到了却写配置失败（如 revision 冲突）→ 尽力释放刚领的登记文件，再把错误抛给调用方。
  async function claimPort(id, { remotePort, expectedRevision, acquireSshSlot } = {}) {
    const server = findMerged(id) || findPersonal(id);
    if (!server) throw statusError("服务器不存在", 404, { code: "not-found" });
    const wanted = toPort(remotePort);
    if (wanted === null) throw statusError("请提供要领取的反向端口", 400, { code: "schema" });
    if (isBlockedBasePortWrite(wanted, previousPersonalRemotePorts(readPersonal(), id))) {
      throw statusError(BASE_PORT_WRITE_MESSAGE, 400, { code: "reserved-port" });
    }
    if (fixtureMode) throw statusError("fixture 模式不发起真实 SSH", 409, { code: "fixture" });
    if (server.authRef) throw statusError("密码认证的服务器不支持后台领取端口，请在「设置 → 服务器」手动填写", 409, { code: "password-auth" });
    const outcome = await surveyForReassign(id, server, { acquireSshSlot });
    if (!outcome.probed) throw statusError(`无法读取服务器上的端口登记信息（${outcome.probeError}），未做任何改动`, 502, { code: "survey-failed" });
    if (outcome.config?.portRegistry?.required === true && outcome.registry !== "ok") {
      throw statusError(PORT_REGISTRY_REQUIRED_MESSAGE, 503, { code: "port-registry-required" });
    }
    const survey = outcome.survey;
    let port;
    let mode;
    if (outcome.registry === "ok") {
      const owner = registeredOwnerOf(survey, wanted);
      if (owner !== null && owner === survey.me) {
        port = wanted;
        mode = "reused";
      } else {
        const order = [wanted, ...outcome.candidates.filter((p) => p !== wanted)];
        // 选定端口已被别人登记 / 正在监听：不领它，直接从候选里领。
        const usable = owner === null && !survey.listening.includes(wanted) ? order : order.slice(1);
        if (!usable.length) throw statusError("反向端口段已无可用端口，请联系管理员", 409, { code: "port-exhausted" });
        const remote = await runRemote(id, server, buildClaimCommand(outcome.dir, usable), { acquireSshSlot });
        const result = parseClaimResult(remote.ok ? remote.stdout : "");
        if (result.status === "exhausted") throw statusError("候选端口在领取时全部被别人抢先登记，请稍后重试", 409, { code: "port-exhausted" });
        if (result.status !== "claimed") throw statusError(`在服务器上登记端口失败（${remote.error || result.status}），未做任何改动`, 502, { code: "claim-failed" });
        port = result.port;
        mode = "claimed";
      }
    } else {
      if (survey.listening.includes(wanted)) throw statusError(`端口 ${wanted} 正被服务器监听，请重新获取建议端口`, 409, { code: "port-in-use" });
      port = wanted;
      mode = "legacy";
    }
    let saved;
    try {
      // 内部已完成 survey + 原子领取；update 里的标记只在内存中传递，不会写进个人层。
      saved = await serializedUpdate(id, { remotePort: port, _portRegistryClaim: true, ...(expectedRevision == null ? {} : { expectedRevision }) });
    } catch (err) {
      if (mode === "claimed") await runRemote(id, server, buildReleaseCommand(outcome.dir, port), { acquireSshSlot }).catch(() => {});
      throw err;
    }
    audit({ action: "claim-port", serverId: id, result: "ok", fields: { remotePort: port, mode, registry: outcome.registry } });
    const registered = outcome.registry === "ok";
    return {
      serverId: id,
      remotePort: port,
      requested: wanted,
      mode,
      registry: outcome.registry,
      registered,
      ...(registered ? {} : { warning: PORT_UNREGISTERED_WARNING, adminCommand: buildRegistryAdminCommand(outcome.dir, { state: outcome.registry }) }),
      revision: saved?.revision ?? readPersonal().revision ?? 0,
    };
  }

  async function add(input) {
    if (input?.authRef) throw statusError("请通过凭据接口绑定密码引用", 400, { code: "credential-binding-required" });
    const value = validateServerInput(input, { now });
    const personal = readPersonal();
    checkRevision(personal, input?.expectedRevision);
    const existing = findPersonal(value.id, personal);
    if (existing) {
      const sameHost = (existing.host || existing.address) === value.host;
      const sameSubmittedFields = ["name", "sshPort", "sshUser", "sshIdentityFile", "remotePort", "localPort", "disabled", "tunnel"]
        .every((field) => input[field] === undefined || String(existing[field] ?? (field === "sshPort" ? 22 : "")) === String(value[field] ?? ""));
      if (sameHost && sameSubmittedFields) {
        audit({ action: "add", serverId: value.id, result: "ok", errorCode: "idempotent" });
        return summarizeServer({ ...existing, source: "personal" }, { runtime: runtime.get(value.id), revision: personal.revision });
      }
      throw statusError("该 id 已存在且配置不同，请编辑现有服务器或更换 id", 409, { code: "duplicate-id" });
    }
    if (isTeam(findMerged(value.id))) throw statusError("不能用团队服务器 id 新增个人条目，请换一个 id", 409, { code: "team-id" });
    if (rawLiveTombstones(personal).some((item) => item.id === value.id)) {
      throw statusError("该 id 仍在 7 天回收期内，请从回收站恢复或更换 id", 409, { code: "server-in-trash" });
    }
    const servers = [...personalServers(personal), value];
    const saved = await persist({ servers, expectedRevision: input?.expectedRevision ?? personal.revision ?? 0 });
    runtime.set(value.id, { state: value.disabled ? "disabled" : "configured" });
    await refresh();
    audit({ action: "add", serverId: value.id, result: "ok", fields: { sshIdentityFile: value.sshIdentityFile, authRef: value.authRef } });
    return summarizeServer({ ...value, source: "personal" }, { runtime: runtime.get(value.id), revision: saved.revision });
  }

  async function update(id, patch = {}) {
    const personal = readPersonal();
    checkRevision(personal, patch.expectedRevision);
    const current = findPersonal(id, personal);
    const mergedServer = findMerged(id);
    if (!current && !mergedServer) throw statusError("服务器不存在", 404, { code: "not-found" });
    if (Object.hasOwn(patch, "authRef") && patch.authRef !== current?.authRef) throw statusError("请通过凭据接口修改密码引用", 400, { code: "credential-binding-required" });
    const teamOverride = isTeam(mergedServer) && (!current || isOverrideOnly(current));
    if (teamOverride) {
      const formShaped = Boolean(patch.address || patch.host || patch.sshUser || patch.name);
      const allowed = { id };
      if (current && isOverrideOnly(current)) {
        if (current.disabled === true) allowed.disabled = true;
        if (current.tunnel === false) allowed.tunnel = false;
        if (current.remotePort != null && current.remotePort !== "") allowed.remotePort = current.remotePort;
        if (current.localPort != null && current.localPort !== "") allowed.localPort = current.localPort;
      }
      if (patch.disabled === true || patch.disabled === false || typeof patch.monitorEnabled === "boolean") allowed.disabled = patch.disabled === true || patch.monitorEnabled === false;
      if (patch.tunnel === true || patch.tunnel === false || patch.tunnelEnabled === true || patch.tunnelEnabled === false) {
        allowed.tunnel = patch.tunnel !== false && patch.tunnelEnabled !== false;
      }
      if (!formShaped && patch.remotePort !== undefined && patch.remotePort !== null && patch.remotePort !== "") {
        if (!patch._portRegistryClaim && merged()?.portRegistry?.required === true) {
          throw statusError("当前团队服务器必须通过「重新分配端口」完成登记，不能手动写入反向端口", 409, { code: "port-registry-required" });
        }
        allowed.remotePort = assertSafePort(patch.remotePort, "remotePort");
        if (isBlockedBasePortWrite(allowed.remotePort, previousPersonalRemotePorts(personal, id))) {
          throw statusError(BASE_PORT_WRITE_MESSAGE, 400, { code: "reserved-port" });
        }
      }
      if (!formShaped && patch.localPort !== undefined && patch.localPort !== null && patch.localPort !== "") {
        allowed.localPort = assertSafePort(patch.localPort, "localPort");
      }
      if (Object.keys(allowed).every((key) => key === "id")) {
        return summarizeServer({ ...mergedServer, ...current }, { runtime: runtime.get(id), revision: personal.revision });
      }
      const servers = [...personalServers(personal).filter((s) => s.id !== id), allowed];
      const saved = await persist({ servers, expectedRevision: patch.expectedRevision ?? personal.revision ?? 0 });
      runtime.delete(id);
      await refresh();
      audit({ action: "update", serverId: id, result: "ok" });
      return summarizeServer({ ...mergedServer, ...allowed }, { runtime: runtime.get(id), revision: saved.revision });
    }
    const next = validateServerInput({
      ...sanitizeEntry(current),
      ...patch,
      id,
      address: patch.address ?? patch.host ?? current.address ?? current.host,
      name: patch.name ?? current.name,
      sshUser: patch.sshUser ?? current.sshUser,
      tunnel: patch.tunnel ?? patch.tunnelEnabled ?? current.tunnel ?? true,
      disabled: patch.disabled ?? (typeof patch.monitorEnabled === "boolean" ? !patch.monitorEnabled : current.disabled),
    }, { legacy: current, now });
    const identityChanged = next.host !== (current.address || current.host)
      || String(next.sshPort || 22) !== String(current.sshPort || 22)
      || String(next.sshUser || "") !== String(current.sshUser || "");
    if (identityChanged) delete next.authRef;
    const servers = personalServers(personal).map((s) => (s.id === id ? { ...next, createdAt: current.createdAt || next.createdAt } : s));
    const saved = await persist({ servers, expectedRevision: patch.expectedRevision ?? personal.revision ?? 0 });
    runtime.delete(id);
    const cleanup = [];
    if (identityChanged) {
      cleanup.push(Promise.resolve().then(() => hostKeyStore?.clear?.(id)));
      const oldRefs = new Set([current.authRef, secrets.get(id)?.authRef].filter(Boolean));
      secrets.delete(id);
      for (const authRef of oldRefs) if (!servers.some((s) => s.authRef === authRef)) cleanup.push(Promise.resolve().then(() => vault.delete(authRef)));
    }
    // 清理失败也必须刷新已保存的安全配置；刷新失败也不能跳过旧凭据撤销。
    const applied = await Promise.allSettled([refresh(), ...cleanup]);
    const failure = applied.find((item) => item.status === "rejected");
    if (failure) throw statusError("配置已保存，但运行刷新或旧凭据清理失败，请检查后重试", 503, { code: "cleanup-pending" });
    audit({ action: "update", serverId: id, result: "ok" });
    return summarizeServer({ ...next, source: "personal" }, { runtime: runtime.get(id), revision: saved.revision });
  }

  async function disable(id, { disabled = true, expectedRevision } = {}) {
    const result = await update(id, { disabled, ...(expectedRevision == null ? {} : { expectedRevision }) });
    runtime.set(id, { ...(runtime.get(id) || {}), state: disabled ? "disabled" : "configured" });
    audit({ action: disabled ? "disable" : "enable", serverId: id, result: "ok" });
    return {
      ...result,
      state: disabled ? "disabled" : "configured",
      cleanup: {
        configUpdated: true,
        probes: "unregistered-on-reload",
        tunnels: "reconcile-on-reload",
      },
    };
  }

  async function remove(id, { expectedRevision } = {}) {
    const personal = readPersonal();
    checkRevision(personal, expectedRevision);
    const current = findPersonal(id, personal);
    const mergedServer = findMerged(id);
    if (!current && !mergedServer) throw statusError("服务器不存在", 404, { code: "not-found" });
    if (isTeam(mergedServer) && (!current || isOverrideOnly(current))) {
      const disabled = await disable(id, { disabled: true, expectedRevision });
      return { ...disabled, state: "disabled", note: "团队服务器只能屏蔽，不能删除团队条目" };
    }
    let nextRevision = expectedRevision;
    if (current && current.disabled !== true) {
      const disabled = await disable(id, { disabled: true, expectedRevision });
      nextRevision = disabled.revision;
    }
    const latest = readPersonal();
    const snapshot = sanitizeEntry(findPersonal(id, latest));
    const tombstones = [...rawLiveTombstones(latest).filter((item) => item.id !== id), {
      id,
      name: snapshot?.name || mergedServer?.name || id,
      host: snapshot?.host,
      sshUser: snapshot?.sshUser,
      authRef: snapshot?.authRef,
      removedAt: now(),
      snapshot,
    }];
    const servers = personalServers(latest).filter((s) => s.id !== id);
    const saved = await persist({ servers, _serverTombstones: tombstones, expectedRevision: nextRevision });
    runtime.delete(id);
    const secretRef = secrets.get(id)?.authRef;
    secrets.delete(id);
    const cleanup = [Promise.resolve().then(() => hostKeyStore?.clear?.(id))];
    for (const authRef of new Set([snapshot?.authRef, secretRef].filter(Boolean))) {
      const shared = servers.some((s) => s.authRef === authRef) || [...secrets.values()].some((s) => s.authRef === authRef);
      if (!shared) cleanup.push(Promise.resolve().then(() => vault.delete(authRef)));
    }
    const applied = await Promise.allSettled([refresh(), ...cleanup]);
    if (applied.some((item) => item.status === "rejected")) throw statusError("服务器条目已删除，但运行刷新或凭据清理失败", 503, { code: "cleanup-pending" });
    audit({ action: "remove", serverId: id, result: "ok", fields: { authRef: snapshot?.authRef } });
    return {
      id,
      state: "removed",
      revision: saved.revision,
      tombstoneUntil: now() + TOMBSTONE_TTL_MS,
      cleanup: {
        configUpdated: true,
        probes: "unregistered-on-reload",
        tunnels: "reconcile-on-reload",
        credentials: snapshot?.authRef ? "reference-cleared" : "none",
      },
    };
  }

  async function restore(id, { expectedRevision } = {}) {
    const personal = readPersonal();
    checkRevision(personal, expectedRevision);
    if (findPersonal(id, personal) || findMerged(id)) throw statusError("同 id 服务器已存在，不能覆盖恢复", 409, { code: "duplicate-id" });
    const tombstone = rawLiveTombstones(personal).find((item) => item.id === id);
    if (!tombstone?.snapshot) throw statusError("没有可恢复的删除记录", 404, { code: "no-tombstone" });
    const snapshot = { ...tombstone.snapshot, disabled: true, updatedAt: new Date(now()).toISOString() };
    let credentialStatus = snapshot.authRef ? "restored" : "none";
    if (snapshot.authRef) {
      const live = await vault.get(snapshot.authRef);
      if (!live) {
        delete snapshot.authRef;
        credentialStatus = "reenter-required";
      }
    }
    const servers = [...personalServers(personal), snapshot];
    const rawTombstones = rawLiveTombstones(personal).filter((item) => item.id !== id);
    const saved = await persist({ servers, _serverTombstones: rawTombstones, expectedRevision: expectedRevision ?? personal.revision ?? 0 });
    runtime.set(id, { state: "disabled" });
    await refresh();
    audit({ action: "restore", serverId: id, result: "ok" });
    return {
      ...summarizeServer({ ...snapshot, source: "personal" }, { runtime: runtime.get(id), revision: saved.revision }),
      credentialStatus,
    };
  }

  async function testConnection(id) {
    const server = findMerged(id) || findPersonal(id);
    if (!server) throw statusError("服务器不存在", 404, { code: "not-found" });
    const testState = { ...(runtime.get(id) || {}), state: "testing" };
    runtime.set(id, testState);
    if (fixtureMode) {
      const payload = {
        ok: false,
        code: "dns",
        nextAction: "fixture 模式不发起真实 SSH",
        checkedAt: new Date(now()).toISOString(),
      };
      runtime.set(id, { state: "offline", lastTest: payload });
      audit({ action: "test", serverId: id, result: "error", errorCode: "dns" });
      return payload;
    }
    const cached = secrets.get(id);
    if (cached?.expiresAt && cached.expiresAt <= now()) secrets.delete(id);
    const authRef = server.authRef || secrets.get(id)?.authRef;
    const password = authRef ? await vault.get(authRef) : (secrets.get(id)?.password || null);
    if (authRef && (!password || !askpassDir)) {
      const payload = { ok: false, code: "auth-required", nextAction: !password ? "密码会话已失效，请重新录入密码" : "密码连接服务不可用", checkedAt: new Date(now()).toISOString() };
      if (runtime.get(id) === testState) runtime.set(id, { state: "auth-required", lastTest: payload });
      audit({ action: "test", serverId: id, result: "error", errorCode: payload.code });
      return payload;
    }
    const identity = {
      host: server.host || server.address,
      sshUser: server.sshUser,
      sshIdentityFile: server.sshIdentityFile,
      sshPort: server.sshPort,
    };
    const usePassword = Boolean(password) && Boolean(askpassDir);
    // 连接测试只认条目自身的身份字段（不走 attachPersonalSsh 的全局回落）。
    const { args } = oneShotSshArgs(id, identity, "true", { usePassword });
    if (usePassword && JSON.stringify(args).includes(password)) {
      throw statusError("密码不得进入 SSH 参数", 500, { code: "secret-leak" });
    }
    let result;
    try {
      const options = { timeoutMs: 10000 };
      result = usePassword
        ? await runWithPasswordSsh({ password, helperDir: askpassDir, args, options, execFileImpl })
        : await execFileImpl("ssh", args, options);
    } catch (err) {
      result = { code: 1, stdout: "", stderr: String(err?.message || err), timedOut: false };
    }
    const text = `${result.stderr || ""} ${result.stdout || ""}`;
    const classified = classifySshFailure(text) || (result.timedOut ? { code: "timeout", nextAction: "连接超时" } : null);
    const ok = result.code === 0 && !result.timedOut;
    const payload = {
      ok,
      code: ok ? "ok" : (classified?.code || (result.timedOut ? "timeout" : "unknown")),
      nextAction: ok ? null : (classified?.nextAction || "检查地址、端口、用户名与密钥"),
      checkedAt: new Date(now()).toISOString(),
    };
    if (runtime.get(id) === testState) {
      runtime.set(id, { state: ok ? "online" : (payload.code === "auth" ? "auth-failed" : payload.code === "hostkey" ? "hostkey-required" : "offline"), lastTest: payload });
    }
    audit({ action: "test", serverId: id, result: ok ? "ok" : "error", errorCode: payload.code });
    return payload;
  }

  async function previewHostKey(id) {
    const server = findMerged(id) || findPersonal(id);
    if (!server) throw statusError("服务器不存在", 404, { code: "not-found" });
    if (!hostKeyStore) throw statusError("主机密钥服务不可用", 503, { code: "hostkey" });
    const pending = { ...(runtime.get(id) || {}), state: "hostkey-required" };
    runtime.set(id, pending);
    const result = await hostKeyStore.preview({
      host: server.host || server.address,
      sshPort: server.sshPort || 22,
      serverId: id,
    });
    if (runtime.get(id) !== pending) {
      hostKeyStore.clear?.(id);
      throw statusError("服务器配置已变化，请重新预览主机密钥", 409, { code: "hostkey-stale" });
    }
    runtime.set(id, { ...(runtime.get(id) || {}), state: "hostkey-required", lastHostKey: { fingerprints: result.fingerprints || [], checkedAt: new Date(now()).toISOString() } });
    audit({ action: "hostkey-preview", serverId: id, result: result.ok ? "ok" : "error", errorCode: result.code || null });
    return result;
  }

  function confirmHostKey(id, body = {}) {
    const server = findMerged(id) || findPersonal(id);
    if (!server) throw statusError("服务器不存在", 404, { code: "not-found" });
    if (!hostKeyStore) throw statusError("主机密钥服务不可用", 503, { code: "hostkey" });
    const saved = hostKeyStore.confirm(id, body);
    runtime.set(id, { ...(runtime.get(id) || {}), state: "configured", lastHostKey: { confirmedAt: new Date(now()).toISOString(), fingerprints: saved.fingerprints || [] } });
    audit({ action: "hostkey-confirm", serverId: id, result: "ok" });
    return { ...saved, state: "configured" };
  }

  async function putCredentials(id, { password, authRef: existingRef, expectedRevision } = {}) {
    if (!findMerged(id) && !findPersonal(id)) throw statusError("服务器不存在", 404, { code: "not-found" });
    const personal = readPersonal();
    checkRevision(personal, expectedRevision);
    const current = findPersonal(id, personal);
    if (!current || isTeam(findMerged(id), personal)) throw statusError("团队服务器凭据请通过 SSH 配置管理；新增个人服务器才能绑定密码", 400, { code: "team-credentials" });
    let stored;
    if (existingRef && !password) {
      if (!isAuthRef(existingRef)) throw statusError("无效凭据引用", 400, { code: "schema" });
      const live = await vault.get(existingRef);
      if (!live) throw statusError("凭据引用无效或已失效，请重新录入", 400, { code: "auth-missing" });
      stored = { authRef: existingRef, persisted: isPersistedAuthRef(existingRef) };
    } else {
      stored = await vault.put(password);
    }
    try {
      // Web 模式也持久化不含密码的 mem: 引用，供 supervisor 共享当前会话保管库。
      await persist({
        servers: personalServers(personal).map((item) => (item.id === id ? { ...item, authRef: stored.authRef, updatedAt: new Date(now()).toISOString() } : item)),
        expectedRevision: expectedRevision ?? personal.revision ?? 0,
      });
    } catch (err) {
      if (!existingRef) await vault.delete(stored.authRef).catch(() => {});
      throw err;
    }
    secrets.set(id, { authRef: stored.authRef, expiresAt: now() + SECRET_TTL_MS });
    runtime.delete(id);
    await refresh();
    if (current.authRef && current.authRef !== stored.authRef
      && !personalServers(personal).some((item) => item.id !== id && item.authRef === current.authRef)) await vault.delete(current.authRef);
    audit({ action: "credentials", serverId: id, result: "ok", fields: { authRef: stored.authRef } });
    return {
      authRef: stored.authRef,
      persisted: Boolean(stored.persisted || isPersistedAuthRef(stored.authRef)),
      expiresAt: stored.expiresAt || null,
    };
  }

  return {
    list,
    add: serialize(add),
    update: serializedUpdate,
    disable: serialize(disable),
    enable: serialize((id, options = {}) => disable(id, { ...options, disabled: false })),
    remove: serialize(remove),
    restore: serialize(restore),
    testConnection,
    suggestPort,
    // 领取走 SSH，不进写串行队列（避免一次 15s 的 SSH 卡住其它保存）；写配置那一步经 update 的串行包装。
    claimPort: (id, options) => claimPort(id, options),
    previewHostKey,
    confirmHostKey,
    putCredentials: serialize(putCredentials),
  };
}
