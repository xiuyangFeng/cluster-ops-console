import assert from "node:assert/strict";
import test from "node:test";
import { buildClusterPanelModel } from "./cluster-model.js";
import { buildGroupedJobRowsHtml, buildHistoryRowsHtml } from "./cluster-view.js";
import { buildHistoryModel } from "./cluster-history-model.js";
import { applyRulesPatch, buildNotificationListHtml, buildResourceReviewHtml, buildRulesHtml, buildWatchButton, buildWatchListHtml, noticeTarget, progressText, rulesSummaryText, syncRuleInputs } from "./job-watch-view.js";

test("关注按钮只覆盖本人作业，折叠实验组保留精确的当前成员", () => {
  const raw = ["1", "2", "3"].map((id) => ({ id, name: "exp", user: "me", state: "RUNNING", elapsedSec: 60 }));
  raw.push({ id: "4", name: "other", user: "other", state: "RUNNING" });
  const model = buildClusterPanelModel({ layer: { slurm: { state: "ok", user: "me", jobs: raw, nodes: [] } } });
  const group = model.jobRows.find((row) => row.kind === "group");
  assert.deepEqual(group.jobIds, ["1", "2", "3"]);
  const html = buildGroupedJobRowsHtml(model.jobRows, "", { watches: new Set() });
  assert.match(html, /data-job-watch="1,2,3"/);
  assert.doesNotMatch(html, /data-job-watch="4"/);
  assert.equal(buildWatchButton({ ids: ["10_[1-9]"] }), "", "压缩数组不能被当作独立作业关注");
  assert.match(buildWatchButton({ ids: ["1"], watched: true }), / disabled/);
  const individuallyWatched = buildGroupedJobRowsHtml(model.jobRows, "", { watches: new Set(["1", "2", "3"]), watchGroups: new Set(["1", "2", "3"]) });
  assert.match(individuallyWatched, /data-job-watch="1,2,3"[^>]*>关注此组/);
  const groupWatched = buildGroupedJobRowsHtml(model.jobRows, "", { watches: new Set(["1", "2", "3"]), watchGroups: new Set(["1,2,3"]) });
  assert.match(groupWatched, /data-job-watch="1,2,3"[^>]* disabled/);
});

test("进度只展示实测 step/epoch，零值保留，静默不直接宣称卡死", () => {
  const text = progressText({ status: "quiet", step: 0, epoch: null });
  assert.match(text, /日志暂未更新.*Step 0/);
  assert.doesNotMatch(text, /Epoch|卡死/);
  const html = buildWatchListHtml({ watches: [{ id: "w", label: "<img>", jobIds: ["1"], jobs: [{ id: "1", name: "<script>", state: "RUNNING", progress: { status: "stalled", tail: "<img src=x onerror=alert(1)>", path: "<script>" } }] }] }, { expanded: new Set(["1"]) });
  assert.match(html, /疑似停滞/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script>/);
});

test("资源缺测显示未知而非零，已完成历史行可直接打开复盘", () => {
  const empty = buildResourceReviewHtml(null);
  assert.equal((empty.match(/<dd>未知<\/dd>/g) || []).length, 10);
  assert.match(buildResourceReviewHtml({ cpuEfficiency: 0, maxRssBytes: 0 }), /<dd>0%<\/dd>/);
  assert.match(buildResourceReviewHtml({ cpuEfficiency: 0.625 }), /62.5%/);
  const history = buildHistoryModel({ data: { state: "ok", summary: {}, rows: [{ kind: "job", id: "12", state: "COMPLETED", outcome: "completed", name: "run", endAt: 100, elapsedSec: 60 }] } });
  const html = buildHistoryRowsHtml(history.rows, "", { resources: new Map(), resourceOpen: new Set(["12"]) });
  assert.match(html, /data-job-resource="12"/);
  assert.match(html, /jw-review-row/);
  assert.match(html, /<dd>未知<\/dd>/);
});

