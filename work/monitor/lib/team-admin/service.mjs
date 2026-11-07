// 团队管理（Team Admin）后端业务服务：
//   - getAdminRole()：同步返回当前账号是否为管理员（供 /api/status 顶层 teamAdmin 字段使用）；
//   - getOverview({ serverId, force })：单次 SSH 聚合探测 + 自动投递本机待下发队列 + 融合 Slurm/GPU/用量数据；
//   - upsertMember / removeMember：维护集群 /public/agent-hub/admin/roster.json 名册与预分配端口；
//   - assignAiConfig / clearAssignment：用成员 X25519 公钥密封 AI 中转站 / API Key 写入 assigned/<user>.enc（无公钥时暂存本机 0600 队列）；
//   - releasePort：释放闲置端口登记文件。

import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// 单次批量纳管的人身上限（与前端 controller 的 TEAM_BATCH_MAX 对齐）。
// 超过时必须显式报错而不是静默截断：静默截断会让页面把「已将 N 位纳入名册」说成谎话。
export const TEAM_BATCH_MEMBER_MAX = 32;

import { writeFileAtomic } from "../atomic-file.mjs";
import { LoginError, normalizeApiLoginRequest } from "../cli/login-api.mjs";
import { REVERSE_PORT_BASE, REVERSE_PORT_SPAN } from "../reverse-port.mjs";
import { readSshConfigUser } from "../ssh-config-user.mjs";
import { statusError } from "../status-error.mjs";
import { toPort } from "../validators.mjs";
import {
  buildEnvelopePublicSummary,
  isValidPublicKey,
  sealAssignedPayload,
} from "./crypto-box.mjs";
import { buildTeamOverviewModel } from "./model.mjs";
import {
  assertSafeClusterUser,
  buildAdminKillPortCommand,
  buildAdminReleasePortCommand,
  buildAdminSurveyCommand,
  buildRemoveAssignedCommand,
  buildRemoveNoticeCommand,
  buildWriteAssignedCommand,
  buildWriteNoticeCommand,
  buildWriteRosterCommand,
  isAdminUser,
  isSafeClusterUser,
  parseAdminSurveyOutput,
  resolveAgentHubBaseDir,
  resolveEffectiveSshUser,
} from "./protocol.mjs";

const OVERVIEW_CACHE_TTL_MS = 10_000;
// 过了上面的新鲜期、但还不到这么久的采集结果：概览先拿它立刻回（checkedAt 写它真实的采集时间），后台再采一次。
// 页面每 25 秒轮询一次，所以以前几乎每次轮询、每次进页都要现等一次集群 ssh 采集（几百毫秒到几秒）。
const SURVEY_STALE_MAX_MS = 5 * 60_000;
const SSH_ADMIN_TIMEOUT_MS = 25_000;
const PENDING_MAX_BYTES = 256 * 1024;

