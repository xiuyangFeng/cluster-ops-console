import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssignPickerHtml,
  buildAssignPresetBarHtml,
  buildBatchOnboardPlan,
  buildHubBannerHtml,
  buildMemberDiagnosticCardText,
  buildPlanetTipHtml,
  buildRowMenuHtml,
  buildTeamListHtml,
  buildTeamReadoutHtml,
  buildTeamReportCsv,
  buildTeamSkySubHtml,
  collectIdleRegisteredPorts,
  extractOverviewConfigTemplates,
  filterTeamMembers,
  formatTokenCount,
  isMemberNeedingAttention,
  normalizeTeamSort,
  recommendNextPort,
  sortGroup,
  teamFilterCounts,
  teamSortHint,
} from "./team-admin-view.js";

const NOW = 1_800_000_000_000;

function member(over = {}) {
  return {
    user: "u",
    displayName: "",
    note: "",
    isSelf: false,
    inRoster: true,
    enabled: true,
    onlineState: "offline",
    tunnelOnline: false,
    activePort: null,
    assignedPort: null,
    registeredPorts: [],
    portDrift: false,
    versionOutdated: false,
    hasPubKey: false,
    lastSeenAt: NOW - 3 * 3600_000,
    assignment: { state: "none" },
    usage: { todayTokens: 0, todayCalls: 0, todayErrors: 0, weekTokens: 0, weekCalls: 0 },
    compute: { runningJobs: 0, pendingJobs: 0, gpuCount: 0, nodes: [] },
    storage: { homeDirBytes: null },
    ...over,
  };
}

const TEAM = [
  member({
    user: "kai",
    displayName: "CY <admin>",
    note: "组长",
    isSelf: true,
    onlineState: "tunnel-online",
    tunnelOnline: true,
    activePort: 23101,
    assignedPort: 23101,
    registeredPorts: [23101, 23102],
    hasPubKey: true,
    lastSeenAt: NOW,
    assignment: { state: "applied", rev: 3, groupKey: "g1", groupLabel: "Codex · team", summary: { codex: { mode: "relay", providerId: "team", keyMask: "sk-1…abcd" } } },
    usage: { todayTokens: 25000, todayCalls: 5, todayErrors: 1, weekTokens: 120000, weekCalls: 30, topModel: "gpt-6-astra" },
    compute: { runningJobs: 2, pendingJobs: 0, gpuCount: 4, gpuMemMiB: 40960, nodes: ["node04"] },
    storage: { homeDirBytes: 10737418240 },
  }),
  member({
    user: "alice",
    displayName: "Alice",
    onlineState: "tunnel-online",
    tunnelOnline: true,
    activePort: 23105,
    registeredPorts: [23105],
    lastSeenAt: NOW,
    assignment: { state: "applied", rev: 1, groupKey: "g1", groupLabel: "Codex · team" },
    usage: { todayTokens: 900000, todayCalls: 80, todayErrors: 0 },
    compute: { runningJobs: 1, pendingJobs: 0, gpuCount: 2, nodes: ["node04"] },
  }),
  member({ user: "bob", onlineState: "ssh-only", lastSeenAt: NOW, egress: { state: "error", reason: "upstream-timeout" } }),
  member({ user: "dora", displayName: "Dora", assignedPort: 23140, registeredPorts: [23199], portDrift: true, assignment: { state: "pending-pubkey" } }),
  member({ user: "eve", inRoster: false, lastSeenAt: null }),
];

test("formatTokenCount：格式化大数 Token", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(850), "850");
  assert.equal(formatTokenCount(12500), "12.5K");
  assert.equal(formatTokenCount(3450000), "3.45M");
});

