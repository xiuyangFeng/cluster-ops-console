// daemons-view.js —— 服务器页「远端守护进程」面板正文的 HTML（纯字符串函数，Node 可测）。
// 数据是 GET /api/daemons / POST /api/daemons/start 的返回（后端 lib/daemons/）。
// 每个守护进程一行：状态点 + 名称 + 端口 + 状态文字（版本 / 说明）+ 动作；说明文字放刷新按钮的悬停提示里。
// 只有「未运行」才给「启动」按钮；点了先在行内确认，确认后才发请求（远端写操作）。
// 所有动态文案一律 escapeHtml；按钮只带 data-dm-* 属性，由 app/daemons-controller.js 委托处理。
//
// v2.62 服务直达：两行守护进程下面多一组「我在这台服务器上的服务」（响应里的 services / forwards），一行一个：
// 进程名（命令行悬停可见）+ 端口 + 监听地址 · 已运行时长，第二行是工作目录；右侧「打开」把它临时转发到本机
// 并在浏览器打开，已转发的显示本机地址（可点）与「关闭」。没有服务也没有转发时整组不出现。
// 组名是一个开关：收起时只留组名（带个数，有对所有网卡开放的一并说明）和正在转发 / 正在动作的那几行——
// 开着的转发得一直看得见、关得掉。展开与否由 app/daemons-controller.js 记着。
import { escapeHtml, formatClock } from "../store.js";
import { formatDuration } from "./cluster-model.js";

export const DAEMON_STATE_TEXT = Object.freeze({
  running: "运行中",
  stopped: "未运行",
  missing: "未安装",
  unknown: "状态未知",
});

function subText(d) {
  const parts = [DAEMON_STATE_TEXT[d.state] || DAEMON_STATE_TEXT.unknown];
  if (d.version) parts.push(`v${d.version}`);
  if (d.state === "missing") parts.push("服务器上没找到程序，需先安装");
  return parts.join(" · ");
}

function actionHtml(d, { serverName, busy, confirmId, startingId }) {
  if (startingId === d.id) return '<span class="dm-busy" role="status">正在启动…</span>';
  if (d.state !== "stopped") return "";
  if (confirmId === d.id) {
    return (
      `<span class="dm-confirm-text">在 ${escapeHtml(serverName)} 上启动 ${escapeHtml(d.label)}？</span>` +
      `<button type="button" class="btn btn-primary btn-secondary dm-btn" data-dm-confirm="${escapeHtml(d.id)}"${busy ? " disabled" : ""}>确认启动</button>` +
      `<button type="button" class="text-btn dm-cancel" data-dm-cancel="${escapeHtml(d.id)}"${busy ? " disabled" : ""}>取消</button>`
    );
  }
  return `<button type="button" class="btn btn-secondary dm-btn" data-dm-start="${escapeHtml(d.id)}"${busy ? " disabled" : ""}>启动</button>`;
}

// ---- 我在这台服务器上的服务 ----

