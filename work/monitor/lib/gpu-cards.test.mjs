import assert from "node:assert/strict";
import test from "node:test";

import {
  attachGpuUsers, GPU_MAX_JOBS_PER_CARD, GPU_MAX_PROCS_PER_CARD, GPU_MAX_USERS_PER_CARD,
  gpuCommFromCmdline, parseGpuAppLine, parseGpuCardLine, parseGpuProcLine,
} from "./gpu-cards.mjs";

test("parseGpuCardLine: 集群实测行（RTX 4090，含温度与功耗）", () => {
  assert.deepEqual(parseGpuCardLine("0, GPU-8a88aaaa-0000-1111-2222-333344445555, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71"), {
    index: 0, uuid: "GPU-8a88aaaa-0000-1111-2222-333344445555", name: "NVIDIA GeForce RTX 4090",
    util: 100, memUsedMb: 9806, memTotalMb: 24564, tempC: 57, powerW: 210.7, users: [],
  });
});

test("parseGpuCardLine: 温度 / 功耗不支持（[N/A]）或回退查询留空 → null；利用率拿不到也不丢卡", () => {
  const na = parseGpuCardLine("1, GPU-b, Tesla T4, 14, 15360, 0, [N/A], [Not Supported]");
  assert.deepEqual([na.tempC, na.powerW, na.util], [null, null, 0]);
  const padded = parseGpuCardLine("2, GPU-c, NVIDIA A100-PCIE-40GB, 14, 40960, 0, , ");
  assert.deepEqual([padded.name, padded.memTotalMb, padded.tempC, padded.powerW], ["NVIDIA A100-PCIE-40GB", 40960, null, null]);
  const noUtil = parseGpuCardLine("3, GPU-d, NVIDIA A100, 14, 40960, [N/A], 40, 55.5");
  assert.deepEqual([noUtil.util, noUtil.tempC, noUtil.powerW], [null, 40, 55.5]);
});

test("parseGpuCardLine: 6 段旧格式照旧能读；名称含逗号时中间拼回", () => {
  const legacy = parseGpuCardLine("0, GPU-uuid, NVIDIA A100-PCIE-40GB, 14, 40960, 0");
  assert.deepEqual([legacy.name, legacy.memUsedMb, legacy.memTotalMb, legacy.util, legacy.tempC, legacy.powerW], ["NVIDIA A100-PCIE-40GB", 14, 40960, 0, null, null]);
  const comma = parseGpuCardLine("4, GPU-e, Vendor, Model X, 100, 8192, 12, 45, 60");
  assert.deepEqual([comma.name, comma.memUsedMb, comma.util, comma.tempC, comma.powerW], ["Vendor, Model X", 100, 12, 45, 60]);
});

test("parseGpuCardLine: 坏行返回 null", () => {
  for (const line of ["", "nvidia-smi: command not found", "x, GPU-a, N, 1, 2, 3, 4, 5", "0, GPU-a, , 1, 2, 3, 4, 5", "0, a, b", null, undefined]) {
    assert.equal(parseGpuCardLine(line), null, String(line));
  }
});

test("parseGpuAppLine: 属主只收安全字符，其余记「未知」；进程名可缺", () => {
  assert.deepEqual(parseGpuAppLine("GPU-a|kai|4412|python"), { uuid: "GPU-a", user: "kai", memMb: 4412, comm: "python", jobId: null });
  assert.deepEqual(parseGpuAppLine("GPU-a|kai|4412"), { uuid: "GPU-a", user: "kai", memMb: 4412, comm: "", jobId: null });
  assert.equal(parseGpuAppLine("GPU-a||28|x").user, "未知");
  assert.equal(parseGpuAppLine("GPU-a|<script>|28|x").user, "未知");
  assert.equal(parseGpuAppLine("GPU-a|kai|[N/A]|python").memMb, null);
  assert.equal(parseGpuAppLine("|kai|1|python"), null);
  assert.equal(parseGpuAppLine(""), null);
});

