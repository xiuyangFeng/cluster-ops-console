import assert from "node:assert/strict";
import { test } from "node:test";

import { COLLECTION_MAX, COLLECTION_WINDOW_MS, deriveCollectionDirs, jobOutputDir, relativeToHome } from "./collections.mjs";

const NOW = Date.UTC(2026, 9, 12, 6, 0);
const HOUR = 3600_000;
const HOME = "/public/home/kai";
const GNN = `${HOME}/Digital_twin/GNN`;

let seq = 48000;
const reg = (over = {}) => {
  seq += 1;
  return {
    serverId: "s1", jobId: String(seq), arrayJobId: null, arrayTaskId: null, name: "job", user: "kai",
    workDir: GNN, stdout: null, stderr: null, command: null, firstSeenAt: NOW - 2 * HOUR, lastSeenAt: NOW - HOUR, ...over,
  };
};

// 设计稿第 1 节的真实路径形状：流水线作业写 outputs/<批次>/…/logs/mesh_%j.out，训练实验写
// training_wss_min/experiments/<实验>/logs/xp_%j.log，还有工作目录直接是 ~/Digital_twin/GNN 的作业。
function realShapes() {
  const entries = [];
  const batches = ["cfd_auto_ad_repro_20261009", "cfd_auto_ad_repro_20261008", "cfd_auto_bc_sweep_20261007", "cfd_auto_ad_pilot_20261005"];
  for (const batch of batches) {
    for (const unit of ["AD", "BC"]) {
      for (let c = 1; c <= 4; c += 1) {
        const dir = `${GNN}/outputs/${batch}/units/${unit}/case_${String(c).padStart(4, "0")}/logs`;
        for (const step of ["setup", "mesh", "smoke", "finalize"]) entries.push(reg({ name: `cfdauto_${step}`, stdout: `${dir}/${step}_%j.out`, stderr: `${dir}/${step}_%j.err` }));
      }
    }
  }
  for (const xp of ["xp_lr3e4_h256", "xp_lr1e4_h256", "xp_lr3e4_h512", "xp_wss_min_base", "xp_wss_min_aug"]) {
    entries.push(reg({ name: xp, workDir: `${GNN}/training_wss_min`, stdout: `${GNN}/training_wss_min/experiments/${xp}/logs/xp_%j.log` }));
    entries.push(reg({ name: xp, workDir: `${GNN}/training_wss_min`, stdout: `experiments/${xp}/logs/xp_%j.log` }));
  }
  // 工作目录直接是 ~/Digital_twin/GNN：没写 -o（默认 slurm-%j.out 落在工作目录），或写了相对文件名。
  for (let i = 0; i < 6; i += 1) entries.push(reg({ name: "cfa-ad-cfd1" }));
  for (let i = 0; i < 3; i += 1) entries.push(reg({ name: "cfa-bc-cfd1", stdout: "slurm-%j.out" }));
  return entries;
}

test("真实路径形状：得到 outputs 与 experiments 这两层，不是更深的 units/AD，也不是 GNN", () => {
  const found = deriveCollectionDirs(realShapes(), { homes: [HOME], nowMs: NOW });
  assert.deepEqual(found.map((f) => f.root), ["Digital_twin/GNN/outputs", "Digital_twin/GNN/training_wss_min/experiments"]);
  assert.deepEqual(found[0], { root: "Digital_twin/GNN/outputs", jobs: 4 * 2 * 4 * 4, children: 4 });
  assert.deepEqual(found[1], { root: "Digital_twin/GNN/training_wss_min/experiments", jobs: 10, children: 5 });
});

test("同一路径上只取最浅的：批次不足 3 个时 outputs 不算，才轮到更深的那一层", () => {
  const entries = [];
  for (const batch of ["b1", "b2"]) {
    for (const c of ["case_1", "case_2", "case_3"]) entries.push(reg({ stdout: `${GNN}/outputs/${batch}/units/AD/${c}/logs/mesh_%j.out` }));
  }
  assert.deepEqual(
    deriveCollectionDirs(entries, { homes: [HOME], nowMs: NOW }).map((f) => f.root),
    ["Digital_twin/GNN/outputs/b1/units/AD", "Digital_twin/GNN/outputs/b2/units/AD"],
  );
  entries.push(reg({ stdout: `${GNN}/outputs/b3/units/AD/case_1/logs/mesh_%j.out` }));
  assert.deepEqual(deriveCollectionDirs(entries, { homes: [HOME], nowMs: NOW }).map((f) => f.root), ["Digital_twin/GNN/outputs"]);
});

