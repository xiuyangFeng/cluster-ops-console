// resources-model.js —— 服务器页「资源与负载」面板的纯模型（无 DOM，Node 可直接测）。
//
// 数据源优先级：layers.resources[id].usage（schema 1，T03 起的新采集口径）优先；
// usage 缺失（旧采集脚本）或某项为 null 时，回落解析 sys 段原文（hostname / uptime /
// free -h / df -h / nproc）。两条路都拿不到的指标诚实显示「未知」，绝不用 0 冒充已测。
//
// CPU 口径统一（修正此前 tile / sparkline / 历史三处口径不一）：
//   cpuBusyPct（/proc/stat 相邻两轮差分）→ 缺失时回落 loadNormalizedPct（load1/核数，
//   可 >100）→ 旧采集脚本回落 legacy cpu。tile 大字、实时曲线点、/api/metrics 历史
//   播种都经 pickCpuMetric 走同一条优先级链。
import { formatBytePair, formatBytes, formatClock, formatGb, formatRelativeTime } from "../store.js";
import { clampPct, finite, levelFor, RESOURCE_THRESHOLDS, worstLevel } from "../thresholds.js";

// 慢档采集节奏 60s；连续错过 3 次仍无新样本即视为数据陈旧。
export const RESOURCE_SAMPLE_INTERVAL_MS = 60_000;
export const RESOURCE_STALE_MS = 3 * RESOURCE_SAMPLE_INTERVAL_MS;

// ---- 旧版 sys 段文本解析 ----

// free -h / df -h 的 "251Gi" / "1.4T" / "642Mi" / "0" → 字节。无法识别返回 null（不猜）。
// 与后端 resource-usage.humanSizeToBytes 同一套后缀归一（前端拿不到 lib/，只能各持一份）。
export function parseHumanSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGTPE]?i?B?)$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const raw = match[2].toLowerCase();
  const suffix = raw.endsWith("ib") ? raw.slice(0, -2)
    : raw.endsWith("b") ? raw.slice(0, -1)
    : raw.endsWith("i") ? raw.slice(0, -1)
    : raw;
  const power = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 }[suffix];
  if (power === undefined) return null;
  return Math.round(value * 1024 ** power);
}

// 解析远端负载采样文本（hostname / uptime / free -h / df 输出拼接）。纯函数，便于测试。
// 返回渲染所需的全部字段；任何行缺失或格式畸形都回落默认值，不抛异常。
// 文本字段（cpuText/ramText/diskText 等）保持旧语义；结构化字段（*Bytes / disk）供面板模型使用。
export function parseRemoteLoad(output, fallbackHost = "-") {
  const text = String(output == null ? "" : output);
  const lines = text.split("\n");

  let hostname = fallbackHost;
  let uptime = "未知";
  let ramPercent = 0;
  let ramText = "未获取";
  let diskPercent = 0;
  let diskText = "未获取";
  let cpuPercent = 0;
  let cpuText = "未知";
  let cores = null;
  let load1 = null;
  let memUsedBytes = null;
  let memTotalBytes = null;
  let memAvailBytes = null;
  let disk = null;

  if (lines.length > 0) hostname = lines[0].trim();

  // v2.15 核数：后端命令追加的 "nproc: N" 标签行；老输出无此行 → cores=null 走回退。
  const nprocLine = lines.find((l) => /^nproc:\s*\d+\s*$/.test(l.trim()));
  if (nprocLine) {
    const n = parseInt(nprocLine.trim().slice("nproc:".length), 10);
    if (Number.isFinite(n) && n > 0) cores = n;
  }

  const uptimeLine = lines.find((l) => l.includes("up") && l.includes("load average"));
  if (uptimeLine) {
    const upIndex = uptimeLine.indexOf("up");
    const loadIndex = uptimeLine.indexOf("load average:");
    if (upIndex !== -1) {
      uptime = uptimeLine.substring(upIndex, loadIndex !== -1 ? loadIndex : uptimeLine.length).replace(/,\s*$/, "").trim();
    }
    if (loadIndex !== -1) {
      const loadPart = uptimeLine.substring(loadIndex);
      const match = loadPart.match(/load average:\s*([0-9.]+)/i);
      if (match) {
        load1 = parseFloat(match[1]);
        if (cores) {
          // 归一化：load1 / 核数。不封顶——>100% 是「过载」这一真实信号。
          cpuPercent = Math.round((load1 / cores) * 100);
          cpuText = `Load ${match[1]} / ${cores}核 (${cpuPercent}%)`;
        } else {
          // 老格式回退：无核数时保持既有语义（load1×100 封顶 100）。
          cpuPercent = Math.min(Math.round(load1 * 100), 100);
          cpuText = `Load: ${match[1]}`;
        }
      }
    }
  }

  const memLine = lines.find((l) => l.startsWith("Mem:"));
  if (memLine) {
    const parts = memLine.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      const totalStr = parts[1];
      const usedStr = parts[2];
      ramText = `${usedStr} / ${totalStr}`;
      const totalNum = parseFloat(totalStr);
      const usedNum = parseFloat(usedStr);
      if (totalNum > 0) {
        let totalVal = totalNum;
        let usedVal = usedNum;
        if (totalStr.toLowerCase().includes("g") && usedStr.toLowerCase().includes("m")) {
          usedVal = usedNum / 1024;
        } else if (totalStr.toLowerCase().includes("m") && usedStr.toLowerCase().includes("g")) {
          totalVal = totalNum / 1024;
        }
        ramPercent = Math.min(Math.round((usedVal / totalVal) * 100), 100);
        ramText += ` (${ramPercent}%)`;
      }
      memTotalBytes = parseHumanSize(totalStr);
      memUsedBytes = parseHumanSize(usedStr);
      // free 的第 7 列 available（内核估算的可用量，含可回收缓存）；老版本 free 没有该列。
      memAvailBytes = parts.length >= 7 ? parseHumanSize(parts[6]) : null;
    }
  }

  const diskLine = lines.find((l) => l.includes("%") && !l.startsWith("Mem:"));
  if (diskLine) {
    const percentMatch = diskLine.match(/(\d+)%/);
    if (percentMatch) {
      diskPercent = parseInt(percentMatch[1], 10);
      const parts = diskLine.split(/\s+/).filter(Boolean);
      const pIndex = parts.findIndex((p) => p.includes("%"));
      if (pIndex >= 2) {
        const usedStr = parts[pIndex - 2];
        const totalStr = parts[pIndex - 3];
        diskText = `${diskPercent}% (${usedStr} / ${totalStr})`;
      } else {
        diskText = `${diskPercent}%`;
      }
      // df -h 标准列：Filesystem Size Used Avail Use% Mounted on
      disk = {
        device: pIndex >= 4 ? parts[pIndex - 4] : null,
        totalBytes: pIndex >= 3 ? parseHumanSize(parts[pIndex - 3]) : null,
        usedBytes: pIndex >= 2 ? parseHumanSize(parts[pIndex - 2]) : null,
        availBytes: pIndex >= 1 ? parseHumanSize(parts[pIndex - 1]) : null,
        usedPct: diskPercent,
        mount: parts.length > pIndex + 1 ? parts.slice(pIndex + 1).join(" ") : null,
      };
    }
  }

  return {
    hostname, uptime, cpuPercent, cpuText, ramPercent, ramText, diskPercent, diskText, cores, load1,
    memUsedBytes, memTotalBytes, memAvailBytes, disk,
  };
}