test("提醒收件箱转义远端文本与 ID，已读状态可辨认", () => {
  const html = buildNotificationListHtml({ notifications: [{ id: '" onclick=alert(1)', title: "<script>", body: "<img>", createdAt: 1, readAt: 2 }] }, 100);
  assert.doesNotMatch(html, /<script>|<img>|data-unread/);
  assert.match(html, /&quot; onclick=alert\(1\)/);
  assert.match(html, /已读/);
});

test("关注列表与提醒收件箱的空状态：没有关注 / 读取失败 / 还在读取 / 没有提醒各自说清楚", () => {
  const none = buildWatchListHtml({ watches: [] });
  assert.match(none, /^<div class="empty-state is-compact" data-tone="neutral">/);
  assert.match(none, /<p class="empty-state-title">还没有关注的作业<\/p>/);
  assert.match(none, /点自己作业行上的「关注」，或关注整个实验组。只有关注的作业会采集日志进度/);
  const failed = buildWatchListHtml(null, { error: "<b>HTTP 500</b>" });
  assert.match(failed, /data-tone="error"/);
  assert.match(failed, /暂时取不到关注列表/);
  assert.match(failed, /&lt;b&gt;HTTP 500&lt;\/b&gt;；稍后会自动重试。/);
  assert.equal(buildWatchListHtml(null, { loading: true }), '<p class="jw-note">正在读取关注列表…</p>', "读取中不是空状态");
  assert.match(buildWatchListHtml({ disabled: true }), /模块已关闭/);

  const inbox = buildNotificationListHtml({ notifications: [] });
  assert.match(inbox, /<p class="empty-state-title">还没有作业提醒<\/p>/);
  assert.match(inbox, /开始、结束、临近时限和疑似停滞会记录在这里/);
  assert.doesNotMatch(inbox, /还没有关注/, "收件箱不知道有没有关注，不下这个结论");
});

// ---- v2.62 提醒规则 ----

test("自动组带「自动」标记、可静音，移除入口是「停用这条规则」；手动组照旧", () => {
  const job = { id: "1", name: "xp_a", state: "RUNNING", outcome: "running", progress: { status: "ok" } };
  const html = buildWatchListHtml({ watches: [
    { id: "m", label: "手动的", jobIds: ["9"], muted: false, jobs: [{ ...job, id: "9" }] },
    { id: "a", label: "xp_<*>", jobIds: ["1"], muted: true, auto: { rule: "name:xp_<*>" }, jobs: [job] },
  ] });
  const [manual, auto] = html.split('<section class="jw-watch"').slice(1);
  assert.match(manual, /data-watch-id="m"/);
  assert.doesNotMatch(manual, /class="badge"|data-auto|data-watch-auto|停用这条规则/);
  assert.match(manual, /<button type="button" class="text-btn" data-watch-remove="m">取消关注<\/button>/);
  assert.match(auto, /data-watch-id="a" data-auto="true"/);
  assert.match(auto, /<strong>xp_&lt;\*&gt;<\/strong><span class="badge" title="按提醒规则自动关注：疑似停滞、临近时限、子任务非零退出和这一批全部结束时提醒">自动<\/span>/);
  // 长作业规则的组没有「这一批结束」的说法（2026-10-12 审查第 2 条）。
  const longRun = buildWatchListHtml({ watches: [{ id: "l", label: "运行超过 120 分钟的作业", jobIds: ["1"], muted: false, auto: { rule: "longRun" }, jobs: [job] }] });
  assert.match(longRun, /<span class="badge" title="按提醒规则自动关注：疑似停滞、临近时限、子任务非零退出时提醒，结束时不提醒">自动<\/span>/);
  assert.match(auto, /已静音/);
  assert.match(auto, /data-watch-mute="a" data-muted="true">取消静音/);
  assert.match(auto, /<button type="button" class="text-btn" data-watch-remove="a" data-watch-auto="true">停用这条规则<\/button>/);
  assert.doesNotMatch(auto, /取消关注/);
  assert.match(auto, /data-watch-job-id="1"/, "组里的作业与手动关注同一种行");
  assert.match(buildWatchListHtml({ watches: [] }), /在侧栏「作业提醒」的提醒规则里设置/);
});

