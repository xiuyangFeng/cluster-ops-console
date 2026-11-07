// dir-usage-view.js —— 资源与负载面板「查看我的目录占用」展开区的 HTML（纯字符串函数，Node 可测）。
// 数据是 GET /api/dir-usage / POST /api/dir-usage/scan 的返回（后端 lib/dir-usage/model.mjs 已排好序）。
// 口径写在界面上：未扫完的数字只是「已扫描部分」，不是目录总量，也不是个人配额。
// 所有动态文案一律 escapeHtml；按钮只带 data-du-* 属性，由 app/dir-usage-controller.js 委托处理。
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";
import { clockOf, dayKeyOf } from "./usage-model.js";

const num = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("zh-CN") : "—");
const size = (n) => formatBytes(n, { compact: true });
const label = (root) => (root ? `~/${root}` : "~");

// 「10-06 14:20」，北京时间（usage-model.js）：这里显示的是集群上文件的修改时刻与扫描时刻，
// 要和在集群上 ls -l 看到的对得上，不随本机时区变。
function clockText(ts) {
  if (!Number.isFinite(ts)) return "";
  const day = dayKeyOf(ts / 1000);
  return `${Number(day.slice(5, 7))}-${day.slice(8)} ${clockOf(ts / 1000)}`;
}

// 覆盖范围一句话：扫完 / 未扫完（已扫描部分：N 个条目，覆盖 X 个目录）。
export function coverageText(scan) {
  const s = scan.scanned;
  if (scan.complete) return `已扫完 ${label(scan.root)}：${num(s.entries)} 个条目，${num(s.dirsDone)} 个目录。`;
  return `已扫描部分：${num(s.entries)} 个条目，覆盖 ${num(s.dirsDone)} 个目录；还有 ${num(s.pendingDirs)} 个目录未扫。`;
}

// 局限与跳过项（只列真实发生的）。
export function caveatTexts(scan) {
  const s = scan.scanned;
  const out = [];
  if (s.denied) out.push(`${num(s.denied)} 处无权限，已跳过`);
  if (s.errors) out.push(`${num(s.errors)} 处读取失败或扫描期间已变化，已跳过`);
  if (s.otherFs) out.push(`${num(s.otherFs)} 个目录在其他文件系统上，未计入${s.otherFsNames?.length ? `（${s.otherFsNames.slice(0, 3).join("、")}${s.otherFsNames.length > 3 ? " 等" : ""}）` : ""}`);
  if (s.dropped) out.push(`${num(s.dropped)} 个目录超出待扫列表上限，未纳入`);
  if (s.hardlinks) out.push(`${num(s.hardlinks)} 个硬链接重复项已去重`);
  return out;
}

// 自动续扫进行中的一句话：第几轮、扫了多少、最近一轮的速度、还剩多少目录。
export function autoProgressText(auto, scan) {
  if (auto?.stopping) return "正在停止（等这一轮扫完）…";
  const parts = [`正在自动扫描 · 第 ${num((auto?.rounds || 0) + 1)} 轮`];
  if (scan) {
    parts.push(`已扫 ${num(scan.scanned.entries)} 个条目`);
    const last = scan.lastRun;
    if (last && last.sec > 0 && last.entries > 0) parts.push(`约 ${num(Math.round(last.entries / last.sec))} 条/秒`);
    if (!scan.complete) parts.push(`还有 ${num(scan.scanned.pendingDirs)} 个目录待扫`);
  }
  return parts.join(" · ");
}

// 自动续扫停下来的原因（扫完不用另说，覆盖范围那句已经写了）。
export function autoEndText(auto) {
  if (!auto || auto.running) return "";
  if (auto.reason === "error") return `自动扫描停在第 ${num((auto.rounds || 0) + 1)} 轮：${auto.error || "原因未知"}。已扫到的部分都留着，可以点「继续扫描」。`;
  if (auto.reason === "limit") return "已连续扫描 3 小时，先停下了。点「继续扫描」接着扫。";
  return "";
}

