// 失败作业分类器：类别判据与优先级、Traceback 提取、证据窗口、headline 截断、归一化分组。
// 日志全部是合成的（形状参照 2026-10 集群实测的几类报错，不含真实内容）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanLogLines, diagnoseJob, DIAGNOSIS_CATEGORIES, groupDiagnoses, HEADLINE_MAX, normalizeHeadline, shortenPath } from "./diagnose.mjs";

const file = (tail, role = "stdout", path = `/w/${role}.log`) => ({ path, role, tail });
const TRACEBACK = [
  "epoch 3 loss 0.12",
  "Traceback (most recent call last):",
  '  File "/home/u/proj/train.py", line 88, in <module>',
  "    main()",
  '  File "/home/u/proj/train.py", line 40, in main',
  "    arm = cfg['arm']",
  "KeyError: 'arm'",
  "srun: error: node03: task 0: Exited with exit code 1",
].join("\n");

test("类别全集与优先级顺序固定", () => {
  assert.deepEqual(DIAGNOSIS_CATEGORIES, ["timeout", "oom", "gpu-oom", "nan", "python", "missing-file", "node", "refused", "unknown", "no-log"]);
});

test("timeout：State=TIMEOUT 或 DUE TO TIME LIMIT，优先于日志里的任何报错", () => {
  const byState = diagnoseJob({ state: "TIMEOUT", elapsedSec: 12 * 3600 + 5 * 60, files: [file(TRACEBACK)] });
  assert.deepEqual([byState.category, byState.headline], ["timeout", "超出时限（已运行 12 小时 5 分）"]);
  const byText = diagnoseJob({ state: "FAILED", files: [file("work\nslurmstepd: error: *** JOB 16183 ON node06 CANCELLED AT 2026-10-01T03:00:00 DUE TO TIME LIMIT ***\n")] });
  assert.equal(byText.category, "timeout");
  assert.equal(byText.file, "/w/stdout.log");
  assert.match(byText.evidence.at(-1), /DUE TO TIME LIMIT/);
});

test("oom：State=OUT_OF_MEMORY / oom-kill / 单独的 Killed + 137 或 9 / Bash 子进程 Killed；GPU 显存不足单列", () => {
  assert.equal(diagnoseJob({ state: "OUT_OF_MEMORY", files: [] }).category, "oom");
  assert.equal(diagnoseJob({ state: "FAILED", files: [file("slurmstepd: error: Detected 1 oom_kill event in StepId=1.batch.", "stderr")] }).category, "oom");
  const killed = diagnoseJob({ state: "FAILED", exitCode: 137, files: [file("loading\n/var/spool/slurmd/job1/slurm_script: line 9: 4242 Killed python big.py\n")] });
  assert.deepEqual([killed.category, killed.headline], ["oom", "内存不足被系统终止"]);
  const bashKilledExit9 = diagnoseJob({ state: "FAILED", exitCode: 9, signal: 0, files: [file("/public/home/u/bench.sh: line 44: 3829590 Killed                  \"$BUILD/bin/first_blood\" > /dev/null\n", "stderr")] });
  assert.deepEqual([bashKilledExit9.category, bashKilledExit9.headline], ["oom", "内存不足被系统终止"]);
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: [file("Killed\n")] }).category, "unknown", "没有 137 / 信号 9 的单独 Killed 不判内存");
  const gpu = diagnoseJob({ state: "FAILED", exitCode: 1, files: [file(`${TRACEBACK.split("\n").slice(0, 6).join("\n")}\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.30 GiB. GPU 0 has a total capacity of 23.6 GiB\n`)] });
  assert.deepEqual([gpu.category, gpu.headline], ["gpu-oom", "显存不足：试图再分配 2.30 GiB"], "显存不足优先于 Python 异常");
});

test("nan：非有限梯度优先于它抛出的 RuntimeError", () => {
  const log = "Traceback (most recent call last):\n  File \"t.py\", line 1\nRuntimeError: The total norm of order 2.0 for gradients from `parameters` is non-finite, so it cannot be clipped.\n";
  const d = diagnoseJob({ state: "FAILED", files: [file(log)] });
  assert.deepEqual([d.category, d.headline], ["nan", "训练出现 NaN / 非有限梯度"]);
  assert.equal(diagnoseJob({ state: "FAILED", files: [file("step 10 Loss is NaN, stopping\n")] }).headline, "训练出现 NaN / 非有限值");
  assert.equal(diagnoseJob({ state: "FAILED", files: [file("val_acc nan\n")] }).category, "unknown", "指标里出现 nan 不算");
});

