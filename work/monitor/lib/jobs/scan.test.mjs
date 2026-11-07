import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JOBS_MAX, parseJobsOutput } from "./parse.mjs";
import { buildJobsLookupInvocation, buildJobsScanInvocation, JOBS_REMOTE_COMMAND, JOBS_REMOTE_SCRIPT, JOBS_SCAN_MAX_OUT_BYTES, JOBS_SCAN_TIMEOUT_MS, jobsLookupSelector } from "./scan.mjs";

test("调用组装：远端命令是常量 sh -s，脚本走 stdin，不含任何插值", () => {
  const inv = buildJobsScanInvocation({ server: { id: "server-01", host: "myserver" }, platform: "darwin" });
  assert.equal(inv.file, "ssh");
  assert.equal(inv.args.at(-1), JOBS_REMOTE_COMMAND);
  assert.ok(inv.args.includes("myserver"));
  assert.equal(inv.input, JOBS_REMOTE_SCRIPT);
  assert.equal(inv.timeoutMs, JOBS_SCAN_TIMEOUT_MS);
  // 接收上限必须装得下打满的一轮（JOBS_MAX 行 × 每行最多 480 字节）；exec 默认的 1MB 不够。
  assert.equal(inv.maxOutputBytes, JOBS_SCAN_MAX_OUT_BYTES);
  assert.ok(JOBS_SCAN_MAX_OUT_BYTES >= JOBS_MAX * 484 + 4096);
  // 只读：脚本里没有任何写文件 / 改状态的动作。
  assert.doesNotMatch(JOBS_REMOTE_SCRIPT, /\bmktemp\b|>\s*[^&/]|\brm\b|\bscancel\b|\bsbatch\b/);
});