// ---- 格式化 ----

// 资源面板的字节数一律紧凑口径（三位有效数字左右：≥100 取整、否则一位小数）。
const COMPACT = { compact: true };

// 单值：620 GiB / 153 GiB / 1.8 TiB；缺失显示「未知」。
export function formatSize(bytes) {
  const n = finite(bytes);
  return n == null || n < 0 ? "未知" : formatBytes(n, COMPACT);
}

// uptime 原文（"up 12 days,  3:42,  2 users" / "up 5 min" / "up 3:42"）→ 「已运行 12 天 3 小时」。
// 认不出的形态返回空串（宁可不显示，也不显示半截英文）。
export function formatUptime(text) {
  const t = String(text ?? "");
  if (!/\bup\b/.test(t)) return "";
  const days = /(\d+)\s+days?/.exec(t);
  const clock = /(\d+):(\d{2})/.exec(t);
  const hours = /(\d+)\s+(?:hrs?|hours?)\b/.exec(t);
  const mins = /(\d+)\s+min/.exec(t);
  const d = days ? Number(days[1]) : 0;
  const h = clock ? Number(clock[1]) : hours ? Number(hours[1]) : 0;
  const m = clock ? Number(clock[2]) : mins ? Number(mins[1]) : null;
  if (d > 0) return `已运行 ${d} 天${h > 0 ? ` ${h} 小时` : ""}`;
  if (h > 0) return `已运行 ${h} 小时${m ? ` ${m} 分` : ""}`;
  if (m != null) return `已运行 ${m} 分钟`;
  return "";
}

// "NVIDIA GeForce RTX 4090" → "RTX 4090"；"NVIDIA A100-SXM4-80GB" → "A100-SXM4-80GB"。
// 完整型号留给 title 悬停；行内只放能区分卡的短名。
export function shortGpuName(name) {
  const full = typeof name === "string" ? name.trim() : "";
  if (!full) return "";
  const short = full.replace(/^NVIDIA\s+/i, "").replace(/^(GeForce|Tesla)\s+/i, "").trim();
  return short || full;
}

// ---- 口径选择与环比 ----

// CPU 口径优先级（tile / 实时曲线点 / 历史播种共用）。kind 标明取到的是哪种口径：
// "busy" = 真实利用率；"load" = 归一化负载（利用率缺失时的估算，可 >100）。
export function pickCpuMetric({ busyPct = null, loadNormalizedPct = null, legacyLoadPct = null } = {}) {
  const busy = finite(busyPct);
  if (busy != null) return { value: busy, kind: "busy" };
  const load = finite(loadNormalizedPct);
  if (load != null) return { value: load, kind: "load" };
  const legacy = finite(legacyLoadPct);
  if (legacy != null) return { value: legacy, kind: "load" };
  return { value: null, kind: null };
}

// /api/metrics 单条历史样本 → 三条曲线的值（未知返回 null，由图表层跳过该点）。
// 旧采集脚本的样本（无 metricSchemaVersion）只有 legacy cpu（归一化负载，后端封顶 100）；
// 新样本 busy/load 都缺时不回落 legacy cpu，免得把两种口径混进一条曲线。
export function metricSampleValues(sample) {
  const s = sample && typeof sample === "object" ? sample : {};
  const legacyOnly = s.metricSchemaVersion == null;
  return {
    cpu: pickCpuMetric({
      busyPct: s.cpuBusyPct,
      loadNormalizedPct: s.loadNormalizedPct,
      legacyLoadPct: legacyOnly ? s.cpu : null,
    }).value,
    ram: finite(s.ram),
    disk: finite(s.disk),
  };
}

// 环比方向（纯函数，便于测试）：与上一采样比较，±epsilon 内视为持平。
// prev/curr 任一非有限数（如首个采样无历史）返回 null → 渲染层不显示箭头。
export function trendDirection(prev, curr, epsilon = 0.5) {
  if (prev == null || curr == null) return null; // Number(null)===0，必须先挡空值
  const p = Number(prev);
  const c = Number(curr);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  const d = c - p;
  if (d > epsilon) return "up";
  if (d < -epsilon) return "down";
  return "flat";
}