test("python：取最后一个 Traceback 之后的异常行；证据从 Traceback 起、至多 20 行", () => {
  const d = diagnoseJob({ state: "FAILED", exitCode: 1, files: [file(TRACEBACK)] });
  assert.deepEqual([d.category, d.headline], ["python", "KeyError: 'arm'"]);
  assert.equal(d.evidence[0], "Traceback (most recent call last):");
  assert.ok(d.evidence.includes("KeyError: 'arm'"));
  assert.ok(d.evidence.length <= 20);

  // 链式异常：取最后一段；长 Traceback 证据只留靠近异常的 20 行；torchrun 的 [rankN]: 前缀剥掉。
  const frames = Array.from({ length: 40 }, (_, i) => `  File "m${i}.py", line ${i}`).join("\n");
  const chained = `Traceback (most recent call last):\n  File "a.py"\nValueError: first\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n${frames}\nFileExistsError: refuse formal run overwrite /public/newhome/u/Digital_twin/GNN/outputs/run_20261001/formal/metrics.json\n`;
  const c = diagnoseJob({ state: "FAILED", files: [file(chained)] });
  assert.equal(c.headline, "FileExistsError: refuse formal run overwrite …/formal/metrics.json");
  assert.equal(c.evidence.length, 20);
  assert.match(c.evidence.at(-1), /^FileExistsError/);
  const ranked = diagnoseJob({ state: "FAILED", files: [file("[rank0]: Traceback (most recent call last):\n[rank0]:   File \"x.py\", line 2\n[rank0]: IndexError: list index out of range\n")] });
  assert.equal(ranked.headline, "IndexError: list index out of range");

  // 没有 Traceback 但打印了异常行。
  assert.equal(diagnoseJob({ state: "FAILED", files: [file("ValueError: refusing incompatible/stale cache; use a new dir\n")] }).headline, "ValueError: refusing incompatible/stale cache; use a new dir");
});

test("文件顺序：stderr → stdout → 兄弟文件；根因只在兄弟文件里也能找到", () => {
  const d = diagnoseJob({
    state: "FAILED",
    files: [file("startup ok\nloading data\n", "stdout", "/w/job_18537_4294967294.out"), file(TRACEBACK, "sibling", "/w/logs/arm_x_18537.log")],
  });
  assert.deepEqual([d.category, d.headline, d.file], ["python", "KeyError: 'arm'", "/w/logs/arm_x_18537.log"]);
  const both = diagnoseJob({ state: "FAILED", files: [file("ValueError: from stdout\n", "stdout"), file("TypeError: from stderr\n", "stderr")] });
  assert.equal(both.headline, "TypeError: from stderr");
});

