// storage-admin-view.js —— 「存储管理（管理员）」页的 HTML（纯字符串函数，Node 可测）。
// 数据：GET /api/storage-admin（概览）、/api/storage-admin/view（扫描结果的某一层）、/api/storage-admin/list（即时列目录）。
// 版式（v2.100）：图在前、字在后——
//   ① 接入还没完成时，一张「下一步」卡；接入与配置（目录范围、未接入的连接、接入步骤）全部收进一行可展开的「接入与配置」。
//   ② 总览：节点选择 · 已用容量大数字 · 所有磁盘的容量条列表（点一行跳到那块盘）。
//   ③ 每台机器：每块盘一张分析卡（统计卡 + 容量构成分段条 + 数据冷热 + 用户名单），下面并排「可扫描目录」与「扫描记录」。
//   说明性的长句一律放进悬停说明（title），页面上只留数字、图和必要的操作。
// 所有动态文案一律 escapeHtml；按钮只带 data-sa-* 属性，由 app/storage-admin-controller.js 委托处理。
import { escapeHtml, formatBytePair, formatBytes, formatRelativeTime } from "../store.js";
import {
  capacityRowsHtml, coldChartHtml, DEFAULT_IDLE_MONTHS, fleetSummary, foldList, idleToolbarHtml, kpiHtml, meterHtml, rankedRowsHtml,
  splitBarHtml, splitSegments, toneLegendHtml, treemapHtml, usedRatio, userKpisHtml, userRowsHtml,
} from "./storage-admin-viz.js";
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

const ago = (sec, now) => (Number.isFinite(sec) ? formatRelativeTime(sec * 1000, now) || "刚刚" : "");

const level = (ratio) => (ratio >= 0.9 ? "crit" : ratio >= 0.8 ? "warn" : "ok");

// 文件数上千万的盘整盘扫描要很久，才值得提示开配额统计。
const QUOTA_HINT_MIN_INODES = 10_000_000;

const STATUS_TEXT = { ok: "已连接", unknown: "未检测", error: "连接失败", outdated: "需要升级" };

const info = (text) => `<span class="sa-info" title="${attr(text)}" aria-label="${attr(text)}">i</span>`;

function copyBlock(cmd, label = "复制") {
  return `<div class="sa-cmd"><code>${escapeHtml(cmd)}</code><button type="button" class="text-btn" data-sa-copy="${attr(cmd)}">${escapeHtml(label)}</button></div>`;
}

const stepsReady = (data) => {
  const targets = data?.targets || [];
  return Boolean(data?.key?.exists && targets.length && targets.every((t) => t.status?.state === "ok"));
};

// ① 本机专用密钥 ② 每台机器的安装命令。放在「接入与配置」里；全部就绪时只是一张核对清单。
export function buildSetupHtml(data, { installers = {}, busy = {} } = {}) {
  const key = data?.key || {};
  const targets = data?.targets || [];
  const ready = stepsReady(data);
  const keyStep = key.exists
    ? `<li data-done="true"><b>本机专用密钥</b><span class="sa-dim sa-mono">${escapeHtml(key.identityFile || "")}</span></li>`
    : `<li><b>本机专用密钥</b><span class="sa-dim">还没有：生成一把只用于这里的 ed25519 密钥（无口令，只存在这台电脑上）。</span>` +
      `<button type="button" class="text-btn sa-primary" data-sa-key${busy.key ? " disabled" : ""}>${busy.key ? "正在生成…" : "生成密钥"}</button></li>`;
  const hostSteps = targets.map((t) => {
    const ok = t.status?.state === "ok";
    const inst = installers[t.id];
    const body = inst
      ? `<p class="sa-note">${inst.shell === "cmd" ? "在本机「命令提示符」（cmd，<b>不是 PowerShell</b>）里" : "在本机「终端」里"}运行下面这一行，输入 <b>root 密码</b>。第一次连接会显示主机指纹，核对后输入 <code>yes</code>。完成后点「检测」。</p>${copyBlock(inst.command)}` +
        `<p class="sa-note">这把密钥在服务器上被限定为只能运行只读扫描脚本（restrict + command=），开不了 shell。以后要撤销，在终端运行：</p>${copyBlock(inst.uninstallCommand, "复制卸载命令")}`
      : "";
    const route = t.connectionId ? `使用所选连接的独立认证${t.sshJumpServerId ? "，经主集群跳转" : "，公网直连"}；需要服务器已安装只读存储服务，账号也需具备读取权限，不会自动提权。` : "";
    return `<li${ok ? ' data-done="true"' : ""}><b>${escapeHtml(t.label)}</b><span class="sa-dim sa-mono">${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)}</span>` +
      `<span class="sa-step-state" data-ok="${ok ? "true" : "false"}"${route ? ` title="${attr(route)}"` : ""}>${escapeHtml(ok ? "已就绪" : t.status?.message || "未安装或未检测")}</span>` +
      `<span class="sa-actions">${key.exists ? `<button type="button" class="text-btn" data-sa-installer="${attr(t.id)}"${busy[`inst:${t.id}`] ? " disabled" : ""}>${ok ? "重新生成安装命令" : "生成安装命令"}</button>` : ""}` +
      `<button type="button" class="text-btn" data-sa-refresh="${attr(t.id)}"${t.refreshing || busy[`ref:${t.id}`] ? " disabled" : ""}>${t.refreshing || busy[`ref:${t.id}`] ? "检测中…" : "检测"}</button></span>${body}</li>`;
  }).join("");
  return `<section class="sa-sub sa-steps" data-ready="${ready ? "true" : "false"}"><h4>接入步骤${ready ? '<span class="sa-chip" data-on="true">已全部就绪</span>' : ""}</h4><ol>${keyStep}${hostSteps}</ol></section>`;
}

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