// 环比徽标：持平不显示（减少噪声）；两次采样口径不同（busy↔load）时不比较。
export function buildDelta(prev, curr) {
  const dir = trendDirection(prev, curr);
  if (!dir || dir === "flat") return null;
  const d = Number(curr) - Number(prev);
  const abs = Math.abs(d);
  const text = abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
  return {
    dir,
    text: `${dir === "up" ? "↑" : "↓"} ${text}`,
    title: `较上一采样 ${d > 0 ? "+" : "−"}${text} 个百分点`,
  };
}

// ---- 占用现场（layer.procTop：slow 采集的 proc-top 段，lib/collector.parseProcTop）----
// 谁在用 CPU / 内存、是不是 Slurm 作业。口径：远端取 %CPU 与常驻内存最高的几十个进程按账号汇总，
// 不是全部进程的合计；%CPU 是 ps 的口径（进程启动以来的平均值，100% = 一个核）。
// 只有账号名与汇总数字。procTop.slurm 为假（这台机器分不出作业内外）时不写「不经 Slurm」。

// 行内那一句的引导词。写「占用：」而不是「占用最多：」：三列布局下一块只有约 250px，省下的宽度留给第二项。
const OCCUPANCY_LABEL = "占用：";
const OCCUPANCY_KIND_LABELS = { job: "Slurm 作业", other: "不经 Slurm" };
// 悬停提示里最多列几项（行内固定写占用最大的两项）
const OCCUPANCY_LIST_MAX = 6;
// 比最大那一项小到这个比例以下的不列（1449% 旁边的 3% 只是噪声）；另有绝对下限：CPU 1%、内存 64 MiB。
const OCCUPANCY_MIN_SHARE = 0.05;
const OCCUPANCY_MIN_ABS = { cpu: 1, memory: 64 * 1024 };

// 按「账号 × 作业内 / 作业外」拆成条目，从大到小排。metric: "cpu"（value 是 %CPU）| "memory"（value 是 KB）。
export function occupancyEntries(procTop, metric) {
  const cpu = metric === "cpu";
  const split = procTop?.slurm === true;
  const entries = [];
  for (const u of Array.isArray(procTop?.users) ? procTop.users : []) {
    if (!u || typeof u.user !== "string" || !u.user) continue;
    const parts = [
      { kind: "job", value: finite(cpu ? u.cpuJobPct : u.rssJobKb) ?? 0, procs: finite(u.procsJob) ?? 0 },
      { kind: "other", value: finite(cpu ? u.cpuOtherPct : u.rssOtherKb) ?? 0, procs: finite(u.procsOther) ?? 0 },
    ];
    if (split) entries.push(...parts.map((part) => ({ user: u.user, ...part })));
    else entries.push({ user: u.user, kind: null, value: parts[0].value + parts[1].value, procs: parts[0].procs + parts[1].procs });
  }
  entries.sort((a, b) => b.value - a.value);
  const floor = Math.max((entries[0]?.value ?? 0) * OCCUPANCY_MIN_SHARE, OCCUPANCY_MIN_ABS[cpu ? "cpu" : "memory"]);
  return entries.filter((entry) => entry.value >= floor);
}

function occupancyValueText(entry, metric) {
  if (metric !== "cpu") return formatSize(entry.value * 1024);
  return `${entry.value >= 10 ? Math.round(entry.value) : Math.round(entry.value * 10) / 10}%`;
}

// 「不经 Slurm」的那一类：账号自己不经调度直接跑的。root 的系统进程本来就不走 Slurm，不算在内、也不挂这个标记。
const isBypass = (entry) => entry.kind === "other" && entry.user !== "root";

// 条目的数值与标注（不含账号名）：「554%（不经 Slurm）」。
// full（悬停提示里的完整排名）两种标注都写；行内那一句（full 为假）只给不经 Slurm 的挂标注——在 Slurm
// 作业里是常态，行内只写「kai 1449%」，把那一行的地方留给需要留意的条目。
function occupancyValueWithKind(entry, metric, full) {
  const kind = isBypass(entry) || (full && entry.kind === "job") ? OCCUPANCY_KIND_LABELS[entry.kind] : "";
  return `${occupancyValueText(entry, metric)}${kind ? `（${kind}）` : ""}`;
}

// 「lin 554%（不经 Slurm）」。
const occupancyEntryText = (entry, metric, full = true) => `${entry.user} ${occupancyValueWithKind(entry, metric, full)}`;

// 用间隔号连起来；前一段以全角括号结尾时括号后不再空格（「（不经 Slurm）· kai」，与界面其它地方的写法一致）。
const joinWithDot = (parts) => parts.reduce((text, part) => (text ? `${text}${text.endsWith("）") ? "" : " "}· ${part}` : part), "");