function rowHtml(c, { busy }) {
  const partial = c.queued
    ? '<span class="du-partial" title="还没轮到这个目录，现在的数字只是目录项本身">未开始</span>'
    : c.partial ? '<span class="du-partial" title="这个目录下还有没扫到的子目录，数字只是已扫描部分">未扫完</span>' : "";
  const densityWarn = c.highFileDensity
    ? `<span class="du-partial du-inode-warn" title="该目录下包含 ${escapeHtml(num(c.files))} 个文件，高密度小文件易耗尽集群 Inode 配额并拖慢 ls/扫描，建议归档打包或清理">小文件密集</span>`
    : "";
  const scanBtn = `<button type="button" class="text-btn du-open" data-du-root="${escapeHtml(c.rel)}"${busy ? " disabled" : ""}>单独查看</button>`;
  const subs = (c.sub || []).map((s) => {
    const subDensity = s.highFileDensity
      ? `<span class="du-partial du-inode-warn" title="高密度小文件（${escapeHtml(num(s.files))} 个），易耗尽 Inode 配额">小文件密集</span>`
      : "";
    return (
      `<li class="du-row du-sub"><span class="du-name" title="${escapeHtml(label(s.rel))}">${escapeHtml(s.name)}${subDensity}</span>` +
      `<span class="du-num">${escapeHtml(size(s.blocks))}</span><span class="du-num du-wide">${escapeHtml(size(s.size))}</span>` +
      `<span class="du-num du-wide">${escapeHtml(num(s.files))}</span>` +
      `<span class="du-act"><button type="button" class="text-btn du-open" data-du-root="${escapeHtml(s.rel)}"${busy ? " disabled" : ""}>单独查看</button></span></li>`
    );
  }).join("");
  const rest = c.subRest && (c.subRest.blocks > 0 || c.subRest.dirs > 0)
    ? `<li class="du-row du-sub du-rest"><span class="du-name">其余（直接文件${c.subRest.dirs ? `及另外 ${num(c.subRest.dirs)} 个子目录` : ""}）</span>` +
      `<span class="du-num">${escapeHtml(size(c.subRest.blocks))}</span><span class="du-num du-wide">${escapeHtml(size(c.subRest.size))}</span><span class="du-num du-wide"></span><span class="du-act"></span></li>`
    : "";
  const body = subs || rest ? `<ul class="du-subs">${subs}${rest}</ul>` : "";
  const head =
    `<span class="du-name" title="${escapeHtml(label(c.rel))}">${escapeHtml(c.name)}${partial}${densityWarn}</span>` +
    `<span class="du-num">${escapeHtml(size(c.blocks))}</span><span class="du-num du-wide">${escapeHtml(size(c.size))}</span>` +
    `<span class="du-num du-wide">${escapeHtml(num(c.files))}</span><span class="du-act">${scanBtn}</span>`;
  // 有子目录明细才可展开；展开态由控制器在重绘前后保留（data-du-rel）。
  return body
    ? `<li class="du-item"><details data-du-rel="${escapeHtml(c.rel)}"><summary class="du-row">${head}</summary>${body}</details></li>`
    : `<li class="du-item"><div class="du-row du-leaf">${head}</div></li>`;
}

function savedHtml(data, busy) {
  const others = (data.saved || []).filter((s) => s.root !== data.root);
  if (!others.length) return "";
  return `<p class="du-saved">本机还保存了：${others.map((s) => (
    `<button type="button" class="text-btn" data-du-root="${escapeHtml(s.root)}"${busy ? " disabled" : ""}>${escapeHtml(label(s.root))}${s.complete ? "" : "（未扫完）"}</button>`
  )).join("")}</p>`;
}

