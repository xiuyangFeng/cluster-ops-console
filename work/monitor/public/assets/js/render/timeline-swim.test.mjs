// 状态时间线泳道：按「基线 + 变更」还原、分段、统计与界面用名。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSwimModel, createViewResolver, laneDefs, laneSegments, laneStats, laneStatText, layerOfKey, objectLabel, reasonLabel,
  reconstructLanes, spanText, swimHtml, toneOfLevel,
} from "./timeline-swim.js";

const H = 3600e3;
const MIN = 60e3;
const DAY = Date.parse("2026-10-02T00:00:00+08:00");
const STATUS = {
  activeServerId: "server-01",
  serversBrief: {
    "server-01": { displayName: "主集群服务器 (myserver)", name: "myserver" },
    "server-aliyun": { displayName: "阿里云服务器 (vpn-aliyun)", name: "vpn-aliyun" },
  },
  agents: [{ id: "codex", name: "Codex" }, { id: "claude-codewing", name: "Claude CodeWing" }],
};
const baseline = (ts, cause, view, levels) => ({ type: "levels", ts, cause, view, levels });
const change = (ts, key, from, to, reason = "") => ({ type: "transition", ts, key, from, to, reason });
const HEALTHY = { channel: "ok", "tunnel:server-aliyun": "ok", "agent:codex": "ok", "res:server-01": "ok", "res:validation:server-01": "ok" };
const lane = (result, key) => result.lanes.get(key)?.map((p) => [(p.t - DAY) / H, p.level]);

test("reasonLabel: 状态码与探针报错换成界面用语，中文句子与认不出的原样保留", () => {
  assert.equal(reasonLabel("ready"), "就绪");
  assert.equal(reasonLabel("degraded"), "降级");
  assert.equal(reasonLabel("auth-required"), "需登录");
  assert.equal(reasonLabel("degraded；凭证即将过期（约 3 天后），建议尽快在服务器上执行 codex login"), "降级；凭证即将过期（约 3 天后），建议尽快在服务器上执行 codex login");
  assert.equal(reasonLabel("timeout after 25000ms"), "检测超时（25 秒）");
  assert.equal(reasonLabel("probe disabled"), "检测已停用");
  assert.equal(reasonLabel("通道异常，熔断跳过"), "通道异常，熔断跳过");
  assert.equal(reasonLabel("采集失败 (ssh exit 255)"), "采集失败 (ssh exit 255)");
  assert.equal(reasonLabel(""), "");
  assert.equal(reasonLabel(undefined), "");
});

test("objectLabel / layerOfKey: 内部键换成界面上的名字；查不到的对象退回原 id", () => {
  const opts = { status: STATUS };
  assert.equal(objectLabel("agent:claude-codewing", opts), "Claude CodeWing");
  assert.equal(objectLabel("tunnel:server-aliyun", opts), "阿里云");
  assert.equal(objectLabel("res:server-01", opts), "主集群");
  assert.equal(objectLabel("res:validation:server-01", opts), "环境校验 · 主集群");
  assert.equal(objectLabel("channel", opts), "", "不知道当时查看的是哪台时不乱写");
  assert.equal(objectLabel("channel", { status: STATUS, view: "server-aliyun" }), "阿里云");
  assert.equal(objectLabel("agent:ghost", opts), "ghost");
  assert.equal(objectLabel("tunnel:gone", {}), "gone");
  assert.deepEqual(["channel", "agent:codex", "tunnel:x", "res:x", "res:validation:x"].map(layerOfKey), ["channel", "agents", "tunnels", "resources", "resources"]);
});

test("createViewResolver: 按基线找出某一时刻查看的是哪台服务器", () => {
  const viewAt = createViewResolver([
    baseline(DAY + 2 * H, "view", "server-aliyun", { channel: "ok" }),
    baseline(DAY, "day", "server-01", { channel: "ok" }),
    baseline(DAY + 3 * H, "stop", "", {}),
    change(DAY + H, "channel", "ok", "error"),
  ]);
  assert.deepEqual([DAY - 1, DAY, DAY + H, DAY + 2 * H, DAY + 5 * H].map(viewAt), ["", "server-01", "server-01", "server-aliyun", "server-aliyun"]);
  assert.equal(createViewResolver(undefined)(DAY), "");
});