// 占用现场的几种写法；没有数据（旧采集脚本 / 远端 ps 不可用 / 都低于下限）→ null。
//   text   行内那一句：「占用：kai 1449% · lin 554%（不经 Slurm）」——占用最大的两项，严格按占用从大到小
//          （不把不经 Slurm 的往前提：窗口窄、只显示得下第一项时，留下的必须是最大的那一位）；只给不经 Slurm
//          的挂标注。资源面板那一行与注意力队列的悬停提示用的是同一句。
//   label / first / second  同一句拆开给资源面板排版用：text === label + first.name + " " + first.value + second。
//          second 是字符串，带前面的间隔号，没有第二项为空串。两项各是一个整体：第二项放不下时整项不显示，
//          第一项放不下时只收账号名（resources-view.occupancyHtml + tiles.css），数字不会被截掉一半。
//   title  多行明细（悬停提示）：首行「占用最多 · …按账号汇总」，再按占用从大到小列最多 OCCUPANCY_LIST_MAX 项，
//          两种标注都写。
export function buildOccupancy(procTop, metric) {
  const entries = occupancyEntries(procTop, metric);
  if (!entries.length) return null;
  const sampled = finite(procTop?.sampled);
  const lines = [
    `占用最多 · ${sampled != null && sampled > 0 ? `CPU 与内存最高的 ${sampled} 个进程按账号汇总` : "按账号汇总"}`,
    ...entries.slice(0, OCCUPANCY_LIST_MAX).map((entry) => joinWithDot([occupancyEntryText(entry, metric), ...(entry.procs > 0 ? [`${entry.procs} 个进程`] : [])])),
    metric === "cpu" ? "百分比是进程启动以来的平均值，100% 相当于一个核" : "按常驻内存计",
  ];
  const [first, second] = entries;
  const firstValue = occupancyValueWithKind(first, metric, false);
  // 间隔号跟着第二项走（它不显示时间隔号也不留）；前一项以全角括号结尾时括号后不再空格，同 joinWithDot
  const secondText = second ? `${firstValue.endsWith("）") ? "" : " "}· ${occupancyEntryText(second, metric, false)}` : "";
  return {
    text: `${OCCUPANCY_LABEL}${first.user} ${firstValue}${secondText}`,
    title: lines.join("\n"),
    label: OCCUPANCY_LABEL,
    first: { name: first.user, value: firstValue },
    second: secondText,
  };
}

// 挂到 tile 上：平时只进悬停提示（hint）；档位到「警告」及以上时多一行小字（occupancy）。就地改 tile。
function attachOccupancy(tile, occupancy) {
  if (!occupancy || tile.value == null) return;
  tile.hint = occupancy.title;
  if (tile.level === "warn" || tile.level === "critical") tile.occupancy = occupancy;
}

// ---- 面板模型 ----

function buildTile({ key, title, metric = null, level, qualifier = "", details = [], note = "", emptyText }) {
  const has = metric != null;
  return {
    key,
    title,
    qualifier: has ? qualifier : "",
    level: has ? level : "unknown",
    value: has ? metric : null,
    display: has ? String(Math.round(metric)) : emptyText,
    unit: has ? "%" : "",
    gauge: has ? clampPct(metric) : 0,
    delta: null,
    details: details.filter(Boolean),
    note,
    // 占用现场（只有 CPU / 内存两块会有，见 attachOccupancy）：hint 是标题与大字上的悬停提示，
    // occupancy 是告警档才出现的那一行（buildOccupancy 的结果）。
    hint: "",
    occupancy: null,
  };
}

const CPU_QUALITY_NOTES = {
  insufficient: "利用率需两次采样，暂以负载估算",
  reset: "采样计数已重置，暂以负载估算",
};

function buildCpuTile({ usage, legacy, emptyText, uptimeText }) {
  const c = usage?.cpu && typeof usage.cpu === "object" ? usage.cpu : null;
  const load1 = finite(c?.load1) ?? finite(legacy?.load1);
  const coresRaw = finite(c?.logicalCores) ?? finite(legacy?.cores);
  const cores = coresRaw != null && coresRaw > 0 ? coresRaw : null;
  // 旧格式无核数时 legacy cpuPercent 是 load1×100，并非百分比口径 → 不拿来当值。
  const legacyLoadPct = !c && legacy && cores != null && load1 != null ? (load1 / cores) * 100 : null;
  const pick = pickCpuMetric({
    busyPct: c?.busyPct,
    loadNormalizedPct: c?.loadNormalizedPct,
    legacyLoadPct,
  });
  let loadLine = "";
  if (load1 != null) loadLine = `负载 ${load1.toFixed(2)} · ${cores != null ? `${cores} 核` : "核数未知"}`;
  else if (cores != null) loadLine = `${cores} 核`;
  const note = pick.kind === "load"
    ? (CPU_QUALITY_NOTES[c?.quality] || "暂以负载估算")
    : "";
  const tile = buildTile({
    key: "cpu",
    title: "CPU",
    metric: pick.value,
    level: levelFor("cpu", pick.value),
    qualifier: pick.kind === "busy" ? "利用率" : "负载估算",
    details: [loadLine, uptimeText],
    note,
    emptyText,
  });
  return { tile, kind: pick.kind };
}

function buildMemoryTile({ usage, legacy, emptyText }) {
  const m = usage?.memory && typeof usage.memory === "object" ? usage.memory : null;
  const used = finite(m?.usedBytes) ?? finite(legacy?.memUsedBytes);
  const total = finite(m?.totalBytes) ?? finite(legacy?.memTotalBytes);
  let pct = used != null && total != null && total > 0 ? clampPct((used / total) * 100) : null;
  // 字节解析失败（free 老输出的非标准后缀）时，旧文本解析的百分比仍可用。
  if (pct == null && legacy && legacy.ramText !== "未获取" && /\(\d+%\)$/.test(legacy.ramText)) pct = legacy.ramPercent;
  // "可用"优先取 free 的 available 列（含可回收缓存，与内核口径一致），没有才用 total-used。
  const avail = finite(legacy?.memAvailBytes) ?? (used != null && total != null ? Math.max(0, total - used) : null);
  const pair = formatBytePair(used, total, COMPACT);
  const details = [pair, pair && avail != null ? `可用 ${formatSize(avail)}` : ""];
  return buildTile({
    key: "memory",
    title: "内存",
    metric: pct,
    level: levelFor("memory", pct),
    details,
    emptyText,
  });
}