// 盘头：挂载点 + 小容量条 + 占比与容量（容量来自 df；没有对应挂载时只写名字）。
function diskHeadHtml(u, mount, sub) {
  const ratio = mount ? usedRatio(mount) : null;
  const cap = mount ? `<span class="sa-users-cap"><span class="sa-users-pct" data-level="${level(ratio)}">${pct(ratio)}</span>${escapeHtml(formatBytePair(mount.used, mount.size, { compact: true }))}</span>${meterHtml(ratio, `${u.mount} 已用 ${pct(ratio)}`)}` : "";
  return `<h4><span class="sa-mono">${escapeHtml(u.mount)}</span><span class="sa-users-tag">${escapeHtml(sub)}</span></h4>${cap}`;
}

// 一台机器多块盘时，次要的盘收成一行摘要（最多的人 + 有占用的用户数 + 细分段条），点「展开」看全部。
function usersCollapsedHtml(u, target, mount) {
  const top = [...(u.rows || [])].sort((a, b) => b.bytes - a.bytes)[0];
  const sum = top ? `最多 ${top.name || `uid ${top.uid}`} ${size(top.bytes)} · ${num(u.rows.length)} 位用户` : "还没有按用户的数据";
  const segs = u.rows?.length ? splitSegments({ ...u, avail: mount?.avail }) : [];
  const mini = segs.length ? `<span class="sa-split sa-split-mini" aria-hidden="true">${segs.map((s) => `<span class="sa-seg" data-kind="${s.kind}"${s.slot ? ` data-slot="${s.slot}"` : ""} style="flex-grow:${(s.ratio * 1000).toFixed(2)}"></span>`).join("")}</span>` : "";
  return `<article class="sa-users sa-users-collapsed" data-sa-anchor="${attr(`disk:${target.id}:${u.mount}`)}"><div class="sa-users-head"><h4><span class="sa-mono">${escapeHtml(u.mount)}</span><span class="sa-users-tag">按用户</span></h4>` +
    `${mini}<span class="sa-dim">${escapeHtml(sum)}</span>` +
    `<button type="button" class="sa-fold" data-sa-fold="${attr(`ublock:${target.id}:${u.mount}`)}" aria-expanded="false">展开</button></div></article>`;
}

const SOURCE = {
  quota: ["repquota", "来源：repquota（按文件属主统计全盘"],
  inode: ["读 inode 表", "来源：读 inode 表按属主统计全盘"],
  scan: ["整盘扫描", "来源：整盘扫描的属主合计"],
};

