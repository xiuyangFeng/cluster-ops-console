import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWatchInvocation, parseWatchOutput, WATCH_REMOTE_COMMAND } from "./watch-scan.mjs";

test("关注采集固定命令，参数仅走stdin，坏ID与超批量有界", () => {
  const inv = buildWatchInvocation({ server: { id: "s1", host: "cluster" }, jobs: [{ id: "1", reg: { stdout: "/tmp/$(evil).log", user: "me" } }, { id: "1;echo bad" }], resourceIds: Array.from({ length: 100 }, (_, i) => String(i)) });
  assert.equal(inv.args.at(-1), WATCH_REMOTE_COMMAND);
  assert.equal(inv.args.some((s) => s.includes("evil")), false);
  const params = JSON.parse(inv.input.split("\n")[1]);
  assert.equal(params.jobs.length, 1);
  assert.equal(params.resourceIds.length, 20);
  assert.equal(params.jobs[0].reg.stdout, "/tmp/$(evil).log");
  const invalid = parseWatchOutput('broken\n{"k":"progress","id":"../x"}\n{"k":"progress","id":"1","files":[{"p":"relative","t":"text"}]}');
  assert.deepEqual(invalid.progress[0].files, []);
});

const pyTest = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0 ? test : test.skip;
pyTest("真实Python + 假Slurm：只读登记的本人RUNNING日志，保留资源steps，命令无-X、不落远端脚本", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "watch-python-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const user = os.userInfo().username;
  const out = path.join(root, "job_1.log");
  const arr = path.join(root, "array_3_04.log");
  const rawArray = path.join(root, "raw_99.log");
  writeFileSync(out, "Epoch: 4\nstep: 20\n");
  writeFileSync(arr, "epoch 2 step 8\n");
  writeFileSync(rawArray, "epoch 5 step 80\n");
  const squeue = `#!/bin/sh\n[ "$LC_ALL" = C.UTF-8 ] || exit 5\nprintf '%s\\n' '1|${user}|RUNNING' '2|somebody-else|RUNNING' '3_4|${user}|RUNNING' '4_2|${user}|RUNNING'\n`;
  const sacct = `#!/bin/sh\nfor x in "$@"; do if [ "$x" = -X ]; then exit 3; fi; done\nprintf '%s\\n' '1|${user}|COMPLETED|4|2Gc||00:00:00|100|1|cpu=4,mem=8G,gres/gpu=1|1|60||' '1.batch||COMPLETED|4||1024K|00:02:00|100|1||1||gres/gpumem=10240M,gres/gpuutil=95|' '2|somebody-else|COMPLETED|4|2G||00:02:00|100|1||'\n`;
  const scontrol = `#!/bin/sh\nprintf '%s\\n' 'JobId=99 ArrayJobId=4 ArrayTaskId=2 UserId=${user}(1000)'\n`;
  for (const [name, body] of [["squeue", squeue], ["sacct", sacct], ["scontrol", scontrol]]) { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); }
  // macOS 对新写出的可执行文件第一次执行要做一次安全评估（空闲时约 0.3 秒，全量并发时可达数秒），
  // 会吃掉远端脚本给每条 Slurm 命令的 6 秒时限。先各跑一次，把评估放在计时之外。
  for (const name of ["squeue", "sacct", "scontrol"]) spawnSync(path.join(bin, name), [], { timeout: 60000 });
  try {
    const inv = buildWatchInvocation({ server: { id: "s1", host: "cluster" }, jobs: [
      { id: "1", reg: { user, workDir: root, stdout: "job_%j.log" } },
      { id: "2", reg: { user, workDir: root, stdout: "job_1.log" } },
      { id: "3_4", reg: { user, workDir: root, stdout: "array_%A_%2a.log" } },
      { id: "4_2", reg: { user, workDir: root, stdout: "raw_%j.log" } },
    ], resourceIds: ["1", "2"] });
    const once = () => {
      const startedAt = Date.now();
      const spawned = spawnSync("sh", ["-c", WATCH_REMOTE_COMMAND], { input: inv.input, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 15000 });
      return { spawned, ms: Date.now() - startedAt };
    };
    // 机器内存吃紧（全量并发时常见）起子进程会卡上几秒，远端脚本给每条 Slurm 命令的 6 秒时限就不够用了。
    // 这一趟慢得不正常（正常约 0.2 秒）就重跑，最多三趟——脚本只读文件，同样的输入重跑结果相同；断言不变。
    let attempt = once();
    for (let i = 0; i < 2 && attempt.ms > 4000; i += 1) attempt = once();
    const result = attempt.spawned;
    assert.equal(result.status, 0, result.stderr);
    const parsed = parseWatchOutput(result.stdout);
    assert.equal(parsed.progress.find((p) => p.id === "1").files[0].path, out);
    assert.equal(parsed.progress.find((p) => p.id === "3_4").files[0].path, arr);
    assert.equal(parsed.progress.find((p) => p.id === "4_2").files[0].path, rawArray);
    assert.deepEqual(parsed.progress.find((p) => p.id === "2").files, []);
    assert.equal(parsed.resources.length, 1);
    assert.equal(parsed.resources[0].rows[1].id, "1.batch");
    assert.equal(parsed.resources[0].rows[0].timeLimit, "60");
    assert.equal(parsed.resources[0].rows[1].tresMax, "gres/gpumem=10240M,gres/gpuutil=95");
    assert.equal(parsed.complete, true);
    // 老 Slurm 不认识扩展列时，同一 SSH / 同一 12 秒预算内退回原来的字段。
    const oldSacct = `#!/bin/sh\ncase "$*" in *TRESUsageInMax*) exit 1;; esac\nprintf '%s\\n' '1|${user}|COMPLETED|4|2Gc||00:00:00|100|1||' '1.batch||COMPLETED|4||1024K|00:02:00|100|1||'\n`;
    writeFileSync(path.join(bin, "sacct"), oldSacct);
    spawnSync(path.join(bin, "sacct"), [], { timeout: 60000 });
    let fallback = once();
    for (let i = 0; i < 2 && fallback.ms > 4000; i += 1) fallback = once();
    assert.equal(fallback.spawned.status, 0, fallback.spawned.stderr);
    const oldParsed = parseWatchOutput(fallback.spawned.stdout);
    assert.equal(oldParsed.resources[0].rows[1].maxRss, "1024K");
    assert.equal(oldParsed.resources[0].rows[0].tresMax, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