test("filterTeamMembers / isMemberNeedingAttention：按状态、关键词（含节点名）筛选；出网异常读 egress.state", () => {
  assert.equal(isMemberNeedingAttention(TEAM[1]), false);
  assert.equal(isMemberNeedingAttention(TEAM[0]), true, "今日有失败");
  assert.equal(isMemberNeedingAttention(TEAM[2]), true, "egress.state=error 视为出网异常");
  assert.equal(isMemberNeedingAttention(member({ egress: { state: "warn" } })), false, "部分目标失败不算需关注");
  assert.equal(filterTeamMembers(TEAM, { filter: "online" }).length, 3);
  assert.equal(filterTeamMembers(TEAM, { filter: "offline" }).length, 2);
  assert.equal(filterTeamMembers(TEAM, { filter: "roster" }).length, 4);
  assert.equal(filterTeamMembers(TEAM, { query: "node04" }).length, 2);
  assert.equal(filterTeamMembers(TEAM, { query: "23199" }).length, 1);
  assert.deepEqual(teamFilterCounts(TEAM), { all: 5, online: 3, offline: 2, roster: 4, attention: 3 });
});

test("buildHubBannerHtml：两类横幅、命令转义，按钮不带 emoji", () => {
  const html = buildHubBannerHtml({
    dir: "/public/agent-hub",
    ready: false,
    baseState: "readonly",
    initCommand: "sudo install -d -o cy -m 1777 /public/agent-hub && echo \"<x>\"",
    spoofsCleaned: ["pubkeys/bob.pub"],
  });
  assert.match(html, /共享管理目录尚未完全就绪/);
  assert.match(html, /已自动清理异常属主占坑文件/);
  assert.match(html, /&lt;x&gt;/);
  assert.doesNotMatch(html, /🔑/);
});

test("buildTeamReadoutHtml / buildTeamSkySubHtml：读数带与标题行", () => {
  const html = buildTeamReadoutHtml({
    totalMembers: 5, rosterMembers: 4, tunnelOnlineCount: 3, sshOnlyCount: 1, totalTodayTokens: 1500000, totalTodayCalls: 4200,
    totalWeekTokens: 9800000, totalGpusUsed: 8, totalRunningJobs: 3, totalPendingJobs: 1, managedKeyCount: 4, pendingSyncCount: 1, outdatedCount: 2,
  });
  assert.match(html, /1\.5M/);
  assert.match(html, /4,200 次/);
  assert.match(html, /GPU 卡/);
  assert.match(html, /旧版本 2/);
  assert.equal((html.match(/class="tm-ro"/g) || []).length, 5);
  assert.match(buildTeamReadoutHtml(null), /0<small>人<\/small>/, "空数据不抛");

  const sub = buildTeamSkySubHtml({ members: TEAM });
  assert.match(sub, /<b>5<\/b> 位成员/);
  assert.match(sub, /<b>3<\/b> 在线/);
  assert.match(sub, /data-tm-goto-attention>3 需关注/);
  assert.match(buildTeamSkySubHtml(null, { loading: true }), /正在从集群聚合/);
});

