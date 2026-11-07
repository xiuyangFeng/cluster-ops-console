// 日志按段向前读取（v2.51）的 HTML 片段与阅读位置保持。状态见 app/log-readback.js。
// 并入原有展开区（关注区「进度依据」、失败诊断详情），不另起面板：一行文字按钮 + 一行口径说明 + 一个限高的 <pre>。
// 日志原文、路径都是不可信文本：一律 escapeHtml，<pre> 只靠 CSS 保留空白。
import { escapeHtml, formatBytes } from "../store.js";

const ROLE_LABEL = { stdout: "stdout", stderr: "stderr" };
const baseName = (p) => String(p || "").split("/").filter(Boolean).at(-1) || "";
const fmtOffset = (n) => Number(n).toLocaleString("en-US");

// 诊断模型里的文件（{ path, role, index }，index = 诊断记录里的序号，即后端的 log 参数）→ 选项。
// 同号日志标出文件名；旧记录没有角色，只写「日志 n」，不猜是 stdout 还是 stderr。
export function diagnosisLogOptions(files = []) {
  let other = 0;
  const options = [];
  for (const [i, f] of (Array.isArray(files) ? files : []).entries()) {
    const index = Number.isInteger(f?.index) ? f.index : i;
    if (index < 0 || index > 5) continue;
    const role = ROLE_LABEL[f?.role];
    if (!role && f?.role !== "sibling") other += 1;
    options.push({ value: String(index), label: role || (f?.role === "sibling" ? `同号日志 ${baseName(f?.path)}` : `日志 ${other}`), title: String(f?.path || "") });
  }
  return options;
}

export const WATCH_LOG_OPTIONS = Object.freeze([
  { value: "stdout", label: "stdout", title: "作业登记的标准输出文件" },
  { value: "stderr", label: "stderr", title: "作业登记的标准错误文件" },
]);

function attrs(action, from, jobId, log) {
  return `data-lr-action="${action}" data-lr-from="${escapeHtml(from)}" data-lr-job="${escapeHtml(jobId)}" data-lr-log="${escapeHtml(log)}"`;
}

function actionHtml(r, from, jobId, log) {
  if (r?.loading) return '<button type="button" class="text-btn lr-read" disabled>读取中…</button>';
  if (r?.stopped) return `<button type="button" class="text-btn lr-read" ${attrs("restart", from, jobId, log)} title="旧的读取位置已失效；改为从文件当前末尾往前读，与已显示内容不衔接">从当前末尾重新读取</button>`;
  if (r?.atStart) return '<span class="lr-state">已到文件开头</span>';
  if (r?.capped) return '<span class="lr-state">已达本页上限（16 段）</span>';
  const label = r?.error ? "重试" : r?.segments?.length ? "继续向前读取" : "读取前一段";
  return `<button type="button" class="text-btn lr-read" ${attrs("read", from, jobId, log)}>${label}</button>`;
}

// 口径与局限：读了多少、哪一段字节、是否与下方末尾衔接；未知不写。
function noteLines(r, from, progressCheckedAt) {
  if (!r?.segments?.length) {
    return r?.error ? [] : ["每次经 SSH 向前取至多 32 KB 尚未显示的内容，按行对齐；只读登记过的本人日志。"];
  }
  const segs = r.segments;
  const bytes = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
  const lines = [`已向前读取 ${segs.length} 段，共 ${formatBytes(bytes)}（字节 ${fmtOffset(segs[0].start)}–${fmtOffset(segs.at(-1).end)}${Number.isFinite(r.size) ? `，文件当时 ${formatBytes(r.size)}` : ""}）`];
  if (!r.atStart && segs[0].dropped > 0) lines.push("最上面一段开头不完整的一行已舍去，继续向前读取时补回。");
  if (segs.some((s) => s.noBreak)) lines.push("有一段内没有换行，按字节截取。");
  if (r.fresh) lines.push("已改为从文件当前末尾读取，与原先显示的内容不衔接。");
  else if (!r.continuous) lines.push(from === "watch" ? "这不是「进度依据」采样的那个文件，从它的当前末尾往前读。" : "与下方末尾不衔接。");
  else if (from === "watch" && r.anchorCheckedAt !== null && Number.isFinite(progressCheckedAt) && progressCheckedAt !== r.anchorCheckedAt) {
    lines.push("下方末尾已在之后的采集中更新，两者之间可能有未显示的部分。");
  }
  if (r.sameFile) lines.push("stdout 与 stderr 写在同一个文件。");
  return [...lines, ...r.notes];
}

// state = createLogReadback().view(from, jobId)；options = [{ value, label, title }]；
// progressCheckedAt：关注入口下方「进度依据」末尾的采样时刻（判断已读段与它是否还衔接）。
export function buildLogReaderHtml({ from, jobId, options = [], state = null, progressCheckedAt = null } = {}) {
  if (!options.length) return "";
  const log = options.some((o) => o.value === state?.log) ? state.log : options[0].value;
  const r = state?.readers?.get(log) || null;
  const picks = options.length > 1
    ? options.map((o) => `<button type="button" class="text-btn lr-opt" ${attrs("pick", from, jobId, o.value)} aria-pressed="${o.value === log}" title="${escapeHtml(o.title || "")}">${escapeHtml(o.label)}</button>`).join("")
    : `<span class="lr-state" title="${escapeHtml(options[0].title || "")}">${escapeHtml(options[0].label)}</span>`;
  const notes = noteLines(r, from, progressCheckedAt).map((t) => `<p class="jw-note">${escapeHtml(t)}</p>`).join("");
  const error = r?.error ? `<p class="jw-note" data-level="warn">${escapeHtml(r.error)}</p>` : "";
  const scrollKey = `${from}|${jobId}|${log}`;
  const text = r?.segments?.length ? r.segments.map((s) => s.text).join("") : "";
  return `<div class="lr" data-lr-reader="${escapeHtml(`${from}|${jobId}`)}">` +
    `<div class="lr-bar"><span class="lr-title">更早的日志</span>${picks}${actionHtml(r, from, jobId, log)}</div>` +
    error + notes +
    (text ? `<pre class="cl-diag-pre lr-pre" data-lr-scroll="${escapeHtml(scrollKey)}">${escapeHtml(text)}</pre>` : "") +
    (text && r.anchorText ? `<p class="jw-note">以下为取证时保存的末尾</p><pre class="cl-diag-pre lr-anchor">${escapeHtml(r.anchorText)}</pre>` : "") +
    "</div>";
}

// ---- 阅读位置：新读到的更早一段插在 <pre> 顶部，按「距底部的距离」恢复，正在看的那几行不跳 ----
// 渲染前 capture，morphInnerHtml 之后 restore；第一次出现的 <pre> 滚到底（紧挨下方末尾的衔接处）。
export function captureLogScroll(root) {
  const saved = new Map();
  for (const el of root?.querySelectorAll?.("[data-lr-scroll]") || []) {
    saved.set(el.getAttribute("data-lr-scroll"), el.scrollHeight - el.scrollTop);
  }
  return saved;
}

export function restoreLogScroll(root, saved) {
  for (const el of root?.querySelectorAll?.("[data-lr-scroll]") || []) {
    const bottom = saved?.get(el.getAttribute("data-lr-scroll"));
    const target = bottom === undefined ? el.scrollHeight : el.scrollHeight - bottom;
    if (Math.abs(el.scrollTop - target) >= 1) el.scrollTop = Math.max(0, target);
  }
}