function buildFixtureOverview({ serverId = "server-01", serverName = "主集群 (Fixture)", adminVersion = "2.67.0", nowMs = Date.now() } = {}) {
  const survey = {
    me: "kai",
    hubBase: "ok",
    hubOwner: "kai",
    dirs: {
      admin: { state: "ok", sticky: false },
      assigned: { state: "ok", sticky: false },
      ports: { state: "ok", sticky: true },
      pubkeys: { state: "ok", sticky: true },
      heartbeats: { state: "ok", sticky: true },
    },
    roster: {
      v: 1,
      updatedAt: new Date(nowMs - 3600_000).toISOString(),
      members: {
        kai: { displayName: "管理员 (kai)", note: "集群负责人", assignedPort: 7891, enabled: true },
        alice: { displayName: "Alice 张", note: "大模型训练组", assignedPort: 7892, enabled: true },
        bob: { displayName: "Bob 李", note: "多模态推理组", assignedPort: 7893, enabled: true },
      },
    },
    ports: [
      { port: 7891, owner: "kai", regular: true },
      { port: 7892, owner: "alice", regular: true },
    ],
    listening: [7891, 7892],
    pubkeys: {
      cy: "fixture-pub-cy",
      alice: "fixture-pub-alice",
    },
    assigned: {
      alice: {
        v: 1,
        rev: 2,
        assignedAt: new Date(nowMs - 7200_000).toISOString(),
        summary: {
          codex: { mode: "relay", baseUrl: "https://relay.team.example/v1", providerId: "team-relay", keyMask: "sk-t…99a1" },
          claude: { mode: "relay", baseUrl: "https://relay.team.example", keyMask: "sk-a…88b2" },
        },
      },
    },
    heartbeats: {
      kai: {
        v: 1,
        user: "kai",
        updatedAt: nowMs - 15_000,
        clientVersion: adminVersion,
        channel: "healthy",
        egress: { mode: "system", state: "healthy", reason: null, failuresTotal: 0 },
        cli: {
          codex: { installed: true, version: "0.42.0", login: "relay", loginDetail: "team-relay" },
          claude: { installed: true, version: "1.0.24", login: "api", loginDetail: "ANTHROPIC_API_KEY" },
        },
        usage: {
          todayCalls: 42,
          todayTokens: 1_280_000,
          todayErrors: 0,
          weekCalls: 310,
          weekTokens: 9_450_000,
          weekErrors: 2,
          topModel: "gpt-5.4",
          lastActiveAt: nowMs - 120_000,
        },
        disk: { scannedDirBytes: 48 * 1024 * 1024 * 1024, homeUsedKb: 512 * 1024 * 1024, homeCapacityPct: 45 },
        assignedAck: null,
      },
      alice: {
        v: 1,
        user: "alice",
        updatedAt: nowMs - 45_000,
        clientVersion: adminVersion,
        channel: "healthy",
        egress: { mode: "system", state: "healthy", reason: null, failuresTotal: 0 },
        cli: {
          codex: { installed: true, version: "0.42.0", login: "relay", loginDetail: "team-relay" },
          claude: { installed: true, version: "1.0.24", login: "relay", loginDetail: "relay.team.example" },
        },
        usage: {
          todayCalls: 28,
          todayTokens: 860_000,
          todayErrors: 1,
          weekCalls: 195,
          weekTokens: 6_120_000,
          weekErrors: 3,
          topModel: "claude-sonnet-4-6",
          lastActiveAt: nowMs - 300_000,
        },
        disk: { scannedDirBytes: 120 * 1024 * 1024 * 1024, homeUsedKb: 512 * 1024 * 1024, homeCapacityPct: 45 },
        assignedAck: {
          rev: 2,
          status: "applied",
          appliedAt: nowMs - 7000_000,
          message: "配置已生效",
        },
      },
    },
    spoofs: [],
    sshUsers: ["kai", "alice"],
    agentProcs: {
      kai: { codex: 1 },
      alice: { claude: 1 },
    },
  };
  return buildTeamOverviewModel({
    survey,
    resources: null,
    pendingAssignments: {},
    adminVersion,
    serverId,
    serverName,
    nowMs,
  });
}

function normalizeCliAssignmentInput(cli, input) {
  if (!input || typeof input !== "object" || input.mode === "keep" || input.mode === "none" || !input.mode) {
    return null;
  }
  const mode = String(input.mode).trim();
  if (mode === "revoke") {
    return { mode: "revoke" };
  }
  if (mode !== "relay" && mode !== "official") {
    throw statusError(`${cli} 不支持的配置模式: ${mode}`, 400, { code: "bad-mode" });
  }
  const method = mode === "official" ? "api" : "relay";
  try {
    const normalized = normalizeApiLoginRequest(cli, method, {
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      providerId: input.providerId || "team-relay",
      providerName: input.providerName || input.providerId || "Team Relay",
      acknowledgePlaintext: true,
    });
    if (mode === "official") {
      return {
        mode: "official",
        apiKey: normalized.apiKey,
      };
    }
    return {
      mode: "relay",
      apiKey: normalized.apiKey,
      baseUrl: normalized.relay.baseUrl,
      ...(cli === "codex"
        ? {
          providerId: normalized.providerId,
          providerName: normalized.providerName,
        }
        : {}),
    };
  } catch (err) {
    if (err instanceof LoginError) {
      throw statusError(`${cli === "codex" ? "Codex" : "Claude"}: ${err.message}`, 400, {
        code: err.code,
        field: err.field,
      });
    }
    throw err;
  }
}

