import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentDiagnosisPrompt, CATEGORY_TEXT, causesModel, diagnosisIndex, diagnosisModel, NO_LOG_TEXT } from "./cluster-diagnosis-model.js";
import { buildHistoryModel } from "./cluster-history-model.js";
import { buildHistoryCausesHtml, buildHistoryFiltersHtml, buildHistoryRowsHtml } from "./cluster-view.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
// 北京时间 2026-10-05 12:00
const NOW = Date.UTC(2026, 9, 5, 4, 0, 0);

const failed = (id, name, extra = {}) => ({
  kind: "job", outcome: "failed", id, name, state: "FAILED", exitCode: 1, signal: 0, cancelledBy: null,
  endAt: NOW - HOUR, elapsedSec: 600, nodes: "node05", partition: "CPU", ...extra,
});
const doneJob = (id) => ({ kind: "job", outcome: "completed", id, name: `ok-${id}`, state: "COMPLETED", exitCode: 0, signal: 0, endAt: NOW - 2 * HOUR, elapsedSec: 60, nodes: "node01", partition: "CPU" });

// GET /api/jobs：一个单独失败的作业、一组同名失败（组内三个，均为 KeyError）、一个超时、一个日志已不可得、一个取消、一个完成。
function history(overrides = {}) {
  return {
    schemaVersion: 1, serverId: "server-01", windowHours: 48, state: "ok", user: "kai",
    checkedAt: NOW - 2 * MIN, total: 9, kept: 9, truncated: false,
    summary: { ended: 9, completed: 1, failed: 7, cancelled: 1, other: 0, running: 0, pending: 0 },
    rows: [
      failed("18537", "arm_train", { diagnosis: { category: "python", headline: "KeyError: 'arm'" } }),
      {
        kind: "group", outcome: "failed", key: "FAILED|cfa-agiter21", state: "FAILED", label: "cfa-agiter21-*", count: 3,
        stages: [], firstEndAt: NOW - 3 * HOUR, lastEndAt: NOW - 2 * HOUR, elapsedMinSec: 60, elapsedMaxSec: 60,
        nodeLists: ["node05"], partitions: ["CPU"], exits: [{ exitCode: 1, signal: 0, count: 3 }],
        children: [
          failed("18601", "cfa-agiter21-aaaaaa-cfd1", { diagnosis: { category: "python", headline: "KeyError: 'arm'" } }),
          failed("18600", "cfa-agiter21-bbbbbb-cfd1", { diagnosis: { category: "python", headline: "KeyError: 'arm'" } }),
          failed("18599", "cfa-agiter21-cccccc-cfd1", { diagnosis: null }),
        ],
        more: 0,
      },
      failed("18400", "census", { state: "TIMEOUT", exitCode: 0, diagnosis: { category: "timeout", headline: "超出时限（上限 12 小时，跑了 12 小时）" } }),
      failed("18300", "tmp_agent_job", { diagnosis: { category: "no-log", headline: "日志已不可得" } }),
      { kind: "job", outcome: "cancelled", id: "18200", name: "x", state: "CANCELLED", exitCode: 0, signal: 15, cancelledBy: "1001", endAt: NOW - HOUR, elapsedSec: 5, nodes: "node01", partition: "CPU", diagnosis: { category: "unknown", headline: "不该显示" } },
      failed("18100", "boot", { state: "BOOT_FAIL", diagnosis: { category: "node", headline: "不在诊断的终态里" } }),
      doneJob("18000"),
    ],
    rowsOmitted: 0,
    ...overrides,
  };
}

const item = (jobId, category, headline, extra = {}) => ({
  jobId, serverId: "server-01", name: `job-${jobId}`, state: "FAILED", exitCode: 1, endedAtMs: NOW - HOUR,
  category, headline, evidence: [], files: [], hasScript: false, source: "registry", ...extra,
});

