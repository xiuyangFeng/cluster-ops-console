// team-admin-view.js —— 「团队管理」页的纯渲染函数（无 DOM 依赖，Node 可直接单测）。
// 星图本体在 render/team-galaxy.js；这里出：横幅、星图标题行与底部读数带、按轨道分组的成员名单
//（列表 / 卡片两种排布，点开原地展开详情）、行星信息卡、行内「更多」菜单。
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";
import {
  buildConstellations,
  compareUser,
  egressReasonLabel,
  hueStyle,
  isOnlineMember,
  maxTodayTokens,
  memberFlags,
  ORBIT_KEYS,
  toMs,
} from "./team-galaxy-model.js";

export function formatTokenCount(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function formatUsdCompact(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 0.01) return "<$0.01";
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

export function isMemberNeedingAttention(m) {
  return memberFlags(m).length > 0;
}

const searchHayCache = new WeakMap();
function searchHayOf(m) {
  if (!m || typeof m !== "object") return "";
  let hay = searchHayCache.get(m);
  if (hay !== undefined) return hay;
  hay = [
    m.user,
    m.displayName,
    m.note,
    m.assignedPort ? String(m.assignedPort) : "",
    m.activePort ? String(m.activePort) : "",
    Array.isArray(m.registeredPorts) ? m.registeredPorts.join(" ") : "",
    Array.isArray(m.compute?.nodes) ? m.compute.nodes.join(" ") : "",
    m.assignment?.groupLabel || "",
    m.usage?.topModel || "",
    m.clientVersion || "",
  ]
    .join(" ")
    .toLowerCase();
  searchHayCache.set(m, hay);
  return hay;
}

export function createTeamMatcher({ filter = "all", query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  return (m) => {
    if (!m) return false;
    if (filter === "online" && !isOnlineMember(m)) return false;
    if (filter === "offline" && m.onlineState !== "offline") return false;
    if (filter === "roster" && !m.inRoster) return false;
    if (filter === "attention" && !isMemberNeedingAttention(m)) return false;
    if (!q) return true;
    return searchHayOf(m).includes(q);
  };
}

export function filterTeamMembers(members, { filter = "all", query = "" } = {}) {
  const list = Array.isArray(members) ? members : [];
  if (filter === "all" && !String(query || "").trim()) return list.slice();
  return list.filter(createTeamMatcher({ filter, query }));
}

const filterCountsCache = new WeakMap();
export function teamFilterCounts(members) {
  const list = Array.isArray(members) ? members : [];
  const cached = filterCountsCache.get(list);
  if (cached) return cached;
  let online = 0;
  let offline = 0;
  let roster = 0;
  let attention = 0;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (isOnlineMember(m)) online += 1;
    if (m?.onlineState === "offline") offline += 1;
    if (m?.inRoster) roster += 1;
    if (isMemberNeedingAttention(m)) attention += 1;
  }
  const counts = { all: list.length, online, offline, roster, attention };
  filterCountsCache.set(list, counts);
  return counts;
}

export function buildHubBannerHtml(hub, { notice = null, configGroups = null } = {}) {
  if (!hub && !notice && (!Array.isArray(configGroups) || !configGroups.length)) return "";
  const banners = [];
  if (notice && notice.text) {
    const levelCls = notice.level === "crit" ? " is-crit" : notice.level === "warn" ? " is-warn" : " is-ok";
    banners.push(
      `<div class="tm-hub-banner${levelCls}" role="status" aria-label="团队置顶公告">` +
        '<div class="tm-hub-banner-body">' +
        `<div class="tm-hub-banner-title">📢 ${escapeHtml(notice.title || "团队公告")}${notice.author ? ` · <small>${escapeHtml(notice.author)}</small>` : ""}</div>` +
        `<div class="tm-hub-banner-desc">${escapeHtml(notice.text)}</div>` +
        "</div>" +
        '<div class="tm-hub-actions">' +
          '<button type="button" class="btn btn-secondary" data-tm-edit-notice>编辑公告</button>' +
          '<button type="button" class="text-btn" data-tm-clear-notice>清除</button>' +
        "</div>" +
      "</div>"
    );
  }
  const alertGroups = Array.isArray(configGroups)
    ? configGroups.filter((g) => g && g.highErrorRate && Array.isArray(g.users) && g.users.length > 0)
    : [];
  for (const g of alertGroups) {
    const pct = Math.round(Number(g.errorRate || 0) * 100);
    const usersAttr = escapeHtml(g.users.join(","));
    banners.push(
      '<div class="tm-hub-banner is-warn" role="alert" aria-label="配置星座限流预警">' +
        '<div class="tm-hub-banner-body">' +
        `<div class="tm-hub-banner-title">⚠️ 配置池「${escapeHtml(g.label || g.key)}」疑似触发限流或配额耗尽</div>` +
        `<div class="tm-hub-banner-desc">共用该配置的 ${g.users.length} 位成员（${escapeHtml(g.users.join("、"))}）今日累计调用 ${Number(g.todayCalls || 0)} 次，失败 ${Number(g.todayErrors || 0)} 次（失败率 ${pct}%）。建议整组一键轮换备用 API Key：</div>` +
        "</div>" +
        '<div class="tm-hub-actions">' +
          `<button type="button" class="btn btn-primary" data-tm-assign-group="${usersAttr}">整组轮换 Key (${g.users.length}人)</button>` +
        "</div>" +
      "</div>"
    );
  }
  if (hub && !hub.ready) {
    const cmd = hub.initCommand || "";
    banners.push(
      '<div class="tm-hub-banner" role="region" aria-label="团队共享目录初始化提示">' +
        '<div class="tm-hub-banner-body">' +
        '<div class="tm-hub-banner-title">共享管理目录尚未完全就绪</div>' +
        `<div class="tm-hub-banner-desc">集群路径 <code class="tm-mono">${escapeHtml(hub.dir || "/public/agent-hub")}</code> 下的管理子目录尚未初始化或权限受限（状态：${escapeHtml(hub.baseState || "unknown")}）。若你有集群 root 账号，推荐点击右侧「配置 Root 赋权」一键完成目录移交与提权：</div>` +
        (cmd
          ? `<div class="tm-hub-cmd"><span>${escapeHtml(cmd)}</span><button type="button" class="text-btn" data-tm-copy-cmd="${escapeHtml(cmd)}">复制命令</button></div>`
          : "") +
        "</div>" +
        '<div class="tm-hub-actions">' +
          '<button type="button" class="btn btn-secondary" data-tm-open-root-guide>配置 Root 赋权</button>' +
          '<button type="button" class="btn btn-primary" data-tm-sync-now>立即尝试初始化</button>' +
        "</div>" +
      "</div>"
    );
  }
  const spoofItems = Array.isArray(hub?.spoofsList)
    ? hub.spoofsList
    : Array.isArray(hub?.spoofsCleaned)
      ? hub.spoofsCleaned
      : [];
  const spoofCount = spoofItems.length || (Number(hub?.spoofsCleaned) > 0 ? Number(hub.spoofsCleaned) : 0);
  if (spoofCount > 0) {
    banners.push(
      '<div class="tm-hub-banner is-ok" role="status">' +
        '<div class="tm-hub-banner-body">' +
        '<div class="tm-hub-banner-title">已自动清理异常属主占坑文件</div>' +
        `<div class="tm-hub-banner-desc">检测到 ${spoofCount} 个文件名与操作系统真实文件属主不匹配的异常文件${spoofItems.length ? `（${escapeHtml(spoofItems.join("、"))}）` : ""}，已自动移除。</div>` +
        "</div>" +
      "</div>"
    );
  }
  return banners.join("");
}

/* —— 星图标题行与底部读数带 —— */

export function buildTeamSkySubHtml(overview, { loading = false, error = "" } = {}) {
  const members = Array.isArray(overview?.members) ? overview.members : null;
  if (!members) {
    const text = error ? "读取失败，稍后自动重试" : loading ? "正在从集群聚合全员状态…" : "尚未读取";
    return `<span>${escapeHtml(text)}</span>`;
  }
  const counts = teamFilterCounts(members);
  return (
    `<span><b>${counts.all}</b> 位成员</span><span class="tm-sep">·</span><span><b>${counts.online}</b> 在线</span>` +
    (counts.attention
      ? `<span class="tm-sep">·</span><button type="button" class="tm-sky-attn" data-tm-goto-attention>${counts.attention} 需关注</button>`
      : "")
  );
}

export function buildTeamReadoutHtml(kpis) {
  const k = kpis || {};
  const cell = (label, value, sub, action = "", tip = "") =>
    `<div class="tm-ro"${action ? ` data-tm-kpi-action="${action}" title="${escapeHtml(tip)}"` : ""}><div class="tm-ro-label">${label}</div><div class="tm-ro-value">${value}</div><div class="tm-ro-sub">${sub}</div></div>`;
  const outdated = Number(k.outdatedCount || 0);
  const costStr = formatUsdCompact(k.totalTodayCostUsd);
  const unmanaged = Number(k.unmanagedGpusTotal || 0);
  const idleGpus = Number(k.idleGpusTotal || 0);
  const hygieneTag =
    unmanaged > 0
      ? ` · <span class="tm-crit-text">裸跑 ${unmanaged}</span>`
      : idleGpus > 0
        ? ` · <span class="tm-warn-text">空占 ${idleGpus}</span>`
        : "";
  return (
    cell("团队成员", `${Number(k.totalMembers || 0)}<small>人</small>`, `名册已登记 ${Number(k.rosterMembers || 0)} 人`, "roster", "点击切换筛选：名册内成员 / 全部成员") +
    cell("实时在线", `${Number(k.tunnelOnlineCount || 0)}<small>隧道</small>`, `仅 SSH 在线 ${Number(k.sshOnlyCount || 0)} 人`, "online", "点击切换筛选：实时在线成员") +
    cell(
      "今日 AI 用量",
      escapeHtml(formatTokenCount(k.totalTodayTokens || 0)),
      `${Number(k.totalTodayCalls || 0).toLocaleString("zh-CN")} 次${costStr ? ` · 约 ${escapeHtml(costStr)}` : ""} · 7 天 ${escapeHtml(formatTokenCount(k.totalWeekTokens || 0))}`,
      "tokens",
      "点击切换排序：按今日 Token 用量 / 7 天用量降序"
    ) +
    cell(
      "集群算力占用",
      `${Number(k.totalGpusUsed || 0)}<small>GPU 卡</small>`,
      `运行 ${Number(k.totalRunningJobs || 0)} · 排队 ${Number(k.totalPendingJobs || 0)}${hygieneTag}`,
      "gpu",
      "点击按 GPU 算力占用降序排列"
    ) +
    cell(
      "配置托管",
      `${Number(k.managedKeyCount || 0)}<small>已托管</small>`,
      `待同步 ${Number(k.pendingSyncCount || 0)}${outdated ? ` · <span class="tm-warn-text">旧版本 ${outdated}</span>` : ""}`,
      "config",
      "点击打开批量 AI 配置下发"
    )
  );
}

/* —— 成员名单 —— */

const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const ICON_SYNC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8.5M4 13a8 8 0 0 0 14.3 4.6L20 15.5"/><path d="M4 4v4.5h4.5M20 20v-4.5h-4.5"/></svg>';
const ICON_KEY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

const CFG_STATES = {
  applied: { cls: "is-applied", icon: ICON_CHECK, text: "已生效" },
  "pending-sync": { cls: "is-pending", icon: ICON_SYNC, text: "待成员同步" },
  "pending-pubkey": { cls: "is-pubkey", icon: ICON_KEY, text: "待公钥上报" },
  error: { cls: "is-error", icon: ICON_X, text: "同步异常" },
  none: { cls: "is-none", icon: "", text: "未托管" },
};

const GROUP_NAMES = { "tunnel-online": "隧道在线", "ssh-only": "仅 SSH 在线", offline: "离线" };

function nameOf(m) {
  return m?.displayName && m.displayName !== m.user ? m.displayName : m?.user || "";
}

function orbitGlyph(i) {
  const rx = 5 + i * 2.6;
  const ry = 2.2 + i * 0.9;
  return (
    `<svg class="tm-orbit-glyph" viewBox="0 0 20 10" aria-hidden="true"><ellipse cx="10" cy="5" rx="${rx}" ry="${ry}"${i === 2 ? ' stroke-dasharray="1.4 1.8"' : ""}/>` +
    `<circle cx="${(10 + rx * 0.7).toFixed(2)}" cy="${(5 + ry * 0.7).toFixed(2)}" r="1.7"/></svg>`
  );
}

function flagActionAttr(f, userHtml) {
  if (!f || !userHtml) return "";
  if (f.text === "配置同步异常" || f.text === "待公钥上报" || f.text === "配置待同步") {
    return ` data-tm-assign="${userHtml}"`;
  }
  if (f.text === "端口漂移") {
    return ` data-tm-edit="${userHtml}"`;
  }
  return "";
}

// 标签统一用 <button type="button"> 渲染：可点击的标签（纳管 / 下发 / 跳转）从此能用 Tab 聚焦、
// Enter / Space 触发（走名单上现成的 click 委托，行为与鼠标完全一致）。纯信息标签（我 / 已停用 / +N）
// 也保留 button 视觉，但 tabindex="-1" 且 data-tm-tag-static，不占 Tab 序列、不改光标，避免读屏
// 把「我」这类状态念成一个可操作按钮。
function tagTabAttr(action, tabbable) {
  if (!action) return ' data-tm-tag-static="1" tabindex="-1"';
  // roving tabindex：只有展开行的标签进入 Tab 序列，长名单不会为每行新增 1–2 个停顿点。
  return ` tabindex="${tabbable ? "0" : "-1"}"`;
}

function staticTag(text, { cls = "", title = "" } = {}) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<button type="button" class="tm-tag${cls ? ` ${cls}` : ""}" data-tm-tag-static="1" tabindex="-1"${titleAttr}>${text}</button>`;
}

function flagTag(f, extraCls = "", userHtml = "", { tabbable = false } = {}) {
  const actAttr = flagActionAttr(f, userHtml);
  const cls = [extraCls, actAttr ? "tm-tag-action" : ""].filter(Boolean).join(" ");
  const tip = f.title ? `${f.text}：${f.title}` : f.text;
  return `<button type="button" class="tm-tag is-${f.tone}${cls ? ` ${cls}` : ""}"${actAttr}${tagTabAttr(Boolean(actAttr), tabbable)} title="${escapeHtml(tip)}">${escapeHtml(f.text)}</button>`;
}

function lastSeenText(m, now) {
  const ts = toMs(m.lastSeenAt);
  return ts ? formatRelativeTime(ts, now) || "刚刚" : "从未上线";
}

function linkHtml(m, now) {
  if (m.onlineState === "tunnel-online") {
    return `<i class="tm-dot is-tunnel" aria-hidden="true"></i><span class="tm-mono">${m.activePort ? `:${escapeHtml(m.activePort)}` : "隧道在线"}</span>`;
  }
  if (m.onlineState === "ssh-only") return '<i class="tm-dot is-ssh" aria-hidden="true"></i><span>仅 SSH</span>';
  return `<i class="tm-dot is-off" aria-hidden="true"></i><span class="tm-muted">${escapeHtml(m.enabled === false ? "已停用" : lastSeenText(m, now))}</span>`;
}

function cfgLabel(m) {
  const a = m.assignment || {};
  if (!a.state || a.state === "none") return "自主配置";
  return a.groupLabel || "统一配置";
}

function moonsHtml(count) {
  const n = Math.min(8, Math.max(0, Number(count) || 0));
  return n ? `<span class="tm-moons" title="GPU ${Number(count)} 卡">${"<i></i>".repeat(n)}</span>` : "";
}

function formatActiveAgents(activeAgents) {
  if (typeof activeAgents === "number" && Number.isFinite(activeAgents)) {
    return `${activeAgents} 个进程`;
  }
  if (activeAgents && typeof activeAgents === "object") {
    const entries = Object.entries(activeAgents)
      .map(([k, v]) => [k, Number(v) || 0])
      .filter(([, n]) => n > 0);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    if (!total) return "0 个进程";
    const detail = entries.map(([k, n]) => `${escapeHtml(k)} ×${n}`).join(" · ");
    return `${total} 个进程（${detail}）`;
  }
  return "0 个进程";
}

// CLI 登录方式的机器枚举 → 中文（lib/cli/detect.mjs 的 classifyCodexLogin / classifyClaudeLogin 产出）。
// 直接裸输出会变成「Codex v0.42.0（none）」这种给用户看的英文枚举；没有 loginDetail 时兜底成中文。
const CLI_LOGIN_LABELS = Object.freeze({
  none: "未登录",
  unknown: "登录态未知",
  apikey: "官方 API key",
  api: "官方 API key",
  chatgpt: "ChatGPT 账号",
  subscription: "订阅账号",
});

function formatCliStatus(cli) {
  if (!cli || typeof cli !== "object") return "";
  const parts = [];
  for (const [id, label] of [
    ["codex", "Codex"],
    ["claude", "Claude"],
  ]) {
    const item = cli[id];
    if (!item || typeof item !== "object") continue;
    if (!item.installed) {
      parts.push(`${label} 未安装`);
      continue;
    }
    const ver = item.version ? ` v${escapeHtml(item.version)}` : "";
    const detail = item.loginDetail || CLI_LOGIN_LABELS[item.login] || item.login || "";
    const login = detail ? `（${escapeHtml(detail)}）` : "";
    parts.push(`${label}${ver}${login}`);
  }
  return parts.join(" · ");
}

function memberTags(m, { tabbable = false } = {}) {
  const tags = [];
  const u = escapeHtml(m?.user || "");
  if (m.isSelf) tags.push(staticTag("我", { cls: "is-self" }));
  if (!m.inRoster) {
    tags.push(
      `<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="${u}"${tagTabAttr(true, tabbable)} title="在集群上自动发现的活跃账号，点击纳入名册并分配专属端口">自动发现</button>`
    );
  } else if (m.enabled === false) {
    tags.push(staticTag("已停用", { cls: "is-warn tm-tag-roster" }));
  }
  const flags = memberFlags(m);
  if (flags[0]) tags.push(flagTag(flags[0], "tm-tag-flag", u, { tabbable }));
  if (flags.length > 1) {
    const moreTip = flags
      .slice(1)
      .map((f) => (f.title ? `${f.text}（${f.title}）` : f.text))
      .join("、");
    tags.push(staticTag(`+${flags.length - 1}`, { cls: "tm-tag-more", title: moreTip }));
  }
  return tags.join("");
}

function actionButtons(m, { busy = false, withDanger = true } = {}) {
  const dis = busy ? " disabled" : "";
  const u = escapeHtml(m.user);
  const btns = [
    `<button type="button" class="tm-act" data-tm-assign="${u}"${dis}>下发配置</button>`,
    `<button type="button" class="tm-act" data-tm-edit="${u}"${dis}>${m.inRoster ? "编辑名册" : "纳入名册"}</button>`,
  ];
  if (m.tunnelOnline && m.activePort && !m.isSelf) {
    const p = escapeHtml(m.activePort);
    btns.push(`<button type="button" class="tm-act" data-tm-kill-user="${u}" data-tm-kill-port="${p}" title="强行终止集群上占用端口 :${p} 的隧道 sshd 进程"${dis}>强踢隧道 :${p}</button>`);
  }
  for (const port of Array.isArray(m.registeredPorts) ? m.registeredPorts : []) {
    if (!m.tunnelOnline || Number(port) !== Number(m.activePort)) {
      const p = escapeHtml(port);
      btns.push(`<button type="button" class="tm-act" data-tm-release-user="${u}" data-tm-release-port="${p}" title="回收闲置端口 :${p}"${dis}>释放闲置端口 :${p}</button>`);
    }
  }
  if (withDanger && m.inRoster) btns.push(`<button type="button" class="tm-act is-danger" data-tm-remove="${u}"${dis}>移出名册</button>`);
  return btns;
}

function detailHtml(m, ctx) {
  const now = ctx.now;
  const a = m.assignment || { state: "none" };
  const st = CFG_STATES[a.state] || CFG_STATES.none;
  const u = m.usage || {};
  const c = m.compute || {};
  const userHtml = escapeHtml(m.user);
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  const mateUsers = (users) => users.filter((x) => x !== m.user);
  const names = (users) => mateUsers(users).map((x) => nameOf(ctx.byUser.get(x) || { user: x }));
  const cfgGroup = a.groupKey ? ctx.constellations.config.find((g) => g.key === a.groupKey) : null;
  const cfgMateUserIds = cfgGroup ? mateUsers(cfgGroup.users) : [];
  const cfgMates = cfgGroup ? names(cfgGroup.users) : [];
  const nodeMateUserIds = [...new Set(ctx.constellations.node.filter((g) => nodes.includes(g.key)).flatMap((g) => mateUsers(g.users)))];
  const nodeMates = nodeMateUserIds.map((x) => nameOf(ctx.byUser.get(x) || { user: x }));

  const link =
    m.onlineState === "tunnel-online"
      ? `隧道在线${m.activePort ? ` · :${escapeHtml(m.activePort)}` : ""}`
      : m.onlineState === "ssh-only"
        ? "仅 SSH 在线"
        : `离线 · ${escapeHtml(lastSeenText(m, now))}`;
  const reg = Array.isArray(m.registeredPorts) ? m.registeredPorts : [];
  const ports = [
    m.assignedPort ? `预分配 :${escapeHtml(m.assignedPort)}` : "未预分配",
    reg.length ? `已登记 :${reg.map((p) => escapeHtml(p)).join(", :")}` : "未登记",
  ].join(" · ");
  const egress =
    m.egress?.state && m.egress.state !== "ok" && m.egress.state !== "unknown"
      ? `${m.egress.state === "error" ? "异常" : "部分失败"}${m.egress.reason ? ` · ${escapeHtml(egressReasonLabel(m.egress.reason))}` : ""}`
      : m.egress?.state === "ok"
        ? "正常"
        : "未上报";
  const cliStatus = formatCliStatus(m.cli);

  const cliLine = (spec, name) => {
    if (!spec) return null;
    if (spec.mode === "official") return [name, `官方直连${spec.keyMask ? ` · ${escapeHtml(spec.keyMask)}` : ""}`];
    const via = spec.providerId || spec.providerName || spec.baseUrl || "中转";
    return [name, `${escapeHtml(via)}${spec.keyMask ? ` · ${escapeHtml(spec.keyMask)}` : ""}`];
  };
  const ackMs = toMs(a.ackAt);
  const assignedMs = toMs(a.assignedAt);
  const cfgTimePart = ackMs
    ? ` · 同步于 ${escapeHtml(formatRelativeTime(ackMs, now) || "刚刚")}`
    : assignedMs
      ? ` · 下发于 ${escapeHtml(formatRelativeTime(assignedMs, now) || "刚刚")}`
      : "";
  const errReason = a.message || a.ackError || "";
  const cfgErrPart =
    a.state === "error" && errReason ? ` · <span class="tm-crit-text">${escapeHtml(errReason)}</span>` : "";
  const cfgRows = [["状态", `${st.text}${a.rev ? ` · rev ${escapeHtml(a.rev)}` : ""}${cfgTimePart}${cfgErrPart}`]];
  const codexRow = cliLine(a.summary?.codex, "Codex");
  const claudeRow = cliLine(a.summary?.claude, "Claude");
  if (codexRow) cfgRows.push(codexRow);
  if (claudeRow) cfgRows.push(claudeRow);
  if (!codexRow && !claudeRow) cfgRows.push(["方案", "成员自主配置"]);
  cfgRows.push(["公钥", m.hasPubKey ? "已上报" : "未上报"]);
  const cfgMatesHtml = cfgMates.length
    ? `<button type="button" data-tm-locate-user="${escapeHtml(cfgMateUserIds[0] || "")}" title="点击定位同配队友" class="tm-inline-jump tm-cfg-mates">${escapeHtml(cfgMates.join("、"))}</button> · <button type="button" class="text-btn" data-tm-assign-group="${escapeHtml(cfgGroup.users.join(","))}">整组轮换 (${cfgGroup.users.length}人)</button>`
    : "—";
  cfgRows.push(["同配", cfgMatesHtml]);

  const gpuText = c.gpuCount
    ? `${Number(c.gpuCount)} 卡${c.gpuMemMiB ? ` · 显存 ${escapeHtml(formatBytes(c.gpuMemMiB * 1048576, { compact: true }))}` : ""}`
    : "无";
  const jobsText = `运行 ${Number(c.runningJobs || 0)} · 排队 ${Number(c.pendingJobs || 0)}${
    Array.isArray(c.jobNames) && c.jobNames.length ? ` · ${escapeHtml(c.jobNames.join("、"))}` : ""
  }`;
  const cpuMemParts = [];
  if (Number(c.cpuPct) > 0) cpuMemParts.push(`CPU ${Number(c.cpuPct).toFixed(1).replace(/\.0$/, "")}%`);
  if (Number(c.rssKb) > 0) cpuMemParts.push(`内存 ${escapeHtml(formatBytes(Number(c.rssKb) * 1024, { compact: true }))}`);
  const fsPct = Number(m.storage?.fsCapacityPct);
  const homeBase = m.storage?.homeDirBytes != null ? escapeHtml(formatBytes(m.storage.homeDirBytes, { compact: true })) : "—";
  const home = homeBase !== "—" && Number.isFinite(fsPct) && fsPct > 0 ? `${homeBase} · 分区 ${Math.round(fsPct)}%` : homeBase;
  const todayCost = formatUsdCompact(u.todayCostUsd);
  const weekCost = formatUsdCompact(u.weekCostUsd);
  const lastActiveMs = toMs(u.lastActiveAt);
  const hygieneParts = [];
  if (Number(c.loginGpuCount) > 0) hygieneParts.push(`<span class="tm-crit-text">登录节点占卡 ×${Number(c.loginGpuCount)}</span>`);
  if (Number(c.unmanagedGpuCount) > 0) hygieneParts.push(`<span class="tm-warn-text">非 Slurm 占卡 ×${Number(c.unmanagedGpuCount)}</span>`);
  if (Number(c.idleGpuCount) > 0) hygieneParts.push(`<span class="tm-warn-text">0% 空占显存 ×${Number(c.idleGpuCount)}</span>`);
  const nodesJumpHtml = nodes
    .map(
      (nd) =>
        `<button type="button" class="tm-inline-jump tm-node" data-tm-filter-node="${escapeHtml(nd)}" title="点击按节点 ${escapeHtml(nd)} 过滤成员">${escapeHtml(nd)}</button>`
    )
    .join("、");
  const nodeMatesJumpHtml = nodeMates.length
    ? ` · <button type="button" class="tm-inline-jump" data-tm-locate-user="${escapeHtml(nodeMateUserIds[0] || "")}" title="点击定位同节点队友">同节点 ${escapeHtml(nodeMates.join("、"))}</button>`
    : "";
  const computeRows = [
    ["GPU", gpuText],
    ["节点", nodes.length ? `${nodesJumpHtml}${nodeMatesJumpHtml}` : "—"],
    ["作业", jobsText],
    ...(cpuMemParts.length ? [["CPU / 内存", cpuMemParts.join(" · ")]] : []),
    ...(hygieneParts.length ? [["算力卫生", hygieneParts.join(" · ")]] : []),
    ["家目录", home],
  ];

  const linkRows = [
    ["状态", link],
    ["端口", ports],
    ["客户端", m.clientVersion ? `v${escapeHtml(m.clientVersion)}` : "未上报"],
    ["Agent", formatActiveAgents(m.activeAgents)],
    ...(cliStatus ? [["CLI", cliStatus]] : []),
    ["出网", egress],
  ];

  const usageRows = [
    [
      "今日",
      `${escapeHtml(formatTokenCount(u.todayTokens))} · ${Number(u.todayCalls || 0)} 次${todayCost ? ` · 约 ${escapeHtml(todayCost)}` : ""}${
        u.todayErrors ? ` · <span class="tm-crit-text">${Number(u.todayErrors)} 失败</span>` : ""
      }`,
    ],
    [
      "7 天",
      `${escapeHtml(formatTokenCount(u.weekTokens))} · ${Number(u.weekCalls || 0)} 次${weekCost ? ` · 约 ${escapeHtml(weekCost)}` : ""}${
        u.weekErrors ? ` · <span class="tm-crit-text">${Number(u.weekErrors)} 失败</span>` : ""
      }`,
    ],
    ["常用模型", u.topModel ? escapeHtml(u.topModel) : "—"],
    ...(lastActiveMs ? [["最近活跃", escapeHtml(formatRelativeTime(lastActiveMs, now) || "刚刚")]] : []),
  ];

  const sec = (title, rows) =>
    `<div class="tm-dsec"><h4>${title}</h4><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
  const flags = memberFlags(m);
  return (
    '<div class="tm-detail">' +
      (flags.length
        ? `<div class="tm-detail-flags">${flags.map((f) => {
            const act = flagActionAttr(f, userHtml);
            return `<button type="button" class="tm-tag is-${f.tone}${act ? " tm-tag-action" : ""}"${act}${tagTabAttr(Boolean(act), true)}>${escapeHtml(f.text)}${f.title ? `：${escapeHtml(f.title)}` : ""}</button>`;
          }).join("")}</div>`
        : "") +
      (m.note ? `<div class="tm-detail-note">${escapeHtml(m.note)}</div>` : "") +
      sec("链路", linkRows) +
      sec("统一 AI 配置", cfgRows) +
      sec("AI 用量", usageRows) +
      sec("算力与存储", computeRows) +
      `<div class="tm-detail-actions">${[
        ...actionButtons(m, { busy: ctx.busy }),
        `<button type="button" class="tm-act" data-tm-copy-diag="${userHtml}" title="复制该成员的 Markdown 诊断卡，便于直接发给成员排查"${ctx.busy ? " disabled" : ""}>复制诊断卡</button>`,
      ].join("")}</div>` +
    "</div>"
  );
}