test("missing-file / node / unknown / no-log", () => {
  const missing = diagnoseJob({ state: "FAILED", exitCode: 2, files: [file("cp: cannot stat '/public/newhome/u/a/b/c/input.json': No such file or directory\n")] });
  assert.deepEqual([missing.category, missing.headline], ["missing-file", "找不到文件 …/c/input.json"]);
  const bash = diagnoseJob({ state: "FAILED", files: [file("/var/spool/slurmd/job9/slurm_script: line 4: ./run.sh: No such file or directory\n")] });
  assert.equal(bash.headline, "找不到文件 ./run.sh");

  assert.deepEqual(Object.values(diagnoseJob({ state: "NODE_FAIL", nodes: "node05", files: [] })).slice(0, 2), ["node", "节点故障（node05）"]);
  const stepd = diagnoseJob({ state: "FAILED", files: [file("slurmstepd: error: execve(): python: Permission denied\n", "stderr")] });
  assert.deepEqual([stepd.category, stepd.headline], ["node", "Slurm 报错：execve(): python: Permission denied"]);

  const unknown = diagnoseJob({ state: "FAILED", exitCode: 1, files: [file("a\n\nb\n\u001b[32mdone\u001b[0m\n")] });
  assert.deepEqual([unknown.category, unknown.headline, unknown.evidence], ["unknown", "退出码 1，日志末尾无报错行（最后输出：done）", ["a", "b", "done"]]);
  assert.equal(diagnoseJob({ state: "FAILED", signal: 11, files: [file("x")] }).headline, "被信号 11 终止，日志末尾无报错行（最后输出：x）");
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: [file('{\n "stats_json_differs": true\n}\n')] }).headline,
    '退出码 1，日志末尾无报错行（最后输出："stats_json_differs": true）', "跳过 JSON 收尾的括号行");

  // 编排型作业：主日志最后一句是某个子任务的「END … 0」，不能当成原因念出来。
  const xp = [file("2026-10-09T12:58:08+0800 END W1_f1 train 0\n")];
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, subruns: { ended: 16, failed: 0, failures: [] } }).headline,
    "退出码 1，但主日志记录的 16 个子任务全部以 0 结束");
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, subruns: { ended: 9, failed: 2, failures: [{ run: "M1G_f3", phase: "train", code: -15 }, { run: "M1G_f4", phase: "train", code: -15 }] } }).headline,
    "子任务 M1G_f3 train 被信号 15 终止（共 2 个子任务以非 0 结束），其日志末尾无报错行");
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, subruns: { ended: 3, failed: 1, failures: [{ run: "A", phase: "eval", code: 2 }] } }).headline,
    "子任务 A eval 退出码 2，其日志末尾无报错行");
  assert.match(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, subruns: null }).headline, /^退出码 1，日志末尾无报错行/, "不是编排型作业照旧");

  // 被拒绝启动的子任务在主日志里没有任何一行，原因只在编排脚本的状态文件里。
  const dispatch = { arms: 18, unfinished: 2, items: [
    { name: "W1_f2", status: "refused", reason: "run 目录已有内容，拒绝覆盖：/public/newhome/u/proj/runs/exp_1/W1_f2" },
    { name: "W1_f3", status: "refused", reason: "run 目录已有内容，拒绝覆盖：/public/newhome/u/proj/runs/exp_1/W1_f3" },
  ] };
  const refused = diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, subruns: { ended: 16, failed: 0, failures: [] }, dispatch });
  assert.deepEqual([refused.category, refused.headline, refused.file], ["refused", "2 个子任务被编排脚本拒绝启动：run 目录已有内容，拒绝覆盖：…/exp_1/W1_f2", null]);
  assert.deepEqual(refused.evidence, dispatch.items.map((item) => `${item.name}  ${item.reason}`));
  assert.match(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, dispatch: { arms: 30, unfinished: 11, items: Array.from({ length: 8 }, (_, i) => ({ name: `A${i}`, status: "refused", reason: null })) } }).headline,
    /^至少 8 个子任务被编排脚本拒绝启动$/, "只带回前 8 个时不报确数");
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: [file("loss is nan\n")], dispatch }).category, "nan", "日志里有报错行时以日志为准");
  assert.equal(diagnoseJob({ state: "FAILED", exitCode: 1, files: xp, dispatch: { arms: 4, unfinished: 1, items: [{ name: "A", status: "failed", reason: null }] } }).category, "unknown", "不是 refused 的不归这一类");

  const none = diagnoseJob({ state: "FAILED", exitCode: 1, files: [] });
  assert.deepEqual([none.category, none.headline, none.evidence, none.file], ["no-log", "日志已不可得（脚本 / 日志在失败前就被删除）", [], null]);
  assert.equal(diagnoseJob({ state: "FAILED", tool: "srun", files: [file("   \n")] }).headline, "srun 直接运行，没有独立的日志文件");
  const emptyLog = diagnoseJob({ state: "FAILED", exitCode: 1, files: [file("", "stdout", "/w/job_1.out")] });
  assert.deepEqual([emptyLog.category, emptyLog.headline, emptyLog.file], ["no-log", "日志文件为空（0 字节，进程在产生输出前即退出）", "/w/job_1.out"]);
  const redirected = diagnoseJob({
    state: "FAILED",
    exitCode: 1,
    files: [file("", "stdout", "/w/job_2.out")],
    script: '#!/bin/bash\npython run.py >> "$d/process.out" 2>&1\n',
  });
  assert.deepEqual([redirected.category, redirected.headline, redirected.file], ["no-log", "主日志为空（脚本将输出重定向至 $d/process.out）", "/w/job_2.out"]);
  const cmakeFail = diagnoseJob({
    state: "FAILED",
    exitCode: 1,
    files: [file('CMake Error at /usr/share/cmake/Modules/CMakeTestCXXCompiler.cmake:62 (message):\n  The C++ compiler is not able to compile a simple test program.\n-- Configuring incomplete, errors occurred!\nSee also "/public/home/u/build/CMakeFiles/CMakeError.log".\n')],
  });
  assert.deepEqual([cmakeFail.category, cmakeFail.headline], ["unknown", "编译 / 构建失败：CMake Error at …/Modules/CMakeTestCXXCompiler.cmake:62 (message):"]);
});