test("attachGpuUsers: 按 uuid 归卡、同一属主显存相加、MPS 守护进程不算、按显存排序", () => {
  const cards = [parseGpuCardLine("0, GPU-a, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71"), parseGpuCardLine("1, GPU-b, NVIDIA GeForce RTX 4090, 13658, 24564, 100, 56, 232.62")];
  const apps = [
    "GPU-a|kai|28|nvidia-cuda-mps", "GPU-a|kai|4412|python", "GPU-a|kai|5358|python",
    "GPU-b|kai|28|nvidia-cuda-mps", "GPU-b|kai|5434|python", "GPU-b|zhang|6570|python", "GPU-b|kai|1618|python",
    "GPU-zz|ghost|1|python", // 不在卡表里的 uuid：丢弃
  ].map(parseGpuAppLine);
  attachGpuUsers(cards, apps);
  assert.deepEqual(cards[0].users, [{ user: "kai", memMb: 9770 }]);
  assert.deepEqual(cards[1].users, [{ user: "kai", memMb: 7052 }, { user: "zhang", memMb: 6570 }]);
});

// v2.62：行尾追加 Slurm 作业号（取自进程的 cgroup，不在作业里时为空）。
test("parseGpuAppLine: 行尾的作业号只认纯数字；不在作业里（空）与 v2.61 的四段格式都是 null", () => {
  assert.deepEqual(parseGpuAppLine("GPU-a|kai|4412|python|48213"), { uuid: "GPU-a", user: "kai", memMb: 4412, comm: "python", jobId: "48213" });
  assert.equal(parseGpuAppLine("GPU-a|kai|4412|python|").jobId, null, "不在作业里：字段在、值为空");
  assert.equal(parseGpuAppLine("GPU-a|kai|4412|python").jobId, null, "旧格式没有这个字段");
  assert.equal(parseGpuAppLine("GPU-a||12||").jobId, null, "ps 与 cgroup 都没取到");
  for (const bad of ["48213_7", "abc", "-1", "4 8", "1234567890123", "48213;id"]) {
    assert.equal(parseGpuAppLine(`GPU-a|kai|1|python|${bad}`).jobId, null, bad);
  }
});

test("parseGpuAppLine: 进程名里有 | 时作业号仍取最后一段，不会把进程名的后半截当成作业号", () => {
  const inJob = parseGpuAppLine("GPU-a|kai|4412|a|b|48213");
  assert.deepEqual([inJob.user, inJob.memMb, inJob.comm, inJob.jobId], ["kai", 4412, "a", "48213"]);
  assert.equal(parseGpuAppLine("GPU-a|kai|4412|a|999|").jobId, null, "进程名叫 a|999、不在作业里：末段为空 → 没有作业号");
});

test("attachGpuUsers: selfUser 自己的进程另按作业合并显存（按显存排序），别人的仍只到属主，作业外的进程不进 jobs", () => {
  const cards = [parseGpuCardLine("0, GPU-a, NVIDIA GeForce RTX 4090, 15000, 24564, 100, 57, 210.71"), parseGpuCardLine("1, GPU-b, NVIDIA GeForce RTX 4090, 6000, 24564, 90, 56, 200")];
  const apps = [
    "GPU-a|kai|28|nvidia-cuda-mps|", // MPS 守护进程：不算占用者，也不进作业
    "GPU-a|kai|4412|python|48213", "GPU-a|kai|100|python|48213", "GPU-a|kai|5358|python|48214",
    "GPU-a|kai|900|python|", // kai 不经 Slurm 直接跑的进程：只计入合计
    "GPU-a|lin|3000|python|48300", // 别人的作业号不保留
    "GPU-b|lin|6000|python|",
  ].map(parseGpuAppLine);
  attachGpuUsers(cards, apps, { selfUser: "kai" });
  assert.deepEqual(cards[0].users, [
    { user: "kai", memMb: 10770, jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4512 }] },
    { user: "lin", memMb: 3000 },
  ]);
  assert.deepEqual(cards[1].users, [{ user: "lin", memMb: 6000 }], "这张卡上没有自己的进程：形状与以前一样");
});