test("还原：跨天基线往回补到当天起点，其后按变更推进；channel 归到当时查看的那台服务器", () => {
  const result = reconstructLanes([
    baseline(DAY + 30_000, "day", "server-01", HEALTHY),
    change(DAY + 3 * H, "channel", "ok", "error", "SSH 隧道未开启"),
    change(DAY + 3.5 * H, "channel", "error", "ok", "通道全链路正常"),
    change(DAY + 5 * H, "tunnel:server-aliyun", "ok", "warn"),
    change(DAY + 30 * H, "agent:codex", "ok", "error"), // 窗口之后的条目不参与
  ], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "ok"], [3, "error"], [3.5, "ok"]]);
  assert.deepEqual(lane(result, "tunnel:server-aliyun"), [[0, "ok"], [5, "warn"]]);
  assert.deepEqual(lane(result, "agent:codex"), [[0, "ok"]]);
  assert.equal(result.lanes.has("channel"), false);
  assert.equal(result.lanes.get("tunnel:server-01")[1].reason, "SSH 隧道未开启");
  assert.deepEqual([result.baselineAt, result.extended], [DAY + 30_000, true]);
});

test("还原：切换查看视角后各服务器的行保持连续；不再跟踪的键不把旧状态延续下去", () => {
  const result = reconstructLanes([
    baseline(DAY, "day", "server-01", { ...HEALTHY, "res:validation:server-09": "error" }),
    change(DAY + 9 * H, "tunnel:server-aliyun", "ok", "error", "SSH 隧道未开启"),
    // 10:00 切到阿里云：channel 改指阿里云（此刻已恢复），主集群开始单列 tunnel:server-01；
    // server-09 的环境校验不在新基线里（服务器已删）。切换本身不产生任何变更条目。
    baseline(DAY + 10 * H, "view", "server-aliyun", { channel: "ok", "tunnel:server-01": "warn", "agent:codex": "skipped", "res:server-01": "ok", "res:validation:server-01": "ok" }),
    change(DAY + 11 * H, "channel", "ok", "error"),
    change(DAY + 12 * H, "tunnel:server-01", "warn", "ok"),
  ], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(result, "tunnel:server-aliyun"), [[0, "ok"], [9, "error"], [10, "ok"], [11, "error"]], "阿里云：先是单列的隧道键，切换后由 channel 接着记");
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "ok"], [10, "warn"], [12, "ok"]]);
  assert.deepEqual(lane(result, "agent:codex"), [[0, "ok"], [10, "skipped"]]);
  assert.deepEqual(lane(result, "res:validation:server-09"), [[0, "error"], [10, null]], "基线里没有的键从那一刻起是无记录，不是一直故障");
});

test("还原：停止标记到下次启动之间是无记录；启动基线不往回补", () => {
  const result = reconstructLanes([
    baseline(DAY, "day", "server-01", HEALTHY),
    baseline(DAY + 12 * H, "stop", "", {}),
    baseline(DAY + 14 * H, "start", "server-01", { ...HEALTHY, channel: "waiting" }),
    change(DAY + 14 * H + MIN, "channel", "waiting", "ok"),
  ], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "ok"], [12, null], [14, "waiting"], [14 + 1 / 60, "ok"]]);
  assert.deepEqual(lane(result, "agent:codex"), [[0, "ok"], [12, null], [14, "ok"]]);

  // 当天第一份基线是启动基线（之前没在运行）：之前没有记录
  const late = reconstructLanes([baseline(DAY + 9 * H, "start", "server-01", HEALTHY)], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(late, "tunnel:server-01"), [[9, "ok"]]);
  assert.deepEqual([late.baselineAt, late.extended], [DAY + 9 * H, false]);
});

test("还原：跨天基线是被一批变更顺带写下的（已是变更之后的状态）时，零点到那一刻按变更前的状态补", () => {
  const at = DAY + 7 * H;
  const result = reconstructLanes([
    baseline(at, "day", "server-01", HEALTHY),
    change(at, "channel", "error", "ok", "通道全链路正常"),
    change(at + 1, "agent:codex", "skipped", "ok", "ready"),
    change(at + 5 * MIN, "res:server-01", "ok", "warn"),
  ], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "error"], [7, "ok"]], "断了一夜、七点恢复：零点到七点是故障，不是正常");
  assert.deepEqual(lane(result, "agent:codex"), [[0, "skipped"], [7, "ok"]]);
  assert.deepEqual(lane(result, "res:server-01"), [[0, "ok"], [7 + 5 / 60, "warn"]], "五分钟后的变更不算同一批");
});

