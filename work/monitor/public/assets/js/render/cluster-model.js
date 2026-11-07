// cluster-model.js —— 服务器页「集群节点与队列」面板的纯模型（无 DOM，Node 可直接测）。
//
// 数据源：layers.resources[activeServerId].slurm（后端 lib/slurm.mjs 解析的 schemaVersion 1
// 结构，随 60s 一轮的 slow 采集刷新）。没有 Slurm 的服务器（state=absent / 旧后端无该字段）
// 整块面板隐藏；采集失败时保留上次数据并在新鲜度胶囊上标出。
//
// 口径：
//   - 节点 CPU 看两件事：分配（Slurm 已分给作业的核，sinfo CPUsState 的 A/T）与负载
//     （节点 load average / 总核数，含 Slurm 之外的进程）。两者差距大时单独提示。
//   - 内存「已用」= 总量 − 空闲（sinfo FreeMem 是 OS 视角），不是 Slurm 分配量；空闲超过配置总量
//     （RealMemory 配偏小）时改报空闲量。
//   - 未知一律显示「未知」，不拿 0 冒充。
import { formatBytePair, formatBytes, formatGb, formatRelativeTime } from "../store.js";
import { clampPct, finite, levelFor, worstLevel } from "../thresholds.js";
import { freshnessParts } from "./resources-model.js";
import { clockOf, dayKeyOf, offsetDay } from "./usage-model.js";

// 「按用户」只列前几位，其余合并成一行，避免长尾把列表撑得很长。
export const USER_ROWS_MAX = 6;
export const JOB_FILTERS = Object.freeze(["all", "running", "pending", "mine"]);

const NUM_COLLATOR = new Intl.Collator("en", { numeric: true });
const COUNT_FORMATTER = new Intl.NumberFormat("en-US");
function compareNumericText(a, b) {
  if (a === b) return 0;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return NUM_COLLATOR.compare(a, b);
}

function pctOf(part, total) {
  const p = finite(part);
  const t = finite(total);
  if (p == null || t == null || t <= 0) return null;
  return clampPct((p / t) * 100);
}

// 千分位：1344 → "1,344"。
export function formatCount(value) {
  const n = finite(value);
  if (n == null) return "未知";
  const r = Math.round(n);
  if (r > -1000 && r < 1000) return String(r);
  return COUNT_FORMATTER.format(r);
}

// 时长（秒）→ 紧凑中文：「45 秒」「44 分」「20 小时 6 分」「3 天 2 小时」。
export function formatDuration(seconds) {
  const s = finite(seconds);
  if (s == null || s < 0) return "";
  if (s < 60) return `${Math.floor(s)} 秒`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} 分`;
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return restMin ? `${hours} 小时 ${restMin} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

// sinfo 的内存口径是 MB（= MiB）：紧凑口径、最大报到 GiB（不进位到 TiB）。
const MIB = 1024 * 1024;
const MEM_FORMAT = { compact: true, maxUnit: "GiB" };

function formatMb(mb) {
  const n = finite(mb);
  return n == null ? "未知" : formatBytes(n * MIB, MEM_FORMAT);
}

function formatMbPair(used, total) {
  return formatBytePair(used * MIB, total * MIB, MEM_FORMAT);
}

// ---- 节点状态 ----

// level：ok（在线可调度）/ warn（排空、维护等人为下线）/ critical（宕机、无响应、故障）/ unknown。
// tone：状态点的颜色语义——busy 用强调色（在干活不是告警），idle/off 用中性灰。
const NODE_STATES = {
  idle: { label: "空闲", level: "ok", tone: "idle" },
  mixed: { label: "部分占用", level: "ok", tone: "busy" },
  allocated: { label: "已占满", level: "ok", tone: "busy" },
  completing: { label: "收尾中", level: "ok", tone: "busy" },
  reserved: { label: "已预留", level: "ok", tone: "idle" },
  planned: { label: "已规划", level: "ok", tone: "idle" },
  draining: { label: "排空中", level: "warn", tone: "warn" },
  drained: { label: "已排空", level: "warn", tone: "warn" },
  drain: { label: "已排空", level: "warn", tone: "warn" },
  maint: { label: "维护中", level: "warn", tone: "warn" },
  future: { label: "未上线", level: "unknown", tone: "idle" },
  down: { label: "宕机", level: "critical", tone: "critical" },
  fail: { label: "故障", level: "critical", tone: "critical" },
  failing: { label: "故障中", level: "critical", tone: "critical" },
  inval: { label: "配置无效", level: "critical", tone: "critical" },
  unknown: { label: "未知", level: "unknown", tone: "idle" },
};

const FLAG_LABELS = {
  not_responding: "无响应",
  drain: "排空中",
  draining: "排空中",
  drained: "已排空",
  maintenance: "维护",
  maint: "维护",
  powered_off: "已休眠",
  powering_up: "唤醒中",
  powering_down: "休眠中",
  power_down_pending: "待休眠",
  reboot_pending: "待重启",
  reboot_issued: "重启中",
  fail: "故障",
  planned: "已规划",
};

export function describeNodeState(state, flags = []) {
  const base = NODE_STATES[String(state || "").toLowerCase()] || { label: state ? String(state) : "未知", level: "unknown", tone: "idle" };
  let level = base.level;
  let tone = base.tone;
  const extras = [];
  for (const flag of Array.isArray(flags) ? flags : []) {
    const key = String(flag || "").toLowerCase();
    const label = FLAG_LABELS[key];
    if (!label || label === base.label || extras.includes(label)) continue;
    extras.push(label);
    if (key === "not_responding" || key === "fail") {
      level = worstLevel(level, "critical");
      tone = "critical";
    } else if (key.startsWith("drain") || key.startsWith("maint")) {
      level = worstLevel(level, "warn");
      if (tone !== "critical") tone = "warn";
    }
  }
  return { label: [base.label, ...extras].join(" · "), level, tone };
}

// ---- 作业状态与原因 ----

const JOB_STATES = {
  RUNNING: { label: "运行中", tone: "busy", group: "running" },
  PENDING: { label: "排队中", tone: "pending", group: "pending" },
  COMPLETING: { label: "收尾中", tone: "busy", group: "other" },
  CONFIGURING: { label: "启动中", tone: "busy", group: "other" },
  SUSPENDED: { label: "已挂起", tone: "warn", group: "other" },
  REQUEUED: { label: "已重排", tone: "pending", group: "other" },
  REQUEUE_HOLD: { label: "重排挂起", tone: "warn", group: "other" },
  RESIZING: { label: "调整中", tone: "busy", group: "other" },
  STOPPED: { label: "已停止", tone: "warn", group: "other" },
  SIGNALING: { label: "发信号", tone: "busy", group: "other" },
  STAGE_OUT: { label: "回传中", tone: "busy", group: "other" },
};

export function describeJobState(state) {
  const key = String(state || "").toUpperCase();
  return JOB_STATES[key] || { label: key || "未知", tone: "idle", group: "other" };
}

// 排队原因（squeue %r）→ 中文。前缀匹配覆盖 QOS/Assoc 的一大族限额原因；
// 认不出的原样显示（原文另放 title，便于对照 Slurm 文档）。
const REASON_EXACT = {
  Priority: "优先级靠后",
  Resources: "等待资源",
  QOSMaxGRESPerUser: "个人 GPU / GRES 配额已满",
  QOSMaxGRESPerUserLimit: "个人 GPU / GRES 配额已满",
  Dependency: "等待依赖作业",
  DependencyNeverSatisfied: "依赖无法满足",
  BeginTime: "未到开始时间",
  JobHeldUser: "用户挂起",
  JobHeldAdmin: "管理员挂起",
  PartitionDown: "分区已停用",
  PartitionInactive: "分区未激活",
  PartitionNodeLimit: "超出分区节点数限制",
  PartitionTimeLimit: "超出分区时限",
  NodeDown: "所需节点宕机",
  BadConstraints: "约束无法满足",
  Reservation: "等待预留",
  InvalidAccount: "账户无效",
  InvalidQOS: "QOS 无效",
  Licenses: "等待许可证",
  "launch failed requeued held": "启动失败已挂起",
  Prolog: "执行 Prolog",
  Cleaning: "清理中",
  NonZeroExitCode: "非零退出",
  TimeLimit: "已达时限",
};

export function describeReason(reason) {
  const raw = typeof reason === "string" ? reason.trim() : "";
  if (!raw || raw === "None") return { text: "", raw: "" };
  if (Object.hasOwn(REASON_EXACT, raw)) return { text: REASON_EXACT[raw], raw };
  if (raw.startsWith("ReqNodeNotAvail")) return { text: "所需节点不可用", raw };
  if (/^(QOS|Assoc)\w*Limit/.test(raw) || /^(QOS|Assoc)(Grp|Max)/.test(raw)) return { text: "超出配额限制", raw };
  return { text: raw, raw };
}