// GET /api/jobs/diagnoses
function diagnoses(overrides = {}) {
  return {
    items: [
      item("18537", "python", "KeyError: 'arm'", {
        evidence: ["Traceback (most recent call last):", "  File \"train.py\", line 12, in <module>", "    cfg['arm']", "KeyError: 'arm'"],
        files: [{ path: "/home/kai/logs/arm_train_18537.log", tail: "…" }, { path: "/home/kai/logs/slurm-18537.out", tail: "" }],
        hasScript: true,
      }),
      item("18601", "python", "KeyError: 'arm'", { evidence: ["KeyError: 'arm'"] }),
      item("18600", "python", "KeyError: 'arm'", { evidence: ["KeyError: 'arm'"] }),
      // 组内第三个：历史行里 diagnosis 还是 null，诊断接口里已经有了
      item("18599", "gpu-oom", "CUDA out of memory: 试图再分配 2.3 GiB", { evidence: ["torch.OutOfMemoryError: CUDA out of memory."] }),
      item("18400", "timeout", "超出时限（上限 12 小时，跑了 12 小时）", { evidence: ["*** JOB 18400 CANCELLED AT … DUE TO TIME LIMIT ***"], source: "scontrol", files: [{ path: "/home/kai/census.out", tail: "" }] }),
      item("18300", "no-log", "日志已不可得", { source: "none" }),
      // 30 天前的同因作业：不在这份 48 小时历史里，不计入合并
      item("15000", "python", "KeyError: 'arm'", { endedAtMs: NOW - 20 * 24 * HOUR }),
    ],
    groups: [
      { key: "python|KeyError: 'arm'", category: "python", headline: "KeyError: 'arm'", count: 4, jobIds: ["18537", "18601", "18600", "15000"] },
      { key: "timeout|超出时限", category: "timeout", headline: "超出时限（上限 12 小时）", count: 1, jobIds: ["18400"] },
    ],
    ...overrides,
  };
}

const allExpanded = new Set(["FAILED|cfa-agiter21"]);
const model = (input = {}) => buildHistoryModel({ data: history(), diagnoses: diagnoses(), now: NOW, ...input, view: { expanded: allExpanded, ...(input.view || {}) } });
const byId = (rows, id) => rows.find((r) => r.kind === "job" && r.id === id);

test("诊断接口不可用（旧后端 404 / 模块关闭 / 形状不对）：没有任何诊断，HTML 与没有诊断时逐字一致", () => {
  const plain = buildHistoryModel({ data: history(), now: NOW, view: { expanded: allExpanded } });
  const baseline = buildHistoryRowsHtml(plain.rows);
  for (const response of [null, { disabled: true }, { items: "x" }, "oops"]) {
    const m = buildHistoryModel({ data: history(), diagnoses: response, now: NOW, view: { expanded: allExpanded } });
    assert.ok(m.rows.every((r) => !r.diag), "行上不带诊断");
    assert.deepEqual(m.causes, { items: [], more: 0, active: null });
    assert.equal(m.cause, null);
    assert.equal(buildHistoryRowsHtml(m.rows), baseline);
    assert.equal(buildHistoryCausesHtml(m.causes), "");
  }
  assert.doesNotMatch(baseline, /cl-diag|cl-has-diag/);
  assert.equal(diagnosisIndex({ disabled: true, items: [] }), null);
  // 历史本身不是 ok（未采集 / 读取失败）：诊断也不出现
  const none = buildHistoryModel({ data: history({ state: "none", rows: [] }), diagnoses: diagnoses(), now: NOW });
  assert.deepEqual(none.causes.items, []);
});