export function createTeamAdminService({
  getConfig,
  getMergedConfig,
  runRemote,
  acquireSshSlot = null,
  getLayers = () => ({}),
  getSelfDirUsageBytes = async () => null,
  memberSync = null,
  pendingPath = null,
  version = "0.0.0",
  fixtureMode = false,
  resolveSshUser = readSshConfigUser,
  log = () => {},
  now = Date.now,
} = {}) {
  const surveyCache = new Map(); // serverId -> { at, survey }
  const surveyInflight = new Map(); // serverId -> Promise<survey>：同一台服务器同时只跑一次采集
  let pendingData = { schemaVersion: 1, items: {} };
  let pendingLoaded = false;
  let mutationQueue = Promise.resolve();

  const serialize = (fn) => (...args) => {
    const next = mutationQueue.then(() => fn(...args));
    mutationQueue = next.catch(() => {});
    return next;
  };

  async function loadPending() {
    if (pendingLoaded || !pendingPath) {
      pendingLoaded = true;
      return pendingData;
    }
    pendingLoaded = true;
    try {
      const st = await stat(pendingPath);
      if (st.size <= PENDING_MAX_BYTES) {
        const parsed = JSON.parse(await readFile(pendingPath, "utf8"));
        if (parsed && typeof parsed.items === "object" && !Array.isArray(parsed.items)) {
          pendingData = { schemaVersion: 1, items: parsed.items };
        }
      }
    } catch {}
    return pendingData;
  }

  async function savePending() {
    if (!pendingPath) return;
    try {
      await mkdir(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
      await writeFileAtomic(pendingPath, JSON.stringify(pendingData), { mode: 0o600 });
    } catch (err) {
      log(`team-admin save pending failed: ${err.message}`);
    }
  }

  function getAdminRole(configOverride = null) {
    const config = configOverride || getMergedConfig?.() || {};
    const servers = Array.isArray(config?.servers) ? config.servers.filter((s) => s && s.disabled !== true) : [];
    const active = servers.find((s) => s.id === config?.activeServerId) || servers[0] || null;
    const sshUser = resolveEffectiveSshUser(config, active, { resolveSshUser });
    const isAdmin = isAdminUser(config, sshUser);
    return {
      isAdmin,
      sshUser: sshUser || null,
      hubDir: resolveAgentHubBaseDir(config),
      adminUsers: Array.isArray(config?.adminUsers) ? config.adminUsers : [],
    };
  }

  async function resolveAdminContext(serverId) {
    const config = (await getConfig?.()) || getMergedConfig?.() || {};
    const servers = Array.isArray(config?.servers) ? config.servers.filter((s) => s && s.disabled !== true) : [];
    const wanted = serverId || config?.activeServerId;
    const server = (wanted ? servers.find((s) => s.id === wanted) : null)
      ?? (serverId ? null : servers.find((s) => s.id === "server-01") ?? servers[0]);
    if (!server) {
      throw statusError(serverId ? `没有找到服务器 ${serverId}` : "还没有可用的服务器", 404, { code: "no-server" });
    }
    const sshUser = resolveEffectiveSshUser(config, server, { resolveSshUser });
    if (!isAdminUser(config, sshUser)) {
      throw statusError(`当前账号 (${sshUser || "未配置"}) 不在团队管理员名单 (adminUsers) 中`, 403, { code: "forbidden" });
    }
    const hubDir = resolveAgentHubBaseDir(config);
    return { config, server, sshUser, hubDir };
  }

  async function remote(ctx, command, { input, timeoutMs = SSH_ADMIN_TIMEOUT_MS } = {}) {
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: ctx.server.host }) : null;
    try {
      return await runRemote(ctx.server, ctx.config, command, {
        timeoutMs,
        ...(input != null ? { input } : {}),
      });
    } finally {
      if (typeof release === "function") release();
    }
  }

  async function flushPendingDeliveries(ctx, survey) {
    await loadPending();
    if (survey?.dirs?.assigned?.state !== "ok") return false;
    let changed = false;
    for (const [user, item] of Object.entries(pendingData.items || {})) {
      const pubKey = survey.pubkeys?.[user];
      if (!isValidPublicKey(pubKey) || !item?.payload) continue;
      try {
        const envelope = sealAssignedPayload(item.payload, pubKey, {
          rev: Number(item.rev) || 1,
          assignedAt: item.assignedAt || new Date(now()).toISOString(),
        });
        const res = await remote(ctx, buildWriteAssignedCommand(ctx.hubDir, user), {
          input: JSON.stringify(envelope),
        });
        if (res?.code === 0 && String(res.stdout || "").includes("WRITE_ASSIGNED=ok")) {
          survey.assigned[user] = envelope;
          delete pendingData.items[user];
          changed = true;
          log(`team-admin: 已将暂存的 AI 配置自动加密投递给成员 ${user} (rev ${envelope.rev})`);
        }
      } catch (err) {
        log(`team-admin: 自动投递成员 ${user} 配置失败: ${err.message}`);
      }
    }
    if (changed) await savePending();
    return changed;
  }

  // 跑一次集群采集。并发调用共用进行中的那一次；fresh（写操作之后）必须另起一次——
  // 写之前就已经在跑的采集读不到刚写进去的东西。
  function runSurvey(ctx, { fresh = false } = {}) {
    const id = ctx.server.id;
    const running = surveyInflight.get(id);
    if (running && !fresh) return running;
    const job = (async () => {
      const res = await remote(ctx, buildAdminSurveyCommand(ctx.hubDir));
      if (res?.code !== 0) {
        throw statusError(`无法读取集群团队管理目录（SSH 退出码 ${res?.code ?? "未知"}）`, 502, { code: "ssh-failed" });
      }
      const survey = parseAdminSurveyOutput(res.stdout);
      await flushPendingDeliveries(ctx, survey);
      surveyCache.set(id, { at: now(), survey });
      return survey;
    })();
    surveyInflight.set(id, job);
    job.then(
      () => { if (surveyInflight.get(id) === job) surveyInflight.delete(id); },
      () => { if (surveyInflight.get(id) === job) surveyInflight.delete(id); },
    );
    return job;
  }

  async function fetchSurvey(ctx, { force = false } = {}) {
    const cached = surveyCache.get(ctx.server.id);
    if (!force && cached && (now() - cached.at < OVERVIEW_CACHE_TTL_MS)) {
      return cached.survey;
    }
    return runSurvey(ctx, { fresh: force });
  }

  // 概览用：返回 { survey, at }。新鲜期内直接用；过期但不太旧就先回旧的、后台再采；再旧或强制才现等。
  async function surveyForOverview(ctx, { force = false } = {}) {
    const cached = surveyCache.get(ctx.server.id);
    const age = cached ? now() - cached.at : Number.POSITIVE_INFINITY;
    if (!force && cached && age < OVERVIEW_CACHE_TTL_MS) return { survey: cached.survey, at: cached.at };
    if (!force && cached && age < SURVEY_STALE_MAX_MS) {
      runSurvey(ctx).catch((err) => log(`team-admin: 后台刷新团队采集失败: ${err.message}`));
      return { survey: cached.survey, at: cached.at };
    }
    const survey = await runSurvey(ctx, { fresh: force });
    return { survey, at: surveyCache.get(ctx.server.id)?.at ?? now() };
  }

  async function getOverview({ serverId = null, force = false } = {}) {
    const ctx = await resolveAdminContext(serverId);
    if (fixtureMode) {
      return buildFixtureOverview({
        serverId: ctx.server.id,
        serverName: ctx.server.name || ctx.server.id,
        adminVersion: version,
        nowMs: now(),
      });
    }
    await loadPending();
    const { survey, at: surveyAt } = await surveyForOverview(ctx, { force });
    let selfDirUsageBytes = null;
    try {
      selfDirUsageBytes = await getSelfDirUsageBytes(ctx.server.id);
    } catch {}
    const resources = getLayers()?.resources?.[ctx.server.id] || null;
    const overview = buildTeamOverviewModel({
      survey,
      resources,
      pendingAssignments: pendingData.items,
      adminVersion: version,
      serverId: ctx.server.id,
      serverName: ctx.server.name || ctx.server.id,
      hubDir: ctx.hubDir,
      selfDirUsageBytes,
      nowMs: now(),
    });
    // 「更新于」写集群采集的真实时间：先回旧数据时不把它说成刚刚
    overview.checkedAt = surveyAt;
    return overview;
  }

  const upsertMember = serialize(async ({ serverId = null, user, displayName = "", note = "", assignedPort = null, enabled = true, members: batch = null } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    const batchItems = Array.isArray(batch) && batch.length ? batch : null;
    if (batchItems && batchItems.length > TEAM_BATCH_MEMBER_MAX) {
      throw statusError(
        `单次最多批量纳管 ${TEAM_BATCH_MEMBER_MAX} 位成员（本次 ${batchItems.length} 位），请分批提交`,
        400,
        { code: "too-many-members", field: "members" },
      );
    }
    const rawItems = batchItems || [{ user, displayName, note, assignedPort, enabled }];
    const minPort = REVERSE_PORT_BASE;
    const maxPort = REVERSE_PORT_BASE + REVERSE_PORT_SPAN;
    const normalizedItems = [];
    const seenUsers = new Set();
    const seenPorts = new Map();

    for (const entry of rawItems) {
      if (!entry || !isSafeClusterUser(entry.user)) {
        throw statusError("请输入合法的集群账号名（字母、数字、下划线、点或连字符，1-32 位）", 400, { code: "bad-user", field: "user" });
      }
      const targetUser = assertSafeClusterUser(entry.user);
      if (seenUsers.has(targetUser)) {
        throw statusError(`账号 ${targetUser} 在本次提交中重复出现，请合并为一条`, 400, { code: "duplicate-user", field: "user" });
      }
      seenUsers.add(targetUser);
      let portVal = null;
      if (entry.assignedPort !== null && entry.assignedPort !== undefined && String(entry.assignedPort).trim() !== "") {
        portVal = toPort(entry.assignedPort);
        if (portVal === null || portVal < minPort || portVal > maxPort) {
          throw statusError(`预分配端口须在 ${minPort}–${maxPort} 区间内`, 400, { code: "bad-port", field: "assignedPort" });
        }
        if (seenPorts.has(portVal)) {
          throw statusError(`端口 ${portVal} 在本次提交中重复分配给 ${seenPorts.get(portVal)} 与 ${targetUser}`, 409, { code: "port-taken", field: "assignedPort" });
        }
        seenPorts.set(portVal, targetUser);
      }
      normalizedItems.push({
        targetUser,
        hasDisplayName: entry.displayName !== undefined,
        displayName: typeof entry.displayName === "string" ? entry.displayName.trim().slice(0, 64) : "",
        hasNote: entry.note !== undefined,
        note: typeof entry.note === "string" ? entry.note.trim().slice(0, 160) : "",
        hasAssignedPort: entry.assignedPort !== undefined,
        portVal,
        hasEnabled: entry.enabled !== undefined,
        enabled: entry.enabled !== false,
      });
    }

    if (fixtureMode) {
      return getOverview({ serverId: ctx.server.id, force: true });
    }

    const survey = await fetchSurvey(ctx, { force: true });
    if (survey.dirs?.admin?.state !== "ok") {
      throw statusError(
        `集群上的 ${ctx.hubDir}/admin 目录尚不可写，请先按页面顶部提示在服务器上执行初始化命令`,
        409,
        { code: "hub-not-ready" },
      );
    }

    const currentMembers = { ...(survey.roster?.members || {}) };
    const nowIso = new Date(now()).toISOString();
    for (const item of normalizedItems) {
      const existing = currentMembers[item.targetUser] || {};
      currentMembers[item.targetUser] = {
        ...existing,
        displayName: item.hasDisplayName ? item.displayName : (existing.displayName || ""),
        note: item.hasNote ? item.note : (existing.note || ""),
        assignedPort: item.hasAssignedPort ? item.portVal : (existing.assignedPort ?? null),
        enabled: item.hasEnabled ? item.enabled : existing.enabled !== false,
        updatedAt: nowIso,
      };
    }

    // 端口唯一性必须按「写入后的有效端口」校验，而不是只看请求里显式带的端口：
    // 否则批内「A 沿用名册旧端口 + B 显式抢同一端口」这种组合会两边都查不出来
    // （A 没带端口所以不进 seenPorts，B 又因为 A 在 seenUsers 里被豁免）。
    // 全部校验都发生在下面唯一的 roster 写入之前，任何一条不过就整体不落盘。
    for (const item of normalizedItems) {
      const effPort = toPort(currentMembers[item.targetUser]?.assignedPort);
      if (effPort === null) continue;
      for (const [otherUser, info] of Object.entries(currentMembers)) {
        if (otherUser !== item.targetUser && toPort(info?.assignedPort) === effPort) {
          throw statusError(`端口 ${effPort} 已在名册中预分配给 ${otherUser}，请换一个端口`, 409, { code: "port-taken", field: "assignedPort" });
        }
      }
      const regCollision = (survey.ports || []).find((p) => p.port === effPort && p.owner && p.owner !== item.targetUser);
      if (regCollision) {
        throw statusError(`端口 ${effPort} 已被 ${regCollision.owner} 在集群登记占用，请先释放或换一个端口`, 409, { code: "port-registered", field: "assignedPort" });
      }
    }

    const nextRoster = {
      v: 1,
      updatedAt: nowIso,
      members: currentMembers,
    };

    const writeRes = await remote(ctx, buildWriteRosterCommand(ctx.hubDir), {
      input: JSON.stringify(nextRoster, null, 2),
    });
    if (writeRes?.code !== 0 || !String(writeRes.stdout || "").includes("WRITE_ROSTER=ok")) {
      throw statusError("写入团队成员名册失败，请检查集群目录权限", 502, { code: "write-roster-failed" });
    }

    log(`team-admin: 已更新成员名册 ${normalizedItems.map((x) => `${x.targetUser}${x.portVal ? `:${x.portVal}` : ""}`).join(", ")}`);
    return getOverview({ serverId: ctx.server.id, force: true });
  });

  const removeMember = serialize(async ({ serverId = null, user, clearAssigned = false } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    if (!isSafeClusterUser(user)) {
      throw statusError("非法的集群账号名", 400, { code: "bad-user" });
    }
    const targetUser = assertSafeClusterUser(user);
    if (fixtureMode) {
      return getOverview({ serverId: ctx.server.id, force: true });
    }

    const survey = await fetchSurvey(ctx, { force: true });
    const currentMembers = { ...(survey.roster?.members || {}) };
    if (currentMembers[targetUser]) {
      delete currentMembers[targetUser];
      const nextRoster = {
        v: 1,
        updatedAt: new Date(now()).toISOString(),
        members: currentMembers,
      };
      const writeRes = await remote(ctx, buildWriteRosterCommand(ctx.hubDir), {
        input: JSON.stringify(nextRoster, null, 2),
      });
      if (writeRes?.code !== 0 || !String(writeRes.stdout || "").includes("WRITE_ROSTER=ok")) {
        throw statusError("更新团队成员名册失败", 502, { code: "write-roster-failed" });
      }
    }

    if (clearAssigned) {
      await loadPending();
      if (pendingData.items[targetUser]) {
        delete pendingData.items[targetUser];
        await savePending();
      }
      await remote(ctx, buildRemoveAssignedCommand(ctx.hubDir, targetUser));
    }

    log(`team-admin: 已从名册移除成员 ${targetUser}`);
    return getOverview({ serverId: ctx.server.id, force: true });
  });

  const assignAiConfig = serialize(async ({ serverId = null, user, users = null, codex = null, claude = null, removeEnvelope = false, clear = false } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    const rawUsers = Array.isArray(users) && users.length
      ? users
      : typeof user === "string" && user.includes(",")
        ? user.split(",").map((s) => s.trim()).filter(Boolean)
        : [user];
    if (!rawUsers.length || rawUsers.some((u) => !isSafeClusterUser(u))) {
      throw statusError("请输入合法的集群账号名", 400, { code: "bad-user", field: "user" });
    }
    const targetUsers = [...new Set(rawUsers.map(assertSafeClusterUser))].slice(0, 32);

    await loadPending();
    if (removeEnvelope || clear) {
      let pendingChanged = false;
      for (const targetUser of targetUsers) {
        if (pendingData.items[targetUser]) {
          delete pendingData.items[targetUser];
          pendingChanged = true;
        }
        if (!fixtureMode) {
          await remote(ctx, buildRemoveAssignedCommand(ctx.hubDir, targetUser));
        }
      }
      if (pendingChanged) await savePending();
      log(`team-admin: 已撤回成员 ${targetUsers.join(", ")} 的下发配置信封`);
      return {
        delivery: "removed",
        delivered: false,
        users: targetUsers,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }

    const codexSpec = normalizeCliAssignmentInput("codex", codex);
    const claudeSpec = normalizeCliAssignmentInput("claude", claude);
    if (!codexSpec && !claudeSpec) {
      throw statusError("请至少为 Codex 或 Claude Code 选择一项下发配置", 400, { code: "empty-assignment" });
    }

    if (fixtureMode) {
      return {
        delivery: "sealed",
        delivered: true,
        sealedCount: targetUsers.length,
        pendingCount: 0,
        users: targetUsers,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }

    const survey = await fetchSurvey(ctx, { force: true });
    const assignedAt = new Date(now()).toISOString();
    const payload = {
      ...(codexSpec ? { codex: codexSpec } : {}),
      ...(claudeSpec ? { claude: claudeSpec } : {}),
    };
    const publicSummary = buildEnvelopePublicSummary(payload);

    let sealedCount = 0;
    let pendingCount = 0;
    let lastRev = 1;
    let pendingChanged = false;
    let selfUpdated = false;

    for (const targetUser of targetUsers) {
      const prevEncRev = Number(survey.assigned?.[targetUser]?.rev) || 0;
      const prevPendingRev = Number(pendingData.items?.[targetUser]?.rev) || 0;
      const nextRev = Math.max(prevEncRev, prevPendingRev) + 1;
      lastRev = nextRev;
      const pubKey = survey.pubkeys?.[targetUser];

      if (isValidPublicKey(pubKey)) {
        if (survey.dirs?.assigned?.state !== "ok") {
          throw statusError(`集群上的 ${ctx.hubDir}/assigned 目录尚不可写，请先完成目录初始化`, 409, { code: "hub-not-ready" });
        }
        const envelope = sealAssignedPayload(payload, pubKey, { rev: nextRev, assignedAt });
        const res = await remote(ctx, buildWriteAssignedCommand(ctx.hubDir, targetUser), {
          input: JSON.stringify(envelope),
        });
        if (res?.code !== 0 || !String(res.stdout || "").includes("WRITE_ASSIGNED=ok")) {
          throw statusError(`向集群写入 ${targetUser} 的加密配置信封失败`, 502, { code: "write-assigned-failed" });
        }
        if (pendingData.items[targetUser]) {
          delete pendingData.items[targetUser];
          pendingChanged = true;
        }
        sealedCount += 1;
        log(`team-admin: 已加密下发 AI 配置给成员 ${targetUser} (rev ${nextRev})`);
        if (targetUser === survey.me) selfUpdated = true;
      } else {
        pendingData.items[targetUser] = {
          rev: nextRev,
          assignedAt,
          summary: publicSummary,
          payload,
        };
        pendingChanged = true;
        pendingCount += 1;
        log(`team-admin: 成员 ${targetUser} 尚未上报公钥，AI 配置已暂存本机队列 (rev ${nextRev})`);
      }
    }

    if (pendingChanged) await savePending();
    if (selfUpdated && memberSync?.syncNow) {
      await memberSync.syncNow({ serverId: ctx.server.id, forceApply: true }).catch(() => {});
    }

    return {
      delivery: sealedCount > 0 && pendingCount === 0 ? "sealed" : sealedCount > 0 ? "partial" : "pending-pubkey",
      delivered: sealedCount === targetUsers.length,
      sealedCount,
      pendingCount,
      users: targetUsers,
      rev: lastRev,
      overview: await getOverview({ serverId: ctx.server.id, force: true }),
    };
  });

  const publishNotice = serialize(async ({ serverId = null, text = "", level = "info", clear = false } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    const trimmed = typeof text === "string" ? text.trim().slice(0, 500) : "";
    const shouldClear = Boolean(clear) || !trimmed;
    if (fixtureMode) {
      return getOverview({ serverId: ctx.server.id, force: true });
    }
    if (shouldClear) {
      await remote(ctx, buildRemoveNoticeCommand(ctx.hubDir));
      log("team-admin: 已清除团队置顶公告");
      return getOverview({ serverId: ctx.server.id, force: true });
    }
    const survey = await fetchSurvey(ctx, { force: true });
    if (survey.dirs?.admin?.state !== "ok") {
      throw statusError(`集群上的 ${ctx.hubDir}/admin 目录尚不可写，请先完成目录初始化`, 409, { code: "hub-not-ready" });
    }
    const noticeObj = {
      v: 1,
      text: trimmed,
      level: ["info", "warn", "error"].includes(level) ? level : "info",
      updatedAt: new Date(now()).toISOString(),
      updatedBy: survey.me || ctx.sshUser || "admin",
    };
    const res = await remote(ctx, buildWriteNoticeCommand(ctx.hubDir), {
      input: JSON.stringify(noticeObj, null, 2),
    });
    if (res?.code !== 0 || !String(res.stdout || "").includes("WRITE_NOTICE=ok")) {
      throw statusError("写入团队置顶公告失败，请检查集群目录权限", 502, { code: "write-notice-failed" });
    }
    log(`team-admin: 已发布团队置顶公告 (${noticeObj.level})`);
    return getOverview({ serverId: ctx.server.id, force: true });
  });

  const releasePort = serialize(async ({ serverId = null, port } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    const p = toPort(port);
    if (p === null) {
      throw statusError("请输入合法的端口号", 400, { code: "bad-port" });
    }
    if (fixtureMode) {
      return {
        status: "ok",
        released: true,
        port: p,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }
    const res = await remote(ctx, buildAdminReleasePortCommand(ctx.hubDir, p));
    const stdout = String(res?.stdout || "");
    if (stdout.includes("RELEASE=ok") || stdout.includes("RELEASE=absent")) {
      log(`team-admin: 已释放端口登记 ${p}`);
      return {
        status: "ok",
        released: true,
        port: p,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }
    if (stdout.includes("RELEASE=need-sudo")) {
      const cmd = `sudo rm -f ${ctx.hubDir}/ports/${p}`;
      return {
        status: "need-sudo",
        released: false,
        port: p,
        command: cmd,
        sudoCommand: cmd,
        message: `端口登记目录启用了 1777 粘滞位保护，非本人文件需先完成 Root 赋权或在集群执行：${cmd}`,
        overview: await getOverview({ serverId: ctx.server.id, force: false }),
      };
    }
    throw statusError(`释放端口 ${p} 失败`, 502, { code: "release-failed" });
  });

  const killPort = serialize(async ({ serverId = null, port } = {}) => {
    const ctx = await resolveAdminContext(serverId);
    const p = toPort(port);
    if (p === null || p < REVERSE_PORT_BASE || p > REVERSE_PORT_BASE + REVERSE_PORT_SPAN) {
      throw statusError(`请输入合法的反向隧道端口号（${REVERSE_PORT_BASE}~${REVERSE_PORT_BASE + REVERSE_PORT_SPAN}）`, 400, { code: "bad-port" });
    }
    if (fixtureMode) {
      return {
        status: "ok",
        killed: true,
        port: p,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }
    const res = await remote(ctx, buildAdminKillPortCommand(ctx.hubDir, p));
    const stdout = String(res?.stdout || "");
    if (stdout.includes("KILL_PORT=ok")) {
      log(`team-admin: 已强行终止占用端口 :${p} 的远端隧道进程`);
      return {
        status: "ok",
        killed: true,
        port: p,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }
    if (stdout.includes("KILL_PORT=no-listener")) {
      return {
        status: "no-listener",
        killed: false,
        port: p,
        message: `端口 :${p} 当前没有监听中的进程。`,
        overview: await getOverview({ serverId: ctx.server.id, force: true }),
      };
    }
    const cmd = `sudo fuser -k -TERM ${p}/tcp`;
    return {
      status: "need-sudo",
      killed: false,
      port: p,
      sudoCommand: cmd,
      message: `跨用户终止端口 :${p} 的僵尸隧道进程需先点击顶部「🔑 Root 赋权」完成一次性授权，或在集群 root 下执行：${cmd}`,
      overview: await getOverview({ serverId: ctx.server.id, force: false }),
    };
  });

  return {
    getAdminRole,
    getOverview,
    upsertMember,
    removeMember,
    assignAiConfig,
    publishNotice,
    releasePort,
    killPort,
  };
}