// 保留 Slurm 原因原文，建议按阻塞条件区分；未知原因不猜测配置。
export function queueReasonAdvice(reason) {
  const raw = typeof reason === "string" ? reason.trim().slice(0, 512) : "";
  const exact = {
    Priority: "同分区或预留中有优先级更高的作业。先等待；同规模实验可参考历史实耗缩短时限，增加回填机会。反复重提不能保证提高优先级。",
    Resources: "所需的 CPU、GPU、内存或节点组合当前无法分配。核对 GPU 型号、节点约束与申请量；可按历史实耗减少过量申请，或选择兼容分区。空闲卡不一定符合全部条件。",
    QOSMaxGRESPerUser: "所选 QOS 的个人 GPU / GRES 总量上限暂不允许此作业启动。先检查自己正在使用的卡数，等待已有作业释放，或减少本次卡数；需要提高配额时联系管理员。",
    Dependency: "先等依赖作业达到指定条件。核对依赖作业的状态与 afterok / afterany 条件；前序失败后 afterok 可能永远无法满足。",
    DependencyNeverSatisfied: "依赖条件已无法满足。核对前序失败原因，修复后重新建立依赖；确认不再需要此作业后手动清理。",
    BeginTime: "尚未到用户指定的开始时刻。核对提交参数 --begin，或等待该时刻到来。",
    JobHeldUser: "作业被用户挂起。确认实验可以运行后，由本人解除挂起。",
    JobHeldAdmin: "作业被管理员挂起。联系管理员确认挂起原因与恢复条件。",
    PartitionTimeLimit: "申请时长超过分区限制。减少 --time，或选择允许该时长的分区。",
    InvalidAccount: "核对 --account 及该账户在分区的授权；必要时联系管理员。",
    InvalidQOS: "核对 --qos 及账户允许使用的 QOS；必要时联系管理员。",
  };
  if (Object.hasOwn(exact, raw)) return exact[raw];
  if (raw === "QOSMaxGRESPerUserLimit") return exact.QOSMaxGRESPerUser;
  if (/^(QOS|Assoc)(Grp|Max)/.test(raw) || /^(QOS|Assoc)\w*Limit/.test(raw)) return "触发 QOS 或账户资源限制。按原始 Reason 核对限制对象与资源种类；个人总量限制可等已有作业释放，组级或单作业限制需调整申请或联系管理员。";
  if (/^(ReqNodeNotAvail|NodeDown|PartitionDown|PartitionInactive|Reservation)/.test(raw)) return "指定节点、分区或预留当前不可用。核对节点状态、预留与硬性约束；确认实验兼容后换节点 / 分区，维护问题联系管理员。";
  return raw && raw !== "None" ? "暂未收录此原因的解释。保留原始 Reason，核对集群规则或联系管理员；不据此推断还要等待多久。" : "Slurm 尚未给出明确原因，等待下一轮队列采样；暂无可确认的操作建议。";
}

// 可信度是证据等级，不是启动概率；当前回填结果也最多标为“中”。
export function pendingStartEstimate(job, sampledAt, now = Date.now()) {
  const sampled = finite(sampledAt);
  const unknown = (text, title, confidence = "unavailable") => ({ at: null, text, title, confidence });
  if (sampled == null || sampled > now + 60_000) return unknown("预计开始：不可用（采样时间异常）", "采样时间缺失或在未来，无法确认预计开始时刻。");
  if (now - sampled > 3 * 60_000) return unknown("预计开始：低可信度（采样已过期）", "队列采样超过 3 分钟未刷新，旧预测暂不展示；等待慢采集恢复。", "low");
  if (isDeadlockReason(job?.reason)) return unknown("预计开始：不可用（依赖无法满足）", "先修复依赖条件，不能根据原预计时刻继续等待。");
  const estimate = describeStartEstimate(job?.startAt, sampled, now);
  if (!estimate) return unknown("预计开始：暂无可信估算", "Slurm 未提供有效未来开始时间，或上次预测已过期；不等于即将开始。");
  const conditional = !["Priority", "Resources"].includes(job?.reason);
  return {
    ...estimate,
    confidence: conditional ? "low" : "medium",
    text: `${estimate.text} · ${conditional ? "低可信度（仍受条件限制）" : "中等可信度（回填估算）"}`,
    title: `${estimate.title}。${conditional ? "配额、依赖、挂起或其它条件仍可能阻止启动。" : "基于当前队列与资源的回填结果；运行结束、抢占与新作业可改变它。"}`,
  };
}

// ---- 时限进度 ----
// 运行中且有时限的作业：已用 / 时限（封顶 1）。到时限 Slurm 会直接杀掉作业，所以用到 80% 转黄、95% 转红。
export const PROGRESS_WARN = 0.8;
export const PROGRESS_CRITICAL = 0.95;

export function progressTone(progress) {
  if (progress == null) return null;
  return progress >= PROGRESS_CRITICAL ? "critical" : progress >= PROGRESS_WARN ? "warn" : "ok";
}

// ---- 面板各块 ----

// 内存三种情形：正常「已用 / 总量」；空闲超过配置总量（RealMemory 配偏小）→ 直接报空闲量；缺数据 → 未知。
function buildMemory(n) {
  const memTotal = finite(n.memTotalMb);
  const memFree = finite(n.memFreeMb);
  // sinfo 的 Memory 是管理员配置的 RealMemory，FreeMem 是系统实报值：配置偏小时空闲会超过
  // 「总量」（本集群实测多数节点如此）。这时「总量 − 空闲」没有意义，改为直接报空闲量。
  const freeExceeds = memTotal != null && memFree != null && memFree > memTotal;
  const memUsed = memTotal != null && memFree != null && !freeExceeds ? memTotal - memFree : null;
  const memPct = freeExceeds ? 0 : pctOf(memUsed, memTotal);
  return {
    pct: memPct == null ? null : Math.round(memPct),
    level: levelFor("memory", memPct),
    text: freeExceeds
      ? `空闲 ${formatMb(memFree)}`
      : memUsed != null ? formatMbPair(memUsed, memTotal) : memTotal != null ? `共 ${formatMb(memTotal)}` : "未知",
    title: freeExceeds
      ? `内存空闲 ${formatMb(memFree)}（超过 Slurm 配置的 ${formatMb(memTotal)}，配置偏小）`
      : memUsed != null ? `内存已用 ${formatMbPair(memUsed, memTotal)}` : "",
  };
}

// GPU 显存 / 使用者占用：GB 一位小数、整数去掉 .0；缺值写「?」。
function gbText(mb) {
  const n = finite(mb);
  return n == null ? "?" : formatGb(n).replace(/\.0$/, "");
}

// GPU 卡位：Slurm 节点只知道「分配了几张」→ 前 used 张实心；直连节点有逐卡数据 →
// 柱高 = 利用率，在用（利用率 ≥5% 或显存 ≥10%）的卡描边强调。
function buildGpu(n, direct) {
  const gpus = n.gpus && typeof n.gpus === "object" ? n.gpus : null;
  const total = finite(gpus?.total);
  if (!total) return null;
  const used = finite(gpus?.used);
  const model = typeof gpus?.model === "string" ? gpus.model : "";
  const cards = Array.isArray(gpus?.cards) ? gpus.cards.filter((c) => c && typeof c === "object") : [];
  let slots;
  const users = new Map();
  const temps = [];
  if (direct && cards.length) {
    slots = cards.map((c, i) => {
      const util = finite(c.util);
      const memUsed = finite(c.memUsedMb);
      const memTotal = finite(c.memTotalMb);
      const memPct = pctOf(memUsed, memTotal);
      const busy = (util != null && util >= 5) || (memPct != null && memPct >= 10);
      const cardUsers = (Array.isArray(c.users) ? c.users : []).filter((u) => u && typeof u.user === "string" && u.user);
      for (const u of cardUsers) users.set(u.user, (users.get(u.user) || 0) + (finite(u.memMb) ?? 0));
      const index = finite(c.index) ?? i;
      const tempC = finite(c.tempC);
      const powerW = finite(c.powerW);
      if (tempC != null) temps.push(tempC);
      return {
        key: `g${index}`,
        fill: util == null ? 0 : clampPct(util) / 100,
        busy,
        title: [
          `GPU ${index}${c.name ? ` · ${c.name}` : ""}`,
          `利用率 ${util == null ? "未知" : `${Math.round(util)}%`}`,
          memTotal != null ? `显存 ${gbText(memUsed)} / ${gbText(memTotal)} GB` : "",
          cardUsers.length ? `使用者 ${cardUsers.map((u) => `${u.user} ${gbText(u.memMb)} GB`).join("、")}` : "",
          [tempC != null ? `${Math.round(tempC)}°C` : "", powerW != null ? `${Math.round(powerW)} W` : ""].filter(Boolean).join(" · "),
        ].filter(Boolean).join("\n"),
      };
    });
  } else {
    const allocated = Math.max(0, Math.min(total, used ?? 0));
    slots = Array.from({ length: Math.min(total, 16) }, (_, i) => ({
      key: `g${i}`,
      fill: i < allocated ? 1 : 0,
      busy: i < allocated,
      title: `GPU ${i + 1} / ${total}${model ? ` · ${model}` : ""}：${i < allocated ? "已分配给作业" : "空闲"}`,
    }));
  }
  const busyCount = slots.filter((s) => s.busy).length;
  const userText = [...users.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([u, mb]) => `${u} ${gbText(mb)} GB`)
    .join(" · ");
  return {
    total,
    used: direct ? busyCount : (used ?? 0),
    model,
    slots,
    // 直连节点有逐卡温度时附最高温度（与服务器页 GPU 卡同一口径；Slurm 节点没有逐卡数据）。
    text: `${direct ? busyCount : (used ?? "?")} / ${total} ${direct ? "在用" : "已分配"}${model ? ` · ${model}` : ""}${temps.length ? ` · 最高 ${Math.round(Math.max(...temps))}°C` : ""}`,
    userText,
  };
}