test("还原：没有基线的旧日子按变更尽力还原——变更前是 from；没有变更的对象还原不出来", () => {
  const result = reconstructLanes([
    change(DAY + 3 * H, "channel", "ok", "error"),
    change(DAY + 4 * H, "channel", "error", "ok"),
    change(DAY + 6 * H, "agent:codex", "unknown", "waiting"),
    // 查看的是主集群，却有它单列的隧道记录（当时一度切到了别的视角）：与 channel 的归属冲突，不参与还原
    change(DAY + 8 * H, "tunnel:server-01", "ok", "error"),
    { ts: DAY + 9 * H, type: "sample", key: "server-01", cpu: 3 },
    { ts: DAY + 9 * H, type: "signal", severity: "warn", title: "网关不健康" },
    null,
  ], { start: DAY, end: DAY + 24 * H, currentView: "server-01" });
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "ok"], [3, "error"], [4, "ok"]]);
  assert.deepEqual(lane(result, "agent:codex"), [[0, "unknown"], [6, "waiting"]]);
  assert.deepEqual([...result.lanes.keys()].sort(), ["agent:codex", "tunnel:server-01"]);
  assert.deepEqual([result.baselineAt, result.extended], [null, false]);
  // 连当前查看的是哪台都不知道：channel 自成一行
  const blind = reconstructLanes([change(DAY + H, "channel", "ok", "warn")], { start: DAY, end: DAY + 24 * H });
  assert.deepEqual(lane(blind, "channel"), [[0, "ok"], [1, "warn"]]);
});

test("还原：旧记录接上第一份基线——基线里没有的键，最后一次变更之后那段不可信，画成无记录", () => {
  const result = reconstructLanes([
    change(DAY + 2 * H, "tunnel:server-old", "ok", "error", "SSH 隧道未开启"),
    change(DAY + 3 * H, "channel", "ok", "warn"),
    change(DAY + 4 * H, "res:server-01", "ok", "error"),
    baseline(DAY + 15 * H, "start", "server-01", { channel: "waiting", "res:server-01": "waiting", "agent:codex": "waiting" }),
    change(DAY + 15 * H + MIN, "channel", "waiting", "ok"),
  ], { start: DAY, end: DAY + 24 * H, currentView: "server-aliyun" });
  assert.deepEqual(lane(result, "tunnel:server-old"), [[0, "ok"], [2, null]], "设计稿踩过的坑：不再跟踪的隧道不能一直停在故障");
  assert.deepEqual(lane(result, "tunnel:server-01"), [[0, "ok"], [3, "warn"], [15, "waiting"], [15 + 1 / 60, "ok"]], "旧记录里的 channel 按第一份基线的视角归属，而不是当前视角");
  assert.deepEqual(lane(result, "res:server-01"), [[0, "ok"], [4, "error"], [15, "waiting"]]);
  assert.deepEqual(lane(result, "agent:codex"), [[15, "waiting"]]);
});

test("laneSegments: 截到窗口内、首尾相接；最早的变化点之前是无记录；相邻同状态合并", () => {
  const points = [{ t: 10, level: "ok", reason: "" }, { t: 40, level: "error", reason: "boom" }, { t: 60, level: "ok", reason: "" }];
  assert.deepEqual(laneSegments(points, 0, 100), [
    { from: 0, to: 10, level: null, reason: "" },
    { from: 10, to: 40, level: "ok", reason: "" },
    { from: 40, to: 60, level: "error", reason: "boom" },
    { from: 60, to: 100, level: "ok", reason: "" },
  ]);
  assert.deepEqual(laneSegments(points, 50, 55), [{ from: 50, to: 55, level: "error", reason: "boom" }]);
  assert.deepEqual(laneSegments(points, 70, 90), [{ from: 70, to: 90, level: "ok", reason: "" }]);
  assert.deepEqual(laneSegments([], 0, 10), [{ from: 0, to: 10, level: null, reason: "" }]);
  assert.deepEqual(laneSegments([{ t: 200, level: "ok", reason: "" }], 0, 10), [{ from: 0, to: 10, level: null, reason: "" }]);
});

