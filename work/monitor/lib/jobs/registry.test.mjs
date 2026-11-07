import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { COLLECTOR_SCRIPT_PATH, parseCollectorOutput } from "../collector.mjs";
import { parseSlurmSection } from "../slurm.mjs";
import { createJobRegistry, JOBREG_MAX_LINES, parseJobRegLine, parseJobRegSection } from "./registry.mjs";

const reg = (id, extra = "") => `jobreg=${id}|${id.split("_")[0]}|${id.includes("_") ? id.split("_")[1].replace(/[[\]]/g, "") : "N/A"}|train|/w/${id}|/w/${id}/o_%j.log|/w/${id}/o_%j.log|/w/run.sh${extra}`;
const section = (lines, total = lines.length) => `state=ok\nuser=kai\njobreg_total=${total}\n${lines.join("\n")}\njob=1|kai|CPU|RUNNING`;

test("jobreg 行解析：8 段定长、作业号白名单、占位符 → null、控制字符 / 超长路径丢弃", () => {
  assert.deepEqual(parseJobRegLine("18537|18537|N/A|scr3_arms|/w|/w/job_%j_%a.out|/w/job_%j_%a.out|/w/train3.slurm"), {
    jobId: "18537", arrayJobId: "18537", arrayTaskId: null, name: "scr3_arms",
    workDir: "/w", stdout: "/w/job_%j_%a.out", stderr: "/w/job_%j_%a.out", command: "/w/train3.slurm",
  });
  assert.equal(parseJobRegLine("18006_[1-3%2]|18006|1-3%2|a|/w|(null)|(null)|/w/x").arrayTaskId, null);
  assert.equal(parseJobRegLine("18006_[1-3%2]|18006|1-3%2|a|/w|(null)|(null)|/w/x").stdout, null);
  assert.equal(parseJobRegLine("1;rm|1|N/A|a|/w|/o|/e|/c"), null);
  assert.equal(parseJobRegLine("1|1|N/A|a|b|/w|/o|/e|/c"), null, "名字里多一个 | → 段数不对整行丢");
  assert.equal(parseJobRegLine(`1|1|N/A|a|/w|/o\u0007|/e|/c`).stdout, null);
  assert.equal(parseJobRegLine(`1|1|N/A|a|/w|/${"x".repeat(600)}|/e|/c`).stdout, null);
});

test("段解析：没有 jobreg_total → null（没查 / 查失败）；行数对不上 → 不完整；行数封顶", () => {
  assert.equal(parseJobRegSection("state=ok\nuser=kai\njob=1|kai"), null);
  const ok = parseJobRegSection(section([reg("1"), reg("2")]));
  assert.deepEqual([ok.user, ok.total, ok.complete, ok.entries.length, ok.badLines], ["kai", 2, true, 2, 0]);
  const cut = parseJobRegSection(section([reg("1")], 5));
  assert.equal(cut.complete, false);
  const bad = parseJobRegSection(section([reg("1"), "jobreg=garbage", reg("1")]));
  assert.deepEqual([bad.entries.length, bad.badLines, bad.complete], [1, 2, false]);
  const many = parseJobRegSection(section(Array.from({ length: 100 }, (_, i) => reg(String(i + 1)))));
  assert.equal(many.entries.length, JOBREG_MAX_LINES);
  assert.equal(parseJobRegSection("jobreg_total=0\n").complete, true);
});

test("登记：去重（首次见到时刻不变、缺的字段补上）、7 天保留、条数上限按最近见到淘汰", async () => {
  let clock = 1_000_000;
  const registry = createJobRegistry({ now: () => clock, maxEntries: 3 });
  await registry.observe("s1", parseJobRegSection(section([reg("1"), "jobreg=2|2|N/A|b|/w|(null)|(null)|/w/run.sh"])));
  clock += 1000;
  const second = await registry.observe("s1", parseJobRegSection(section([reg("1"), "jobreg=2|2|N/A|b|/w|/w/o.log|(null)|/w/run.sh"])));
  assert.equal(second.added, 0);
  assert.deepEqual([registry.lookup("s1", "1").firstSeenAt, registry.lookup("s1", "1").lastSeenAt], [1_000_000, 1_001_000]);
  assert.equal(registry.lookup("s1", "2").stdout, "/w/o.log");
  assert.equal(registry.lookup("s2", "1"), null, "按服务器隔离");

  clock += 1000;
  await registry.observe("s1", parseJobRegSection(section([reg("1")])));
  clock += 1000;
  await registry.observe("s1", parseJobRegSection(section([reg("3"), reg("4")])));
  assert.equal(registry.size(), 3, "上限 3：最久没见到的先淘汰");
  assert.equal(registry.has("s1", "2"), false);
  clock += 8 * 24 * 3600_000;
  await registry.observe("s1", parseJobRegSection(section([reg("5")])));
  assert.deepEqual(["1", "3", "4", "5"].map((id) => registry.has("s1", id)), [false, false, false, true], "超过 7 天没见到的淘汰");
});

