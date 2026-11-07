// cluster-diagnosis-model.js —— 「我的历史」里失败作业诊断的纯模型（无 DOM，Node 可直接测；v2.49）。
//
// 诊断不另开面板：失败 / 超时 / 内存不足 / 节点故障的作业行下面多一行原因，点开看证据、日志路径与提交脚本；
// 近 48 小时里同一原因失败了不止一个，列表顶部合并成一行「N 个失败同因：…」，点它筛出这些作业。
//
// 数据源：
//   GET /api/jobs?serverId=               行上的 diagnosis: { category, headline } | null（加法字段）
//   GET /api/jobs/diagnoses?serverId=     { items, groups }：展开所需的证据 / 日志路径 / 有没有脚本，以及同因分组
//   GET /api/jobs/diagnoses/script?...    提交脚本原文（展开后按需取，见 cluster-history-loader.js）
// 诊断接口没有（旧后端 404）/ 模块关闭（{ disabled: true }）→ 索引为 null，历史表与没有诊断时完全一样。

// 会做诊断的终态（与后端取证的触发条件一致）；取消 / 完成的作业不显示原因行。
export const DIAGNOSED_STATES = Object.freeze(["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"]);

export const CATEGORY_TEXT = Object.freeze({
  timeout: "超时",
  oom: "内存不足",
  "gpu-oom": "显存不足",
  nan: "数值异常(NaN)",
  python: "程序报错",
  "missing-file": "找不到文件",
  node: "节点故障",
  refused: "子任务未启动",
  unknown: "原因未识别",
  "no-log": "日志已不可得",
});

export const NO_LOG_TEXT = "日志已不可得（脚本或日志在失败前已被删除）";

// 日志路径从哪里来（越靠前越可信）：登记 = 作业还在队列时记下的 StdOut / StdErr。
const SOURCE_TEXT = Object.freeze({
  registry: "日志路径取自作业运行时的登记",
  scontrol: "日志路径取自 scontrol",
  submitline: "日志路径由提交命令 / 脚本推断",
  default: "日志路径按默认的 slurm-<作业号>.out 推断",
});

// 顶部同因合并最多列几类，其余写「另有 N 类」。
export const CAUSES_MAX = 3;
const HOUR_MS = 3_600_000;

const text = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

// 诊断接口响应 → { items: Map<作业号, item>, groups }；不可用（缺失 / 关闭 / 形状不对）→ null。
export function diagnosisIndex(response) {
  if (!response || typeof response !== "object" || response.disabled || !Array.isArray(response.items)) return null;
  const items = new Map();
  for (const item of response.items) {
    if (!item || typeof item !== "object" || item.jobId == null) continue;
    items.set(String(item.jobId), item);
  }
  const groups = (Array.isArray(response.groups) ? response.groups : [])
    .filter((g) => g && typeof g === "object" && g.key != null && Array.isArray(g.jobIds))
    .map((g) => ({ key: String(g.key), category: text(g.category), headline: text(g.headline), jobIds: g.jobIds.map(String) }));
  return { items, groups };
}

const diagnosedState = (row) => DIAGNOSED_STATES.includes(String(row?.state || "").toUpperCase());

// 行的诊断摘要：历史行自带的优先，没有再看诊断接口里的同一作业。不该显示 / 还没诊断 → null。
export function rowDiagnosis(row, index) {
  if (!index || !row || !diagnosedState(row)) return null;
  const own = row.diagnosis && typeof row.diagnosis === "object" && row.diagnosis.category ? row.diagnosis : null;
  const source = own || index.items.get(String(row.id)) || null;
  if (!source?.category) return null;
  return { category: text(source.category), headline: text(source.headline) };
}

// 提交脚本的展示状态。entry = 加载器缓存（{ state: "loading" | "ok" | "error", script, error }）。
function scriptModel(item, entry, open) {
  if (!item?.hasScript) return { available: false, open: false, state: "none", text: "", error: "" };
  let state = "idle";
  if (entry?.state === "loading") state = "loading";
  else if (entry?.state === "ok") state = typeof entry.script === "string" && entry.script ? "ok" : "missing";
  else if (entry?.state === "error") state = "error";
  return {
    available: true,
    open: Boolean(open),
    state,
    text: state === "ok" ? entry.script : "",
    error: state === "error" ? text(entry.error) || "未知错误" : "",
  };
}

