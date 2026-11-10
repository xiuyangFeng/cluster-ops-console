// storage-admin-view.js —— 服务器页「存储管理（管理员）」面板的 HTML（纯字符串函数，Node 可测）。
// 数据：GET /api/storage-admin（概览）、/api/storage-admin/view（扫描结果的某一层）、/api/storage-admin/list（即时列目录）。
// 所有动态文案一律 escapeHtml；按钮只带 data-sa-* 属性，由 app/storage-admin-controller.js 委托处理。
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";
import { DEFAULT_IDLE_MONTHS, diskCardHtml, foldList, idleToolbarHtml, rankedRowsHtml, splitBarHtml, treemapHtml, userKpisHtml, usedRatio, userRowsHtml } from "./storage-admin-viz.js";
import { clockOf, dayKeyOf } from "./usage-model.js";

export { usedRatio };

const size = (n) => (Number.isFinite(n) ? formatBytes(n, { compact: true }) : "—");
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("zh-CN") : "—");
const pct = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(r >= 0.1 ? 0 : 1)}%` : "—");
const attr = escapeHtml;

// 集群上的时刻按北京时间显示（与在集群上 ls -l 看到的一致）。
export function clockText(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const day = dayKeyOf(sec);
  return `${Number(day.slice(5, 7))}-${day.slice(8)} ${clockOf(sec)}`;
}

function when(sec, now) {
  if (!Number.isFinite(sec)) return "";
  return `${clockText(sec)}（${formatRelativeTime(sec * 1000, now) || "刚刚"}）`;
}

const level = (ratio) => (ratio >= 0.9 ? "crit" : ratio >= 0.8 ? "warn" : "ok");

// tone：容量条按占比分级着色；占比条（某人 / 某目录占多少）用中性色——占得多不等于出了问题。
function bar(ratio, { share = false } = {}) {
  const w = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  return `<span class="sa-bar" data-level="${share ? "share" : level(ratio)}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}

// 文件数上千万的盘整盘扫描要很久，才值得提示开配额统计。
const QUOTA_HINT_MIN_INODES = 10_000_000;

const STATUS_TEXT = { ok: "已连接", unknown: "未检测", error: "连接失败", outdated: "需要升级" };

function copyBlock(cmd, label = "复制") {
  return `<div class="sa-cmd"><code>${escapeHtml(cmd)}</code><button type="button" class="text-btn" data-sa-copy="${attr(cmd)}">${escapeHtml(label)}</button></div>`;
}

// ① 本机专用密钥 ② 每台机器的安装命令。全部就绪后折叠成一行。
export function buildSetupHtml(data, { installers = {}, busy = {} } = {}) {
  const key = data?.key || {};
  const targets = data?.targets || [];
  const ready = key.exists && targets.length && targets.every((t) => t.status?.state === "ok");
  const keyStep = key.exists
    ? `<li data-done="true"><b>本机专用密钥</b><span class="sa-dim">${escapeHtml(key.identityFile || "")}</span></li>`
    : `<li><b>本机专用密钥</b>：还没有。点击生成一把只用于这里的 ed25519 密钥（无口令，只存在这台电脑上）。` +
      `<button type="button" class="text-btn sa-primary" data-sa-key${busy.key ? " disabled" : ""}>${busy.key ? "正在生成…" : "生成密钥"}</button></li>`;
  const hostSteps = targets.map((t) => {
    const ok = t.status?.state === "ok";
    const inst = installers[t.id];
    const body = inst
      ? `<p class="sa-note">${inst.shell === "cmd" ? "在本机「命令提示符」（cmd，<b>不是 PowerShell</b>）里" : "在本机「终端」里"}运行下面这一行，输入 <b>root 密码</b>。第一次连接会显示主机指纹，核对后输入 <code>yes</code>。完成后点「检测」。</p>${copyBlock(inst.command)}` +
        `<p class="sa-note">这把密钥在服务器上被限定为只能运行只读扫描脚本（restrict + command=），开不了 shell。以后要撤销，在终端运行：</p>${copyBlock(inst.uninstallCommand, "复制卸载命令")}`
      : "";
    return `<li${ok ? ' data-done="true"' : ""}><b>${escapeHtml(t.label)}</b>（${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)}）：${escapeHtml(ok ? "已就绪" : t.status?.message || "未安装或未检测")}` +
      (t.connectionId ? `<p class="sa-note">使用所选连接的独立认证${t.sshJumpServerId ? "，经主集群跳转" : "，公网直连"}。需要服务器已安装只读存储服务，账号也需具备读取权限；不会自动提权。</p>` : "") +
      `<span class="sa-actions">${key.exists ? `<button type="button" class="text-btn" data-sa-installer="${attr(t.id)}"${busy[`inst:${t.id}`] ? " disabled" : ""}>${ok ? "重新生成安装命令" : "生成安装命令"}</button>` : ""}` +
      `<button type="button" class="text-btn" data-sa-refresh="${attr(t.id)}"${t.refreshing || busy[`ref:${t.id}`] ? " disabled" : ""}>${t.refreshing || busy[`ref:${t.id}`] ? "检测中…" : "检测"}</button></span>${body}</li>`;
  }).join("");
  const open = ready ? "" : " open";
  return `<details class="sa-setup"${open}><summary>接入步骤${ready ? "（已全部就绪）" : ""}</summary><ol>${keyStep}${hostSteps}</ol></details>`;
}

