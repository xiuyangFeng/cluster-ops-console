// gpu-card-view.js —— 「这块卡上谁在跑」浮层的正文片段（纯字符串函数，Node 可测）。
//
// 输入是就地取到的原始卡（lib/gpu-cards.mjs 的形状：users[].procs[]，v2.76 起），
// 输出交给 app/gpu-card-controller.js 填进 #dlgGpuCardBody。
//
// 这一屏要回答的问题只有一个：**这块卡被谁占着、跑了多久、是怎么起的（经不经 Slurm）**。
// 命令行是别人的进程原样回传的自由文本（唯一能看出 python / jupyter / 容器的线索），
// 所以所有动态文案一律 escapeHtml，绝不当 HTML 拼。
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml, formatClock, formatGb } from "../store.js";

// 提交方式：nvidia-smi 只给 pid 与显存，命令行是唯一线索。判定顺序有讲究——
// 作业号最硬（取自进程 cgroup，是实证）；其次才是工具名；conda 的路径比笼统的「python」更具体。
const SUBMIT_RULES = [
  { kind: "jupyter", re: /\b(jupyter|ipykernel)/, label: "Jupyter 内核", hint: "网页 / VS Code 里的 Notebook 内核，不经 Slurm" },
  { kind: "vscode", re: /code-server|vscode-server|\.vscode/, label: "VS Code Remote", hint: "VS Code 远端会话里起的" },
  { kind: "launcher", re: /torchrun|accelerate\s+launch|deepspeed|\bmpirun\b|\bmpiexec\b/, label: "分布式训练启动器", hint: "torchrun / accelerate / mpirun 这类启动器，不经 Slurm" },
  { kind: "conda", re: /conda|micromamba|\bmamba\b/, label: "conda 环境", hint: "某个 conda 环境里的解释器，不经 Slurm" },
  { kind: "python", re: /(^|\/)python[0-9.]*(\s|$)/, label: "直接运行 Python", hint: "命令行直接起的 python，不经 Slurm" },
];

// 提交方式（kind + 给人看的一句话）。jobId 有值就是 Slurm 作业——这一条不看命令行。
export function classifyGpuProc(proc) {
  const cmdline = String(proc?.cmdline || "");
  const jobId = typeof proc?.jobId === "string" && proc.jobId ? proc.jobId : "";
  if (jobId) {
    return { kind: "slurm", label: `Slurm 作业 #${jobId}`, hint: "进程在 Slurm 作业的 cgroup 里（sbatch / srun / salloc 起的）" };
  }
  for (const rule of SUBMIT_RULES) {
    if (rule.re.test(cmdline)) return { kind: rule.kind, label: rule.label, hint: rule.hint };
  }
  const comm = String(proc?.comm || "").trim();
  return {
    kind: "other",
    label: comm || "未知进程",
    hint: cmdline ? "没认出提交方式，看命令行" : "ps 没取到命令行（进程可能刚退出）",
  };
}