// 真跑远端脚本（本机 /bin/sh + 假 sacct），确认输出与解析器咬合。Windows 无 POSIX sh，跳过。
function runWithFakeSacct(body, input = JOBS_REMOTE_SCRIPT) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-jobs-"));
  try {
    if (body != null) {
      writeFileSync(path.join(dir, "sacct"), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(dir, "sacct"), 0o755);
    }
    const res = spawnSync("/bin/sh", ["-s"], {
      input,
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: `${dir}:/usr/bin:/bin`, TZ: "Asia/Shanghai" },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const skip = process.platform === "win32";

test("远端脚本 ok：参数原样传给 sacct，作业行带 job= 前缀并能解析", { skip }, () => {
  const stdout = runWithFakeSacct([
    `[ "$*" = "-u $(id -un) -X -n -P -S now-2days -o JobID,JobName,State,ExitCode,Submit,Start,End,Elapsed,NodeList,Partition" ] || { echo "bad args: $*" >&2; exit 2; }`,
    "printf '16446|lib_audit_d|COMPLETED|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T16:00:07|00:38:40|node06|CPU\\n'",
    "printf '16500|train|PENDING|0:0|2026-10-02T10:00:00|Unknown|Unknown|00:00:00|None assigned|GPU\\n'",
  ].join("\n"));
  const out = parseJobsOutput(stdout);
  assert.equal(out.state, "ok", stdout);
  assert.equal(out.tzOffsetMin, 480);
  assert.ok(out.user);
  assert.ok(out.remoteNow > 0);
  assert.deepEqual(out.jobs.map((j) => [j.id, j.state]), [["16500", "PENDING"], ["16446", "COMPLETED"]]);
  assert.equal(out.rowsTotal, 2, "远端先报 sacct 的总行数");
  assert.equal(out.truncated, false);
});

// 回归：此前远端 tail -n 400 且不报总数，实测近 48 小时 1137 条时今日简报少算了一大半、还漏掉了失败的作业。
test("远端脚本：实测量级（1137 行）整份回传，rows 与作业行数一致", { skip }, () => {
  const stdout = runWithFakeSacct("awk 'BEGIN { for (i = 1; i <= 1137; i++) printf \"%d|cfa-agiter20-%06x-cfd1|COMPLETED|0:0|2026-10-03T10:00:00|2026-10-03T10:00:01|2026-10-03T10:50:00|00:49:59|node01|CPU\\n\", 16000 + i, i }'");
  const out = parseJobsOutput(stdout);
  assert.equal(out.state, "ok");
  assert.equal(out.rowsTotal, 1137);
  assert.equal(out.jobs.length, 1137);
  assert.equal(out.truncated, false);
  assert.equal(out.badLines, 0);
});

test("远端脚本：超过上限只保留最新（末尾）JOBS_MAX 行并报出总行数，超长行截断", { skip }, () => {
  const total = JOBS_MAX + 50;
  const stdout = runWithFakeSacct(`awk 'BEGIN { for (i = 1; i <= ${total}; i++) printf "%d|j|COMPLETED|0:0|||||n|p\\n", i }'; printf '999999|%0700d|COMPLETED|0:0|||||n|p\\n' 0`);
  const rows = stdout.split("\n").filter((l) => l.startsWith("job="));
  assert.equal(rows.length, JOBS_MAX);
  assert.ok(rows.every((l) => l.length <= 4 + 480));
  assert.equal(rows[0].split("|")[0], "job=52", "tail 留下的是末尾（作业号最大）的那些");
  assert.match(stdout, new RegExp(`^rows=${total + 1}$`, "m"));
  const out = parseJobsOutput(stdout);
  assert.equal(out.rowsTotal, total + 1);
  assert.equal(out.badLines, 1, "被截断的超长行整行丢弃");
  assert.equal(out.truncated, true);
});

test("远端脚本：sacct 没有任何作业 → rows=0、不截断", { skip }, () => {
  const out = parseJobsOutput(runWithFakeSacct("exit 0"));
  assert.equal(out.state, "ok");
  assert.equal(out.rowsTotal, 0);
  assert.deepEqual(out.jobs, []);
  assert.equal(out.truncated, false);
});

test("远端脚本 absent：PATH 里没有 sacct", { skip }, () => {
  const out = parseJobsOutput(runWithFakeSacct(null));
  assert.equal(out.state, "absent");
  assert.ok(out.user);
});

test("远端脚本 error：sacct 非零退出 → error=sacct-failed + 首行报错", { skip }, () => {
  const out = parseJobsOutput(runWithFakeSacct("echo 'sacct: error: Slurm accounting storage is disabled' >&2; exit 1"));
  assert.equal(out.state, "error");
  assert.equal(out.error, "sacct-failed");
  assert.equal(out.detail, "sacct: error: Slurm accounting storage is disabled");
  assert.deepEqual(out.jobs, []);
});

// ---- v2.51 按需回查：参数化的远端脚本 ----

test("回查选择参数：只认严格格式的日期窗口 / 作业号，其它一律抛错（不可能带进引号或 $）", () => {
  assert.equal(jobsLookupSelector({ kind: "range", from: "2026-10-01", to: "2026-10-03" }), "-S 2026-10-01T00:00:00 -E 2026-10-03T23:59:59");
  assert.equal(jobsLookupSelector({ kind: "job", job: "13207_5" }), "-j 13207_5");
  assert.equal(jobsLookupSelector({ kind: "job", job: "18036" }), "-j 18036");
  for (const bad of [
    { kind: "job", job: "1;rm -rf ~" },
    { kind: "job", job: "$(id)" },
    { kind: "job", job: "13207_[1-3]" },
    { kind: "job", job: "" },
    { kind: "range", from: "2026-10-01", to: "now" },
    { kind: "range", from: "2026-10-01'", to: "2026-10-02" },
    { kind: "other" },
    {},
  ]) assert.throws(() => jobsLookupSelector(bad), /invalid/, JSON.stringify(bad));
  assert.throws(() => buildJobsLookupInvocation({ server: { host: "h" }, query: { kind: "job", job: "x" } }), /invalid/);
});

test("回查调用组装：远端命令仍是常量 sh -s，与定期采集只差 sacct 的选择参数", () => {
  const inv = buildJobsLookupInvocation({ server: { id: "server-01", host: "myserver" }, platform: "darwin", query: { kind: "job", job: "18036" } });
  assert.equal(inv.args.at(-1), JOBS_REMOTE_COMMAND);
  assert.equal(inv.maxOutputBytes, JOBS_SCAN_MAX_OUT_BYTES);
  assert.equal(inv.input, JOBS_REMOTE_SCRIPT.replace("-S now-2days", "-j 18036"));
  assert.doesNotMatch(inv.input, /\bscancel\b|\bsbatch\b|\bmktemp\b/);
});

test("回查远端脚本：日期窗口原样传给 sacct，输出与解析器咬合", { skip }, () => {
  const input = buildJobsLookupInvocation({ server: { host: "h" }, query: { kind: "range", from: "2026-09-28", to: "2026-09-28" } }).input;
  const stdout = runWithFakeSacct([
    `[ "$*" = "-u $(id -un) -X -n -P -S 2026-09-28T00:00:00 -E 2026-09-28T23:59:59 -o JobID,JobName,State,ExitCode,Submit,Start,End,Elapsed,NodeList,Partition" ] || { echo "bad args: $*" >&2; exit 2; }`,
    "printf '13207_0|v6_geom_full|COMPLETED|0:0|2026-09-28T11:15:35|2026-09-28T11:15:35|2026-09-28T11:15:41|00:00:06|node05|CPU\\n'",
  ].join("\n"), input);
  const out = parseJobsOutput(stdout);
  assert.equal(out.state, "ok", stdout);
  assert.deepEqual(out.jobs.map((j) => j.id), ["13207_0"]);
});
