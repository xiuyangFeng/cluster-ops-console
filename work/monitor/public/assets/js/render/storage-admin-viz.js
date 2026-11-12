// storage-admin-viz.js —— 存储管理的图形部件（纯字符串函数，Node 可测）：
//   - capacityRowsHtml：所有磁盘的容量条列表（一盘一行，条对齐，80% / 90% 两条刻度；点一行跳到那块盘的按用户）。
//   - fleetSummary：所选节点全部磁盘的合计（总容量 / 已用 / 剩余 / 文件数 / 最满的盘）。
//   - splitBarHtml：一块盘（或一次扫描范围）的容量被谁占了——分段条（前 5 人各一色、其他用户、未归属、剩余）；
//     tall 版 28px、块内印占比（放不下就不印），图例只列名字，数值在下面的名单里。
//   - coldChartHtml：数据冷热——按「这个人最后一次修改数据」距今多久分档，合计占用；超过所选时长的几档用强调色。
//   - treemapHtml：扫描结果某一层的矩形树图（面积 = 占用，颜色按占比分四档，只作辅助），可深入的目录点了就进下一层。
//   - rankedRowsHtml / userRowsHtml：与图对照的排序表（精确数值都在表里）。
//   - diskEntryHtml：服务器页磁盘卡片里的「存储管理」入口摘要。
// 颜色：分类色只给前 5 名（经 dataviz 校验脚本校验，深浅两套：蓝、琥珀、青绿、紫、玫红），第 6 名起并入「其他用户」（灰）。
// 树图只用一种蓝的深浅（四档，校验过的有序色阶），不按属主上色（树图里任意两块都可能相邻）。
// 所有动态文案一律 escapeHtml；悬停提示的内容放在 data-tip-* 上，由控制器用 textContent 填进提示框。
import { escapeHtml, formatBytePair, formatBytes } from "../store.js";
import { dateTimeOf, dayKeyOf } from "./usage-model.js";

const size = (n) => (Number.isFinite(n) ? formatBytes(n, { compact: true }) : "—");
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("zh-CN") : "—");
const pct = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(r >= 0.1 || r === 0 ? 0 : 1)}%` : "—");
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const attr = escapeHtml;
const w = (r) => `${(clamp01(r) * 100).toFixed(2)}%`;

export const OWNER_SLOTS = 5;

// ---------- 折叠：每个列表默认只显示前几项，「展开全部」看其余 ----------
// fold.open：已展开的列表键（控制器持有，重绘不丢）；key 在整页唯一（如 users:master:/public）。
export const FOLD_DEFAULT = 5;

export function foldList(items, key, fold, n = FOLD_DEFAULT) {
  const open = Boolean(fold?.open?.has(key));
  const shown = open || items.length <= n ? items : items.slice(0, n);
  const toggle = items.length > n
    ? `<button type="button" class="sa-fold" data-sa-fold="${attr(key)}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : `展开全部（${num(items.length)} 项）`}</button>`
    : "";
  return { shown, toggle };
}
export const level = (ratio) => (ratio >= 0.9 ? "crit" : ratio >= 0.8 ? "warn" : "ok");

// 与 df 的 Use% 同一口径：已用 ÷（已用 + 普通用户可用），不把 root 保留块算作可用。
export const usedRatio = (m) => (m.used + m.avail > 0 ? m.used / (m.used + m.avail) : 0);

// 悬停 / 聚焦提示：值在前（醒目），名字与说明在后。
export function tip(name, value, meta = "") {
  return ` data-tip-name="${attr(name)}" data-tip-value="${attr(value)}"${meta ? ` data-tip-meta="${attr(meta)}"` : ""}`;
}

// 容量计量条：填充色表达状态（<80% 主题色、80–90% 警告、≥90% 危险），80% / 90% 两条细刻度。
export function meterHtml(ratio, label, { large = false } = {}) {
  const lv = level(ratio);
  return `<span class="sa-meter${large ? " sa-meter-lg" : ""}" data-level="${lv}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(clamp01(ratio) * 100)}" aria-label="${attr(label)}">` +
    `<span class="sa-meter-fill" style="width:${w(ratio)}"></span><span class="sa-meter-tick" style="left:80%"></span><span class="sa-meter-tick" style="left:90%"></span></span>`;
}

// ---------- 所有磁盘：合计与容量条列表 ----------