test("laneStats / laneStatText / spanText: 连在一起的警告与故障算一段异常", () => {
  const seg = (from, to, level) => ({ from: from * MIN, to: to * MIN, level, reason: "" });
  const stats = laneStats([seg(0, 60, "ok"), seg(60, 70, "warn"), seg(70, 75, "error"), seg(75, 80, "warn"), seg(80, 200, "ok"), seg(200, 209, "error"), seg(209, 230, "skipped"), seg(230, 240, null)]);
  assert.deepEqual(stats, { runs: 2, badMs: 29 * MIN, okMs: 180 * MIN, idleMs: 21 * MIN, noneMs: 10 * MIN });
  assert.equal(laneStatText(stats), "异常 2 段 · 共 29 分");
  assert.equal(laneStatText(laneStats([seg(0, 60, "ok")])), "全程正常");
  assert.equal(laneStatText(laneStats([seg(0, 60, "ok"), seg(60, 70, "waiting")])), "无异常");
  assert.equal(laneStatText(laneStats([seg(0, 60, "skipped"), seg(60, 70, null)])), "全程跳过");
  assert.equal(laneStatText(laneStats([seg(0, 60, null)])), "无记录");
  assert.deepEqual([400, 45_000, 59_600, 24 * MIN, 60 * MIN, 185 * MIN, 26 * H].map(spanText), ["1 秒", "45 秒", "1 分", "24 分", "1 小时", "3 小时 5 分", "26 小时"]);
  assert.deepEqual([null, undefined, "ok", "warn", "error", "skipped", "waiting", "unknown", "stopped"].map(toneOfLevel), ["none", "none", "ok", "warn", "error", "idle", "idle", "idle", "idle"]);
});

test("laneDefs: 查看中的服务器叫「通道」排最前，其余隧道、各 Agent、资源采集、环境校验；配置里没有的对象排最后", () => {
  const defs = laneDefs(STATUS, ["tunnel:server-old", "agent:ghost", "res:validation:server-old", "res:server-old", "agent:codex"]);
  assert.deepEqual(defs.map((d) => [d.key, d.name]), [
    ["tunnel:server-01", "通道 · 主集群"],
    ["tunnel:server-aliyun", "隧道 · 阿里云"],
    ["channel", "通道"],
    ["agent:codex", "Codex"],
    ["agent:claude-codewing", "Claude CodeWing"],
    ["res:server-01", "资源采集 · 主集群"],
    ["res:server-aliyun", "资源采集 · 阿里云"],
    ["res:validation:server-01", "环境校验 · 主集群"],
    ["res:validation:server-aliyun", "环境校验 · 阿里云"],
    ["tunnel:server-old", "隧道 · server-old"],
    ["agent:ghost", "ghost"],
    ["res:validation:server-old", "环境校验 · server-old"],
    ["res:server-old", "资源采集 · server-old"],
  ]);
  assert.deepEqual(laneDefs(null).map((d) => d.key), ["channel"]);
});

test("buildSwimModel: 近 24 小时——只画不正常的段，统计异常段数与时长，窗口里没有记录的对象不占行", () => {
  const now = DAY + 42.5 * H; // 10 月 3 日 18:30
  const start = now - 24 * H;
  const model = buildSwimModel([
    baseline(DAY, "day", "server-01", HEALTHY),
    change(DAY + 20 * H, "channel", "ok", "error", "SSH 隧道未开启"),
    change(DAY + 20.25 * H, "channel", "error", "warn", "远端端口未开放"),
    change(DAY + 20.5 * H, "channel", "warn", "ok", "通道全链路正常"),
    baseline(DAY + 24 * H + 20_000, "day", "server-01", { ...HEALTHY, "agent:codex": "warn" }),
    change(DAY + 30 * H, "agent:codex", "warn", "ok", "ready"),
    change(DAY + 40 * H, "agent:codex", "ok", "warn", "degraded"),
  ], { start, end: now, live: true, status: STATUS });
  assert.equal(model.title, "近 24 小时 · 每行一个对象，颜色段是它当时的状态");
  assert.deepEqual(model.rows.map((r) => [r.name, r.stat, r.tone]), [
    ["通道 · 主集群", "异常 1 段 · 共 30 分", "warn"],
    ["隧道 · 阿里云", "全程正常", ""],
    ["Codex", "异常 2 段 · 共 8 小时 30 分", "warn"],
    ["资源采集 · 主集群", "全程正常", ""],
    ["环境校验 · 主集群", "全程正常", ""],
  ]);
  const channel = model.rows[0].segments;
  assert.deepEqual(channel.map((s) => [s.tone, Number(s.left.toFixed(3)), Number(s.width.toFixed(3))]), [["error", 6.25, 1.042], ["warn", 7.292, 1.042]]);
  assert.equal(channel[0].title, "通道 · 主集群：故障 10.2 20:00 – 20:15 · 15 分 · SSH 隧道未开启");
  assert.equal(model.rows[2].segments[0].title, "Codex：警告 10.3 00:00 – 06:00 · 6 小时");
  assert.equal(model.rows[2].segments[1].title, "Codex：警告 10.3 16:00 – 现在 · 2 小时 30 分 · 降级");
  // 18:00 离右端的「现在」（18:30）太近，让位
  assert.deepEqual(model.ticks.map((t) => [t.label, t.strong, Number(t.left.toFixed(2))]), [["0 点", true, 22.92], ["06:00", false, 47.92], ["12:00", false, 72.92]]);
  assert.deepEqual([model.endLabel, model.note], ["现在", ""]);
});

