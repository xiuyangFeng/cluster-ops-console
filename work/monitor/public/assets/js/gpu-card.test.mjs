// gpu-card.test.mjs —— GPU 逐卡详情（L1/L2，v2.76）的纯函数回归：
//   1) render/gpu-card-view.js：提交方式分类、时长格式化、进程拍平、浮层正文（含转义与空状态）；
//   2) render/resources-view.js：GPU 行带上「哪张卡」的数据属性 + 卡号是按钮（浮层的入口）。
// 数据形状取自 lib/gpu-cards.mjs 的卡（users[].procs[]）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGpuCardBodyHtml, classifyGpuProc, formatProcElapsed, gpuCardHeading, gpuCardJobSummary, gpuCardProcs,
} from "./render/gpu-card-view.js";
import { buildGpuTableHtml } from "./render/resources-view.js";

const card = (over = {}) => ({
  index: 0,
  name: "NVIDIA GeForce RTX 4090",
  util: 100,
  memUsedMb: 9806,
  memTotalMb: 24564,
  tempC: 57,
  powerW: 210.71,
  users: [],
  ...over,
});
const proc = (over = {}) => ({
  pid: "3223819", memMb: 4412, etimes: 3600, jobId: null, comm: "python", cmdline: "python train.py",
  ...over,
});

test("classifyGpuProc: 有作业号就是 Slurm（不看命令行）；否则按命令行认工具，认不出退回进程名", () => {
  assert.equal(classifyGpuProc(proc({ jobId: "48213" })).kind, "slurm");
  assert.equal(classifyGpuProc(proc({ jobId: "48213", cmdline: "jupyter-lab" })).kind, "slurm", "作业号优先：作业里的 notebook 也是作业");
  assert.equal(classifyGpuProc(proc({ cmdline: "/usr/bin/python -m ipykernel_launcher -f k.json" })).kind, "jupyter");
  assert.equal(classifyGpuProc(proc({ cmdline: "jupyter-lab --no-browser" })).kind, "jupyter");
  assert.equal(classifyGpuProc(proc({ cmdline: "/home/u/.vscode-server/bin/x/python a.py" })).kind, "vscode");
  assert.equal(classifyGpuProc(proc({ cmdline: "torchrun --nproc_per_node=4 train.py" })).kind, "launcher");
  assert.equal(classifyGpuProc(proc({ cmdline: "/home/u/miniconda3/envs/llm/bin/python train.py" })).kind, "conda");
  assert.equal(classifyGpuProc(proc({ cmdline: "/usr/bin/python3.11 -u infer.py" })).kind, "python");
  // 认不出的：用进程名（comm 取命令行第一个词的 basename）；命令行也没有就说清是 ps 没取到
  assert.deepEqual(classifyGpuProc(proc({ cmdline: "/opt/foo/trainer --x", comm: "trainer" })), { kind: "other", label: "trainer", hint: "没认出提交方式，看命令行" });
  assert.equal(classifyGpuProc(proc({ cmdline: "", comm: "" })).label, "未知进程");
  assert.equal(classifyGpuProc(proc({ cmdline: "", comm: "" })).hint.includes("ps 没取到"), true);
  assert.equal(classifyGpuProc(null).kind, "other");
});

test("formatProcElapsed: 秒 / 分钟 / 小时 / 天；取不到给空串（列留空，不写 0）", () => {
  assert.equal(formatProcElapsed(45), "45 秒");
  assert.equal(formatProcElapsed(59), "59 秒");
  assert.equal(formatProcElapsed(60), "1 分钟");
  assert.equal(formatProcElapsed(3599), "59 分钟");
  assert.equal(formatProcElapsed(3600), "1 小时");
  assert.equal(formatProcElapsed(3660), "1 小时 1 分");
  assert.equal(formatProcElapsed(86400 + 7200), "1 天 2 小时");
  assert.equal(formatProcElapsed(172800), "2 天");
  assert.equal(formatProcElapsed(null), "");
  assert.equal(formatProcElapsed(undefined), "");
});

test("gpuCardProcs: 拍平属主与进程、显存降序；老采集（没有 procs）返回空数组", () => {
  const procs = gpuCardProcs(card({
    users: [
      { user: "kai", memMb: 1000, procs: [proc({ pid: "2", memMb: 900 }), proc({ pid: "3", memMb: 5358 })] },
      { user: "lin", memMb: 3000, procs: [proc({ pid: "4", memMb: 3000, cmdline: "jupyter-lab" })] },
    ],
  }));
  assert.deepEqual(procs.map((p) => [p.user, p.pid, p.memMb]), [["kai", "3", 5358], ["lin", "4", 3000], ["kai", "2", 900]]);
  assert.deepEqual(gpuCardProcs(card({ users: [{ user: "kai", memMb: 100 }] })), [], "v2.75 及更早的卡没有 procs");
  assert.deepEqual(gpuCardProcs(null), []);
});

