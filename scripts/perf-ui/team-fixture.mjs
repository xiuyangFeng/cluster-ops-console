// 团队管理页基准用的确定性示例数据（结构同 lib/team-admin/model.mjs 的 TeamOverview），以及隔离的团队配置。
// 只给基准 / 截图用：账号、端口、节点全是虚构的；服务器是解析不了的 fixture.invalid。
export const TEAM_BENCH_CONFIG = {
  activeServerId: "fixture-server",
  activeAgentId: "codex",
  adminUsers: ["admin"],
  servers: [{ id: "fixture-server", name: "myserver", host: "fixture.invalid", sshUser: "admin", localPort: 18888, remotePort: 17891 }],
  agents: [{ id: "codex", name: "Codex" }],
};

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CFGS = [
  { groupKey: "a1", groupLabel: "Codex · team-relay", summary: { codex: { mode: "relay", providerId: "team-relay", baseUrl: "https://relay.example/v1", keyMask: "sk-t…99a1" } } },
  { groupKey: "b2", groupLabel: "Claude · relay.example", summary: { claude: { mode: "relay", baseUrl: "https://relay.example", keyMask: "sk-a…88b2" } } },
  { groupKey: "c3", groupLabel: "Codex 官方", summary: { codex: { mode: "official", keyMask: "sk-…7f20" } } },
];
const NAMES = ["陈宇", "李雯", "赵鑫", "孙浩", "王琦", "何韵", "徐天", "周默", "林夕", "方雨", "唐乐", "马哲", "钱一", "罗涵", "宋佳", "邓珂", "谢宁", "韩悦", "冯驰", "曹威", "彭飞", "曾黎", "肖然", "田雨", "董梓", "潘欣", "袁博", "蔡雯", "江涛", "余航", "沈默", "吕青", "苏杭", "卢瑶", "蒋帆", "魏来", "程远", "叶舟", "陆离", "丁一"];

export function teamOverview(count = 40, { now = Date.now() } = {}) {
  const r = rng(20261017);
  const HOUR = 3600e3;
  const members = [];
  for (let i = 0; i < count; i += 1) {
    const isSelf = i === 0;
    const roll = r();
    const state = isSelf ? "tunnel-online" : roll < 0.38 ? "tunnel-online" : roll < 0.55 ? "ssh-only" : "offline";
    const online = state !== "offline";
    const port = 20400 + i;
    const cfg = r() < 0.75 ? CFGS[Math.floor(r() * CFGS.length)] : null;
    const gpu = online && r() < 0.55 ? 1 + Math.floor(r() * 4) : 0;
    const nodes = gpu || (online && r() < 0.3) ? [`node0${1 + Math.floor(r() * 6)}`] : [];
    const tok = state === "tunnel-online" ? r() * 6e6 : state === "ssh-only" ? r() * 0.8e6 : 0;
    members.push({
      user: isSelf ? "admin" : `u${String(i).padStart(2, "0")}`,
      displayName: isSelf ? "管理员" : NAMES[i % NAMES.length],
      note: r() < 0.2 ? "多模态组" : "",
      isSelf,
      inRoster: r() > 0.05,
      enabled: r() > 0.04,
      assignedPort: port,
      registeredPorts: r() < 0.06 ? [port + 100] : [port],
      activePort: state === "tunnel-online" ? port : null,
      portDrift: false,
      onlineState: state,
      tunnelOnline: state === "tunnel-online",
      sshOnline: online,
      activeAgents: online ? Math.floor(r() * 3) : 0,
      lastSeenAt: online ? now : now - Math.floor(r() * 140) * HOUR,
      hasPubKey: r() > 0.1,
      clientVersion: r() < 0.1 ? "2.66.1" : "2.69.0",
      versionOutdated: false,
      egress: { state: r() < 0.06 ? "error" : "ok", reason: "upstream-timeout" },
      assignment: cfg ? { state: r() < 0.1 ? "pending-sync" : "applied", rev: 1 + Math.floor(r() * 4), ...cfg } : { state: "none", summary: { codex: null, claude: null }, groupKey: null, groupLabel: null },
      usage: { todayTokens: tok, todayCalls: Math.round(tok / 7000), todayErrors: r() < 0.08 ? 3 : 0, weekTokens: tok * 6 + r() * 3e6, weekCalls: Math.round(tok / 1200), weekErrors: 0, topModel: cfg?.groupKey === "b2" ? "claude-opus-5-5" : "gpt-6-astra" },
      compute: { runningJobs: gpu ? 1 + Math.floor(r() * 3) : nodes.length, pendingJobs: r() < 0.3 ? 1 : 0, gpuCount: gpu, gpuMemMiB: gpu * 40000, cpuPct: online ? Math.round(r() * 800) : 0, rssKb: 0, jobNames: gpu ? ["train"] : [], nodes },
      storage: { homeDirBytes: Math.round(r() * 600e9) },
    });
    members.at(-1).versionOutdated = members.at(-1).clientVersion === "2.66.1";
  }
  const sum = (f) => members.reduce((s, m) => s + (f(m) || 0), 0);
  return {
    serverId: "fixture-server",
    serverName: "myserver",
    checkedAt: now,
    me: "admin",
    hub: { dir: "/public/agent-hub", ready: true, sudoReady: false, baseState: "ok", spoofsCleaned: 0, spoofsList: [], rootGrantScript: "# fixture" },
    kpis: {
      totalMembers: members.length,
      rosterMembers: members.filter((m) => m.inRoster).length,
      tunnelOnlineCount: members.filter((m) => m.onlineState === "tunnel-online").length,
      sshOnlyCount: members.filter((m) => m.onlineState === "ssh-only").length,
      totalTodayTokens: sum((m) => m.usage.todayTokens),
      totalTodayCalls: sum((m) => m.usage.todayCalls),
      totalWeekTokens: sum((m) => m.usage.weekTokens),
      totalRunningJobs: sum((m) => m.compute.runningJobs),
      totalPendingJobs: sum((m) => m.compute.pendingJobs),
      totalGpusUsed: sum((m) => m.compute.gpuCount),
      managedKeyCount: members.filter((m) => m.assignment.state !== "none").length,
      pendingSyncCount: members.filter((m) => m.assignment.state === "pending-sync").length,
      outdatedCount: members.filter((m) => m.versionOutdated).length,
    },
    members,
  };
}
