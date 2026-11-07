// 失败作业分类（v2.49 §2.3，纯函数）：sacct 状态 / 退出码 + 取证回来的日志尾部 → 原因类别与一句话。
//
// 类别按优先级（先命中先得）：
//   timeout      State=TIMEOUT 或日志里有 `DUE TO TIME LIMIT`
//   oom          State=OUT_OF_MEMORY、oom-kill 类字样、或单独一行 `Killed` 且退出码 137 / 信号 9
//   gpu-oom      `CUDA out of memory` 等显存不足
//   nan          `non-finite`、`nan loss`、`Loss is NaN` 等
//   python       Traceback 之后的那一行异常（没有 Traceback 时取最后一行 `XxxError: …`）
//   missing-file `No such file or directory`（非 Python 报错）
//   node         State=NODE_FAIL、`slurmstepd: error` 的非时限类报错
//   refused      编排脚本的状态文件记着有子任务被拒绝启动（主日志里没有它们的任何一行），日志里又没有别的报错
//   unknown      找到了日志，但没有可识别的报错行（编排型作业改说子任务的结束情况，见 subrunSummary）
//   no-log       所有来源都没有日志文件
// 文件按 stderr → stdout → 同目录兄弟文件的顺序找，第一个命中的文件给出证据（命中行前后至多 20 行）。
// headline ≤ 160 字符，长路径只留末两段；证据每行 ≤ 300 字符。
//
// groupDiagnoses：按「类别 + 归一化 headline」（数字、路径中段、哈希换成占位符）分组，
// 例如十个 `KeyError: 'arm'` 归成一组。本模块不读盘、不碰时钟。

export const DIAGNOSIS_CATEGORIES = Object.freeze(["timeout", "oom", "gpu-oom", "nan", "python", "missing-file", "node", "refused", "unknown", "no-log"]);
export const HEADLINE_MAX = 160;
export const EVIDENCE_MAX_LINES = 20;
const EVIDENCE_LINE_MAX = 300;
const ROLE_ORDER = { stderr: 0, stdout: 1, sibling: 2 };

const TIME_LIMIT_RE = /DUE TO TIME LIMIT/;
const OOM_RE = /oom[-_ ]kill|Out of memory: Kill|OOM Killer|Exceeded (?:job|step) memory limit|memory cgroup out of memory/i;
const KILLED_RE = /^\s*(?:\S+: line \d+: \d+ )?Killed\b/;
const BASH_KILLED_RE = /^\s*\S+: line \d+:\s+\d+\s+Killed\b/;
const GPU_OOM_RE = /CUDA out of memory|CUDA error: out of memory|torch\.(?:cuda\.)?OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|RESOURCE_EXHAUSTED: Out of memory/i;
const NAN_RE = /non-finite|\bnan loss\b|loss (?:is|became|=|:) ?nan\b|nan (?:detected|encountered)|NaN or Inf found|detected (?:nan|inf)/i;
// torchrun 等会给每行加 "[rank0]: " 前缀：Traceback 行前面的部分记为前缀，后续行先剥掉再判断。
const TRACEBACK_RE = /^(.{0,32}?)Traceback \(most recent call last\):/;
const EXCEPTION_LINE_RE = /^(?:[A-Za-z_][\w]*\.)*[A-Za-z_]\w*(?:Error|Exception|Exit|Interrupt|Warning|Failure)?(?::\s.*|:?\s*$)/;
const LOOSE_EXCEPTION_RE = /^(?:[A-Za-z_]\w*\.)*[A-Z]\w*(?:Error|Exception): \S/;
const MISSING_FILE_RE = /No such file or directory/;
const SLURMSTEPD_RE = /slurmstepd(?:-[\w.-]+)?: error:\s*(.*)$/;
const BUILD_ERROR_SPECIFIC_RE = /^(?:CMake Error\b.*|collect2: error: ld returned \d+ exit status|(?:\S+:\d+:\d+: )?fatal error: .*|make(?:\[\d+\])?: \*\*\* .*)/;
const BUILD_ERROR_SUMMARY_RE = /^(?:-- Configuring incomplete, errors occurred!|ninja: build stopped:.*)$/;
const SCRIPT_REDIRECT_RE = /(?:^|[\s;&|()])1?>>?\s*["']?([^\s"';&|)>]+)["']?/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 终端转义序列就是要剥掉的
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剩余控制字符（保留制表符）
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

// 日志原文 → 行数组：剥终端转义；进度条的 \r 只留最后一段；去掉其余控制字符、行尾空白与末尾空行。
export function cleanLogLines(text) {
  const lines = String(text == null ? "" : text)
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part.trim());
      return (parts.length ? parts[parts.length - 1] : "").replace(CONTROL_RE, "").replace(/\s+$/, "");
    });
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

