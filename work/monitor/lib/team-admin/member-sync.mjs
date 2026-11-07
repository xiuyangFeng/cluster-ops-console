// 团队成员端后台同步器（Team Member Sync）：
// 1. 定期（默认 5 分钟）或手动触发，经单次只读 SSH 拉取集群共享目录 /public/agent-hub 下与本人相关的状态：
//    - ~/.config/cluster-workbench/box.key（本人 X25519 私钥）
//    - /public/agent-hub/pubkeys/<me>.pub（本人公开加密公钥）
//    - /public/agent-hub/assigned/<me>.enc（管理员加密下发的 AI 中转站 / API Key 信封）
// 2. 若集群侧尚未生成 box.key 或公钥不匹配，自动生成/推导 X25519 密钥对并发布公钥到 pubkeys/<me>.pub；
// 3. 若发现新的 assigned/<me>.enc（rev > 本机已应用 rev，或手动强制重应用），用本人私钥解密信封，
//    复用 login-api.mjs 的 normalizeApiLoginRequest + runApiLogin 自动配置集群侧 ~/.codex/config.toml、
//    keys/*.env、~/.claude/settings.json 以及本机代理白名单 / NO_PROXY，并记录回执 assignedAck；
// 4. 汇总本机工作台版本、隧道与出网健康、CLI 登录态、今日/近 7 天 Token 用量、存储占用及 assignedAck，
//    原子写入 /public/agent-hub/heartbeats/<me>.json（<= 8KB），供管理员大盘单次 SSH 聚合查看。

import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { noProxyExtraFor } from "../cluster-env.mjs";
import { normalizeApiLoginRequest, resetCodexDefaultProvider, runApiLogin } from "../cli/login-api.mjs";
import {
  buildInspectCommand,
  buildReplaceFileCommand,
  CLAUDE_SETTINGS_FILE,
  CODEX_CONFIG_FILE,
  parseInspectOutput,
  planClaudeApiSettings,
} from "../cli/login-flows.mjs";
import { parseAllowlistEntry } from "../proxy/address.mjs";
import { AGENT_IDS } from "../usage/model.mjs";
import { toPort } from "../validators.mjs";
import {
  derivePublicKeyFromPrivate,
  generateMemberKeyPair,
  isValidPrivateKey,
  openAssignedEnvelope,
} from "./crypto-box.mjs";
import {
  buildMemberSyncReadCommand,
  buildMemberSyncWriteCommand,
  parseMemberSyncReadOutput,
  resolveAgentHubBaseDir,
} from "./protocol.mjs";

export const DEFAULT_MEMBER_SYNC_INTERVAL_MS = 5 * 60_000;
export const INITIAL_MEMBER_SYNC_DELAY_MS = 8_000;
const ERROR_RETRY_COOLDOWN_MS = 10 * 60_000;
const STATE_MAX_BYTES = 64 * 1024;
const SSH_SYNC_TIMEOUT_MS = 25_000;