test("规则改动先按界面这边的理解应用上（保存在途时的显示）：只动提交的那一项，名字规则只加 / 只删一条", () => {
  const rules = { failNotify: true, longRunMinutes: 120, patterns: ["xp_*", "cfa-*"] };
  assert.deepEqual(applyRulesPatch(rules, { failNotify: false }), { failNotify: false, longRunMinutes: 120, patterns: ["xp_*", "cfa-*"] });
  assert.deepEqual(applyRulesPatch(rules, { longRunMinutes: null }), { failNotify: true, longRunMinutes: null, patterns: ["xp_*", "cfa-*"] });
  assert.deepEqual(applyRulesPatch(rules, { longRunMinutes: 30 }).longRunMinutes, 30);
  assert.deepEqual(applyRulesPatch(rules, { addPattern: "lora_*" }).patterns, ["xp_*", "cfa-*", "lora_*"]);
  assert.deepEqual(applyRulesPatch(rules, { addPattern: "xp_*" }).patterns, ["xp_*", "cfa-*"]);
  assert.deepEqual(applyRulesPatch(rules, { removePattern: "xp_*" }).patterns, ["cfa-*"]);
  assert.deepEqual(applyRulesPatch(undefined, { addPattern: "a_*" }), { failNotify: true, longRunMinutes: null, patterns: ["a_*"] }, "没有规则按默认起算");
  assert.deepEqual(applyRulesPatch(rules, null), rules);
  assert.deepEqual(rules.patterns, ["xp_*", "cfa-*"], "不改入参");
});

