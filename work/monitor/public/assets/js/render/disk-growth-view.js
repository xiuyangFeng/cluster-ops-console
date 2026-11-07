// disk-growth-view.js —— 「查看我的目录占用」面板顶部「作业产出目录」一块的 HTML（纯字符串函数，Node 可测）。
// 数据是 GET /api/disk-growth / POST /api/disk-growth/scan 的返回（后端 lib/disk-growth/model.mjs 已排好序、算好增长）。
// 回答的是「磁盘是不是我的作业写满的、哪个批次、涨了多少」：按作业登记找到的集合目录，每 6 小时自动量一次
// 各子目录的实际占用。没有集合目录、不是团队集群、「我的 Slurm 作业」模块关着时返回空串——整块不显示。
// 所有动态文案一律 escapeHtml；按钮只带 data-dg-scan，由 app/disk-growth-controller.js 委托处理。
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";
import { clockOf, dayKeyOf } from "./usage-model.js";

const VISIBLE_ROOTS = 4;
const STALE_MS = 12 * 3600_000;
const size = (n) => formatBytes(n, { compact: true });
const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("zh-CN") : "—");
const label = (root) => `~/${root}`;
const baseName = (root) => root.slice(root.lastIndexOf("/") + 1);

// 「14:20」；不是今天（北京时间）就带上日期「10-11 14:20」。量的是集群上的目录，时刻按北京时间。
function clockText(ts, now) {
  if (!Number.isFinite(ts)) return "";
  const day = dayKeyOf(ts / 1000);
  const clock = clockOf(ts / 1000);
  return day === dayKeyOf(now / 1000) ? clock : `${Number(day.slice(5, 7))}-${day.slice(8)} ${clock}`;
}

// 增长一栏：+1.1 TiB / −20 GiB / 0；算不出来是「—」。
export function deltaText(delta) {
  if (!Number.isFinite(delta)) return "—";
  if (delta === 0) return "0";
  return `${delta > 0 ? "+" : "−"}${size(Math.abs(delta))}`;
}

function shareText(share) {
  if (!Number.isFinite(share)) return "";
  if (share >= 1) return "，超过整盘同期的净增长";
  if (share < 0.01) return "，占整盘同期增长不到 1%";
  return `，占整盘同期增长的 ${Math.round(share * 100)}%`;
}

// 一句话：合计涨了多少、占整盘多少；还没有可比的上一次就只说现在多大。
export function totalText(growth) {
  if (!Number.isFinite(growth.measuredAt)) return "";
  const { total } = growth;
  // 有上一次（refAt）却算不出合计：两次没有都量完的目录可比。
  if (!Number.isFinite(total.delta)) {
    return `合计 ${size(total.bytes)}。${Number.isFinite(growth.refAt) ? "这次与上一次没有都量完的目录可比，算不出增长。" : "增长要和至少 3 小时前的一次测量比，现在还没有。"}`;
  }
  const scope = total.partial ? "两次都量完的目录合计" : "合计";
  return `${growth.label}${scope} ${deltaText(total.delta)}${total.delta > 0 ? shareText(growth.share) : ""}。`;
}

// 要提醒的地方（只列真实发生的）：数字是很久以前的、没量全的。
export function caveatTexts(growth, now = Date.now()) {
  const out = [];
  if (!Number.isFinite(growth.measuredAt)) {
    out.push(growth.attempt?.error ? `还没有量成：${growth.attempt.error}` : "还没有量成。");
    return out;
  }
  // 正常每 6 小时量一次；隔了这么久说明之后没再量成（工作台没开着、服务器连不上，或登记里已经没有这些目录的作业）。
  if (now - growth.measuredAt > STALE_MS) out.push(`这是 ${formatRelativeTime(growth.measuredAt, now)}量的，之后没有再量成，增长一栏也是当时的`);
  if (growth.stop === "deadline") out.push("这次到 10 分钟上限先停了，没量完的目录标了「未量完」");
  else if (growth.stop === "error") out.push(`这次中途停了${growth.attempt?.error ? `：${growth.attempt.error}` : ""}；已经量到的照实记着，没量完的标了「未量完」`);
  for (const root of growth.roots) {
    if (root.state === "error") out.push(`${label(root.root)} 没有量：${root.error || "远端没有量成"}`);
    else if (root.state === "skipped") out.push(`${label(root.root)} 这次没轮到`);
    else if (root.state === "partial" && !growth.stop) out.push(`${label(root.root)} 有子目录没量全（子目录太多、超出扫描器一次能排的数量，或量到一半目录变了）`);
  }
  return out;
}