// 纯函数：从 usageService.summary({ range: 7 }) 提炼心跳所需的精简 AI 用量统计（字段名与 model.mjs 对齐）
export function extractUsageForHeartbeat(summary7d) {
  if (!summary7d || typeof summary7d !== "object") return null;
  const todayKey = summary7d.today || "";
  const buckets = Array.isArray(summary7d.trend?.buckets) ? summary7d.trend.buckets : [];
  const todayBucket = buckets.find((b) => b && b.key === todayKey) || null;
  const calToday = summary7d.calendar?.[todayKey] || null;
  const sumBucketTokens = (b) => b ? AGENT_IDS.reduce((acc, id) => acc + (Number(b[id]) || 0), 0) : 0;
  const todayTokens = todayBucket
    ? sumBucketTokens(todayBucket)
    : Number(calToday?.tokens) || 0;
  const todayCalls = todayBucket ? Number(todayBucket.calls) || 0 : Number(calToday?.calls) || 0;
  const todayErrors = todayBucket ? Number(todayBucket.errors) || 0 : 0;
  const codexTokens7d = buckets.reduce((sum, b) => sum + (Number(b?.codex) || 0), 0);
  const claudeTokens7d = buckets.reduce((sum, b) => sum + (Number(b?.claude) || 0), 0);
  const allBucketTokens7d = buckets.reduce((sum, b) => sum + sumBucketTokens(b), 0);
  const weekTokens = Number(summary7d.kpis?.total) || allBucketTokens7d || (codexTokens7d + claudeTokens7d);
  const weekCalls = Number(summary7d.kpis?.calls) || 0;
  const weekErrors = Number(summary7d.kpis?.errors) || 0;
  const weekCostUsd = Math.round((Number(summary7d.kpis?.costUsd) || 0) * 10000) / 10000;
  const todayCostUsd = weekTokens > 0 && weekCostUsd > 0
    ? Math.round((weekCostUsd * Math.min(1, todayTokens / weekTokens)) * 10000) / 10000
    : 0;

  const modelTotals = new Map();
  let lastActiveAt = null;
  for (const s of Array.isArray(summary7d.sessions) ? summary7d.sessions : []) {
    if (s?.model && Number(s?.stats?.total) > 0) {
      modelTotals.set(s.model, (modelTotals.get(s.model) || 0) + Number(s.stats.total));
    }
    const lastSec = Number(s?.lastAt ?? s?.lastSec);
    if (Number.isFinite(lastSec) && lastSec > 0) {
      const ms = Math.round(lastSec * 1000);
      if (lastActiveAt === null || ms > lastActiveAt) lastActiveAt = ms;
    }
  }
  let topModel = null;
  let topModelTokens = 0;
  for (const [model, total] of modelTotals.entries()) {
    if (total > topModelTokens) {
      topModel = model;
      topModelTokens = total;
    }
  }

  return {
    todayCalls,
    todayTokens,
    todayErrors,
    todayCostUsd,
    weekCalls,
    weekTokens,
    weekErrors,
    weekCostUsd,
    codexTokens7d,
    claudeTokens7d,
    topModel,
    lastActiveAt,
  };
}

// 纯函数：从 toolkit.cli.getSnapshot(serverId) 提炼 CLI 安装与登录态摘要
export function extractCliForHeartbeat(cliSnapshot) {
  const clis = cliSnapshot?.clis;
  if (!clis || typeof clis !== "object") return null;
  const mapOne = (item) => {
    if (!item || typeof item !== "object") return null;
    return {
      installed: Boolean(item.installed),
      version: item.version ? String(item.version).slice(0, 64) : null,
      login: item.login ? String(item.login).slice(0, 32) : null,
      loginDetail: item.loginDetail ? String(item.loginDetail).slice(0, 64) : null,
    };
  };
  return {
    codex: mapOne(clis.codex),
    claude: mapOne(clis.claude),
  };
}

// 纯函数：从 resources 层与 dirUsage 提炼本人存储占用摘要（字段名与 model.mjs 的 hb.disk 对齐）
export function extractDiskForHeartbeat(serverResource, scannedDirBytes = null) {
  const fsInfo = serverResource?.filesystem || serverResource?.disk || null;
  const homeUsedKb = Number(fsInfo?.usedKb) > 0
    ? Number(fsInfo.usedKb)
    : Number(fsInfo?.usedBytes) > 0
      ? Math.round(Number(fsInfo.usedBytes) / 1024)
      : null;
  const homeCapacityPct = Number.isFinite(Number(fsInfo?.capacityPct ?? fsInfo?.usePercent))
    ? Number(fsInfo.capacityPct ?? fsInfo.usePercent)
    : null;
  const dirBytes = Number(scannedDirBytes) > 0 ? Number(scannedDirBytes) : null;
  if (homeUsedKb === null && homeCapacityPct === null && dirBytes === null) return null;
  return {
    scannedDirBytes: dirBytes,
    homeUsedKb,
    homeCapacityPct,
  };
}