test("登记：数组任务没有单独登记时退到排队时的数组整体记录，并补上任务号", async () => {
  const registry = createJobRegistry({ now: () => 1 });
  await registry.observe("s1", parseJobRegSection(section(["jobreg=18006_[1-9]|18006|1-9|vp|/w|/w/train_%A_%a.log|(null)|/w/run.sh"])));
  const hit = registry.lookup("s1", "18006_4");
  assert.deepEqual([hit.jobId, hit.arrayJobId, hit.arrayTaskId, hit.stdout], ["18006_4", "18006", "4", "/w/train_%A_%a.log"]);
  assert.equal(registry.lookup("s1", "18007_4"), null);
});

test("登记：运行中的数组子作业以实际编号登记，按 数组号 + 任务号 找回（v2.51 本机展开 %j）", async () => {
  const registry = createJobRegistry({ now: () => 1 });
  await registry.observe("s1", parseJobRegSection(section(["jobreg=18784|18781|2|arr|/w|/w/xp_%j.log|(null)|/w/run.sh"])));
  assert.deepEqual([registry.findArrayTask("s1", "18781", "2")?.jobId, registry.findArrayTask("s1", "18781", "3"), registry.findArrayTask("s2", "18781", "2")], ["18784", null, null]);
});

test("登记：names 给出一台服务器近期见到过的作业名（v2.62 提醒规则的建议前缀用），按服务器与时刻筛，没有名字的不带", async () => {
  let clock = 1_000_000;
  const registry = createJobRegistry({ now: () => clock });
  await registry.observe("s1", parseJobRegSection(section(["jobreg=1|1|N/A|cfdauto_setup_0001|/w|/o|/e|/c", "jobreg=2|2|N/A|(null)|/w|/o|/e|/c"])));
  await registry.observe("s2", parseJobRegSection(section(["jobreg=9|9|N/A|elsewhere|/w|/o|/e|/c"])));
  clock += 5000;
  await registry.observe("s1", parseJobRegSection(section(["jobreg=3|3|N/A|xp_wallgate|/w|/o|/e|/c"])));
  assert.deepEqual(registry.names("s1"), [{ id: "1", name: "cfdauto_setup_0001" }, { id: "3", name: "xp_wallgate" }]);
  assert.deepEqual(registry.names("s1", { since: 1_003_000 }), [{ id: "3", name: "xp_wallgate" }]);
  assert.deepEqual(registry.names("s3"), []);
  registry.names("s1")[0].name = "changed";
  assert.equal(registry.lookup("s1", "1").name, "cfdauto_setup_0001", "给出去的是副本");
});

test("作业消失：两次完整视图之间不见了才算；被截断的一轮不作数", async () => {
  const registry = createJobRegistry({ now: () => 1 });
  assert.deepEqual((await registry.observe("s1", parseJobRegSection(section([reg("1"), reg("2")])))).disappeared, [], "第一轮只建基线");
  assert.deepEqual((await registry.observe("s1", parseJobRegSection(section([reg("2")])))).disappeared, ["1"]);
  assert.deepEqual((await registry.observe("s1", parseJobRegSection(section([], 9)))).disappeared, [], "截断的一轮不判消失");
  assert.deepEqual((await registry.observe("s1", parseJobRegSection(section([])))).disappeared, [], "截断之后重新建基线");
  assert.deepEqual((await registry.observe("s1", null)).disappeared, []);
});