test("attachGpuUsers: 没给 selfUser / 不是合法账号名 / 自己的进程都不在作业里 → 与 v2.61 的形状完全一样", () => {
  const lines = ["GPU-a|kai|4412|python|48213", "GPU-a|kai|900|python|", "GPU-a||40||48213"];
  const run = (options) => {
    const cards = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
    attachGpuUsers(cards, lines.map(parseGpuAppLine), options);
    return cards[0].users;
  };
  const plain = [{ user: "kai", memMb: 5312 }, { user: "未知", memMb: 40 }];
  assert.deepEqual(run(undefined), plain);
  assert.deepEqual(run({ selfUser: null }), plain);
  assert.deepEqual(run({ selfUser: "" }), plain);
  assert.deepEqual(run({ selfUser: "未知" }), plain, "属主认不出时记的「未知」不能被当成采集账号");
  assert.deepEqual(run({ selfUser: "someone-else" }), plain);
  const cards = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
  attachGpuUsers(cards, ["GPU-a|kai|4412|python|", "GPU-a|kai|900|python"].map(parseGpuAppLine), { selfUser: "kai" });
  assert.deepEqual(cards[0].users, [{ user: "kai", memMb: 5312 }], "没有一个进程带作业号：不挂空的 jobs");
});

test("attachGpuUsers: 每张卡的作业数有上限（兜底，正常远小于它）", () => {
  const cards = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
  const many = Array.from({ length: GPU_MAX_JOBS_PER_CARD + 5 }, (_, i) => parseGpuAppLine(`GPU-a|kai|${i + 1}|python|${1000 + i}`));
  attachGpuUsers(cards, many, { selfUser: "kai" });
  assert.equal(cards[0].users[0].jobs.length, GPU_MAX_JOBS_PER_CARD);
});

test("attachGpuUsers: 每张卡的占用者有上限；空输入不抛", () => {
  const cards = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
  const many = Array.from({ length: GPU_MAX_USERS_PER_CARD + 5 }, (_, i) => parseGpuAppLine(`GPU-a|u${i}|${i}|python`));
  attachGpuUsers(cards, [null, ...many]);
  assert.equal(cards[0].users.length, GPU_MAX_USERS_PER_CARD);
  assert.deepEqual(attachGpuUsers([], []), []);
});

// ---------------------------------------------------------------------------
// v2.76（L2）：gpuproc 行——逐进程的 pid / 已运行秒数 / 命令行。
// 前 6 段固定且不含 |，命令行是第 7 段起的自由文本；进程名（comm）由命令行第一个词的 basename 推出。
// ---------------------------------------------------------------------------

test("gpuCommFromCmdline: 取命令行第一个词的 basename；路径 / 空命令行 / 超长都兜住", () => {
  assert.equal(gpuCommFromCmdline("python train.py --x 1"), "python");
  assert.equal(gpuCommFromCmdline("/usr/bin/python3.11 -u a.py"), "python3.11");
  assert.equal(gpuCommFromCmdline("  /opt/nvidia/bin/nvidia-cuda-mps-control -d "), "nvidia-cuda-mps-control");
  assert.equal(gpuCommFromCmdline(""), "");
  assert.equal(gpuCommFromCmdline(null), "");
  assert.equal(gpuCommFromCmdline("x".repeat(80)).length, 32);
});

test("parseGpuProcLine: 常规行、命令行带 | 、ps 没取到、坏行", () => {
  assert.deepEqual(parseGpuProcLine("GPU-a|3223819|4412|kai|3600|48213|python train.py --epochs 10"), {
    uuid: "GPU-a", pid: "3223819", memMb: 4412, user: "kai", etimes: 3600,
    jobId: "48213", comm: "python", cmdline: "python train.py --epochs 10",
  });
  // 命令行里的 | 原样拼回（前 6 段不含 |，分隔符不会错位）
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|60||a|b|c").cmdline, "a|b|c");
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|60||a|b|c").jobId, null, "第 6 段是空的作业号");
  // 不在作业里：字段在、值为空
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|60||python x.py").jobId, null);
  // ps 没取到（进程刚退出）：属主 / 秒数 / 命令行都空，行仍然有效
  assert.deepEqual(parseGpuProcLine("GPU-a|99|12||||"), {
    uuid: "GPU-a", pid: "99", memMb: 12, user: "未知", etimes: null, jobId: null, comm: "", cmdline: "",
  });
  // etimes 非数字（老 ps 不认识这个字段时可能带单位）→ null，不影响这一行
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|3d||python x.py").etimes, null, "不是纯数字 → 未知，不拿 parseFloat 猜");
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|-5||python x.py").etimes, null);
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|1234567890123||python x.py").etimes, null, "超长 → 未知");
  // 进程名里的 | 与空格由命令行带过来：属主非法记「未知」，非法 pid / 空 uuid / 段数不足 → 丢弃
  assert.equal(parseGpuProcLine("GPU-a|1|10|<script>|1||python").user, "未知");
  assert.equal(parseGpuProcLine("GPU-a|bad;pid|10|kai|1||python"), null);
  assert.equal(parseGpuProcLine("GPU-a|1234567890123|10|kai|1||python"), null, "pid 超长");
  assert.equal(parseGpuProcLine("|1|10|kai|1||python"), null);
  // 被段上限截断的行可能只剩 6 段：命令行按空处理，前 6 段的读数照样保留
  assert.deepEqual(parseGpuProcLine("GPU-a|1|10|kai|1|"), { uuid: "GPU-a", pid: "1", memMb: 10, user: "kai", etimes: 1, jobId: null, comm: "", cmdline: "" });
  assert.equal(parseGpuProcLine("GPU-a|1|10|kai|1"), null, "只有 5 段：作业号字段都没有，整行丢弃");
  assert.equal(parseGpuProcLine(""), null);
  assert.equal(parseGpuProcLine(null), null);
});