// 磁盘容量卡片（render/storage-admin-viz.js）。
const mountRow = diskCardHtml;

// 与服务器端 usage-start 的默认限速一致（MB/s）：预计时长按「整张 inode 表」上限估，实际只读在用的那部分，通常更快。
const INODE_READ_MBPS = 150;

export function usageEta(u) {
  const fs = u.inodeScan?.fs;
  if (!fs?.inodes || !fs.inodeSize) return "几分钟";
  const sec = (fs.inodes * fs.inodeSize) / (INODE_READ_MBPS * 1024 * 1024);
  return sec < 90 ? "一两分钟" : `最多约 ${Math.ceil(sec / 60)} 分钟`;
}

function inodeReason(u) {
  const s = u.inodeScan;
  if (!s) return "";
  if (s.ok) return "";
  const why = { "not-ext": "不是 ext 文件系统", "unsupported-feature": `用了暂不支持的特性${s.detail ? `（${s.detail}）` : ""}`, "no-device": "找不到块设备" }[s.code] || "检查未通过";
  return `（不能按 inode 表快速统计：${why}）`;
}

function usageButton(u, target) {
  if (!u.inodeScan?.ok || u.quota) return "";
  const busy = Boolean(target.running);
  return `<button type="button" class="text-btn" data-sa-usage="${attr(target.id)}" data-mount="${attr(u.mount)}"${busy ? " disabled" : ""}` +
    ` title="服务器上只读、顺序、限速地读 inode 表，按属主合计；不遍历目录、不改任何配置">${u.source === "inode" ? "重新统计" : "按用户统计"}</button>`;
}

// 一台机器多块盘时，次要的盘收成一行摘要（最多的人 + 有占用的用户数），点「展开」看全部。
function usersCollapsedHtml(u, target) {
  const top = [...(u.rows || [])].sort((a, b) => b.bytes - a.bytes)[0];
  const sum = top ? `最多 ${top.name || `uid ${top.uid}`} ${size(top.bytes)} · ${num(u.rows.length)} 位用户` : "还没有按用户的数据";
  return `<div class="sa-users sa-users-collapsed"><div class="sa-users-head"><h4>${escapeHtml(u.mount)} · 按用户</h4>` +
    `<span class="sa-dim">${escapeHtml(sum)}</span>` +
    `<button type="button" class="sa-fold" data-sa-fold="${attr(`ublock:${target.id}:${u.mount}`)}" aria-expanded="false">展开</button></div></div>`;
}