test("持久化：0600 原子写、重启后读回；文件损坏 → 当空表、下一次写入覆盖", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "job-registry-"));
  const file = path.join(dir, "runtime", "job-registry.json");
  try {
    const a = createJobRegistry({ filePath: file, now: () => 5 });
    await a.observe("s1", parseJobRegSection(section([reg("7")])));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const b = createJobRegistry({ filePath: file, now: () => 6 });
    await b.load();
    assert.equal(b.lookup("s1", "7").stdout, "/w/7/o_%j.log");

    writeFileSync(file, "{not json");
    const logs = [];
    const c = createJobRegistry({ filePath: file, now: () => 7, log: (msg) => logs.push(msg) });
    await c.load();
    assert.equal(c.size(), 0);
    // 坏文件先留档再当空表（lib/corrupt-archive.mjs）。
    assert.match(logs[0], /作业登记（job-registry\.json）不是有效的 JSON，原文件已留档为 job-registry\.json\.corrupt-19700101-080000，按空表重建/);
    assert.equal(readFileSync(`${file}.corrupt-19700101-080000`, "utf8"), "{not json");
    await c.observe("s1", parseJobRegSection(section([reg("8")])));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries.map((e) => e.jobId), ["8"]);

    writeFileSync(file, JSON.stringify({ entries: [{ serverId: "s1", jobId: "bad id", firstSeenAt: 1, lastSeenAt: 1 }, { serverId: "s1", jobId: "9", firstSeenAt: 7, lastSeenAt: 7, stdout: "/o\u0000" }] }));
    const d = createJobRegistry({ filePath: file, now: () => 8 });
    await d.load();
    assert.deepEqual([d.size(), d.lookup("s1", "9").stdout], [1, null], "坏条目丢弃、坏字段置空");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// collect.sh 真跑：jobreg 行只来自 `squeue -u <当前用户>`，放在 job= 之前、按整行封顶 16KB；
// 已有的 slurm 段解析不受影响。Windows 无 POSIX sh，跳过。
const FAKE_SINFO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "slurm 23.11.8"; exit 0; fi
printf '%s\\n' 'master|idle|0/192/0/192|1.73|93948|380000|0|gpu:4090:4|gpu:4090:0(IDX:N/A)|GPU|none|'
`;
const FAKE_SQUEUE = `#!/bin/sh
case "$*" in
  *" -u "*)
    [ "$FAKE_REG" = fail ] && exit 1
    i=0
    while [ $i -lt "\${FAKE_REG_N:-2}" ]; do
      printf '%s|%s|N/A|train_%s|/w|/w/o_%%j.log|/w/e_%%j.log|/w/%s|\\n' $((500 + i)) $((500 + i)) $i "$FAKE_REG_CMD"
      i=$((i + 1))
    done
    ;;
  *)
    printf '%s\\n' '16326|kai|CPU|RUNNING|44:19|UNLIMITED|1|92|cpu=92,node=1,billing=92|N/A|0|2026-09-30T11:53:47|2026-09-30T12:02:18|None|node07|job|'
    ;;
esac
`;

function runCollect(env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-jobreg-"));
  try {
    for (const [name, body] of [["sinfo", FAKE_SINFO], ["squeue", FAKE_SQUEUE]]) {
      writeFileSync(path.join(dir, name), body);
      chmodSync(path.join(dir, name), 0o755);
    }
    const res = spawnSync("/bin/sh", [COLLECTOR_SCRIPT_PATH], { encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CT_PROFILE: "slow", CT_PORTS: "7891", FAKE_REG_CMD: "run.sh", ...env } });
    assert.equal(res.status, 0, res.stderr);
    return parseCollectorOutput(res.stdout).sections.slurm;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collect.sh：jobreg_total 在汇总区、jobreg= 在 job= 之前；squeue -u 失败则整段不出", { skip: process.platform === "win32" }, () => {
  const text = runCollect({});
  const lines = text.split("\n");
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at("jobreg_total=") < at("node=") && at("jobreg=") > at("node=") && at("jobreg=") < at("job="));
  const parsed = parseJobRegSection(text);
  assert.deepEqual([parsed.total, parsed.complete, parsed.entries[0].stdout, parsed.entries[1].name], [2, true, "/w/o_%j.log", "train_1"]);
  assert.equal(parseSlurmSection(text).jobs.length, 1, "slurm 段旧解析不受影响");
  assert.equal(parseJobRegSection(runCollect({ FAKE_REG: "fail" })), null);
});

test("collect.sh：jobreg 最多 64 行、每行 ≤ 1.5KB、合计 ≤ 16KB 且不截半行", { skip: process.platform === "win32" }, () => {
  const many = parseJobRegSection(runCollect({ FAKE_REG_N: "80" }));
  assert.deepEqual([many.total, many.entries.length, many.complete], [80, 64, false]);
  const long = runCollect({ FAKE_REG_N: "40", FAKE_REG_CMD: "x".repeat(1400) });
  const regLines = long.split("\n").filter((l) => l.startsWith("jobreg="));
  assert.ok(regLines.reduce((sum, l) => sum + l.length + 1, 0) <= 16384);
  assert.ok(regLines.length >= 10 && regLines.length < 40);
  assert.ok(regLines.every((l) => l.split("|").length === 8), "没有半行");
  assert.ok(long.split("\n").some((l) => l.startsWith("job=16326|")), "job= 行不会和 jobreg 粘在一起");
});