test("外层项目目录含零星 worktree 子目录时：穿过 Digital_twin 下钻到 GNN/outputs 与 experiments，不把外层根目录当集合目录", () => {
  const entries = [
    ...realShapes(),
    // Digital_twin 下多了两个零星 worktree 目录各跑了 2 个测试作业，使 Digital_twin 的直接子目录数达到 3
    reg({ workDir: `${HOME}/Digital_twin/GNN_cfdperf_A`, stdout: `${HOME}/Digital_twin/GNN_cfdperf_A/slurm-%j.out` }),
    reg({ workDir: `${HOME}/Digital_twin/GNN_cfdperf_A`, stdout: `${HOME}/Digital_twin/GNN_cfdperf_A/slurm-%j.out` }),
    reg({ workDir: `${HOME}/Digital_twin/GNN_cfdperf_B`, stdout: `${HOME}/Digital_twin/GNN_cfdperf_B/slurm-%j.out` }),
  ];
  const found = deriveCollectionDirs(entries, { homes: [HOME], nowMs: NOW });
  assert.deepEqual(found.map((f) => f.root), ["Digital_twin/GNN/outputs", "Digital_twin/GNN/training_wss_min/experiments"]);
});

test("$HOME 自己不算集合目录；不在 $HOME 下的路径、过期的登记一律不计", () => {
  const flat = ["a", "b", "c", "d"].map((p) => reg({ workDir: `${HOME}/${p}`, stdout: `${HOME}/${p}/logs/run_%j.out` }));
  assert.deepEqual(deriveCollectionDirs(flat, { homes: [HOME], nowMs: NOW }), [], "家目录下 4 个项目各一个 logs：没有集合目录");

  const elsewhere = ["x", "y", "z"].flatMap((p) => [
    reg({ workDir: `/scratch/shared/${p}`, stdout: `/scratch/shared/runs/${p}/out_%j.log` }),
    reg({ workDir: `/public/home/kaix/proj/${p}`, stdout: null }),
    reg({ workDir: `${HOME}-old/proj/${p}`, stdout: null }),
    reg({ workDir: null, stdout: `runs/${p}/out_%j.log` }),
    reg({ workDir: "/dev", stdout: "/dev/null" }),
  ]);
  assert.deepEqual(deriveCollectionDirs(elsewhere, { homes: [HOME], nowMs: NOW }), []);

  const stale = ["r1", "r2", "r3"].map((p) => reg({ stdout: `${HOME}/proj/runs/${p}/o_%j.log`, lastSeenAt: NOW - COLLECTION_WINDOW_MS - HOUR }));
  assert.deepEqual(deriveCollectionDirs(stale, { homes: [HOME], nowMs: NOW }), []);
  stale[0].lastSeenAt = NOW - COLLECTION_WINDOW_MS + HOUR;
  assert.deepEqual(deriveCollectionDirs(stale, { homes: [HOME], nowMs: NOW }), [], "窗口内只剩 1 个");
  for (const entry of stale) entry.lastSeenAt = NOW - 13 * 24 * HOUR;
  assert.deepEqual(deriveCollectionDirs(stale, { homes: [HOME], nowMs: NOW }).map((f) => f.root), ["proj/runs"]);
});

test("家目录的两种写法都认：物理路径与 $HOME 原值（经过符号链接时两者不同）", () => {
  const entries = [
    reg({ workDir: "/home/kai/proj", stdout: "/home/kai/proj/runs/r1/o_%j.log" }),
    reg({ workDir: "/public/home/kai/proj", stdout: "/public/home/kai/proj/runs/r2/o_%j.log" }),
    reg({ workDir: "/public/home/kai/proj", stdout: "runs/r3/o_%j.log" }),
  ];
  assert.deepEqual(deriveCollectionDirs(entries, { homes: ["/public/home/kai", "/home/kai"], nowMs: NOW }), [{ root: "proj/runs", jobs: 3, children: 3 }]);
  assert.deepEqual(deriveCollectionDirs(entries, { homes: ["/public/home/kai"], nowMs: NOW }), [], "只认物理路径时凑不够 3 个");
  assert.equal(relativeToHome("/public/home/kai", ["/public/home/kai"]), "");
  assert.equal(relativeToHome("/public/home/kai/a/b", ["/x", "/public/home/kai"]), "a/b");
  assert.equal(relativeToHome("/public/home/kaix/a", ["/public/home/kai"]), null);
  assert.equal(relativeToHome("/a", ["/", "", null, "relative"]), null, "不合格的 home 不参与匹配");
});