test("提醒规则一节：默认收起只写一句现状；展开后是开关、阈值、名字规则与建议；值不写进 HTML", () => {
  assert.equal(rulesSummaryText({ failNotify: true, longRunMinutes: null, patterns: [] }), "失败提醒已开 · 没有自动关注的规则");
  assert.equal(rulesSummaryText({ failNotify: false, longRunMinutes: 120, patterns: ["a", "b"] }), "失败提醒已关 · 2 条名字规则 · 运行超过 120 分钟自动关注");
  assert.equal(rulesSummaryText(undefined), "失败提醒已开 · 没有自动关注的规则", "没给规则按默认说");

  const server = {
    serverId: "server-01", name: "主集群服务器 (myserver)",
    rules: { failNotify: true, longRunMinutes: 120, patterns: ["cfdauto_*", '"><img src=x>'] },
    suggestions: [{ prefix: "xp_wallgate", pattern: "xp_wallgate*", count: 5 }, { prefix: "cfdauto_", pattern: "cfdauto_*", count: 132 }, { prefix: "<b>", pattern: "<b>*", count: "<i>" }],
  };
  const closed = buildRulesHtml([server]);
  assert.match(closed, /^<section class="jw-rules" data-rules-server="server-01"><div class="jw-rules-head">/);
  assert.match(closed, /data-rules-toggle="server-01" aria-expanded="false">提醒规则<\/button>/);
  assert.match(closed, /失败提醒已开 · 2 条名字规则 · 运行超过 120 分钟自动关注/);
  assert.doesNotMatch(closed, /jw-rules-body|<input|<form/, "收起时没有任何控件");
  assert.equal(buildRulesHtml([]), "");
  assert.equal(buildRulesHtml(undefined), "", "旧后端不带 servers：整节不出现");
  assert.equal(buildRulesHtml([null, { name: "没有 id" }]), "");

  const open = buildRulesHtml([server], { open: new Set(["server-01"]) });
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<input type="checkbox" role="switch" class="jw-rule-switch" data-rule-fail="server-01" aria-label="作业失败时提醒">/);
  assert.match(open, /<input type="number" min="10" max="10080" step="1" inputmode="numeric" placeholder="关" data-rule-long="server-01"/);
  assert.doesNotMatch(open, / checked| value=/, "勾选与数值由控制器在渲染后按数据设置");
  assert.match(open, /<li><code>cfdauto_\*<\/code><button type="button" class="text-btn" data-rule-remove="cfdauto_\*" data-rule-server="server-01">移除<\/button><\/li>/);
  assert.match(open, /<form class="jw-rule-add" data-rule-add="server-01"><input type="text" name="pattern" maxlength="64"/);
  assert.match(open, /data-rule-suggest="xp_wallgate\*" data-rule-server="server-01" title="近 7 天的作业里有 5 个会被这条规则命中，点一下加入">xp_wallgate\*<span>5<\/span>/);
  assert.doesNotMatch(open, /data-rule-suggest="cfdauto_\*"/, "已经是规则的不再当建议");
  assert.doesNotMatch(open, /<img|<b>|<i>/, "规则、建议与个数全部转义");
  assert.match(open, /&quot;&gt;&lt;img src=x&gt;/);
  // 各条规则会在什么时候提醒，照实写（2026-10-12 审查后的口径）：长作业不报结束；名字规则多一条「这一批全部结束」；
  // 排队中的不占名额；静音的组里的作业失败也不提醒。
  assert.match(open, /运行超过这个时长的作业自动进入关注：疑似停滞、临近时限、子任务非零退出时提醒，结束时不提醒。留空为关。/);
  assert.match(open, /作业名匹配的开始运行后自动进入关注：疑似停滞、临近时限、子任务非零退出时提醒，这一批全部结束时再提醒一次。/);
  assert.match(open, /自动关注不逐个报开始和结束；合计最多 60 个在跑或刚结束的作业，排队中的不占名额。/);
  assert.match(open, /静音的关注组里的作业，失败时也不再提醒。/);
  assert.doesNotMatch(open, /！|!/, "不用感叹号");

  // 没有名字规则：列表还在只是藏起来（增删时输入框位置不变）；没有建议就没有那一行。
  const bare = buildRulesHtml([{ serverId: "s", rules: { failNotify: false, longRunMinutes: null, patterns: [] }, suggestions: [] }], { open: new Set(["s"]) });
  assert.match(bare, /<ul class="jw-rule-list" hidden><\/ul><form class="jw-rule-add" data-rule-add="s">/);
  assert.doesNotMatch(bare, /jw-rule-suggest/);
  // 到 12 条：不再给添加与建议。
  const full = buildRulesHtml([{ serverId: "s", rules: { patterns: Array.from({ length: 12 }, (_, i) => `p${i}_*`) }, suggestions: [{ pattern: "more*", count: 3 }] }], { open: new Set(["s"]) });
  assert.match(full, /<form class="jw-rule-add" data-rule-add="s" hidden>/);
  assert.doesNotMatch(full, /jw-rule-suggest/);
  // 保存在途：控件全部禁用。
  const busy = buildRulesHtml([server], { open: new Set(["server-01"]), busy: true });
  assert.equal((busy.match(/<(?:input|button)[^>]* disabled>/g) || []).length, 3 + 2 + 1 + 2, "开关、阈值、输入框 + 两条移除 + 添加 + 两条建议，都禁用");
  assert.doesNotMatch(busy, /data-rules-toggle="server-01"[^>]* disabled/, "展开 / 收起不受影响");

  // 多台服务器：标题带界面用名。
  const two = buildRulesHtml([server, { serverId: "server-02", name: "二号集群服务器 (hpc2)", rules: {} }]);
  assert.match(two, /提醒规则 · 主集群<\/button>/);
  assert.match(two, /提醒规则 · 二号集群<\/button>/);
});

