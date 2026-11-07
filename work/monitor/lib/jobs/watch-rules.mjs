// 作业提醒规则（v2.62）：纯函数——规则的规整与校验、名字通配、作业归哪条规则、建议前缀、失败提醒的文案。
//
// 规则按服务器存在 job-watch.json 的 settings[serverId].rules：
//   { failNotify: boolean, longRunMinutes: number | null, patterns: string[] }
//   failNotify      本人作业失败时提醒（不依赖关注）；默认开
//   longRunMinutes  已运行超过这么多分钟的作业自动进入关注；null = 关
//   patterns        作业名通配（只认 * 与 ?，区分大小写），命中的自动进入关注；最多 12 条、每条 ≤ 64 字符
// 没存过（settings[serverId].rules 不存在）= 默认值在生效。
//
// 自动关注每条规则一组，组上记 auto.rule：名字规则是 "name:<通配>"，长作业是 "longRun"。
// 一个作业只归一条规则（名字规则按顺序先命中先得，其次长作业），所以不会进两个组、也不会被数两遍。
// 本模块不读盘、不碰时钟；通配不转正则（多个 * 的正则在长名字上会回溯爆炸）。

import { statusError } from "../status-error.mjs";
import { groupDiagnoses } from "./diagnose.mjs";

export const RULE_PATTERNS_MAX = 12;
export const RULE_PATTERN_MAX_LENGTH = 64;
export const LONG_RUN_MIN_MINUTES = 10;
export const LONG_RUN_MAX_MINUTES = 7 * 24 * 60;
// 自动关注的作业合计上限（所有服务器、所有规则加起来）。
export const AUTO_MAX_JOBS = 60;
export const SUGGESTIONS_MAX = 8;
export const LONG_RUN_RULE = "longRun";
const NAME_RULE_PREFIX = "name:";
export const DEFAULT_RULES = Object.freeze({ failNotify: true, longRunMinutes: null, patterns: Object.freeze([]) });

// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符就是要挡掉的
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const chars = (text) => [...String(text)];

const isLongRun = (value) => Number.isInteger(value) && value >= LONG_RUN_MIN_MINUTES && value <= LONG_RUN_MAX_MINUTES;
const isPattern = (value) => typeof value === "string" && value === value.trim() && value.length > 0 && chars(value).length <= RULE_PATTERN_MAX_LENGTH && !CONTROL_RE.test(value);