function ringFor(outer, inner, caption) {
  return {
    outer: outer == null ? null : Math.round(clampPct(outer) * 10) / 10,
    inner: inner == null ? null : Math.round(clampPct(inner) * 10) / 10,
    center: outer == null ? "—" : `${Math.round(outer)}%`,
    caption,
  };
}

function buildNodes(rawNodes, jobsByNode, now) {
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  return list
    .filter((n) => n && typeof n === "object" && typeof n.name === "string" && n.name)
    .map((n) => {
      const direct = n.source === "direct";
      const reachable = n.reachable !== false;
      const cpus = n.cpus && typeof n.cpus === "object" ? n.cpus : {};
      const alloc = finite(cpus.alloc);
      const total = finite(cpus.total);
      const load = finite(n.load);
      const busyPct = finite(n.busyPct);
      const allocPct = pctOf(alloc, total);
      const loadPct = load != null && total != null && total > 0 ? (load / total) * 100 : null;
      const mem = buildMemory(n);
      const gpu = reachable ? buildGpu(n, direct) : null;
      const partitions = (Array.isArray(n.partitions) ? n.partitions : []).filter((p) => typeof p === "string" && p);
      const jobCount = jobsByNode.get(n.name) || 0;
      const reason = typeof n.reason === "string" && n.reason ? n.reason : "";
      const loadText = load != null ? `${load.toFixed(1)}${loadPct != null ? `（${Math.round(loadPct)}%）` : ""}` : "未知";

      let state;
      let meta;
      let ring;
      let stats;
      let offline = null;
      if (direct) {
        const failure = n.failure === "timeout" ? "连接超时" : "ssh 连接失败";
        state = reachable
          ? { label: "直连在线", level: "ok", tone: busyPct != null && busyPct >= 5 ? "busy" : "idle" }
          : { label: "无法连接", level: "warn", tone: "warn" };
        // 卡片上已有「直连」徽标：首行说明只留核数（「不在 Slurm 分区、经登录节点直连」在悬停提示里）；
        // 连不上时拿不到核数，这一格留空，原因写在卡片正文里。
        meta = total != null ? `${total} 核` : "";
        ring = reachable ? ringFor(busyPct, loadPct, "利用率") : ringFor(null, null, "利用率");
        stats = reachable
          ? [
            { key: "busy", label: "利用率", value: busyPct == null ? "未知" : `${Math.round(busyPct)}%`, dot: "accent" },
            { key: "load", label: "负载", value: loadText, dot: "neutral" },
          ]
          : [];
        if (!reachable) {
          const lastSeen = finite(n.lastSeenAt);
          offline = {
            text: `${failure}${lastSeen != null ? ` · 上次连接 ${formatRelativeTime(lastSeen, now)}` : ""}`,
            note: "只影响该节点的监控，其它节点与作业队列照常",
          };
        }
      } else {
        state = describeNodeState(n.state, n.flags);
        // 首行说明与名称、状态挤在同一行，写短：「CPU · 8 作业」（完整说法在悬停提示里）。
        meta = [partitions.join(" / "), jobCount ? `${jobCount} 作业` : "无作业"].filter(Boolean).join(" · ");
        ring = ringFor(allocPct, loadPct, "分配");
        stats = [
          { key: "alloc", label: "分配", value: alloc != null && total != null ? `${alloc} / ${total} 核` : "未知", dot: "accent" },
          { key: "load", label: "负载", value: loadText, dot: "neutral" },
        ];
      }
      // 负载比已分配核多出一截（≥8 核且 ≥总核 10%）：节点上有 Slurm 之外的进程在跑。直连节点无分配概念。
      const offSlurm = !direct && load != null && total != null && alloc != null
        ? load - alloc >= Math.max(8, total * 0.1)
        : false;
      const title = [
        `${n.name} · ${state.label}${n.stateRaw ? `（Slurm：${n.stateRaw}）` : ""}`,
        direct ? "不在任何 Slurm 分区，由登录节点 ssh 直连采集" : "",
        !direct ? [partitions.length ? `${partitions.join(" / ")} 分区` : "", jobCount ? `${jobCount} 个作业在运行` : "没有作业在运行"].filter(Boolean).join(" · ") : "",
        !direct && alloc != null && total != null ? `CPU 已分配 ${alloc} / ${total} 核` : "",
        direct && busyPct != null ? `CPU 利用率 ${busyPct}%` : "",
        load != null ? `负载 ${load.toFixed(2)}` : "",
        mem.title,
        gpu ? `GPU ${gpu.text}${gpu.userText ? ` · ${gpu.userText}` : ""}` : "",
        reason ? `原因：${reason}` : "",
      ].filter(Boolean).join("\n");
      return {
        key: n.name,
        name: n.name,
        direct,
        reachable,
        state,
        meta,
        partitions,
        ring,
        stats,
        cpuAlloc: direct ? null : alloc,
        cpuTotal: total,
        busyPct,
        load,
        memPct: reachable ? mem.pct : null,
        memLevel: reachable ? mem.level : "unknown",
        memText: reachable ? mem.text : "未知",
        gpu,
        offline,
        offSlurm,
        reason,
        title,
      };
    });
}

// 本人排队作业的预计开始时间（v2.51）：squeue %S 是 Slurm 回填调度的估算，会随队列变化。
// 只在采样时刻之后、一年之内才显示（Unknown / N/A 解析不出、过去时刻、远期哨兵值一律不显示）。
const START_HORIZON_MS = 365 * 86400_000;
// 时刻按北京时间显示（与作业历史、用量、简报同一口径，见 usage-model.js），不随本机时区变：
//「明天」「10-09」这类日期前缀按本机日历算的话，人不在 UTC+8 时会和集群上看到的日期差一天。
export function describeStartEstimate(startAt, sampledAt, now = Date.now()) {
  const at = finite(startAt);
  const sampled = finite(sampledAt);
  if (at == null || sampled == null || at <= sampled || at <= now - 60_000 || at - sampled > START_HORIZON_MS) return null;
  const date = dayKeyOf(at / 1000);
  const currentDate = dayKeyOf(now / 1000);
  const hm = clockOf(at / 1000);
  const day = date === currentDate ? "" : date === offsetDay(currentDate, 1) ? "明天 " : `${date.slice(5)} `;
  const sampledText = clockOf(sampled / 1000);
  return {
    at,
    text: `预计 ${day}${hm} 开始 · ${sampledText} 估算`,
    title: `预计开始 ${date} ${hm}（Slurm 回填调度估算，${sampledText} 采样，会随队列变化，不是承诺）`,
  };
}

// 排队死锁原因（前序依赖作业失败/被取消，永远无法满足，需要用户主动 scancel）。
export function isDeadlockReason(reasonRaw) {
  return String(reasonRaw || "").trim() === "DependencyNeverSatisfied";
}

// 排队前序透视：针对处于 PENDING（且原因为 Priority / Resources / ReqNodeNotAvail）的作业，
// 统计同一分区内比它等待更久（或等待时长相同但作业号更早）的排队作业数量、合计核数与 GPU 数。
const QUEUE_AHEAD_REASONS = /^(Priority|Resources|ReqNodeNotAvail)/;
const pendingIndexCache = new WeakMap();

function getPendingEntries(allJobs) {
  if (!Array.isArray(allJobs)) return [];
  let entries = pendingIndexCache.get(allJobs);
  if (entries) return entries;
  entries = [];
  for (const other of allJobs) {
    if (!other || typeof other !== "object") continue;
    const oState = String(other.state || "").toUpperCase();
    if (oState !== "PENDING" && other.group !== "pending") continue;
    const id = String(other.id ?? "");
    const idNum = Number(id);
    entries.push({
      id,
      idNum: Number.isFinite(idNum) ? idNum : null,
      part: typeof other.partition === "string" ? other.partition : "",
      wait: finite(other.waitSec ?? other.wait) ?? -1,
      cpus: finite(other.cpus) ?? 0,
      gpus: finite(other.gpus) ?? 0,
    });
  }
  pendingIndexCache.set(allJobs, entries);
  return entries;
}