function buildDiskTile({ usage, legacy, emptyText }) {
  const fs = usage?.filesystem && typeof usage.filesystem === "object" ? usage.filesystem : null;
  const ld = legacy?.disk || null;
  const used = finite(fs?.usedBytes) ?? finite(ld?.usedBytes);
  const total = finite(fs?.totalBytes) ?? finite(ld?.totalBytes);
  const avail = finite(fs?.availBytes) ?? finite(ld?.availBytes);
  // df 的 capacity 是"可用空间口径"原值，优先于 used/total 自算（保留块会让两者不同）。
  let pct = finite(fs?.usedPct) ?? finite(ld?.usedPct);
  if (pct == null && used != null && total != null && total > 0) pct = (used / total) * 100;
  if (pct != null) pct = clampPct(pct);
  const inode = finite(fs?.inodeUsedPct);
  const mount = (typeof fs?.mountpoint === "string" && fs.mountpoint) || (typeof ld?.mount === "string" && ld.mount) || "";
  const pair = formatBytePair(used, total, COMPACT);
  const sizeLine = pair ? `${pair}${avail != null ? ` · 剩余 ${formatSize(avail)}` : ""}` : "";
  // inode 平时不占版面；逼近告警线才出现（inode 满了同样写不进文件）。
  const inodeHigh = inode != null && inode >= RESOURCE_THRESHOLDS.disk.warn;
  const inodeLine = inodeHigh ? `inode ${Math.round(inode)}%` : "";
  // T11 之前个人配额恒为未知：df 统计的是 $HOME 所在共享卷，不能说成个人剩余空间。
  // 挂载点并在这行注释里（「共享卷 /public（$HOME 所在）」），明细行腾给走势判断与范围高低值。
  const quotaState = usage?.quota && typeof usage.quota === "object" ? usage.quota.state : "unknown";
  const quotaUnknown = quotaState === "unknown" || quotaState == null;
  const note = quotaUnknown
    ? `共享卷${mount ? ` ${mount}` : ""}（$HOME 所在）· 个人配额未知`
    : mount ? `挂载点 ${mount}` : "";
  return buildTile({
    key: "disk",
    title: "磁盘",
    metric: pct,
    level: worstLevel(levelFor("disk", pct), inode != null && pct != null ? levelFor("disk", inode) : "unknown"),
    details: [sizeLine, inodeLine],
    note,
    emptyText,
  });
}

// 占用者带的作业明细（v2.62，lib/gpu-cards.attachGpuUsers）：只有采集账号自己、且进程在 Slurm 作业里时才有。
function gpuUserJobs(user) {
  return (Array.isArray(user?.jobs) ? user.jobs : []).filter((job) => job && typeof job.id === "string" && job.id);
}

// 占用者一行：按显存从大到小（采集已按属主合并、剔除 MPS 守护进程），最多列 2 个，其余并成「等 N 人」。
// 显存为空表示属主进程没上报显存；没有占用进程且显存几乎为空 → 空闲。
// 这张卡只有自己在用、且分得出作业时写成「kai · 3 个作业」（各作业的显存在整行的悬停提示里，见 gpuJobLines）。
// 与别人合用的卡仍写各自的显存——这一格只有约 84px，合用时谁占了多少更要紧，作业明细照样在悬停提示里。
export function gpuOwnerText(users, { idle = false } = {}) {
  const list = (Array.isArray(users) ? users : []).filter((u) => u && typeof u.user === "string" && u.user);
  if (!list.length) return idle ? "空闲" : "没有计算进程";
  const soleJobs = list.length === 1 ? gpuUserJobs(list[0]) : [];
  if (soleJobs.length) return `${list[0].user} · ${soleJobs.length} 个作业`;
  const head = list.slice(0, 2).map((u) => (finite(u.memMb) != null ? `${u.user} ${formatGb(u.memMb)} GB` : u.user));
  return list.length > 2 ? `${head.join(" · ")} 等 ${list.length} 人` : head.join(" · ");
}

// 悬停提示里的作业明细，一个作业一行：作业号、作业名（取自队列快照，查不到就只写作业号）、显存。
// 自己在这张卡上还有不在作业里的进程时单列一行。作业多于 GPU_JOB_LINES_MAX 个时其余并成一行。
export const GPU_JOB_LINES_MAX = 8;
const mbText = (mb) => (finite(mb) != null ? `${formatGb(mb)} GB` : "显存未知");

export function gpuJobLines(users, jobNames = null) {
  const lines = [];
  for (const u of Array.isArray(users) ? users : []) {
    const jobs = gpuUserJobs(u);
    if (!jobs.length) continue;
    lines.push(`${u.user} 在这张卡上的 ${jobs.length} 个作业：`);
    for (const job of jobs.slice(0, GPU_JOB_LINES_MAX)) {
      const name = typeof jobNames?.get === "function" ? jobNames.get(job.id) : "";
      lines.push(`${job.id}${name ? ` ${name}` : ""} · ${mbText(job.memMb)}`);
    }
    const rest = jobs.slice(GPU_JOB_LINES_MAX);
    if (rest.length) lines.push(`另有 ${rest.length} 个作业 · ${mbText(rest.reduce((sum, job) => sum + (finite(job.memMb) ?? 0), 0))}`);
    // 合计减去各作业 = 不经 Slurm 直接跑的那部分（不足 1 MiB 的差值只是取整）
    const loose = (finite(u.memMb) ?? 0) - jobs.reduce((sum, job) => sum + (finite(job.memMb) ?? 0), 0);
    if (loose >= 1) lines.push(`不在作业里的进程 · ${mbText(loose)}`);
  }
  return lines;
}

// 队列快照（layer.slurm.jobs）→ 作业号 → 作业名。快照最多 300 条，查不到的作业只显示作业号。
export function slurmJobNames(slurm) {
  const names = new Map();
  for (const job of Array.isArray(slurm?.jobs) ? slurm.jobs : []) {
    if (job && typeof job.id === "string" && typeof job.name === "string" && job.name) names.set(job.id, job.name);
  }
  return names;
}

