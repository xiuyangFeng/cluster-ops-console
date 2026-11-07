import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_MODES,
  AUTH_SETTLE_MS,
  AUTH_SETTLE_TRIES,
  authSettled,
  buildAuthFactsHtml,
  buildEnforceConfirmHtml,
  buildRotateConfirmHtml,
  buildSyncPanelHtml,
  buildUsageHtml,
  createSettingsProxyAuth,
  describeCluster,
  describeClusterAlert,
  describeProxyApplied,
  describeRisks,
  describeSyncPlan,
  describeUnauthenticatedTargets,
  ENFORCE_NOTICE,
  formatDeadline,
} from "./settings-proxy-auth.js";
import { fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const NOW = Date.UTC(2026, 9, 12, 6, 0, 0);
const STATS_EMPTY = { windowHours: 24, since: null, authed: 0, missing: 0, bad: 0, denied: 0, targets: [], moreTargets: 0, moreRequests: 0 };
const CLUSTER = { serverId: "server-01", serverName: "主集群", env: "in-sync", credential: "none", checkedAt: NOW, error: null };

// GET /api/egress 的 proxyAuth 的几种样子。
const OFF = { mode: "off", hasToken: false, updatedAt: null, rotation: null, issue: null, proxy: { state: "applied", mode: null, since: null }, cluster: { ...CLUSTER, credential: "unknown" }, stats: STATS_EMPTY, enforceRisks: [{ code: "no-observation" }] };
const OBSERVE = {
  mode: "observe",
  hasToken: true,
  updatedAt: NOW,
  rotation: null,
  issue: null,
  proxy: { state: "applied", mode: "observe", since: NOW },
  cluster: CLUSTER,
  stats: { windowHours: 24, since: NOW - 3600_000, authed: 12, missing: 6, bad: 1, denied: 0, targets: [{ target: "chatgpt.com:443", missing: 4, bad: 1, denied: 0, lastAt: NOW }, { target: "api.openai.com:443", missing: 2, bad: 0, denied: 0, lastAt: NOW }], moreTargets: 3, moreRequests: 4 },
  enforceRisks: [
    { code: "unauthenticated", requests: 7, targets: [{ target: "chatgpt.com:443", missing: 4, bad: 1, denied: 0, lastAt: NOW }], moreTargets: 3 },
    { code: "cluster-not-synced", serverName: "主集群", credential: "none" },
  ],
};
const statusOf = (proxyAuth) => ({ egress: { mode: "direct" }, proxyAuth });

test("三种模式各有一句说明；没有感叹号与表情", () => {
  assert.deepEqual(AUTH_MODES.map((item) => [item.mode, item.label]), [["off", "关"], ["observe", "只记录"], ["enforce", "强制"]]);
  for (const text of [...AUTH_MODES.map((item) => item.hint), ENFORCE_NOTICE]) {
    assert.ok(text.length > 10);
    assert.doesNotMatch(text, /[!！]|\p{Extended_Pictographic}/u);
  }
  assert.match(ENFORCE_NOTICE, /已经在运行的 codex \/ claude \/ 作业拿的是旧的环境变量，强制后会断网，需要重开/);
  assert.match(ENFORCE_NOTICE, /reclaude 的 systemd 配置、~\/\.npmrc/);
});

test("describeProxyApplied：本机代理按什么在跑——关着且没有回报时不说话；旧版本代理说清楚要交接", () => {
  assert.equal(describeProxyApplied(OFF), "");
  assert.equal(describeProxyApplied(OBSERVE), "已按「只记录」运行");
  assert.equal(describeProxyApplied({ ...OBSERVE, mode: "enforce", proxy: { state: "pending", mode: "observe" } }), "还在按「只记录」运行，新设置几秒内生效");
  assert.equal(describeProxyApplied({ ...OFF, proxy: { state: "pending", mode: "enforce" } }), "还在按「强制」运行，新设置几秒内生效");
  // 刚从「关」打开：代理的第一份回报还没到，不知道它此刻按什么在跑——只说几秒内生效，不说它是旧版本。
  assert.equal(describeProxyApplied({ ...OBSERVE, proxy: { state: "pending", mode: null } }), "新设置几秒内生效");
  assert.equal(authSettled({ proxy: { state: "pending" } }), false);
  for (const state of ["applied", "unconfirmed", "not-running"]) assert.equal(authSettled({ proxy: { state } }), true, state);
  assert.equal(authSettled(null), true);
  assert.equal(describeProxyApplied({ ...OBSERVE, proxy: { state: "unconfirmed", mode: null } }), "正在运行的是旧版本，不认识口令；平滑交接到新版本后才生效");
  assert.equal(describeProxyApplied({ ...OBSERVE, proxy: { state: "not-running", mode: null } }), "没有运行，启动后按这项设置生效");
  assert.equal(describeProxyApplied({ ...OFF, proxy: { state: "not-running", mode: null } }), "");
  assert.equal(describeProxyApplied(null), "");
});

test("describeCluster：集群上那份配置带的是哪一个口令；还没有口令或没有集群时不说话", () => {
  const withCred = (credential, extra = {}) => describeCluster({ ...OBSERVE, cluster: { ...CLUSTER, credential, ...extra } });
  assert.equal(withCred("current"), "已写入当前口令");
  assert.equal(withCred("none"), "还没有写入口令");
  assert.equal(withCred("previous"), "还是上一个口令（过渡期内仍可用），需要重新写入");
  assert.equal(withCred("other"), "带的不是这台电脑现在的口令，需要重新写入");
  assert.equal(withCred("unverified"), "已带口令，但集群上算不出指纹，核对不了是不是当前的");
  assert.equal(withCred("unknown"), "还没有查到；点「把口令写到集群」会现查一次");
  assert.equal(withCred("unknown", { error: "读取集群配置失败（Connection timed out）" }), "没查到：读取集群配置失败（Connection timed out）");
  assert.equal(withCred("none", { env: "absent" }), "还没有工作台的受管配置，先完成接入引导");
  assert.equal(describeCluster(OFF), "", "还没有口令");
  assert.equal(describeCluster({ ...OBSERVE, cluster: null }), "", "没有团队服务器");
});

test("buildAuthFactsHtml：有内容的行才出；目标名转义", () => {
  assert.equal(buildAuthFactsHtml(OFF), "", "关着、从没记过：一行都没有");
  assert.equal(buildAuthFactsHtml(null), "");
  const html = buildAuthFactsHtml(OBSERVE);
  assert.match(html, /<dt>本机代理<\/dt><dd>已按「只记录」运行<\/dd>/);
  assert.match(html, /<dt>主集群<\/dt><dd>还没有写入口令<\/dd>/);
  assert.match(html, /<dt>近 24 小时<\/dt><dd>带口令 12 次 · 没带 7 次<\/dd>/);
  assert.match(html, /<dt>没带口令的目标<\/dt><dd>chatgpt\.com:443 5 次、api\.openai\.com:443 2 次，另有 3 个目标<\/dd>/);
  assert.doesNotMatch(html, /换口令|口令文件/);

  const enforced = buildAuthFactsHtml({ ...OBSERVE, mode: "enforce", proxy: { state: "applied", mode: "enforce" }, stats: { ...OBSERVE.stats, denied: 5 }, rotation: { until: NOW + 3600_000 } });
  assert.match(enforced, /没带 7 次（已拒绝 5 次）/);
  assert.match(enforced, new RegExp(`<dt>换口令</dt><dd>上一个口令继续可用到 ${formatDeadline(NOW + 3600_000)}</dd>`));

  assert.match(buildAuthFactsHtml({ ...OFF, issue: { state: "invalid", reason: "not-json" } }), /<dt>口令文件<\/dt><dd>内容损坏，这里先按「关」显示/);
  assert.match(buildAuthFactsHtml({ ...OFF, issue: { state: "unreadable", reason: "EACCES" } }), /读不出来/);
  const hostile = buildAuthFactsHtml({ ...OBSERVE, cluster: { ...CLUSTER, serverName: "<img src=x>" }, stats: { ...OBSERVE.stats, targets: [{ target: "<b>x</b>:443", missing: 1, bad: 0 }], moreTargets: 0 } });
  assert.doesNotMatch(hostile, /<img|<b>/);
  assert.equal(describeUnauthenticatedTargets({ targets: [] }), "");
});

test("describeClusterAlert / buildAuthFactsHtml（v2.64）：已是强制而集群口令不同步——集群那一行接上警告、以警告样式显示，指向「把口令写到集群…」", () => {
  assert.equal(describeClusterAlert(null), "");
  assert.equal(describeClusterAlert(undefined), "");
  assert.equal(describeClusterAlert({ code: "something-new" }), "");
  assert.equal(describeClusterAlert({ code: "cluster-not-synced", serverName: "主集群", credential: "none" }), "现在是「强制」：那里新开的终端连不上外网。点下面的「把口令写到集群…」补写");
  assert.match(describeClusterAlert({ code: "cluster-not-synced", serverName: "主集群", credential: "previous" }), /过渡期一过，那里新开的终端就连不上外网/);

  const ENFORCE = { ...OBSERVE, mode: "enforce", proxy: { state: "applied", mode: "enforce" }, enforceRisks: [] };
  const warned = buildAuthFactsHtml({ ...ENFORCE, clusterAlert: { code: "cluster-not-synced", serverName: "主集群", credential: "none" } });
  assert.match(warned, /<div class="eg-fact is-warn"><dt>主集群<\/dt><dd>还没有写入口令。现在是「强制」：那里新开的终端连不上外网。点下面的「把口令写到集群…」补写<\/dd><\/div>/);
  assert.equal((warned.match(/is-warn/g) || []).length, 1, "只有集群那一行");
  const other = buildAuthFactsHtml({ ...ENFORCE, cluster: { ...CLUSTER, credential: "other" }, clusterAlert: { code: "cluster-not-synced", serverName: "主集群", credential: "other" } });
  assert.match(other, /<dd>带的不是这台电脑现在的口令，需要重新写入。现在是「强制」/);
  // 没有警告（只记录、或已写入当前口令）：与以前逐字相同。
  assert.equal(buildAuthFactsHtml({ ...OBSERVE, clusterAlert: null }), buildAuthFactsHtml(OBSERVE));
  assert.doesNotMatch(buildAuthFactsHtml({ ...ENFORCE, cluster: { ...CLUSTER, credential: "current" }, clusterAlert: null }), /is-warn|现在是「强制」/);
  // 服务器名照样转义。
  assert.doesNotMatch(buildAuthFactsHtml({ ...ENFORCE, cluster: { ...CLUSTER, serverName: "<img src=x>" }, clusterAlert: { code: "cluster-not-synced", serverName: "<img src=x>", credential: "none" } }), /<img/);
});

test("describeRisks / buildEnforceConfirmHtml：切强制前把会断的东西一条条说清，末尾总带那段不会自己好的说明", () => {
  const lines = describeRisks(OBSERVE.enforceRisks);
  assert.deepEqual(lines, [
    "近 24 小时还有 7 次请求没带口令：chatgpt.com:443 5 次，另有 3 个目标。强制后它们会被拒绝。",
    "主集群 上的受管配置还没有写入口令：强制后那里新开的终端也连不上外网。先点「把口令写到集群」。",
  ]);
  assert.deepEqual(describeRisks([{ code: "no-observation" }]), ["还没有「只记录」的数据，看不出哪些程序没带口令。建议先开「只记录」用一段时间。"]);
  assert.match(describeRisks([{ code: "cluster-not-synced", serverName: "主集群", credential: "previous" }])[0], /还是上一个口令/);
  assert.deepEqual(describeRisks([{ code: "something-new" }]), []);

  const html = buildEnforceConfirmHtml(OBSERVE.enforceRisks);
  assert.match(html, /近 24 小时还有 7 次请求没带口令/);
  assert.ok(html.includes(ENFORCE_NOTICE));
  assert.match(html, /data-auth-action="confirm-enforce">仍然切到强制<\/button>/);
  assert.match(html, /data-auth-action="cancel">取消<\/button>/);
  // 没有已知风险时也停一下，至少把那段说明给人看。
  assert.ok(buildEnforceConfirmHtml([]).includes(ENFORCE_NOTICE));
});

test("describeSyncPlan / buildSyncPanelHtml：预览列出每个文件改什么；没什么可改时不给「写入」；写完说明新开的终端才生效", () => {
  const plan = { env: { path: "~/.config/cluster-workbench/env.sh", credential: "add", port: null, action: "write" }, claude: { path: "~/.claude/settings.json", action: "write", reason: null, changedKeys: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] } };
  assert.deepEqual(describeSyncPlan(plan), [
    "~/.config/cluster-workbench/env.sh：加上口令（整份重写，权限 600）",
    "~/.claude/settings.json：改 4 个代理键，其余内容不动（先备份，权限收到 600）",
  ]);
  assert.deepEqual(describeSyncPlan({ env: { path: "env.sh", credential: "replace", port: { from: 7900, to: 7891 }, action: "write" }, claude: { path: "settings.json", action: "skip", reason: "reclaude-managed", changedKeys: [] } }), [
    "env.sh：换成当前口令，端口 7900 → 7891（整份重写，权限 600）",
    "settings.json：不改（代理由 reclaude 接管）",
  ]);
  assert.match(describeSyncPlan({ env: { path: "env.sh", credential: "keep", port: null, action: "unchanged" }, claude: { path: "settings.json", action: "skip", reason: "no-claude", changedKeys: [] } }).join("|"), /env\.sh：已是当前口令，不改\|settings\.json：不改（集群上没有 Claude Code）/);

  const preview = buildSyncPanelHtml({ serverName: "主集群", status: "preview", plan, changed: [], warning: null });
  assert.match(preview, /将在 主集群 上：/);
  assert.match(preview, /data-auth-action="confirm-sync">写入<\/button>/);
  assert.match(preview, /只对新开的终端生效/);

  const nothing = buildSyncPanelHtml({ serverName: "主集群", status: "preview", plan: { env: { ...plan.env, credential: "keep", action: "unchanged" }, claude: { ...plan.claude, action: "unchanged", changedKeys: [] } }, changed: [], warning: null });
  assert.doesNotMatch(nothing, /confirm-sync/);
  assert.match(nothing, /主集群 上已经是当前口令，不需要改/);
  assert.equal((nothing.match(/<button/g) || []).length, 1, "只有一个「知道了」");

  const done = buildSyncPanelHtml({ serverName: "主集群", status: "synced", plan, changed: ["~/.config/cluster-workbench/env.sh"], warning: "改写 ~/.claude/settings.json 失败（退出码 1），原文件未改动" });
  assert.match(done, /已写到 主集群：~\/\.config\/cluster-workbench\/env\.sh。新开的终端生效。/);
  assert.match(done, /改写 ~\/\.claude\/settings\.json 失败/);
  assert.doesNotMatch(done, /<button/);
  assert.equal(buildSyncPanelHtml(null), "");
});