export function fleetSummary(targets) {
  const disks = [];
  for (const t of targets || []) for (const m of t.info?.mounts || []) disks.push({ target: t, mount: m, ratio: usedRatio(m) });
  const sum = (key) => disks.reduce((s, d) => s + (Number(d.mount[key]) || 0), 0);
  const used = sum("used");
  const avail = sum("avail");
  const fullest = disks.reduce((best, d) => (!best || d.ratio > best.ratio ? d : best), null);
  return {
    disks: [...disks].sort((a, b) => b.ratio - a.ratio),
    nodes: new Set(disks.map((d) => d.target.id)).size,
    size: sum("size"), used, avail, ratio: used + avail > 0 ? used / (used + avail) : 0,
    iused: sum("iused"), inodes: sum("inodes"), fullest,
    hot: disks.filter((d) => d.ratio >= 0.8).length,
  };
}

// 一盘一行：名字（挂载点 + 节点）· 计量条 · 百分比 · 已用 / 总量。整行是按钮，点了跳到这块盘的按用户。
export function capacityRowsHtml(disks, { multiNode = true } = {}) {
  if (!disks?.length) return "";
  return `<div class="sa-cap-list" role="list">${disks.map(({ target: t, mount: m, ratio }) => {
    const lv = level(ratio);
    const iratio = m.inodes > 0 ? m.iused / m.inodes : 0;
    const meta = [`剩余 ${size(m.avail)}`, `${num(m.iused)} 个文件（inode ${pct(iratio)}）`, `${m.fs || ""} ${m.device || ""}`.trim(), m.quota ? "配额统计已开" : ""].filter(Boolean).join(" · ");
    return `<button type="button" role="listitem" class="sa-cap-row" data-level="${lv}" data-sa-jump="${attr(`disk:${t.id}:${m.mount}`)}"${tip(`${t.label} ${m.mount}`, `已用 ${pct(ratio)}`, meta)}>` +
      `<span class="sa-cap-name"><b>${escapeHtml(m.mount)}</b>${multiNode ? `<small>${escapeHtml(t.label)}</small>` : ""}</span>` +
      meterHtml(ratio, `${t.label} ${m.mount} 已用 ${pct(ratio)}`) +
      `<span class="sa-cap-pct" data-level="${lv}">${pct(ratio)}</span>` +
      `<span class="sa-cap-size">${escapeHtml(formatBytePair(m.used, m.size, { compact: true }) || size(m.used))}</span></button>`;
  }).join("")}</div>`;
}

// ---------- 按用户：分段条 + 名单 ----------