export function computeQueueAhead(allJobs, targetJob) {
  if (!targetJob || typeof targetJob !== "object") return null;
  const stateKey = String(targetJob.state?.label ? "PENDING" : (targetJob.state || "")).toUpperCase();
  if (stateKey !== "PENDING" && targetJob.group !== "pending") return null;
  const rawReason = String(targetJob.reason?.raw ?? targetJob.reason ?? "").trim();
  if (rawReason && !QUEUE_AHEAD_REASONS.test(rawReason)) return null;
  const part = typeof targetJob.partition === "string" ? targetJob.partition : "";
  const myWait = finite(targetJob.waitSec ?? targetJob.wait) ?? -1;
  const myId = String(targetJob.id ?? "");
  const myIdNum = Number(myId);
  const myIdIsNum = Number.isFinite(myIdNum);
  let jobs = 0;
  let cpus = 0;
  let gpus = 0;
  for (const other of getPendingEntries(allJobs)) {
    if (other.id === myId) continue;
    if (part && other.part && part !== other.part) continue;
    const ahead =
      other.wait > myWait ||
      (other.wait === myWait &&
        (myIdIsNum && other.idNum != null ? other.idNum < myIdNum : NUM_COLLATOR.compare(other.id, myId) < 0));
    if (!ahead) continue;
    jobs += 1;
    cpus += other.cpus;
    gpus += other.gpus;
  }
  if (!jobs) return null;
  const res = [cpus ? `${formatCount(cpus)} 核` : "", gpus ? `${formatCount(gpus)} GPU` : ""].filter(Boolean).join(" · ");
  return {
    jobs,
    cpus,
    gpus,
    text: `前序 ${jobs} 作业${res ? `（${res}）` : ""}`,
  };
}

export const GPU_IDLE_MIN_ELAPSED_SEC = 15 * 60;
export const GPU_VRAM_CRITICAL_RATIO = 0.95;

// 运行中 GPU 作业「算力空转 / 同卡显存濒危」早筛：
// 1. 若通过 gpuapp 里的 Slurm 作业号精确匹配到所在 GPU 卡：检查该卡总显存是否 ≥95%（MPS/多进程同卡叠跑濒危），
//    或运行满 15 分钟但所在卡利用率全为 0%（疑似空转）。
// 2. 若所在节点有完整 GPU 卡列表但未发现该用户的任何 GPU 进程，且作业已运行满 15 分钟：提示无 GPU 进程（疑似空转）。
export function detectJobGpuHazard(job, { allCards = [], nodeCards = [], viewer = null } = {}) {
  if (!job || !job.mine || job.group !== "running" || !(job.gpus > 0) || !viewer) return null;
  const jobId = String(job.id);
  const matchedCards = allCards.filter((c) => Array.isArray(c?.users) && c.users.some((u) => (
    u?.user === viewer && Array.isArray(u.jobs) && u.jobs.some((j) => String(j?.id) === jobId)
  )));
  if (matchedCards.length > 0) {
    let worstCard = null;
    let worstRatio = 0;
    for (const c of matchedCards) {
      const used = finite(c.memUsedMb);
      const total = finite(c.memTotalMb);
      if (used != null && total != null && total > 0) {
        const ratio = used / total;
        if (ratio > worstRatio) {
          worstRatio = ratio;
          worstCard = c;
        }
      }
    }
    if (worstCard && worstRatio >= GPU_VRAM_CRITICAL_RATIO) {
      const pct = Math.round(worstRatio * 100);
      const multiJob = matchedCards.some((c) => {
        const totalJobs = (c.users || []).reduce((acc, u) => acc + (Array.isArray(u?.jobs) ? u.jobs.length : 1), 0);
        return totalJobs > 1 || (c.users || []).length > 1;
      });
      return {
        kind: "vram-critical",
        tone: "critical",
        text: `显存 ${pct}%${multiJob ? "（同卡叠跑濒危）" : "（濒临 OOM）"}`,
        title: `所在 GPU ${worstCard.index ?? ""} 显存已用 ${gbText(worstCard.memUsedMb)} / ${gbText(worstCard.memTotalMb)} GB（${pct}%）${multiJob ? "，多进程/多作业共享同卡极易触发 CUDA OOM" : "，接近显存上限"}`,
      };
    }
    if ((job.elapsed ?? 0) >= GPU_IDLE_MIN_ELAPSED_SEC && matchedCards.every((c) => finite(c.util) != null && finite(c.util) === 0)) {
      return {
        kind: "gpu-idle",
        tone: "warn",
        text: "GPU 0%（疑似空转）",
        title: `作业已运行 ${formatDuration(job.elapsed)}，但所在 GPU 卡利用率为 0%，可能卡在数据加载、预处理或通信等待`,
      };
    }
    return null;
  }
  if ((job.elapsed ?? 0) >= GPU_IDLE_MIN_ELAPSED_SEC && nodeCards.length > 0) {
    const hasAnyViewerProc = nodeCards.some((c) => Array.isArray(c?.users) && c.users.some((u) => u?.user === viewer));
    if (!hasAnyViewerProc) {
      return {
        kind: "gpu-no-proc",
        tone: "warn",
        text: "无 GPU 进程（疑似空转）",
        title: `作业已申请 ${job.gpus} 张 GPU 并运行 ${formatDuration(job.elapsed)}，但所在节点的 GPU 上未检测到您的计算进程`,
      };
    }
  }
  return null;
}

// 串联本人排队中的依赖死锁链：直接处于 DependencyNeverSatisfied 的作业 + 同实验前缀（流水线）下
// 因 Dependency 等待前序的后续作业，生成一键整链 scancel 命令。
export function analyzeDeadlockChain(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const minePending = list.filter((j) => j && j.mine && j.group === "pending");
  const direct = minePending.filter((j) => j.deadlock);
  if (!direct.length) return null;
  const pipeKey = (name) => {
    const base = jobBaseName(name);
    return base.replace(/[-_](?:step|stage|phase|part)\d*$/i, "") || base;
  };
  const deadlockBases = new Set(direct.map((j) => pipeKey(j.name)).filter(Boolean));
  const cascade = minePending.filter((j) => !j.deadlock && j.reasonRaw === "Dependency" && deadlockBases.has(pipeKey(j.name)));
  for (const j of cascade) {
    j.cascadeDeadlock = true;
    j.title = [j.title, `同流水线前序作业已死锁，建议执行 scancel ${j.id} 一起清理`].filter(Boolean).join("\n");
  }
  const directIds = direct.map((j) => j.id);
  const cascadeIds = cascade.map((j) => j.id);
  const allIds = [...directIds, ...cascadeIds];
  const command = `scancel ${allIds.join(" ")}`;
  const text = cascadeIds.length > 0
    ? `${directIds.length} 个依赖死锁（波及同流水线 ${cascadeIds.length} 个后续作业）`
    : directIds.length > 1
      ? `${directIds.length} 个作业依赖死锁`
      : `作业 #${directIds[0]} 依赖死锁`;
  return {
    directIds,
    cascadeIds,
    allIds,
    command,
    text,
  };
}