test("buildUsageHtml：没有目标时整块为空；有就是一张五列小表，「其它」并在末尾，目标名转义", () => {
  assert.equal(buildUsageHtml(null), "");
  assert.equal(buildUsageHtml({ targets: [], other: null }), "");
  const html = buildUsageHtml({
    targets: [{ target: "api.openai.com:443", connections: 42, up: 1536, down: 5 * 1024 * 1024, lastAt: NOW - 5 * 60_000 }, { target: "<b>:443", connections: 1, up: 0, down: 0, lastAt: 0 }],
    other: { targets: 3, connections: 4, up: 10, down: 20, lastAt: NOW - 3600_000 },
  }, NOW);
  assert.match(html, /<th>目标<\/th><th>连接<\/th><th>上行<\/th><th>下行<\/th><th>最近<\/th>/);
  assert.match(html, /<td class="eg-usage-target">api\.openai\.com:443<\/td><td>42<\/td><td>1\.5 KiB<\/td><td>5 MiB<\/td><td>5 分钟前<\/td>/);
  assert.match(html, /&lt;b&gt;:443<\/td><td>1<\/td><td>0 B<\/td><td>0 B<\/td><td>—<\/td>/, "没有最近时刻的行显示破折号");
  assert.match(html, /<td>其它 3 个目标<\/td><td>4<\/td>/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(buildUsageHtml({ targets: [], other: { targets: 0, connections: 1, up: 1, down: 1, lastAt: NOW } }, NOW), /<td>其它<\/td>/);
});

test("buildRotateConfirmHtml：平时说明旧口令再接受 24 小时；过渡期内再换要多确认一次", () => {
  assert.match(buildRotateConfirmHtml(OBSERVE), /旧口令再接受 24 小时/);
  assert.match(buildRotateConfirmHtml(OBSERVE), /data-auth-action="confirm-rotate">更换/);
  const rotating = buildRotateConfirmHtml({ ...OBSERVE, rotation: { until: NOW } });
  assert.match(rotating, /仍在用上一个口令的程序会立刻断网/);
  assert.match(rotating, /data-auth-action="confirm-rotate-force">仍然更换/);
});

// 假 DOM：index.html 里 #egressAuth 的骨架。
function setup({ getJson, postJson, reload } = {}) {
  const timers = fakeTimers();
  const modeButtons = ["off", "observe", "enforce"].map((mode) => fakeElement({ tag: "button", dataset: { authMode: mode } }));
  const elements = {
    egressAuth: fakeElement({ hidden: true }),
    egressAuthModes: fakeElement({ querySelectorAll: (sel) => (sel === "[data-auth-mode]" ? modeButtons : []) }),
    egressAuthHint: fakeElement(),
    egressAuthFacts: fakeElement(),
    egressAuthActions: fakeElement({ hidden: true }),
    egressAuthSyncBtn: fakeElement({ tag: "button" }),
    egressAuthRotateBtn: fakeElement({ tag: "button" }),
    egressAuthRetireBtn: fakeElement({ tag: "button", hidden: true }),
    egressAuthPanel: fakeElement({ hidden: true }),
    egressUsage: fakeElement({ hidden: true }),
  };
  for (const btn of modeButtons) btn.parent = elements.egressAuthModes;
  const deps = {
    doc: fakeDocument(elements),
    getJson: getJson || spy(async () => ({ windowHours: 24, targets: [{ target: "api.openai.com:443", connections: 3, up: 10, down: 20, lastAt: NOW }], other: null })),
    postJson: postJson || spy(async (_path, body) => statusOf({ ...OBSERVE, mode: body.mode || OBSERVE.mode })),
    showToast: spy(),
    reload: reload || spy(async () => {}),
    now: () => NOW,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  };
  const proxyAuth = createSettingsProxyAuth(deps);
  const pressed = () => modeButtons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.authMode);
  const clickMode = (mode) => elements.egressAuthModes.dispatch("click", { target: modeButtons.find((b) => b.dataset.authMode === mode) });
  const clickPanel = (action) => elements.egressAuthPanel.dispatch("click", { target: fakeElement({ tag: "button", dataset: { authAction: action } }) });
  return { proxyAuth, elements, deps, pressed, clickMode, clickPanel, timers };
}

