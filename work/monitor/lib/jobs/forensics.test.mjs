import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { diagnoseJob } from "./diagnose.mjs";
import {
  buildForensicsInvocation,
  FORENSICS_BATCH_MAX,
  FORENSICS_REMOTE_COMMAND,
  FORENSICS_TAIL_BYTES,
  loadForensicsScript,
  parseForensicsOutput,
} from "./forensics.mjs";

const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const pyTest = PYTHON && process.platform !== "win32" ? test : test.skip;

test("调用组装：远端命令是常量，作业号与路径模板只走 stdin；非法作业号不进远端；批量封顶", () => {
  const jobs = [
    { id: "18537", reg: { workDir: "/w", stdout: "/w/o_%j.log", stderr: null, command: "/w/run.sh", name: "x", user: "kai", firstSeenAt: 1 } },
    { id: "1;rm -rf /", reg: null },
    { id: "18006_3", reg: null },
    ...Array.from({ length: 30 }, (_, i) => ({ id: String(20000 + i), reg: null })),
  ];
  const inv = buildForensicsInvocation({ server: { id: "s1", host: "cluster" }, jobs });
  assert.equal(inv.file, "ssh");
  assert.equal(inv.args.at(-1), FORENSICS_REMOTE_COMMAND);
  assert.ok(inv.args.includes("cluster"));
  assert.ok(!inv.args.join(" ").includes("18537"), "作业号不出现在命令行里");
  const [first, second] = inv.input.split("\n");
  assert.equal(JSON.parse(first), loadForensicsScript());
  const payload = JSON.parse(second);
  assert.equal(payload.jobs.length, FORENSICS_BATCH_MAX);
  assert.deepEqual(payload.jobs.slice(0, 2).map((j) => j.id), ["18537", "18006_3"]);
  assert.deepEqual(payload.jobs[0].reg, { workDir: "/w", stdout: "/w/o_%j.log", stderr: null, command: "/w/run.sh", name: "x", user: "kai" }, "登记只带取证需要的字段");
  assert.equal(payload.tailBytes, 16 * 1024);
  assert.equal(payload.siblingMax, 4);
  assert.equal(payload.scriptBytes, 32 * 1024);
});

test("输出解析：字段白名单、坏行 / 未知类型 / 重复作业丢弃、尾部与脚本截断、文件数封顶", () => {
  const big = "x".repeat(FORENSICS_TAIL_BYTES + 100);
  const files = Array.from({ length: 9 }, (_, i) => ({ p: `/w/f${i}.log`, r: i ? "sibling" : "stdout", sz: 10, t: i ? "t" : big }));
  const out = [
    JSON.stringify({ k: "job", id: "101", raw: "101", wd: "/w", src: "registry", tool: "sbatch", live: true, files, sc: "s".repeat(40000), scs: "scontrol" }),
    JSON.stringify({ k: "job", id: "101", src: "none", files: [] }),
    JSON.stringify({ k: "job", id: "../etc", src: "none", files: [] }),
    JSON.stringify({ k: "job", id: "102", src: "weird", files: [{ p: "relative.log", r: "stdout", t: "a" }, { p: "/ok.log", r: "evil", t: "a" }, { p: "/ok2.log", r: "stderr", t: 5 }] }),
    JSON.stringify({ k: "mystery" }),
    "not json",
    "[1,2]",
    JSON.stringify({ k: "end", n: 2, complete: true, sec: 1.5 }),
  ].join("\n");
  const parsed = parseForensicsOutput(out);
  assert.deepEqual(parsed.jobs.map((j) => j.id), ["101", "102"]);
  const [a, b] = parsed.jobs;
  assert.equal(a.files.length, 6, "stdout/stderr + 4 个兄弟文件");
  assert.equal(a.files[0].tail.length, FORENSICS_TAIL_BYTES);
  assert.equal(a.script.length, 32 * 1024);
  assert.deepEqual([a.source, a.tool, a.live, a.scriptFrom, a.rawId], ["registry", "sbatch", true, "scontrol", "101"]);
  assert.deepEqual([b.source, b.files, b.script, b.scriptFrom], ["none", [], null, null], "未知来源 → none；相对路径 / 未知角色 / 非字符串尾部的文件丢弃");
  assert.deepEqual(parsed.end, { n: 2, complete: true, sec: 1.5 });
  assert.equal(parsed.badLines, 5);
  assert.deepEqual(parseForensicsOutput(""), { jobs: [], end: null, badLines: 0 });
  assert.equal(a.subruns, null, "没有 sub 字段（旧脚本 / 不是编排型作业）→ null");
  const sub = (value) => parseForensicsOutput(JSON.stringify({ k: "job", id: "7", src: "none", files: [], sub: value })).jobs[0].subruns;
  assert.deepEqual(sub({ n: 16, bad: 0, fail: [] }), { ended: 16, failed: 0, failures: [] });
  assert.deepEqual(sub({ n: 9, bad: 3, fail: [["M1_f3", "train", -15], ["bad name", "train", 1], ["M1_f4", "train", 0], ["M1_f5", "eval", 2], "x"] }),
    { ended: 9, failed: 3, failures: [{ run: "M1_f3", phase: "train", code: -15 }, { run: "M1_f5", phase: "eval", code: 2 }] }, "名字不合格 / 退出码为 0 的条目丢弃");
  assert.equal(sub({ n: 0, bad: 0, fail: [] }), null);
  assert.equal(sub("x"), null);
});