function usersHtml(u, target, now, activity, fold, collapsible = false) {
  const source = u.source === "quota"
    ? `来源：repquota（按文件属主统计全盘，${escapeHtml(when(u.at, now))}）`
    : u.source === "inode"
      ? `来源：读 inode 表按属主统计全盘（${escapeHtml(when(u.at, now))}）`
      : u.source === "scan"
        ? `来源：整盘扫描的属主合计（${escapeHtml(when(u.at, now))}）`
        : "";
  const collapse = collapsible
    ? `<button type="button" class="sa-fold" data-sa-fold="${attr(`ublock:${target.id}:${u.mount}`)}" aria-expanded="true">收起</button>`
    : "";
  const action = usageButton(u, target) + collapse;
  if (!u.rows.length) {
    const big = u.iused >= QUOTA_HINT_MIN_INODES;
    const inodeOk = Boolean(u.inodeScan?.ok);
    const hint = u.quota
      ? "已开配额统计，点「刷新」读取 repquota。"
      : inodeOk
        ? `还没有按用户的数据。点「按用户统计」：服务器上只读、顺序地读这块盘的 inode 表，${big ? `${num(u.iused)} 个文件也只要` : "通常"}${escapeHtml(usageEta(u))}，不遍历目录、不用开配额。`
        : big
          ? `还没有按用户的数据。这块盘有 ${num(u.iused)} 个文件，整盘扫描要很久；可以开启配额统计（见下方说明），也可以对 ${u.mount} 整盘扫描一次。${inodeReason(u)}`
          : `还没有按用户的数据：对 ${u.mount} 整盘扫描一次即可（${num(u.iused)} 个文件，通常几分钟内）。`;
    const guide = u.quota || !big || inodeOk ? "" : quotaGuideHtml(u.mount, target);
    return `<div class="sa-users"><div class="sa-users-head"><h4>${escapeHtml(u.mount)} · 按用户</h4>${action}</div><p class="sa-note">${escapeHtml(hint)}</p>${guide}</div>`;
  }
  const mount = (target.info?.mounts || []).find((m) => m.mount === u.mount);
  // 读 inode 表的统计把目录也算作一个 inode，表头写清楚。
  const filesLabel = u.source === "inode" ? "文件和目录数" : "文件数";
  return `<div class="sa-users"><div class="sa-users-head"><h4>${escapeHtml(u.mount)} · 按用户</h4>${action}</div><p class="sa-note">${source}；占已用 = 占这块盘已用空间。</p>` +
    `${userKpisHtml(u)}${splitBarHtml({ ...u, avail: mount?.avail })}${idleToolbarHtml(u, { now, activity })}${userRowsHtml(u, { filesLabel, activity, now, fold, foldKey: `users:${target.id}:${u.mount}` })}` +
    `${u.source === "scan" && !u.quota && !u.inodeScan?.ok && u.iused >= QUOTA_HINT_MIN_INODES ? quotaGuideHtml(u.mount, target) : ""}</div>`;
}

// /public 这类上亿文件的盘：开启配额统计后，每人用量由内核实时维护，repquota 一秒出结果，不用再扫。
export function quotaGuideHtml(mount, target) {
  const cmds = [
    "apt-get install -y quota",
    `mount -o remount,usrquota ${mount}`,
    `nice -n 19 ionice -c3 quotacheck -cum ${mount}   # 首次统计要遍历整盘，可能需要数小时；建议在 tmux/screen 里或夜间运行`,
    `quotaon -u ${mount}`,
    `repquota -u ${mount} | head   # 验证`,
  ];
  return `<details class="sa-guide"><summary>在 ${escapeHtml(mount)} 开启用户配额统计（只统计、不设上限，root 在 ${escapeHtml(target.label)} 上执行）</summary>` +
    `<p class="sa-note">不给任何人设上限，所以不会限制写入；只是让内核按文件属主实时记账。最后要把 <code>usrquota</code> 加进 /etc/fstab 里 ${escapeHtml(mount)} 那一行的挂载选项，重启后才会继续生效。改挂载选项前请确认业务允许。</p>` +
    cmds.map((c) => copyBlock(c)).join("") + "</details>";
}