function usersHtml(u, target, now, activity, fold, collapsible = false) {
  const mount = (target.info?.mounts || []).find((m) => m.mount === u.mount);
  const src = SOURCE[u.source];
  const source = src ? `<span class="sa-src" title="${attr(`${src[1]}，${when(u.at, now)}）；占已用 = 占这块盘已用空间。`)}">${escapeHtml(src[0])} · ${escapeHtml(ago(u.at, now))}</span>` : "";
  const collapse = collapsible
    ? `<button type="button" class="sa-fold" data-sa-fold="${attr(`ublock:${target.id}:${u.mount}`)}" aria-expanded="true">收起</button>`
    : "";
  const action = `<span class="sa-actions">${usageButton(u, target)}${collapse}</span>`;
  const anchor = ` data-sa-anchor="${attr(`disk:${target.id}:${u.mount}`)}"`;
  if (!u.rows.length) {
    const big = u.iused >= QUOTA_HINT_MIN_INODES;
    const inodeOk = Boolean(u.inodeScan?.ok);
    const hint = u.quota
      ? "已开配额统计，点「刷新」读取 repquota。"
      : inodeOk
        ? `还没有按用户的数据。点「按用户统计」：服务器上只读、顺序地读这块盘的 inode 表，${big ? `${num(u.iused)} 个文件也只要` : "通常"}${usageEta(u)}，不遍历目录、不用开配额。`
        : big
          ? `还没有按用户的数据。这块盘有 ${num(u.iused)} 个文件，整盘扫描要很久；可以开启配额统计（见下方说明），也可以对 ${u.mount} 整盘扫描一次。${inodeReason(u)}`
          : `还没有按用户的数据：对 ${u.mount} 整盘扫描一次即可（${num(u.iused)} 个文件，通常几分钟内）。`;
    const guide = u.quota || !big || inodeOk ? "" : quotaGuideHtml(u.mount, target);
    return `<article class="sa-users sa-users-empty"${anchor}><div class="sa-users-head">${diskHeadHtml(u, mount, "按用户")}${action}</div>` +
      `<p class="sa-empty">${escapeHtml(hint)}</p>${guide}</article>`;
  }
  // 读 inode 表的统计把目录也算作一个 inode，表头写清楚。
  const filesLabel = u.source === "inode" ? "文件和目录数" : "文件数";
  const months = activity?.months || DEFAULT_IDLE_MONTHS;
  const cold = coldChartHtml(u, { now, months });
  const capacity = mount ? usedRatio(mount) : null;
  return `<article class="sa-users"${anchor}><div class="sa-users-head">${diskHeadHtml(u, mount, `按用户 · ${num(u.rows.length)} 位`)}${source}${action}</div>` +
    `<div class="sa-users-top${cold ? "" : " sa-users-top-solo"}"><div class="sa-users-main">${userKpisHtml(u, { now, months, capacity })}` +
    `<div class="sa-split-wrap">${splitBarHtml({ ...u, avail: mount?.avail }, { tall: true })}</div></div>${cold}</div>` +
    `${idleToolbarHtml(u, { now, activity })}${userRowsHtml(u, { filesLabel, activity, now, fold, foldKey: `users:${target.id}:${u.mount}` })}` +
    `${u.source === "scan" && !u.quota && !u.inodeScan?.ok && u.iused >= QUOTA_HINT_MIN_INODES ? quotaGuideHtml(u.mount, target) : ""}</article>`;
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
  const inode = job.kind === "inode";
  const title = inode ? `正在按用户统计 ${job.root}（读 inode 表）` : `正在扫描 ${job.root}`;
  const how = inode
    ? "在服务器上后台运行：只读、顺序、限速读块设备（不进页缓存），关掉工作台也会继续；每 5 秒更新一次。"
    : "扫描在服务器上后台运行（最低优先级），关掉工作台也会继续；每 5 秒更新一次。";
  const stat = (label, value) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`;
  return `<div class="sa-job" data-indeterminate="${ratio == null ? "true" : "false"}"><div class="sa-job-head"><span class="sa-job-pulse" aria-hidden="true"></span><b>${escapeHtml(title)}</b>${info(how)}` +
    `${ratio != null ? `<span class="sa-job-pct">约 ${pct(ratio)}</span>` : ""}` +
    `<button type="button" class="text-btn" data-sa-stop="${attr(target.id)}" data-job="${attr(job.id)}">停止</button></div>` +
    `<span class="sa-job-bar"><span class="sa-job-fill" style="width:${ratio != null ? (ratio * 100).toFixed(1) : 100}%"></span></span>` +
    `<div class="sa-job-stats">${stat(inode ? "已统计" : "已扫", `${num(job.entries)} 个${inode ? "文件" : "条目"}`)}${stat("容量", size(job.bytes))}` +
    `${stat("已进行", elapsed != null ? mins(elapsed) : "—")}${eta ? stat("预计还要", mins(eta)) : ""}</div>` +
    (job.current ? `<p class="sa-job-current sa-mono" title="${attr(job.current)}">${escapeHtml(job.current)}</p>` : "") + "</div>";
}

function rootsHtml(t, running, fold) {
  const roots = t.info?.roots || [];
  if (!roots.length) return "";
  const mounts = new Set((t.info?.mounts || []).map((m) => m.mount));
  const body = roots.map((r) => {
    const rootBtns = `<button type="button" class="text-btn" data-sa-list="${attr(t.id)}" data-path="${attr(r.path)}">查看目录</button>` +
      `<button type="button" class="text-btn" data-sa-scan="${attr(t.id)}" data-root="${attr(r.path)}"${running ? " disabled" : ""}>扫描${mounts.has(r.path) ? "整盘" : ""}</button>`;
    const folded = foldList(r.children || [], `kids:${t.id}:${r.path}`, fold, 8);
    const kids = folded.shown.map((c) => {
      const full = `${r.path}/${c.name}`;
      return `<li><span class="sa-kid-icon" aria-hidden="true"></span><span class="sa-name">${escapeHtml(c.name)}</span>${c.mount ? '<span class="sa-chip" data-on="true">独立磁盘</span>' : ""}` +
        `<span class="sa-dim sa-kid-owner">${escapeHtml(c.owner || (c.uid != null ? `uid ${c.uid}` : ""))}</span>` +
        `<span class="sa-actions"><button type="button" class="text-btn" data-sa-list="${attr(t.id)}" data-path="${attr(full)}">查看</button>` +
        `<button type="button" class="text-btn" data-sa-scan="${attr(t.id)}" data-root="${attr(full)}"${running ? " disabled" : ""}>扫描</button></span></li>`;
    }).join("");
    return `<div class="sa-root"><div class="sa-root-head"><b class="sa-mono">${escapeHtml(r.path)}</b><span class="sa-dim">${num((r.children || []).length)} 项</span><span class="sa-actions">${rootBtns}</span></div>` +
      (kids ? `<ul class="sa-kids">${kids}</ul>${folded.toggle}` : '<p class="sa-note">（没有子目录或读不到）</p>') + "</div>";
  }).join("");
  return `<section class="sa-card sa-roots"><div class="sa-card-head"><h4>可扫描目录</h4>${info("「查看」即时列出目录（发一次 SSH）；「扫描」在服务器后台统计整棵目录树，结果保存在本机，可在「扫描记录」里逐层浏览。")}</div>${body}</section>`;
}

function scansHtml(t, now, fold) {
  if (!t.scans?.length) return "";
  const folded = foldList(t.scans, `scans:${t.id}`, fold, 4);
  const max = Math.max(...t.scans.map((j) => j.bytes || 0), 0);
  const rows = folded.shown.map((j) => {
    const inode = j.kind === "inode";
    const name = inode
      ? `<span class="sa-mono">${escapeHtml(j.root)}</span>`
      : `<button type="button" class="text-btn sa-mono" data-sa-view="${attr(t.id)}" data-job="${attr(j.id)}">${escapeHtml(j.root)}</button>`;
    return `<tr${inode ? "" : ' data-browsable="true"'}><td class="sa-name">${name}${j.partial ? '<span class="sa-chip" data-warn="true" title="中途停止，只含已扫部分">部分</span>' : ""}</td>` +
      `<td><span class="sa-kind" data-kind="${inode ? "inode" : "tree"}">${inode ? "按用户" : "目录树"}</span></td>` +
      `<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:${max ? ((j.bytes / max) * 100).toFixed(1) : 0}%"></span></span></td>` +
      `<td class="sa-num sa-strong-num">${escapeHtml(size(j.bytes))}</td>` +
      `<td class="sa-num sa-dim sa-files-col">${escapeHtml(num(j.entries))}</td><td class="sa-num sa-dim" title="${attr(when(j.endedAt, now))}">${escapeHtml(ago(j.endedAt, now))}</td></tr>`;
  }).join("");
  return `<section class="sa-card sa-scans"><div class="sa-card-head"><h4>扫描记录</h4><span class="sa-dim">保存在本机 · 点「目录树」的路径逐层浏览</span></div>` +
    `<div class="sa-table-wrap"><table class="sa-table sa-scan-table"><thead><tr><th>范围</th><th>类型</th><th class="sa-barcell"><span class="sa-visually-hidden">相对大小</span></th><th class="sa-num">占用</th><th class="sa-num sa-files-col">条目</th><th class="sa-num">完成</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>${folded.toggle}</section>`;
}