// 逐卡模型 + 摘要（服务器页 GPU 区与概览服务器卡的 GPU 行共用）。
// jobNames（作业号 → 作业名的 Map，可不给）只用来给悬停提示里的作业明细补名字。
export function buildGpuModel(rawGpu, { jobNames = null } = {}) {
  const list = Array.isArray(rawGpu) ? rawGpu : [];
  const cards = [];
  list.forEach((card, i) => {
    if (!card || typeof card !== "object") return;
    const index = finite(card.index) ?? i;
    const fullName = typeof card.name === "string" ? card.name.trim() : "";
    const util = finite(card.util);
    const used = finite(card.memUsedMb);
    const total = finite(card.memTotalMb);
    const hasMem = used != null && total != null && total > 0;
    const memPct = hasMem ? clampPct((used / total) * 100) : null;
    const utilPct = util != null ? Math.round(clampPct(util)) : null;
    const memText = hasMem ? `${formatGb(used)} / ${formatGb(total)} GB` : "显存未知";
    const tempC = finite(card.tempC);
    const powerW = finite(card.powerW);
    const isIdle = utilPct != null && utilPct <= 5 && memPct != null && memPct < 10;
    const users = Array.isArray(card.users) ? card.users : [];
    const summaryLine = [
      `#${index}${fullName ? ` ${fullName}` : ""}`,
      `利用率 ${utilPct == null ? "未知" : `${utilPct}%`}`,
      `显存 ${memText}`,
      tempC != null ? `温度 ${Math.round(tempC)}°C` : "",
      powerW != null ? `功耗 ${powerW} W` : "",
      users.length ? `占用 ${users.map((u) => `${u.user}${finite(u.memMb) != null ? ` ${formatGb(u.memMb)} GB` : ""}`).join("、")}` : "",
    ].filter(Boolean).join(" · ");
    cards.push({
      index,
      name: shortGpuName(fullName) || `GPU ${index}`,
      fullName,
      util: utilPct,
      memUsedMb: hasMem ? used : null,
      memTotalMb: hasMem ? total : null,
      memPct: memPct == null ? null : Math.round(memPct),
      memLevel: levelFor("gpuMemory", memPct),
      memText,
      tempC,
      powerW,
      // 底行：谁在用 + 温度功耗（老采集脚本没有这些字段时整行不显示）。
      ownerText: gpuOwnerText(users, { idle: isIdle }),
      envText: [tempC != null ? `${Math.round(tempC)}°C` : "", powerW != null ? `${Math.round(powerW)} W` : ""].filter(Boolean).join(" · "),
      hasFoot: users.length > 0 || tempC != null || powerW != null,
      figures: `${utilPct == null ? "利用率未知" : `${utilPct}%`} · ${memText}`,
      // 整行的悬停提示：第一行是这张卡的全部读数；自己的占用分得出作业时，下面一个作业一行
      title: [summaryLine, ...gpuJobLines(users, jobNames)].join("\n"),
    });
  });
  if (!cards.length) return { cards, summary: null };

  const utils = cards.map((c) => c.util).filter((u) => u != null);
  const withMem = cards.filter((c) => c.memTotalMb != null);
  const usedTotal = withMem.reduce((sum, c) => sum + c.memUsedMb, 0);
  const memTotal = withMem.reduce((sum, c) => sum + c.memTotalMb, 0);
  // 空闲卡：几乎没有计算（≤5%）且显存基本未占（<10%，驱动常驻的几百 MB 不算占用）。
  const idle = cards.filter((c) => c.util != null && c.util <= 5 && c.memPct != null && c.memPct < 10).length;
  const names = new Set(cards.map((c) => c.name));
  const temps = cards.map((c) => c.tempC).filter((t) => t != null);
  const powers = cards.map((c) => c.powerW).filter((p) => p != null);
  const summary = {
    count: cards.length,
    model: names.size === 1 ? cards[0].name : "",
    avgUtil: utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
    memText: memTotal > 0 ? `${formatGb(usedTotal)} / ${formatGb(memTotal)} GB` : "",
    idle,
    maxTemp: temps.length ? Math.round(Math.max(...temps)) : null,
    totalPowerW: powers.length ? powers.reduce((a, b) => a + b, 0) : null,
  };
  return { cards, summary };
}

// 直连节点（slurm 快照里 source=direct 且可达的机器，如 node04：不在 Slurm 分区里、从登录节点跳采）的 GPU 原始卡列表。
// 卡的字段与本机 gpu 段同一格式（lib/gpu-cards.mjs），可以直接交给 buildGpuModel。
export function directGpuNodes(slurm) {
  return (Array.isArray(slurm?.nodes) ? slurm.nodes : [])
    .filter((n) => n && n.source === "direct" && n.reachable !== false && typeof n.name === "string"
      && Array.isArray(n.gpus?.cards) && n.gpus.cards.length > 0)
    .map((n) => ({ node: n.name, cards: n.gpus.cards }));
}

// 服务器页 GPU 区：本机（登录节点）一组 + 每个直连节点一组；cards / summary 是全部卡的合计
// （只有一组时与 v2.52 之前一模一样）。key：走势数据里取哪份（"" = 本机 gpuUtil，节点名 = nodeGpuUtil[节点]）。
export function buildGpuGroups(rawLocal, slurm, hostLabel = "") {
  const groups = [];
  const raw = [];
  // 作业名取现有的队列快照（同一轮 slow 采集的 slurm 段），不另外查
  const jobNames = slurmJobNames(slurm);
  const local = buildGpuModel(rawLocal, { jobNames });
  if (local.cards.length) {
    groups.push({ key: "", label: hostLabel || "本机", direct: false, ...local });
    raw.push(...rawLocal);
  }
  for (const { node, cards } of directGpuNodes(slurm)) {
    const m = buildGpuModel(cards, { jobNames });
    if (!m.cards.length) continue;
    groups.push({ key: node, label: node, direct: true, ...m });
    raw.push(...cards);
  }
  if (groups.length <= 1) return { cards: groups[0]?.cards || [], summary: groups[0]?.summary || null, groups };
  const all = buildGpuModel(raw);
  return { cards: groups.flatMap((g) => g.cards), summary: { ...all.summary, nodes: groups.length }, groups };
}