// 已运行时长：秒 → 「N 秒 / N 分钟 / N 小时 M 分 / N 天 M 小时」。取不到（老 ps）返回空串，列留空。
export function formatProcElapsed(etimes) {
  // 先挡 null / undefined / 空串：Number(null) 是 0，会把「没取到」说成「0 秒」。
  if (etimes == null || etimes === "") return "";
  const sec = Number(etimes);
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.floor(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  const hours = Math.floor(sec / 3600);
  if (hours < 24) {
    const mins = Math.floor((sec % 3600) / 60);
    return mins ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
}

// 这张卡上的全部进程（拍平成一张表：属主 + 每个进程），显存降序；显存为空/相同按 pid 排，保证顺序稳定。
// v2.76 之前采集的卡没有 procs → 返回空数组（调用方据此说「这台节点还没有进程明细」）。
export function gpuCardProcs(card) {
  const out = [];
  for (const owner of Array.isArray(card?.users) ? card.users : []) {
    for (const proc of Array.isArray(owner?.procs) ? owner.procs : []) {
      out.push({
        user: typeof owner.user === "string" ? owner.user : "未知",
        pid: String(proc?.pid ?? ""),
        memMb: Number.isFinite(Number(proc?.memMb)) ? Number(proc.memMb) : null,
        etimes: Number.isFinite(Number(proc?.etimes)) ? Number(proc.etimes) : null,
        jobId: typeof proc?.jobId === "string" && proc.jobId ? proc.jobId : "",
        comm: String(proc?.comm || ""),
        cmdline: String(proc?.cmdline || ""),
      });
    }
  }
  return out.sort((a, b) => (b.memMb ?? 0) - (a.memMb ?? 0) || a.pid.localeCompare(b.pid));
}

// 就地从状态里取当前服务器的资源层（与 app/render-pipeline.js 的取值口径一致）。
// 登录节点的 gpu 段与直连节点（layer.slurm.nodes[].gpus.cards）都在这一层里。
export function activeGpuLayer(status) {
  const layers = status?.layers?.resources;
  if (!layers || typeof layers !== "object") return null;
  return layers[status?.activeServerId] ?? null;
}

// 回原始卡：key = "" 是登录节点（layer.gpu），否则是直连节点名（layer.slurm.nodes[].gpus.cards）。
// 与 render/resources-model.js 的 buildGpuGroups 取同一份数据——浮层因此不需要任何新请求。
export function resolveGpuCard(status, key, index) {
  const layer = activeGpuLayer(status);
  const cards = key
    ? (Array.isArray(layer?.slurm?.nodes) ? layer.slurm.nodes : []).find((node) => node?.name === key)?.gpus?.cards
    : layer?.gpu;
  const list = Array.isArray(cards) ? cards : [];
  return list.find((card) => Number(card?.index) === index) || null;
}

// 浮层标题：#0 NVIDIA GeForce RTX 4090（取不到型号就只写卡号）。
export function gpuCardHeading(card) {
  const index = Number.isFinite(Number(card?.index)) ? Number(card.index) : "?";
  const name = String(card?.name || "").trim();
  return `GPU #${index}${name ? ` · ${name}` : ""}`;
}

// 「Slurm 内 / 外」一句话——这一屏最要紧的结论：有人在节点上直接跑（squeue 里看不到）。
export function gpuCardJobSummary(procs) {
  const list = Array.isArray(procs) ? procs : [];
  if (!list.length) return "";
  const inJob = list.filter((p) => p.jobId).length;
  const loose = list.length - inJob;
  if (!loose) return `${list.length} 个计算进程，都在 Slurm 作业里（squeue 里查得到）`;
  if (!inJob) return `${list.length} 个计算进程，都不在 Slurm 作业里——在节点上直接运行，squeue 里看不到`;
  return `${list.length} 个计算进程：${inJob} 个在 Slurm 作业里，${loose} 个不在（在节点上直接运行）`;
}

function statHtml(items) {
  const cells = items
    .filter(([, value]) => value !== "" && value != null)
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
  return cells ? `<dl class="gpu-detail-stats">${cells}</dl>` : "";
}

function procRowHtml(proc) {
  const how = classifyGpuProc(proc);
  const cmdline = proc.cmdline || proc.comm || "（命令行取不到）";
  const mem = proc.memMb == null ? "—" : `${formatGb(proc.memMb)} GB`;
  const age = formatProcElapsed(proc.etimes) || "—";
  const full = [proc.cmdline, `pid ${proc.pid}${proc.etimes == null ? "" : ` · 已运行 ${age}`}`].filter(Boolean).join("\n");
  return (
    '<tr class="gpu-proc-row">' +
    `<td class="gpu-proc-user">${escapeHtml(proc.user)}</td>` +
    `<td class="gpu-proc-cmd" title="${escapeHtml(full)}"><code>${escapeHtml(cmdline)}</code>` +
    `<span class="gpu-proc-pid">pid ${escapeHtml(proc.pid)}</span></td>` +
    `<td class="gpu-proc-mem">${escapeHtml(mem)}</td>` +
    `<td class="gpu-proc-age">${escapeHtml(age)}</td>` +
    `<td class="gpu-proc-how"><span class="gpu-proc-kind" data-kind="${escapeHtml(how.kind)}" title="${escapeHtml(how.hint)}">${escapeHtml(how.label)}</span></td>` +
    "</tr>"
  );
}

// 浮层正文。card = 原始卡（users[].procs[]）；label = 节点名；sampledAt = 这一轮慢采集的时刻。
// 没有 procs 就是「这块卡上没有计算进程」（v2.75 及更早的采集只有属主，没有逐进程明细）。
export function buildGpuCardBodyHtml(card, { label = "", sampledAt = null } = {}) {
  const procs = gpuCardProcs(card);
  const util = Number.isFinite(Number(card?.util)) ? `${Math.round(Number(card.util))}%` : "未知";
  const hasMem = Number.isFinite(Number(card?.memUsedMb)) && Number.isFinite(Number(card?.memTotalMb)) && Number(card.memTotalMb) > 0;
  const mem = hasMem ? `${formatGb(Number(card.memUsedMb))} / ${formatGb(Number(card.memTotalMb))} GB` : "未知";
  const temp = Number.isFinite(Number(card?.tempC)) ? `${Math.round(Number(card.tempC))}°C` : "";
  const power = Number.isFinite(Number(card?.powerW)) ? `${Math.round(Number(card.powerW))} W` : "";
  // 固定 24 小时制（与「最后更新」「下次探测」同一写法）：采集时刻不该随系统区域变成 6:00:00 PM。
  const sampled = Number.isFinite(Number(sampledAt)) && Number(sampledAt) > 0
    ? `采样于 ${formatClock(Number(sampledAt), { locale: "zh-CN", hour12: false })}`
    : "";

  const stats = statHtml([
    ["节点", label || ""],
    ["利用率", util],
    ["显存", mem],
    ["温度", temp],
    ["功耗", power],
  ]);

  const summary = gpuCardJobSummary(procs);
  const head = summary ? `<p class="gpu-detail-summary">${escapeHtml(summary)}</p>` : "";
  const note = `<p class="gpu-detail-note">${escapeHtml([sampled, "数据来自每分钟一次的 nvidia-smi 只读采集"].filter(Boolean).join("；"))}。nvidia-smi 看不到的进程（只用 CPU、或用别人账号起的容器）不在这里。</p>`;

  if (!procs.length) {
    const body = emptyStateHtml({
      compact: true,
      tone: "neutral",
      icon: "server",
      title: "这块卡上没有计算进程",
      body: "nvidia-smi 没列出占用进程：卡是空的，或者进程刚退出、显存还没释放。采集每分钟一次，下一轮会刷新。",
    });
    return stats + head + body + note;
  }

  const rows = procs.map(procRowHtml).join("");
  return (
    stats + head +
    `<h3 class="gpu-detail-h">占用进程（${procs.length}）</h3>` +
    '<div class="gpu-proc-scroll"><table class="gpu-proc-table">' +
    '<caption class="gpu-proc-caption">这块卡上的计算进程：用户、命令行、显存、已运行时长与提交方式</caption>' +
    '<thead><tr><th scope="col">用户</th><th scope="col">进程</th><th scope="col">显存</th><th scope="col">已运行</th><th scope="col">提交方式</th></tr></thead>' +
    `<tbody>${rows}</tbody></table></div>` +
    note
  );
}