export function buildTargetHtml(t, { now = Date.now(), activity = { months: DEFAULT_IDLE_MONTHS, only: false }, fold = null, editable = false } = {}) {
  const state = t.status?.state || "unknown";
  const roots = (t.roots || []).map((r) => `<span class="sa-chip sa-mono">${escapeHtml(r)}</span>`).join("");
  const head = `<div class="sa-target-head"><span class="sa-status" data-state="${attr(state)}">${escapeHtml(STATUS_TEXT[state] || state)}</span>` +
    `<h3>${escapeHtml(t.label)}</h3><span class="sa-dim sa-mono">${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)}</span>` +
    `<span class="sa-target-scope" title="允许查看的目录">${roots}</span>` +
    `${t.checkedAt ? `<span class="sa-dim">检测于 ${escapeHtml(formatRelativeTime(t.checkedAt, now) || "刚刚")}</span>` : ""}` +
    `<span class="sa-actions">${editable ? `<button type="button" class="text-btn" data-sa-edit-target="${attr(t.id)}"${t.running || t.refreshing ? " disabled" : ""}>添加 / 管理目录</button>` : ""}` +
    `<button type="button" class="btn btn-secondary sa-btn" data-sa-refresh="${attr(t.id)}"${t.refreshing ? " disabled" : ""}>${t.refreshing ? "刷新中…" : "刷新"}</button></span></div>`;
  const msg = state !== "ok" && t.status?.message ? `<p class="sa-banner" data-level="warn">${escapeHtml(t.status.message)}</p>` : "";
  const anchor = ` data-sa-anchor="${attr(`target:${t.id}`)}"`;
  if (!t.info) return `<section class="sa-target"${anchor}>${head}${msg}<p class="sa-empty">还没有数据：完成接入步骤后点「刷新」。</p></section>`;
  const mounts = t.info.mounts.length ? "" : '<p class="sa-empty">没有找到相关的磁盘。</p>';
  // 多块盘：默认只展开已用最多的那块的「按用户」，其余收成一行（展开状态记在 fold 里）。
  const list = t.users || [];
  const primary = list.length > 1 ? [...list].sort((a, b) => (b.used || 0) - (a.used || 0))[0].mount : null;
  const users = list.map((u) => (
    !primary || u.mount === primary || fold?.open?.has(`ublock:${t.id}:${u.mount}`)
      ? usersHtml(u, t, now, activity, fold, Boolean(primary) && u.mount !== primary)
      : usersCollapsedHtml(u, t, t.info.mounts.find((m) => m.mount === u.mount))
  )).join("");
  const side = `${rootsHtml(t, Boolean(t.running), fold)}${scansHtml(t, now, fold)}`;
  return `<section class="sa-target"${anchor}>${head}${msg}${mounts}${jobHtml(t.running, now, t)}${users}${side ? `<div class="sa-target-grid">${side}</div>` : ""}</section>`;
}