function buildJobs(rawJobs, viewer, sampledAt = null, now = Date.now(), { gpuContext = null, baselines = null } = {}) {
  const list = Array.isArray(rawJobs) ? rawJobs : [];
  const jobs = [];
  for (const j of list) {
    if (!j || typeof j !== "object" || j.id == null) continue;
    const st = describeJobState(j.state);
    const reason = describeReason(j.reason);
    const elapsed = finite(j.elapsedSec);
    const wait = finite(j.waitSec);
    const limit = finite(j.timeLimitSec);
    const cpus = finite(j.cpus);
    const nodes = finite(j.nodes);
    const gpus = finite(j.gpus);
    const running = st.group === "running" || (st.group === "other" && st.tone === "busy");
    const durationText = st.group === "pending"
      ? (wait != null ? `已等 ${formatDuration(wait)}` : "等待中")
      : (elapsed != null ? formatDuration(elapsed) || "0 秒" : "未知");
    // 没有时限（或时限为 0）不画进度；排队 / 收尾中的作业也不画。
    const progress = st.group === "running" && limit != null && limit > 0 && elapsed != null
      ? Math.min(1, Math.max(0, elapsed / limit))
      : null;
    const limitText = limit == null
      ? "不限时"
      : `上限 ${formatDuration(limit)}${progress != null ? `（已用 ${Math.round(progress * 100)}%）` : ""}`;
    // 单行表格：资源列只放要紧的（多节点才写节点数），完整明细在悬停提示里。
    const resParts = [
      nodes != null && nodes > 1 ? `${nodes} 节点` : "",
      cpus != null ? `${cpus} 核` : "",
      gpus ? `${gpus} GPU` : "",
    ].filter(Boolean);
    const nodeList = typeof j.nodeList === "string" && j.nodeList ? j.nodeList : "";
    const where = running || st.group === "running" ? nodeList : (reason.text || nodeList);
    const user = typeof j.user === "string" ? j.user : "";
    const name = typeof j.name === "string" ? j.name : "";
    const mine = Boolean(viewer) && user === viewer;
    const deadlock = st.group === "pending" && isDeadlockReason(reason.raw);
    const startEstimate = st.group === "pending" && mine ? pendingStartEstimate(j, sampledAt, now) : null;
    const queueAhead = st.group === "pending" && mine && !deadlock ? computeQueueAhead(list, j) : null;
    const jobItem = {
      key: String(j.id),
      id: String(j.id),
      name,
      user,
      mine,
      partition: typeof j.partition === "string" ? j.partition : "",
      state: st,
      group: st.group,
      durationText,
      // 有时限才在时长后面挂「/ 上限」；不限时不占位。
      limitShort: limit == null ? "" : formatDuration(limit),
      // 时限进度细线（时长单元格底边）：0–1，没有时限 / 不在运行 → null。
      progress,
      progressTone: progressTone(progress),
      resourceText: resParts.join(" · ") || "未知",
      cpus,
      gpus,
      where,
      whereIsReason: st.group !== "running" && Boolean(reason.text),
      reasonRaw: reason.raw,
      queueAdvice: st.group === "pending" && mine ? queueReasonAdvice(reason.raw) : "",
      deadlock,
      cascadeDeadlock: false,
      queueAhead,
      startEstimate,
      nodeList,
      elapsed,
      wait,
      gpuHazard: null,
      slowAnomaly: mine && st.group === "running" && baselines ? evaluateDurationAnomaly(name, elapsed, baselines) : null,
      title: "",
    };
    if (gpuContext && mine && st.group === "running" && gpus > 0) {
      jobItem.gpuHazard = detectJobGpuHazard(jobItem, {
        allCards: gpuContext.allCards,
        nodeCards: gpuContext.nodeCardsFor(nodeList),
        viewer,
      });
    }
    jobItem.title = [
      `作业 ${j.id}${name ? ` · ${name}` : ""}`,
      `用户 ${user || "未知"} · 分区 ${j.partition || "未知"}`,
      `${st.label}${reason.raw ? `（${reason.raw}）` : ""}`,
      deadlock ? `依赖永远无法满足，建议执行 scancel ${j.id} 清理` : "",
      jobItem.gpuHazard ? jobItem.gpuHazard.title : "",
      jobItem.slowAnomaly ? jobItem.slowAnomaly.title : "",
      queueAhead ? queueAhead.text : "",
      startEstimate ? startEstimate.title : "",
      `${nodes != null ? `${nodes} 节点 · ` : ""}${[cpus != null ? `${cpus} 核` : "", gpus ? `${gpus} GPU` : ""].filter(Boolean).join(" · ")}${j.memory ? ` · 内存 ${j.memory}` : ""}`,
      limitText,
      nodeList ? `节点 ${nodeList}` : "",
    ].filter(Boolean).join("\n");
    jobs.push(jobItem);
  }
  // 排序：运行中（运行最久在前）→ 其它 → 排队（等得最久在前，大致就是队列顺序）。
  const groupRank = { running: 0, other: 1, pending: 2 };
  jobs.sort((a, b) => {
    const g = (groupRank[a.group] ?? 1) - (groupRank[b.group] ?? 1);
    if (g) return g;
    if (a.group === "pending") return (b.wait ?? -1) - (a.wait ?? -1) || compareNumericText(a.id, b.id);
    return (b.elapsed ?? -1) - (a.elapsed ?? -1) || compareNumericText(a.id, b.id);
  });
  return jobs;
}

// 节点名 → 该节点上的作业数（nodeList 可能是 node[02-03,07] 压缩写法，这里展开常见形态）。
const expandNodeListCache = new Map();
export function expandNodeList(text) {
  const src = typeof text === "string" ? text.trim() : "";
  if (!src || src === "(null)" || src === "N/A") return [];
  const cached = expandNodeListCache.get(src);
  if (cached) return cached.slice();
  const out = [];
  // 顶层按逗号切分，但方括号内的逗号不切。
  const parts = [];
  let depth = 0;
  let buf = "";
  for (const ch of src) {
    if (ch === "[") depth += 1;
    if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  for (const part of parts) {
    const m = /^([^[\]]*)\[([^\]]+)\](.*)$/.exec(part);
    if (!m) {
      if (part) out.push(part);
      continue;
    }
    const [, prefix, body, suffix] = m;
    for (const seg of body.split(",")) {
      const range = /^(\d+)-(\d+)$/.exec(seg);
      if (!range) {
        out.push(`${prefix}${seg}${suffix}`);
        continue;
      }
      const width = range[1].length;
      const from = Number(range[1]);
      const to = Number(range[2]);
      // 防御：畸形或超大区间不展开（一个作业最多 512 个节点足够）。
      if (!(to >= from) || to - from > 512) continue;
      for (let i = from; i <= to; i += 1) out.push(`${prefix}${String(i).padStart(width, "0")}${suffix}`);
    }
  }
  if (expandNodeListCache.size >= 1024) expandNodeListCache.clear();
  expandNodeListCache.set(src, out);
  return out.slice();
}

function buildUsers(jobs, viewer, cpuTotal) {
  const byUser = new Map();
  for (const job of jobs) {
    const key = job.user || "未知";
    const row = byUser.get(key) || { user: key, cores: 0, gpus: 0, running: 0, pending: 0 };
    if (job.group === "pending") row.pending += 1;
    else {
      row.running += 1;
      row.cores += job.cpus ?? 0;
      row.gpus += job.gpus ?? 0;
    }
    byUser.set(key, row);
  }
  const rows = [...byUser.values()].sort((a, b) => b.cores - a.cores || b.pending - a.pending || NUM_COLLATOR.compare(a.user, b.user));
  const shown = rows.slice(0, USER_ROWS_MAX);
  const rest = rows.slice(USER_ROWS_MAX);
  const toModel = (r) => ({
    key: r.user,
    user: r.user,
    mine: Boolean(viewer) && r.user === viewer,
    cores: r.cores,
    pct: pctOf(r.cores, cpuTotal),
    coresText: r.cores > 0 ? `${formatCount(r.cores)} 核` : "未占用",
    detail: [r.running ? `${r.running} 运行` : "", r.pending ? `${r.pending} 排队` : "", r.gpus ? `${r.gpus} GPU` : ""].filter(Boolean).join(" · "),
  });
  const models = shown.map(toModel);
  if (rest.length) {
    const agg = rest.reduce((acc, r) => ({
      user: `其他 ${rest.length} 位`,
      cores: acc.cores + r.cores,
      gpus: acc.gpus + r.gpus,
      running: acc.running + r.running,
      pending: acc.pending + r.pending,
    }), { user: "", cores: 0, gpus: 0, running: 0, pending: 0 });
    models.push({ ...toModel(agg), key: "__rest__", mine: false, other: true });
  }
  return { rows: models, count: rows.length };
}

function buildFreshness({ layer, slurm, now }) {
  const dataAt = finite(slurm?.checkedAt);
  const attemptAt = finite(layer?.checkedAt);
  // 采集成功时层的 checkedAt 只比数据时刻晚几毫秒；相差超过 5 秒才说明最近一次尝试没拿到新数据。
  const attemptLags = attemptAt != null && (dataAt == null || attemptAt - dataAt > 5000);
  const f = freshnessParts({ dataAt, attemptAt: attemptLags ? attemptAt : null, cadence: "随资源采集每 60 秒刷新", now });
  if (slurm?.state === "error") {
    return { level: "error", text: "调度器查询失败", title: f.title(slurm.reason || "sinfo / squeue 执行失败") };
  }
  if (layer?.level === "error" && attemptLags) return f.failed(layer.reason || "采集失败");
  return f.current();
}

function filterJobs(jobs, { filter = "all", node = null } = {}) {
  return jobs.filter((job) => {
    if (filter === "running" && job.group === "pending") return false;
    if (filter === "pending" && job.group !== "pending") return false;
    if (filter === "mine" && !job.mine) return false;
    if (node && !expandNodeList(job.nodeList).includes(node)) return false;
    return true;
  });
}

// ---- 同名实验分组 ----
// 一次提交几十个实验时作业表会拉得很长：同一用户、名字去掉末尾哈希 / 序号后相同的作业（≥ JOB_GROUP_MIN 个）
// 折叠成一行，点击展开。例：cfa-agiter20-35607b-cfd1 / cfa-agiter20-025781-prepare1 → cfa-agiter20。
export const JOB_GROUP_MIN = 3;

const jobBaseNameCache = new Map();
export function jobBaseName(name) {
  const text = String(name || "");
  if (!text) return "";
  const hit = jobBaseNameCache.get(text);
  if (hit !== undefined) return hit;
  const noHash = text.replace(/[-_][0-9a-f]{5,}(?:[-_].*)?$/i, "");
  const out = noHash.replace(/[-_]\d+$/, "") || text;
  if (jobBaseNameCache.size >= 2048) jobBaseNameCache.clear();
  jobBaseNameCache.set(text, out);
  return out;
}