test("原因行：只给失败 / 超时 / 内存不足 / 节点故障；分类标签 + 等宽 headline，完整内容在悬停提示", () => {
  const { rows } = model();
  const at = (id) => byId(rows, id)?.diag ?? null;
  assert.deepEqual([at("18537").category, at("18537").label, at("18537").headline], ["python", "程序报错", "KeyError: 'arm'"]);
  assert.deepEqual([at("18599").category, at("18599").label], ["gpu-oom", "显存不足"], "行上没有时退到诊断接口里的同一作业");
  assert.deepEqual([at("18400").label, at("18400").headline], ["超时", "超出时限（上限 12 小时，跑了 12 小时）"]);
  assert.equal(at("18200"), null, "取消的作业不显示原因");
  assert.equal(at("18100"), null, "BOOT_FAIL 不在诊断的终态里");
  assert.equal(at("18000"), null);

  const html = buildHistoryRowsHtml(rows);
  assert.match(html, /<tr data-kind="problem" data-level="critical" class="cl-has-diag" data-cl-diag="18537" aria-expanded="false" tabindex="0" title="作业 18537 · arm_train/);
  assert.match(html, /<tr class="cl-diag" data-kind="problem" data-level="critical"><td class="cl-diag-cell" colspan="6"><div class="cl-diag-line" data-cl-diag="18537"><span class="cl-group-caret" aria-hidden="true">▸<\/span><span class="cl-diag-tag" data-category="python">程序报错<\/span><span class="cl-diag-headline" title="KeyError: &#039;arm&#039;">KeyError: &#039;arm&#039;<\/span><\/div><\/td><\/tr>/);
  // 组内作业的原因行跟着缩进（同样带 cl-group-child / data-parent）
  assert.match(html, /<tr class="cl-diag cl-group-child" data-kind="problem" data-level="critical" data-parent="FAILED\|cfa-agiter21">/);
  // 每个分类都有中文标签；认不出的分类写「原因未识别」
  const categories = Object.keys(CATEGORY_TEXT);
  assert.deepEqual(categories, ["timeout", "oom", "gpu-oom", "nan", "python", "missing-file", "node", "refused", "unknown", "no-log"]);
  for (const category of [...categories, "weird"]) {
    const index = diagnosisIndex({ items: [item("1", category, "h")], groups: [] });
    const d = diagnosisModel(failed("1", "a"), index);
    assert.equal(d.label, CATEGORY_TEXT[category] || "原因未识别");
    if (category !== "no-log") assert.match(buildHistoryRowsHtml([{ ...jobRowOf(d), diag: d }]), new RegExp(`data-category="${category}">${d.label.replace(/[()]/g, "\\$&")}<`));
  }
});

// 只为渲染单行准备的最小作业行模型。
function jobRowOf(d) {
  return { kind: "job", id: d.jobId, name: "a", rowKind: "problem", level: "critical", state: { label: "失败", tone: "critical" }, endText: "—", elapsedText: "—", where: "—", exitText: "—", title: "", child: false, parent: "" };
}

test("日志已不可得：只写一句灰字，不出分类标签；没有可展开的内容就不可点", () => {
  const d = byId(model().rows, "18300").diag;
  assert.deepEqual([d.noLog, d.expandable], [true, false]);
  const html = buildHistoryRowsHtml([{ ...jobRowOf(d), diag: d }]);
  assert.ok(html.includes(`<div class="cl-diag-line"><span class="cl-diag-muted">${NO_LOG_TEXT}</span></div>`));
  assert.equal(NO_LOG_TEXT, "日志已不可得（脚本或日志在失败前已被删除）");
  assert.doesNotMatch(html, /cl-diag-tag|data-cl-diag=|tabindex/);
  // 脚本还在（作业结束前用 scontrol 取到了）：仍可展开看脚本
  const withScript = diagnosisModel(failed("9", "a"), diagnosisIndex({ items: [item("9", "no-log", "", { hasScript: true })] }));
  assert.equal(withScript.expandable, true);
});

test("展开：证据保留空白、日志路径可复制、来源说明与「查看提交脚本」；展开状态跟着 view 走，重绘后仍展开", () => {
  const view = { diagOpen: new Set(["18537"]) };
  const first = model({ view });
  const d = byId(first.rows, "18537").diag;
  assert.deepEqual([d.open, d.expandable, d.files.map((f) => f.path)], [true, true, ["/home/kai/logs/arm_train_18537.log", "/home/kai/logs/slurm-18537.out"]]);
  const html = buildHistoryRowsHtml(first.rows);
  assert.match(html, /data-cl-diag="18537" aria-expanded="true" tabindex="0"/);
  assert.match(html, /<span class="cl-group-caret" aria-hidden="true">▾<\/span><span class="cl-diag-tag"/);
  assert.ok(html.includes('<pre class="cl-diag-pre cl-diag-evidence">Traceback (most recent call last):\n  File &quot;train.py&quot;, line 12, in &lt;module&gt;\n    cfg[&#039;arm&#039;]\nKeyError: &#039;arm&#039;</pre>'));
  assert.ok(html.includes('<li><code class="cl-diag-path" title="/home/kai/logs/arm_train_18537.log">/home/kai/logs/arm_train_18537.log</code><button type="button" class="text-btn cl-diag-copy" data-cl-diag-copy="/home/kai/logs/arm_train_18537.log" title="复制日志路径">复制</button></li>'));
  assert.ok(html.includes('<button type="button" class="text-btn cl-diag-script-btn" data-cl-diag-script="18537" aria-expanded="false">查看提交脚本</button><span class="cl-diag-muted">日志路径取自作业运行时的登记</span>'));
  // 另一行没展开：没有详情
  assert.equal(byId(first.rows, "18601").diag.open, false);

  // 新一轮采集（数据换新、作业顺序变了）：同一个 view 照样展开 18537
  const next = history();
  next.rows = [failed("18700", "new_job", { diagnosis: { category: "oom", headline: "内存不足被系统终止（申请 32G）" } }), ...next.rows];
  const second = buildHistoryModel({ data: next, diagnoses: diagnoses(), now: NOW + 5 * MIN, view: { expanded: allExpanded, ...view } });
  assert.equal(byId(second.rows, "18537").diag.open, true);
  assert.equal(byId(second.rows, "18700").diag.label, "内存不足");
  assert.equal(byId(second.rows, "18700").diag.expandable, false, "诊断接口里还没有这个作业的详情：只显示原因行");

  // 来源说明 / 没有脚本
  const timeout = byId(model({ view: { diagOpen: new Set(["18400"]) } }).rows, "18400").diag;
  const timeoutHtml = buildHistoryRowsHtml([{ ...jobRowOf(timeout), diag: timeout }]);
  assert.ok(timeoutHtml.includes('<span class="cl-diag-muted">提交脚本已不可得</span><span class="cl-diag-muted">日志路径取自 scontrol</span>'));
});

test("提交脚本：按需读取的各个状态（未读 / 读取中 / 读到 / 已不可得 / 失败可重试）", () => {
  const script = (entry, open = true) => byId(model({ view: { diagOpen: new Set(["18537"]), scriptOpen: open ? new Set(["18537"]) : new Set() }, scripts: new Map(entry ? [["18537", entry]] : []) }).rows, "18537").diag;
  const html = (d) => buildHistoryRowsHtml([{ ...jobRowOf(d), diag: d }]);

  assert.equal(script(null, false).script.state, "idle");
  assert.match(html(script({ state: "loading" })), /data-cl-diag-script="18537" aria-expanded="false" disabled>读取中…<\/button>/);
  const ok = html(script({ state: "ok", script: "#!/bin/bash\n#SBATCH -o logs/%j.out\npython train.py --x '<y>'\n" }));
  assert.match(ok, /aria-expanded="true">收起脚本<\/button>/);
  assert.ok(ok.includes('<pre class="cl-diag-pre cl-diag-script">#!/bin/bash\n#SBATCH -o logs/%j.out\npython train.py --x &#039;&lt;y&gt;&#039;\n</pre>'));
  // 读到了但收起：按钮回到「查看提交脚本」，不画脚本
  const closed = html(script({ state: "ok", script: "echo hi" }, false));
  assert.match(closed, />查看提交脚本<\/button>/);
  assert.doesNotMatch(closed, /cl-diag-script"/);
  assert.match(html(script({ state: "ok", script: null })), /<p class="cl-diag-muted">脚本已不可得<\/p>/);
  const failedHtml = html(script({ state: "error", error: "HTTP 500 <b>" }));
  assert.match(failedHtml, />重新读取脚本<\/button>/);
  assert.match(failedHtml, /<p class="cl-diag-muted">脚本读取失败：HTTP 500 &lt;b&gt;<\/p>/);
});

test("同因合并：只算这份 48 小时历史里的作业，两个以上才合并；点击筛出这些作业，芯片不按下，可回到全部", () => {
  const m = model();
  assert.deepEqual(m.causes.items.map((c) => [c.key, c.count, c.headline, c.active]), [["python|KeyError: 'arm'", 3, "KeyError: 'arm'", false]]);
  assert.equal(m.causes.more, 0);
  const html = buildHistoryCausesHtml(m.causes);
  assert.equal(html, '<button type="button" class="cl-diag-cause" data-cl-diag-cause="python|KeyError: &#039;arm&#039;" aria-pressed="false" title="只看这 3 个作业"><span class="cl-diag-cause-count">3 个失败同因：</span><span class="cl-diag-headline">KeyError: &#039;arm&#039;</span></button>');

  const filtered = model({ view: { cause: "python|KeyError: 'arm'", filter: "done" } });
  assert.equal(filtered.cause, "python|KeyError: 'arm'");
  assert.deepEqual(filtered.rows.map((r) => r.id), ["18537", "18601", "18600"], "组内作业拉平列出，不受「完成」芯片影响");
  assert.ok(filtered.rows.every((r) => r.kind === "job" && !r.child && r.diag?.category === "python"));
  assert.deepEqual(filtered.filters.map((f) => f.active), [false, false, false]);
  assert.doesNotMatch(buildHistoryFiltersHtml(filtered.filters), /aria-pressed="true"/);
  const activeHtml = buildHistoryCausesHtml(filtered.causes);
  assert.match(activeHtml, /aria-pressed="true" title="再点一次显示全部作业"/);
  assert.match(activeHtml, /<div class="cl-diag-causes-foot"><button type="button" class="text-btn cl-diag-all" data-cl-diag-cause-clear="1">显示全部<\/button><\/div>$/);

  // 分组消失（作业滑出窗口 / 诊断换新）：筛选自动作废
  const gone = model({ view: { cause: "nope" } });
  assert.equal(gone.cause, null);
  assert.equal(gone.rows.length, 10);
});

test("同因合并：最多 3 类、其余写「另有 N 类」，正在筛的那类总在其中；组里没带回的写「还有 N 个」", () => {
  const rows = [];
  const items = [];
  const groups = [];
  // 五类，个数 6 / 5 / 4 / 3 / 2；每类只有第一个作业出现在历史行里，其余靠结束时刻落在窗口内
  [6, 5, 4, 3, 2].forEach((count, g) => {
    const ids = Array.from({ length: count }, (_, i) => `${g + 1}0${i}`);
    rows.push(failed(ids[0], `g${g}`));
    for (const id of ids) items.push(item(id, "python", `E${g}`, { endedAtMs: NOW - 10 * HOUR }));
    groups.push({ key: `k${g}`, category: "python", headline: `E${g}`, count, jobIds: ids });
  });
  const data = history({ rows });
  const response = { items, groups };
  const m = buildHistoryModel({ data, diagnoses: response, now: NOW });
  assert.deepEqual(m.causes.items.map((c) => c.key), ["k0", "k1", "k2"]);
  assert.equal(m.causes.more, 2);
  assert.match(buildHistoryCausesHtml(m.causes), /<span class="cl-diag-muted">另有 2 类<\/span>/);

  const picked = buildHistoryModel({ data, diagnoses: response, now: NOW, view: { cause: "k4" } });
  assert.deepEqual(picked.causes.items.map((c) => [c.key, c.active]), [["k0", false], ["k1", false], ["k4", true]]);
  assert.equal(picked.causes.more, 2);
  assert.deepEqual(picked.rows.map((r) => (r.kind === "more" ? r.text : r.id)), ["500", "还有 1 个没有列出…"]);

  // 窗口外的作业不算：k4 的两个都在 3 天前结束 → 只剩行里的一个，不够合并
  for (const it of items) if (it.jobId.startsWith("5")) it.endedAtMs = NOW - 72 * HOUR;
  const aged = causesModel(diagnosisIndex(response), { historyIds: new Set(["500"]), windowStart: NOW - 48 * HOUR });
  assert.ok(!aged.items.some((c) => c.key === "k4"));
});

test("转义：日志尾部、路径、headline、分组 key 都是不可信文本", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const response = {
    items: [item("18537", "python", `ValueError: ${evil}`, { evidence: [evil, "  \"quoted\" & 'single'"], files: [{ path: `/tmp/"${evil}".log` }], hasScript: true })],
    groups: [{ key: `k"${evil}`, category: "python", headline: evil, jobIds: ["18537", "18601"] }],
  };
  const m = model({ diagnoses: response, view: { diagOpen: new Set(["18537"]), scriptOpen: new Set(["18537"]) }, scripts: new Map([["18537", { state: "ok", script: `echo ${evil}` }]]) });
  const html = buildHistoryRowsHtml(m.rows) + buildHistoryCausesHtml(m.causes);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-cl-diag-copy="\/tmp\/&quot;&lt;img/);
  assert.match(html, /data-cl-diag-cause="k&quot;&lt;img/);
  assert.ok(html.includes("  &quot;quoted&quot; &amp; &#039;single&#039;"), "证据行原样保留前导空白");
});

test("防御：诊断条目缺字段 / 畸形不抛错", () => {
  const index = diagnosisIndex({ items: [null, 3, { jobId: null }, { jobId: 7, category: "python", evidence: "x", files: [null, { path: "" }, "/a.log"] }], groups: [null, { key: 1 }, { key: "g", jobIds: [7, 7, 8] }] });
  assert.equal(index.items.size, 1);
  assert.deepEqual(index.groups.map((g) => g.jobIds), [["7", "7", "8"]]);
  const d = diagnosisModel(failed("7", "a", { diagnosis: { category: "" } }), index);
  assert.deepEqual([d.label, d.headline, d.evidence, d.files], ["程序报错", "程序报错", [], [{ path: "/a.log", role: null, index: 2 }]]);
  assert.equal(d.expandable, true);
  // 同一作业号在分组里重复：只算一次（8 不在窗口内）
  assert.deepEqual(causesModel(index, { historyIds: new Set(["7"]) }).items, []);
});

test("同因提示：「原因未识别」「日志已不可得」不算同因，不出提示", () => {
  const index = diagnosisIndex({
    items: ["1", "2", "3", "4"].map((jobId) => ({ jobId, category: Number(jobId) < 3 ? "unknown" : "no-log", headline: "x", evidence: [], files: [], hasScript: false })),
    groups: [
      { key: "unknown", category: "unknown", headline: "原因未识别", count: 2, jobIds: ["1", "2"] },
      { key: "no-log|x", category: "no-log", headline: "x", count: 2, jobIds: ["3", "4"] },
    ],
  });
  assert.deepEqual(causesModel(index, { historyIds: new Set(["1", "2", "3", "4"]) }).items, []);
});

test("复制排障上下文：将作业元信息、诊断归因、日志路径、报错证据与已加载脚本拼成结构化 Prompt", () => {
  const m = model({
    view: { diagOpen: new Set(["18537"]), scriptOpen: new Set(["18537"]) },
    scripts: new Map([["18537", { state: "ok", script: "#!/bin/bash\npython train.py\n" }]]),
  });
  const row = m.rows.find((r) => r.id === "18537");
  const prompt = buildAgentDiagnosisPrompt(row.diag, row);
  assert.match(prompt, /请帮我排查这个失败的 Slurm 作业：/);
  assert.match(prompt, /- 作业号：18537（arm_train）/);
  assert.match(prompt, /- 诊断归因：\[程序报错\] KeyError: 'arm'/);
  assert.match(prompt, /- 日志文件：\/home\/kai\/logs\/arm_train_18537\.log/);
  assert.match(prompt, /KeyError: 'arm'/);
  assert.match(prompt, /提交脚本：\n```bash\n#!\/bin\/bash\npython train\.py/);
  const html = buildHistoryRowsHtml([row]);
  assert.match(html, />复制排障上下文<\/button>/);
});
