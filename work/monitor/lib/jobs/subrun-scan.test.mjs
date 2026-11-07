// 真实 Python 远端（job-forensics.py + job-subruns.py + job-watch.py 同一条命令）+ 假 Slurm：
// 增量游标、子任务日志按 run 精确关联、收尾读取、覆盖缺口、FIFO 不挂住。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applySubrunRecord, subrunView } from "./subrun-model.mjs";
import { buildWatchInvocation, parseWatchOutput, WATCH_REMOTE_COMMAND } from "./watch-scan.mjs";

const pyTest = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0 ? test : test.skip;
const NOW = Date.parse("2026-10-06T14:20:00+08:00");
const L = (t, run, phase) => `2026-10-06T${t}+0800 LAUNCH ${run} ${phase} GPU-0\n`;
const E = (t, run, phase, code) => `2026-10-06T${t}+0800 END ${run} ${phase} ${code}\n`;

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "subrun-python-"));
  const bin = path.join(root, "bin");
  const logs = path.join(root, "exp", "logs");
  mkdirSync(bin);
  mkdirSync(logs, { recursive: true });
  const user = os.userInfo().username;
  const squeue = `#!/bin/sh\nprintf '%s\\n' '18764|${user}|RUNNING'\n`;
  writeFileSync(path.join(bin, "squeue"), squeue);
  chmodSync(path.join(bin, "squeue"), 0o755);
  // macOS 对新写出的可执行文件第一次执行要做一次安全评估（空闲时约 0.3 秒，全量并发时可达数秒），
  // 会吃掉远端脚本给每条 Slurm 命令的 6 秒时限。先各跑一次，把评估放在计时之外。
  spawnSync(path.join(bin, "squeue"), [], { timeout: 60000 });
  const run = (jobs, orchFinal = []) => {
    const inv = buildWatchInvocation({ server: { id: "s1", host: "cluster" }, jobs, orchFinal });
    const once = () => {
      const startedAt = Date.now();
      const result = spawnSync("sh", ["-c", WATCH_REMOTE_COMMAND], { input: inv.input, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000 });
      return { result, ms: Date.now() - startedAt };
    };
    // 机器内存吃紧（全量并发时常见）起子进程会卡上几秒，远端脚本给每条 Slurm 命令的 6 秒时限就不够用了。
    // 这一趟慢得不正常（正常约 0.2 秒）就重跑，最多三趟——脚本只读文件，同样的输入重跑结果相同；断言不变。
    let attempt = once();
    for (let i = 0; i < 2 && attempt.ms > 4000; i += 1) attempt = once();
    const { result } = attempt;
    assert.equal(result.status, 0, result.stderr);
    return parseWatchOutput(result.stdout);
  };
  const reg = { user, workDir: path.join(root, "exp"), stdout: path.join(logs, "xp_%j.log"), stderr: path.join(logs, "xp_%j.log") };
  return { root, logs, run, reg, stdout: path.join(logs, "xp_18764.log"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

pyTest("增量读取：首轮从头回填并读正在跑的子任务日志；次轮只读新增完整行；半行留到下轮", () => {
  const h = setup();
  try {
    writeFileSync(h.stdout, `2026-10-05T17:02:29-07:00\nnode\n${L("08:02:31", "PFG_f0_s1234", "train")}${L("08:03:16", "PFG_f1_s1234", "train")}${E("08:49:59", "PFG_f1_s1234", "train", 0)}${L("08:49:59", "PFG_f1_s1234", "eval_best")}`);
    writeFileSync(path.join(h.logs, "PFG_f0_s1234_train_18764.log"), "23:50:58 INFO epoch 168/400 loss=0.1520\n23:51:53 INFO epoch 169/400 loss=0.1518\n23:52:48 INFO epoch 170/400 loss=0.1512\n");
    writeFileSync(path.join(h.logs, "PFG_f1_s1234_eval_best_99999.log"), "作业号不对，不应被读取\n");
    let parsed = h.run([{ id: "18764", reg: h.reg, orch: {} }]);
    assert.equal(parsed.progress.length, 1, "原有进度记录照常输出");
    const first = parsed.subruns.find((r) => r.kind === "live");
    assert.equal(first.events.length, 4);
    const logs = Object.fromEntries(first.logs.map((l) => [`${l.run}/${l.phase}`, l]));
    assert.equal(logs["PFG_f0_s1234/train"].lines.length, 3);
    assert.equal(logs["PFG_f1_s1234/eval_best"].missing, true, "只认 <run>_<phase>_<作业号>.log");
    assert.equal(logs["PFG_f1_s1234/train"], undefined, "已结束的不读");
    let state = applySubrunRecord(null, first, { now: NOW, serverId: "s1", jobId: "18764" });
    appendFileSync(h.stdout, `${E("08:51:04", "PFG_f0_s1234", "train", 0)}2026-10-06T08:51:04+0800 LAUNCH PFG_f0_s1234 eva`);
    parsed = h.run([{ id: "18764", reg: h.reg, orch: state }]);
    const second = parsed.subruns[0];
    assert.equal(second.from, first.off);
    assert.equal(second.events.length, 1, "半行不读");
    state = applySubrunRecord(state, second, { now: NOW, serverId: "s1", jobId: "18764" });
    appendFileSync(h.stdout, "l_best GPU-0\n");
    state = applySubrunRecord(state, h.run([{ id: "18764", reg: h.reg, orch: state }]).subruns[0], { now: NOW, serverId: "s1", jobId: "18764" });
    const view = subrunView(state, NOW);
    assert.deepEqual([view.launched, view.ended, view.runningCount], [4, 2, 2]);
    assert.equal(state.cursor.off, statSync(h.stdout).size);
  } finally { h.cleanup(); }
});

pyTest("收尾读取只认同一文件身份：补上最后的 END；文件被替换则不读", () => {
  const h = setup();
  try {
    writeFileSync(h.stdout, L("08:02:31", "A_s1", "train"));
    const ctx = { now: NOW, serverId: "s1", jobId: "18764" };
    let state = applySubrunRecord(null, h.run([{ id: "18764", reg: h.reg, orch: {} }]).subruns[0], ctx);
    appendFileSync(h.stdout, E("09:00:00", "A_s1", "train", -15));
    let parsed = h.run([], [{ id: "18764", cursor: state.cursor }]);
    const fin = parsed.subruns.find((r) => r.kind === "final");
    assert.equal(fin.events.length, 1);
    const done = applySubrunRecord(state, fin, ctx);
    assert.equal(subrunView(done, NOW).failedRuns[0].code, -15);
    assert.equal(done.finalized, true);
    // 替换：同路径换成新文件（新 inode）→ 标缺口、不读事件。
    writeFileSync(`${h.stdout}.new`, `${L("10:00:00", "B_s1", "train")}${E("10:01:00", "B_s1", "train", 1)}`);
    renameSync(`${h.stdout}.new`, h.stdout);
    parsed = h.run([], [{ id: "18764", cursor: state.cursor }]);
    const replaced = parsed.subruns.find((r) => r.kind === "final");
    assert.equal(replaced.gap, "replaced");
    assert.equal(replaced.events.length, 0);
    state = applySubrunRecord(state, replaced, ctx);
    assert.equal(state.finalized, true);
    assert.equal(subrunView(state, NOW).failed, 0);
  } finally { h.cleanup(); }
});

pyTest("覆盖缺口：截断从头重读；首次超过 4MB 只读末尾并丢掉残行；子任务日志是 FIFO 时不挂住", () => {
  const h = setup();
  try {
    const ctx = { now: NOW, serverId: "s1", jobId: "18764" };
    writeFileSync(h.stdout, `${L("08:00:00", "A_s1", "train")}${L("08:00:01", "B_s1", "train")}`);
    let state = applySubrunRecord(null, h.run([{ id: "18764", reg: h.reg, orch: {} }]).subruns[0], ctx);
    truncateSync(h.stdout, 0);
    writeFileSync(h.stdout, L("09:00:00", "C_s1", "train"));
    const cut = h.run([{ id: "18764", reg: h.reg, orch: state }]).subruns[0];
    assert.equal(cut.gap, "truncated");
    state = applySubrunRecord(state, cut, ctx);
    assert.deepEqual(subrunView(state, NOW).running.map((r) => r.run), ["C_s1"]);
    if (process.platform !== "win32") {
      spawnSync("mkfifo", [path.join(h.logs, "C_s1_train_18764.log")]);
      const fifo = h.run([{ id: "18764", reg: h.reg, orch: state }]).subruns[0];
      assert.equal(fifo.logs[0].missing, true);
    }
    const filler = `${"x".repeat(99)}\n`.repeat(Math.ceil((4.2 * 1024 * 1024) / 100));
    writeFileSync(h.stdout, `${L("07:00:00", "OLD_s1", "train")}${filler}${L("10:00:00", "NEW_s1", "train")}`);
    const big = h.run([{ id: "18764", reg: h.reg, orch: {} }]).subruns[0];
    assert.equal(big.gap, "head");
    assert.deepEqual(big.events.map((e) => e.run), ["NEW_s1"]);
  } finally { h.cleanup(); }
});

