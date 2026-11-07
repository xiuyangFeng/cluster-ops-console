// 团队管理视图纯函数模型：将远端管理员探测（survey）、集群资源层（resources: slurm / gpu / procTop）
// 与管理员本机待投递队列（pendingAssignments）合成为前端可直接渲染的 TeamOverview 结构。

import { compareVersions } from "../cli/catalog.mjs";
import { buildHubAdminInitCommand, buildRootGrantScript, DEFAULT_AGENT_HUB_DIR, isSafeClusterUser } from "./protocol.mjs";

const SYSTEM_USERS = new Set([
  "root", "nobody", "nfsnobody", "daemon", "bin", "sys", "sync", "games", "man", "lp",
  "mail", "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats",
  "systemd-network", "systemd-resolve", "systemd-timesync", " systemd-coredump",
  "sshd", "messagebus", "dbus", "polkitd", "chrony", "ntp", "postfix", "slurm", "munge",
  "rpc", "rpcuser", "avahi", "colord", "rtkit", "gdm", "tss", "tcpdump", "uuidd",
]);

function isLikelySystemUser(user) {
  if (!isSafeClusterUser(user)) return true;
  const u = user.trim();
  if (SYSTEM_USERS.has(u)) return true;
  if (u.startsWith("systemd-") || u.startsWith("_")) return true;
  return false;
}

function summarizeCliItems(summary) {
  if (!summary || typeof summary !== "object") return { codex: null, claude: null };
  return {
    codex: summary.codex || null,
    claude: summary.claude || null,
  };
}

// 「同一份配置」分组：只用信封外层的公开摘要（mode / baseUrl / providerId / keyMask，已脱敏），
// 同指纹的成员在星图里连成一个配置星座。revoke 或空摘要不分组。
function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function hostOf(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim().slice(0, 48);
  }
}

export function buildAssignmentGroup(summary) {
  const parts = [];
  const labels = [];
  const codex = summary?.codex;
  const claude = summary?.claude;
  if (codex?.mode && codex.mode !== "revoke") {
    parts.push(`codex|${codex.mode}|${codex.baseUrl || ""}|${codex.providerId || ""}|${codex.keyMask || ""}`);
    labels.push(codex.mode === "official" ? "Codex 官方" : `Codex · ${codex.providerId || codex.providerName || hostOf(codex.baseUrl) || "中转"}`);
  }
  if (claude?.mode && claude.mode !== "revoke") {
    parts.push(`claude|${claude.mode}|${claude.baseUrl || ""}|${claude.keyMask || ""}`);
    labels.push(claude.mode === "official" ? "Claude 官方" : `Claude · ${hostOf(claude.baseUrl) || "中转"}`);
  }
  if (!parts.length) return { groupKey: null, groupLabel: null };
  return { groupKey: fnv1a(parts.join("\n")), groupLabel: labels.join(" + ") };
}

function buildAssignmentState({ enc, pending, ack }) {
  if (pending && typeof pending === "object") {
    return {
      state: "pending-pubkey",
      rev: pending.rev || 1,
      assignedAt: pending.assignedAt || null,
      ackAt: null,
      message: "待该成员首次接入生成公钥后自动加密投递",
      summary: summarizeCliItems(pending.summary),
      ...buildAssignmentGroup(pending.summary),
    };
  }
  if (!enc || typeof enc !== "object") {
    return {
      state: "none",
      rev: null,
      assignedAt: null,
      ackAt: null,
      message: null,
      summary: { codex: null, claude: null },
      groupKey: null,
      groupLabel: null,
    };
  }
  const rev = Number(enc.rev) || 1;
  const summary = summarizeCliItems(enc.summary);
  const group = buildAssignmentGroup(enc.summary);
  if (ack && typeof ack === "object" && Number(ack.rev) === rev) {
    if (ack.status === "error") {
      return {
        state: "error",
        rev,
        assignedAt: enc.assignedAt || null,
        ackAt: ack.appliedAt || null,
        message: typeof ack.message === "string" && ack.message ? ack.message : "成员端应用配置失败",
        summary,
        ...group,
      };
    }
    return {
      state: "applied",
      rev,
      assignedAt: enc.assignedAt || null,
      ackAt: ack.appliedAt || null,
      message: typeof ack.message === "string" ? ack.message : "已生效",
      summary,
      ...group,
    };
  }
  return {
    state: "pending-sync",
    rev,
    assignedAt: enc.assignedAt || null,
    ackAt: ack?.appliedAt || null,
    message: "已写入集群，等待成员工作台在线同步",
    summary,
    ...group,
  };
}