// 转发出来的本机地址。只用端口号现拼，不采用响应里的任何字符串。
export function localForwardUrl(localPort) {
  const port = Number(localPort);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}/` : "";
}

const clockHm = (ts) => formatClock(ts, { fallback: "", locale: "zh-CN", hour12: false }).slice(0, 5);

function bindText(binds) {
  const list = Array.isArray(binds) ? binds : [];
  return list.length > 2 ? `${list.slice(0, 2).join("、")} 等 ${list.length} 个地址` : list.join("、");
}

// 已转发：本机地址（新标签页打开；桌面壳里交给系统浏览器）+「复制」+「关闭」。
function forwardedHtml(port, forward, pendingKind) {
  if (pendingKind === "close") return '<span class="dm-busy" role="status">正在关闭…</span>';
  const url = localForwardUrl(forward.localPort);
  const until = clockHm(forward.expiresAt);
  return (
    `<a class="dm-fwd" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="在浏览器打开。${until ? `${until} 自动收回，` : ""}也可以随时关闭">127.0.0.1:${escapeHtml(forward.localPort)}</a>` +
    `<button type="button" class="text-btn dm-copy" data-dm-copy="${escapeHtml(url)}" title="复制本机地址（适合粘贴到 VS Code Jupyter / Cursor 等客户端）">复制</button>` +
    `<button type="button" class="text-btn dm-cancel" data-dm-close="${escapeHtml(port)}">关闭</button>`
  );
}

function serviceActionHtml(svc, { forward, pendingKind, blocked, full }) {
  if (forward) return forwardedHtml(svc.port, forward, pendingKind);
  if (pendingKind === "open") return '<span class="dm-busy" role="status">正在转发…</span>';
  if (blocked) return "";
  if (svc.forwardable === false) {
    return `<span class="dm-busy" title="只绑定在 ${escapeHtml(bindText(svc.binds))}，从集群本机的回环地址连不上，所以转发不了">不能转发</span>`;
  }
  const title = full ? "转发已经开满，先关掉一条" : "临时转发到这台电脑并在浏览器打开；最长 2 小时，可以随时关闭";
  return `<button type="button" class="btn btn-secondary dm-btn" data-dm-open="${escapeHtml(svc.port)}" title="${title}"${full ? " disabled" : ""}>打开</button>`;
}

function serviceRowHtml(svc, ctx) {
  const sub = [bindText(svc.binds)];
  const uptime = formatDuration(svc.uptimeSec);
  if (uptime) sub.push(`已运行 ${uptime}`);
  if (svc.procCount > 1) sub.push(`${svc.procCount} 个进程`);
  const kindTag = svc.kind?.label
    ? `<span class="dm-tag" data-kind="${escapeHtml(svc.kind.id || "")}">${escapeHtml(svc.kind.label)}</span>`
    : "";
  const open = svc.scope === "all"
    ? '<span class="dm-tag" data-level="warn" title="绑定在 0.0.0.0 / ::——同一网络里的其它机器也连得上，不是只有集群本机能访问">对所有网卡开放</span>'
    : "";
  // 单独一个 ~ 太不起眼，而「在家目录里起了个服务」正是值得看见的事：补上说明。
  const cwd = svc.cwd ? `<div class="dm-note-line dm-cwd" title="工作目录">${escapeHtml(svc.cwd === "~" ? "~（家目录）" : svc.cwd)}</div>` : "";
  return (
    `<li class="dm-row dm-svc" data-state="${ctx.forward ? "forwarded" : "running"}">` +
    '<span class="dm-dot" aria-hidden="true"></span>' +
    '<div class="dm-main">' +
    `<div class="dm-title"><span class="dm-name"${svc.cmdline ? ` title="${escapeHtml(svc.cmdline)}"` : ""}>${escapeHtml(svc.name || "进程")}</span>` +
    `<span class="dm-addr">:${escapeHtml(svc.port)}</span><span class="dm-sub">${escapeHtml(sub.filter(Boolean).join(" · "))}</span>${kindTag}${open}</div>${cwd}` +
    "</div>" +
    `<div class="dm-act">${serviceActionHtml(svc, ctx)}</div>` +
    "</li>"
  );
}

// 开着转发、但这一轮的服务列表里没有它（这一轮没取到列表，或排在 24 个之后）：仍给一行，保证能关。
function strayForwardRowHtml(forward, pendingKind) {
  return (
    '<li class="dm-row dm-svc" data-state="forwarded">' +
    '<span class="dm-dot" aria-hidden="true"></span>' +
    '<div class="dm-main">' +
    `<div class="dm-title"><span class="dm-name">转发中</span><span class="dm-addr">:${escapeHtml(forward.port)}</span><span class="dm-sub">这一轮的列表里没有它</span></div>` +
    "</div>" +
    `<div class="dm-act">${forwardedHtml(forward.port, forward, pendingKind)}</div>` +
    "</li>"
  );
}

// pending：Map<端口, "open" | "close">，本窗口正在进行的转发动作；collapsed：收起，只留转发中 / 动作中的行。
export function buildServicesHtml(data, { pending = new Map(), collapsed = false } = {}) {
  const services = Array.isArray(data?.services) ? data.services : [];
  const forwards = Array.isArray(data?.forwards) ? data.forwards : [];
  if (!services.length && !forwards.length) return "";
  const forwardOf = new Map(forwards.map((f) => [Number(f.port), f]));
  const blocked = Boolean(data?.forwardBlocked);
  const full = Number(data?.forwardLimit) > 0 && forwards.length >= Number(data.forwardLimit);
  const listed = new Set(services.map((svc) => Number(svc.port)));
  const kept = (port) => !collapsed || forwardOf.has(Number(port)) || pending.has(Number(port));
  const rows = services.filter((svc) => kept(svc.port)).map((svc) => serviceRowHtml(svc, { forward: forwardOf.get(Number(svc.port)) || null, pendingKind: pending.get(Number(svc.port)) || null, blocked, full }));
  for (const forward of forwards) {
    if (!listed.has(Number(forward.port))) rows.push(strayForwardRowHtml(forward, pending.get(Number(forward.port)) || null));
  }
  const notes = [];
  if (!collapsed) {
    if (data?.forwardBlocked === "password" && services.length) notes.push("这台服务器用密码连接，不能转发到本机；改用密钥登录后可用。");
    if (Number(data?.servicesMore) > 0) notes.push(`另有 ${Number(data.servicesMore)} 个没有列出（按端口从小到大，最多列 ${services.length} 个）。`);
  }
  const total = services.length + Math.max(0, Number(data?.servicesMore) || 0);
  const exposed = services.filter((svc) => svc.scope === "all").length;
  const count = total
    ? `<span class="dm-count">${total} 个</span>${exposed ? `<span class="dm-tag" data-level="warn">${exposed} 个对所有网卡开放</span>` : ""}`
    : "";
  return (
    `<h3 class="dm-group"><button type="button" class="text-btn dm-group-toggle" data-dm-toggle aria-expanded="${collapsed ? "false" : "true"}">我在这台服务器上的服务</button>${count}</h3>` +
    (rows.length ? `<ul class="dm-list">${rows.join("")}</ul>` : "") +
    notes.map((text) => `<p class="dm-note">${escapeHtml(text)}</p>`).join("")
  );
}

// data：接口返回（可能为 null）；busyId：本窗口正在启动的 id；confirmId：处于行内确认的 id；
// loading：正在读状态；error：读状态失败的文案（有旧数据时仍显示旧数据）；pending：正在进行的转发动作。
export function buildDaemonsHtml(data, { busyId = null, confirmId = null, loading = false, error = "", pending = new Map(), servicesCollapsed = false } = {}) {
  const daemons = Array.isArray(data?.daemons) ? data.daemons : [];
  if (!daemons.length) {
    if (error) return `<p class="dm-note" data-level="warn">${escapeHtml(error)}</p>`;
    return `<p class="dm-note">${loading ? "正在检查远端守护进程…" : "还没有检查过。"}</p>`;
  }
  const startingId = busyId || data?.starting || null;
  const busy = Boolean(startingId);
  const serverName = data?.serverName || data?.serverId || "这台服务器";
  const rows = daemons.map((d) => {
    const note = d.note ? `<div class="dm-note-line">${escapeHtml(d.note)}</div>` : "";
    return (
      `<li class="dm-row" data-state="${escapeHtml(DAEMON_STATE_TEXT[d.state] ? d.state : "unknown")}">` +
      '<span class="dm-dot" aria-hidden="true"></span>' +
      '<div class="dm-main">' +
      `<div class="dm-title"><span class="dm-name">${escapeHtml(d.label)}</span><span class="dm-addr">:${escapeHtml(d.port)}</span><span class="dm-sub">${escapeHtml(subText(d))}</span></div>${note}` +
      "</div>" +
      `<div class="dm-act">${actionHtml(d, { serverName, busy, confirmId, startingId })}</div>` +
      "</li>"
    );
  }).join("");
  const warn = data?.reachable === false
    ? `<p class="dm-note" data-level="warn">这一轮取不到状态：${escapeHtml(data.error || "SSH 未返回结果")}</p>`
    : (error ? `<p class="dm-note" data-level="warn">${escapeHtml(error)}（下面是上一次的结果）</p>` : "");
  return `${warn}<ul class="dm-list">${rows}</ul>${buildServicesHtml(data, { pending, collapsed: servicesCollapsed })}`;
}