function jobHtml(job, now, target) {
  if (!job) return "";
  const elapsed = Number.isFinite(job.startedAt) ? Math.max(0, now / 1000 - job.startedAt) : null;
  const ratio = job.estTotal > 0 ? Math.min(1, job.entries / job.estTotal) : null;
  const eta = ratio && ratio > 0.01 && elapsed ? (elapsed / ratio) - elapsed : null;
  const mins = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} 小时` : `${Math.max(1, Math.round(s / 60))} 分钟`);
  const title = job.kind === "inode" ? `正在按用户统计 ${job.root}（读 inode 表）` : `正在扫描 ${job.root}`;
  const how = job.kind === "inode"
    ? "在服务器上后台运行：只读、顺序、限速读块设备（不进页缓存），关掉工作台也会继续；每 5 秒更新一次。"
    : "扫描在服务器上后台运行（最低优先级），关掉工作台也会继续；每 5 秒更新一次。";
  return `<div class="sa-job"><div class="sa-job-head"><b>${escapeHtml(title)}</b>` +
    `<button type="button" class="text-btn" data-sa-stop="${attr(target.id)}" data-job="${attr(job.id)}">停止</button></div>` +
    (ratio != null ? bar(ratio) : "") +
    `<p class="sa-note">已${job.kind === "inode" ? "统计" : "扫"} ${num(job.entries)} 个${job.kind === "inode" ? "文件" : "条目"}${ratio != null ? `（约 ${pct(ratio)}）` : ""}、${size(job.bytes)}；已进行 ${elapsed != null ? mins(elapsed) : "—"}${eta ? `，预计还要 ${mins(eta)}` : ""}。` +
    `${escapeHtml(how)}</p>` +
    (job.current ? `<p class="sa-note sa-mono">${escapeHtml(job.current)}</p>` : "") + "</div>";
}

function rootsHtml(t, running, fold) {
  const roots = t.info?.roots || [];
  const mounts = new Set((t.info?.mounts || []).map((m) => m.mount));
  return roots.map((r) => {
    const rootBtns = `<button type="button" class="text-btn" data-sa-list="${attr(t.id)}" data-path="${attr(r.path)}">查看目录</button>` +
      `<button type="button" class="text-btn" data-sa-scan="${attr(t.id)}" data-root="${attr(r.path)}"${running ? " disabled" : ""}>扫描${mounts.has(r.path) ? "整盘" : ""}</button>`;
    const folded = foldList(r.children || [], `kids:${t.id}:${r.path}`, fold, 6);
    const kids = folded.shown.map((c) => {
      const full = `${r.path}/${c.name}`;
      return `<li><span class="sa-name">${escapeHtml(c.name)}</span>${c.mount ? '<span class="sa-chip" data-on="true">独立磁盘</span>' : ""}` +
        `<span class="sa-dim">${escapeHtml(c.owner || (c.uid != null ? `uid ${c.uid}` : ""))}</span>` +
        `<span class="sa-actions"><button type="button" class="text-btn" data-sa-list="${attr(t.id)}" data-path="${attr(full)}">查看目录</button>` +
        `<button type="button" class="text-btn" data-sa-scan="${attr(t.id)}" data-root="${attr(full)}"${running ? " disabled" : ""}>扫描</button></span></li>`;
    }).join("");
    return `<div class="sa-root"><div class="sa-root-head"><b>${escapeHtml(r.path)}</b><span class="sa-actions">${rootBtns}</span></div>` +
      (kids ? `<ul class="sa-kids">${kids}</ul>${folded.toggle}` : '<p class="sa-note">（没有子目录或读不到）</p>') + "</div>";
  }).join("");
}

function scansHtml(t, now, fold) {
  if (!t.scans?.length) return "";
  const folded = foldList(t.scans, `scans:${t.id}`, fold, 3);
  return `<div class="sa-scans"><h4>扫描结果（保存在本机，点开逐层浏览）</h4><ul>${folded.shown.map((j) => (
    `<li>${j.kind === "inode"
      ? `<span class="sa-name">${escapeHtml(j.root)} · 按用户统计</span>`
      : `<button type="button" class="text-btn" data-sa-view="${attr(t.id)}" data-job="${attr(j.id)}">${escapeHtml(j.root)}</button>`}` +
    `<span class="sa-num">${escapeHtml(size(j.bytes))}</span><span class="sa-dim">${escapeHtml(num(j.entries))} 个条目 · ${escapeHtml(when(j.endedAt, now))}${j.partial ? " · 中途停止（部分结果）" : ""}</span></li>`
  )).join("")}</ul>${folded.toggle}</div>`;
}

export function buildTargetHtml(t, { now = Date.now(), activity = { months: DEFAULT_IDLE_MONTHS, only: false }, fold = null } = {}) {
  const state = t.status?.state || "unknown";
  const head = `<div class="sa-target-head"><h3>${escapeHtml(t.label)}</h3><span class="sa-dim">${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)} · 允许：${escapeHtml(t.roots.join(" "))}</span>` +
    `<span class="sa-status" data-state="${attr(state)}">${escapeHtml(STATUS_TEXT[state] || state)}</span>` +
    `${t.checkedAt ? `<span class="sa-dim">检测于 ${escapeHtml(formatRelativeTime(t.checkedAt, now) || "刚刚")}</span>` : ""}` +
    `<button type="button" class="text-btn" data-sa-refresh="${attr(t.id)}"${t.refreshing ? " disabled" : ""}>${t.refreshing ? "刷新中…" : "刷新"}</button></div>`;
  const msg = state !== "ok" && t.status?.message ? `<p class="sa-note" data-level="warn">${escapeHtml(t.status.message)}</p>` : "";
  if (!t.info) return `<section class="sa-target">${head}${msg}<p class="sa-note">还没有数据：完成上面的接入步骤后点「刷新」。</p></section>`;
  const mounts = t.info.mounts.length ? `<div class="sa-disks">${t.info.mounts.map(mountRow).join("")}</div>` : '<p class="sa-note">没有找到相关的磁盘。</p>';
  // 多块盘：默认只展开已用最多的那块的「按用户」，其余收成一行（展开状态记在 fold 里）。
  const list = t.users || [];
  const primary = list.length > 1 ? [...list].sort((a, b) => (b.used || 0) - (a.used || 0))[0].mount : null;
  const users = list.map((u) => (
    !primary || u.mount === primary || fold?.open?.has(`ublock:${t.id}:${u.mount}`)
      ? usersHtml(u, t, now, activity, fold, Boolean(primary) && u.mount !== primary)
      : usersCollapsedHtml(u, t)
  )).join("");
  return `<section class="sa-target">${head}${msg}${mounts}${jobHtml(t.running, now, t)}${users}${rootsHtml(t, Boolean(t.running), fold)}${scansHtml(t, now, fold)}</section>`;
}

// 机器标签：多台机器时一次只展开一台（selected），标签上带最满那块盘的占用与「扫描中」。
function targetTabsHtml(targets, selected) {
  return `<div class="sa-tabs" role="group" aria-label="存储节点和账号（可多选）">${targets.map((t) => {
    const worst = (t.info?.mounts || []).reduce((m, d) => Math.max(m, usedRatio(d)), 0);
    const lv = worst >= 0.9 ? "crit" : worst >= 0.8 ? "warn" : "ok";
    const badge = t.info?.mounts?.length ? `<span class="sa-tab-pct" data-level="${lv}">${Math.round(worst * 100)}%</span>` : "";
    const busyDot = t.running ? '<span class="sa-tab-busy" title="有任务在跑"></span>' : "";
    const bad = t.status?.state && t.status.state !== "ok" ? '<span class="sa-tab-warn" title="连接或版本有问题">!</span>' : "";
    return `<label class="sa-tab"><input type="checkbox" data-sa-target-tab="${attr(t.id)}"${selected.includes(t.id) ? " checked" : ""}>` +
      `<b>${escapeHtml(t.label)} · ${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)}</b>${badge}${busyDot}${bad}</label>`;
  }).join("")}</div>`;
}

export function buildStorageTargetForm(data, busy = {}) {
  if (!data?.setup) return "";
  const draft = data.setup;
  const field = (name, label, value, extra = "") => `<label>${label}<input name="${name}" value="${attr(String(value ?? ""))}" ${extra} /></label>`;
  return `<details class="sa-setup"${data.targets?.length ? "" : " open"}><summary>配置存储服务器</summary>` +
    '<p class="sa-note">已预填当前连接。选择允许查看的目录并保存，然后按接入步骤配置只读扫描。也可填写另一台服务器。</p>' +
    '<div class="sa-target-form" data-sa-target-form>' +
    field("id", "服务器标识", draft.id, 'maxlength="64"') + field("label", "显示名称", draft.label, 'maxlength="64"') +
    `<label>节点与登录账号<select name="connectionId" data-sa-connection><option value="">专用 root 受限密钥（手填地址）</option>${(data.connections || []).map((s) => `<option value="${attr(s.id)}"${draft.connectionId === s.id ? " selected" : ""}>${escapeHtml(s.name)} · ${escapeHtml(s.sshUser || "默认账号")}@${escapeHtml(s.host)}（${s.sshJumpServerId ? "内网跳转" : "直连"}）</option>`).join("")}</select></label>` +
    field("host", "服务器地址或 SSH 别名", draft.host, 'autocomplete="off"') + field("port", "SSH 端口", draft.port || 22, 'type="number" min="1" max="65535"') +
    `<label class="sa-target-roots">允许查看的目录<input name="roots" value="${attr(draft.roots || "")}" placeholder="例如 /home /public /mnt（空格分隔）" /></label>` +
    `<button type="button" class="btn btn-secondary" data-sa-save-target${busy.target ? " disabled" : ""}>${busy.target ? "正在保存…" : "保存存储服务器"}</button></div></details>`;
}

export function buildUnconfiguredConnectionsHtml(data) {
  if (!data?.setup) return "";
  const missing = (data.connections || []).filter((connection) => !(data.targets || []).some((target) =>
    target.connectionId === connection.id || (!target.connectionId && target.host === connection.host
      && target.port === connection.port && connection.sshUser === "root")));
  if (!missing.length) return "";
  return '<section class="sa-setup"><h3>尚未配置存储扫描的连接</h3>' +
    '<p class="sa-note">已保存的 SSH 连接需要单独选择扫描目录，再安装并检测只读存储服务。</p>' +
    missing.map((connection) => `<p><b>${escapeHtml(connection.name)}</b> · ${escapeHtml(connection.sshUser || "默认账号")}@${escapeHtml(connection.host)} ` +
      `<button type="button" class="text-btn" data-sa-configure="${attr(connection.id)}">配置扫描目录</button></p>`).join("") + '</section>';
}

export function buildOverviewHtml(data, { installers = {}, busy = {}, error = "", loading = false, now = Date.now(), activity, fold = null, selected = null } = {}) {
  if (loading && !data) return '<p class="sa-note">正在读取…</p>';
  if (!data) return error ? `<p class="sa-note" data-level="warn">${escapeHtml(error)}</p>` : "";
  if (!data.targets?.length) {
    return buildStorageTargetForm(data, busy) + buildUnconfiguredConnectionsHtml(data) || '<p class="sa-note">个人配置 config.local.json 里还没有 storageAdmin.targets（要查看的机器与允许扫描的目录）。</p>';
  }
  const err = error ? `<p class="sa-note" data-level="warn">${escapeHtml(error)}</p>` : "";
  const opts = { now, fold, ...(activity ? { activity } : {}) };
  const setup = buildStorageTargetForm(data, busy);
  const picks = Array.isArray(selected) ? selected : selected ? [selected] : data.targets.map((t) => t.id);
  return `${err}${setup}${buildUnconfiguredConnectionsHtml(data)}${buildSetupHtml(data, { installers, busy })}${targetTabsHtml(data.targets, picks)}${data.targets.filter((t) => picks.includes(t.id)).map((t) => buildTargetHtml(t, opts)).join("") || '<p class="sa-note">勾选上方节点与账号以查看存储。</p>'}`;
}

// 扫描结果的某一层。
export function buildBrowserHtml(view, { now = Date.now(), fold = null } = {}) {
  if (!view) return "";
  const crumbs = view.crumbs.map((c, i) => (i === view.crumbs.length - 1
    ? `<b>${escapeHtml(c.name)}</b>`
    : `<button type="button" class="text-btn" data-sa-rel="${attr(c.rel)}">${escapeHtml(c.name)}</button>`)).join('<span class="sa-dim">/</span>');
  const n = view.node;
  const job = view.job;
  const headNote = `${escapeHtml(size(n.blocks))} · ${escapeHtml(num(n.files))} 个文件 · ${escapeHtml(num(n.dirs))} 个子目录` +
    `${n.owner ? ` · 属主 ${escapeHtml(n.owner)}` : ""} · 扫描于 ${escapeHtml(when(job.endedAt, now))}${job.partial ? " · <b>中途停止，只含已扫部分</b>" : ""}`;
  const maxFile = view.top[0]?.blocks || 0;
  const topFold = foldList(view.top, `files:${view.path}`, fold);
  const top = view.top.length
    ? `<div class="sa-files"><h4>这一层下最大的文件</h4><table class="sa-table sa-ranked"><tbody>${topFold.shown.map((f) => (
      `<tr><td class="sa-name sa-mono" title="${attr(f.rel)}">${escapeHtml(f.name)}</td><td class="sa-dim sa-owner">${escapeHtml(f.owner || "")}</td>` +
      `<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:${(maxFile ? (f.blocks / maxFile) * 100 : 0).toFixed(1)}%"></span></span></td>` +
      `<td class="sa-num sa-strong-num">${escapeHtml(size(f.blocks))}</td><td class="sa-num sa-dim sa-mtime">${escapeHtml(clockText(f.mtime))}</td></tr>`
    )).join("")}</tbody></table>${topFold.toggle}</div>`
    : "";
  const owners = view.owners?.length
    ? `<div class="sa-files"><h4>按属主（这次扫描范围内）</h4>${userRowsHtml({ rows: view.owners }, { shareLabel: "占扫描范围", fold, foldKey: `owners:${view.path}` })}</div>`
    : "";
  const map = treemapHtml(view);
  return `<div class="sa-browser-head"><span class="sa-crumbs">${crumbs}</span><span class="sa-actions">` +
    `<button type="button" class="text-btn" data-sa-list-here="${attr(view.path)}">即时列出全部条目</button>` +
    `<button type="button" class="text-btn" data-sa-close>关闭</button></span></div>` +
    `<p class="sa-note">${headNote}</p>` +
    (map ? `${map}<p class="sa-note sa-tm-hint">矩形面积 = 占用（颜色浓淡按占比分四档，只作辅助）；右上角带 › 的块可以点进去，悬停看详情。</p>` : "") +
    `${rankedRowsHtml(view, { clockText, fold })}<div class="sa-files-grid">${top}${owners}</div>` +
    `<p class="sa-note">占用 = 磁盘块（st_blocks × 512）；不跟随符号链接、不跨文件系统，硬链接只计一次。为控制体积，只保留第一层的全部目录和更深处 ≥ ${escapeHtml(size(view.threshold))} 的最大 3 万个目录。</p>`;
}

const KIND = { d: "目录", f: "文件", l: "链接", o: "其他" };

// 即时列目录（发 SSH）：全部条目；目录的大小只有在扫描结果里才有。
export function buildListHtml(list, { fold = null } = {}) {
  if (!list) return "";
  const parent = list.path.includes("/") && list.path.lastIndexOf("/") > 0 ? list.path.slice(0, list.path.lastIndexOf("/")) : null;
  const folded = foldList(list.entries, `list:${list.path}`, fold, 10);
  const rows = folded.shown.map((e) => {
    const name = e.kind === "d"
      ? `<button type="button" class="text-btn sa-dir" data-sa-list-here="${attr(`${list.path}/${e.name}`)}">${escapeHtml(e.name)}/</button>`
      : `<span>${escapeHtml(e.name)}${e.kind === "d" ? "/" : e.kind === "l" ? " →" : ""}</span>`;
    const sz = e.kind === "d" ? (e.treeBlocks != null ? size(e.treeBlocks) : "未扫描") : size(e.blocks);
    return `<tr><td class="sa-name">${name}${e.mount ? '<span class="sa-chip" data-on="true">独立磁盘</span>' : ""}</td><td class="sa-dim">${KIND[e.kind] || ""}</td>` +
      `<td class="sa-dim">${escapeHtml(e.owner || (e.uid != null ? `uid ${e.uid}` : ""))}</td><td class="sa-num">${escapeHtml(sz)}</td><td class="sa-num sa-dim">${escapeHtml(clockText(e.mtime))}</td></tr>`;
  }).join("");
  return `<div class="sa-browser-head"><span class="sa-crumbs"><b>${escapeHtml(list.path)}</b></span><span class="sa-actions">` +
    `${parent ? `<button type="button" class="text-btn" data-sa-list-here="${attr(parent)}">上一级</button>` : ""}` +
    `<button type="button" class="text-btn" data-sa-close>关闭</button></span></div>` +
    `<p class="sa-note">即时列出（${num(list.entries.length)} 项${list.truncated ? "，条目过多只列出前一部分" : ""}）。目录大小来自扫描结果；没扫描过的目录显示「未扫描」。</p>` +
    (rows ? `<table class="sa-table"><thead><tr><th>名称</th><th>类型</th><th>属主</th><th class="sa-num">大小</th><th class="sa-num">修改</th></tr></thead><tbody>${rows}</tbody></table>${folded.toggle}` : '<p class="sa-note">空目录。</p>');
}