// 一个作业行的诊断模型（null = 这行不显示原因）。
// opts：open（证据是否展开）、scriptOpen（脚本是否展开）、scriptEntry（加载器里这份脚本的缓存）。
export function diagnosisModel(row, index, { open = false, scriptOpen = false, scriptEntry = null } = {}) {
  const summary = rowDiagnosis(row, index);
  if (!summary) return null;
  const jobId = String(row.id);
  const item = index.items.get(jobId) || null;
  const evidence = (Array.isArray(item?.evidence) ? item.evidence : []).map(text);
  // index = 诊断记录里的文件序号（v2.51 按段读取的 log 参数）；role 只有 v2.51 起的记录才有。
  const files = (Array.isArray(item?.files) ? item.files : [])
    .map((f, index) => ({ path: text(f && typeof f === "object" ? f.path : f), role: f && typeof f === "object" && typeof f.role === "string" ? f.role : null, index }))
    .filter((f) => f.path);
  const noLog = summary.category === "no-log";
  const label = CATEGORY_TEXT[summary.category] || CATEGORY_TEXT.unknown;
  const expandable = Boolean(item) && (evidence.length > 0 || files.length > 0 || Boolean(item.hasScript));
  return {
    jobId,
    category: summary.category,
    label,
    headline: summary.headline || label,
    noLog,
    expandable,
    open: expandable && Boolean(open),
    evidence,
    files,
    sourceText: files.length ? SOURCE_TEXT[item?.source] || "" : "",
    script: scriptModel(item, scriptEntry, scriptOpen),
  };
}

// 顶部同因合并：只算这份近 48 小时历史里的作业（行里出现的，或诊断记录的结束时刻落在窗口内的），
// 两个以上才合并；按个数多 → 少，最多 CAUSES_MAX 类（正在筛的那类总在其中）。
// historyIds：历史行（含组内）里的作业号；windowStart：窗口起点（毫秒）；active：正在筛的分组 key。
const NOT_A_CAUSE = new Set(["unknown", "no-log"]);

export function causesModel(index, { historyIds = new Set(), windowStart = -Infinity, active = null } = {}) {
  const empty = { items: [], more: 0, active: null };
  if (!index) return empty;
  const inWindow = (id) => historyIds.has(id) || Number(index.items.get(id)?.endedAtMs) >= windowStart;
  const qualifying = [];
  for (const group of index.groups) {
    // 「原因未识别」「日志已不可得」不是一个原因，不能说成「同因」。
    if (NOT_A_CAUSE.has(group.category)) continue;
    const ids = [...new Set(group.jobIds.filter(inWindow))];
    if (ids.length < 2) continue;
    qualifying.push({ key: group.key, category: group.category, headline: group.headline || CATEGORY_TEXT[group.category] || "", count: ids.length, ids });
  }
  qualifying.sort((a, b) => b.count - a.count);
  const current = qualifying.find((g) => g.key === active) || null;
  const shown = qualifying.slice(0, CAUSES_MAX);
  if (current && !shown.includes(current)) shown[shown.length - 1] = current;
  return {
    items: shown.map((g) => ({
      ...g,
      active: g === current,
      title: g === current ? "再点一次显示全部作业" : `只看这 ${g.count} 个作业`,
    })),
    more: qualifying.length - shown.length,
    active: current ? current.key : null,
  };
}

// 历史窗口起点：以采集时刻为准（没有则用现在），往前 windowHours（缺省 48）小时。
export function historyWindowStart(data, now = Date.now()) {
  const end = Number.isFinite(data?.checkedAt) ? data.checkedAt : now;
  const hours = Number.isFinite(data?.windowHours) && data.windowHours > 0 ? data.windowHours : 48;
  return end - hours * HOUR_MS;
}

// 一键复制给 Claude Code / Codex 排障的结构化上下文：包含作业号、名称、状态/退出码、分类结论、
// 未省略的完整日志路径与关键报错摘录（若有已读取的提交脚本也一并附上）。
export function buildAgentDiagnosisPrompt(diag, row = null) {
  if (!diag || typeof diag !== "object") return "";
  const id = text(diag.jobId || row?.id);
  const name = text(row?.name);
  const stateLabel = text(row?.state?.label || row?.state);
  const exitText = text(row?.exitText);
  const where = text(row?.where);
  const elapsed = text(row?.elapsedText);
  const header = [
    "请帮我排查这个失败的 Slurm 作业：",
    `- 作业号：${id}${name ? `（${name}）` : ""}`,
    stateLabel || exitText ? `- 终态：${[stateLabel, exitText && exitText !== "—" ? exitText : "", elapsed && elapsed !== "—" ? `耗时 ${elapsed}` : "", where && where !== "—" ? where : ""].filter(Boolean).join(" · ")}` : "",
    `- 诊断归因：[${text(diag.label || diag.category)}] ${text(diag.headline)}`,
  ].filter(Boolean);
  const files = Array.isArray(diag.files) ? diag.files.filter((f) => f?.path) : [];
  if (files.length) {
    header.push(`- 日志文件：${files.map((f) => f.path).join(" , ")}`);
  }
  const evidence = Array.isArray(diag.evidence) ? diag.evidence.filter(Boolean) : [];
  if (evidence.length) {
    header.push("", "关键报错摘录：", "```text", ...evidence.slice(0, 20), "```");
  }
  if (diag.script?.state === "ok" && diag.script.text) {
    header.push("", "提交脚本：", "```bash", diag.script.text.trim(), "```");
  }
  return header.join("\n");
}