// state：{ busy, loading, error }。data 为 null 表示还没读到本机结果。
export function buildDirUsageHtml(data, { busy = false, loading = false, error = "", now = Date.now() } = {}) {
  if (loading && !data) return '<p class="du-note">正在读取本机保存的结果…</p>';
  if (!data) return error ? `<p class="du-note" data-level="warn">${escapeHtml(error)}</p>` : "";
  if (data.eligible === false) return '<p class="du-note">这台服务器不提供目录占用扫描（只对团队集群开放）。</p>';
  const scan = data.scan;
  const root = data.root ?? "";
  // 后台正在自动续扫（可能是别的扫描根）：期间不给切换目录和再开扫描，只给「停止」。
  const auto = data.auto?.running ? data.auto : null;
  if (auto) busy = true;
  const up = root
    ? `<button type="button" class="text-btn" data-du-root="${escapeHtml(root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "")}"${busy ? " disabled" : ""}>上一级</button>`
    : "";
  const actions = [];
  if (auto) {
    actions.push(`<button type="button" class="text-btn du-primary" data-du-scan="stop"${auto.stopping ? " disabled" : ""}>停止</button>`);
  } else {
    if (scan && !scan.complete) actions.push(`<button type="button" class="text-btn du-primary" data-du-scan="continue"${busy ? " disabled" : ""}>继续扫描</button>`);
    actions.push(`<button type="button" class="text-btn${scan ? "" : " du-primary"}" data-du-scan="start"${busy ? " disabled" : ""}>${scan ? "重新扫描" : "开始扫描"}</button>`);
  }
  const elsewhere = auto && auto.root !== root ? `（${label(auto.root)}）` : "";
  const status = auto
    ? `<span class="du-busy">${escapeHtml(autoProgressText(auto, auto.root === root ? scan : null))}${escapeHtml(elsewhere)}</span>`
    : busy ? '<span class="du-busy">正在发起扫描…</span>' : "";
  const head =
    `<div class="du-head"><span class="du-root" title="${escapeHtml(scan?.home ? `${scan.home}${root ? `/${root}` : ""}` : label(root))}">${escapeHtml(label(root))}</span>${up}` +
    `<span class="du-actions">${status}${actions.join("")}</span></div>`;
  const ended = autoEndText(data.auto);
  const err = (error ? `<p class="du-note" data-level="warn">${escapeHtml(error)}</p>` : "") +
    (ended && data.auto.root === root ? `<p class="du-note" data-level="warn">${escapeHtml(ended)}</p>` : "");
  const rule = "点一次就一轮接一轮自动扫到完成（每轮最多 2 万个条目或 8 秒，中间歇 2 秒），可以随时停止，关掉这块面板也会继续；只读，不跟随符号链接、不跨文件系统。先扫名字不带点的目录，再扫隐藏目录。这里的扫描没有定时任务。";
  if (!scan) {
    return `${head}${err}<p class="du-note">${escapeHtml(label(root))} 还没有扫描过。${escapeHtml(rule)}</p>${savedHtml(data, busy)}`;
  }
  const last = scan.lastRun;
  const when = `扫描于 ${clockText(scan.updatedAt)}（${formatRelativeTime(scan.updatedAt, now) || "刚刚"}）· 共 ${num(scan.runs)} 轮${last && Number.isFinite(last.sec) ? ` · 上一轮 ${last.sec.toFixed(1)} 秒` : ""}`;
  const t = scan.totals;
  const totalLine = scan.complete
    ? `合计：实际占用 ${size(t.blocks)}，逻辑大小 ${size(t.size)}，${num(t.files)} 个文件。`
    : `已扫描部分合计：实际占用 ${size(t.blocks)}，逻辑大小 ${size(t.size)}，${num(t.files)} 个文件。这不是目录总量，也不是个人配额。`;
  const caveats = caveatTexts(scan);
  const summary =
    `<p class="du-coverage" data-complete="${scan.complete ? "true" : "false"}">${escapeHtml(coverageText(scan))}${escapeHtml(totalLine)}</p>` +
    `<p class="du-note">${escapeHtml(when)}${caveats.length ? ` · ${escapeHtml(caveats.join("；"))}` : ""}</p>`;
  const rf = scan.rootFiles;
  const rows = scan.children.map((c) => rowHtml(c, { busy })).join("");
  const restRow = scan.childrenRest.count || scan.childrenRest.overflow
    ? `<li class="du-item"><div class="du-row du-leaf du-rest"><span class="du-name">其余 ${num(scan.childrenRest.count)} 个目录${scan.childrenRest.overflow ? "及超出上限的条目" : ""}</span><span class="du-num">${escapeHtml(size(scan.childrenRest.blocks))}</span><span class="du-num du-wide">${escapeHtml(size(scan.childrenRest.size))}</span><span class="du-num du-wide"></span><span class="du-act"></span></div></li>`
    : "";
  const filesRow = rf.files
    ? `<li class="du-item"><div class="du-row du-leaf du-rest"><span class="du-name">直接位于 ${escapeHtml(label(root))} 的文件</span><span class="du-num">${escapeHtml(size(rf.blocks))}</span><span class="du-num du-wide">${escapeHtml(size(rf.size))}</span><span class="du-num du-wide">${escapeHtml(num(rf.files))}</span><span class="du-act"></span></div></li>`
    : "";
  const list = rows || restRow || filesRow
    ? `<div class="du-table"><div class="du-row du-th"><span class="du-name">目录（按实际占用）</span><span class="du-num">实际占用</span><span class="du-num du-wide">逻辑大小</span><span class="du-num du-wide">文件数</span><span class="du-act"></span></div><ul class="du-list">${rows}${restRow}${filesRow}</ul></div>`
    : '<p class="du-note">已扫描部分里还没有子目录或文件。</p>';
  const caches = Array.isArray(scan.knownCaches) && scan.knownCaches.length
    ? `<div class="du-files du-caches"><h4>常见缓存与环境占用（已扫描部分，按实际占用）</h4><ul>${scan.knownCaches.map((c) => {
      const warn = c.highFileDensity ? '<span class="du-partial du-inode-warn" title="高密度小文件，易耗尽 Inode 配额">小文件密集</span>' : "";
      const copyCmdBtn = c.cleanCmd
        ? `<button type="button" class="text-btn du-copy-cmd" data-du-copy-cmd="${escapeHtml(c.cleanCmd)}" title="复制清理命令：${escapeHtml(c.cleanCmd)}">复制清理命令</button>`
        : "";
      return `<li><span class="du-name" title="${escapeHtml(c.hint || "")}">${escapeHtml(label(c.rel))} · ${escapeHtml(c.label)}${warn}</span><span class="du-num">${escapeHtml(size(c.blocks))}</span><span class="du-num du-wide">${escapeHtml(num(c.files))} 个文件</span>${copyCmdBtn ? `<span class="du-act">${copyCmdBtn}</span>` : ""}</li>`;
    }).join("")}</ul></div>`
    : "";
  const files = scan.topFiles.length
    ? `<div class="du-files"><h4>最大的文件（已扫描部分，按实际占用）</h4><ul>${scan.topFiles.map((f) => (
      `<li><span class="du-name" title="${escapeHtml(label(f.rel))}">${escapeHtml(f.path)}</span><span class="du-num">${escapeHtml(size(f.blocks))}</span><span class="du-num du-wide du-mtime">${escapeHtml(f.mtime ? clockText(f.mtime * 1000) : "")}</span></li>`
    )).join("")}</ul></div>`
    : "";
  const foot = `<p class="du-note">实际占用 = 磁盘块（st_blocks × 512）；逻辑大小 = 文件长度之和。硬链接只在同一轮内去重；扫描期间目录有改动时，续扫结果可能有少量重复或遗漏。${escapeHtml(rule)}</p>`;
  return `${head}${err}${summary}${list}${caches}${files}${savedHtml(data, busy)}${foot}`;
}