test("输出目录：StdOut 所在目录（相对路径以 WorkDir 为基准），没有 StdOut 用 WorkDir；目录里的占位符按登记展开", () => {
  assert.equal(jobOutputDir(reg({ stdout: `${GNN}/outputs/b/logs/mesh_%j.out` })), `${GNN}/outputs/b/logs`);
  assert.equal(jobOutputDir(reg({ workDir: `${GNN}/`, stdout: "logs/x_%j.out" })), `${GNN}/logs`);
  assert.equal(jobOutputDir(reg({ workDir: `${GNN}/a/../b//`, stdout: null })), `${GNN}/b`);
  assert.equal(jobOutputDir(reg({ workDir: null, stdout: null })), null);
  assert.equal(jobOutputDir(reg({ workDir: "relative/dir", stdout: "x.out" })), null);
  assert.equal(jobOutputDir(reg({ workDir: null, stdout: "/x.out" })), "/");
  assert.equal(jobOutputDir(null), null);
  // %x = 作业名，%u = 用户，%j = 作业号，%A / %a = 数组号 / 任务号
  assert.equal(jobOutputDir(reg({ jobId: "500", name: "xp_a", stdout: `${GNN}/runs/%x/%u/%j/out.log` })), `${GNN}/runs/xp_a/kai/500`);
  assert.equal(jobOutputDir(reg({ jobId: "612", arrayJobId: "600", arrayTaskId: "7", stdout: `${GNN}/arr/%A/task_%3a/o.log` })), `${GNN}/arr/600/task_007`);
  // 排队中的数组整体：任务号未知，不猜——在占位符那一段截断
  assert.equal(jobOutputDir(reg({ jobId: "600_[1-10]", arrayJobId: "600", stdout: `${GNN}/arr/%A/task_%a/o.log` })), `${GNN}/arr`);
  // 展开不了的占位符（%N 之类）同样截断；文件名里的占位符不影响目录
  assert.equal(jobOutputDir(reg({ stdout: `${GNN}/by-node/%N/logs/o_%j.log` })), `${GNN}/by-node`);
  assert.equal(jobOutputDir(reg({ stdout: "/%x/o.log", name: null })), "/");
});

test("目录名带中文、空格、引号照样成立；按作业数取前 4 个，同数按路径", () => {
  const entries = [];
  const dirs = ["数据 集/第 1 批", "it's \"q\"/runs", "plain/runs", "z/runs", "y/runs"];
  dirs.forEach((dir, index) => {
    for (let child = 0; child < 3; child += 1) {
      for (let n = 0; n <= index; n += 1) entries.push(reg({ workDir: `${HOME}/${dir}/c${child}`, stdout: `${HOME}/${dir}/c${child}/slurm-%j.out` }));
    }
  });
  const found = deriveCollectionDirs(entries, { homes: [HOME], nowMs: NOW });
  assert.equal(found.length, COLLECTION_MAX);
  assert.deepEqual(found.map((f) => [f.root, f.jobs]), [["y/runs", 15], ["z/runs", 12], ["plain/runs", 9], ["it's \"q\"/runs", 6]]);
  assert.deepEqual(deriveCollectionDirs(entries, { homes: [HOME], nowMs: NOW, limit: 9 }).at(-1), { root: "数据 集/第 1 批", jobs: 3, children: 3 });
  const tie = ["b", "a"].flatMap((p) => [1, 2, 3].map((c) => reg({ workDir: `${HOME}/${p}/runs/c${c}`, stdout: null })));
  assert.deepEqual(deriveCollectionDirs(tie, { homes: [HOME], nowMs: NOW }).map((f) => f.root), ["a/runs", "b/runs"]);
});

test("畸形输入不抛错：不是数组、条目缺字段、没有 home", () => {
  assert.deepEqual(deriveCollectionDirs(null), []);
  assert.deepEqual(deriveCollectionDirs([null, 5, {}, { lastSeenAt: NOW }, { lastSeenAt: "x", workDir: `${HOME}/a` }], { homes: [HOME], nowMs: NOW }), []);
  assert.deepEqual(deriveCollectionDirs(realShapes(), { homes: [], nowMs: NOW }), []);
  assert.deepEqual(deriveCollectionDirs(realShapes(), { nowMs: NOW }), []);
});