test("buildSwimModel: 历史某天——标题、24:00、无记录与跳过画成斜纹；基线说明", () => {
  const entries = [
    baseline(DAY + 9 * H, "start", "server-01", { ...HEALTHY, "agent:codex": "skipped" }),
    change(DAY + 10 * H, "agent:codex", "skipped", "ok", "ready"),
  ];
  const model = buildSwimModel(entries, { start: DAY, end: DAY + 24 * H, status: STATUS, day: "2026-10-02" });
  assert.equal(model.title, "10 月 2 日 全天");
  assert.equal(model.endLabel, "24:00");
  assert.equal(model.note, "09:00 之前没有状态基线：那一段只能按变更还原，还原不出来的画成无记录。");
  const codex = model.rows.find((r) => r.name === "Codex");
  assert.deepEqual(codex.segments.map((s) => [s.tone, s.title]), [
    ["none", "Codex：没有记录 00:00 – 09:00"],
    ["idle", "Codex：跳过 09:00 – 10:00 · 1 小时"],
  ]);
  assert.equal(codex.stat, "无异常");
  assert.deepEqual(model.ticks.map((t) => t.label), ["0 点", "06:00", "12:00", "18:00"]);

  // 今天（还没过完）：截至当前
  const today = buildSwimModel([baseline(DAY + 5000, "day", "server-01", HEALTHY)], { start: DAY, end: DAY + 18.5 * H, status: STATUS, day: "2026-10-02" });
  assert.deepEqual([today.title, today.endLabel, today.note], ["10 月 2 日 · 截至 18:30", "现在", ""]);
  assert.equal(today.rows.every((r) => r.stat === "全程正常" && r.segments.length === 0), true);

  // 旧版本留下的日子：没有基线
  const legacy = buildSwimModel([change(DAY + 3 * H, "channel", "ok", "error"), change(DAY + 3.2 * H, "channel", "error", "ok")], { start: DAY, end: DAY + 24 * H, status: STATUS, day: "2026-10-02" });
  assert.deepEqual(legacy.rows.map((r) => [r.name, r.stat]), [["通道 · 主集群", "异常 1 段 · 共 12 分"]]);
  assert.match(legacy.note, /还没有状态基线/);
  // 什么都没有
  const none = buildSwimModel([], { start: DAY, end: DAY + 24 * H, status: STATUS, day: "2026-10-02" });
  assert.deepEqual(none.rows, []);
  assert.match(swimHtml(none), /这段时间没有状态记录。/);
});

test("swimHtml: 一行三格（名字 / 条 / 统计）+ 时间轴；名字与原因全部转义", () => {
  const status = { ...STATUS, agents: [{ id: "codex", name: '<img src=x onerror="1">' }] };
  const html = swimHtml(buildSwimModel([
    baseline(DAY, "day", "server-01", HEALTHY),
    change(DAY + 6 * H, "agent:codex", "ok", "error", '"><script>x</script>'),
    change(DAY + 12 * H, "agent:codex", "error", "ok"),
  ], { start: DAY, end: DAY + 24 * H, status, day: "2026-10-02" }));
  assert.ok(!html.includes("<img") && !html.includes("<script>"));
  assert.match(html, /<span class="tl-name" title="agent:codex">&lt;img src=x onerror=&quot;1&quot;&gt;<\/span>/);
  assert.match(html, /<span class="tl-seg" data-tone="error" style="left:25%;width:max\(2px, 25%\)" title="[^"]*故障 06:00 – 12:00 · 6 小时 · &quot;&gt;&lt;script&gt;x&lt;\/script&gt;"><\/span>/);
  assert.match(html, /<span class="tl-stat" data-tone="warn">异常 1 段 · 共 6 小时<\/span>/);
  assert.match(html, /<span class="tl-stat">全程正常<\/span>/);
  assert.match(html, /<span class="tl-tick is-strong" style="left:0%">0 点<\/span>/);
  assert.match(html, /<span class="tl-now" aria-hidden="true">24:00<\/span>/);
  assert.equal(html.split('class="tl-bar"').length - 1, 5);
  assert.match(html, /<i class="tl-key" data-tone="none"><\/i>跳过 \/ 无记录/);
});