// 前 5 名（按占用）各占一个固定色位；颜色跟着人走，同一份名单里不会因为排序变化而换色。
export function ownerSlots(rows) {
  const top = [...(rows || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, OWNER_SLOTS);
  return new Map(top.map((r, i) => [r.uid, i + 1]));
}

const ownerName = (r) => r.name || `uid ${r.uid}`;

// 分段条的各段：前 5 人、其他用户、未归属（已用里名单没覆盖到的，如保留块 / 元数据 / 扫描没覆盖的部分）、剩余。
// 宽度一律按「已用 + 可用」（与百分比同一口径）。
export function splitSegments(u) {
  const rows = [...(u.rows || [])].sort((a, b) => b.bytes - a.bytes);
  const used = Number(u.used) || 0;
  const cap = used + (Number(u.avail) || Math.max(0, (Number(u.size) || 0) - used));
  if (!(cap > 0)) return [];
  const top = rows.slice(0, OWNER_SLOTS);
  const others = rows.slice(OWNER_SLOTS).reduce((s, r) => s + r.bytes, 0);
  const listed = rows.reduce((s, r) => s + r.bytes, 0);
  const segs = top.map((r, i) => ({ kind: "user", slot: i + 1, name: ownerName(r), bytes: r.bytes }));
  if (others > 0) segs.push({ kind: "others", name: `其他 ${num(rows.length - OWNER_SLOTS)} 位用户`, bytes: others });
  const unassigned = Math.max(0, used - listed);
  if (unassigned / cap >= 0.002) segs.push({ kind: "unassigned", name: "未归属", bytes: unassigned });
  const free = Math.max(0, cap - Math.max(used, listed));
  if (free > 0) segs.push({ kind: "free", name: "剩余", bytes: free });
  return segs.map((s) => ({ ...s, ratio: s.bytes / cap }));
}

// tall：28px 高、块内印占比（块太窄时由 CSS 容器查询隐藏，不裁半个字）；名字在图例里、数值在名单里。
export function splitBarHtml(u, { tall = false, name = u.mount, scope = "这块盘容量" } = {}) {
  const segs = splitSegments(u);
  if (!segs.length) return "";
  const label = segs.map((s) => `${s.name} ${size(s.bytes)}`).join("，");
  const bar = segs.map((s) => (
    `<span class="sa-seg" data-kind="${s.kind}"${s.slot ? ` data-slot="${s.slot}"` : ""} style="flex-grow:${(s.ratio * 1000).toFixed(2)}"` +
    `${tip(s.name, size(s.bytes), `占${scope} ${pct(s.ratio)}`)} tabindex="-1">${tall ? `<span class="sa-seg-label">${pct(s.ratio)}</span>` : ""}</span>`
  )).join("");
  const legend = segs.map((s) => (
    `<li><span class="sa-swatch" data-kind="${s.kind}"${s.slot ? ` data-slot="${s.slot}"` : ""}></span>${escapeHtml(s.name)}</li>`
  )).join("");
  return `<div class="sa-split${tall ? " sa-split-tall" : ""}" role="img" aria-label="${attr(`${name} 容量构成：${label}`)}">${bar}</div><ul class="sa-legend">${legend}</ul>`;
}

const USER_ROWS = 40;

// ---------- 不活跃用户 ----------
// 登录记录和文件修改均较旧，且没有近期正向活动证据时，只列为疑似不活跃（待核实）。
//   - 系统账号（uid < 1000，如 root）不判定；没有对应账号的 uid（多半是已删的人）登录一项按「不可能登录」算；
//   - 任一时间未知（lastlog 读不到 / 统计结果来自旧版本或 repquota，没有修改时间）就不下结论；
//   - 占用不到 1 GiB 的不标（IDLE_MIN_BYTES）。
export const IDLE_MONTHS = Object.freeze([3, 6, 12]);
// 占用不到 1 GiB 的不标：清理价值很小，标出来只是噪音（时间照样显示）。
export const IDLE_MIN_BYTES = 1024 ** 3;
export const DEFAULT_IDLE_MONTHS = 6;
const DAY_SEC = 86400;
const MONTH_SEC = 30 * DAY_SEC;
export const IDLE_RULE = "登录记录和数据最后修改都早于所选时长，且没有观测到近期作业 / 会话；占用 ≥ 1 GiB；系统账号不判定。只是线索，需人工核实。";

export function idleState(r, { now = Date.now(), months = DEFAULT_IDLE_MONTHS } = {}) {
  if (r.account === "system") return { judged: false, idle: false, system: true };
  const limit = now / 1000 - months * MONTH_SEC;
  const loginKnown = r.account === "none" || r.lastLogin != null;
  const loginStale = r.account === "none" || r.lastLogin === 0 || (r.lastLogin != null && r.lastLogin < limit);
  const writeKnown = r.lastWrite != null;
  const writeStale = writeKnown && r.lastWrite < limit;
  const small = !(r.bytes >= IDLE_MIN_BYTES);
  const seenAt = r.activity?.lastObservedAt;
  const recentActivity = Number.isFinite(seenAt) && seenAt <= now && seenAt > limit * 1000;
  return { judged: loginKnown && writeKnown, idle: loginStale && writeStale && !small && !recentActivity, small, loginStale, writeStale, loginKnown, writeKnown, recentActivity };
}

// 「N 天前 / N 个月前 / N 年前」；秒。
export function agoText(sec, now = Date.now()) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const d = Math.max(0, now / 1000 - sec);
  if (d < DAY_SEC) return "今天";
  if (d < 60 * DAY_SEC) return `${Math.floor(d / DAY_SEC)} 天前`;
  if (d < 24 * MONTH_SEC) return `${Math.floor(d / MONTH_SEC)} 个月前`;
  return `${Math.floor(d / (365 * DAY_SEC))} 年前`;
}

const dateText = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  return dayKeyOf(sec);
};

function loginCell(r, st, now) {
  if (r.account === "system") return '<td class="sa-num sa-dim sa-act">系统账号</td>';
  if (r.account === "none") return '<td class="sa-num sa-act" data-stale="true">已无账号</td>';
  if (r.lastLogin == null) return '<td class="sa-num sa-dim sa-act">未知</td>';
  if (r.lastLogin === 0) return '<td class="sa-num sa-act" title="lastlog 没有记录，不代表从未通过 SSH 登录">无记录</td>';
  return `<td class="sa-num sa-act"${st.loginStale ? ' data-stale="true"' : ""} title="${attr(`${dateText(r.lastLogin)}（北京时间，lastlog 记录；不是完整 SSH 活动历史）`)}">${escapeHtml(agoText(r.lastLogin, now))}</td>`;
}