test("规则输入框的状态在渲染后按数据设回去，正在编辑的那个不动", () => {
  const fail = { dataset: { ruleFail: "s1" }, checked: false };
  const long = { dataset: { ruleLong: "s1" }, value: "" };
  const editing = { dataset: { ruleLong: "s2" }, value: "4" };
  const stranger = { dataset: { ruleFail: "s9" }, checked: false };
  const root = { querySelectorAll: (selector) => (selector === "[data-rule-fail]" ? [fail, stranger] : [long, editing]) };
  const servers = [{ serverId: "s1", rules: { failNotify: true, longRunMinutes: 120, patterns: [] } }, { serverId: "s2", rules: { failNotify: true, longRunMinutes: 45, patterns: [] } }];
  syncRuleInputs(root, servers, editing);
  assert.deepEqual([fail.checked, long.value, editing.value, stranger.checked], [true, "120", "4", false]);
  syncRuleInputs(root, [{ serverId: "s1", rules: { failNotify: false, longRunMinutes: null } }, servers[1]], null);
  assert.deepEqual([fail.checked, long.value, editing.value], [false, "", "45"]);
  assert.doesNotThrow(() => syncRuleInputs(null, servers));
  assert.doesNotThrow(() => syncRuleInputs({}, undefined));
});

test("失败提醒不属于任何关注组：收件箱照常显示，点开去「我的历史」；空状态按规则照实说", () => {
  const failed = { id: "f1", serverId: "s", watchId: null, kind: "failed", title: "3 个作业失败", body: "2 个 KeyError: 'arm'，1 个超出时限。作业号 3005、3004、3003。", jobIds: ["3005", "3004", "3003"], createdAt: 50, readAt: null, intro: true };
  const html = buildNotificationListHtml({ notifications: [failed, { id: "w1", serverId: "s", watchId: "w", kind: "ended", title: "实验组 全部完成", body: "", jobIds: ["1"], createdAt: 40, readAt: 60 }] }, 100);
  assert.match(html, /<li class="jw-notice" data-unread="true"><div class="jw-notice-heading"><strong>3 个作业失败<\/strong>/);
  assert.match(html, /KeyError: &#039;arm&#039;/);
  assert.match(html, /data-notice-open="f1">查看作业<\/button><button type="button" class="text-btn" data-notice-read="f1">标为已读/);
  assert.equal(noticeTarget(failed), "history");
  assert.equal(noticeTarget({ kind: "ended", watchId: "w" }), null);
  assert.equal(noticeTarget({ kind: "stalled", watchId: null }), null);
  assert.equal(noticeTarget(null), null);

  const on = buildNotificationListHtml({ notifications: [], servers: [{ serverId: "s", rules: { failNotify: true } }] });
  assert.match(on, /我的作业失败时会自动记录在这里，不用先关注。关注作业后，开始、结束、临近时限和疑似停滞会记录在这里/);
  assert.match(on, /或在上面的提醒规则里按名字、运行时长自动关注。/);
  const off = buildNotificationListHtml({ notifications: [], servers: [{ serverId: "s", rules: { failNotify: false } }] });
  assert.doesNotMatch(off, /失败时会自动记录/, "关着就不许诺");
  assert.match(off, /在上面的提醒规则里/);
  assert.doesNotMatch(buildNotificationListHtml({ notifications: [] }), /提醒规则|失败时会自动记录/, "没有可设规则的服务器时不提这一节");
});


test("资源建议与可复制脚本的远端文本全部转义，坏评估条目不致崩溃", () => {
  const html = buildResourceReviewHtml({ assessments: [null, { resource: "<img>", kind: 'risk" onclick="bad', text: "<script>" }], sbatch: "#SBATCH --mem=1G\n<script>alert(1)</script>", adviceNote: "<b>" });
  assert.doesNotMatch(html, /<img>|<script>|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-copy-sbatch/);
});