test("服务端没有这项能力（proxyAuth 为空）：整块不显示，不发任何请求", async () => {
  const ctx = setup();
  await ctx.proxyAuth.setStatus({ egress: { mode: "direct" } });
  assert.equal(ctx.elements.egressAuth.hidden, true);
  await ctx.proxyAuth.setStatus(null);
  assert.equal(ctx.elements.egressAuth.hidden, true);
  assert.deepEqual(ctx.deps.getJson.calls, []);
});

test("关着、从没记过：只有模式与说明；没有动作行、没有表、不读使用记录", async () => {
  const ctx = setup();
  await ctx.proxyAuth.setStatus(statusOf(OFF));
  assert.equal(ctx.elements.egressAuth.hidden, false);
  assert.deepEqual(ctx.pressed(), ["off"]);
  assert.equal(ctx.elements.egressAuthHint.textContent, AUTH_MODES[0].hint);
  assert.equal(ctx.elements.egressAuthFacts.innerHTML, "");
  assert.equal(ctx.elements.egressAuthActions.hidden, true);
  assert.equal(ctx.elements.egressAuthPanel.hidden, true);
  assert.equal(ctx.elements.egressUsage.hidden, true);
  assert.deepEqual(ctx.deps.getJson.calls, [], "没有东西可看就不发这个请求");
});