function activityCell(r, now) {
  const a = r.activity;
  const live = a?.active && a.checkedAt <= now && a.expiresAt >= now;
  const labels = live ? [a.sshOnline ? "SSH 在线" : "", a.runningJobs ? `${a.runningJobs} 项作业运行中` : "", a.pendingJobs ? `${a.pendingJobs} 项作业排队中` : "", a.agentProcesses ? "Agent 进程运行中" : ""].filter(Boolean) : [];
  const text = labels.length ? labels.join(" · ") : a?.lastObservedAt ? `${agoText(a.lastObservedAt / 1000, now)}观测到活动` : "暂无观测";
  const at = labels.length ? a.checkedAt : a?.lastObservedAt;
  const state = labels.length ? "live" : a?.lastObservedAt ? "seen" : "none";
  return `<td class="sa-act sa-activity" data-state="${state}" title="${attr(at ? `最近活动观测 ${dateTimeOf(at / 1000)}（北京时间）；作业或进程不等于新的 SSH 登录` : "只融合已有团队与资源采样；暂无观测不代表没有活动")}"><span class="sa-act-dot" aria-hidden="true"></span>${escapeHtml(text)}</td>`;
}

function writeCell(r, st, now) {
  if (r.lastWrite == null) return '<td class="sa-num sa-dim sa-act">未知</td>';
  if (r.lastWrite === 0) return '<td class="sa-num sa-act" data-stale="true">—</td>';
  return `<td class="sa-num sa-act"${st.writeStale ? ' data-stale="true"' : ""} title="${attr(dateText(r.lastWrite))}">${escapeHtml(agoText(r.lastWrite, now))}</td>`;
}

// 这块盘按所选时长算出的不活跃用户合计。
export function idleSummary(u, { now = Date.now(), months = DEFAULT_IDLE_MONTHS } = {}) {
  const rows = u.rows || [];
  const idle = rows.filter((r) => idleState(r, { now, months }).idle);
  const bytes = idle.reduce((s, r) => s + r.bytes, 0);
  const writeKnown = rows.some((r) => r.lastWrite != null);
  return { count: idle.length, bytes, share: u.used > 0 ? bytes / u.used : 0, writeKnown };
}

// 时长切换 + 只看不活跃 + 合计。activity：{ months, only }。判定规则放在标签的悬停说明里，不占一整行。
export function idleToolbarHtml(u, { now = Date.now(), activity = {} } = {}) {
  const months = activity.months || DEFAULT_IDLE_MONTHS;
  const s = idleSummary(u, { now, months });
  const seg = IDLE_MONTHS.map((m) => (
    `<button type="button" class="sa-seg-btn" data-sa-idle-months="${m}" aria-pressed="${m === months ? "true" : "false"}">${m} 个月</button>`
  )).join("");
  const only = `<button type="button" class="sa-seg-btn sa-idle-only" data-sa-idle-only aria-pressed="${activity.only ? "true" : "false"}"${s.count ? "" : " disabled"}>只看疑似不活跃</button>`;
  const sum = !s.writeKnown
    ? "数据最后修改时间还没有：重新「按用户统计」一次（服务器端版本 3）后才判定不活跃。"
    : s.count
      ? `疑似不活跃 ${num(s.count)} 位，共占 ${size(s.bytes)}（占已用 ${pct(s.share)}），需核实`
      : `${months} 个月内没有符合条件的疑似不活跃用户`;
  return `<div class="sa-idle-bar"><span class="sa-idle-label" title="${attr(IDLE_RULE)}">疑似不活跃<span class="sa-info" aria-hidden="true">i</span>超过</span>` +
    `<span class="sa-seg-group" role="group" aria-label="不活跃时长">${seg}</span>${only}` +
    `<span class="sa-idle-sum"${s.count ? ' data-has="true"' : ""}>${escapeHtml(sum)}</span></div>`;
}