// 节点选择（可多选）：每个节点一枚胶囊，带最满那块盘的占用、连接状态与「扫描中」。
function targetTabsHtml(targets, selected) {
  return `<div class="sa-tabs" role="group" aria-label="存储节点和账号（可多选）">${targets.map((t) => {
    const worst = (t.info?.mounts || []).reduce((m, d) => Math.max(m, usedRatio(d)), 0);
    const badge = t.info?.mounts?.length ? `<span class="sa-tab-pct" data-level="${level(worst)}">${Math.round(worst * 100)}%</span>` : "";
    const busyDot = t.running ? '<span class="sa-tab-busy" title="有任务在跑"></span>' : "";
    const bad = t.status?.state && t.status.state !== "ok" ? '<span class="sa-tab-warn" title="连接或版本有问题">!</span>' : "";
    return `<label class="sa-tab" title="${attr(`${t.sshUser || "root"}@${t.host}`)}"><input type="checkbox" data-sa-target-tab="${attr(t.id)}"${selected.includes(t.id) ? " checked" : ""}>` +
      `<b>${escapeHtml(t.label)}</b><span class="sa-tab-host">${escapeHtml(t.sshUser || "root")}@${escapeHtml(t.host)}</span>${badge}${busyDot}${bad}</label>`;
  }).join("")}</div>`;
}

// ② 总览：已用容量大数字 + 统计 + 所有磁盘的容量条。
export function buildFleetHtml(targets) {
  const s = fleetSummary(targets);
  if (!s.disks.length) return "";
  const lv = level(s.ratio);
  const f = s.fullest;
  const stats = [
    kpiHtml("剩余", size(s.avail), `共 ${size(s.size)}`),
    kpiHtml("文件数", num(s.iused), s.inodes > 0 ? `inode 已用 ${pct(s.iused / s.inodes)}` : ""),
    kpiHtml("最满的盘", f ? pct(f.ratio) : "—", f ? `${f.target.label} ${f.mount.mount}` : "", f ? ` data-level="${level(f.ratio)}"` : ""),
    kpiHtml("≥ 80% 的盘", `${num(s.hot)} 块`, `共 ${num(s.disks.length)} 块 · ${num(s.nodes)} 台节点`, s.hot ? ' data-level="warn"' : ""),
  ].join("");
  return `<div class="sa-fleet-grid"><section class="sa-hero" data-level="${lv}"><span class="sa-hero-label">已用容量</span>` +
    `<div class="sa-hero-figure"><span class="sa-hero-value">${pct(s.ratio)}</span><span class="sa-hero-cap">${escapeHtml(formatBytePair(s.used, s.size, { compact: true }))}</span></div>` +
    `${meterHtml(s.ratio, `所选节点合计已用 ${pct(s.ratio)}`, { large: true })}<div class="sa-kpis sa-kpis-2">${stats}</div></section>` +
    `<section class="sa-capacity"><div class="sa-card-head"><h4>磁盘容量</h4><span class="sa-dim">按占用排序 · 刻度 80% / 90% · 点一行查看该盘用户</span></div>` +
    `${capacityRowsHtml(s.disks, { multiNode: s.nodes > 1 || targets.length > 1 })}</section></div>`;
}

export function buildStorageTargetForm(data, busy = {}) {
  if (!data?.setup) return "";
  const draft = data.setup;
  const editing = draft.editing === true;
  const locked = editing ? " readonly" : "";
  const field = (name, label, value, extra = "") => `<label>${label}<input name="${name}" value="${attr(String(value ?? ""))}" ${extra} /></label>`;
  const note = editing
    ? "已保留原目录，可在「新增目录」中追加多个路径；也可修改已有列表。保存后按引导同步服务器授权，再检测。无需重新生成密钥，仍在范围内的扫描结果会保留。"
    : "已预填当前连接。选择允许查看的目录并保存，然后按接入步骤配置只读扫描。也可填写另一台服务器。";
  return `<details class="sa-sub sa-form-card"${editing || !data.targets?.length ? " open" : ""}><summary>${editing ? `管理 ${escapeHtml(draft.label || draft.id)} 的目录` : "配置存储服务器"}${info(note)}</summary>` +
    '<div class="sa-target-form" data-sa-target-form>' +
    field("id", "服务器标识", draft.id, `maxlength="64"${locked}`) + field("label", "显示名称", draft.label, 'maxlength="64"') +
    `<label>节点与登录账号<select name="connectionId" data-sa-connection${editing ? " disabled" : ""}><option value="">专用 root 受限密钥（手填地址）</option>${(data.connections || []).map((s) => `<option value="${attr(s.id)}"${draft.connectionId === s.id ? " selected" : ""}>${escapeHtml(s.name)} · ${escapeHtml(s.sshUser || "默认账号")}@${escapeHtml(s.host)}（${s.sshJumpServerId ? "内网跳转" : "直连"}）</option>`).join("")}</select></label>` +
    field("host", "服务器地址或 SSH 别名", draft.host, `autocomplete="off"${locked}`) + field("port", "SSH 端口", draft.port || 22, `type="number" min="1" max="65535"${locked}`) +
    `<label class="sa-target-roots">${editing ? "已有目录（可修改）" : "允许查看的目录"}<input name="roots" value="${attr(draft.roots || "")}" placeholder="例如 /home /public /mnt（空格分隔）" /></label>` +
    (editing ? `<label class="sa-target-roots">新增目录<input name="additionalRoots" value="${attr(draft.additionalRoots || "")}" placeholder="例如 /data /mnt/archive（空格分隔，合计最多 8 个）" /></label>` : "") +
    `<button type="button" class="btn btn-secondary" data-sa-save-target${busy.target ? " disabled" : ""}>${busy.target ? "正在保存…" : editing ? "保存目录范围" : "保存存储服务器"}</button></div></details>`;
}