test("只记录中：事实行、动作行、使用记录小表（每次打开只读一次）", async () => {
  const ctx = setup();
  ctx.proxyAuth.onOpen();
  await ctx.proxyAuth.setStatus(statusOf(OBSERVE));
  assert.deepEqual(ctx.pressed(), ["observe"]);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /带口令 12 次 · 没带 7 次/);
  assert.equal(ctx.elements.egressAuthActions.hidden, false);
  assert.equal(ctx.elements.egressAuthSyncBtn.hidden, false);
  assert.equal(ctx.elements.egressAuthRetireBtn.hidden, true);
  assert.deepEqual(ctx.deps.getJson.calls, [["/api/egress/usage"]]);
  assert.equal(ctx.elements.egressUsage.hidden, false);
  assert.match(ctx.elements.egressUsage.innerHTML, /api\.openai\.com:443/);
  // 同一次打开里状态再刷新（出网一节重读）：不重复读使用记录。
  await ctx.proxyAuth.setStatus(statusOf(OBSERVE));
  assert.equal(ctx.deps.getJson.calls.length, 1);
  // 没有团队服务器：没有「写到集群」。
  await ctx.proxyAuth.setStatus(statusOf({ ...OBSERVE, cluster: null }));
  assert.equal(ctx.elements.egressAuthSyncBtn.hidden, true);
  // 之后变成没有东西可看（关着、记录也过了 24 小时）：之前那张表收起来，不留过时的内容。
  await ctx.proxyAuth.setStatus(statusOf(OFF));
  assert.equal(ctx.elements.egressUsage.hidden, true);
  assert.equal(ctx.elements.egressUsage.innerHTML, "");
  assert.equal(ctx.deps.getJson.calls.length, 1, "收起不需要再发请求");
});