function statusText(data, now) {
  const run = data.running ? data.run : null;
  if (run) {
    const which = run.rootCount > 1 ? `，第 ${num(run.rootIndex + 1)} / ${num(run.rootCount)} 个目录` : "";
    return `正在量 · 第 ${num((run.rounds || 0) + 1)} 轮${which}`;
  }
  const at = data.growth.measuredAt;
  return Number.isFinite(at) ? `量于 ${clockText(at, now)}（${formatRelativeTime(at, now) || "刚刚"}）` : "";
}

// 增长一格。说明性的小字（未量完 / 新出现 / 至少）都放在这一格里：目录名那一格会被省略号截断，放不稳。
function growthCell(row) {
  if (row.partial) return '<span class="dg-tag" title="这个目录只量了一部分，左边的实际占用偏小，不参与增长">未量完</span>';
  const text = escapeHtml(deltaText(row.delta));
  if (row.lowerBound) return `<span title="上一次它不在最大的 40 个里，没有单独的数字：增长按下限算"><span class="dg-tag">至少</span> ${text}</span>`;
  if (row.isNew) return `<span title="上一次量的时候还没有这个目录"><span class="dg-tag">新出现</span> ${text}</span>`;
  return text;
}

function rowHtml(row, now) {
  return `<li class="du-item"><div class="du-row dg-row"><span class="du-name" title="${escapeHtml(`${label(row.root)}/${row.name}`)}">${escapeHtml(`${baseName(row.root)}/${row.name}`)}</span>` +
    `<span class="du-num">${escapeHtml(size(row.bytes))}</span><span class="du-num dg-delta" data-sign="${row.delta > 0 ? "up" : "flat"}">${growthCell(row)}</span>` +
    `<span class="du-num du-wide">${escapeHtml(clockText(row.at, now))}</span></div></li>`;
}

// state：{ busy, error }。data 为 null、不在范围、模块关着、没有集合目录 → ""（整块不显示）。
export function buildDiskGrowthHtml(data, { busy = false, error = "", now = Date.now() } = {}) {
  const growth = data?.growth;
  if (!data || data.eligible === false || data.disabled === true || !growth) return "";
  const running = data.running === true;
  const status = statusText(data, now);
  const head =
    `<div class="du-head"><span class="du-root">作业产出目录</span>` +
    `<span class="du-actions">${status ? `<span class="du-busy">${escapeHtml(status)}</span>` : ""}` +
    `<button type="button" class="text-btn du-primary" data-dg-scan${running || busy ? " disabled" : ""}>现在量一次</button></span></div>`;
  const total = totalText(growth);
  const caveats = caveatTexts(growth, now);
  const notes = (error ? `<p class="du-note" data-level="warn">${escapeHtml(error)}</p>` : "")
    + (total ? `<p class="du-coverage" data-complete="${growth.complete ? "true" : "false"}">${escapeHtml(total)}</p>` : "")
    + (caveats.length ? `<p class="du-note" data-level="warn">${escapeHtml(caveats.join("；"))}。</p>` : "");
  const column = growth.label || "增长";
  const table = growth.rows.length
    ? `<div class="du-table"><div class="du-row dg-row du-th"><span class="du-name">目录（${growth.label ? `按${escapeHtml(growth.label)}增长` : "按实际占用"}）</span>` +
      `<span class="du-num">实际占用</span><span class="du-num">${escapeHtml(column)}</span><span class="du-num du-wide">量于</span></div>` +
      `<ul class="du-list">${growth.rows.map((row) => rowHtml(row, now)).join("")}</ul></div>`
    : "";
  const more = growth.rowCount > growth.rows.length ? `只列前 ${num(growth.rows.length)} 个，另有 ${num(growth.rowCount - growth.rows.length)} 个子目录单独记了数。` : "";
  const found = growth.roots.slice(0, VISIBLE_ROOTS).map((root) => `${label(root.root)}（${num(root.jobs)} 个作业）`).join("、");
  const foot = `<p class="du-note">${escapeHtml(more)}按登记的作业输出路径找到 ${escapeHtml(found)}。每 6 小时自动量一次各子目录的实际占用，磁盘占用涨 1 个百分点时提前量；只读，每轮最多 8 秒、一次最多 10 分钟，量不完会标出来。</p>`;
  return `${head}${notes}${table}${foot}`;
}