function usagePct(m, maxTok) {
  const t = Number(m.usage?.todayTokens) || 0;
  if (!maxTok || t <= 0) return 0;
  return Math.max(4, Math.min(100, (t / maxTok) * 100));
}

const closedFragCache = new WeakMap();
function getClosedFrag(m, kind, key, build) {
  if (!m || typeof m !== "object") return build();
  let rec = closedFragCache.get(m);
  if (!rec) {
    rec = {};
    closedFragCache.set(m, rec);
  }
  const slot = `${kind}:${key}`;
  if (rec[slot] !== undefined) return rec[slot];
  const html = build();
  rec[slot] = html;
  return html;
}

function rowHtml(m, ctx) {
  const open = ctx.open === m.user;
  const hasDetail = ctx.details.has(m.user);
  if (!open && !hasDetail) {
    const tKey = isOnlineMember(m) || m.enabled === false ? 0 : Math.floor(ctx.now / 15000);
    return getClosedFrag(m, "row", `${ctx.maxTok}|${ctx.busy ? 1 : 0}|${tKey}`, () => buildRowHtmlInner(m, ctx, false, false));
  }
  return buildRowHtmlInner(m, ctx, open, hasDetail);
}

function buildRowHtmlInner(m, ctx, open, hasDetail) {
  const st = CFG_STATES[m.assignment?.state] || CFG_STATES.none;
  const c = m.compute || {};
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  const u = escapeHtml(m.user);
  const showId = m.displayName && m.displayName !== m.user;
  const nodesHtml = nodes.length
    ? `<span class="tm-node tm-inline-jump" data-tm-filter-node="${escapeHtml(nodes[0])}" title="点击按节点 ${escapeHtml(nodes[0])} 过滤成员">${escapeHtml(nodes.join(" · "))}</span>`
    : c.gpuCount
      ? ""
      : '<span class="tm-muted">—</span>';
  const dis = ctx.busy ? " disabled" : "";
  const whoTitle = showId ? `${nameOf(m)} (${m.user})` : nameOf(m);
  const detailId = `tm-detail-${u}`;
  return (
    `<div class="tm-row${isOnlineMember(m) ? "" : " is-off"}${open ? " is-open" : ""}" data-tm-member="${u}" style="${hueStyle(m.user)}">` +
      `<div class="tm-row-main" data-tm-toggle="${u}">` +
        `<div class="tm-row-who"><span class="tm-planet-dot" aria-hidden="true"></span><span class="tm-row-name" title="${escapeHtml(whoTitle)}">${escapeHtml(nameOf(m))}</span>${showId ? `<span class="tm-row-id">${u}</span>` : ""}${memberTags(m, { tabbable: open })}</div>` +
        `<div class="tm-row-link">${linkHtml(m, ctx.now)}</div>` +
        `<div class="tm-row-cfg ${st.cls}" title="${escapeHtml(st.text)}">${st.icon}<span>${escapeHtml(cfgLabel(m))}</span></div>` +
        `<div class="tm-row-use"><b>${escapeHtml(formatTokenCount(m.usage?.todayTokens))}</b><span class="tm-bar"><i style="width:${usagePct(m, ctx.maxTok).toFixed(1)}%"></i></span><span class="tm-row-calls">${Number(m.usage?.todayCalls || 0)} 次</span></div>` +
        `<div class="tm-row-gpu">${moonsHtml(c.gpuCount)}${nodesHtml}</div>` +
        `<div class="tm-row-acts"><button type="button" class="tm-act tm-act-quick" data-tm-assign="${u}"${dis}>下发配置</button><button type="button" class="tm-act tm-act-quick" data-tm-edit="${u}"${dis}>${m.inRoster ? "编辑" : "纳入名册"}</button><button type="button" class="tm-act is-icon" data-tm-menu="${u}" aria-haspopup="menu" aria-label="${escapeHtml(nameOf(m))} 的更多操作"${dis}>···</button></div>` +
        `<button type="button" class="tm-chev" data-tm-toggle="${u}" aria-expanded="${open}" aria-controls="${detailId}" aria-label="${open ? "收起" : "展开"} ${escapeHtml(nameOf(m))} 的详情">${ICON_CHEV}</button>` +
      "</div>" +
      `<div class="tm-detail-wrap" id="${detailId}"><div>${hasDetail ? detailHtml(m, ctx) : ""}</div></div>` +
    "</div>"
  );
}