// 同名/同批次成功作业的耗时历史基线（至少 3 个 ≥60s 的完成样本才建基线）。
// 兼容输入：原始作业列表 [{ name, state, outcome, elapsedSec }] 或归并后的历史 rows（含 group.children）。
export const BASELINE_MIN_SAMPLES = 3;
export const BASELINE_MIN_ELAPSED_SEC = 60;
export const BASELINE_SLOW_RATIO = 2;
export const BASELINE_SLOW_MIN_DELTA_SEC = 600;

export function computeDurationBaselines(items) {
  const buckets = new Map();
  const addSample = (name, sec) => {
    if (!name || !Number.isFinite(sec) || sec < BASELINE_MIN_ELAPSED_SEC) return;
    const base = jobBaseName(name);
    if (!base) return;
    let list = buckets.get(base);
    if (!list) {
      list = [];
      buckets.set(base, list);
    }
    list.push(sec);
  };
  const isCompleted = (item) => item.outcome === "completed" || String(item.state || "").toUpperCase() === "COMPLETED";
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (item.kind === "group") {
      for (const child of Array.isArray(item.children) ? item.children : []) {
        if (child && isCompleted(child)) addSample(child.name || item.label, Number(child.elapsedSec));
      }
      continue;
    }
    if (isCompleted(item)) addSample(item.name, Number(item.elapsedSec ?? item.elapsed));
  }
  const baselines = new Map();
  for (const [base, list] of buckets) {
    if (list.length < BASELINE_MIN_SAMPLES) continue;
    list.sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    const medianSec = list.length % 2 === 1 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
    const p90Sec = list[Math.min(list.length - 1, Math.floor(list.length * 0.9))];
    if (medianSec > 0) baselines.set(base, { medianSec, p90Sec, count: list.length });
  }
  return baselines;
}

// 对比单个作业耗时与同名历史基线：超出中位数 ≥2 倍且至少多出 10 分钟（600s）时返回慢作业提示。
export function evaluateDurationAnomaly(name, elapsedSec, baselines) {
  if (!name || !(baselines instanceof Map) || !baselines.size) return null;
  const sec = finite(elapsedSec);
  if (sec == null || sec <= 0) return null;
  const base = jobBaseName(name);
  const b = baselines.get(base);
  if (!b || !(b.medianSec > 0)) return null;
  if (sec < b.medianSec * BASELINE_SLOW_RATIO || sec - b.medianSec < BASELINE_SLOW_MIN_DELTA_SEC) return null;
  const ratio = Math.round((sec / b.medianSec) * 10) / 10;
  const medText = formatDuration(b.medianSec);
  return {
    medianSec: b.medianSec,
    p90Sec: b.p90Sec,
    count: b.count,
    ratio,
    text: `慢 ${ratio}×（常约 ${medText}）`,
    title: `耗时 ${formatDuration(sec)}，比近 48 小时同名成功作业中位数（${medText}，${b.count} 个样本）慢 ${ratio} 倍`,
  };
}

function buildGpuContext(lay, slurm) {
  const hostCards = Array.isArray(lay?.gpu?.cards) ? lay.gpu.cards.filter((c) => c && typeof c === "object") : [];
  const rawNodes = Array.isArray(slurm?.nodes) ? slurm.nodes : [];
  const slurmNodeCount = rawNodes.filter((n) => n && n.source !== "direct").length;
  const byNode = new Map();
  const allCards = [...hostCards];
  for (const n of rawNodes) {
    const cards = Array.isArray(n?.gpus?.cards) ? n.gpus.cards.filter((c) => c && typeof c === "object") : [];
    if (cards.length) {
      byNode.set(n.name, cards);
      allCards.push(...cards);
    }
  }
  return {
    allCards,
    nodeCardsFor(nodeListText) {
      const names = expandNodeList(nodeListText);
      const found = [];
      for (const name of names) {
        const list = byNode.get(name);
        if (list) found.push(...list);
      }
      if (found.length) return found;
      if (slurmNodeCount <= 1 && hostCards.length) return hostCards;
      return [];
    },
  };
}

// 哈希之后的阶段后缀（cfa-agiter20-35607b-cfd1 → cfd1），用于组行的阶段分布。
function jobStage(name, base) {
  const rest = String(name || "").slice(base.length);
  const match = /^[-_][0-9a-f]{5,}[-_]([A-Za-z][A-Za-z0-9]*)$/i.exec(rest);
  return match ? match[1] : null;
}

// 若干 nodeList（可带 node[01-03] 压缩写法）→「node01–07 · 7 台」；withCount=false 时不带台数。
export function nodeRangeOf(nodeLists, { withCount = true } = {}) {
  const names = [...new Set((Array.isArray(nodeLists) ? nodeLists : []).flatMap((text) => expandNodeList(text)))].sort();
  if (!names.length) return "";
  const nums = names.map((n) => /^node(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1]));
  const others = names.filter((n) => !/^node\d+$/.test(n));
  const pad2 = (n) => String(n).padStart(2, "0");
  const parts = [];
  if (nums.length) parts.push(nums.length > 1 ? `node${pad2(Math.min(...nums))}–${pad2(Math.max(...nums))}` : `node${pad2(nums[0])}`);
  parts.push(...others);
  return `${parts.join(" · ")}${withCount && names.length > 1 ? ` · ${names.length} 台` : ""}`;
}

const nodeRangeText = (jobs) => nodeRangeOf(jobs.map((j) => j.nodeList));

function summarizeGroup(key, members, expanded) {
  const first = members[0];
  const base = jobBaseName(first.name);
  const sameName = members.every((j) => j.name === first.name);
  const running = members.filter((j) => j.group !== "pending");
  const pending = members.filter((j) => j.group === "pending");
  const stages = new Map();
  for (const j of members) {
    const stage = jobStage(j.name, base);
    if (stage) stages.set(stage, (stages.get(stage) || 0) + 1);
  }
  const range = (values, prefix = "") => {
    const list = values.filter((v) => v != null).sort((a, b) => a - b);
    if (!list.length) return "";
    const lo = formatDuration(list[0]) || "0 秒";
    const hi = formatDuration(list.at(-1)) || "0 秒";
    return `${prefix}${lo === hi ? lo : `${lo} – ${hi}`}`;
  };
  const res = new Map();
  for (const j of members) {
    const label = [j.cpus != null ? `${j.cpus} 核` : "", j.gpus ? `${j.gpus} GPU` : ""].filter(Boolean).join(" ") || "未知";
    res.set(label, (res.get(label) || 0) + 1);
  }
  const resText = [...res.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label, n]) => `${label} ×${n}`).join(" · ");
  const reasons = new Map();
  for (const j of pending) if (j.whereIsReason && j.where) reasons.set(j.where, (reasons.get(j.where) || 0) + 1);
  const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const label = sameName ? first.name : `${base}-*`;
  const stagesText = [...stages.entries()].map(([stage, n]) => `${stage} ×${n}`).join(" · ");
  // 组内时限进度：最小–最大（颜色看最大的那个——最接近被杀的）。
  const progresses = running.map((j) => j.progress).filter((v) => v != null);
  const progress = progresses.length
    ? { lo: Math.min(...progresses), hi: Math.max(...progresses), tone: progressTone(Math.max(...progresses)) }
    : null;
  return {
    kind: "group",
    key,
    label,
    count: members.length,
    jobIds: members.map((job) => job.id),
    user: first.user,
    mine: first.mine,
    expanded,
    stagesText,
    running: running.length,
    pending: pending.length,
    timeText: running.length ? range(running.map((j) => j.elapsed)) : range(pending.map((j) => j.wait), "已等 "),
    resText,
    progress,
    where: running.length ? nodeRangeText(running) : topReason,
    whereIsReason: !running.length && Boolean(topReason),
    title: [
      `${label} · ${members.length} 个作业${expanded ? "" : "（点击展开）"}`,
      `用户 ${first.user || "未知"}`,
      [running.length ? `${running.length} 运行中` : "", pending.length ? `${pending.length} 排队` : ""].filter(Boolean).join(" · "),
      stagesText ? `阶段 ${stagesText}` : "",
    ].filter(Boolean).join("\n"),
  };
}