test("已是强制而集群口令不同步（v2.64）：事实行里是警告，补写入口就是那个「把口令写到集群…」按钮，点了走原来的预览流程", async () => {
  const enforced = { ...OBSERVE, mode: "enforce", proxy: { state: "applied", mode: "enforce" }, enforceRisks: [], clusterAlert: { code: "cluster-not-synced", serverName: "主集群", credential: "none" } };
  const postJson = spy(async () => ({ proxyAuth: enforced, sync: { serverId: "server-01", serverName: "主集群", status: "preview", plan: { env: { path: "~/.config/cluster-workbench/env.sh", credential: "add", port: null, action: "write" }, claude: { path: "~/.claude/settings.json", action: "skip", reason: "no-claude", changedKeys: [] } }, changed: [], warning: null } }));
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf(enforced));
  assert.deepEqual(ctx.pressed(), ["enforce"]);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /class="eg-fact is-warn"><dt>主集群<\/dt><dd>还没有写入口令。现在是「强制」/);
  assert.equal(ctx.elements.egressAuthActions.hidden, false);
  assert.equal(ctx.elements.egressAuthSyncBtn.hidden, false, "补写入口：沿用已有的按钮");
  ctx.elements.egressAuthSyncBtn.dispatch("click", {});
  await flush();
  assert.deepEqual(postJson.calls[0], ["/api/egress/proxy-auth/sync", {}], "先预览（只读），确认了才写");
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /env\.sh：加上口令/);
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /data-auth-action="confirm-sync">写入/);
  // 写好之后服务端不再给警告：那一行回到普通样式。
  await ctx.proxyAuth.setStatus(statusOf({ ...enforced, cluster: { ...CLUSTER, credential: "current" }, clusterAlert: null }));
  assert.doesNotMatch(ctx.elements.egressAuthFacts.innerHTML, /is-warn/);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /<dd>已写入当前口令<\/dd>/);
});