function cardHtml(m, ctx) {
  const open = ctx.open === m.user;
  const hasDetail = ctx.details.has(m.user);
  if (!open && !hasDetail) {
    const tKey = isOnlineMember(m) || m.enabled === false ? 0 : Math.floor(ctx.now / 15000);
    return getClosedFrag(m, "card", `${ctx.maxTok}|${tKey}`, () => buildCardHtmlInner(m, ctx, false, false));
  }
  return buildCardHtmlInner(m, ctx, open, hasDetail);
}

function buildCardHtmlInner(m, ctx, open, hasDetail) {
  const c = m.compute || {};
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  const u = escapeHtml(m.user);
  const flags = memberFlags(m);
  const flag = flags[0];
  const moreFlags =
    flags.length > 1
      ? staticTag(`+${flags.length - 1}`, { cls: "tm-tag-more", title: flags.slice(1).map((f) => (f.title ? `${f.text}（${f.title}）` : f.text)).join("、") })
      : "";
  const rosterBadge = !m.inRoster
    ? `<button type="button" class="tm-tag tm-tag-roster tm-tag-action" data-tm-edit="${u}"${tagTabAttr(true, open)} title="在集群上自动发现的活跃账号，点击纳入名册并分配专属端口">自动发现</button>`
    : m.enabled === false
      ? staticTag("已停用", { cls: "is-warn tm-tag-roster" })
      : "";
  const detailId = `tm-detail-${u}`;
  return (
    `<article class="tm-card${isOnlineMember(m) ? "" : " is-off"}${open ? " is-open" : ""}" data-tm-member="${u}" style="${hueStyle(m.user)}">` +
      `<div class="tm-card-top" data-tm-toggle="${u}">` +
        `<div class="tm-card-head"><span class="tm-planet-dot is-lg" aria-hidden="true"></span>` +
          `<div class="tm-card-who"><b><span>${escapeHtml(nameOf(m))}</span>${m.isSelf ? staticTag("我", { cls: "is-self" }) : ""}${rosterBadge}</b><span>${u}</span></div>` +
          `<div class="tm-card-link">${linkHtml(m, ctx.now)}</div>` +
          `<button type="button" class="tm-chev" data-tm-toggle="${u}" aria-expanded="${open}" aria-controls="${detailId}" aria-label="${open ? "收起" : "展开"} ${escapeHtml(nameOf(m))} 的详情">${ICON_CHEV}</button>` +
        "</div>" +
        `<div class="tm-card-use"><b>${escapeHtml(formatTokenCount(m.usage?.todayTokens))}</b><span>今日 · ${Number(m.usage?.todayCalls || 0)} 次</span>${flag ? `<span class="tm-card-flags">${flagTag(flag, "tm-tag-flag", u, { tabbable: open })}${moreFlags}</span>` : ""}</div>` +
        `<span class="tm-bar"><i style="width:${usagePct(m, ctx.maxTok).toFixed(1)}%"></i></span>` +
        `<div class="tm-card-foot">${moonsHtml(c.gpuCount)}${nodes.length ? `<span class="tm-node">${escapeHtml(nodes.join(" · "))}</span>` : `<span>${c.gpuCount ? "" : "无 GPU"}</span>`}<span class="tm-card-cfg">${escapeHtml(cfgLabel(m))}</span></div>` +
      "</div>" +
      `<div class="tm-detail-wrap" id="${detailId}"><div>${hasDetail ? detailHtml(m, ctx) : ""}</div></div>` +
    "</article>"
  );
}