test("parseGpuProcLine: 显存拿不到（[N/A]）记 null；命令行超长截断", () => {
  assert.equal(parseGpuProcLine("GPU-a|1|[N/A]|kai|1||python").memMb, null);
  assert.equal(parseGpuProcLine(`GPU-a|1|10|kai|1||${"x".repeat(1000)}`).cmdline.length, 400);
});

test("attachGpuUsers: gpuproc 的逐进程明细挂到属主那一项（按显存降序），MPS 守护进程按命令行 basename 剔除", () => {
  const cards = [parseGpuCardLine("0, GPU-a, NVIDIA GeForce RTX 4090, 20000, 24564, 100, 57, 210.71")];
  const apps = [
    "GPU-a|1|28|kai|9000||nvidia-cuda-mps-control -d", // MPS 守护进程：不算占用者
    "GPU-a|2|4412|kai|3600|48213|python train.py",
    "GPU-a|3|5358|kai|60|48214|torchrun --nproc_per_node=2 train.py",
    "GPU-a|4|900|kai|120||python -u infer.py", // 不经 Slurm 直接跑的：正是要看见的那类
    "GPU-a|5|3000|lin|7200||jupyter-lab",
  ].map(parseGpuProcLine);
  attachGpuUsers(cards, apps, { selfUser: "kai" });
  assert.deepEqual(cards[0].users, [
    {
      user: "kai", memMb: 10670,
      procs: [
        { pid: "3", memMb: 5358, etimes: 60, jobId: "48214", comm: "torchrun", cmdline: "torchrun --nproc_per_node=2 train.py" },
        { pid: "2", memMb: 4412, etimes: 3600, jobId: "48213", comm: "python", cmdline: "python train.py" },
        { pid: "4", memMb: 900, etimes: 120, jobId: null, comm: "python", cmdline: "python -u infer.py" },
      ],
      jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }],
    },
    {
      user: "lin", memMb: 3000,
      procs: [{ pid: "5", memMb: 3000, etimes: 7200, jobId: null, comm: "jupyter-lab", cmdline: "jupyter-lab" }],
    },
  ]);
});

test("attachGpuUsers: 每张卡的进程条数有上限；gpuapp 旧行（没有 pid）不产生 procs", () => {
  const cards = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
  const many = Array.from({ length: GPU_MAX_PROCS_PER_CARD + 5 }, (_, i) => parseGpuProcLine(`GPU-a|${1000 + i}|${i + 1}|u${i % 3}|60||python p.py`));
  attachGpuUsers(cards, many);
  const total = cards[0].users.reduce((sum, u) => sum + (u.procs?.length || 0), 0);
  assert.equal(total, GPU_MAX_PROCS_PER_CARD);

  const legacy = [parseGpuCardLine("0, GPU-a, N, 1, 2, 3, 4, 5")];
  attachGpuUsers(legacy, [parseGpuAppLine("GPU-a|kai|4412|python|48213")], { selfUser: "kai" });
  assert.equal("procs" in legacy[0].users[0], false, "旧格式的形状与 v2.75 逐字一致");
});