test("关 → 只记录：直接保存，回显重渲，提示里说明生成了口令，并让「出网」一节重读", async () => {
  const postJson = spy(async () => ({ ...statusOf(OBSERVE), proxyAuthResult: { action: "mode", created: true, reset: false } }));
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf(OFF));
  await ctx.clickMode("observe");
  await flush();
  assert.deepEqual(postJson.calls, [["/api/egress/proxy-auth", { mode: "observe" }]]);
  assert.deepEqual(ctx.pressed(), ["observe"]);
  assert.deepEqual(ctx.deps.showToast.calls.at(-1), [{ type: "success", title: "代理口令", message: "已生成口令。已改为「只记录」，本机代理几秒内生效" }]);
  assert.equal(ctx.deps.reload.calls.length, 1);
  assert.equal(ctx.timers.timeouts.size, 0, "回显里本机代理已有定论：不排重读");
  // 点已经按下的那个：不发请求。
  await ctx.clickMode("observe");
  assert.equal(postJson.calls.length, 1);
});

test("改完模式后隔几秒重读，直到本机代理有了定论；一直没有也只读有限几次；重读不重写正开着的确认面板", async () => {
  const pendingAuth = { ...OBSERVE, proxy: { state: "pending", mode: null, since: null } };
  const postJson = spy(async () => ({ ...statusOf(pendingAuth), proxyAuthResult: { action: "mode", created: true, reset: false } }));
  // 重读由「出网」一节做：它读回 /api/egress 后把状态交回来（这里用 reload 的替身模拟这条回路）。
  const looped = (state) => {
    const made = setup({ postJson, reload: spy(async () => { await made.proxyAuth.setStatus(statusOf(state.next)); }) });
    return made;
  };
  const loop = { next: pendingAuth };
  const ctx = looped(loop);
  await ctx.proxyAuth.setStatus(statusOf(OFF));
  await ctx.clickMode("observe");
  await flush();
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /<dt>本机代理<\/dt><dd>新设置几秒内生效<\/dd>/);
  assert.equal(ctx.deps.reload.calls.length, 1, "动作成功后立刻重读一次");
  assert.deepEqual([...ctx.timers.timeouts.values()].map((t) => t.ms), [AUTH_SETTLE_MS], "还没有定论：排一次重读");

  // 这期间用户点开了「强制」的确认面板：重读只更新事实行，面板那块 DOM 不重写。
  await ctx.clickMode("enforce");
  let panelWrites = 0;
  const box = ctx.elements.egressAuthPanel;
  let html = box.innerHTML;
  Object.defineProperty(box, "innerHTML", { get: () => html, set: (value) => { panelWrites += 1; html = value; }, configurable: true });
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.deps.reload.calls.length, 2);
  assert.equal(panelWrites, 0, "确认面板没有被重写");
  assert.equal(box.hidden, false);
  assert.equal(ctx.timers.timeouts.size, 1, "仍没有定论：再排一次");

  // 代理的回报到了：改成已生效，不再重读。
  loop.next = OBSERVE;
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.deps.reload.calls.length, 3);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /已按「只记录」运行/);
  assert.equal(ctx.timers.timeouts.size, 0, "已有定论：不再排");

  // 一直没有定论（代理没读到新文件）：只读 AUTH_SETTLE_TRIES 次就停。
  const stuck = looped({ next: pendingAuth });
  await stuck.proxyAuth.setStatus(statusOf(OFF));
  await stuck.clickMode("observe");
  await flush();
  for (let i = 0; i < AUTH_SETTLE_TRIES + 3; i += 1) {
    stuck.timers.runTimeouts();
    await flush();
  }
  assert.equal(stuck.deps.reload.calls.length, 1 + AUTH_SETTLE_TRIES);
  assert.equal(stuck.timers.timeouts.size, 0);
  assert.ok(AUTH_SETTLE_MS * AUTH_SETTLE_TRIES > 8000, "最后一次重读要落在服务端那段宽限（8 秒）之后，才分得清旧版本代理");
});

