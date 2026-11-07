import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseFilesystem,
  COLLECTOR_SCRIPT_PATH,
  COLLECTOR_SECTION_NAMES,
  COLLECTOR_TIMEOUT_MS,
  buildCollectorInvocation,
  loadCollectorScript,
  parseAgentsInstalled,
  parseCollectorOutput,
  parseGpu,
  parseListeningPorts,
  parseProcTop,
  PROC_TOP_MAX_USERS,
} from "./collector.mjs";
import { SSH_CONTROL_ARGS } from "./ssh-args.mjs";

// ---------------------------------------------------------------------------
// 脚本本体：路径解析与缓存。
// ---------------------------------------------------------------------------

test("COLLECTOR_SCRIPT_PATH 指向仓库内的 remote/collect.sh，内容是 POSIX sh", () => {
  assert.ok(path.isAbsolute(COLLECTOR_SCRIPT_PATH));
  assert.equal(path.basename(COLLECTOR_SCRIPT_PATH), "collect.sh");
  const text = loadCollectorScript();
  assert.ok(text.startsWith("#!/bin/sh"), "必须是 #!/bin/sh，远端 bash 特性一概不用");
  assert.match(text, /__CT_BEGIN/);
  assert.doesNotMatch(text, /\[\[ /, "不得出现 bash 的 [[ ]]");
});

// ---------------------------------------------------------------------------
// buildCollectorInvocation：远端命令串只由固定模板 + 校验过的值构成。
// ---------------------------------------------------------------------------

const SERVER = { host: "myserver", remotePort: 7891 };

test("buildCollectorInvocation: fast 形态与超时", () => {
  const inv = buildCollectorInvocation({
    server: SERVER,
    parsed: {},
    profile: "fast",
    ports: [7891, "7893"],
  });
  assert.equal(inv.file, "ssh");
  assert.equal(inv.timeoutMs, 15000);
  assert.equal(inv.timeoutMs, COLLECTOR_TIMEOUT_MS.fast);
  assert.equal(inv.args.at(-1), "env CT_PROFILE='fast' CT_PORTS='7891,7893' sh -s");
  assert.equal(inv.args.at(-2), "myserver", "host 必须是命令串前一位的 ssh 位置参数");
  assert.ok(inv.input.startsWith("#!/bin/sh"), "脚本正文经 stdin 送达");
});

test("buildCollectorInvocation: slow 形态只带 profile 与端口，超时 20s", () => {
  const inv = buildCollectorInvocation({
    server: SERVER,
    parsed: {},
    profile: "slow",
    ports: [7891],
  });
  assert.equal(inv.timeoutMs, 20000);
  assert.equal(inv.timeoutMs, COLLECTOR_TIMEOUT_MS.slow);
  assert.equal(inv.args.at(-1), "env CT_PROFILE='slow' CT_PORTS='7891' sh -s");
});

test("buildCollectorInvocation: 参数经数组传递，命令串是单个元素、值全部单引号包裹", () => {
  const inv = buildCollectorInvocation({ server: SERVER, parsed: {}, profile: "slow", ports: [7891] });
  // 除末尾那一个远端命令串外，其余参数里不得出现空格拼接出来的"半条命令"。
  const command = inv.args.at(-1);
  assert.equal(inv.args.filter((a) => a.includes("sh -s")).length, 1);
  // 白名单已排除单引号，因此包裹后不可能被闭合逃逸。
  assert.equal((command.match(/'/g) || []).length % 2, 0);
  assert.doesNotMatch(command, /[;&|`$()<>]/, "远端命令串不得含任何 shell 元字符");
});

test("buildCollectorInvocation: 非法 profile / 非法端口直接 throw", () => {
  for (const bad of ["FAST", "", undefined, null, "slow;id"]) {
    assert.throws(() => buildCollectorInvocation({ server: SERVER, profile: bad }), /unsafe collector profile/);
  }
  assert.throws(
    () => buildCollectorInvocation({ server: SERVER, profile: "fast", ports: ["7891; rm -rf /"] }),
    /unsafe collector port/,
  );
  assert.throws(
    () => buildCollectorInvocation({ server: SERVER, profile: "fast", ports: [0] }),
    /unsafe collector port/,
  );
});

test("buildCollectorInvocation: win32 剔除 ControlMaster 三项，其它平台不变", () => {
  const win = buildCollectorInvocation({ server: SERVER, profile: "fast", platform: "win32" });
  assert.ok(!win.args.includes("ControlMaster=auto"));
  assert.ok(!win.args.some((a) => String(a).startsWith("ControlPath=")));
  assert.ok(!win.args.includes("ControlPersist=5m"));
  assert.equal(win.args.at(-2), "myserver");

  const mac = buildCollectorInvocation({ server: SERVER, profile: "fast", platform: "darwin" });
  for (const part of SSH_CONTROL_ARGS) assert.ok(mac.args.includes(part), `darwin 应保留 ${part}`);
});

// ---------------------------------------------------------------------------
// parseCollectorOutput。
// ---------------------------------------------------------------------------

// 每个 profile 应有的段（顺序即 collect.sh 的输出顺序）；缺段判定由用例自己比对。
const PROFILE_SECTIONS = {
  fast: ["reclaude-logs", "reclaude-state", "ports"],
  slow: ["sys", "cpu-stat", "filesystem", "gpu", "agents", "ports", "proc-top", "tunnel-egress", "slurm"],
};
const missingOf = (sections, profile) => PROFILE_SECTIONS[profile].filter((name) => !(name in sections));

const FULL_SLOW = [
  "__CT_BEGIN sys__",
  "node05",
  " 15:04:01 up 12 days,  3:22,  4 users,  load average: 1.20, 1.05, 0.98",
  "              total        used        free      shared  buff/cache   available",
  "Mem:          251Gi        31Gi       120Gi       1.0Gi        99Gi       217Gi",
  "/dev/sda2       1.8T   1.1T  620G  65% /public/newhome",
  "nproc: 64",
  "__CT_END sys__",
  // v2.20（T03）：slow 新增 cpu-stat 与 filesystem 段。
  "__CT_BEGIN cpu-stat__",
  "cpu=74608 2520 244216 1140134 24669 0 10829 0 0 0",
  "boot_id=6ffc0f4a000000000000000000000000",
  "__CT_END cpu-stat__",
  "__CT_BEGIN filesystem__",
  "state=ok",
  "device=/dev/mapper/public-newhome",
  "total_kb=46137346000",
  "used_kb=39438540312",
  "avail_kb=6698805688",
  "capacity_pct=86",
  "mount=/public/newhome",
  "inodes_total=1073741824",
  "inodes_used=12345678",
  "inode_pct=2",
  "__CT_END filesystem__",
  "__CT_BEGIN gpu__",
  "0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
  "__CT_END gpu__",
  "__CT_BEGIN agents__",
  "codex=1",
  "reclaude=1",
  "zcode=0",
  "reclaudeActive=active",
  "user=kai",
  "hostname=node05",
  "__CT_END agents__",
  "__CT_BEGIN ports__",
  "LISTEN 0      4096       127.0.0.1:7891       0.0.0.0:*",
  "__CT_END ports__",
  // v2.62：slurm 之前新增 proc-top 段（占用现场，解析见 parseProcTop）。
  "__CT_BEGIN proc-top__",
  "sampled=40",
  "slurm=1",
  "top=kai|1449.0|0.0|126000000|0|12|0",
  "top=lin|0.0|554.0|0|67000000|0|6",
  "__CT_END proc-top__",
  // proc-top 与 slurm 之间新增 tunnel-egress 段（经隧道出网的程序，解析见 lib/tunnel-egress.mjs）。
  "__CT_BEGIN tunnel-egress__",
  "state=ok",
  "port=7891",
  "detail=full",
  "total=3|1200|18000",
  "others=0|-|-",
  "progs=1",
  "prog=codex|3|1200|18000",
  "__CT_END tunnel-egress__",
  // v2.32：slow 末尾新增 slurm 段（解析见 lib/slurm.mjs）。
  "__CT_BEGIN slurm__",
  "state=ok",
  "version=23.11.8",
  "node=node05|idle|0/192/0/192|0.00|366257|350000|0|(null)|gpu:0|CPU*|none",
  "__CT_END slurm__",
  "",
].join("\n");

test("parseCollectorOutput: 完整 slow 输出各段齐全", () => {
  const { sections } = parseCollectorOutput(FULL_SLOW);
  assert.deepEqual(Object.keys(sections).sort(), PROFILE_SECTIONS.slow.slice().sort());
  assert.ok(sections.sys.startsWith("node05\n"), "sys 首行必须是 hostname（parseRemoteLoad 依赖）");
  assert.match(sections.sys, /nproc: 64$/);
  assert.match(sections.ports, /127\.0\.0\.1:7891/);
});

test("parseCollectorOutput: 缺段不影响其它段", () => {
  const partial = FULL_SLOW.replace(/__CT_BEGIN gpu__\n[\s\S]*?__CT_END gpu__\n/, "");
  const { sections } = parseCollectorOutput(partial);
  assert.deepEqual(missingOf(sections, "slow"), ["gpu"]);
  assert.ok(sections.sys);
  assert.ok(sections.ports);
});

test("parseCollectorOutput: 段内出现 marker 字样的日志行不误切", () => {
  const raw = [
    "__CT_BEGIN reclaude-logs__",
    "2026-09-02 ERROR upstream said __CT_BEGIN sys__ which is just text",
    "__CT_END sys__",
    "__CT_BEGIN ports__",
    "  __CT_END reclaude-logs__ (缩进，不是整行精确匹配)",
    "still inside the logs section",
    "__CT_END reclaude-logs__",
    "__CT_BEGIN reclaude-state__",
    '{"status":"idle"}',
    "__CT_END reclaude-state__",
    "__CT_BEGIN ports__",
    "LISTEN 0 4096 127.0.0.1:7891 0.0.0.0:*",
    "__CT_END ports__",
  ].join("\n");
  const { sections } = parseCollectorOutput(raw);
  assert.deepEqual(missingOf(sections, "fast"), []);
  assert.ok(!("sys" in sections), "伪 BEGIN sys 不得切出 sys 段");
  assert.match(sections["reclaude-logs"], /__CT_END sys__/);
  assert.match(sections["reclaude-logs"], /still inside the logs section/);
  assert.match(sections["reclaude-logs"], /缩进，不是整行精确匹配/);
  assert.equal(sections["reclaude-state"], '{"status":"idle"}');
  assert.match(sections.ports, /127\.0\.0\.1:7891/);
});

test("parseCollectorOutput: 同名段先到先得，后来的伪段覆盖不了真段", () => {
  const raw = [
    "__CT_BEGIN ports__",
    "ok",
    "__CT_END ports__",
    "__CT_BEGIN ports__",
    "skip:forged",
    "__CT_END ports__",
  ].join("\n");
  assert.equal(parseCollectorOutput(raw).sections.ports, "ok");
});

test("parseCollectorOutput: 输出被截断（缺尾部 END）时保留半段并报缺段", () => {
  const truncated = [
    "__CT_BEGIN sys__",
    "node05",
    "__CT_END sys__",
    "__CT_BEGIN cpu-stat__",
    "cpu=1 2 3 4 5 6 7 8 9 10",
    "__CT_END cpu-stat__",
    "__CT_BEGIN filesystem__",
    "state=ok",
    "__CT_END filesystem__",
    "__CT_BEGIN gpu__",
    "0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
  ].join("\n");
  const { sections } = parseCollectorOutput(truncated);
  assert.equal(sections.sys, "node05");
  assert.match(sections.gpu, /RTX 4090/);
  assert.deepEqual(missingOf(sections, "slow"), ["agents", "ports", "proc-top", "tunnel-egress", "slurm"]);
});

test("parseCollectorOutput: 空输出 / 垃圾输出全段缺失且不抛", () => {
  assert.deepEqual(parseCollectorOutput("").sections, {});
  assert.deepEqual(parseCollectorOutput(null).sections, {});
  assert.deepEqual(parseCollectorOutput("ssh: connect to host myserver port 22: Operation timed out").sections, {});
});

test("parseCollectorOutput: CRLF 行尾也能识别 marker", () => {
  const raw = "__CT_BEGIN ports__\r\nok\r\n__CT_END ports__\r\n";
  assert.equal(parseCollectorOutput(raw).sections.ports, "ok");
});

// ---------------------------------------------------------------------------
// parseGpu / parseListeningPorts / parseAgentsInstalled。
// ---------------------------------------------------------------------------

test("parseGpu: 集群 4×RTX 4090 实测样本", () => {
  const sample = [
    "0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
    "1, NVIDIA GeForce RTX 4090, 21851 MiB, 24564 MiB, 34 %",
    "2, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
    "3, NVIDIA GeForce RTX 4090, 12000 MiB, 24564 MiB, 100 %",
  ].join("\n");
  const gpus = parseGpu(sample);
  assert.equal(gpus.length, 4);
  assert.deepEqual(gpus[0], { index: 0, name: "NVIDIA GeForce RTX 4090", memUsedMb: 8, memTotalMb: 24564, util: 0 });
  assert.deepEqual(gpus[3], { index: 3, name: "NVIDIA GeForce RTX 4090", memUsedMb: 12000, memTotalMb: 24564, util: 100 });
  for (const g of gpus) {
    assert.equal(typeof g.index, "number");
    assert.equal(typeof g.memUsedMb, "number");
    assert.equal(typeof g.util, "number");
  }
});

// 2026-10-03 在集群登录节点真跑两条 nvidia-smi 查询拿到的样本（uuid 截短，进程名经 ps 取得）：
// 四张卡各挂一个 nvidia-cuda-mps 守护进程（28 MiB），其余是 kai 的 python 训练进程。
const GPU_SAMPLE_V245 = [
  "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71",
  "gpu=1, GPU-99ad, NVIDIA GeForce RTX 4090, 13658, 24564, 100, 56, 232.62",
  "gpu=2, GPU-550c, NVIDIA GeForce RTX 4090, 10898, 24564, 100, 59, 221.85",
  "gpu=3, GPU-d0b3, NVIDIA GeForce RTX 4090, 10938, 24564, 100, 57, 238.36",
  "gpuapp=GPU-8a88|kai|28|nvidia-cuda-mps",
  "gpuapp=GPU-8a88|kai|4412|python",
  "gpuapp=GPU-8a88|kai|5358|python",
  "gpuapp=GPU-99ad|kai|28|nvidia-cuda-mps",
  "gpuapp=GPU-99ad|kai|5434|python",
  "gpuapp=GPU-99ad|kai|6570|python",
  "gpuapp=GPU-99ad|kai|1618|python",
  "gpuapp=GPU-550c|kai|28|nvidia-cuda-mps",
  "gpuapp=GPU-550c|kai|5430|python",
  "gpuapp=GPU-550c|kai|5432|python",
  "gpuapp=GPU-d0b3|kai|28|nvidia-cuda-mps",
  "gpuapp=GPU-d0b3|kai|4392|python",
  "gpuapp=GPU-d0b3|kai|6510|python",
].join("\n");

test("parseGpu: v2.45 格式——温度、功耗、每张卡的占用者（MPS 守护进程不算）", () => {
  const gpus = parseGpu(GPU_SAMPLE_V245);
  assert.equal(gpus.length, 4);
  assert.deepEqual(gpus[0], {
    index: 0, name: "NVIDIA GeForce RTX 4090", memUsedMb: 9806, memTotalMb: 24564, util: 100,
    tempC: 57, powerW: 210.7, users: [{ user: "kai", memMb: 9770 }],
  });
  assert.deepEqual(gpus.map((g) => [g.tempC, g.powerW]), [[57, 210.7], [56, 232.6], [59, 221.9], [57, 238.4]]);
  assert.deepEqual(gpus[1].users, [{ user: "kai", memMb: 13622 }]);
  assert.ok(gpus.every((g) => !("uuid" in g)), "uuid 只用于归卡，不外露");
});

test("parseGpu: v2.45 格式——乱序按 index 排、重复的卡只收一次、缺读数的行与孤儿进程丢弃", () => {
  const gpus = parseGpu([
    "gpu=1, GPU-b, Tesla T4, 14, 15360, 0, [N/A], [N/A]",
    "gpu=0, GPU-a, Tesla T4, 2048, 15360, [N/A], 41, ",
    "gpu=1, GPU-b2, Tesla T4, 99, 15360, 9, 1, 1",
    "gpu=2, GPU-c, Tesla T4, [N/A], [N/A], 0, 30, 20",
    "gpuapp=GPU-a|alice|2000|python",
    "gpuapp=GPU-a||40|",
    "gpuapp=GPU-nope|bob|1|python",
    "garbage line",
  ].join("\n"));
  assert.deepEqual(gpus, [
    { index: 0, name: "Tesla T4", memUsedMb: 2048, memTotalMb: 15360, util: null, tempC: 41, powerW: null, users: [{ user: "alice", memMb: 2000 }, { user: "未知", memMb: 40 }] },
    { index: 1, name: "Tesla T4", memUsedMb: 14, memTotalMb: 15360, util: 0, tempC: null, powerW: null, users: [] },
  ]);
});

test("parseGpu: 无 nvidia-smi（空段）与坏行", () => {
  assert.deepEqual(parseGpu(""), []);
  assert.deepEqual(parseGpu(null), []);
  assert.deepEqual(parseGpu("nvidia-smi: command not found"), []);
  const mixed = [
    "garbage line",
    "x, NVIDIA, 1 MiB, 2 MiB, 3 %",
    "0, , 1 MiB, 2 MiB, 3 %",
    "1, NVIDIA GeForce RTX 4090, [N/A], 24564 MiB, 0 %",
    "2, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
  ].join("\n");
  assert.deepEqual(parseGpu(mixed), [
    { index: 2, name: "NVIDIA GeForce RTX 4090", memUsedMb: 8, memTotalMb: 24564, util: 0 },
  ]);
});

// v2.62：gpuapp 行尾追加 Slurm 作业号。采集账号自己的进程另按作业合并显存；别人的仍只到属主。
const GPU_SAMPLE_V262 = [
  "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71",
  "gpu=1, GPU-99ad, NVIDIA GeForce RTX 4090, 13658, 24564, 100, 56, 232.62",
  "gpuapp=GPU-8a88|kai|28|nvidia-cuda-mps|",
  "gpuapp=GPU-8a88|kai|4412|python|48213",
  "gpuapp=GPU-8a88|kai|5358|python|48214",
  "gpuapp=GPU-99ad|kai|28|nvidia-cuda-mps|",
  "gpuapp=GPU-99ad|kai|5434|python|48213",
  "gpuapp=GPU-99ad|kai|1618|python|", // 自己不经 Slurm 直接跑的进程
  "gpuapp=GPU-99ad|lin|6570|python|48300",
].join("\n");

test("parseGpu: v2.62 格式——给了采集账号，它在每张卡上的那一项带 jobs（按作业合并的显存）；别人的不带", () => {
  const gpus = parseGpu(GPU_SAMPLE_V262, { selfUser: "kai" });
  assert.deepEqual(gpus[0].users, [
    { user: "kai", memMb: 9770, jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }] },
  ]);
  assert.deepEqual(gpus[1].users, [
    { user: "kai", memMb: 7052, jobs: [{ id: "48213", memMb: 5434 }] },
    { user: "lin", memMb: 6570 },
  ]);
  // 卡本身的字段一个不多一个不少
  assert.deepEqual(Object.keys(gpus[0]), ["index", "name", "memUsedMb", "memTotalMb", "util", "tempC", "powerW", "users"]);
});

test("parseGpu: v2.62 格式——没给采集账号时与 v2.45 的结果完全一样；v2.45 的四段行在新解析器下照旧", () => {
  const noJobField = GPU_SAMPLE_V262.split("\n").map((line) => (line.startsWith("gpuapp=") ? line.replace(/\|[^|]*$/, "") : line)).join("\n");
  assert.deepEqual(parseGpu(GPU_SAMPLE_V262), parseGpu(noJobField));
  assert.deepEqual(parseGpu(noJobField, { selfUser: "kai" }), parseGpu(noJobField), "旧格式没有作业号：给了账号也分不出作业");
  assert.deepEqual(parseGpu(GPU_SAMPLE_V245, { selfUser: "kai" }), parseGpu(GPU_SAMPLE_V245));
  assert.deepEqual(parseGpu(GPU_SAMPLE_V262)[1].users, [{ user: "kai", memMb: 7052 }, { user: "lin", memMb: 6570 }]);
});

// v2.76（L2）：gpuproc 行——逐进程明细并进属主那一项；与 gpuapp 混在一段里也照旧能读
// （远端脚本与本机是同一次发布，混排只可能出现在人工粘贴的样本里，但解析器不该因此丢数据）。
test("parseGpu: v2.76 格式——属主那一项带 procs（pid / 已运行秒数 / 命令行），不经 Slurm 的进程也在", () => {
  const text = [
    "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 20000, 24564, 100, 57, 210.71",
    "gpuproc=GPU-8a88|1|28|kai|9000||nvidia-cuda-mps-control -d",
    "gpuproc=GPU-8a88|2|4412|kai|3600|48213|python train.py",
    "gpuproc=GPU-8a88|3|900|kai|7200||python -u infer.py",
    "gpuproc=GPU-8a88|4|3000|lin|300||jupyter-lab --no-browser",
  ].join("\n");
  assert.deepEqual(parseGpu(text, { selfUser: "kai" })[0].users, [
    {
      user: "kai", memMb: 5312,
      procs: [
        { pid: "2", memMb: 4412, etimes: 3600, jobId: "48213", comm: "python", cmdline: "python train.py" },
        { pid: "3", memMb: 900, etimes: 7200, jobId: null, comm: "python", cmdline: "python -u infer.py" },
      ],
      jobs: [{ id: "48213", memMb: 4412 }],
    },
    {
      user: "lin", memMb: 3000,
      procs: [{ pid: "4", memMb: 3000, etimes: 300, jobId: null, comm: "jupyter-lab", cmdline: "jupyter-lab --no-browser" }],
    },
  ]);
});

test("parseGpu: gpuproc 与 gpuapp 混排——两种行都收，只有 gpuproc 带 procs", () => {
  const text = [
    "gpu=0, GPU-a, N, 100, 200, 50, 40, 60",
    "gpuproc=GPU-a|7|10|kai|60|48213|python a.py",
    "gpuapp=GPU-a|lin|20|python|48214",
  ].join("\n");
  const users = parseGpu(text, { selfUser: "kai" })[0].users;
  assert.deepEqual(users.map((u) => u.user), ["lin", "kai"], "按显存降序：lin 20 > kai 10");
  assert.equal("procs" in users[0], false, "gpuapp 旧行不产生 procs");
  assert.deepEqual(users[1].procs, [{ pid: "7", memMb: 10, etimes: 60, jobId: "48213", comm: "python", cmdline: "python a.py" }]);
});

// ---------------------------------------------------------------------------
// parseProcTop：占用现场（v2.62）。
// ---------------------------------------------------------------------------

test("parseProcTop: 按账号的 CPU 与常驻内存，分作业内 / 作业外", () => {
  assert.deepEqual(parseProcTop([
    "sampled=40",
    "slurm=1",
    "top=kai|1449.0|12.5|126000000|2048|12|3",
    "top=lin|0.0|554.0|0|67000000|0|6",
  ].join("\n")), {
    sampled: 40,
    slurm: true,
    users: [
      { user: "kai", cpuJobPct: 1449, cpuOtherPct: 12.5, rssJobKb: 126000000, rssOtherKb: 2048, procsJob: 12, procsOther: 3 },
      { user: "lin", cpuJobPct: 0, cpuOtherPct: 554, rssJobKb: 0, rssOtherKb: 67000000, procsJob: 0, procsOther: 6 },
    ],
  });
});

test("parseProcTop: 空段 / 没有有效的 top= 行 → null（远端 ps 不可用、超时，或旧脚本）", () => {
  assert.equal(parseProcTop(""), null);
  assert.equal(parseProcTop(null), null);
  assert.equal(parseProcTop("sampled=0\nslurm=1"), null);
  assert.equal(parseProcTop("ps: unknown option -- e"), null);
});

test("parseProcTop: slurm=0 时不认作业内外；但这一轮确有进程在作业里就认（远端只看了常见的 cgroup 目录）", () => {
  assert.equal(parseProcTop("sampled=3\nslurm=0\ntop=root|0.0|80.0|0|1024|0|3").slurm, false);
  assert.equal(parseProcTop("top=root|0.0|80.0|0|1024|0|3").slurm, false, "没有 slurm= 行按分不出算");
  assert.equal(parseProcTop("slurm=0\ntop=kai|5.0|0.0|10|0|1|0").slurm, true);
  assert.equal(parseProcTop("slurm=yes\ntop=root|0.0|80.0|0|1024|0|3").slurm, false, "只认 1");
});

test("parseProcTop: 坏行逐行丢弃、同名只收第一条、条数封顶、行尾多出来的字段忽略", () => {
  const lines = [
    "sampled=abc",
    "slurm=1",
    "top=kai|10.0|0.0|100|0|1|0",
    "top=kai|99.0|0.0|100|0|1|0", // 重复的账号
    "top=bad name|1.0|1.0|1|1|1|1",
    "top=<script>|1.0|1.0|1|1|1|1",
    "top=short|1.0|1.0|1",
    "top=neg|-1.0|1.0|1|1|1|1",
    "top=nan|x|1.0|1|1|1|1",
    "top=huge|99999999.0|1.0|1|1|1|1", // 超出上限的数字按损坏处理
    "top=float-rss|1.0|1.0|1.5|1|1|1", // 内存与进程数只认整数
    "top=future|1.0|2.0|3|4|5|6|以后|追加的字段",
    "garbage",
  ];
  const parsed = parseProcTop(lines.join("\n"));
  assert.equal(parsed.sampled, null);
  assert.deepEqual(parsed.users.map((u) => u.user), ["kai", "future"]);
  assert.equal(parsed.users[0].cpuJobPct, 10);
  assert.deepEqual(parsed.users[1], { user: "future", cpuJobPct: 1, cpuOtherPct: 2, rssJobKb: 3, rssOtherKb: 4, procsJob: 5, procsOther: 6 });
  const many = Array.from({ length: PROC_TOP_MAX_USERS + 4 }, (_, i) => `top=u${i}|1.0|0.0|1|0|1|0`).join("\n");
  assert.equal(parseProcTop(many).users.length, PROC_TOP_MAX_USERS);
});

test("parseListeningPorts: ss -ltn 样本含 127.0.0.1:7891", () => {
  const sample = [
    "State   Recv-Q  Send-Q   Local Address:Port     Peer Address:Port Process",
    "LISTEN  0       4096         127.0.0.1:7891          0.0.0.0:*",
    "LISTEN  0       128            0.0.0.0:22             0.0.0.0:*",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(sample, [7891, 22, 7893]), { 7891: true, 22: true, 7893: false });
});

test("parseListeningPorts: 前缀端口不得误命中（:65535 不算 :6553 监听）", () => {
  const sample = "LISTEN  0  4096  127.0.0.1:65535  0.0.0.0:*";
  assert.deepEqual(parseListeningPorts(sample, [655, 6553, 65535]), { 655: false, 6553: false, 65535: true });
  // 端口区间外的项直接不进结果（与 assertSafePort 同一区间）。
  assert.deepEqual(parseListeningPorts(sample, [78915]), {});
});

test("parseListeningPorts: 空段 / 非法端口项 / 空列表", () => {
  assert.deepEqual(parseListeningPorts("", [7891]), { 7891: false });
  assert.deepEqual(parseListeningPorts(null, [7891]), { 7891: false });
  assert.deepEqual(parseListeningPorts("x", ["nope", 0, 70000]), {});
  assert.deepEqual(parseListeningPorts("x", []), {});
});

test("parseAgentsInstalled: key=value 解析与缺失回落", () => {
  const text = [
    "codex=1",
    "claude=1",
    "reclaude=0",
    "zcode=1",
    "reclaudeActive=inactive",
    "user=kai",
    "hostname=node05",
    "unknownKey=whatever",
  ].join("\n");
  assert.deepEqual(parseAgentsInstalled(text), {
    codex: true,
    claude: true,
    reclaude: false,
    zcode: true,
    reclaudeActive: "inactive",
    user: "kai",
    hostname: "node05",
  });
  assert.deepEqual(parseAgentsInstalled(""), {
    codex: false,
    claude: false,
    reclaude: false,
    zcode: false,
    reclaudeActive: "unknown",
    user: "",
    hostname: "",
  });
  // systemctl 缺失或状态异常统一收成 unknown/inactive 三值。
  assert.equal(parseAgentsInstalled("reclaudeActive=failed").reclaudeActive, "unknown");
  assert.equal(parseAgentsInstalled("reclaudeActive=active").reclaudeActive, "active");
  // L3 远端动作已移除：旧脚本残留的 reclaudeUnit 行按未知键忽略，不进解析结果。
  assert.equal("reclaudeUnit" in parseAgentsInstalled("reclaudeUnit=present"), false);
});

// ---------------------------------------------------------------------------
// 段名常量：下一波（探针改接）按名取段，写死在这里防漂移。
// ---------------------------------------------------------------------------

test("段名集合固定", () => {
  assert.deepEqual(COLLECTOR_SECTION_NAMES, [
    "sys",
    "cpu-stat",
    "filesystem",
    "gpu",
    "ports",
    "agents",
    "proc-top",
    "tunnel-egress",
    "slurm",
    "reclaude-state",
    "reclaude-logs",
  ]);
});

// ---------------------------------------------------------------------------
// 端到端：真跑一次本机 collect.sh（slow，只读），
// 确认脚本产出的 marker 与解析器互相咬合。Windows 无 POSIX sh，跳过。
// ---------------------------------------------------------------------------

test("collect.sh 真跑一轮（slow）：marker 与解析器咬合", { skip: process.platform === "win32" }, () => {
  const res = spawnSync("/bin/sh", [COLLECTOR_SCRIPT_PATH], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, CT_PROFILE: "slow", CT_PORTS: "7891" },
  });
  assert.equal(res.status, 0, res.stderr);

  const { sections } = parseCollectorOutput(res.stdout);
  // v2.20（T03）：slow 在 sys 后新增 cpu-stat 与 filesystem 两段；v2.32 末尾新增 slurm；v2.62 在它之前新增 proc-top。
  assert.deepEqual(Object.keys(sections), PROFILE_SECTIONS.slow, "slow 各段必须齐全且按序");
  // sys 首行是 hostname，parseRemoteLoad 依赖这一点。
  assert.ok(sections.sys.split("\n")[0].length > 0);
  const agents = parseAgentsInstalled(sections.agents);
  assert.ok(agents.user.length > 0, "agents 段必须带 user");
  assert.ok(agents.hostname.length > 0, "agents 段必须带 hostname");
  assert.ok(["active", "inactive", "unknown"].includes(agents.reclaudeActive));
  assert.equal("reclaudeUnit" in agents, false, "采集脚本不再探测 reclaude 单元文件");
});

test("collect.sh 非法参数：坏端口只让对应段 skip，其它段照常", { skip: process.platform === "win32" }, () => {
  const res = spawnSync("/bin/sh", [COLLECTOR_SCRIPT_PATH], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      CT_PROFILE: "slow",
      CT_PORTS: "7891; rm -rf /",
    },
  });
  assert.equal(res.status, 0, res.stderr);
  const { sections } = parseCollectorOutput(res.stdout);
  assert.deepEqual(missingOf(sections, "slow"), []);
  assert.equal(sections.ports, "skip:bad-ports");
  assert.ok(sections.sys.length > 0, "坏参数不得影响 sys 段");
  assert.doesNotMatch(res.stdout, /uid=\d+/, "注入串绝不能被当命令执行");
});

test("collect.sh filesystem 段：df -Pi 首列是设备名，inode 百分比不错位（曾报 inode 506172879%）", { skip: process.platform === "win32" }, () => {
  const bin = mkdtempSync(path.join(tmpdir(), "fake-df-"));
  try {
    // 集群真实输出（myserver，2026-10-01）
    writeFileSync(path.join(bin, "df"), [
      "#!/bin/sh",
      'case "$*" in',
      '  *-i*) printf "Filesystem        Inodes     IUsed     IFree IUse%% Mounted on\\n/dev/sda       732516352 226343473 506172879   31%% /public\\n" ;;',
      '  *) printf "Filesystem     1024-blocks       Used  Available Capacity Mounted on\\n/dev/sda    46669262848 40527388672 3801358336      92%% /public\\n" ;;',
      "esac",
      "",
    ].join("\n"));
    chmodSync(path.join(bin, "df"), 0o755);
    const res = spawnSync("/bin/sh", [COLLECTOR_SCRIPT_PATH], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CT_PROFILE: "slow", CT_PORTS: "" },
    });
    assert.equal(res.status, 0, res.stderr);
    const fs = parseFilesystem(parseCollectorOutput(res.stdout).sections.filesystem);
    assert.equal(fs.inodesTotal, 732516352);
    assert.equal(fs.inodesUsed, 226343473);
    assert.equal(fs.inodePct, 31);
    assert.equal(fs.capacityPct, 92);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gpu 段真跑：假 nvidia-smi / ps 覆盖「完整查询」与「老驱动不认温度、功耗字段 → 回退并留空」两条路径。
// /bin/sh 与 dash（若有）各跑一遍。
// ---------------------------------------------------------------------------

const FAKE_NVIDIA_SMI = `#!/bin/sh
case "$*" in
  *temperature.gpu*)
    [ "$FAKE_GPU_MODE" = "old-driver" ] && { echo "Field \\"temperature.gpu\\" is not a valid field to query." >&2; exit 2; }
    printf '0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71\\n1, GPU-99ad, NVIDIA GeForce RTX 4090, 13658, 24564, 100, 56, 232.62\\n' ;;
  *query-gpu=*)
    printf '0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100\\n1, GPU-99ad, NVIDIA GeForce RTX 4090, 13658, 24564, 100\\n' ;;
  *query-compute-apps*)
    printf 'GPU-8a88, 3223871, 28\\nGPU-8a88, 3223819, 4412\\nGPU-99ad, 3223871, 28\\nGPU-99ad, 3226120, 5434\\nGPU-99ad, 99, 12\\nGPU-99ad, bad;pid, 1\\n' ;;
esac
`;
// ps：只接管 gpu 段的那一种调用，其余交回系统的 ps。
// v2.76 起 gpu 段一次取「属主 / 已运行秒数 / 命令行」三列，进程名由本机从命令行第一个词的 basename 推：
// 3223871 的 args 是 nvidia-cuda-mps-control → 本机仍认得出它是 MPS 守护进程（不算占用者）。
// FAKE_PS_NO_ETIMES=1 模拟老 ps（BusyBox）：带 etimes 的那次调用直接失败，
// 只有不带 etimes 的两次调用有输出——采集脚本据此退回「属主 + 命令行」两列，秒数留空。
const FAKE_PS = `#!/bin/sh
case "$*" in
  *etimes*) [ "$FAKE_PS_NO_ETIMES" = "1" ] && exit 1 ;;
esac
case "$*" in
  *user:32=,etimes=,args=*)
    for last; do :; done
    case "$last" in
      3223871) printf 'kai       9000 nvidia-cuda-mps-control -d\\n' ;;
      3223819) printf 'kai       3600 python train.py --epochs 10\\n' ;;
      3226120) printf 'kai       120 python -u infer.py\\n' ;;
      *) exit 1 ;;
    esac ;;
  *user:32=,args=*)
    for last; do :; done
    case "$last" in
      3223871) printf 'kai       nvidia-cuda-mps-control -d\\n' ;;
      3223819) printf 'kai       python train.py --epochs 10\\n' ;;
      3226120) printf 'kai       python -u infer.py\\n' ;;
      *) exit 1 ;;
    esac ;;
  *) exec /bin/ps "$@" ;;