// 表格行：分组放在组内第一个作业的位置（沿用原排序），展开时组内作业紧跟其后（child）。
// expanded：已展开的组 key 集合（面板持有）。返回 { rows, groupKeys }。
export function groupJobRows(jobs, { expanded = new Set(), min = JOB_GROUP_MIN } = {}) {
  const buckets = new Map();
  for (const job of jobs) {
    const key = `${job.user}|${jobBaseName(job.name)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(job);
  }
  const rows = [];
  const groupKeys = [];
  const emitted = new Set();
  for (const job of jobs) {
    const key = `${job.user}|${jobBaseName(job.name)}`;
    const members = buckets.get(key);
    if (members.length < min) {
      rows.push({ kind: "job", job });
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    groupKeys.push(key);
    const open = expanded.has(key);
    rows.push(summarizeGroup(key, members, open));
    if (open) for (const member of members) rows.push({ kind: "job", job: member, child: true, groupKey: key });
  }
  return { rows, groupKeys };
}

const FILTER_LABELS = { running: "运行中", pending: "排队中", mine: "我的作业" };

// 作业表为空时的空状态（spec 交给 empty-state.js 渲染，见 cluster-view.js）：队列本身就是空的，
// 还是当前筛选（芯片 / 节点）没有命中——后者给「清除筛选」（cluster-panel.js 的 [data-cl-clear-filter]）。
// squeue 段随 slow 采集每 60 秒一轮（lib/probes/collect.mjs COLLECT_SLOW_INTERVAL_MS）。
function jobsEmptyState({ total, filter, node }) {
  if (!total) {
    return { tone: "neutral", icon: "inbox", title: "队列是空的", body: "集群上现在没有排队或运行的作业。数据来自 squeue，每分钟刷新一次。" };
  }
  const parts = [FILTER_LABELS[filter] || "", node ? `节点 ${node}` : ""].filter(Boolean);
  return {
    tone: "neutral", icon: "search", title: "没有符合筛选的作业", body: `当前筛选：${parts.join(" · ")}。`,
    actions: [{ label: "清除筛选", kind: "text", attrs: { "data-cl-clear-filter": "" } }],
  };
}

// 空闲算力雷达（最佳投递建议）：
// 综合节点在线状态（排除 drain / down / maint / 离线 / 直连节点）、剩余未分配 GPU 卡数、
// 剩余未分配 CPU 核数与系统负载，推荐当前无需排队即可立即调度的最佳 GPU 节点与 CPU 节点，
// 并生成一键可复制的交互式 srun 命令与 #SBATCH 资源参数片段。
export function buildIdleComputeRadar(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const healthySlurm = list.filter((n) => n && !n.direct && n.reachable !== false && n.state?.level === "ok" && !/^(?:master|login|head|mgmt|admin)\b/i.test(n.name));
  if (!healthySlurm.length) {
    return { visible: false, totalFreeGpus: 0, totalFreeCpus: 0, bestGpu: null, bestCpu: null };
  }
  const candidates = healthySlurm.map((n) => {
    const freeGpus = n.gpu ? Math.max(0, (finite(n.gpu.total) ?? 0) - (finite(n.gpu.used) ?? 0)) : 0;
    const freeCpus = n.cpuTotal != null && n.cpuAlloc != null ? Math.max(0, n.cpuTotal - n.cpuAlloc) : 0;
    const rawPart = Array.isArray(n.partitions) && n.partitions[0] ? String(n.partitions[0]).replace(/\*$/, "") : "";
    const loadRatio = n.load != null && n.cpuTotal > 0 ? n.load / n.cpuTotal : 0;
    return {
      node: n.name,
      partition: rawPart,
      freeGpus,
      freeCpus,
      gpuModel: n.gpu?.model || "",
      loadRatio,
      offSlurm: Boolean(n.offSlurm),
    };
  });

  const totalFreeGpus = candidates.reduce((s, c) => s + c.freeGpus, 0);
  const totalFreeCpus = candidates.reduce((s, c) => s + c.freeCpus, 0);

  const gpuPool = candidates
    .filter((c) => c.freeGpus > 0 && (c.freeCpus > 0 || c.freeCpus === 0))
    .sort(
      (a, b) =>
        Number(a.offSlurm) - Number(b.offSlurm) ||
        b.freeGpus - a.freeGpus ||
        b.freeCpus - a.freeCpus ||
        a.loadRatio - b.loadRatio ||
        compareNumericText(a.node, b.node)
    );
  const topGpu = gpuPool[0] || null;
  let bestGpu = null;
  if (topGpu) {
    const recCpus = topGpu.freeCpus > 0 ? Math.min(topGpu.freeCpus, 8) : 4;
    const partFlag = topGpu.partition ? ` -p ${topGpu.partition}` : "";
    bestGpu = {
      node: topGpu.node,
      partition: topGpu.partition,
      freeGpus: topGpu.freeGpus,
      freeCpus: topGpu.freeCpus,
      model: topGpu.gpuModel,
      srunCmd: `srun${partFlag} -w ${topGpu.node} --gres=gpu:1 -c ${recCpus} --pty bash`,
      sbatchSnippet: `#SBATCH${partFlag} -w ${topGpu.node} --gres=gpu:1 -c ${recCpus}`,
    };
  }

  const cpuPool = candidates
    .filter((c) => c.freeCpus >= 2)
    .sort(
      (a, b) =>
        Number(a.offSlurm) - Number(b.offSlurm) ||
        b.freeCpus - a.freeCpus ||
        a.loadRatio - b.loadRatio ||
        compareNumericText(a.node, b.node)
    );
  const topCpu = cpuPool[0] || null;
  let bestCpu = null;
  if (topCpu) {
    const recCpus = Math.min(topCpu.freeCpus, 16);
    const partFlag = topCpu.partition ? ` -p ${topCpu.partition}` : "";
    bestCpu = {
      node: topCpu.node,
      partition: topCpu.partition,
      freeCpus: topCpu.freeCpus,
      srunCmd: `srun${partFlag} -w ${topCpu.node} -c ${recCpus} --pty bash`,
      sbatchSnippet: `#SBATCH${partFlag} -w ${topCpu.node} -c ${recCpus}`,
    };
  }

  return {
    visible: Boolean(bestGpu || bestCpu),
    totalFreeGpus,
    totalFreeCpus,
    bestGpu,
    bestCpu,
  };
}