test("切到强制：先出确认面板、不发请求；取消就收起；确认才带 confirm 发出去", async () => {
  const postJson = spy(async () => statusOf({ ...OBSERVE, mode: "enforce", proxy: { state: "pending", mode: "observe" }, enforceRisks: [] }));
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf(OBSERVE));
  await ctx.clickMode("enforce");
  assert.deepEqual(postJson.calls, [], "还没确认");
  assert.equal(ctx.elements.egressAuthPanel.hidden, false);
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /近 24 小时还有 7 次请求没带口令/);
  assert.ok(ctx.elements.egressAuthPanel.innerHTML.includes(ENFORCE_NOTICE));
  assert.deepEqual(ctx.pressed(), ["observe"], "按下态没有变");

  await ctx.clickPanel("cancel");
  assert.equal(ctx.elements.egressAuthPanel.hidden, true);
  assert.deepEqual(postJson.calls, []);

  await ctx.clickMode("enforce");
  await ctx.clickPanel("confirm-enforce");
  await flush();
  assert.deepEqual(postJson.calls, [["/api/egress/proxy-auth", { mode: "enforce", confirm: true }]]);
  assert.deepEqual(ctx.pressed(), ["enforce"]);
  assert.equal(ctx.elements.egressAuthPanel.hidden, true);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /还在按「只记录」运行，新设置几秒内生效/);
});