function chipHtml(m, ctx) {
  const tKey = m.enabled === false ? 0 : Math.floor(ctx.now / 15000);
  return getClosedFrag(m, "chip", String(tKey), () => {
    const flag = memberFlags(m)[0];
    return (
      `<button type="button" class="tm-chip" data-tm-chip="${escapeHtml(m.user)}" style="${hueStyle(m.user)}"><span class="tm-planet-dot" aria-hidden="true"></span>${escapeHtml(nameOf(m))}` +
      (flag ? `<span class="tm-fdot is-${flag.tone}" title="${escapeHtml(flag.text)}"></span>` : "") +
      `<span class="tm-chip-ago">${escapeHtml(m.enabled === false ? "已停用" : lastSeenText(m, ctx.now))}</span></button>`
    );
  });
}

export const TEAM_SORT_KEYS = ["default", "errors", "tokens", "week", "gpu", "storage", "name"];
export const TEAM_SORT_LABELS = Object.freeze({
  default: "默认（我在前、今日用量降序）",
  errors: "今日失败降序",
  tokens: "今日用量降序",
  week: "7 天用量降序",
  gpu: "GPU 占用降序",
  storage: "家目录大小降序",
  name: "账号名称升序",
});

export function normalizeTeamSort(raw) {
  return TEAM_SORT_KEYS.includes(raw) ? raw : "default";
}