test("buildTeamListHtml：按轨道分组、一人一行、转义；离线默认收成胶囊", () => {
  const html = buildTeamListHtml({ members: TEAM }, { now: NOW, details: new Set(["kai", "alice"]) });
  const groups = [...html.matchAll(/data-tm-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["tunnel-online", "ssh-only", "offline"]);
  assert.match(html, /CY &lt;admin&gt;/);
  assert.doesNotMatch(html, /CY <admin>/);
  // 在线组：本人置顶，其余按今日用量降序
  const online = html.slice(html.indexOf('data-tm-group="tunnel-online"'), html.indexOf('data-tm-group="ssh-only"'));
  assert.ok(online.indexOf('data-tm-member="kai"') < online.indexOf('data-tm-member="alice"'));
  // 离线组收起：只有胶囊，没有行
  const offline = html.slice(html.indexOf('data-tm-group="offline"'));
  assert.match(offline, /data-tm-chip="dora"/);
  assert.doesNotMatch(offline, /data-tm-member="dora"/);
  assert.match(offline, /从未上线/, "eve 没有 lastSeenAt");
  assert.match(offline, /data-tm-toggle-offline aria-expanded="false">展开/);
  // 行里只露第一条问题，其余折成 +N
  assert.match(html, /今日 1 次失败/);
  assert.match(html, /出网异常/);
  // 详情里的动作：活跃端口给强踢，闲置端口给释放，自己不给强踢
  assert.match(html, /data-tm-release-port="23102"/);
  assert.doesNotMatch(html, /data-tm-release-port="23101"/);
  assert.doesNotMatch(html, /data-tm-kill-user="kai"/);
  assert.match(html, /data-tm-kill-user="alice" data-tm-kill-port="23105"/);
  // 同配 / 同节点 互相列出
  assert.match(html, /同节点 Alice/);
  assert.match(html, /tm-cfg-mates">Alice</);
});

test("buildTeamListHtml：详情只渲染展开的行（以及正在收起的行）", () => {
  const none = buildTeamListHtml({ members: TEAM }, { now: NOW });
  assert.doesNotMatch(none, /class="tm-detail"/, "都没展开时不渲染任何详情");
  const one = buildTeamListHtml({ members: TEAM }, { now: NOW, open: "alice" });
  assert.equal((one.match(/class="tm-detail"/g) || []).length, 1);
  const closing = buildTeamListHtml({ members: TEAM }, { now: NOW, open: "alice", details: new Set(["kai"]) });
  assert.equal((closing.match(/class="tm-detail"/g) || []).length, 2, "正在收起的那行保留详情，动画放完再删");
  assert.match(closing, /class="tm-row" data-tm-member="kai"/, "保留详情但不带 is-open");
});

test("buildTeamListHtml：展开、离线展开、卡片排布、筛选后离线自动展开、空态", () => {
  const opened = buildTeamListHtml({ members: TEAM }, { now: NOW, open: "alice", offlineOpen: true });
  assert.match(opened, /class="tm-row is-open" data-tm-member="alice"/);
  assert.match(opened, /data-tm-member="dora"/);
  assert.match(opened, /aria-expanded="true"[^>]*aria-controls="tm-detail-alice"[^>]*aria-label="收起 Alice 的详情"/);

  const cards = buildTeamListHtml({ members: TEAM }, { now: NOW, layout: "cards" });
  assert.match(cards, /class="tm-cards"/);
  assert.match(cards, /<article class="tm-card"/);
  assert.match(cards, /data-tm-chip="dora"/, "卡片排布下离线仍先收成胶囊");

  const filtered = buildTeamListHtml({ members: TEAM }, { now: NOW, filter: "attention" });
  assert.match(filtered, /data-tm-member="dora"/, "筛选后离线组直接展开");
  assert.doesNotMatch(filtered, /data-tm-toggle-offline/);

  assert.match(buildTeamListHtml({ members: TEAM }, { query: "zzz" }), /没有匹配/);
  assert.match(buildTeamListHtml({ members: [] }), /当前暂无成员记录/);
  assert.match(buildTeamListHtml(null, { loading: true }), /正在从集群聚合/);
  assert.match(buildTeamListHtml(null, { error: "<boom>" }), /&lt;boom&gt;/);
  assert.match(buildTeamListHtml({ members: TEAM }, { busy: true, now: NOW }), /data-tm-assign="kai" disabled/);
});

test("buildRowMenuHtml：窄窗补上快捷动作；自己没有强踢；移出名册在最后", () => {
  const wide = buildRowMenuHtml(TEAM[1]);
  assert.doesNotMatch(wide, /data-tm-assign/);
  assert.match(wide, /data-tm-kill-port="23105"/);
  assert.match(wide, /role="menuitem" class="tm-act is-danger" data-tm-remove="alice"/);
  const folded = buildRowMenuHtml(TEAM[1], { folded: true });
  assert.match(folded, /data-tm-assign="alice"/);
  assert.match(buildRowMenuHtml(member({ user: "x", inRoster: false })), /没有更多操作/);
  assert.equal(buildRowMenuHtml(null), "");
});

test("buildPlanetTipHtml：状态、用量、节点与问题标签，全部转义", () => {
  const tip = buildPlanetTipHtml(TEAM[0], { now: NOW });
  assert.match(tip, /CY &lt;admin&gt;/);
  assert.match(tip, /隧道在线/);
  assert.match(tip, /GPU 4 卡 · node04/);
  assert.match(tip, /Codex · team/);
  assert.match(tip, /今日 1 次失败/);
  assert.match(buildPlanetTipHtml(TEAM[3], { now: NOW }), /离线 · 3 小时前/);
  assert.equal(buildPlanetTipHtml(null), "");
});

test("buildHubBannerHtml 与算力卫生：支持团队置顶公告、配置池限流预警一键整组轮换与算力卫生告警标签", () => {
  const banner = buildHubBannerHtml(
    { ready: true, spoofsCleaned: [] },
    {
      notice: { title: "节点维护", text: "g02 升级驱动", level: "warn", author: "kai" },
      configGroups: [
        { key: "claude:relay:r:sk-1", label: "Claude · r · sk-1", users: ["alice", "bob"], todayCalls: 12, todayErrors: 6, errorRate: 0.5, highErrorRate: true },
      ],
    }
  );
  assert.match(banner, /📢 节点维护/);
  assert.match(banner, /g02 升级驱动/);
  assert.match(banner, /data-tm-assign-group="alice,bob"/);
  assert.match(banner, /整组轮换 Key \(2人\)/);

  const ro = buildTeamReadoutHtml({ totalMembers: 3, totalTodayTokens: 100000, totalTodayCalls: 10, totalTodayCostUsd: 1.25, unmanagedGpusTotal: 2 });
  assert.match(ro, /约 \$1\.25/);
  assert.match(ro, /裸跑 2/);
});

test("buildTeamListHtml：响应式标签类（tm-tag-flag / tm-tag-roster / tm-tag-more）、卡片多告警角标与 activeAgents 对象格式化", () => {
  const crowded = [
    member({
      user: "kai",
      displayName: "管理员 (本机)",
      isSelf: true,
      inRoster: false,
      onlineState: "tunnel-online",
      tunnelOnline: true,
      activePort: 7891,
      activeAgents: { codex: 2, claude: 1 },
      cli: {
        codex: { installed: true, version: "0.45.0", login: "relay" },
        claude: { installed: true, version: "1.2.3", login: "official" },
      },
      usage: { todayTokens: 437930000, todayCalls: 1386, todayErrors: 1, weekTokens: 900000000, weekCalls: 3200, weekErrors: 4, lastActiveAt: NOW - 120_000 },
      compute: { runningJobs: 1, pendingJobs: 0, gpuCount: 6, loginGpuCount: 1, idleGpuCount: 1, cpuPct: 125.4, rssKb: 2097152, nodes: ["master", "node01"] },
      storage: { homeDirBytes: 10737418240, fsCapacityPct: 42 },
      assignment: { state: "error", rev: 2, ackError: "disk full", assignedAt: NOW - 600_000 },
    }),
  ];
  const listHtml = buildTeamListHtml({ members: crowded }, { now: NOW, open: "kai" });
  assert.match(listHtml, /tm-tag tm-tag-roster tm-tag-action"[^>]*data-tm-edit="kai"[^>]*>自动发现</);
  assert.match(listHtml, /tm-tag is-crit tm-tag-flag[^>]*title="今日 1 次失败"[^>]*>今日 1 次失败</);
  assert.match(listHtml, /tm-tag tm-tag-more[^>]*>\+3</);
  assert.match(listHtml, /3 个进程（codex ×2 · claude ×1）/);
  assert.doesNotMatch(listHtml, /NaN 个进程/);
  // 验证详情面板新增的诊断字段
  assert.match(listHtml, /Codex v0\.45\.0（relay） · Claude v1\.2\.3（official）/);
  assert.match(listHtml, /CPU 125\.4% · 内存 2 GiB/);
  assert.match(listHtml, /10 GiB · 分区 42%/);
  assert.match(listHtml, /4 失败/);
  assert.match(listHtml, /disk full/);
  assert.match(listHtml, /data-tm-assign="kai"[^>]*>配置同步异常</);

  const cardHtml = buildTeamListHtml({ members: crowded }, { now: NOW, layout: "cards" });
  assert.match(cardHtml, /tm-card-flags/);
  assert.match(cardHtml, /tm-tag tm-tag-more[^>]*>\+3</);
  assert.match(cardHtml, /tm-tag tm-tag-roster tm-tag-action"[^>]*data-tm-edit="kai"[^>]*>自动发现</);
});

test("标签可键盘操作：行内 / 卡片 / 详情都用 button.tm-tag，只有展开行的动作标签进入 Tab 序列", () => {
  const crowded = [
    member({
      user: "kai",
      displayName: "管理员 (本机)",
      isSelf: true,
      inRoster: false,
      onlineState: "tunnel-online",
      tunnelOnline: true,
      usage: { todayTokens: 100, todayCalls: 1, todayErrors: 1, weekTokens: 0, weekCalls: 0 },
      assignment: { state: "error", ackError: "disk full" },
    }),
    member({ user: "bob", onlineState: "ssh-only", inRoster: false }),
  ];
  // 收起时：动作标签仍是 button，但 tabindex=-1（不在 Tab 序列里），点击行为（data-tm-edit）不变
  const closed = buildTeamListHtml({ members: crowded }, { now: NOW });
  assert.match(closed, /<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="kai" tabindex="-1"/);
  assert.doesNotMatch(closed, /<span class="tm-tag/);
  assert.doesNotMatch(closed, /class="tm-tag[^"]*"[^>]*tabindex="0"/);

  // 展开时：这一行的动作标签 tabindex=0，详情里的动作标签也可 Tab；纯信息标签始终 tabindex=-1
  const opened = buildTeamListHtml({ members: crowded }, { now: NOW, open: "kai" });
  assert.match(opened, /<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="kai" tabindex="0"/);
  assert.match(opened, /class="tm-tag is-crit tm-tag-action"[^>]*data-tm-assign="kai"[^>]*tabindex="0"/);
  assert.match(opened, /<button type="button" class="tm-tag is-self" data-tm-tag-static="1" tabindex="-1">我<\/button>/);
  assert.match(opened, /<button type="button" class="tm-tag tm-tag-more" data-tm-tag-static="1" tabindex="-1"/);

  // 卡片排布下同一套规则
  const cards = buildTeamListHtml({ members: crowded }, { now: NOW, layout: "cards" });
  assert.match(cards, /<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="kai" tabindex="-1"/);
  const cardsOpen = buildTeamListHtml({ members: crowded }, { now: NOW, layout: "cards", open: "kai" });
  assert.match(cardsOpen, /<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="kai" tabindex="0"/);

  // 展开 / 收起按钮带 aria-expanded + aria-controls，指向详情区域
  assert.match(opened, /class="tm-chev" data-tm-toggle="kai" aria-expanded="true" aria-controls="tm-detail-kai"/);
  assert.match(opened, /<div class="tm-detail-wrap" id="tm-detail-kai">/);
});

test("批量多选：chips 是可键盘触发的 button（aria-pressed），容器与选中文案有分组 / live 语义", () => {
  const html = buildAssignPickerHtml(TEAM, ["kai"]);
  assert.match(html, /class="tm-pick-chips" role="group" aria-label="选择要下发配置的成员：Tab 切换，空格或回车选中 \/ 取消"/);
  assert.match(html, /<button type="button" class="tm-pick-chip is-selected" data-tm-pick-user="kai" aria-pressed="true"/);
  assert.match(html, /<button type="button" class="tm-pick-chip" data-tm-pick-user="alice" aria-pressed="false"/);
  assert.match(html, /class="tm-pick-stat" role="status" aria-live="polite">已选 <b>1<\/b>/);
});

test("teamSortHint：给排序控件一句可朗读的等价说明（分组不变、只改组内顺序）", () => {
  assert.match(teamSortHint("tokens"), /当前按「今日用量降序」排序/);
  assert.match(teamSortHint("tokens"), /只改变每个轨道分组内的先后顺序/);
  assert.match(teamSortHint("bogus"), /默认（我在前、今日用量降序）/);
});

test("sortGroup & normalizeTeamSort：支持按今日用量、7 天用量、今日失败、GPU 卡数、存储大小与账号名多维排序", () => {
  assert.equal(normalizeTeamSort("tokens"), "tokens");
  assert.equal(normalizeTeamSort("unknown"), "default");
  const items = [
    member({ user: "zoe", isSelf: true, usage: { todayTokens: 100, todayErrors: 0, weekTokens: 500 }, compute: { gpuCount: 1 }, storage: { homeDirBytes: 100 } }),
    member({ user: "bob", usage: { todayTokens: 5000, todayErrors: 3, weekTokens: 8000 }, compute: { gpuCount: 4 }, storage: { homeDirBytes: 900 } }),
    member({ user: "alice", usage: { todayTokens: 9000, todayErrors: 1, weekTokens: 20000 }, compute: { gpuCount: 2 }, storage: { homeDirBytes: 300 } }),
  ];
  // default 模式下 isSelf 排第一
  assert.equal(sortGroup("tunnel-online", items, "default")[0].user, "zoe");
  // tokens 模式下按今日 Token 降序，不再强制固定 isSelf
  assert.deepEqual(sortGroup("tunnel-online", items, "tokens").map((m) => m.user), ["alice", "bob", "zoe"]);
  assert.deepEqual(sortGroup("tunnel-online", items, "errors").map((m) => m.user), ["bob", "alice", "zoe"]);
  assert.deepEqual(sortGroup("tunnel-online", items, "gpu").map((m) => m.user), ["bob", "alice", "zoe"]);
  assert.deepEqual(sortGroup("tunnel-online", items, "storage").map((m) => m.user), ["bob", "alice", "zoe"]);
  assert.deepEqual(sortGroup("tunnel-online", items, "name").map((m) => m.user), ["alice", "bob", "zoe"]);
});

test("recommendNextPort & buildBatchOnboardPlan & buildAssignPickerHtml & buildTeamReportCsv", () => {
  const ov = {
    members: [
      member({ user: "kai", inRoster: true, assignedPort: 7891, activePort: 7891, registeredPorts: [7891], hasPubKey: true }),
      member({ user: "alice", inRoster: false, activePort: 7895, registeredPorts: [7895] }),
      member({ user: "bob", inRoster: false, activePort: null, registeredPorts: [] }),
      member({ user: "evil", inRoster: true, displayName: "=cmd|' /C calc'!A0" }),
    ],
  };
  assert.equal(recommendNextPort(ov, { forUser: "alice" }), 7895, "优先沿用本人无冲突的 7891~8891 活跃端口");
  assert.equal(recommendNextPort(ov, { forUser: "bob" }), 7892, "无活跃端口时自动顺延分配首个空闲端口");

  const plan = buildBatchOnboardPlan(ov);
  assert.deepEqual(plan, [
    { user: "alice", displayName: "", assignedPort: 7895, note: "自动发现纳管", enabled: true },
    { user: "bob", displayName: "", assignedPort: 7892, note: "自动发现纳管", enabled: true },
  ]);

  const picker = buildAssignPickerHtml(ov.members, ["kai", "bob"]);
  assert.match(picker, /data-tm-pick-user="kai"[^>]*aria-pressed="true"/);
  assert.match(picker, /data-tm-pick-user="alice"[^>]*aria-pressed="false"/);
  assert.match(picker, /data-tm-pick-batch="unmanaged"/);

  const csv = buildTeamReportCsv(ov);
  assert.ok(csv.startsWith("\uFEFF账号,姓名,"), "带 UTF-8 BOM 表头");
  assert.match(csv, /'=cmd\|' \/C calc'!A0/, "公式注入字符前自动加单引号转义");
  // 公式注入不能误伤合法数字：负数/正数要原样保留可计算性
  const csvNums = buildTeamReportCsv({ members: [member({ user: "n", usage: { todayCostUsd: -3.5, todayTokens: 12 } })] });
  const numLine = csvNums.split("\n").find((l) => l.startsWith("n,"));
  assert.ok(numLine.includes(",-3.5,"), `负数不应被加引号变成文本：${numLine}`);

  // 7891 是团队生产端口，凭空「新分配」绝不能落到它上面
  const baseOnly = { members: [member({ user: "kai", inRoster: true, assignedPort: 7891, activePort: 7891, registeredPorts: [7891] })] };
  assert.equal(recommendNextPort(baseOnly, { forUser: "" }), 7892, "新分配从 7892 起，跳过保留的 7891");
  assert.equal(recommendNextPort(baseOnly, { forUser: "kai" }), 7891, "已持有 7891 的人仍可沿用自己原有的端口");
  const freshCluster = { members: [member({ user: "newbie", inRoster: false, activePort: null })] };
  assert.equal(buildBatchOnboardPlan(freshCluster)[0].assignedPort, 7892, "一键纳管的新分配同样从 7892 起");

  // 端口段用尽时如实返回 null（成员照旧纳管），并由调用方提示，而不是假装已分配端口
  const full = {
    members: [
      member({ user: "newbie", inRoster: false, activePort: null }),
      ...Array.from({ length: 1001 }, (_, i) => member({ user: `u${i}`, inRoster: true, assignedPort: 7891 + i })),
    ],
  };
  assert.equal(buildBatchOnboardPlan(full)[0].assignedPort, null, "端口段已满时不得静默给出不存在的端口");
  assert.equal(recommendNextPort(full, { forUser: "newbie" }), 7892, "端口段已满时推荐值退化为区间下界（调用方仍需自行校验）");

  // ✓ / ⏳ 必须有可区分的类名，否则「公钥已就绪」没有任何视觉差异
  assert.match(picker, /tm-pick-key is-ok"[^>]*>✓</);
  assert.match(picker, /tm-pick-key"[^>]*>⏳</);
});

test("collectIdleRegisteredPorts / buildMemberDiagnosticCardText / extractOverviewConfigTemplates / buildAssignPresetBarHtml", () => {
  const idle = collectIdleRegisteredPorts({ members: TEAM });
  assert.deepEqual(idle, [
    { user: "kai", displayName: "CY <admin>", port: 23102 },
    { user: "dora", displayName: "Dora", port: 23199 },
  ]);

  const diag = buildMemberDiagnosticCardText(TEAM[0], { serverName: "AI集群", now: NOW });
  assert.match(diag, /### 🩺 团队成员状态诊断卡 · CY <admin> \(kai\)/);
  assert.match(diag, /- \*\*集群节点\*\*：AI集群/);
  assert.match(diag, /隧道在线 \(:23101\)/);
  assert.match(diag, /已登记 :23101, :23102/);
  assert.match(diag, /今日 1 次失败/);

  const tpls = extractOverviewConfigTemplates({ members: TEAM });
  assert.equal(tpls.length, 1);
  assert.equal(tpls[0].codex.providerId, "team");

  const presetHtml = buildAssignPresetBarHtml({
    presets: [{ name: "主力中转", codex: { enabled: true, providerId: "main", baseUrl: "https://main.example/v1" } }],
    activeTemplates: tpls,
  });
  assert.match(presetHtml, /data-tm-apply-preset="0"[^>]*>📌 主力中转</);
  assert.match(presetHtml, /data-tm-delete-preset="0"/);
  assert.match(presetHtml, /data-tm-apply-active-tpl="0"[^>]*>⚡ Codex · team \(1人\)</);
  assert.match(presetHtml, /data-tm-save-preset/);
});