const clipLine = (line) => (line.length > EVIDENCE_LINE_MAX ? `${line.slice(0, EVIDENCE_LINE_MAX - 1)}…` : line);

// 证据窗口首尾的空行没有信息量，去掉。
function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

// 长路径只留末两段（/public/newhome/cy/x/y/case.json → …/y/case.json），过长的段截短。
export function shortenPath(value) {
  const parts = String(value).split("/").filter(Boolean);
  const short = (seg) => (seg.length > 40 ? `${seg.slice(0, 28)}…` : seg);
  if (!String(value).startsWith("/") || parts.length <= 3) return parts.length ? String(value).split("/").map(short).join("/") : String(value);
  return `…/${parts.slice(-2).map(short).join("/")}`;
}

const PATH_IN_TEXT_RE = /\/[^\s'"`:,;()[\]{}<>]+(?:\/[^\s'"`:,;()[\]{}<>]+)+/g;

export function shortenPathsIn(text) {
  return String(text).replace(PATH_IN_TEXT_RE, (match) => shortenPath(match));
}

function clipHeadline(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > HEADLINE_MAX ? `${flat.slice(0, HEADLINE_MAX - 1)}…` : flat;
}

function humanSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} 小时 ${minutes % 60} 分` : `${h} 小时`;
}

function prepareFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file, index) => ({ path: file?.path ?? null, role: file?.role ?? "sibling", index, lines: cleanLogLines(file?.tail) }))
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || a.index - b.index);
}

// 各文件里最后一处命中（按文件顺序，第一个有命中的文件胜出）→ { file, index, line }。
function findLast(prepared, test) {
  for (const file of prepared) {
    for (let i = file.lines.length - 1; i >= 0; i -= 1) {
      if (test(file.lines[i], i, file.lines)) return { file, index: i, line: file.lines[i] };
    }
  }
  return null;
}

// 命中行附近的上下文（start..end 闭区间，至多 20 行）。
function evidenceAround(hit, before = 9, after = 10) {
  if (!hit) return [];
  const { lines } = hit.file;
  let start = Math.max(0, hit.index - before);
  const end = Math.min(lines.length - 1, hit.index + after);
  if (end - start + 1 > EVIDENCE_MAX_LINES) start = end - EVIDENCE_MAX_LINES + 1;
  return trimBlank(lines.slice(start, end + 1)).map(clipLine);
}

// 最后一个 Traceback 之后的异常行（帧都是缩进行，第一条不缩进的非空行就是异常本身）。
function findTraceback(prepared) {
  for (const file of prepared) {
    const { lines } = file;
    for (let t = lines.length - 1; t >= 0; t -= 1) {
      const head = TRACEBACK_RE.exec(lines[t]);
      if (!head) continue;
      const prefix = head[1];
      for (let i = t + 1; i < lines.length && i <= t + 400; i += 1) {
        const line = prefix && lines[i].startsWith(prefix) ? lines[i].slice(prefix.length) : lines[i];
        if (!line.trim() || /^\s/.test(line)) continue;
        if (EXCEPTION_LINE_RE.test(line)) {
          // 证据：从 Traceback 起到异常行再多一行；太长时保留靠近异常的部分。
          const end = Math.min(lines.length - 1, i + 1);
          const start = Math.max(t, end - EVIDENCE_MAX_LINES + 1);
          return { file, index: i, line, evidence: trimBlank(lines.slice(start, end + 1)).map(clipLine) };
        }
        break;
      }
    }
  }
  const loose = findLast(prepared, (line) => LOOSE_EXCEPTION_RE.test(line));
  return loose ? { ...loose, evidence: evidenceAround(loose, 15, 4) } : null;
}

function missingFileHeadline(line) {
  const quoted = /['"‘“]([^'"’”]*\/[^'"’”]*)['"’”]/.exec(line);
  const colon = /(\S+): No such file or directory/.exec(line);
  const target = quoted?.[1] || (colon && colon[1] !== "error" ? colon[1] : null);
  return target ? `找不到文件 ${shortenPath(target.replace(/:$/, ""))}` : `找不到文件：${shortenPathsIn(line.trim())}`;
}

// 编排型作业（主日志每个子任务一行 END <run> <phase> <退出码>）找不到报错行时的说法：
// 有子任务以非 0 结束 → 点名最先失败的那个；全部以 0 结束 → 如实说明——这时主日志的最后一句
// 恰好是某个子任务的「END … 0」，照抄出来会让人以为它就是原因。
function subrunSummary(subruns, how) {
  const ended = Number(subruns?.ended);
  if (!Number.isSafeInteger(ended) || ended <= 0) return null;
  const first = Array.isArray(subruns.failures) ? subruns.failures[0] : null;
  if (!first) return `${how}，但主日志记录的 ${ended} 个子任务全部以 0 结束`;
  const ending = first.code < 0 ? `被信号 ${-first.code} 终止` : `退出码 ${first.code}`;
  const more = subruns.failed > 1 ? `（共 ${subruns.failed} 个子任务以非 0 结束）` : "";
  return `子任务 ${first.run} ${first.phase} ${ending}${more}，其日志末尾无报错行`;
}

// 状态文件里被拒绝启动的子任务 → { headline, evidence }；没有则 null。原因取第一个的（同一批几乎总是同一个原因）。
function refusedArms(dispatch) {
  const refused = (Array.isArray(dispatch?.items) ? dispatch.items : []).filter((item) => item?.status === "refused");
  if (!refused.length) return null;
  // 状态文件里没跑完的子任务只带回前 8 个：没列全时个数只能说「至少」。
  const count = dispatch.items.length < dispatch.unfinished ? `至少 ${refused.length}` : String(refused.length);
  const reason = refused[0].reason ? `：${shortenPathsIn(refused[0].reason)}` : "";
  return {
    headline: `${count} 个子任务被编排脚本拒绝启动${reason}`,
    evidence: refused.map((item) => clipLine(`${item.name}  ${item.reason || "（状态文件没有写原因）"}`)),
  };
}

function extractScriptRedirect(scriptText) {
  if (typeof scriptText !== "string" || !scriptText) return null;
  let lastTarget = null;
  for (const rawLine of scriptText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    for (const match of line.matchAll(SCRIPT_REDIRECT_RE)) {
      const target = match[1];
      if (!target || target.startsWith("&") || target === "/dev/null") continue;
      lastTarget = target;
    }
  }
  return lastTarget;
}

// input：{ state, exitCode, signal, elapsedSec, nodes, tool, files: [{ path, role, tail }], script, subruns, dispatch }
// → { category, headline, evidence: string[], file: 证据所在文件路径 | null }
export function diagnoseJob(input = {}) {
  const state = String(input.state || "").toUpperCase();
  const prepared = prepareFiles(input.files);
  const hasText = prepared.some((file) => file.lines.some((line) => line.trim()));
  const result = (category, headline, hit = null, evidence = null) => ({
    category,
    headline: clipHeadline(headline),
    evidence: (evidence ?? evidenceAround(hit)).slice(-EVIDENCE_MAX_LINES),
    file: hit?.file?.path ?? null,
  });

  const timeHit = findLast(prepared, (line) => TIME_LIMIT_RE.test(line));
  if (state === "TIMEOUT" || timeHit) {
    const ran = humanSeconds(input.elapsedSec);
    return result("timeout", `超出时限${ran ? `（已运行 ${ran}）` : ""}`, timeHit);
  }

  const killed137 = input.exitCode === 137 || input.exitCode === 9 || input.signal === 9;
  const oomHit = findLast(prepared, (line) => OOM_RE.test(line) || BASH_KILLED_RE.test(line) || (killed137 && KILLED_RE.test(line)));
  if (state === "OUT_OF_MEMORY" || oomHit) return result("oom", "内存不足被系统终止", oomHit);

  const gpuHit = findLast(prepared, (line) => GPU_OOM_RE.test(line));
  if (gpuHit) {
    const amount = /Tried to allocate ([\d.]+ ?[KMGT]i?B)/i.exec(gpuHit.line)?.[1];
    return result("gpu-oom", amount ? `显存不足：试图再分配 ${amount}` : "显存不足（CUDA out of memory）", gpuHit);
  }

  const nanHit = findLast(prepared, (line) => NAN_RE.test(line));
  if (nanHit) return result("nan", /grad/i.test(nanHit.line) ? "训练出现 NaN / 非有限梯度" : "训练出现 NaN / 非有限值", nanHit);

  const traceback = findTraceback(prepared);
  if (traceback) return result("python", shortenPathsIn(traceback.line.trim()), traceback, traceback.evidence);

  const missingHit = findLast(prepared, (line) => MISSING_FILE_RE.test(line));
  if (missingHit) return result("missing-file", missingFileHeadline(missingHit.line), missingHit);

  const stepdHit = findLast(prepared, (line) => SLURMSTEPD_RE.test(line) && !TIME_LIMIT_RE.test(line));
  if (state === "NODE_FAIL" || stepdHit) {
    if (state === "NODE_FAIL" || !stepdHit) return result("node", `节点故障${input.nodes ? `（${String(input.nodes).slice(0, 60)}）` : ""}`, stepdHit);
    const message = SLURMSTEPD_RE.exec(stepdHit.line)[1].replace(/^\*+\s*|\s*\*+$/g, "");
    return result("node", `Slurm 报错：${shortenPathsIn(message)}`, stepdHit);
  }

  const refused = refusedArms(input.dispatch);
  if (refused) return result("refused", refused.headline, null, refused.evidence);

  if (hasText) {
    const buildHit = findLast(prepared, (line) => BUILD_ERROR_SPECIFIC_RE.test(line.trim()))
      || findLast(prepared, (line) => BUILD_ERROR_SUMMARY_RE.test(line.trim()));
    if (buildHit) {
      return result("unknown", `编译 / 构建失败：${shortenPathsIn(buildHit.line.trim())}`, buildHit);
    }
    const how = Number(input.signal) > 0 ? `被信号 ${input.signal} 终止` : `退出码 ${input.exitCode ?? "?"}`;
    // 证据：主文件（stderr 优先，空的话 stdout，再兄弟文件）末尾的非空行。
    const primary = prepared.find((file) => file.lines.some((line) => line.trim()));
    const tail = primary.lines.filter((line) => line.trim()).slice(-8).map(clipLine);
    // 附上最后一句有内容的输出（跳过只有括号 / 逗号的 JSON 收尾行）：故意以非零退出的比对脚本
    // 往往没有报错行，但最后那句（如 "stats_json_differs": true）就是它停下的原因。
    const last = [...primary.lines].reverse().map((line) => line.trim()).find((line) => /[\p{L}\p{N}]/u.test(line));
    const said = last ? `（最后输出：${shortenPathsIn(last).slice(0, 60)}）` : "";
    const headline = subrunSummary(input.subruns, how) ?? `${how}，日志末尾无报错行${said}`;
    return { category: "unknown", headline: clipHeadline(headline), evidence: tail, file: primary.path };
  }

  if (input.tool === "srun" || input.tool === "salloc") {
    return { category: "no-log", headline: "srun 直接运行，没有独立的日志文件", evidence: [], file: null };
  }
  if (prepared.length > 0) {
    const redirectTarget = extractScriptRedirect(input.script);
    const headline = redirectTarget
      ? `主日志为空（脚本将输出重定向至 ${shortenPath(redirectTarget)}）`
      : "日志文件为空（0 字节，进程在产生输出前即退出）";
    return { category: "no-log", headline: clipHeadline(headline), evidence: [], file: prepared[0].path };
  }
  return { category: "no-log", headline: "日志已不可得（脚本 / 日志在失败前就被删除）", evidence: [], file: null };
}

// ---- 分组 ----

// 归一化：路径只留末段、哈希 / UUID → <h>、数字 → #，空白折叠。
export function normalizeHeadline(text) {
  return String(text || "")
    .replace(PATH_IN_TEXT_RE, (match) => `…/${match.split("/").filter(Boolean).pop() || ""}`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<h>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi, "<h>")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

// 这几类的 headline 只是同一原因的不同读数（跑了多久、想再分配多少显存、退出码几），按类别整组合并；
// 其余（Python 报错、缺文件、Slurm 报错、日志不可得的两种情形）按归一化后的原文分组。
const CATEGORY_ONLY_GROUPS = new Set(["timeout", "oom", "gpu-oom", "nan", "refused", "unknown"]);
// 按类别合并的组用通用说法作组标题：组内各条的读数不同，拿其中一条的原文当整组原因会误导
// （例如两个「原因未识别」各自的最后输出并不相同）。
const CATEGORY_GROUP_HEADLINE = {
  timeout: "超出时限",
  oom: "内存不足被系统终止",
  "gpu-oom": "显存不足",
  nan: "训练出现 NaN / 非有限梯度",
  refused: "子任务被编排脚本拒绝启动",
  unknown: "原因未识别",
};

export function diagnosisGroupKey(item) {
  const category = item?.category || "unknown";
  return CATEGORY_ONLY_GROUPS.has(category) ? category : `${category}|${normalizeHeadline(item?.headline)}`;
}

// items：[{ jobId, category, headline, endedAtMs }] → [{ key, category, headline, count, jobIds }]，
// 多的在前，同数按最近一次失败新 → 旧；headline：按类别合并的组用通用说法，其余取组内最近那条；jobIds 新 → 旧。
export function groupDiagnoses(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.jobId !== "string") continue;
    const key = diagnosisGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const at = (item) => (Number.isFinite(item.endedAtMs) ? item.endedAtMs : 0);
  return [...groups.entries()]
    .map(([key, members]) => {
      members.sort((a, b) => at(b) - at(a) || b.jobId.localeCompare(a.jobId, "en", { numeric: true }));
      const category = members[0].category;
      const headline = CATEGORY_ONLY_GROUPS.has(category) ? CATEGORY_GROUP_HEADLINE[category] : members[0].headline;
      return { key, category, headline, count: members.length, jobIds: members.map((m) => m.jobId), latest: at(members[0]) };
    })
    .sort((a, b) => b.count - a.count || b.latest - a.latest)
    .map(({ latest, ...group }) => group);
}