// 新鲜度胶囊的共用骨架（资源面板与集群面板都随 60s 慢档采集刷新）：「采样于 X」文案、
// 悬停 title（采样时刻 / 最近尝试 / 节奏说明），以及两种结论——
//   failed(reason, emptyText)：本轮采集失败，有旧数据时报「采集失败 · 数据采于 X」；
//   current(emptyText)：从未采到 / 超过 3 个采样周期的「数据较旧」/ 正常。
// attemptAt 只在调用方认为值得显示时传（非空即写进 title）。
export function freshnessParts({ dataAt, attemptAt = null, cadence, now }) {
  const rel = dataAt != null ? formatRelativeTime(dataAt, now) : "";
  const sampled = dataAt == null ? "" : rel === "刚刚" ? "刚刚采样" : `采样于 ${rel}`;
  const titleParts = [];
  if (dataAt != null) titleParts.push(`采样时间 ${formatClock(dataAt)}`);
  if (attemptAt != null) titleParts.push(`最近尝试 ${formatClock(attemptAt)}`);
  titleParts.push(cadence);
  const title = (...lead) => [...lead, ...titleParts].join(" · ");
  return {
    title,
    failed: (reason, emptyText = "采集失败") => ({
      level: "error",
      text: sampled ? `采集失败 · 数据${sampled.replace(/^采样/, "采")}` : emptyText,
      title: title(reason),
    }),
    current: (emptyText = "尚未采样") => {
      if (dataAt == null) return { level: "unknown", text: emptyText, title: title() };
      if (now - dataAt > RESOURCE_STALE_MS) {
        return { level: "warn", text: `数据较旧 · ${sampled}`, title: title("超过 3 个采样周期没有新数据") };
      }
      return { level: "ok", text: sampled, title: title() };
    },
  };
}

// 采样节奏的说明。服务器 SSH 连不上、探测已放慢（layer.backoff，由 app/render-pipeline.js 从
// /api/status.probeBackoff 附上）时不再是 60 秒一轮，如实写下次探测的时刻。
export function resourceCadenceText(backoff) {
  const next = backoff?.nextProbeAt;
  if (typeof next !== "number" || !Number.isFinite(next)) return "每 60 秒采样一次";
  return `服务器连不上，探测已放慢 · 下次 ${formatClock(next, { locale: "zh-CN", hour12: false })}`;
}

function buildFreshness({ layer, loadFailed, dataAt, attemptAt, hasData, now }) {
  const reason = typeof layer?.reason === "string" ? layer.reason : "";
  const f = freshnessParts({ dataAt, attemptAt: attemptAt !== dataAt ? attemptAt : null, cadence: resourceCadenceText(layer?.backoff), now });
  if (layer?.level === "error" || loadFailed) {
    return f.failed(reason || "负载探测失败", hasData ? "采集失败 · 显示上次数据" : "采集失败");
  }
  if (layer?.level === "skipped") return { level: "unknown", text: "采样已暂停", title: f.title(reason || "探针已跳过") };
  return f.current(hasData ? "采样时间未知" : "尚未采样");
}

// 从没采到过数据时面板该说什么：wait = 还在等第一次采样；error = 一直没采到且最近一次失败（带原因）；
// 采到过数据（哪怕已过时 / 本轮失败）一律 null——旧数据照常显示，由新鲜度胶囊说明。
// 采样暂停（探针被门控跳过）也是 null：胶囊已写「采样已暂停」，不算在等。
function firstSampleState({ hasData, layer, remoteLoad }) {
  if (hasData) return null;
  if (layer?.level === "error" || remoteLoad?.ok === false) {
    return { state: "error", reason: typeof layer?.reason === "string" ? layer.reason : "" };
  }
  if (layer?.level === "skipped") return null;
  return { state: "wait" };
}

// 面板模型（纯函数）。layer = status.layers.resources[activeServerId]（可能缺失/残缺）；
// remoteLoad = status.remoteLoad（{ ok, output }，旧通路）；host = 回退主机名；
// prev = 上一采样的 sample（{ cpu, cpuKind, ram, disk }），给了就附带环比。
export function buildResourcePanelModel({ layer = null, remoteLoad = null, host = "-", now = Date.now(), prev = null } = {}) {
  const lay = layer && typeof layer === "object" ? layer : null;
  const usage = lay?.usage && typeof lay.usage === "object" ? lay.usage : null;
  const output = (typeof remoteLoad?.output === "string" && remoteLoad.output) || (typeof lay?.output === "string" && lay.output) || "";
  const legacy = output ? parseRemoteLoad(output, host) : null;
  const hasData = Boolean(usage || legacy);
  // 旧通路 ok:false 且仍带着上次输出 = 本轮采集失败、显示的是残留数据。
  const loadFailed = remoteLoad?.ok === false && Boolean(output);
  const usageAt = finite(usage?.checkedAt);
  const attemptAt = finite(lay?.checkedAt);
  // 数据时刻：usage.checkedAt 是成功采到的那一刻；层的 checkedAt 是最近一次尝试，
  // 只有本轮成功时两者才可互换。
  const dataAt = usageAt ?? (lay?.level !== "error" && !loadFailed ? attemptAt : null);
  const emptyText = hasData ? "未知" : "未采集";

  const uptimeText = legacy ? formatUptime(legacy.uptime) : "";
  const { tile: cpu, kind: cpuKind } = buildCpuTile({ usage, legacy, emptyText, uptimeText });
  const memory = buildMemoryTile({ usage, legacy, emptyText });
  const disk = buildDiskTile({ usage, legacy, emptyText });
  if (!hasData) {
    for (const t of [cpu, memory, disk]) t.details = ["等待首次采样"];
    disk.note = "";
  }
  // v2.62 占用现场：谁在用、是不是 Slurm 作业（与三块指标同一轮 slow 采集）。
  const procTop = lay?.procTop && typeof lay.procTop === "object" ? lay.procTop : null;
  attachOccupancy(cpu, buildOccupancy(procTop, "cpu"));
  attachOccupancy(memory, buildOccupancy(procTop, "memory"));

  const hostName = (legacy?.hostname || "").trim() || host || "-";
  const model = {
    host: hostName,
    hasData,
    firstSample: firstSampleState({ hasData, layer: lay, remoteLoad }),
    dataAt,
    freshness: buildFreshness({ layer: lay, loadFailed, dataAt, attemptAt, hasData, now }),
    tiles: { cpu, memory, disk },
    gpu: buildGpuGroups(lay?.gpu, lay?.slurm, hostName === "-" ? "" : hostName),
    sample: { cpu: cpu.value, cpuKind, ram: memory.value, disk: disk.value },
  };
  return prev ? withSampleDeltas(model, prev) : model;
}