export function createTeamMemberSync({
  getConfig,
  getPersonalConfig = () => ({}),
  savePersonalConfig = async () => {},
  refreshConfigIntoKernel = async () => {},
  runRemote,
  acquireSshSlot = null,
  getEnvCredential = async () => null,
  onLoginChanged = () => {},
  getStatus = () => ({}),
  getLayers = () => ({}),
  getEgressSnapshot = () => null,
  getCliSnapshot = () => null,
  getUsageSummary = async () => null,
  getSelfDirUsageBytes = async () => null,
  version = "0.0.0",
  statePath = null,
  fixtureMode = false,
  intervalMs = DEFAULT_MEMBER_SYNC_INTERVAL_MS,
  initialDelayMs = INITIAL_MEMBER_SYNC_DELAY_MS,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const inFlight = new Map(); // serverId -> Promise
  const lastSyncByServer = new Map(); // serverId -> { at, ok, me, hub, ack, error }
  let localState = { servers: {} };
  let stateLoaded = false;
  let timer = null;
  let initialTimer = null;

  async function loadLocalState() {
    if (stateLoaded || !statePath) {
      stateLoaded = true;
      return localState;
    }
    stateLoaded = true;
    try {
      const st = await stat(statePath);
      if (st.size <= STATE_MAX_BYTES) {
        const parsed = JSON.parse(await readFile(statePath, "utf8"));
        if (parsed && typeof parsed.servers === "object" && !Array.isArray(parsed.servers)) {
          localState = { servers: parsed.servers };
        }
      }
    } catch {}
    return localState;
  }

  async function saveLocalState() {
    if (!statePath) return;
    try {
      await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
      await writeFileAtomic(statePath, JSON.stringify(localState), { mode: 0o600 });
    } catch (err) {
      log(`team-member-sync save state failed: ${err.message}`);
    }
  }

  async function remote(server, config, command, { input, timeoutMs = SSH_SYNC_TIMEOUT_MS } = {}) {
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: server.host }) : null;
    try {
      return await runRemote(server, config, command, {
        timeoutMs,
        ...(input != null ? { input } : {}),
      });
    } finally {
      if (typeof release === "function") release();
    }
  }

  function buildLoginDeps(server, config) {
    const port = toPort(server.remotePort);
    return {
      port,
      runRemote: (command, opts) => remote(server, config, command, opts),
      getEnvCredential: () => getEnvCredential(server.id),
      getNoProxyExtra: () => noProxyExtraFor(getPersonalConfig() || {}, server.id),
      saveNoProxyExtra: async (list) => {
        const personal = getPersonalConfig() || {};
        const map = personal.noProxyExtra && typeof personal.noProxyExtra === "object" && !Array.isArray(personal.noProxyExtra)
          ? personal.noProxyExtra
          : {};
        await savePersonalConfig({ noProxyExtra: { ...map, [server.id]: list }, expectedRevision: personal.revision ?? 0 });
        await refreshConfigIntoKernel();
      },
      addAllowlistEntry: async (entry) => {
        const personal = getPersonalConfig() || {};
        const current = (Array.isArray(personal.proxyAllowedTargets) ? personal.proxyAllowedTargets : [])
          .map((raw) => parseAllowlistEntry(raw).entry)
          .filter(Boolean);
        if (current.includes(entry)) return { added: false };
        await savePersonalConfig({ proxyAllowedTargets: [...current, entry], expectedRevision: personal.revision ?? 0 });
        await refreshConfigIntoKernel();
        return { added: true };
      },
      sleep,
      phase: () => {},
    };
  }

  async function revokeCliConfig(cli, deps) {
    if (cli === "codex") {
      const res = await deps.runRemote(buildInspectCommand({ cli: "codex", port: deps.port, file: CODEX_CONFIG_FILE }));
      const parsed = res?.code === 0 ? parseInspectOutput(res.stdout) : null;
      if (parsed?.file) {
        await resetCodexDefaultProvider(deps, parsed.file);
      }
      return "Codex 已取消管理员中转站默认设置";
    }
    if (cli === "claude") {
      const res = await deps.runRemote(buildInspectCommand({ cli: "claude", port: deps.port, file: CLAUDE_SETTINGS_FILE }));
      const parsed = res?.code === 0 ? parseInspectOutput(res.stdout) : null;
      const plan = planClaudeApiSettings(parsed?.file ?? "", { port: deps.port, mode: "clear" });
      if (plan.action === "write") {
        await deps.runRemote(
          buildReplaceFileCommand(CLAUDE_SETTINGS_FILE, Buffer.byteLength(plan.text, "utf8"), { chmod600: true }),
          { input: plan.text },
        );
      }
      return "Claude Code 已清除管理员下发的 API Key";
    }
    return "";
  }

  async function applyAssignedEnvelope({ server, config, privateKey, envelope }) {
    const rev = Number(envelope?.rev);
    let payload;
    try {
      payload = openAssignedEnvelope(envelope, privateKey);
    } catch (err) {
      return {
        rev,
        status: "error",
        appliedAt: now(),
        message: `解密下发配置失败：${err.message}`,
      };
    }

    const deps = buildLoginDeps(server, config);
    const notes = [];
    const errors = [];

    for (const cli of ["codex", "claude"]) {
      const spec = payload?.[cli];
      if (!spec || typeof spec !== "object") continue;
      if (spec.mode === "revoke") {
        try {
          const msg = await revokeCliConfig(cli, deps);
          if (msg) notes.push(msg);
          try {
            onLoginChanged({ serverId: server.id, cli });
          } catch {}
        } catch (err) {
          errors.push(`${cli}: ${err.message}`);
        }
        continue;
      }
      const method = spec.mode === "official" || spec.method === "api" ? "api" : "relay";
      try {
        const req = normalizeApiLoginRequest(cli, method, {
          apiKey: spec.apiKey,
          baseUrl: spec.baseUrl,
          providerId: spec.providerId || "team-relay",
          providerName: spec.providerName || spec.providerId || "Team Relay",
          acknowledgePlaintext: true,
        });
        const out = await runApiLogin(req, deps);
        notes.push(out.message || `${cli} 配置已生效`);
        try {
          onLoginChanged({ serverId: server.id, cli });
        } catch {}
      } catch (err) {
        errors.push(`${cli === "codex" ? "Codex" : "Claude"}: ${err.message}`);
      }
    }

    return {
      rev,
      status: errors.length > 0 ? "error" : "applied",
      appliedAt: now(),
      message: errors.length > 0 ? errors.join("；") : (notes.join("；") || "配置已生效"),
    };
  }

  async function doSyncServer(server, config, { forceApply = false } = {}) {
    await loadLocalState();
    const hubDir = resolveAgentHubBaseDir(config);
    if (!hubDir) return { ok: false, error: "invalid-hub-dir" };

    const readRes = await remote(server, config, buildMemberSyncReadCommand(hubDir));
    if (readRes?.code !== 0) {
      const errText = `SSH 读取失败 (code ${readRes?.code ?? "unknown"})`;
      lastSyncByServer.set(server.id, { at: now(), ok: false, error: errText });
      return { ok: false, error: errText };
    }

    const readParsed = parseMemberSyncReadOutput(readRes.stdout);
    const { me, hub } = readParsed;
    if (!me) {
      lastSyncByServer.set(server.id, { at: now(), ok: false, error: "missing-user" });
      return { ok: false, error: "missing-user" };
    }
    if (hub !== "present") {
      const info = { at: now(), ok: true, me, hub, ack: localState.servers[server.id] || null };
      lastSyncByServer.set(server.id, info);
      return info;
    }

    // 1. 准备成员端 X25519 密钥对（私钥存集群 ~/.config/cluster-workbench/box.key，公钥发 /public/agent-hub/pubkeys/<me>.pub）
    let privateKey = null;
    let publicKey = null;
    let needWriteBoxKey = false;
    if (isValidPrivateKey(readParsed.boxKey)) {
      privateKey = readParsed.boxKey.trim();
      publicKey = derivePublicKeyFromPrivate(privateKey);
    }
    if (!privateKey || !publicKey) {
      const pair = generateMemberKeyPair();
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      needWriteBoxKey = true;
    }
    const needWritePubKey = readParsed.pubKey !== publicKey;

    // 2. 检查是否有管理员下发的配置需要解密应用
    let ack = localState.servers[server.id] || null;
    const envelope = readParsed.assignedEnvelope;
    if (envelope && Number.isInteger(Number(envelope.rev)) && Number(envelope.rev) > 0) {
      const envRev = Number(envelope.rev);
      const prevRev = Number(ack?.rev) || 0;
      const prevAtMs = Number(ack?.appliedAt) || 0;
      const shouldRetryError = ack?.status === "error" && (now() - prevAtMs >= ERROR_RETRY_COOLDOWN_MS);
      if (forceApply || envRev > prevRev || (envRev === prevRev && shouldRetryError)) {
        ack = await applyAssignedEnvelope({
          server,
          config,
          privateKey,
          envelope,
        });
        localState.servers[server.id] = ack;
        await saveLocalState();
      }
    }

    // 3. 汇总本机状态，组装 heartbeat（字段与 model.mjs 对齐）
    const status = getStatus() || {};
    const layers = getLayers() || {};
    const egressSnap = getEgressSnapshot?.() || null;
    const cliSnap = getCliSnapshot?.(server.id) || null;
    let usageSummary = null;
    try {
      usageSummary = await getUsageSummary(server.id);
    } catch {}
    let selfDirBytes = null;
    try {
      selfDirBytes = await getSelfDirUsageBytes(server.id);
    } catch {}
    const serverRes = layers.resources?.[server.id] || null;

    const heartbeat = {
      v: 1,
      user: me,
      serverId: server.id,
      updatedAt: now(),
      clientVersion: version,
      channel: status.overall || "unknown",
      remotePort: toPort(server.remotePort),
      egress: egressSnap
        ? {
          mode: egressSnap.mode || null,
          state: egressSnap.state || "unknown",
          reason: egressSnap.reason || null,
          failuresTotal: Number(egressSnap.failures?.total) || 0,
        }
        : null,
      cli: extractCliForHeartbeat(cliSnap),
      usage: extractUsageForHeartbeat(usageSummary),
      disk: extractDiskForHeartbeat(serverRes, selfDirBytes),
      assignedAck: ack,
    };

    const writeCmd = buildMemberSyncWriteCommand(hubDir, {
      privateKey: needWriteBoxKey ? privateKey : null,
      publicKey: needWritePubKey || needWriteBoxKey ? publicKey : null,
    });
    const writeRes = await remote(server, config, writeCmd, {
      input: JSON.stringify(heartbeat),
    });
    const stdout = String(writeRes?.stdout || "");
    const ok = writeRes?.code === 0 && (stdout.includes("HB_WRITE=ok") || stdout.includes("HB_WRITE=skipped"));
    const info = {
      at: now(),
      ok,
      me,
      hub,
      ack,
      notice: readParsed.notice || null,
      ...(ok ? {} : { error: `写入心跳失败 (${writeRes?.code ?? "unknown"})` }),
    };
    lastSyncByServer.set(server.id, info);
    return info;
  }

  function syncServer(server, config, options = {}) {
    if (!server?.id) return Promise.resolve({ ok: false, error: "no-server" });
    const existing = inFlight.get(server.id);
    if (existing && !options.forceApply) return existing;
    const task = (existing || Promise.resolve())
      .catch(() => {})
      .then(() => doSyncServer(server, config, options))
      .finally(() => {
        if (inFlight.get(server.id) === task) inFlight.delete(server.id);
      });
    inFlight.set(server.id, task);
    return task;
  }

  async function syncAll({ serverId = null, forceApply = false } = {}) {
    if (fixtureMode) return { ok: true, simulated: true, results: {} };
    const config = await getConfig();
    const servers = (Array.isArray(config?.servers) ? config.servers : []).filter(
      (s) => s && s.disabled !== true && s.source !== "personal" && (!serverId || s.id === serverId),
    );
    const results = {};
    for (const server of servers) {
      try {
        results[server.id] = await syncServer(server, config, { forceApply });
      } catch (err) {
        results[server.id] = { ok: false, error: err.message };
      }
    }
    return { ok: true, results };
  }

  function start() {
    if (fixtureMode || timer || initialTimer) return;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      syncAll().catch((err) => log(`team-member-sync initial error: ${err.message}`));
    }, initialDelayMs);
    initialTimer.unref?.();
    timer = setInterval(() => {
      syncAll().catch((err) => log(`team-member-sync tick error: ${err.message}`));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getLastSync(serverId) {
    return lastSyncByServer.get(serverId) || null;
  }

  return {
    start,
    stop,
    syncNow: syncAll,
    getLastSync,
  };
}