esac
`;
const GPU_SHELLS = ["/bin/sh", "/bin/dash"].filter((sh) => spawnSync(sh, ["-c", "exit 0"]).status === 0);

function runGpuSection(shell, mode, extraEnv = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), "fake-gpu-"));
  try {
    for (const [name, body] of [["nvidia-smi", FAKE_NVIDIA_SMI], ["ps", FAKE_PS]]) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
      // 先执行一次：macOS 对新写出的可执行文件第一次执行要做安全评估（机器忙时能卡上几十秒），放在计时之外
      spawnSync(path.join(bin, name), ["--version"], { timeout: 60000 });
    }
    const res = spawnSync(shell, [COLLECTOR_SCRIPT_PATH], {
      encoding: "utf8",
      timeout: 30000,
      // CT_FS_ROOT 指到一个没有 proc/ 的目录：不管测试跑在哪台机器上，这几个假 pid 都读不到 cgroup
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CT_PROFILE: "slow", CT_PORTS: "", CT_FS_ROOT: bin, FAKE_GPU_MODE: mode, ...extraEnv },
    });
    assert.equal(res.status, 0, res.stderr);
    return parseCollectorOutput(res.stdout).sections.gpu;
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

for (const shell of GPU_SHELLS) {
  test(`collect.sh gpu 段（${shell}）：每张卡一行 gpu=、每个进程一行 gpuproc=，属性与命令行来自 ps`, { skip: process.platform === "win32" }, () => {
    const section = runGpuSection(shell, "full");
    assert.deepEqual(section.split("\n"), [
      "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71",
      "gpu=1, GPU-99ad, NVIDIA GeForce RTX 4090, 13658, 24564, 100, 56, 232.62",
      // 第 6 段是 v2.62 追加的作业号：假文件系统里没有这几个 pid，读不到 cgroup → 留空；第 7 段是命令行
      "gpuproc=GPU-8a88|3223871|28|kai|9000||nvidia-cuda-mps-control -d",
      "gpuproc=GPU-8a88|3223819|4412|kai|3600||python train.py --epochs 10",
      "gpuproc=GPU-99ad|3223871|28|kai|9000||nvidia-cuda-mps-control -d",
      "gpuproc=GPU-99ad|3226120|5434|kai|120||python -u infer.py",
      "gpuproc=GPU-99ad|99|12||||", // ps 查不到（进程刚退出）：属主、秒数、命令行留空；非数字 pid 的行直接跳过
    ]);
    const parsed = parseGpu(section);
    assert.deepEqual(parsed.map(({ index, memUsedMb, memTotalMb, util, tempC, powerW }) => ({ index, memUsedMb, memTotalMb, util, tempC, powerW })), [
      { index: 0, memUsedMb: 9806, memTotalMb: 24564, util: 100, tempC: 57, powerW: 210.7 },
      { index: 1, memUsedMb: 13658, memTotalMb: 24564, util: 100, tempC: 56, powerW: 232.6 },
    ]);
    // MPS 守护进程（args 的 basename 是 nvidia-cuda-mps-control）不算占用者；逐进程明细挂在属主那一项上
    assert.deepEqual(parsed[0].users, [{
      user: "kai", memMb: 4412,
      procs: [{ pid: "3223819", memMb: 4412, etimes: 3600, jobId: null, comm: "python", cmdline: "python train.py --epochs 10" }],
    }]);
    assert.deepEqual(parsed[1].users, [
      {
        user: "kai", memMb: 5434,
        procs: [{ pid: "3226120", memMb: 5434, etimes: 120, jobId: null, comm: "python", cmdline: "python -u infer.py" }],
      },
      { user: "未知", memMb: 12, procs: [{ pid: "99", memMb: 12, etimes: null, jobId: null, comm: "", cmdline: "" }] },
    ]);
  });

  test(`collect.sh gpu 段（${shell}）：老 ps 不认 etimes → 退回「属主 + 命令行」两列，秒数留空但人还在`, { skip: process.platform === "win32" }, () => {
    const section = runGpuSection(shell, "full", { FAKE_PS_NO_ETIMES: "1" });
    assert.deepEqual(section.split("\n").filter((line) => line.startsWith("gpuproc=")), [
      // 第 5 段（已运行秒数）留空；命令行照旧在，MPS 守护进程照样被认出来
      "gpuproc=GPU-8a88|3223871|28|kai|||nvidia-cuda-mps-control -d",
      "gpuproc=GPU-8a88|3223819|4412|kai|||python train.py --epochs 10",
      "gpuproc=GPU-99ad|3223871|28|kai|||nvidia-cuda-mps-control -d",
      "gpuproc=GPU-99ad|3226120|5434|kai|||python -u infer.py",
      "gpuproc=GPU-99ad|99|12||||",
    ]);
    const parsed = parseGpu(section);
    assert.deepEqual(parsed[0].users, [{
      user: "kai", memMb: 4412,
      procs: [{ pid: "3223819", memMb: 4412, etimes: null, jobId: null, comm: "python", cmdline: "python train.py --epochs 10" }],
    }], "取不到时长不算回归：属主与「怎么起的」都还在");
    assert.deepEqual(parsed[1].users.map((u) => u.user), ["kai", "未知"]);
  });

  test(`collect.sh gpu 段（${shell}）：老驱动不认温度 / 功耗字段 → 回退基础查询，两项留空、卡不丢`, { skip: process.platform === "win32" }, () => {
    const section = runGpuSection(shell, "old-driver");
    assert.equal(section.split("\n")[0], "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, , ", "行尾补两个空字段，段数与完整查询一致");
    const gpus = parseGpu(section);
    assert.deepEqual(gpus.map((g) => [g.index, g.util, g.memUsedMb, g.tempC, g.powerW]), [[0, 100, 9806, null, null], [1, 100, 13658, null, null]]);
    assert.deepEqual(gpus[0].users, [{
      user: "kai", memMb: 4412,
      procs: [{ pid: "3223819", memMb: 4412, etimes: 3600, jobId: null, comm: "python", cmdline: "python train.py --epochs 10" }],
    }]);
  });
}

// ---------------------------------------------------------------------------
// v2.62：作业号（gpu 段行尾）与占用现场（proc-top 段）真跑。
// 假 ps / 假 nvidia-smi 放 PATH 里，/proc 与 /sys/fs/cgroup 用 CT_FS_ROOT 指到临时目录里的假文件系统
// （只给测试用的入口：本机的调用从不设置它）。/bin/sh 与 dash（若有）各跑一遍。
// ---------------------------------------------------------------------------

// 假文件系统里的进程：pid → cgroup 文件内容；null = 进程目录在、没有 cgroup 文件；不列 = 进程已退出。
const FS_PROCS = {
  // cgroup v1（本集群实测形状）：只有部分控制器在 slurm 层级里，其余行是 user.slice
  101: "12:pids:/user.slice/user-1003.slice/session-5.scope\n11:freezer:/slurm/uid_1003/job_48213/step_batch\n1:name=systemd:/user.slice/user-1003.slice/session-5.scope\n",
  102: "11:freezer:/slurm/uid_1003/job_48214/step_0/task_0\n4:memory:/slurm/uid_1003/job_48214/step_0\n",
  // cgroup v2
  103: "0::/system.slice/slurmstepd.scope/job_777/step_0/user/task_0\n",
  // 不经 Slurm：登录会话
  201: "12:pids:/user.slice/user-1005.slice/session-9.scope\n0::/user.slice/user-1005.slice/session-9.scope\n",
  // 自己在 user.slice 下面建的同名目录（含带冒号的目录名）：不是从层级根开始，不算作业
  202: "0::/user.slice/user-1005.slice/user@1005.service/slurm/uid_1005/job_999/x\n",
  203: "5:freezer:/user.slice/a:/slurm/uid_1/job_888\n",
  300: "0::/system.slice/cron.service\n",
  301: "0::/user.slice/user-1009.slice/session-2.scope\n",
  400: "0::/user.slice/user-1010.slice/session-3.scope\n",
};
// 28 个 CPU 最高 + 12 个内存最高的边界由这 40 个凑数进程卡出来：cpu 40..1、rss 1000..1039（各不相同，排序无歧义）。
const FS_FILLERS = Array.from({ length: 40 }, (_, i) => ({ pid: 1000 + i, user: "fill", cpu: 40 - i, rss: 1000 + i }));
const FS_PS_ROWS = [
  { pid: 101, user: "kai", cpu: 724, rss: 9000000 },
  { pid: 102, user: "kai", cpu: 725, rss: 9100000 },
  { pid: 103, user: "kai", cpu: 12.5, rss: 500000 }, // CPU 排不进前 28，靠内存进来
  { pid: 201, user: "lin", cpu: 554, rss: 4000000 },
  { pid: 202, user: "lin", cpu: 45, rss: 110 },
  { pid: 203, user: "mallory", cpu: 50, rss: 100 },
  { pid: 300, user: "root", cpu: 1.5, rss: 2048 },
  { pid: 301, user: "bigmem", cpu: 0, rss: 99000000 }, // 不耗 CPU 的内存大户：只按 CPU 取样会漏掉
  { pid: 400, user: "weird$", cpu: 700, rss: 11 }, // 账号名不在白名单里：整行不计
  { pid: 999, user: "ghost", cpu: 600, rss: 10 }, // ps 之后已经退出（没有进程目录）：不计
  ...FS_FILLERS,
];
const psRowsText = (rows) => `${rows.map((r) => `${String(r.pid).padStart(7)} ${r.user.padEnd(8)} ${Number.isInteger(r.cpu) ? r.cpu : r.cpu.toFixed(1)} ${r.rss}`).join("\n")}\n`;

// ps：占用现场那一次调用读 FAKE_PS_ROWS（FAKE_PS_FAIL=1 时失败）；gpu 段那一种给属主与进程名；其余交回系统的 ps。
const FS_FAKE_PS = `#!/bin/sh
case "$*" in
  *pcpu=*)
    [ "$FAKE_PS_FAIL" = 1 ] && { echo "ps: unknown option" >&2; exit 1; }
    cat "$FAKE_PS_ROWS" ;;
  *user:32=,etimes=,args=*)
    for last; do :; done
    case "$last" in
      101) printf 'kai       3600 python train.py\\n' ;;
      102) printf 'kai       60 torchrun --nproc_per_node=2 train.py\\n' ;;
      201) printf 'lin      300 a|b\\n' ;;
      *) exit 1 ;;
    esac ;;
  *user:32=,args=*)
    for last; do :; done
    case "$last" in
      101) printf 'kai       python train.py\\n' ;;
      102) printf 'kai       torchrun --nproc_per_node=2 train.py\\n' ;;
      201) printf 'lin      a|b\\n' ;;
      *) exit 1 ;;
    esac ;;
  *) exec /bin/ps "$@" ;;