// ---- 趋势注记（范围内高低值、磁盘走势）----

const DAY_MS = 24 * 60 * 60 * 1000;

function percentPerDay(slope) {
  return slope < 0.1 ? slope.toFixed(2) : slope.toFixed(1);
}

// 磁盘走势一句话（纯函数）。series = 近 7 天的磁盘占用序列（{ values, ts }，/api/metrics/range 的小时均值）；
// current = 当前读数。口径同今日简报的磁盘提醒（lib/brief/service.mjs diskTrend、model.mjs conditionNotes）：
// 最小二乘斜率 > 0.05%/天才算在涨，90 天以内写得满才给天数。数据不足两天不下结论（返回空串）。
export function diskOutlook(series, current) {
  const now = finite(current);
  const ts = series?.ts || [];
  const values = series?.values || [];
  if (now == null || ts.length < 10) return "";
  const spanDays = (ts[ts.length - 1] - ts[0]) / DAY_MS;
  if (spanDays < 2) return "";
  const label = `近 ${spanDays >= 6.5 ? 7 : Math.max(2, Math.round(spanDays))} 天`;
  const xs = ts.map((t) => (t - ts[0]) / DAY_MS);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = values.reduce((a, b) => a + b, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (values[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  if (slope > 0.05) {
    const daysToFull = (100 - now) / slope;
    const pace = daysToFull <= 90 ? `按这个速度约 ${Math.max(1, Math.round(daysToFull))} 天写满` : "按这个速度三个月内写不满";
    return `${label}每天约涨 ${percentPerDay(slope)}%，${pace}`;
  }
  const from = Math.round(values[0]);
  const to = Math.round(now);
  if (to - from <= -1) return `${label} ${from}% → ${to}%，在下降，暂无写满风险`;
  return `${label}基本持平`;
}

// 「24 小时内 86–93%」：把当前读数也算进去（长范围画的是分桶均值，最新一桶会把刚发生的变化抹平）。
function rangeNoteText(label, extent, current) {
  if (!extent || current == null) return "";
  const lo = Math.round(Math.min(extent.lo, current));
  const hi = Math.round(Math.max(extent.hi, current));
  return lo === hi ? `${label}内稳定在 ${lo}%` : `${label}内 ${lo}–${hi}%`;
}

// 把趋势注记挂到三块 tile 的明细行上（纯函数，返回新模型，不改入参）。
//   trend = { label, extents: { cpu, ram, disk }, diskWeek }——label 是当前趋势范围（「24 小时」）；
//   extents 各项为该范围内的 { lo, hi }（还没取到 = null，那一项就不出注记）；
//   diskWeek 是近 7 天的磁盘序列（走势一句话恒按 7 天算，与选中的范围无关）。
// 带语义的明细项是 { text, kind } 对象（kind: "range" | "outlook"，视图写到 data-kind 上）；其余仍是字符串。
export function withTrendNotes(model, trend) {
  if (!model?.hasData || !trend) return model;
  const { cpu, memory, disk } = model.tiles;
  const extents = trend.extents || {};
  const rangeItem = (tile, extent) => {
    const text = rangeNoteText(trend.label, extent, tile.value);
    return text ? [{ text, kind: "range" }] : [];
  };
  const outlook = disk.value == null ? "" : diskOutlook(trend.diskWeek, disk.value);
  const [diskSize, ...diskRest] = disk.details;
  return {
    ...model,
    tiles: {
      cpu: { ...cpu, details: [...cpu.details, ...rangeItem(cpu, extents.cpu)] },
      memory: { ...memory, details: [...memory.details, ...rangeItem(memory, extents.ram)] },
      disk: {
        ...disk,
        details: [
          ...(diskSize ? [diskSize] : []),
          ...(outlook ? [{ text: outlook, kind: "outlook" }] : []),
          ...diskRest,
          ...rangeItem(disk, extents.disk),
        ],
      },
    },
  };
}

// 把上一采样的环比挂到三块 tile 上（纯函数，返回新模型，不改入参）。
export function withSampleDeltas(model, prev) {
  if (!model || !prev) return model;
  const s = model.sample;
  const cpuComparable = prev.cpuKind != null && prev.cpuKind === s.cpuKind;
  return {
    ...model,
    tiles: {
      cpu: { ...model.tiles.cpu, delta: cpuComparable ? buildDelta(prev.cpu, s.cpu) : null },
      memory: { ...model.tiles.memory, delta: buildDelta(prev.ram, s.ram) },
      disk: { ...model.tiles.disk, delta: buildDelta(prev.disk, s.disk) },
    },
  };
}