test("截断：headline ≤ 160、证据每行 ≤ 300；\\r 进度条只留最后一段", () => {
  const d = diagnoseJob({ state: "FAILED", files: [file(`ValueError: ${"v".repeat(500)}\n`)] });
  assert.equal(d.headline.length, HEADLINE_MAX);
  assert.ok(d.headline.endsWith("…"));
  assert.ok(d.evidence.every((line) => line.length <= 300));
  assert.deepEqual(cleanLogLines("10%|#   \r50%|#####  \r100%|##########\nok"), ["100%|##########", "ok"]);
  assert.equal(shortenPath("/public/newhome/u/outputs/cfd_auto_trial_20260927/case.json"), "…/cfd_auto_trial_20260927/case.json");
  assert.equal(shortenPath("/tmp/x.log"), "/tmp/x.log");
});

test("归一化分组：数字 / 路径中段 / 哈希归一，多的在前，jobIds 新 → 旧", () => {
  assert.equal(normalizeHeadline("FileNotFoundError: …/trial_7/case_12.json"), normalizeHeadline("FileNotFoundError: …/trial_9/case_3.json"));
  assert.equal(normalizeHeadline("ValueError: run 3f9a1c2e failed"), "ValueError: run <h> failed");
  assert.equal(normalizeHeadline("KeyError: 'arm'"), "KeyError: 'arm'");
  assert.notEqual(normalizeHeadline("KeyError: 'arm'"), normalizeHeadline("KeyError: 'leg'"));
  const items = [
    { jobId: "1", category: "python", headline: "KeyError: 'arm'", endedAtMs: 100 },
    { jobId: "2", category: "timeout", headline: "超出时限（已运行 3 小时）", endedAtMs: 300 },
    { jobId: "3", category: "python", headline: "KeyError: 'arm'", endedAtMs: 200 },
    { jobId: "4", category: "timeout", headline: "超出时限（已运行 12 小时 5 分）", endedAtMs: 50 },
    { jobId: "5", category: "missing-file", headline: "KeyError: 'arm'", endedAtMs: 400 },
    { jobId: "6", category: "python", headline: "IndexError: list index out of range", endedAtMs: 500 },
    null,
  ];
  // 超时按类别整组合并（读数不同也是同一原因）；同一报错不同类别不混；同数按最近一次新 → 旧。
  assert.deepEqual(groupDiagnoses(items), [
    { key: "timeout", category: "timeout", headline: "超出时限", count: 2, jobIds: ["2", "4"] },
    { key: "python|KeyError: 'arm'", category: "python", headline: "KeyError: 'arm'", count: 2, jobIds: ["3", "1"] },
    { key: "python|IndexError: list index out of range", category: "python", headline: "IndexError: list index out of range", count: 1, jobIds: ["6"] },
    { key: "missing-file|KeyError: 'arm'", category: "missing-file", headline: "KeyError: 'arm'", count: 1, jobIds: ["5"] },
  ]);
  assert.deepEqual(groupDiagnoses(null), []);
});

test("按类别合并的组用通用组标题，不拿某一条的读数当整组原因；未识别类也一样", () => {
  const groups = groupDiagnoses([
    { jobId: "1", category: "unknown", headline: "退出码 1，日志末尾无报错行（最后输出：a）", endedAtMs: 2 },
    { jobId: "2", category: "unknown", headline: "退出码 1，日志末尾无报错行（最后输出：b）", endedAtMs: 1 },
    { jobId: "3", category: "timeout", headline: "超出时限（已运行 3 小时）", endedAtMs: 3 },
    { jobId: "4", category: "timeout", headline: "超出时限（已运行 12 小时）", endedAtMs: 4 },
    { jobId: "5", category: "python", headline: "KeyError: 'arm'", endedAtMs: 5 },
  ]);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.equal(byKey.unknown.headline, "原因未识别");
  assert.equal(byKey.timeout.headline, "超出时限");
  assert.equal(byKey["python|KeyError: 'arm'"].headline, "KeyError: 'arm'");
});