// 面板模型（纯函数）。layer = status.layers.resources[activeServerId]；view = { filter, node }；historyRows = 近 48h 作业行（用于耗时基线对比）。
export function buildClusterPanelModel({ layer = null, now = Date.now(), view = {}, historyRows = null } = {}) {
  const lay = layer && typeof layer === "object" ? layer : null;
  const slurm = lay?.slurm && typeof lay.slurm === "object" ? lay.slurm : null;
  if (!slurm || slurm.state === "absent" || slurm.state == null) return { visible: false };

  const viewer = typeof slurm.user === "string" && slurm.user ? slurm.user : null;
  const gpuContext = buildGpuContext(lay, slurm);
  const baselines = historyRows ? computeDurationBaselines(historyRows) : null;
  const jobs = buildJobs(slurm.jobs, viewer, slurm.checkedAt, now, { gpuContext, baselines });
  const deadlockChain = analyzeDeadlockChain(jobs);
  const jobsByNode = new Map();
  for (const job of jobs) {
    if (job.group === "pending") continue;
    for (const name of expandNodeList(job.nodeList)) jobsByNode.set(name, (jobsByNode.get(name) || 0) + 1);
  }
  const nodes = buildNodes(slurm.nodes, jobsByNode, now);
  const idleRadar = buildIdleComputeRadar(nodes);
  const hasData = nodes.length > 0 || jobs.length > 0;

  // ---- KPI ----
  // CPU 分配只统计 Slurm 节点（直连节点不归调度器管，没有「分配」）。
  const slurmNodes = nodes.filter((n) => !n.direct);
  const directNodes = nodes.filter((n) => n.direct);
  const cpuTotal = slurmNodes.reduce((s, n) => s + (n.cpuTotal ?? 0), 0);
  const cpuAlloc = slurmNodes.reduce((s, n) => s + (n.cpuAlloc ?? 0), 0);
  const loadSum = slurmNodes.reduce((s, n) => s + (n.load ?? 0), 0);
  const hasCpu = slurmNodes.some((n) => n.cpuTotal != null);
  const allocPct = hasCpu ? pctOf(cpuAlloc, cpuTotal) : null;
  const busyNodes = nodes.filter((n) => n.state.tone === "busy").length;
  const idleNodes = nodes.filter((n) => n.state.tone === "idle" && n.state.level === "ok").length;
  const badNodes = nodes.filter((n) => n.state.level === "warn" || n.state.level === "critical").length;
  const worstNode = nodes.reduce((lvl, n) => worstLevel(lvl, n.state.level), "ok");
  const gpuNodes = nodes.filter((n) => n.gpu);
  const gpuTotal = gpuNodes.reduce((s, n) => s + n.gpu.total, 0);
  const gpuUsed = gpuNodes.reduce((s, n) => s + n.gpu.used, 0);

  const rawCounts = slurm.counts && typeof slurm.counts === "object" ? slurm.counts : null;
  const running = finite(rawCounts?.running) ?? jobs.filter((j) => j.group === "running").length;
  const pending = finite(rawCounts?.pending) ?? jobs.filter((j) => j.group === "pending").length;
  const other = finite(rawCounts?.other) ?? jobs.filter((j) => j.group === "other").length;
  const users = buildUsers(jobs, viewer, cpuTotal);

  const mineJobs = jobs.filter((j) => j.mine);
  const mineRunning = mineJobs.filter((j) => j.group !== "pending");
  const mineCores = mineRunning.reduce((s, j) => s + (j.cpus ?? 0), 0);
  const minePending = mineJobs.filter((j) => j.group === "pending").length;

  const directLine = directNodes.map((n) => (n.reachable
    ? `${n.name} 直连 · 利用率 ${n.busyPct == null ? "未知" : `${Math.round(n.busyPct)}%`}`
    : `${n.name} 直连中断`)).join(" · ");
  const jobTotal = running + pending + other;
  // 我占用的核数 / Slurm 节点总核数（与「按用户占用」同一口径）。
  const mineShare = mineCores > 0 ? pctOf(mineCores, cpuTotal) : null;
  const kpis = [
    {
      key: "cpu",
      label: "CPU 核分配",
      value: allocPct == null ? "未知" : `${Math.round(allocPct)}%`,
      sub: hasCpu ? `${formatCount(cpuAlloc)} / ${formatCount(cpuTotal)} 核${directNodes.length ? " · Slurm 节点" : "已分配"}` : "等待采样",
      sub2: directLine,
      visual: { kind: "ring", pct: allocPct == null ? null : Math.round(allocPct * 10) / 10 },
      hint: hasCpu && cpuTotal > 0 ? `Slurm 节点负载合计 ${loadSum.toFixed(1)}（${Math.round((loadSum / cpuTotal) * 100)}%）` : "",
      level: "ok",
    },
    {
      key: "nodes",
      label: "节点",
      value: `${nodes.length}`,
      unit: "台",
      sub: [busyNodes ? `${busyNodes} 占用` : "", idleNodes ? `${idleNodes} 空闲` : "", badNodes ? `${badNodes} 异常` : ""].filter(Boolean).join(" · ") || "—",
      // 每台节点一个状态点（顺序同下方节点卡），一眼看出忙闲与异常。
      visual: { kind: "dots", dots: nodes.map((n) => ({ key: n.name, tone: n.state.tone, title: `${n.name} · ${n.state.label}` })) },
      level: badNodes ? worstNode : "ok",
    },
    {
      key: "jobs",
      label: "作业",
      value: `${formatCount(running)}`,
      unit: "运行",
      sub: [`${formatCount(pending)} 排队`, other ? `${formatCount(other)} 其它` : "", users.count ? `${users.count} 位用户` : ""].filter(Boolean).join(" · "),
      // 运行 / 排队占比条：排队越长，灰段越长。
      visual: jobTotal > 0
        ? { kind: "split", segments: [
          { key: "running", pct: ((running + other) / jobTotal) * 100, tone: "busy", title: `运行 ${running + other}` },
          { key: "pending", pct: (pending / jobTotal) * 100, tone: "pending", title: `排队 ${pending}` },
        ].filter((seg) => seg.pct > 0) }
        : { kind: "split", segments: [] },
      level: "ok",
    },
    {
      key: "mine",
      label: viewer ? `我的作业（${viewer}）` : "我的作业",
      value: `${mineRunning.length}`,
      unit: "运行",
      sub: [`${minePending} 排队`, mineCores ? `占 ${formatCount(mineCores)} 核` : ""].filter(Boolean).join(" · "),
      // 占比单独一行（与「CPU 核分配」那格的第二行同一写法）+ 底部细条，不挤在同一行里被省略。
      sub2: mineShare == null ? "" : `占全集群 ${mineShare > 0 && mineShare < 1 ? "<1" : Math.round(mineShare)}% 的核`,
      visual: mineShare == null ? null : { kind: "share", pct: Math.round(mineShare * 10) / 10, title: "我占用的核数 / Slurm 节点总核数" },
      level: "ok",
      emphasis: mineJobs.length > 0,
    },
  ];
  if (gpuTotal > 0) {
    const slurmGpu = gpuNodes.filter((n) => !n.direct);
    const directGpu = gpuNodes.filter((n) => n.direct);
    const part = (list, verb) => {
      const t = list.reduce((s, n) => s + n.gpu.total, 0);
      const u = list.reduce((s, n) => s + n.gpu.used, 0);
      return t ? `${verb} ${u}/${t}` : "";
    };
    // 说明拆两行：「Slurm 已分配 4/4 · 直连在用 0/2」挤在一行会被省略。
    const gpuParts = [part(slurmGpu, "Slurm 已分配"), part(directGpu, "直连在用")].filter(Boolean);
    kpis.push({
      key: "gpu",
      label: "GPU",
      value: `${gpuUsed}`,
      unit: `/ ${gpuTotal} 卡在用`,
      sub: gpuParts[0] || "",
      sub2: gpuParts[1] || "",
      // 按节点分组的卡位条：实心 = 已分配 / 在用。
      visual: { kind: "slots", groups: gpuNodes.map((n) => ({ key: n.name, title: `${n.name} · ${n.gpu.text}`, slots: n.gpu.slots })) },
      level: "ok",
    });
  }

  // ---- 过滤 ----
  const filter = JOB_FILTERS.includes(view.filter) ? view.filter : "all";
  const node = typeof view.node === "string" && nodes.some((n) => n.name === view.node) ? view.node : null;
  // 我的作业（含我的实验组）固定在表格最上方；我的 / 别人的内部各自保持原排序（运行最久在前 → 排队）。
  const filtered = filterJobs(jobs, { filter, node });
  const visibleJobs = [...filtered.filter((j) => j.mine), ...filtered.filter((j) => !j.mine)];
  const expanded = view.expanded instanceof Set ? view.expanded : new Set();
  const { rows: jobRows, groupKeys } = groupJobRows(visibleJobs, { expanded });
  const mineGpus = mineRunning.reduce((s, j) => s + (j.gpus ?? 0), 0);
  const filters = [
    { key: "all", label: "全部", count: jobs.length },
    { key: "running", label: "运行", count: jobs.filter((j) => j.group !== "pending").length },
    { key: "pending", label: "排队", count: jobs.filter((j) => j.group === "pending").length },
    { key: "mine", label: "我的", count: mineJobs.length, disabled: !viewer },
  ].map((f) => ({ ...f, active: f.key === filter }));

  const jobsTotal = finite(slurm.jobsTotal) ?? jobs.length;
  const truncated = slurm.jobsTruncated === true || jobsTotal > jobs.length;
  const emptyState = visibleJobs.length ? null : jobsEmptyState({ total: jobs.length, filter, node });

  const partitions = [...new Set(nodes.flatMap((n) => n.partitions))];
  const badgeParts = [
    `${nodes.length} 节点`,
    partitions.length ? `${partitions.length} 分区` : "",
    slurm.version ? `Slurm ${slurm.version}` : "Slurm",
  ].filter(Boolean);

  return {
    visible: true,
    hasData,
    // 调度器里的当前用户（没有就没有「我的」过滤与「我的历史」）。
    viewer,
    errorText: slurm.state === "error" ? (slurm.reason || "sinfo / squeue 执行失败") : "",
    badge: badgeParts.join(" · "),
    freshness: buildFreshness({ layer: lay, slurm, now }),
    kpis,
    // 菜单栏数字与悬浮岛（render/glance-model.js）的读数：与上面 KPI 同一组计数，不另算一遍。
    glance: {
      cpuAlloc: hasCpu ? cpuAlloc : null,
      cpuTotal: hasCpu ? cpuTotal : null,
      cpuAllocPct: allocPct,
      nodeCount: nodes.length,
      busyNodes,
      idleNodes,
      badNodes,
      gpuUsed,
      gpuTotal,
      running,
      pending,
    },
    nodes,
    idleRadar,
    offSlurmCount: nodes.filter((n) => n.offSlurm).length,
    users: users.rows,
    userCount: users.count,
    filters,
    node,
    filter,
    jobs: visibleJobs,
    jobRows,
    groupKeys,
    // 作业表上方「我的」汇总条：我有作业或表里有折叠组时显示；allExpanded 决定按钮文案。
    mine: {
      visible: mineJobs.length > 0 || groupKeys.length > 0,
      count: mineJobs.length,
      running: mineRunning.length,
      pending: minePending,
      cores: mineCores,
      gpus: mineGpus,
      groups: groupKeys.length,
      collapsed: groupKeys.filter((k) => !expanded.has(k)).length,
      allExpanded: groupKeys.length > 0 && groupKeys.every((k) => expanded.has(k)),
      deadlockChain,
    },
    // 作业表为空时的说明：emptyText 是一句话的标题，emptyState 是完整的空状态（图标 / 正文 / 动作）。
    emptyText: emptyState?.title || "",
    emptyState,
    truncatedText: truncated ? `仅列出前 ${formatCount(jobs.length)} 个作业（队列共 ${formatCount(jobsTotal)} 个）` : "",
  };
}