esac
`;
const FS_FAKE_NVIDIA_SMI = `#!/bin/sh
case "$*" in
  *query-gpu=*) printf '0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71\\n' ;;
  *query-compute-apps*) printf 'GPU-8a88, 101, 4412\\nGPU-8a88, 102, 5358\\nGPU-8a88, 201, 800\\nGPU-8a88, 999, 12\\n' ;;
esac
`;
// timeout：记下被包住的命令；FAKE_PS_HANG=1 时把 ps 当成超时（真 timeout 杀掉它时退出码就是 124）。
const FS_FAKE_TIMEOUT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TIMEOUT_LOG"
shift
if [ "$FAKE_PS_HANG" = 1 ] && [ "$1" = ps ]; then exit 124; fi
exec "$@"
`;

// 起一轮 slow 采集。scenario：{ slurmDir（建不建 Slurm 的 cgroup 层级目录）, rows, procs, env, withTimeout }。
// 假命令写完先各执行一次：macOS 对新写出的可执行文件第一次执行要做安全评估（机器忙时能卡上几十秒），放在计时之外；
// 这一趟慢得不正常就重跑，最多三趟——脚本只读，同样的输入重跑结果相同，断言不变。
function runWithFakeFs(shell, { slurmDir = "freezer/slurm", rows = FS_PS_ROWS, procs = FS_PROCS, env = {}, withTimeout = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-fakefs-"));
  try {
    const bin = path.join(dir, "bin");
    const root = path.join(dir, "root");
    mkdirSync(bin);
    for (const [pid, cgroup] of Object.entries(procs)) {
      mkdirSync(path.join(root, "proc", pid), { recursive: true });
      if (cgroup != null) writeFileSync(path.join(root, "proc", pid, "cgroup"), cgroup);
    }
    for (const filler of FS_FILLERS) mkdirSync(path.join(root, "proc", String(filler.pid)), { recursive: true });
    if (slurmDir) mkdirSync(path.join(root, "sys/fs/cgroup", slurmDir), { recursive: true });
    writeFileSync(path.join(dir, "ps-rows"), psRowsText(rows));
    const fakes = [["nvidia-smi", FS_FAKE_NVIDIA_SMI], ["ps", FS_FAKE_PS], ...(withTimeout ? [["timeout", FS_FAKE_TIMEOUT]] : [])];
    for (const [name, body] of fakes) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
    const timeoutLog = path.join(dir, "timeout.log");
    const fullEnv = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CT_PROFILE: "slow", CT_PORTS: "", CT_FS_ROOT: root,
      FAKE_PS_ROWS: path.join(dir, "ps-rows"), FAKE_TIMEOUT_LOG: timeoutLog, ...env,
    };
    for (const [name] of fakes) spawnSync(path.join(bin, name), name === "timeout" ? ["1", "true"] : ["--version"], { env: fullEnv, timeout: 60000 });
    rmSync(timeoutLog, { force: true });
    const once = () => {
      const startedAt = Date.now();
      const res = spawnSync(shell, [COLLECTOR_SCRIPT_PATH], { encoding: "utf8", timeout: 30000, env: fullEnv });
      return { res, ms: Date.now() - startedAt };
    };
    let attempt = once();
    for (let i = 0; i < 2 && attempt.ms > 4000; i += 1) attempt = once();
    assert.equal(attempt.res.status, 0, attempt.res.stderr);
    const { sections } = parseCollectorOutput(attempt.res.stdout);
    assert.deepEqual(Object.keys(sections), PROFILE_SECTIONS.slow, "slow 各段必须齐全且按序");
    let wrapped = [];
    try { wrapped = readFileSync(timeoutLog, "utf8").trim().split("\n"); } catch {}
    return { sections, ms: attempt.ms, wrapped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 缺省场景（FS_PS_ROWS + FS_PROCS）每种 shell 只跑一趟，gpu 段与 proc-top 段的两条用例共用。
const defaultRuns = new Map();
function defaultRun(shell) {
  if (!defaultRuns.has(shell)) defaultRuns.set(shell, runWithFakeFs(shell));
  return defaultRuns.get(shell);
}

for (const shell of GPU_SHELLS) {
  test(`collect.sh（${shell}）：gpu 段带 Slurm 作业号与逐进程明细——作业内有号、作业外留空，命令行含 | 也不错位`, { skip: process.platform === "win32" }, () => {
    const { sections } = defaultRun(shell);
    assert.deepEqual(sections.gpu.split("\n"), [
      "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71",
      "gpuproc=GPU-8a88|101|4412|kai|3600|48213|python train.py",
      "gpuproc=GPU-8a88|102|5358|kai|60|48214|torchrun --nproc_per_node=2 train.py",
      "gpuproc=GPU-8a88|201|800|lin|300||a|b", // 命令行里有 |：前 6 段不含它，第 7 段整段算命令行
      "gpuproc=GPU-8a88|999|12||||", // 进程已退出：ps 取不到 → 属性与命令行留空
    ]);
    assert.deepEqual(parseGpu(sections.gpu, { selfUser: "kai" })[0].users, [
      {
        user: "kai",
        memMb: 9770,
        jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }],
        procs: [
          { pid: "102", memMb: 5358, etimes: 60, jobId: "48214", comm: "torchrun", cmdline: "torchrun --nproc_per_node=2 train.py" },
          { pid: "101", memMb: 4412, etimes: 3600, jobId: "48213", comm: "python", cmdline: "python train.py" },
        ],
      },
      { user: "lin", memMb: 800, procs: [{ pid: "201", memMb: 800, etimes: 300, jobId: null, comm: "a|b", cmdline: "a|b" }] },
      { user: "未知", memMb: 12, procs: [{ pid: "999", memMb: 12, etimes: null, jobId: null, comm: "", cmdline: "" }] },
    ]);
  });

  test(`collect.sh（${shell}）：proc-top 段——CPU 前 28 + 内存前 12 去重后按账号汇总，cgroup 分作业内外；只有账号名与数字`, { skip: process.platform === "win32" }, () => {
    const { sections, ms } = defaultRun(shell);
    assert.deepEqual(sections["proc-top"].split("\n"), [
      // 取到 37 个：CPU 前 28（102 101 400 999 201 203 202 + 凑数的 21 个）∪ 内存前 12（多出 301 103 300 + 凑数的 6 个）；
      // 999 已退出、400 的账号名不合法，都不计 → 35
      "sampled=35",
      "slurm=1",
      // 账号：CPU 合计最高的 4 个，再加其余里内存合计最高的 2 个
      "top=kai|1461.5|0.0|18600000|0|3|0", // 三个进程都在作业里（v1 两种写法 + v2）
      "top=fill|0.0|651.0|0|27429|0|27",
      "top=lin|0.0|599.0|0|4000110|0|2", // 登录会话 + 自己伪造的 slurm 路径：都算作业外
      "top=mallory|0.0|50.0|0|100|0|1", // 目录名带冒号的伪造路径：作业外
      "top=bigmem|0.0|0.0|0|99000000|0|1",
      "top=root|0.0|1.5|0|2048|0|1",
    ]);
    assert.ok(Buffer.byteLength(sections["proc-top"]) <= 1024, "整段不超过 1 KB");
    assert.doesNotMatch(sections["proc-top"], /python|session|scope|uid_|job_/, "不带进程名、命令行与 cgroup 路径");
    assert.deepEqual(parseProcTop(sections["proc-top"]).users[0], { user: "kai", cpuJobPct: 1461.5, cpuOtherPct: 0, rssJobKb: 18600000, rssOtherKb: 0, procsJob: 3, procsOther: 0 });
    assert.ok(ms < COLLECTOR_TIMEOUT_MS.slow, `整轮 slow 采集 ${ms}ms，应远小于本机给的 ${COLLECTOR_TIMEOUT_MS.slow}ms 时限`);
  });

  test(`collect.sh（${shell}）：proc-top 段——这台机器没有 Slurm 的 cgroup 层级 → slurm=0，数字全在作业外几栏`, { skip: process.platform === "win32" }, () => {
    const procs = { 201: FS_PROCS[201], 300: FS_PROCS[300], 301: null };
    const rows = FS_PS_ROWS.filter((r) => [201, 300, 301].includes(r.pid));
    const { sections } = runWithFakeFs(shell, { slurmDir: null, rows, procs });
    assert.deepEqual(sections["proc-top"].split("\n"), [
      "sampled=3",
      "slurm=0",
      "top=lin|0.0|554.0|0|4000000|0|1",
      "top=root|0.0|1.5|0|2048|0|1",
      "top=bigmem|0.0|0.0|0|99000000|0|1", // 进程目录在、没有 cgroup 文件：照样计入（作业外）
    ]);
    assert.equal(parseProcTop(sections["proc-top"]).slurm, false);
  });

  test(`collect.sh（${shell}）：proc-top 段——cgroup v2 的层级目录也认；ps 失败 → 空段，其余段照常`, { skip: process.platform === "win32" }, () => {
    const v2 = runWithFakeFs(shell, { slurmDir: "system.slice/slurmstepd.scope", rows: FS_PS_ROWS.filter((r) => r.pid === 103), procs: { 103: FS_PROCS[103] } });
    assert.deepEqual(v2.sections["proc-top"].split("\n"), ["sampled=1", "slurm=1", "top=kai|12.5|0.0|500000|0|1|0"]);
    const failed = runWithFakeFs(shell, { env: { FAKE_PS_FAIL: "1" } });
    assert.equal(failed.sections["proc-top"], "");
    assert.equal(parseProcTop(failed.sections["proc-top"]), null);
    assert.match(failed.sections.gpu, /^gpuproc=GPU-8a88\|101\|4412\|kai\|3600\|48213\|python train\.py$/m, "gpu 段不受影响");
    assert.ok(failed.sections.sys.length > 0);
  });

  test(`collect.sh（${shell}）：proc-top 段——有 timeout 时 ps 包在 3 秒时限里；超时 → 空段，不拖住后面的 slurm 段`, { skip: process.platform === "win32" }, () => {
    const ok = runWithFakeFs(shell, { withTimeout: true });
    assert.ok(ok.wrapped.includes("3 ps -eo pid=,user:32=,pcpu=,rss="), `ps 应经 timeout 3 执行，实际：${ok.wrapped.join(" / ")}`);
    assert.match(ok.sections["proc-top"], /^top=kai\|1461\.5\|/m);
    const hung = runWithFakeFs(shell, { withTimeout: true, env: { FAKE_PS_HANG: "1" } });
    assert.equal(hung.sections["proc-top"], "");
    assert.ok("slurm" in hung.sections, "后面的段照常输出");
  });
}