test("gpuCardJobSummary: 说得清几个在作业里、几个不在（这一屏最要紧的结论）", () => {
  assert.equal(gpuCardJobSummary([]), "");
  assert.match(gpuCardJobSummary([{ jobId: "1" }, { jobId: "2" }]), /2 个计算进程，都在 Slurm 作业里/);
  const all = gpuCardJobSummary([{ jobId: "" }, { jobId: "" }]);
  assert.match(all, /都不在 Slurm 作业里/);
  assert.match(all, /squeue 里看不到/);
  assert.equal(gpuCardJobSummary([{ jobId: "1" }, { jobId: "" }]), "2 个计算进程：1 个在 Slurm 作业里，1 个不在（在节点上直接运行）");
});

test("gpuCardHeading: 卡号 + 型号；型号缺了只写卡号", () => {
  assert.equal(gpuCardHeading(card()), "GPU #0 · NVIDIA GeForce RTX 4090");
  assert.equal(gpuCardHeading({ index: 3 }), "GPU #3");
  assert.equal(gpuCardHeading({}), "GPU #?");
});

test("buildGpuCardBodyHtml: 读数 + 结论 + 进程表；命令行里的尖括号一律转义", () => {
  const html = buildGpuCardBodyHtml(card({
    users: [{
      user: "kai",
      memMb: 4412,
      procs: [proc({ cmdline: "python -c \"import os; os.system('<script>alert(1)</script>')\"" })],
    }],
  }), { label: "master", sampledAt: Date.parse("2026-10-19T18:00:00+08:00") });

  assert.ok(!html.includes("<script>"), "命令行是别人的自由文本：必须转义");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<dt>节点<\/dt><dd>master<\/dd>/);
  assert.match(html, /<dt>利用率<\/dt><dd>100%<\/dd>/);
  assert.match(html, /<dt>显存<\/dt><dd>9\.6 \/ 24\.0 GB<\/dd>/);
  assert.match(html, /占用进程（1）/);
  assert.match(html, /gpu-proc-kind" data-kind="python"/);
  assert.match(html, /不在 Slurm 作业里/);
  assert.match(html, /pid 3223819/);
  assert.match(html, /1 小时/);
  assert.match(html, /每 60 秒|每分钟一次/, "口径说明要在");
  // 采样时刻固定 24 小时制（zh-CN + hour12:false）：两位小时 + 无 AM/PM，与本机时区无关
  assert.match(html, /采样于 \d{2}:\d{2}:\d{2}/);
  assert.ok(!/AM|PM/.test(html));
});

test("buildGpuCardBodyHtml: 没有进程 → 空状态；没有进程明细（老脚本）→ 也说清是空的", () => {
  const empty = buildGpuCardBodyHtml(card(), { label: "master" });
  assert.match(empty, /这块卡上没有计算进程/);
  assert.ok(!empty.includes("<table"), "没有进程就不出表");
  const legacy = buildGpuCardBodyHtml(card({ users: [{ user: "kai", memMb: 4412 }] }), { label: "node04" });
  assert.match(legacy, /这块卡上没有计算进程/, "v2.75 的形状只有属主、没有逐进程明细");
});

test("buildGpuCardBodyHtml: 读数缺项不写 0，也不留空壳（未知就是未知）", () => {
  const html = buildGpuCardBodyHtml({ index: 1, users: [] }, { label: "node04" });
  assert.match(html, /<dt>利用率<\/dt><dd>未知<\/dd>/);
  assert.match(html, /<dt>显存<\/dt><dd>未知<\/dd>/);
  assert.ok(!/<dt>温度<\/dt>/.test(html), "没有温度就不出这一格");
});

test("buildGpuTableHtml: 每行带「哪张卡」的数据属性，卡号是能点的按钮（浮层的入口）", () => {
  const html = buildGpuTableHtml([{
    key: "node04",
    label: "node04",
    direct: true,
    summary: { model: "NVIDIA A100-PCIE-40GB" },
    cards: [{ index: 2, util: 88, memUsedMb: 30000, memTotalMb: 40960, memText: "29.3 / 40 GB", memPct: 73, memLevel: "warn", envText: "61°C · 245W", ownerText: "kai 29.3 GB", title: "GPU #2" }],
  }]);
  assert.match(html, /<tr class="res-gpu-row"[^>]*data-gpu-key="node04"[^>]*data-gpu-index="2"[^>]*data-gpu-label="node04"/);
  assert.match(html, /<button type="button" class="res-gpu-index" data-gpu-open aria-label="node04 GPU #2：点击查看这块卡上的进程[^"]*">2<\/button>/);
  assert.match(html, /点击查看这块卡上的进程/, "整行提示里也要说清能点");
});

test("buildGpuTableHtml: 本机组的 key 是空串（浮层据此回 layer.gpu 取卡），属性照样在", () => {
  const html = buildGpuTableHtml([{
    key: "",
    label: "master",
    direct: false,
    summary: { model: "NVIDIA GeForce RTX 4090" },
    cards: [{ index: 0, util: 1, memUsedMb: 10, memTotalMb: 24564, memText: "0.0 / 24 GB", memPct: 1, memLevel: "ok", envText: "", ownerText: "空闲", title: "GPU #0" }],
  }]);
  assert.match(html, /data-gpu-key="" data-gpu-index="0" data-gpu-label="master"/);
});