// 盘上的规则 → 生效的规则：缺的补默认值，不合格的部分丢掉（文件被手改坏时不至于整段失效）。
export function normalizeRules(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const patterns = [];
  for (const pattern of Array.isArray(src.patterns) ? src.patterns : []) {
    if (patterns.length >= RULE_PATTERNS_MAX) break;
    if (isPattern(pattern) && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return {
    failNotify: typeof src.failNotify === "boolean" ? src.failNotify : DEFAULT_RULES.failNotify,
    longRunMinutes: isLongRun(src.longRunMinutes) ? src.longRunMinutes : null,
    patterns,
  };
}

// 一条名字规则的校验（去掉首尾空白后返回）；不合格抛 400。
function checkedPattern(raw) {
  if (typeof raw !== "string") throw statusError("名字规则必须是文本");
  const pattern = raw.trim();
  if (!pattern) throw statusError("名字规则不能为空");
  if (chars(pattern).length > RULE_PATTERN_MAX_LENGTH) throw statusError(`名字规则每条最多 ${RULE_PATTERN_MAX_LENGTH} 个字符`);
  if (CONTROL_RE.test(pattern)) throw statusError("名字规则里不能有换行等控制字符");
  return pattern;
}

// 界面提交的改动（只带要改的字段）并进当前规则；任何一项不合格整次拒绝（400），不存半截。
// 名字规则两种改法：patterns 整份替换；addPattern / removePattern 只加 / 只删一条（先删后加）。界面用后一种——
// 它手里的列表可能是半分钟前读到的，整份发回来会把别处刚做的改动盖掉；加已有的、删没有的都不算错。
export function patchRules(current, body) {
  const next = normalizeRules(current);
  let touched = false;
  if (body.failNotify !== undefined) {
    if (typeof body.failNotify !== "boolean") throw statusError("失败提醒开关必须是开或关");
    next.failNotify = body.failNotify;
    touched = true;
  }
  if (body.longRunMinutes !== undefined) {
    if (body.longRunMinutes !== null && !isLongRun(body.longRunMinutes)) {
      throw statusError(`长作业阈值必须是 ${LONG_RUN_MIN_MINUTES}–${LONG_RUN_MAX_MINUTES} 分钟的整数，留空为关`);
    }
    next.longRunMinutes = body.longRunMinutes;
    touched = true;
  }
  if (body.patterns !== undefined) {
    if (!Array.isArray(body.patterns)) throw statusError("名字规则必须是列表");
    if (body.patterns.length > RULE_PATTERNS_MAX) throw statusError(`名字规则最多 ${RULE_PATTERNS_MAX} 条`);
    if (body.addPattern !== undefined || body.removePattern !== undefined) throw statusError("名字规则的整份替换与单条增删不能同时用");
    const patterns = [];
    for (const raw of body.patterns) {
      const pattern = checkedPattern(raw);
      if (patterns.includes(pattern)) throw statusError(`名字规则重复：${pattern}`);
      patterns.push(pattern);
    }
    next.patterns = patterns;
    touched = true;
  }
  if (body.removePattern !== undefined) {
    if (typeof body.removePattern !== "string") throw statusError("名字规则必须是文本");
    const pattern = body.removePattern.trim();
    next.patterns = next.patterns.filter((item) => item !== pattern);
    touched = true;
  }
  if (body.addPattern !== undefined) {
    const pattern = checkedPattern(body.addPattern);
    if (!next.patterns.includes(pattern)) {
      if (next.patterns.length >= RULE_PATTERNS_MAX) throw statusError(`名字规则最多 ${RULE_PATTERNS_MAX} 条`);
      next.patterns = [...next.patterns, pattern];
    }
    touched = true;
  }
  if (!touched) throw statusError("未指定要修改的提醒规则");
  return next;
}

// 通配匹配：* 任意一段（可为空）、? 恰好一个字符，其余按字面、区分大小写，整名匹配。
// 经典的「记住上一个 * 回退」写法，最坏 O(名字长度 × 规则长度)。
export function globMatch(pattern, text) {
  const p = chars(pattern);
  const s = chars(text ?? "");
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== "*" && (p[pi] === "?" || p[pi] === s[si])) {
      pi += 1;
      si += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      pi += 1;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

export const nameRule = (pattern) => `${NAME_RULE_PREFIX}${pattern}`;

// 生效规则对应的自动组 key，顺序即归属的先后。
export function ruleKeys(rules) {
  return [...rules.patterns.map(nameRule), ...(rules.longRunMinutes ? [LONG_RUN_RULE] : [])];
}

// 自动组的显示名（也用在提醒标题里）：名字规则就是通配本身。
export function ruleLabel(key, rules) {
  return key === LONG_RUN_RULE ? `运行超过 ${rules.longRunMinutes} 分钟的作业` : key.slice(NAME_RULE_PREFIX.length);
}

// 关掉一条规则后的规则（自动组的「停用这条规则」用）。
export function withoutRule(rules, key) {
  return key === LONG_RUN_RULE
    ? { ...rules, longRunMinutes: null }
    : { ...rules, patterns: rules.patterns.filter((pattern) => nameRule(pattern) !== key) };
}

// (job) → 这条作业归哪条规则的 key，都不沾 → null。按名字缓存：一轮里上千个作业多是同一批名字。
// 长作业看已运行时长（sacct 的 Elapsed；排队中的是 0，自然不命中），结束了的长作业也算，供「这一批结束」计数。
export function createRuleMatcher(rules) {
  const byName = new Map();
  const named = (name) => {
    if (!byName.has(name)) byName.set(name, rules.patterns.find((pattern) => globMatch(pattern, name)) ?? null);
    const pattern = byName.get(name);
    return pattern === null ? null : nameRule(pattern);
  };
  const longSec = rules.longRunMinutes ? rules.longRunMinutes * 60 : null;
  return (job) => {
    const key = rules.patterns.length ? named(typeof job?.name === "string" ? job.name : "") : null;
    if (key) return key;
    return longSec !== null && Number.isFinite(job?.elapsedSec) && job.elapsedSec >= longSec ? LONG_RUN_RULE : null;
  };
}

// ---- 建议前缀 ----

// 末尾的一段：纯数字（序号、日期 20261009、时分秒）、带 T 的日期时间、或带数字的十六进制哈希。
const TAIL_SEGMENT_RE = /[-_.](?:\d+|\d{6,8}T\d{4,6}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{5,})$/i;
const BARE_SEGMENT_RE = /^(?:\d+|\d{6,8}T\d{4,6}|(?=[0-9a-f]*\d)[0-9a-f]{5,})$/i;
// 名字中间的哈希段（连同其后的阶段后缀）：十六进制、5 位以上、且带数字。
const HASH_SEGMENT_RE = /[-_](?=[0-9a-f]*\d)[0-9a-f]{5,}(?:[-_].*)?$/i;
const PREFIX_MIN_LENGTH = 2;

// 作业名 → 可当规则用的前缀：先去掉哈希（连同其后的阶段后缀），再把末尾剩下的数字 / 日期 / 哈希段逐段去掉。
// 得不到像样的前缀 → null。口径跟作业队列 / 我的历史里「同名实验」的折叠（model.mjs jobBaseName）一样，只严一处：
// 折叠把任何 5 位以上的十六进制段都当哈希，纯字母的（added、faded、decade…）也算——用来折叠无妨，用来建议规则
// 就会把 xp_added_noise_1 砍成 xp、建议出一条过宽的 xp*。这里只认带数字的，纯字母的那段当普通单词留着。
export function namePrefix(name) {
  let text = String(name ?? "").trim().replace(HASH_SEGMENT_RE, "");
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(TAIL_SEGMENT_RE, "");
    if (next === text) break;
    text = next;
  }
  if (chars(text).length < PREFIX_MIN_LENGTH || chars(text).length >= RULE_PATTERN_MAX_LENGTH) return null;
  // 整个名字就是一串数字 / 哈希的没有前缀可言；带通配符或控制字符的也不建议（加成规则后含义就变了）。
  return BARE_SEGMENT_RE.test(text) || /[*?]/.test(text) || CONTROL_RE.test(text) ? null : text;
}

// entries：[{ id, name }]（近 7 天的登记 + 近 48 小时的作业，调用方合并，可以有重复）。
// → [{ prefix, pattern, count }]，多的在前、最多 max 个；已有名字规则管着的名字不再建议。
// 个数按提交算：同一个作业两边都有只算一次，数组作业的各个任务也只算一次。
// 选哪些前缀看「有多少作业的名字归到这个前缀」；显示的 count 是「加成规则后会命中多少」——xp_base* 也会命中
// xp_base_wide_3，那些要算进去，否则界面上写着 2 个、加了规则却收进来一大批。已有规则管着的不算（它们归先命中的那条）。
export function buildSuggestions(entries, rules, { max = SUGGESTIONS_MAX } = {}) {
  const covered = createRuleMatcher({ ...rules, longRunMinutes: null });
  const seen = new Set();
  const derived = new Map();
  const names = new Map();
  for (const entry of entries) {
    const root = /^\d+/.exec(String(entry?.id ?? ""))?.[0];
    if (!root || seen.has(root) || typeof entry.name !== "string" || !entry.name) continue;
    seen.add(root);
    if (covered({ name: entry.name })) continue;
    names.set(entry.name, (names.get(entry.name) || 0) + 1);
    const prefix = namePrefix(entry.name);
    if (prefix) derived.set(prefix, (derived.get(prefix) || 0) + 1);
  }
  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en");
  // 前缀里没有通配符（namePrefix 保证），「前缀*」的命中就是以它开头。
  const matched = (prefix) => [...names].reduce((sum, [name, count]) => sum + (name.startsWith(prefix) ? count : 0), 0);
  return [...derived.entries()].sort(byCount).slice(0, max)
    .map(([prefix]) => [prefix, matched(prefix)]).sort(byCount)
    .map(([prefix, count]) => ({ prefix, pattern: `${prefix}*`, count }));
}

// ---- 失败提醒的文案 ----

// 还没有诊断结果时按 sacct 状态给的说法（类别与诊断的一致，能和已诊断的同因合并）。
const STATE_CAUSE = {
  TIMEOUT: { category: "timeout", headline: "超出时限" },
  OUT_OF_MEMORY: { category: "oom", headline: "内存不足被系统终止" },
  NODE_FAIL: { category: "node", headline: "节点故障" },
};
const CAUSES_SHOWN = 3;
const IDS_SHOWN = 6;

function clip(text, max) {
  const list = chars(text);
  return list.length > max ? `${list.slice(0, max - 1).join("")}…` : String(text);
}

function causeOf(job, diagnosisOf) {
  const found = typeof diagnosisOf === "function" ? diagnosisOf(job.id) : null;
  if (found && typeof found.category === "string" && typeof found.headline === "string" && found.headline) return found;
  if (STATE_CAUSE[job.state]) return STATE_CAUSE[job.state];
  return { category: "pending", headline: Number.isInteger(job.exitCode) && job.exitCode > 0 ? `退出码 ${job.exitCode}，原因待查` : "原因待查" };
}

// 这一轮新失败的作业（新的在前）→ 一条提醒的标题与正文：按原因汇总（同因合并，口径同「我的历史」顶部的同因分组），带作业号。
// 例：「3 个作业失败」+「2 个 KeyError: 'arm'，1 个超出时限。作业号 18766、18765、18770。详情见「我的历史」。」
export function summarizeFailures(jobs, diagnosisOf = null) {
  const groups = groupDiagnoses(jobs.map((job) => {
    const cause = causeOf(job, diagnosisOf);
    return { jobId: job.id, category: cause.category, headline: cause.headline, endedAtMs: job.endAt };
  }));
  const total = jobs.length;
  // 「2 个 KeyError: …」「1 个超出时限」：原因以西文开头时与量词之间空一格。
  const counted = (group) => `${group.count} 个${/^[\x21-\x7e]/.test(group.headline) ? " " : ""}${clip(group.headline, 60)}`;
  const causes = groups.slice(0, CAUSES_SHOWN).map((group) => (total === 1 ? clip(group.headline, 100) : counted(group)));
  const rest = groups.slice(CAUSES_SHOWN);
  if (rest.length) causes.push(`另有 ${rest.reduce((sum, group) => sum + group.count, 0)} 个是其它 ${rest.length} 种原因`);
  const ids = jobs.slice(0, IDS_SHOWN).map((job) => job.id).join("、") + (total > IDS_SHOWN ? ` 等 ${total} 个` : "");
  return {
    title: total === 1 ? `作业失败：${clip(jobs[0].name || jobs[0].id, 60)}` : `${total} 个作业失败`,
    body: `${causes.join("，")}。作业号 ${ids}。详情见「我的历史」。`,
  };
}