// 排序控件的读屏说明（与 index.html 的 #teamAdminSortHelp 一致）：原生 select 会念当前选项，
// 这里再补一句「只改变组内顺序、不改变分组」，避免把它误当成筛选。
export function teamSortHint(raw) {
  return `当前按「${TEAM_SORT_LABELS[normalizeTeamSort(raw)]}」排序，只改变每个轨道分组内的先后顺序。`;
}

export function sortGroup(key, items, sortBy = "default") {
  const mode = normalizeTeamSort(sortBy);
  if (mode === "errors") {
    return items.sort(
      (a, b) =>
        (Number(b.usage?.todayErrors) || 0) - (Number(a.usage?.todayErrors) || 0) ||
        memberFlags(b).length - memberFlags(a).length ||
        (Number(b.usage?.todayTokens) || 0) - (Number(a.usage?.todayTokens) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  if (mode === "tokens") {
    return items.sort(
      (a, b) =>
        (Number(b.usage?.todayTokens) || 0) - (Number(a.usage?.todayTokens) || 0) ||
        (Number(b.usage?.todayCalls) || 0) - (Number(a.usage?.todayCalls) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  if (mode === "week") {
    return items.sort(
      (a, b) =>
        (Number(b.usage?.weekTokens) || 0) - (Number(a.usage?.weekTokens) || 0) ||
        (Number(b.usage?.weekCalls) || 0) - (Number(a.usage?.weekCalls) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  if (mode === "gpu") {
    return items.sort(
      (a, b) =>
        (Number(b.compute?.gpuCount) || 0) - (Number(a.compute?.gpuCount) || 0) ||
        (Number(b.compute?.runningJobs) || 0) - (Number(a.compute?.runningJobs) || 0) ||
        (Number(b.compute?.gpuMemMiB) || 0) - (Number(a.compute?.gpuMemMiB) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  if (mode === "storage") {
    return items.sort(
      (a, b) =>
        (Number(b.storage?.homeDirBytes) || 0) - (Number(a.storage?.homeDirBytes) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  if (mode === "name") {
    return items.sort((a, b) => compareUser(nameOf(a), nameOf(b)) || compareUser(a.user, b.user));
  }
  if (key === "offline") {
    return items.sort(
      (a, b) =>
        Number(a.enabled === false) - Number(b.enabled === false) ||
        (toMs(b.lastSeenAt) || 0) - (toMs(a.lastSeenAt) || 0) ||
        compareUser(a.user, b.user)
    );
  }
  return items.sort(
    (a, b) =>
      Number(Boolean(b.isSelf)) - Number(Boolean(a.isSelf)) ||
      (Number(b.usage?.todayTokens) || 0) - (Number(a.usage?.todayTokens) || 0) ||
      compareUser(a.user, b.user)
  );
}

const listMetaCache = new WeakMap();
function getListMeta(all) {
  let meta = listMetaCache.get(all);
  if (meta) return meta;
  meta = {
    maxTok: maxTodayTokens(all),
    byUser: new Map(all.map((m) => [m.user, m])),
    constellations: buildConstellations(all),
  };
  listMetaCache.set(all, meta);
  return meta;
}

export function buildTeamListHtml(
  overview,
  { filter = "all", query = "", sort = "default", layout = "list", open = null, details = null, offlineOpen = false, loading = false, error = "", busy = false, now = Date.now(), theme = "dark" } = {}
) {
  if (!overview && loading) return '<div class="tm-empty" role="status">正在从集群聚合全员在线状态、AI 用量与算力占用…</div>';
  if (!overview && error) return `<div class="tm-empty" role="alert">${escapeHtml(error)}</div>`;
  const all = Array.isArray(overview?.members) ? overview.members : [];
  const rows = filterTeamMembers(all, { filter, query });
  if (!rows.length) {
    const msg = all.length
      ? "没有匹配当前筛选或搜索条件的团队成员。"
      : "当前暂无成员记录。可点击右上角「添加 / 预分配成员」预分配专属隧道端口与 AI 配置。";
    return `<div class="tm-empty">${escapeHtml(msg)}</div>`;
  }
  const meta = getListMeta(all);
  // 详情只渲染展开的那一行（以及正在收起、动画还没放完的那一行）：40 人全渲染时团队页 2600+ 个节点，
  // 首次显示的布局、每次刷新的 morph 比对都按节点数算
  const ctx = {
    open,
    details: new Set([...(details || []), ...(open ? [open] : [])]),
    busy,
    now,
    theme,
    maxTok: meta.maxTok,
    byUser: meta.byUser,
    constellations: meta.constellations,
  };
  const narrowed = filter !== "all" || String(query || "").trim() !== "" || normalizeTeamSort(sort) !== "default";
  const offlineExpanded = offlineOpen || narrowed;
  return ORBIT_KEYS.map((key, i) => {
    const items = sortGroup(
      key,
      rows.filter((m) => (m.onlineState || "offline") === key || (key === "offline" && !ORBIT_KEYS.includes(m.onlineState))),
      sort
    );
    if (!items.length) return "";
    const collapsed = key === "offline" && !offlineExpanded;
    const sum =
      key === "offline"
        ? (() => {
            const latest = Math.max(0, ...items.map((m) => toMs(m.lastSeenAt) || 0));
            return latest ? `最近 ${escapeHtml(formatRelativeTime(latest, now) || "刚刚")}在线` : "";
          })()
        : `今日 ${escapeHtml(formatTokenCount(items.reduce((s, m) => s + (Number(m.usage?.todayTokens) || 0), 0)))} · GPU ${items.reduce((s, m) => s + (Number(m.compute?.gpuCount) || 0), 0)} 卡`;
    const toggle =
      key === "offline" && !narrowed
        ? `<button type="button" class="text-btn tm-group-toggle" data-tm-toggle-offline aria-expanded="${!collapsed}">${collapsed ? "展开" : "收起"}</button>`
        : "";
    let body;
    if (collapsed) body = `<div class="tm-group-body"><div class="tm-chips">${items.map((m) => chipHtml(m, ctx)).join("")}</div></div>`;
    else if (layout === "cards") body = `<div class="tm-cards">${items.map((m) => cardHtml(m, ctx)).join("")}</div>`;
    else body = `<div class="tm-group-body">${items.map((m) => rowHtml(m, ctx)).join("")}</div>`;
    return (
      `<section class="tm-group" data-tm-group="${key}" aria-label="${GROUP_NAMES[key]}">` +
        `<div class="tm-group-head">${orbitGlyph(i)}<b>${GROUP_NAMES[key]}</b><span class="tm-group-n">${items.length}</span><span class="tm-group-rule"></span><span class="tm-group-sum">${sum}</span>${toggle}</div>` +
        body +
      "</section>"
    );
  }).join("");
}

// 行尾「···」菜单：窄窗时快捷按钮收起，这里补上「下发 / 编辑」。
export function buildRowMenuHtml(m, { folded = false, busy = false } = {}) {
  if (!m) return "";
  const btns = actionButtons(m, { busy, withDanger: false });
  const quick = btns.slice(0, 2);
  const rest = btns.slice(2);
  const items = [];
  if (folded) items.push(...quick);
  if (folded && rest.length) items.push('<hr role="separator" />');
  items.push(...rest);
  if (m.inRoster) {
    if (items.length) items.push('<hr role="separator" />');
    items.push(`<button type="button" class="tm-act is-danger" data-tm-remove="${escapeHtml(m.user)}"${busy ? " disabled" : ""}>移出名册</button>`);
  }
  if (!items.length) items.push('<span class="tm-menu-empty">没有更多操作</span>');
  return items.map((h) => h.replace('class="tm-act', 'role="menuitem" class="tm-act')).join("");
}

// 星图上悬停行星时的信息卡。
export function buildPlanetTipHtml(m, { now = Date.now() } = {}) {
  if (!m) return "";
  const status =
    m.onlineState === "tunnel-online"
      ? `<i class="tm-dot is-tunnel" aria-hidden="true"></i>隧道在线${m.activePort ? ` <span class="tm-mono">:${escapeHtml(m.activePort)}</span>` : ""}`
      : m.onlineState === "ssh-only"
        ? '<i class="tm-dot is-ssh" aria-hidden="true"></i>仅 SSH 在线'
        : `<i class="tm-dot is-off" aria-hidden="true"></i>离线 · ${escapeHtml(lastSeenText(m, now))}`;
  const c = m.compute || {};
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  const flags = memberFlags(m);
  return (
    `<div class="tm-tip-head"><span class="tm-planet-dot" style="${hueStyle(m.user)}" aria-hidden="true"></span><b>${escapeHtml(nameOf(m))}</b><span class="tm-mono">${escapeHtml(m.user)}</span></div>` +
    `<div class="tm-tip-status">${status}</div>` +
    '<dl class="tm-tip-grid">' +
      `<dt>今日用量</dt><dd>${escapeHtml(formatTokenCount(m.usage?.todayTokens))} · ${Number(m.usage?.todayCalls || 0)} 次</dd>` +
      `<dt>算力</dt><dd>${c.gpuCount ? `GPU ${Number(c.gpuCount)} 卡` : "无 GPU"}${nodes.length ? ` · ${escapeHtml(nodes.join("、"))}` : ""}</dd>` +
      `<dt>配置</dt><dd>${escapeHtml(cfgLabel(m))}</dd>` +
    "</dl>" +
    (flags.length ? `<div class="tm-tip-flags">${flags.map((f) => flagTag(f)).join("")}</div>` : "") +
    '<div class="tm-tip-foot">点击行星，展开下方成员详情</div>'
  );
}

/* —— 端口智能推荐、自动发现批量纳管、自由多选配置下发、报表导出 —— */

// 7891 是团队生产端口（lib/reverse-port.mjs:6），个人只能从 7892 起「新分配」；
// 已经持有 7891 的人（本仓库的约定里就是管理员本机）沿用自己的端口不受影响。
export const TEAM_PORT_BASE = 7891;
export const TEAM_FRESH_PORT_MIN = TEAM_PORT_BASE + 1;
export const TEAM_PORT_MAX = 8891;

function collectUsedPorts(members, excludeUser = "") {
  const used = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || m.user === excludeUser) continue;
    const candidates = [m.assignedPort, m.activePort, ...(Array.isArray(m.registeredPorts) ? m.registeredPorts : [])];
    for (const p of candidates) {
      const n = Number(p);
      if (Number.isInteger(n) && n > 0) used.add(n);
    }
  }
  return used;
}

// 复用自己已持有的端口时允许到 7891（管理员本机就是它）；凭空「新分配」时从 7892 起。
function ownPortCandidate(target, used, max) {
  const ownCandidates = [target.assignedPort, target.activePort, ...(Array.isArray(target.registeredPorts) ? target.registeredPorts : [])];
  for (const p of ownCandidates) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= TEAM_PORT_BASE && n <= max && !used.has(n)) return n;
  }
  return null;
}

export function recommendNextPort(overview, { forUser = "", min = TEAM_FRESH_PORT_MIN, max = TEAM_PORT_MAX } = {}) {
  const members = Array.isArray(overview?.members) ? overview.members : [];
  const used = collectUsedPorts(members, forUser);
  if (forUser) {
    const target = members.find((m) => m?.user === forUser);
    if (target) {
      const own = ownPortCandidate(target, used, max);
      if (own !== null) return own;
    }
  }
  for (let p = min; p <= max; p += 1) {
    if (!used.has(p)) return p;
  }
  return min;
}

export function buildBatchOnboardPlan(overview, { min = TEAM_FRESH_PORT_MIN, max = TEAM_PORT_MAX } = {}) {
  const members = Array.isArray(overview?.members) ? overview.members : [];
  const unrostered = members.filter((m) => m && typeof m.user === "string" && !m.inRoster);
  if (!unrostered.length) return [];
  const used = collectUsedPorts(members, "");
  let cursor = min;
  const pickNextFree = () => {
    for (let p = Math.max(min, cursor); p <= max; p += 1) {
      if (!used.has(p)) {
        used.add(p);
        cursor = p + 1;
        return p;
      }
    }
    return null;
  };

  return unrostered.map((m) => {
    const otherUsed = collectUsedPorts(members, m.user);
    let assignedPort = ownPortCandidate(m, otherUsed, max);
    if (assignedPort !== null) {
      used.add(assignedPort);
    } else {
      // 端口段用尽时如实返回 null（成员照样纳管，只是没有预分配端口），
      // 由调用方在确认框/toast 里说清楚，而不是假装「已分配专属端口」。
      assignedPort = pickNextFree();
    }
    return {
      user: m.user,
      displayName: m.displayName || (m.isSelf ? "管理员 (本机)" : ""),
      assignedPort,
      note: m.note || "自动发现纳管",
      enabled: true,
    };
  });
}

export function buildAssignPickerHtml(members, selectedUsers = []) {
  const list = Array.isArray(members) ? members : [];
  if (!list.length) return "";
  const sel = new Set(Array.isArray(selectedUsers) ? selectedUsers : []);
  const chips = list
    .map((m) => {
      const u = escapeHtml(m.user);
      const active = sel.has(m.user);
      const label = nameOf(m) !== m.user ? `${escapeHtml(nameOf(m))} (${u})` : u;
      const keyIcon = m.hasPubKey ? "✓" : "⏳";
      return `<button type="button" class="tm-pick-chip${active ? " is-selected" : ""}" data-tm-pick-user="${u}" aria-pressed="${active}" title="${m.hasPubKey ? "公钥已上报，支持立即端到端加密投递" : "尚未上报公钥，将暂存本机队列待上线自动投递"}"><span class="tm-pick-key${m.hasPubKey ? " is-ok" : ""}" aria-hidden="true">${keyIcon}</span><span>${label}</span></button>`;
    })
    .join("");
  return (
    '<div class="tm-pick-bar">' +
      `<span class="tm-pick-stat" role="status" aria-live="polite">已选 <b>${sel.size}</b> / ${list.length} 人</span>` +
      '<div class="tm-pick-quick">' +
        '<button type="button" class="text-btn" data-tm-pick-batch="roster">全选名册</button>' +
        '<button type="button" class="text-btn" data-tm-pick-batch="unmanaged">全选未托管</button>' +
        '<button type="button" class="text-btn" data-tm-pick-batch="all">全选</button>' +
        '<button type="button" class="text-btn" data-tm-pick-batch="none">清空</button>' +
      "</div>" +
    "</div>" +
    `<div class="tm-pick-chips" role="group" aria-label="选择要下发配置的成员：Tab 切换，空格或回车选中 / 取消">${chips}</div>`
  );
}

function csvCell(val) {
  if (val == null) return "";
  let s = String(val).replace(/\r?\n/g, " ").trim();
  // 防公式注入：只处理真正会被 Excel 当公式的前缀。合法负数（-3.5）与 +1 不处理，
  // 否则成本/占比列会被引号变成文本、丢失可计算性。
  if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = `'${s}`;
  if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildTeamReportCsv(overview) {
  const members = Array.isArray(overview?.members) ? overview.members : [];
  const headers = [
    "账号",
    "姓名",
    "名册状态",
    "在线状态",
    "活跃端口",
    "预分配端口",
    "已登记端口",
    "配置状态",
    "配置方案",
    "今日调用次数",
    "今日Token",
    "今日失败次数",
    "今日折算费用(USD)",
    "7天调用次数",
    "7天Token",
    "7天失败次数",
    "7天折算费用(USD)",
    "常用模型",
    "GPU卡数",
    "GPU显存(MiB)",
    "运行作业数",
    "排队作业数",
    "CPU占比(%)",
    "常驻内存(KiB)",
    "所在节点",
    "家目录占用(Bytes)",
    "客户端版本",
    "异常告警",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const m of members) {
    const a = m.assignment || {};
    const st = CFG_STATES[a.state] || CFG_STATES.none;
    const u = m.usage || {};
    const c = m.compute || {};
    const flags = memberFlags(m).map((f) => (f.title ? `${f.text}(${f.title})` : f.text)).join("；");
    const row = [
      m.user || "",
      nameOf(m),
      !m.inRoster ? "自动发现" : m.enabled === false ? "已停用" : "名册内",
      GROUP_NAMES[m.onlineState] || "离线",
      m.activePort ?? "",
      m.assignedPort ?? "",
      Array.isArray(m.registeredPorts) ? m.registeredPorts.join(";") : "",
      st.text,
      cfgLabel(m),
      Number(u.todayCalls || 0),
      Number(u.todayTokens || 0),
      Number(u.todayErrors || 0),
      Number(u.todayCostUsd || 0) || "",
      Number(u.weekCalls || 0),
      Number(u.weekTokens || 0),
      Number(u.weekErrors || 0),
      Number(u.weekCostUsd || 0) || "",
      u.topModel || "",
      Number(c.gpuCount || 0),
      Number(c.gpuMemMiB || 0),
      Number(c.runningJobs || 0),
      Number(c.pendingJobs || 0),
      Number(c.cpuPct || 0) || "",
      Number(c.rssKb || 0) || "",
      Array.isArray(c.nodes) ? c.nodes.join(";") : "",
      m.storage?.homeDirBytes ?? "",
      m.clientVersion || "",
      flags,
    ];
    lines.push(row.map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

/* —— 批量回收闲置端口、成员排障诊断卡、AI 配置下发预设与在用方案提取 —— */

export function collectIdleRegisteredPorts(overview) {
  const members = Array.isArray(overview?.members) ? overview.members : [];
  const items = [];
  for (const m of members) {
    if (!m || typeof m.user !== "string") continue;
    const reg = Array.isArray(m.registeredPorts) ? m.registeredPorts : [];
    for (const port of reg) {
      const p = Number(port);
      if (!Number.isInteger(p) || p <= 0) continue;
      if (m.tunnelOnline && p === Number(m.activePort)) continue;
      items.push({
        user: m.user,
        displayName: nameOf(m),
        port: p,
      });
    }
  }
  return items;
}

export function buildMemberDiagnosticCardText(m, { serverName = "", now = Date.now() } = {}) {
  if (!m) return "";
  const a = m.assignment || { state: "none" };
  const st = CFG_STATES[a.state] || CFG_STATES.none;
  const u = m.usage || {};
  const c = m.compute || {};
  const flags = memberFlags(m);
  const reg = Array.isArray(m.registeredPorts) ? m.registeredPorts : [];
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  const linkLine =
    m.onlineState === "tunnel-online"
      ? `隧道在线${m.activePort ? ` (:${m.activePort})` : ""}`
      : m.onlineState === "ssh-only"
        ? "仅 SSH 在线（未建反向隧道）"
        : `离线（上次活跃：${lastSeenText(m, now)}）`;
  const lines = [
    `### 🩺 团队成员状态诊断卡 · ${nameOf(m)}${m.displayName && m.displayName !== m.user ? ` (${m.user})` : ""}`,
    `- **集群节点**：${serverName || "默认团队集群"}`,
    `- **链路状态**：${linkLine}`,
    `- **端口信息**：预分配 ${m.assignedPort ? `:${m.assignedPort}` : "未设置"} · 已登记 ${reg.length ? reg.map((p) => `:${p}`).join(", ") : "无"}${m.portDrift ? " ⚠️ 端口漂移" : ""}`,
    `- **配置托管**：${st.text}（${cfgLabel(m)}${a.rev ? ` · rev ${a.rev}` : ""}）· 公钥${m.hasPubKey ? "已上报" : "未上报"}`,
    `- **AI 用量**：今日 ${formatTokenCount(u.todayTokens)}（${Number(u.todayCalls || 0)} 次调用${u.todayErrors ? `，${u.todayErrors} 次失败` : ""}）· 7 天 ${formatTokenCount(u.weekTokens)}`,
    `- **算力与存储**：GPU ${Number(c.gpuCount || 0)} 卡${nodes.length ? `（${nodes.join("、")}）` : ""} · 作业 运行 ${Number(c.runningJobs || 0)} / 排队 ${Number(c.pendingJobs || 0)}${m.storage?.homeDirBytes != null ? ` · 家目录 ${formatBytes(m.storage.homeDirBytes, { compact: true })}` : ""}`,
  ];
  if (flags.length) {
    lines.push(`- **需关注项**：${flags.map((f) => (f.title ? `${f.text}（${f.title}）` : f.text)).join("；")}`);
  } else {
    lines.push("- **诊断结论**：各项指标正常");
  }
  return lines.join("\n");
}

export function extractOverviewConfigTemplates(overview) {
  const members = Array.isArray(overview?.members) ? overview.members : [];
  const byKey = new Map();
  for (const m of members) {
    const sum = m?.assignment?.summary;
    if (!sum || typeof sum !== "object") continue;
    const codex = sum.codex && typeof sum.codex === "object" ? sum.codex : null;
    const claude = sum.claude && typeof sum.claude === "object" ? sum.claude : null;
    if (!codex && !claude) continue;
    const key = [
      codex ? `c:${codex.mode || ""}:${codex.providerId || ""}:${codex.baseUrl || ""}:${codex.model || ""}` : "",
      claude ? `a:${claude.mode || ""}:${claude.baseUrl || ""}:${claude.model || ""}` : "",
    ].join("|");
    if (!key || key === "|") continue;
    if (!byKey.has(key)) {
      const labelParts = [];
      if (codex) labelParts.push(`Codex(${codex.providerId || (codex.mode === "official" ? "官方" : "relay")})`);
      if (claude) labelParts.push(`Claude(${claude.mode === "official" ? "官方" : "relay"})`);
      byKey.set(key, {
        id: key,
        label: m.assignment?.groupLabel || labelParts.join(" + ") || "在用方案",
        count: 0,
        codex: codex
          ? {
              enabled: true,
              providerId: codex.providerId || "relay",
              baseUrl: codex.baseUrl || "",
              model: codex.model || "",
            }
          : { enabled: false },
        claude: claude
          ? {
              enabled: true,
              baseUrl: claude.baseUrl || "",
              model: claude.model || "",
            }
          : { enabled: false },
      });
    }
    byKey.get(key).count += 1;
  }
  return [...byKey.values()];
}

export function buildAssignPresetBarHtml({ presets = [], activeTemplates = [] } = {}) {
  const savedList = Array.isArray(presets) ? presets : [];
  const activeList = Array.isArray(activeTemplates) ? activeTemplates : [];
  const chips = [];
  for (let i = 0; i < savedList.length; i += 1) {
    const p = savedList[i];
    if (!p || !p.name) continue;
    const nameHtml = escapeHtml(p.name);
    chips.push(
      `<span class="tm-preset-chip-wrap">` +
        `<button type="button" class="tm-preset-chip" data-tm-apply-preset="${i}" title="一键填入预设「${nameHtml}」的 Provider、Base URL 与模型（不含密钥）">📌 ${nameHtml}</button>` +
        `<button type="button" class="tm-preset-del" data-tm-delete-preset="${i}" aria-label="删除预设 ${nameHtml}" title="删除该预设">×</button>` +
      `</span>`
    );
  }
  for (let i = 0; i < activeList.length; i += 1) {
    const t = activeList[i];
    if (!t) continue;
    const labelHtml = escapeHtml(t.label || "在用方案");
    chips.push(
      `<span class="tm-preset-chip-wrap">` +
        `<button type="button" class="tm-preset-chip" data-tm-apply-active-tpl="${i}" title="复用当前集群 ${Number(t.count || 1)} 人正在使用的配置结构（不含密钥）">⚡ ${labelHtml} (${Number(t.count || 1)}人)</button>` +
      `</span>`
    );
  }
  return (
    '<div class="tm-preset-head">' +
      "<span>快捷方案填充（仅填入地址与模型，API Key 需单独输入）：</span>" +
      '<button type="button" class="text-btn" data-tm-save-preset>+ 将当前表单存为预设</button>' +
    "</div>" +
    `<div class="tm-preset-chips">${
      chips.length ? chips.join("") : '<span class="tm-muted" style="font-size:11.5px">暂无已存预设，填写常用中转站地址后可点击右上角存为预设</span>'
    }</div>`
  );
}