export function userRowsHtml(u, { limit = USER_ROWS, shareLabel = "占已用", filesLabel = "文件数", activity = null, now = Date.now(), fold = null, foldKey = "" } = {}) {
  const rows = [...(u.rows || [])].sort((a, b) => b.bytes - a.bytes);
  const slots = ownerSlots(rows);
  const max = rows[0]?.bytes || 0;
  const months = activity?.months || DEFAULT_IDLE_MONTHS;
  const ranked = rows.map((r, i) => ({ r, rank: i + 1, st: activity ? idleState(r, { now, months }) : null }));
  const visible = activity?.only ? ranked.filter((x) => x.st?.idle) : ranked;
  // 有折叠键：默认前 5 项、可展开全部；没有：按 limit 截断（旧调用方）。
  const folded = foldKey ? foldList(visible, foldKey, fold) : { shown: visible.slice(0, limit), toggle: "" };
  const body = folded.shown.map(({ r, rank, st }) => {
    const slot = slots.get(r.uid);
    const idleTag = st?.idle ? `<span class="sa-idle-tag">${r.account === "none" ? "已无账号 · 待核实" : "疑似不活跃"}</span>` : "";
    const meta = `${shareLabel} ${pct(r.share)} · ${filesLabel} ${num(r.files)}` +
      (activity ? ` · 系统登录记录 ${r.lastLogin ? dateText(r.lastLogin) : r.lastLogin === 0 ? "无记录" : r.account === "none" ? "已无账号" : "未知"} · 数据最后修改 ${r.lastWrite ? dateText(r.lastWrite) : "未知"}` : "");
    return `<tr${st?.idle ? ' data-idle="true"' : ""}${tip(ownerName(r), size(r.bytes), meta)}>` +
      `<td class="sa-rank">${rank}</td>` +
      `<td class="sa-name"><span class="sa-swatch" data-kind="${slot ? "user" : "others"}"${slot ? ` data-slot="${slot}"` : ""}></span>${escapeHtml(ownerName(r))}${idleTag}</td>` +
      `<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:${w(max ? r.bytes / max : 0)}"></span></span></td>` +
      `<td class="sa-num sa-strong-num">${escapeHtml(size(r.bytes))}</td><td class="sa-num">${pct(r.share)}</td><td class="sa-num sa-dim sa-files-col">${escapeHtml(num(r.files))}</td>` +
      (activity ? `${activityCell(r, now)}${loginCell(r, st, now)}${writeCell(r, st, now)}` : "") + "</tr>";
  }).join("");
  const more = foldKey ? folded.toggle : visible.length > limit ? `<p class="sa-note">另有 ${num(visible.length - limit)} 个用户占用更少，未列出。</p>` : "";
  const actHead = activity ? '<th class="sa-act">近期活动</th><th class="sa-num sa-act" title="来自 lastlog，可能漏记 SSH 连接，不是完整登录审计">系统登录记录</th><th class="sa-num sa-act">数据最后修改</th>' : "";
  return `<div class="sa-table-wrap"><table class="sa-table sa-ranked"><thead><tr><th class="sa-rank">#</th><th>用户</th><th class="sa-barcell"><span class="sa-visually-hidden">相对占用</span></th>` +
    `<th class="sa-num">占用</th><th class="sa-num">${escapeHtml(shareLabel)}</th><th class="sa-num sa-files-col">${escapeHtml(filesLabel)}</th>${actHead}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

// 这块盘的摘要数字：前 5 人合计占已用多少、名单覆盖多少人。
export function userSummary(u) {
  const rows = [...(u.rows || [])].sort((a, b) => b.bytes - a.bytes);
  const used = Number(u.used) || 0;
  const top = rows.slice(0, OWNER_SLOTS).reduce((s, r) => s + r.bytes, 0);
  return { count: rows.length, topShare: used > 0 ? top / used : 0, top: rows[0] || null };
}

// 统计卡：标签 · 数值 · 一行小字。数值是唯一醒目的东西。
export function kpiHtml(label, value, sub = "", extra = "") {
  return `<div class="sa-kpi"${extra}><span class="sa-kpi-label">${escapeHtml(label)}</span><span class="sa-kpi-value">${escapeHtml(value)}</span>${sub ? `<span class="sa-kpi-sub">${escapeHtml(sub)}</span>` : ""}</div>`;
}

export function userKpisHtml(u, { now = Date.now(), months = DEFAULT_IDLE_MONTHS, capacity = null } = {}) {
  const s = userSummary(u);
  if (!s.count) return "";
  const idle = idleSummary(u, { now, months });
  const top = s.top;
  return `<div class="sa-kpis">${kpiHtml("已用", size(u.used), capacity != null ? `占容量 ${pct(capacity)}` : "")}` +
    `${kpiHtml("占用最多", ownerName(top), `${size(top.bytes)} · ${pct(u.used > 0 ? top.bytes / u.used : 0)}`)}` +
    `${kpiHtml(`前 ${Math.min(OWNER_SLOTS, s.count)} 人合计`, pct(s.topShare), "的已用")}` +
    `${kpiHtml("有占用的用户", `${num(s.count)} 位`, idle.writeKnown ? (idle.count ? `疑似不活跃 ${num(idle.count)} 位 · ${size(idle.bytes)}` : "没有疑似不活跃") : "", idle.count ? ' data-idle="true"' : "")}</div>`;
}

// ---------- 数据冷热 ----------
// 按「这个人最后一次修改数据」距今多久分档（月 = 30 天）：整个人的数据都多久没动过了。
// 1 年以上包括修改时间为 0 的；没有修改时间（旧版统计 / repquota）进「未知」。
export const COLD_BUCKETS = Object.freeze([
  { key: "m1", label: "1 个月内", min: 0, max: 1 },
  { key: "m3", label: "1–3 个月", min: 1, max: 3 },
  { key: "m6", label: "3–6 个月", min: 3, max: 6 },
  { key: "m12", label: "6–12 个月", min: 6, max: 12 },
  { key: "y1", label: "1 年以上", min: 12, max: Infinity },
]);

export function coldBuckets(rows, { now = Date.now() } = {}) {
  const out = [...COLD_BUCKETS, { key: "unknown", label: "未知", min: null, max: null }].map((b) => ({ ...b, bytes: 0, users: [] }));
  for (const r of rows || []) {
    let b = out[out.length - 1];
    if (r.lastWrite != null) {
      const months = r.lastWrite > 0 ? Math.max(0, now / 1000 - r.lastWrite) / MONTH_SEC : Infinity;
      b = out.find((x) => x.min != null && months >= x.min && months < x.max) || out[COLD_BUCKETS.length - 1];
    }
    b.bytes += Number(r.bytes) || 0;
    b.users.push(r);
  }
  for (const b of out) b.users.sort((a, c) => c.bytes - a.bytes);
  return out;
}

export function coldChartHtml(u, { now = Date.now(), months = DEFAULT_IDLE_MONTHS } = {}) {
  const rows = u.rows || [];
  if (!rows.some((r) => r.lastWrite != null)) return "";
  const buckets = coldBuckets(rows, { now }).filter((b) => b.key !== "unknown" || b.bytes > 0);
  const total = buckets.reduce((s, b) => s + b.bytes, 0);
  const max = Math.max(...buckets.map((b) => b.bytes), 0);
  const cold = buckets.filter((b) => b.min != null && b.min >= months);
  const coldBytes = cold.reduce((s, b) => s + b.bytes, 0);
  const bars = buckets.map((b) => {
    const isCold = b.min != null && b.min >= months;
    const names = b.users.slice(0, 3).map(ownerName).join("、");
    const meta = b.users.length ? `${num(b.users.length)} 位用户${names ? `：${names}${b.users.length > 3 ? " 等" : ""}` : ""} · 占这些用户合计 ${pct(total ? b.bytes / total : 0)}` : "没有用户";
    return `<li class="sa-cold-row"${isCold ? ' data-cold="true"' : ""}${b.key === "unknown" ? ' data-unknown="true"' : ""}${tip(`最后修改 ${b.label}`, size(b.bytes), meta)}>` +
      `<span class="sa-cold-label">${escapeHtml(b.label)}</span><span class="sa-cold-track"><span class="sa-cold-fill" style="width:${w(max ? b.bytes / max : 0)}"></span></span>` +
      `<span class="sa-cold-val">${escapeHtml(b.bytes ? size(b.bytes) : "—")}</span><span class="sa-cold-n">${b.users.length ? `${num(b.users.length)} 人` : ""}</span></li>`;
  }).join("");
  return `<section class="sa-cold" aria-label="数据冷热：按每个人最后一次修改数据距今多久分档">` +
    `<div class="sa-cold-head"><span class="sa-cold-title" title="按每个人名下数据的最后修改时间分档：整个人的数据都多久没动过；与登录无关">数据冷热<span class="sa-info" aria-hidden="true">i</span></span>` +
    `<span class="sa-cold-sum"><b>${escapeHtml(size(coldBytes))}</b> 超过 ${months} 个月未修改 · ${pct(u.used > 0 ? coldBytes / u.used : 0)}</span></div>` +
    `<ul class="sa-cold-bars">${bars}</ul></section>`;
}

// ---------- 矩形树图 ----------

// Squarified treemap（Bruls 等）：按面积从大到小，一行一行铺，使每块尽量接近正方形。
// items: [{ value, ... }]（value > 0，已按从大到小排列）；返回同序的 { ...item, x, y, w, h }（与 width/height 同单位）。
export function squarify(items, width, height) {
  const list = items.filter((it) => it.value > 0);
  const total = list.reduce((s, it) => s + it.value, 0);
  if (!(total > 0) || !(width > 0) || !(height > 0)) return [];
  const scale = (width * height) / total;
  const queue = list.map((it) => ({ it, area: it.value * scale }));
  const out = [];
  let x = 0;
  let y = 0;
  let cw = width;
  let ch = height;
  const worst = (row, side) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    let max = 0;
    let min = Infinity;
    for (const r of row) {
      if (r.area > max) max = r.area;
      if (r.area < min) min = r.area;
    }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    if (cw >= ch) {
      // 竖着排一列，宽 s / ch
      const colW = ch > 0 ? s / ch : 0;
      let yy = y;
      for (const r of row) {
        const hh = colW > 0 ? r.area / colW : 0;
        out.push({ ...r.it, x, y: yy, w: colW, h: hh });
        yy += hh;
      }
      x += colW;
      cw -= colW;
    } else {
      const rowH = cw > 0 ? s / cw : 0;
      let xx = x;
      for (const r of row) {
        const ww = rowH > 0 ? r.area / rowH : 0;
        out.push({ ...r.it, x: xx, y, w: ww, h: rowH });
        xx += ww;
      }
      y += rowH;
      ch -= rowH;
    }
  };
  let row = [];
  while (queue.length) {
    const side = Math.min(cw, ch);
    const next = queue[0];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      queue.shift();
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}

const TM_W = 1200;
const TM_H = 480;
const TM_MAX_TILES = 36;

// 深浅档：占这一层的比例越大档位越高（浅色主题更深、深色主题更亮，都是与底色反差更大），与面积同向，只作辅助。
export const tone = (share) => (share >= 0.25 ? 4 : share >= 0.08 ? 3 : share >= 0.02 ? 2 : 1);

// 树图色阶的图例（四档 + 其余），替代原来整句的说明文字。
export function toneLegendHtml() {
  const steps = [["1", "< 2%"], ["2", "2–8%"], ["3", "8–25%"], ["4", "≥ 25%"], ["rest", "其余"]];
  return `<ul class="sa-tm-legend" aria-label="颜色深浅 = 占这一层的比例（只作辅助，面积才是占用）">${steps.map(([t, label]) => `<li><span class="sa-tm-key" data-tone="${t}"></span>${escapeHtml(label)}</li>`).join("")}</ul>`;
}

export function treemapHtml(view) {
  const n = view?.node;
  const total = n?.blocks || 0;
  if (!(total > 0)) return "";
  const kids = [...(view.children || [])].filter((c) => c.blocks > 0).sort((a, b) => b.blocks - a.blocks);
  const shown = kids.slice(0, TM_MAX_TILES);
  const folded = kids.slice(TM_MAX_TILES);
  const restBytes = (view.rest || 0) + folded.reduce((s, c) => s + c.blocks, 0);
  const items = shown.map((c) => ({ value: c.blocks, c }));
  if (restBytes > 0) items.push({ value: restBytes, rest: true });
  items.sort((a, b) => b.value - a.value);
  const cells = squarify(items, TM_W, TM_H);
  const restName = `其余${folded.length ? `（含另外 ${num(folded.length)} 个目录）` : ""}`;
  const tiles = cells.map((cell) => {
    const style = `left:${((cell.x / TM_W) * 100).toFixed(3)}%;top:${((cell.y / TM_H) * 100).toFixed(3)}%;width:${((cell.w / TM_W) * 100).toFixed(3)}%;height:${((cell.h / TM_H) * 100).toFixed(3)}%`;
    if (cell.rest) {
      const share = cell.value / total;
      return `<div class="sa-tm-tile" data-tone="rest" style="${style}" tabindex="0"${tip(restName, size(cell.value), `占这一层 ${pct(share)} · 较小的子目录与直接文件`)} aria-label="${attr(`${restName} ${size(cell.value)}`)}">` +
        `<span class="sa-tm-label"><b>其余</b><span class="sa-tm-size">${escapeHtml(size(cell.value))}</span></span></div>`;
    }
    const c = cell.c;
    const share = total ? c.blocks / total : 0;
    const meta = [`占这一层 ${pct(share)}`, c.owner ? `属主 ${c.owner}` : "", Number.isFinite(c.files) ? `${num(c.files)} 个文件` : "", c.deeper ? "点击进入" : ""].filter(Boolean).join(" · ");
    const inner = `<span class="sa-tm-label"><b>${escapeHtml(c.name)}</b><span class="sa-tm-size">${escapeHtml(size(c.blocks))} · ${pct(share)}</span></span>`;
    const common = `class="sa-tm-tile" data-tone="${tone(share)}" style="${style}"${tip(`${c.name}/`, size(c.blocks), meta)} aria-label="${attr(`${c.name} ${size(c.blocks)}，${meta}`)}"`;
    return c.deeper
      ? `<button type="button" ${common} data-sa-rel="${attr(c.rel)}">${inner}</button>`
      : `<div ${common} tabindex="0">${inner}</div>`;
  }).join("");
  return `<div class="sa-tm" role="group" aria-label="${attr(`${view.path} 的子目录占用（矩形面积 = 占用）`)}">${tiles}</div>`;
}

// 树图旁的排序列表：长条按这一层最大的那项缩放（看相对大小），百分比是占这一层的比例。
export function rankedRowsHtml(view, { clockText = () => "", fold = null } = {}) {
  const n = view.node;
  const kids = [...(view.children || [])].sort((a, b) => b.blocks - a.blocks);
  const max = Math.max(kids[0]?.blocks || 0, view.rest || 0);
  const row = (name, owner, bytes, share, files, mtime, extra = "") => (
    `<tr${extra}><td class="sa-name">${name}</td><td class="sa-dim sa-owner">${escapeHtml(owner || "")}</td>` +
    `<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:${w(max ? bytes / max : 0)}"></span></span></td>` +
    `<td class="sa-num sa-strong-num">${escapeHtml(size(bytes))}</td><td class="sa-num">${pct(share)}</td>` +
    `<td class="sa-num sa-dim sa-files-col">${escapeHtml(num(files))}</td><td class="sa-num sa-dim sa-mtime">${escapeHtml(mtime)}</td></tr>`
  );
  const folded = foldList(kids, `dirs:${view.path}`, fold);
  const rows = folded.shown.map((c) => {
    const name = c.deeper
      ? `<button type="button" class="text-btn sa-dir" data-sa-rel="${attr(c.rel)}">${escapeHtml(c.name)}/</button>`
      : `<span>${escapeHtml(c.name)}/</span>`;
    return row(name, c.owner, c.blocks, c.share, c.files, clockText(c.mtime));
  }).join("");
  const rest = view.rest > 0
    ? row(`其余（小于 ${escapeHtml(size(view.threshold))} 的子目录与直接文件${view.hiddenChildren ? `，及另外 ${num(view.hiddenChildren)} 个目录` : ""}）`, "", view.rest, n.blocks ? view.rest / n.blocks : 0, NaN, "", ' class="sa-rest"')
    : "";
  if (!rows && !rest) return '<p class="sa-note">这一层下面没有超过阈值的子目录。</p>';
  return `<div class="sa-table-wrap"><table class="sa-table sa-ranked"><thead><tr><th>目录（按占用）</th><th class="sa-owner">属主</th><th class="sa-barcell"><span class="sa-visually-hidden">相对占用</span></th>` +
    `<th class="sa-num">占用</th><th class="sa-num">占这一层</th><th class="sa-num sa-files-col">文件数</th><th class="sa-num sa-mtime">修改</th></tr></thead><tbody>${rows}${rest}</tbody></table></div>${folded.toggle}`;
}