function missingConnections(data) {
  return (data?.connections || []).filter((connection) => !(data.targets || []).some((target) =>
    target.connectionId === connection.id || (!target.connectionId && target.host === connection.host
      && target.port === connection.port && connection.sshUser === "root")));
}

export function buildUnconfiguredConnectionsHtml(data) {
  if (!data?.setup) return "";
  const missing = missingConnections(data);
  if (!missing.length) return "";
  return `<section class="sa-sub sa-conns"><h4>尚未配置存储扫描的连接${info("已保存的 SSH 连接需要单独选择扫描目录，再安装并检测只读存储服务。")}</h4><ul>` +
    missing.map((connection) => `<li><b>${escapeHtml(connection.name)}</b><span class="sa-dim sa-mono">${escapeHtml(connection.sshUser || "默认账号")}@${escapeHtml(connection.host)}</span>` +
      `<button type="button" class="text-btn" data-sa-configure="${attr(connection.id)}">配置扫描目录</button></li>`).join("") + "</ul></section>";
}

export function buildStorageGuideHtml(data, { installers = {}, busy = {} } = {}) {
  if (!data) return "";
  const targets = data.targets || [];
  const target = targets.find((t) => t.status?.code === "roots-update") || targets.find((t) => t.status?.state !== "ok");
  let stage, title, message, action = "";
  if (!targets.length) {
    stage = "target"; title = "1 · 先选择节点和允许扫描的目录";
    message = "SSH 连接成功后，还需要为存储管理单独选择节点与目录；保存后，这里会引导你完成后续接入。";
    action = '<button type="button" class="text-btn" data-sa-show-setup>填写扫描范围</button>';
  } else if (!target) {
    stage = "ready"; title = "4 · 已完成检测，可以查看目录和扫描";
    message = "连接与只读服务已经检测通过。选择下方的节点和目录，再点击对应的扫描按钮；已有扫描结果可以直接打开。";
  } else if (["unreachable", "timeout"].includes(target.status?.code)) {
    stage = "network"; title = "先恢复到这个节点的网络连接";
    message = "连上能访问该节点的内网或 VPN，核对地址和端口后重新检测。网络不通时，重复生成密钥不能解决问题。";
    action = `<button type="button" class="text-btn" data-sa-refresh="${attr(target.id)}"${busy[`ref:${target.id}`] ? " disabled" : ""}>重新检测连接</button>`;
  } else if (target.connectionId && target.status?.state === "unknown") {
    stage = "check"; title = "2 · 先检测已保存的节点连接";
    message = "先用你选择的账号检测服务器上的只读存储服务；已经接入过的节点可以直接使用。";
    action = `<button type="button" class="text-btn" data-sa-refresh="${attr(target.id)}"${busy[`ref:${target.id}`] ? " disabled" : ""}>检测 ${escapeHtml(target.label)}</button>`;
  } else if (!data.key?.exists) {
    stage = "key"; title = "2 · 准备这台电脑的存储专用密钥";
    message = "这是管理员存储功能的受限密钥。新电脑生成自己的密钥，再把公钥加入服务器即可；不用拷贝旧电脑的私钥，也不会移除旧电脑的授权。";
    action = `<button type="button" class="text-btn" data-sa-key${busy.key ? " disabled" : ""}>${busy.key ? "正在生成…" : "生成本机存储密钥"}</button>`;
  } else if (target.status?.code === "roots-update" && !installers[target.id]) {
    stage = "scope"; title = `为 ${target.label} 同步目录授权`;
    message = "目录范围已在本机保存。重新生成并在本机执行安装命令，把完整目录范围同步到服务器；使用现有密钥，原有扫描结果保留。完成后点击检测。";
    action = `<button type="button" class="text-btn" data-sa-installer="${attr(target.id)}"${busy[`inst:${target.id}`] ? " disabled" : ""}>生成目录授权更新命令</button>`;
  } else if (!installers[target.id]) {
    stage = "install"; title = `3 · 为 ${target.label} 准备公钥授权和只读服务`;
    message = "本机密钥已准备好。生成安装命令后，按提示在本机执行一次；服务器上只安装公钥和只读服务。该步骤需要管理员具备目标服务器的 root 登录权限。";
    action = `<button type="button" class="text-btn" data-sa-installer="${attr(target.id)}"${busy[`inst:${target.id}`] ? " disabled" : ""}>生成安装命令</button>`;
  } else {
    stage = "verify"; title = `3 · 安装完成后检测 ${target.label}`;
    const shell = installers[target.id].shell === "cmd" ? "本机的命令提示符（cmd），不是 PowerShell 或集群终端" : "本机终端，不是集群终端";
    message = `在下方「接入步骤」里复制该节点的安装命令，在${shell}执行。看到安装成功后点击检测，检测通过才进入扫描。`;
    action = `<button type="button" class="text-btn" data-sa-refresh="${attr(target.id)}"${busy[`ref:${target.id}`] ? " disabled" : ""}>我已安装，检测连接</button>`;
  }
  const m = /^(\d) · (.*)$/.exec(title);
  const badge = `<span class="sa-guide-step" aria-hidden="true">${m ? m[1] : "!"}</span>`;
  return `<section class="sa-guide-card" data-sa-guide-stage="${stage}" aria-label="存储接入下一步">${badge}<div class="sa-guide-text"><h3>${escapeHtml(m ? m[2] : title)}</h3>` +
    `<p class="sa-note">${escapeHtml(message)}</p></div>${action ? `<span class="sa-guide-action">${action}</span>` : ""}</section>`;
}