// ---------------------------------------------------------------------------
// 真跑远端脚本（本机 python3 + 假 sacct / scontrol + 临时目录里的日志），路径解析各分支逐一过。
// 日志内容全部是合成的。
// ---------------------------------------------------------------------------

const FAKE_SACCT = `#!/bin/sh
cat "$FAKE_DIR/sacct.txt"
`;
const FAKE_SCONTROL = `#!/bin/sh
if [ "$1" = show ]; then
  f="$FAKE_DIR/scontrol-$4.txt"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo "slurm_load_jobs error: Invalid job id specified" >&2
  exit 1
fi
if [ "$1" = write ]; then
  f="$FAKE_DIR/script-$3.sh"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  exit 1
fi
exit 1
`;

function put(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function runForensics(jobs) {
  const root = mkdtempSync(path.join(os.tmpdir(), "job-forensics-"));
  const bin = path.join(root, "bin");
  const W = path.join(root, "w");
  try {
    put(path.join(bin, "sacct"), FAKE_SACCT);
    put(path.join(bin, "scontrol"), FAKE_SCONTROL);
    chmodSync(path.join(bin, "sacct"), 0o755);
    chmodSync(path.join(bin, "scontrol"), 0o755);
    // macOS 对新写出的可执行文件第一次执行要做一次安全评估（空闲时约 0.3 秒，全量并发时可达数秒），
    // 会吃掉远端脚本给每条 Slurm 命令的 6 秒时限。先各跑一次，把评估放在计时之外。
    for (const name of ["sacct", "scontrol"]) spawnSync(path.join(bin, name), [], { timeout: 60000 });
    const sacct = [
      `103|103|myname|tester|${W}/c|sbatch --parsable --job-name=myname -o logs/%x-%j.out run.sh`,
      // SubmitLine 丢了引号（--export=ALL,ARMS="A B"）：第一个位置参数 B 不是脚本，要挑出真实存在的 train.slurm。
      `104|104|n|tester|${W}/d|sbatch --export=ALL,ARMS=A B train.slurm`,
      `105_3|109|arr|tester|${W}/e|sbatch --array=0-5 --output=${W}/e/train_%A_%4a.log job.sh`,
      `106_2|110|arr|tester|${W}/f|sbatch -a 0-3 job.sh`,
      `107|107|d|tester|${W}/g|/public/slurm/bin/sbatch run.sh`,
      `108|108|python|tester|${W}/h|srun -p CPU -c 4 python x.py`,
      `111|111|t|tester|${W}/i|sbatch gone.slurm`,
      `120|120|xp_demo|tester|${W}/x|sbatch -o logs/xp_%j.log run_xp.sh`,
      `121|121|xp_refused|tester|${W}/y|sbatch -o logs/xp_%j.log run_xp.sh`,
      `122_2|122|cfd_wrap|tester|${W}/z|sbatch --array=1-2 -o ${W}/z/logs/cfd_%A_%a.out --wrap="d=\\$(sed -n \\"\\$((SLURM_ARRAY_TASK_ID+0))p\\" ${W}/z/dirs.txt); python sim.py >> \\"\\$d/process.out\\" 2>&1"`,
      "garbage line without pipes",
    ].join("\n");
    put(path.join(bin, "sacct.txt"), `${sacct}\n`);
    // 101：登记表（squeue 原样模板，%j 由脚本展开）+ 同目录兄弟文件（含二进制与相邻作业号的干扰项）。
    put(path.join(W, "a/out_101.log"), "start\nepoch 1\n");
    put(path.join(W, "a/arm_x_101.log"), "Traceback (most recent call last):\n  File \"t.py\", line 3\nKeyError: 'arm'\n");
    put(path.join(W, "a/ckpt_101.pt"), Buffer.from([0, 1, 2, 3]));
    put(path.join(W, "a/other_1010.log"), "not mine\n");
    // 102：scontrol 视野内（路径已展开），脚本经 write batch_script 取。
    put(path.join(bin, "scontrol-102.txt"), `JobId=102 JobName=sc UserId=tester(1000) JobState=FAILED Command=${W}/b/run.sh WorkDir=${W}/b StdErr=${W}/b/err-102.log StdIn=/dev/null StdOut=${W}/b/out-102.log Power=\n`);
    put(path.join(bin, "script-102.sh"), "#!/bin/bash\n#SBATCH -J sc\npython train.py\n");
    put(path.join(W, "b/out-102.log"), "hello\n");
    put(path.join(W, "b/err-102.log"), "RuntimeError: boom\n");
    put(path.join(W, "c/run.sh"), "#!/bin/bash\n#SBATCH -o ignored_%j.out\necho hi\n");
    put(path.join(W, "c/logs/myname-103.out"), `${"x".repeat(40000)}\nlast line\n`);
    put(path.join(W, "d/train.slurm"), "#!/bin/bash\n#SBATCH --job-name=n\n#SBATCH -o out/%u_%j.txt # 注释\n\npython run.py\n#SBATCH -e never.txt\n");
    put(path.join(W, "d/out/tester_104.txt"), "d log\n");
    put(path.join(W, "e/train_105_0003.log"), "array log\n");
    put(path.join(W, "f/slurm-106_2.out"), "default array\n");
    put(path.join(W, "g/slurm-107.out"), "default\n");
    put(path.join(W, "h/x.py"), "print('srun 直接跑，没有日志文件')\n");
    put(path.join(W, "i/logs/job_111_4294967294.out"), "sibling only\n");
    // 120：编排型作业——主日志每个子任务一行 LAUNCH / END，8 个子任务日志里只有 B_f1 train 退出码非 0，
    // 而且它最早结束（修改时间最旧）；XB_f1 是名字前缀相撞的干扰项。
    const runs = ["B_f1", "XB_f1", "A_f0", "A_f1", "A_f2", "C_f0", "C_f1", "C_f2"];
    put(path.join(W, "x/logs/xp_120.log"), [
      "scheduler start",
      ...runs.map((run, i) => `2026-10-09T15:0${i}:10+0800 LAUNCH ${run} train GPU-${i}`),
      "2026-10-09T15:40:42+0800 END B_f1 train 1",
      ...runs.slice(1).map((run, i) => `2026-10-09T15:5${i}:00+0800 END ${run} train 0`),
      "",
    ].join("\n"));
    runs.forEach((run, i) => {
      const file = path.join(W, `x/logs/${run}_train_120.log`);
      put(file, run === "B_f1"
        ? "epoch 3/400 loss=nan\nTraceback (most recent call last):\n  File \"t.py\", line 9, in run\nRuntimeError: The total norm for gradients is non-finite, so it cannot be clipped.\n"
        : `epoch 400/400 loss=0.0${i} [best]\n`);
      utimesSync(file, 1_790_000_000 + i * 60, 1_790_000_000 + i * 60);
    });
    // 同一实验目录被后来的作业重写过的状态文件（job_id 对不上）不能算到 120 头上。
    put(path.join(W, "x/status.json"), JSON.stringify({ schema: "xp_status_v1", job_id: "999", arms: { Z: { status: "refused", reason: "别的作业的" } } }));
    // 121：启动了的子任务全部以 0 结束，另有两个被拒绝启动——只有状态文件里记着。
    put(path.join(W, "y/logs/xp_121.log"), "2026-10-09T12:28:10+0800 LAUNCH W1_f0 train GPU-0\n2026-10-09T12:58:08+0800 END W1_f0 train 0\n");
    put(path.join(W, "y/status.json"), JSON.stringify({
      schema: "xp_status_v1", job_id: "121", status: "failed",
      arms: {
        W1_f0: { status: "complete", stages: { train: { returncode: 0 } } },
        W1_f1: { status: "refused", reason: `run 目录已有内容，拒绝覆盖：${W}/runs/W1_f1`, stages: {} },
        W1_f2: { status: "refused", reason: `run 目录已有内容，拒绝覆盖：${W}/runs/W1_f2`, stages: {} },
      },
    }));
    // 122_2：--wrap 数组作业，主日志 0 字节，实际输出被重定向到 sed 映射出的 case_02/process.out。
    put(path.join(W, "z/logs/cfd_122_2.out"), "");
    put(path.join(W, "z/dirs.txt"), `${W}/z/case_01\n${W}/z/case_02\n`);
    put(path.join(W, "z/case_02/process.out"), "Traceback (most recent call last):\n  File \"sim.py\", line 12\nRuntimeError: mesh diverged\n");

    const payloadJobs = jobs.map((job) => (job.id === "101"
      ? { id: "101", reg: { workDir: `${W}/a`, stdout: "out_%j.log", stderr: null, command: `${W}/a/run.sh`, name: "r", user: "tester" } }
      : job));
    const inv = buildForensicsInvocation({ server: { id: "s1", host: "example" }, jobs: payloadJobs });
    const bootstrap = FORENSICS_REMOTE_COMMAND.slice("python3 -c '".length, -1);
    const res = spawnSync(PYTHON, ["-c", bootstrap], { input: inv.input, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin } });
    assert.equal(res.status, 0, res.stderr);
    return { parsed: parseForensicsOutput(res.stdout), W };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

pyTest("远端脚本：登记 → scontrol → SubmitLine / #SBATCH → 默认路径，%j %x %u %A %a（含补零）与相对路径展开", () => {
  const ids = ["101", "102", "103", "104", "105_3", "106_2", "107", "108", "111"];
  const { parsed, W } = runForensics(ids.map((id) => ({ id, reg: null })));
  assert.equal(parsed.badLines, 0);
  assert.deepEqual(parsed.end && [parsed.end.n, parsed.end.complete], [9, true]);
  const by = Object.fromEntries(parsed.jobs.map((j) => [j.id, j]));
  const paths = (id) => by[id].files.map((f) => `${f.role}:${path.relative(W, f.path)}`);

  assert.equal(by["101"].source, "registry");
  assert.deepEqual(paths("101"), ["stdout:a/out_101.log", "sibling:a/arm_x_101.log"], "兄弟文件按作业号边界匹配，二进制与 1010 不算");
  assert.match(by["101"].files[1].tail, /KeyError: 'arm'/);

  assert.equal(by["102"].source, "scontrol");
  assert.equal(by["102"].live, true);
  assert.deepEqual(paths("102"), ["stdout:b/out-102.log", "stderr:b/err-102.log"]);
  assert.equal(by["102"].scriptFrom, "scontrol");
  assert.match(by["102"].script, /python train\.py/);

  assert.equal(by["103"].source, "submitline", "命令行 -o 优先于脚本里的 #SBATCH -o");
  assert.deepEqual(paths("103"), ["stdout:c/logs/myname-103.out"]);
  assert.ok(by["103"].files[0].tail.length <= FORENSICS_TAIL_BYTES);
  assert.match(by["103"].files[0].tail, /last line\n$/);
  assert.equal(by["103"].scriptFrom, "file");

  assert.equal(by["104"].source, "submitline");
  assert.deepEqual(paths("104"), ["stdout:d/out/tester_104.txt"], "#SBATCH 只看第一条命令之前的；行内注释剥掉");
  assert.match(by["104"].script, /#SBATCH -o out/);

  assert.deepEqual([by["105_3"].source, by["105_3"].rawId], ["submitline", "109"]);
  assert.deepEqual(paths("105_3"), ["stdout:e/train_105_0003.log"]);
  assert.deepEqual([by["106_2"].source, ...paths("106_2")], ["default", "stdout:f/slurm-106_2.out"]);
  assert.deepEqual([by["107"].source, ...paths("107")], ["default", "stdout:g/slurm-107.out"]);

  assert.deepEqual([by["108"].source, by["108"].tool, by["108"].files], ["none", "srun", []], "srun 不找 slurm-%j.out");
  assert.equal(by["111"].source, "none");
  assert.deepEqual(paths("111"), ["sibling:i/logs/job_111_4294967294.out"], "日志与脚本都没了，WorkDir/logs 里的同号文件仍能找到");
});

pyTest("远端脚本：编排型作业先取退出码非 0 的子任务日志；被拒绝启动的子任务从编排脚本的状态文件里读出来；--wrap 重定向日志跟进", () => {
  const { parsed, W } = runForensics([{ id: "120", reg: null }, { id: "121", reg: null }, { id: "122_2", reg: null }]);
  const [job, refused, wrapped] = parsed.jobs;
  assert.deepEqual(
    job.files.map((f) => `${f.role}:${path.relative(W, f.path)}`),
    ["stdout:x/logs/xp_120.log", "sibling:x/logs/B_f1_train_120.log", "sibling:x/logs/C_f2_train_120.log", "sibling:x/logs/C_f1_train_120.log", "sibling:x/logs/C_f0_train_120.log"],
    "失败的 B_f1 排在兄弟文件最前（它修改时间最旧）；XB_f1 不因名字包含 B_f1 被提前；其余仍按新 → 旧",
  );
  assert.deepEqual(job.subruns, { ended: 8, failed: 1, failures: [{ run: "B_f1", phase: "train", code: 1 }] });
  assert.equal(job.dispatch, null, "job_id 对不上的状态文件不认");
  const diagnosis = diagnoseJob({ state: "FAILED", exitCode: 1, tool: job.tool, files: job.files, subruns: job.subruns, dispatch: job.dispatch });
  assert.equal(diagnosis.category, "nan", "此前只拿到最新的 4 个正常结束的日志，结论是「原因未识别」");
  assert.match(diagnosis.file, /B_f1_train_120\.log$/);

  assert.deepEqual(refused.subruns, { ended: 1, failed: 0, failures: [] });
  assert.deepEqual(refused.dispatch, {
    arms: 3,
    unfinished: 2,
    items: ["W1_f1", "W1_f2"].map((name) => ({ name, status: "refused", reason: `run 目录已有内容，拒绝覆盖：${W}/runs/${name}` })),
  });
  const why = diagnoseJob({ state: "FAILED", exitCode: 1, tool: refused.tool, files: refused.files, subruns: refused.subruns, dispatch: refused.dispatch });
  assert.equal(why.category, "refused");
  assert.match(why.headline, /^2 个子任务被编排脚本拒绝启动：run 目录已有内容，拒绝覆盖：…\/runs\/W1_f1$/);

  assert.match(wrapped.script, /SLURM_ARRAY_TASK_ID/);
  assert.deepEqual(
    wrapped.files.map((f) => `${f.role}:${path.relative(W, f.path)}`),
    ["stdout:z/logs/cfd_122_2.out", "sibling:z/case_02/process.out"],
  );
  const wrapDiag = diagnoseJob({ state: "FAILED", exitCode: 1, tool: wrapped.tool, files: wrapped.files, script: wrapped.script });
  assert.deepEqual([wrapDiag.category, wrapDiag.headline], ["python", "RuntimeError: mesh diverged"]);
});