// Slurm 压缩主机列表展开：「node[01-03,07],gpu5」→ node01 node02 node03 node07 gpu5。
// 只为连星座用，单个作业最多取 16 个节点，畸形输入原样当作一个名字。
export function expandSlurmNodeList(text, limit = 16) {
  if (typeof text !== "string" || !text.trim()) return [];
  const out = [];
  const tokens = text.trim().match(/[^,[]+(?:\[[^\]]*\])?[^,]*/g) || [];
  for (const raw of tokens) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = tok.match(/^([^[]*)\[([^\]]*)\](.*)$/);
    if (!m) {
      out.push(tok);
    } else {
      const [, prefix, body, suffix] = m;
      for (const part of body.split(",")) {
        const r = part.match(/^(\d+)-(\d+)$/);
        if (r) {
          const width = r[1].length;
          const lo = Number(r[1]);
          const hi = Math.min(Number(r[2]), lo + limit);
          for (let n = lo; n <= hi && out.length < limit; n += 1) out.push(`${prefix}${String(n).padStart(width, "0")}${suffix}`);
        } else if (part.trim()) {
          out.push(`${prefix}${part.trim()}${suffix}`);
        }
        if (out.length >= limit) break;
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

const LOGIN_NODE_LABEL = "登录节点";
const IDLE_GPU_MIN_MEM_MIB = 1024;

// 当心跳只带总 Token 未带细分明细时，按主力模型粗略折算混合等效花费（USD / 1M Tokens）
function estimateBlendedCostUsd(tokens, topModel = "") {
  const n = Number(tokens) || 0;
  if (n <= 0) return 0;
  const m = String(topModel || "").toLowerCase();
  const ratePerM = m.includes("opus") ? 6.0 : m.includes("mini") || m.includes("nano") || m.includes("haiku") ? 0.35 : 1.5;
  return Math.round(((n * ratePerM) / 1_000_000) * 10000) / 10000;
}

function collectComputeByUser(resources) {
  const byUser = new Map();
  const ensure = (u) => {
    if (!byUser.has(u)) {
      byUser.set(u, {
        runningJobs: 0,
        pendingJobs: 0,
        slurmGpus: 0,
        slurmCpus: 0,
        jobNames: [],
        gpuCardKeys: new Set(),
        loginGpuCards: new Set(),
        idleGpuCards: new Set(),
        gpuMemMiB: 0,
        cpuPct: 0,
        rssKb: 0,
        nodes: new Set(),
      });
    }
    return byUser.get(u);
  };

  // 1. Slurm 队列作业
  const jobs = Array.isArray(resources?.slurm?.jobs) ? resources.slurm.jobs : [];
  for (const job of jobs) {
    if (!job || !isSafeClusterUser(job.user)) continue;
    const item = ensure(job.user.trim());
    if (job.state === "RUNNING" || job.state === "COMPLETING") {
      item.runningJobs += 1;
      if (Number.isFinite(job.gpus) && job.gpus > 0) item.slurmGpus += job.gpus;
      if (Number.isFinite(job.cpus) && job.cpus > 0) item.slurmCpus += job.cpus;
      if (job.name && item.jobNames.length < 3 && !item.jobNames.includes(job.name)) {
        item.jobNames.push(job.name);
      }
      for (const n of expandSlurmNodeList(job.nodeList)) item.nodes.add(n);
    } else if (job.state === "PENDING") {
      item.pendingJobs += 1;
    }
  }

  // 2. 登录节点 GPU 进程占用
  const loginGpus = Array.isArray(resources?.gpu)
    ? resources.gpu
    : Array.isArray(resources?.gpu?.cards)
      ? resources.gpu.cards
      : [];
  for (const card of loginGpus) {
    const isCardIdle = Number.isFinite(card?.util) && Number(card.util) === 0;
    for (const uEntry of Array.isArray(card?.users) ? card.users : []) {
      if (!uEntry || !isSafeClusterUser(uEntry.user) || uEntry.user === "未知") continue;
      const item = ensure(uEntry.user.trim());
      const cardKey = `login:${card.index}`;
      item.gpuCardKeys.add(cardKey);
      item.loginGpuCards.add(cardKey);
      item.nodes.add(LOGIN_NODE_LABEL);
      const mem = Number(uEntry.memMb) || 0;
      if (mem > 0) item.gpuMemMiB += mem;
      if (isCardIdle && mem >= IDLE_GPU_MIN_MEM_MIB) item.idleGpuCards.add(cardKey);
    }
  }

  // 3. 直连节点（如 node04）GPU 进程占用
  const nodes = Array.isArray(resources?.slurm?.nodes) ? resources.slurm.nodes : [];
  for (const node of nodes) {
    const cards = Array.isArray(node?.gpus?.cards) ? node.gpus.cards : [];
    for (const card of cards) {
      const isCardIdle = Number.isFinite(card?.util) && Number(card.util) === 0;
      for (const uEntry of Array.isArray(card?.users) ? card.users : []) {
        if (!uEntry || !isSafeClusterUser(uEntry.user) || uEntry.user === "未知") continue;
        const item = ensure(uEntry.user.trim());
        const cardKey = `${node.name}:${card.index}`;
        item.gpuCardKeys.add(cardKey);
        if (node.name) item.nodes.add(String(node.name));
        const mem = Number(uEntry.memMb) || 0;
        if (mem > 0) item.gpuMemMiB += mem;
        if (isCardIdle && mem >= IDLE_GPU_MIN_MEM_MIB) item.idleGpuCards.add(cardKey);
      }
    }
  }

  // 4. 节点 proc-top CPU / 常驻内存占用
  const procUsers = Array.isArray(resources?.procTop?.users) ? resources.procTop.users : [];
  for (const pu of procUsers) {
    if (!pu || !isSafeClusterUser(pu.user)) continue;
    const item = ensure(pu.user.trim());
    const cpu = (Number(pu.cpuJobPct) || 0) + (Number(pu.cpuOtherPct) || 0);
    const rss = (Number(pu.rssJobKb) || 0) + (Number(pu.rssOtherKb) || 0);
    item.cpuPct = Math.round((item.cpuPct + cpu) * 10) / 10;
    item.rssKb += rss;
  }

  return byUser;
}

function isVersionOutdated(memberVer, adminVer) {
  if (typeof memberVer !== "string" || typeof adminVer !== "string") return false;
  const a = memberVer.trim().replace(/^v/i, "");
  const b = adminVer.trim().replace(/^v/i, "");
  if (!a || !b) return false;
  try {
    return compareVersions(a, b) < 0;
  } catch {
    return false;
  }
}

export function buildTeamOverviewModel({
  survey,
  resources = null,
  pendingAssignments = {},
  adminVersion = "",
  serverId = "server-01",
  serverName = "",
  hubDir = DEFAULT_AGENT_HUB_DIR,
  selfDirUsageBytes = null,
  nowMs = Date.now(),
} = {}) {
  const s = survey || {
    me: "",
    hubBase: "unknown",
    hubOwner: "",
    dirs: {},
    roster: { v: 1, members: {} },
    ports: [],
    listening: [],
    pubkeys: {},
    assigned: {},
    heartbeats: {},
    spoofs: [],
    sshUsers: [],
    agentProcs: {},
  };

  const computeByUser = collectComputeByUser(resources);
  const explicitUsers = new Set([
    ...Object.keys(s.roster?.members || {}),
    ...(s.ports || []).map((p) => p.owner).filter(isSafeClusterUser),
    ...Object.keys(s.pubkeys || {}),
    ...Object.keys(s.assigned || {}),
    ...Object.keys(s.heartbeats || {}),
    ...Object.keys(pendingAssignments || {}),
    ...(s.me && isSafeClusterUser(s.me) ? [s.me] : []),
  ]);

  const discoveredUsers = new Set(explicitUsers);
  for (const u of s.sshUsers || []) {
    if (!isLikelySystemUser(u)) discoveredUsers.add(u);
  }
  for (const u of Object.keys(s.agentProcs || {})) {
    if (!isLikelySystemUser(u)) discoveredUsers.add(u);
  }
  for (const u of computeByUser.keys()) {
    if (!isLikelySystemUser(u)) discoveredUsers.add(u);
  }

  const listeningSet = new Set(s.listening || []);
  const members = [];

  for (const user of discoveredUsers) {
    if (!isSafeClusterUser(user)) continue;
    const rosterEntry = s.roster?.members?.[user] || null;
    const regEntries = (s.ports || []).filter((p) => p.regular && p.owner === user);
    const registeredPorts = regEntries.map((p) => p.port);
    const assignedPort = rosterEntry?.assignedPort ?? null;
    const primaryPort = registeredPorts[0] ?? assignedPort ?? null;

    // 隧道是否在线：本人已登记端口在 LISTEN，或名册预分配端口在 LISTEN 且未被他人登记
    const listeningOwnPorts = registeredPorts.filter((p) => listeningSet.has(p));
    const assignedListening =
      assignedPort != null &&
      listeningSet.has(assignedPort) &&
      !(s.ports || []).some((p) => p.port === assignedPort && p.owner !== user);
    const tunnelOnline = listeningOwnPorts.length > 0 || assignedListening;
    const activePort = listeningOwnPorts[0] ?? (assignedListening ? assignedPort : primaryPort);

    const sshOnline = (s.sshUsers || []).includes(user);
    const activeAgents = s.agentProcs?.[user] || {};
    const activeAgentCount = Object.values(activeAgents).reduce((sum, n) => sum + Number(n || 0), 0);
    const compute = computeByUser.get(user) || {
      runningJobs: 0,
      pendingJobs: 0,
      slurmGpus: 0,
      slurmCpus: 0,
      jobNames: [],
      gpuCardKeys: new Set(),
      loginGpuCards: new Set(),
      idleGpuCards: new Set(),
      gpuMemMiB: 0,
      cpuPct: 0,
      rssKb: 0,
      nodes: new Set(),
    };

    let onlineState = "offline";
    if (tunnelOnline) onlineState = "tunnel-online";
    else if (sshOnline || activeAgentCount > 0 || compute.runningJobs > 0) onlineState = "ssh-only";

    const hb = s.heartbeats?.[user] || null;
    const rootScan = s.rootScans?.[user] || null;
    const hbUpdatedAt = Number(hb?.updatedAt) > 0 ? Number(hb.updatedAt) : null;
    const lastSeenAt = tunnelOnline || sshOnline ? nowMs : hbUpdatedAt;

    const clientVersion = typeof hb?.clientVersion === "string" ? hb.clientVersion : null;
    const channel = typeof hb?.channel === "string" ? hb.channel : null;
    const versionOutdated = clientVersion ? isVersionOutdated(clientVersion, adminVersion) : false;

    const egress = hb?.egress && typeof hb.egress === "object"
      ? {
          mode: hb.egress.mode || null,
          state: hb.egress.state || "unknown",
          reason: hb.egress.reason || null,
          failuresTotal: Number(hb.egress.failuresTotal) || 0,
        }
      : null;

    const usage = hb?.usage && typeof hb.usage === "object"
      ? {
          todayCalls: Number(hb.usage.todayCalls) || 0,
          todayTokens: Number(hb.usage.todayTokens) || 0,
          todayErrors: Number(hb.usage.todayErrors) || 0,
          todayCostUsd: Number(hb.usage.todayCostUsd) > 0
            ? Number(hb.usage.todayCostUsd)
            : estimateBlendedCostUsd(hb.usage.todayTokens, hb.usage.topModel),
          weekCalls: Number(hb.usage.weekCalls) || 0,
          weekTokens: Number(hb.usage.weekTokens) || 0,
          weekErrors: Number(hb.usage.weekErrors) || 0,
          weekCostUsd: Number(hb.usage.weekCostUsd) > 0
            ? Number(hb.usage.weekCostUsd)
            : estimateBlendedCostUsd(hb.usage.weekTokens, hb.usage.topModel),
          topModel: typeof hb.usage.topModel === "string" ? hb.usage.topModel : null,
          lastActiveAt: Number(hb.usage.lastActiveAt) || null,
          fromRootScan: false,
        }
      : rootScan
        ? {
            todayCalls: Number(rootScan.todayCalls) || 0,
            todayTokens: Number(rootScan.todayTokens) || 0,
            todayErrors: 0,
            todayCostUsd: estimateBlendedCostUsd(rootScan.todayTokens, ""),
            weekCalls: Number(rootScan.weekCalls) || 0,
            weekTokens: Number(rootScan.weekTokens) || 0,
            weekErrors: 0,
            weekCostUsd: estimateBlendedCostUsd(rootScan.weekTokens, ""),
            topModel: "Root 兜底采集",
            lastActiveAt: null,
            fromRootScan: true,
          }
        : null;

    const isSelf = Boolean(s.me && user === s.me);
    const homeDirBytes = Number(hb?.disk?.scannedDirBytes) > 0
      ? Number(hb.disk.scannedDirBytes)
      : isSelf && Number(selfDirUsageBytes) > 0
        ? Number(selfDirUsageBytes)
        : Number(rootScan?.homeDirBytes) > 0
          ? Number(rootScan.homeDirBytes)
          : null;
    const fsUsedKb = Number(hb?.disk?.homeUsedKb) > 0
      ? Number(hb.disk.homeUsedKb)
      : isSelf && Number(resources?.filesystem?.usedKb) > 0
        ? Number(resources.filesystem.usedKb)
        : null;

    const gpuCount = Math.max(compute.slurmGpus, compute.gpuCardKeys.size);
    const loginGpuCount = compute.loginGpuCards?.size || 0;
    const unmanagedGpuCount = Math.max(0, compute.gpuCardKeys.size - compute.slurmGpus);
    const idleGpuCount = compute.idleGpuCards?.size || 0;
    const assignment = buildAssignmentState({
      enc: s.assigned?.[user] || null,
      pending: pendingAssignments?.[user] || null,
      ack: hb?.assignedAck || null,
    });

    const portDrift =
      assignedPort != null &&
      registeredPorts.length > 0 &&
      !registeredPorts.includes(assignedPort);

    const cli = hb?.cli || (rootScan ? { codex: { installed: Boolean(rootScan.codexInstalled) }, claude: { installed: Boolean(rootScan.claudeInstalled) } } : null);

    members.push({
      user,
      displayName: rosterEntry?.displayName || (isSelf ? "管理员 (本机)" : ""),
      note: rosterEntry?.note || "",
      isSelf,
      inRoster: Boolean(rosterEntry),
      enabled: rosterEntry ? rosterEntry.enabled !== false : true,
      assignedPort,
      registeredPorts,
      activePort,
      portDrift,
      onlineState,
      tunnelOnline,
      sshOnline,
      activeAgents,
      lastSeenAt,
      hasPubKey: Boolean(s.pubkeys?.[user]),
      clientVersion,
      channel,
      versionOutdated,
      egress,
      cli,
      assignment,
      usage,
      compute: {
        runningJobs: compute.runningJobs,
        pendingJobs: compute.pendingJobs,
        gpuCount,
        loginGpuCount,
        unmanagedGpuCount,
        idleGpuCount,
        gpuMemMiB: Math.round(compute.gpuMemMiB),
        cpuPct: compute.cpuPct,
        rssKb: compute.rssKb,
        jobNames: compute.jobNames,
        nodes: [...compute.nodes].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).slice(0, 8),
      },
      storage: {
        homeDirBytes,
        fsUsedKb,
        fsCapacityPct: Number(hb?.disk?.homeCapacityPct) || (isSelf ? resources?.filesystem?.capacityPct ?? null : null),
      },
    });
  }

  const onlineRank = { "tunnel-online": 0, "ssh-only": 1, offline: 2 };
  members.sort((a, b) => {
    const rA = onlineRank[a.onlineState] ?? 3;
    const rB = onlineRank[b.onlineState] ?? 3;
    if (rA !== rB) return rA - rB;
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.inRoster !== b.inRoster) return a.inRoster ? -1 : 1;
    return a.user.localeCompare(b.user);
  });

  // 按配置星座（groupKey）聚合中转站 / API Key 池今日调用、失败率与等效花费
  const groupMap = new Map();
  for (const m of members) {
    const gk = m.assignment?.groupKey;
    if (!gk || m.assignment?.state === "none") continue;
    let g = groupMap.get(gk);
    if (!g) {
      g = {
        groupKey: gk,
        groupLabel: m.assignment.groupLabel || gk,
        users: [],
        todayCalls: 0,
        todayErrors: 0,
        todayTokens: 0,
        todayCostUsd: 0,
        applyErrors: 0,
      };
      groupMap.set(gk, g);
    }
    g.users.push(m.user);
    g.todayCalls += m.usage?.todayCalls || 0;
    g.todayErrors += m.usage?.todayErrors || 0;
    g.todayTokens += m.usage?.todayTokens || 0;
    g.todayCostUsd += m.usage?.todayCostUsd || 0;
    if (m.assignment.state === "error") g.applyErrors += 1;
  }
  const configGroups = [...groupMap.values()]
    .map((g) => {
      const errorRate = g.todayCalls > 0 ? Math.round((g.todayErrors / g.todayCalls) * 1000) / 1000 : 0;
      const highErrorRate = g.applyErrors > 0 || (g.todayErrors >= 3 && errorRate >= 0.1);
      return {
        ...g,
        memberCount: g.users.length,
        todayCostUsd: Math.round(g.todayCostUsd * 10000) / 10000,
        errorRate,
        highErrorRate,
      };
    })
    .sort((a, b) => Number(b.highErrorRate) - Number(a.highErrorRate) || b.memberCount - a.memberCount);

  // 统计顶部全局 KPI
  const tunnelOnlineCount = members.filter((m) => m.onlineState === "tunnel-online").length;
  const sshOnlyCount = members.filter((m) => m.onlineState === "ssh-only").length;
  const totalTodayTokens = members.reduce((sum, m) => sum + (m.usage?.todayTokens || 0), 0);
  const totalTodayCalls = members.reduce((sum, m) => sum + (m.usage?.todayCalls || 0), 0);
  const totalTodayCostUsd = Math.round(members.reduce((sum, m) => sum + (m.usage?.todayCostUsd || 0), 0) * 10000) / 10000;
  const totalWeekTokens = members.reduce((sum, m) => sum + (m.usage?.weekTokens || 0), 0);
  const totalRunningJobs = members.reduce((sum, m) => sum + (m.compute?.runningJobs || 0), 0);
  const totalPendingJobs = members.reduce((sum, m) => sum + (m.compute?.pendingJobs || 0), 0);
  const totalGpusUsed = members.reduce((sum, m) => sum + (m.compute?.gpuCount || 0), 0);
  const unmanagedGpusTotal = members.reduce((sum, m) => sum + (m.compute?.unmanagedGpuCount || 0), 0);
  const idleGpusTotal = members.reduce((sum, m) => sum + (m.compute?.idleGpuCount || 0), 0);
  const managedKeyCount = members.filter((m) => m.assignment.state !== "none").length;
  const pendingSyncCount = members.filter((m) => m.assignment.state === "pending-sync" || m.assignment.state === "pending-pubkey").length;
  const outdatedCount = members.filter((m) => m.versionOutdated).length;

  // 检查目录健康度：admin / assigned / ports / pubkeys / heartbeats 是否可写
  const writableDirs = ["admin", "assigned", "ports", "pubkeys", "heartbeats"];
  const missingOrReadonlyDirs = writableDirs.filter((d) => s.dirs?.[d]?.state !== "ok");
  const hubReady = s.hubBase === "ok" && missingOrReadonlyDirs.length === 0;

  return {
    serverId,
    serverName: serverName || serverId,
    checkedAt: nowMs,
    me: s.me || "",
    notice: s.notice || null,
    hub: {
      dir: hubDir,
      ready: hubReady,
      sudoReady: Boolean(s.sudoReady),
      baseState: s.hubBase,
      owner: s.hubOwner || null,
      missingOrReadonlyDirs,
      initCommand: buildHubAdminInitCommand(hubDir, s.me || ""),
      rootGrantScript: buildRootGrantScript(hubDir, s.me || "admin"),
      spoofsCleaned: (s.spoofs || []).length,
      spoofsList: (s.spoofs || []).map((x) => x.file).filter(Boolean),
    },
    kpis: {
      totalMembers: members.length,
      rosterMembers: Object.keys(s.roster?.members || {}).length,
      tunnelOnlineCount,
      sshOnlyCount,
      totalTodayTokens,
      totalTodayCalls,
      totalTodayCostUsd,
      totalWeekTokens,
      totalRunningJobs,
      totalPendingJobs,
      totalGpusUsed,
      unmanagedGpusTotal,
      idleGpusTotal,
      managedKeyCount,
      pendingSyncCount,
      outdatedCount,
    },
    configGroups,
    members,
  };
}