// ① 接入与配置：一行可展开。没就绪（或正在编辑目录）时默认展开，上面再放一张「下一步」卡。
function manageHtml(data, { installers, busy }) {
  const targets = data.targets || [];
  const guide = buildStorageGuideHtml(data, { installers, busy });
  const guideReady = /data-sa-guide-stage="ready"/.test(guide);
  const ready = guideReady && stepsReady(data);
  const okCount = targets.filter((t) => t.status?.state === "ok").length;
  const missing = data.setup ? missingConnections(data).length : 0;
  const chips = [
    `<span class="sa-chip" data-on="${okCount === targets.length ? "true" : "false"}">${num(okCount)}/${num(targets.length)} 台已就绪</span>`,
    `<span class="sa-chip" data-on="${data.key?.exists ? "true" : "false"}">${data.key?.exists ? "本机密钥已就绪" : "缺本机密钥"}</span>`,
    missing ? `<span class="sa-chip" data-warn="true">${num(missing)} 个连接未接入</span>` : "",
  ].join("");
  const open = !ready || data.setup?.editing === true;
  return `${guideReady ? "" : guide}<details class="sa-manage" data-sa-key="manage"${open ? " open" : ""}><summary><span class="sa-manage-title">接入与配置</span>${chips}</summary>` +
    `<div class="sa-manage-body">${buildUnconfiguredConnectionsHtml(data)}${buildStorageTargetForm(data, busy)}${buildSetupHtml(data, { installers, busy })}</div></details>`;
}

export function buildOverviewHtml(data, { installers = {}, busy = {}, error = "", loading = false, now = Date.now(), activity, fold = null, selected = null } = {}) {
  if (loading && !data) return '<p class="sa-empty">正在读取…</p>';
  if (!data) return error ? `<p class="sa-banner" data-level="warn">${escapeHtml(error)}</p>` : "";
  if (!data.targets?.length) {
    return buildStorageGuideHtml(data, { installers, busy }) + buildStorageTargetForm(data, busy) + buildUnconfiguredConnectionsHtml(data);
  }
  const err = error ? `<p class="sa-banner" data-level="warn">${escapeHtml(error)}</p>` : "";
  const opts = { now, fold, editable: Boolean(data.setup), ...(activity ? { activity } : {}) };
  const picks = Array.isArray(selected) ? selected : selected ? [selected] : data.targets.map((t) => t.id);
  const chosen = data.targets.filter((t) => picks.includes(t.id));
  const fleet = `<section class="sa-fleet">${targetTabsHtml(data.targets, picks)}${buildFleetHtml(chosen)}</section>`;
  return `${err}${manageHtml(data, { installers, busy })}${fleet}${chosen.map((t) => buildTargetHtml(t, opts)).join("") || '<p class="sa-empty">勾选上方节点与账号以查看存储。</p>'}`;
}