// ---------- 服务器页磁盘卡片里的入口 ----------

// 在概览里找与「正在看的服务器 / 它的 $HOME 所在挂载点」对应的那块盘：先按主机地址，再按挂载点。
export function pickEntryDisk(data, { hosts = [], mount = "" } = {}) {
  const targets = (data?.targets || []).filter((t) => t.info?.mounts?.length);
  if (!targets.length) return null;
  const byHost = targets.filter((t) => hosts.includes(t.host));
  const pool = byHost.length ? byHost : targets;
  for (const t of pool) {
    const m = t.info.mounts.find((x) => mount && x.mount === mount);
    if (m) return { target: t, mount: m, users: (t.users || []).find((u) => u.mount === m.mount) || null };
  }
  // 对不上：取最满的那块（存储管理最关心的就是它）。
  let best = null;
  for (const t of pool) {
    for (const m of t.info.mounts) {
      if (!best || usedRatio(m) > usedRatio(best.mount)) best = { target: t, mount: m, users: (t.users || []).find((u) => u.mount === m.mount) || null };
    }
  }
  return best;
}

export function diskEntryHtml(data, ctx = {}) {
  const pick = pickEntryDisk(data, ctx);
  const go = '<span class="res-sa-go" aria-hidden="true">→</span>';
  const head = '<span class="res-sa-title">存储管理</span>';
  if (!pick) return `${head}<span class="res-sa-sum">各盘按用户占用与目录树</span>${go}`;
  const { target, mount, users } = pick;
  const where = `${target.label} ${mount.mount}`;
  const u = users?.rows?.length ? users : null;
  const s = u ? userSummary(u) : null;
  const sum = s?.top
    ? `${where} · 最多 ${ownerName(s.top)} ${size(s.top.bytes)}`
    : `${where} · 已用 ${pct(usedRatio(mount))}`;
  const bar = u ? `<span class="res-sa-split">${splitSegments({ ...u, avail: mount.avail }).map((seg) => (
    `<span class="sa-seg" data-kind="${seg.kind}"${seg.slot ? ` data-slot="${seg.slot}"` : ""} style="flex-grow:${(seg.ratio * 1000).toFixed(2)}"></span>`
  )).join("")}</span>` : "";
  return `${head}<span class="res-sa-sum">${escapeHtml(sum)}</span>${bar}${go}`;
}