test("服务端仍要求确认（切换前状态变了）：重读一次，按最新的风险清单再问；其它失败如实提示、状态不变", async () => {
  let fail = Object.assign(new Error("HTTP 409"), { status: 409, code: "confirm-required", serverMessage: "切到「强制」前请先确认" });
  const postJson = spy(async () => { throw fail; });
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf({ ...OBSERVE, enforceRisks: [] }));
  await ctx.clickMode("enforce");
  await ctx.clickPanel("confirm-enforce");
  await flush();
  assert.equal(ctx.deps.reload.calls.length, 1);
  assert.equal(ctx.elements.egressAuthPanel.hidden, false, "又回到确认面板");
  assert.deepEqual(ctx.pressed(), ["observe"]);

  fail = Object.assign(new Error("HTTP 500"), { status: 500, serverMessage: "口令文件读不出来（EACCES），没有改动任何设置" });
  await ctx.clickMode("off");
  await flush();
  assert.deepEqual(ctx.deps.showToast.calls.at(-1), [{ type: "error", title: "代理口令", message: "没有改成：口令文件读不出来（EACCES），没有改动任何设置" }]);
  assert.deepEqual(ctx.pressed(), ["observe"]);
});

test("把口令写到集群：先预览（不带 confirm），面板列出要改的文件；点「写入」才带 confirm；失败原因原样给出", async () => {
  const plan = { env: { path: "~/.config/cluster-workbench/env.sh", credential: "add", port: null, action: "write" }, claude: { path: "~/.claude/settings.json", action: "skip", reason: "no-claude", changedKeys: [] } };
  const postJson = spy(async (_path, body) => ({
    sync: { serverId: "server-01", serverName: "主集群", status: body.confirm ? "synced" : "preview", plan, changed: body.confirm ? [plan.env.path] : [], warning: null },
    proxyAuth: { ...OBSERVE, cluster: { ...CLUSTER, credential: body.confirm ? "current" : "none" } },
  }));
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf(OBSERVE));
  await ctx.elements.egressAuthSyncBtn.dispatch("click");
  assert.deepEqual(postJson.calls, [["/api/egress/proxy-auth/sync", {}]]);
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /env\.sh：加上口令/);
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /settings\.json：不改（集群上没有 Claude Code）/);
  assert.equal(ctx.deps.reload.calls.length, 0, "预览不触发重读");

  await ctx.clickPanel("confirm-sync");
  assert.deepEqual(postJson.calls.at(-1), ["/api/egress/proxy-auth/sync", { confirm: true }]);
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /已写到 主集群/);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /<dt>主集群<\/dt><dd>已写入当前口令<\/dd>/);
  assert.equal(ctx.deps.reload.calls.length, 1);

  const failing = setup({ postJson: spy(async () => { throw Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "集群上还没有工作台的受管配置（~/.config/cluster-workbench/env.sh），先完成接入引导的「写集群侧配置」一步" }); }) });
  await failing.proxyAuth.setStatus(statusOf(OBSERVE));
  await failing.elements.egressAuthSyncBtn.dispatch("click");
  assert.match(failing.elements.egressAuthPanel.innerHTML, /集群上还没有工作台的受管配置/);
  assert.equal(failing.elements.egressAuthSyncBtn.disabled, false, "失败后按钮恢复可点");
});

test("换口令：先说明再确认；过渡期内出现「停用旧口令」", async () => {
  const rotated = { ...OBSERVE, rotation: { until: NOW + 24 * 3600_000 } };
  const postJson = spy(async (_path, body) => statusOf(body.retirePrevious ? OBSERVE : rotated));
  const ctx = setup({ postJson });
  await ctx.proxyAuth.setStatus(statusOf(OBSERVE));
  await ctx.elements.egressAuthRotateBtn.dispatch("click");
  assert.match(ctx.elements.egressAuthPanel.innerHTML, /旧口令再接受 24 小时/);
  assert.deepEqual(postJson.calls, []);
  await ctx.clickPanel("confirm-rotate");
  await flush();
  assert.deepEqual(postJson.calls, [["/api/egress/proxy-auth", { rotate: true }]]);
  assert.equal(ctx.elements.egressAuthRetireBtn.hidden, false);
  assert.match(ctx.elements.egressAuthFacts.innerHTML, /上一个口令继续可用到/);

  await ctx.elements.egressAuthRetireBtn.dispatch("click");
  await flush();
  assert.deepEqual(postJson.calls.at(-1), ["/api/egress/proxy-auth", { retirePrevious: true }]);
  assert.equal(ctx.elements.egressAuthRetireBtn.hidden, true);
});