// 扫描结果的某一层：面包屑 · 统计条 · 树图（全宽）· 目录排行 · 属主与最大的文件并排。
export function buildBrowserHtml(view, { now = Date.now(), fold = null } = {}) {
  if (!view) return "";
  const crumbs = view.crumbs.map((c, i) => (i === view.crumbs.length - 1
    ? `<b>${escapeHtml(c.name)}</b>`
    : `<button type="button" class="text-btn" data-sa-rel="${attr(c.rel)}">${escapeHtml(c.name)}</button>`)).join('<span class="sa-crumb-sep" aria-hidden="true">/</span>');
  const n = view.node;
  const job = view.job;
  const stats = [
    kpiHtml("占用", size(n.blocks), n.size != null && Number.isFinite(n.size) ? `文件大小合计 ${size(n.size)}` : ""),
    kpiHtml("文件", num(n.files)),
    kpiHtml("子目录", num(n.dirs)),
    n.owner ? kpiHtml("属主", n.owner) : "",
    kpiHtml("扫描于", ago(job.endedAt, now), clockText(job.endedAt)),
  ].join("");
  const partial = job.partial ? '<p class="sa-banner" data-level="warn"><b>中途停止，只含已扫部分</b>：数字偏小，需要完整结果请重新扫描。</p>' : "";
  const maxFile = view.top[0]?.blocks || 0;
  const topFold = foldList(view.top, `files:${view.path}`, fold);
  const top = view.top.length
    ? `<section class="sa-card sa-files"><div class="sa-card-head"><h4>最大的文件</h4><span class="sa-dim">这一层以下</span></div><div class="sa-table-wrap"><table class="sa-table sa-ranked"><tbody>${topFold.shown.map((f) => (
      `<tr><td class="sa-name sa-file" title="${attr(f.rel)}">${fileNameHtml(f.name)}</td><td class="sa-dim sa-owner">${escapeHtml(f.owner || "")}</td>` +
      `<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:${(maxFile ? (f.blocks / maxFile) * 100 : 0).toFixed(1)}%"></span></span></td>` +
      `<td class="sa-num sa-strong-num">${escapeHtml(size(f.blocks))}</td><td class="sa-num sa-dim sa-mtime">${escapeHtml(clockText(f.mtime))}</td></tr>`
    )).join("")}</tbody></table></div>${topFold.toggle}</section>`
    : "";
  const owners = view.owners?.length
    ? `<section class="sa-card sa-files"><div class="sa-card-head"><h4>按属主</h4><span class="sa-dim">这次扫描范围内</span></div>` +
      `<div class="sa-split-wrap">${splitBarHtml({ rows: view.owners, used: n.blocks, avail: 0 }, { tall: true, name: view.path, scope: "扫描范围" })}</div>` +
      `${userRowsHtml({ rows: view.owners }, { shareLabel: "占扫描范围", fold, foldKey: `owners:${view.path}` })}</section>`
    : "";
  const map = treemapHtml(view);
  const note = `占用 = 磁盘块（st_blocks × 512）；不跟随符号链接、不跨文件系统，硬链接只计一次。为控制体积，只保留第一层的全部目录和更深处 ≥ ${size(view.threshold)} 的最大 3 万个目录。`;
  return `<div class="sa-browser-head"><span class="sa-crumbs">${crumbs}</span>${info(note)}<span class="sa-actions">` +
    `<button type="button" class="text-btn" data-sa-list-here="${attr(view.path)}">即时列出全部条目</button>` +
    `<button type="button" class="text-btn" data-sa-close>关闭</button></span></div>` +
    `${partial}<div class="sa-kpis sa-kpis-strip">${stats}</div>` +
    (map ? `<section class="sa-tm-card"><div class="sa-card-head"><h4>子目录占用</h4><span class="sa-dim">面积 = 占用 · 带 › 的块可以点进去</span>${toneLegendHtml()}</div>${map}</section>` : "") +
    `<section class="sa-card"><div class="sa-card-head"><h4>目录排行</h4></div>${rankedRowsHtml(view, { clockText, fold })}</section>` +
    (top || owners ? `<div class="sa-files-grid">${owners}${top}</div>` : "");
}

// 最大的文件：名字是相对路径，长路径截断后每行都只剩同一个前缀——文件名放第一行，所在目录作第二行小字。
function fileNameHtml(rel) {
  const i = String(rel).lastIndexOf("/");
  const base = i >= 0 ? rel.slice(i + 1) : rel;
  return `<span class="sa-file-base">${escapeHtml(base)}</span>${i > 0 ? `<span class="sa-file-dir"><bdi>${escapeHtml(rel.slice(0, i))}</bdi></span>` : ""}`;
}

const KIND = { d: "目录", f: "文件", l: "链接", o: "其他" };

// 即时列目录（发 SSH）：全部条目；目录的大小只有在扫描结果里才有。
export function buildListHtml(list, { fold = null } = {}) {
  if (!list) return "";
  const parent = list.path.includes("/") && list.path.lastIndexOf("/") > 0 ? list.path.slice(0, list.path.lastIndexOf("/")) : null;
  const folded = foldList(list.entries, `list:${list.path}`, fold, 12);
  const rows = folded.shown.map((e) => {
    const name = e.kind === "d"
      ? `<button type="button" class="text-btn sa-dir" data-sa-list-here="${attr(`${list.path}/${e.name}`)}">${escapeHtml(e.name)}/</button>`
      : `<span>${escapeHtml(e.name)}${e.kind === "d" ? "/" : e.kind === "l" ? " →" : ""}</span>`;
    const sz = e.kind === "d" ? (e.treeBlocks != null ? size(e.treeBlocks) : "未扫描") : size(e.blocks);
    return `<tr><td class="sa-name"><span class="sa-kind-icon" data-kind="${attr(e.kind || "o")}" aria-hidden="true"></span>${name}${e.mount ? '<span class="sa-chip" data-on="true">独立磁盘</span>' : ""}</td><td class="sa-dim">${KIND[e.kind] || ""}</td>` +
      `<td class="sa-dim">${escapeHtml(e.owner || (e.uid != null ? `uid ${e.uid}` : ""))}</td><td class="sa-num${sz === "未扫描" ? " sa-dim" : " sa-strong-num"}">${escapeHtml(sz)}</td><td class="sa-num sa-dim">${escapeHtml(clockText(e.mtime))}</td></tr>`;
  }).join("");
  return `<div class="sa-browser-head"><span class="sa-crumbs"><b>${escapeHtml(list.path)}</b></span>` +
    `${info("即时列出（发一次 SSH）。目录大小来自扫描结果；没扫描过的目录显示「未扫描」。")}<span class="sa-dim">${num(list.entries.length)} 项${list.truncated ? "（条目过多，只列出前一部分）" : ""}</span><span class="sa-actions">` +
    `${parent ? `<button type="button" class="text-btn" data-sa-list-here="${attr(parent)}">上一级</button>` : ""}` +
    `<button type="button" class="text-btn" data-sa-close>关闭</button></span></div>` +
    (rows ? `<section class="sa-card"><div class="sa-table-wrap"><table class="sa-table"><thead><tr><th>名称</th><th>类型</th><th>属主</th><th class="sa-num">大小</th><th class="sa-num">修改</th></tr></thead><tbody>${rows}</tbody></table></div>${folded.toggle}</section>` : '<p class="sa-empty">空目录。</p>');
}
