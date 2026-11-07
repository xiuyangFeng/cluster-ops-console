import assert from "node:assert/strict";
import test from "node:test";
import { buildResourceReview, parseTres } from "./watch-model.mjs";
import { parseWatchOutput } from "./watch-scan.mjs";
import { resourceAdvice } from "./resource-advice.mjs";

// sacct -n -P --units=K 的分配行与 .batch：16 核 × 1 小时，只使用 2 核小时。
const top = { id: "48213", state: "COMPLETED", cpus: "16", nodes: "1", tasks: "1", reqMem: "64Gn", reqTres: "cpu=16,mem=64G,node=1,gres/gpu=2,gres/gpu:a100=2", elapsed: "3600", timeLimit: "240", totalCpu: "02:00:00" };
const batch = { id: "48213.batch", state: "COMPLETED", tasks: "1", maxRss: "8388608K", totalCpu: "02:00:00", tresMax: "cpu=02:00:00,energy=0,fs/disk=0,gres/gpumem=10240M,gres/gpuutil=196,mem=8388608K" };
const review = (state = "COMPLETED", rows = [top, batch]) => buildResourceReview({ id: "48213", rows }, { name: "train", state }, 1000);

test("真实记账 fixture：对照申请与实耗，GPU 高水位可超过 100%，不按峰值减卡", () => {
  const r = review();
  assert.equal(r.gpuMemoryPeakBytes, 10 * 1024 ** 3);
  assert.equal(r.gpuUtilPeak, 196);
  assert.equal(r.requestedGpus, 2, "总计与类型分项不能相加两遍");
  assert.equal(r.timeLimitSeconds, 14400);
  assert.equal(r.cpuEfficiency, 0.125);
  assert.equal(r.maxRssBytes, 8 * 1024 ** 3);
  assert.deepEqual(r.assessments.map((a) => a.kind), ["over", "over", "over", "unknown"]);
  assert.equal(r.sbatch, "#SBATCH --cpus-per-task=3\n#SBATCH --mem=12288M\n#SBATCH --time=01:30:00");
  assert.doesNotMatch(r.sbatch, /gpu|gres|ntasks|nodes/);
  assert.match(r.detail, /不是时间平均/);
  assert.match(r.adviceNote, /同.*规模|相同规模/);
});

test("多节点、多任务与多 step 不把单任务 RSS 当总内存；时长仍可独立参考", () => {
  for (const rows of [
    [{ ...top, nodes: "2" }, batch],
    [{ ...top, tasks: "" }, batch],
    [top, { ...batch, tasks: "8" }],
    [top, batch, { ...batch, id: "48213.0" }],
    [top, { ...batch, tasks: "" }],
  ]) {
    const r = review("COMPLETED", rows);
    assert.equal(r.singleTask, false);
    assert.equal(r.assessments.find((a) => a.resource === "内存").kind, "unknown");
    assert.doesNotMatch(r.sbatch, /--mem|--cpus-per-task/);
    assert.match(r.sbatch, /--time/);
  }
});

test("OOM、超时、取消、失败不按未完成阶段缩量，近满内存提示风险", () => {
  for (const state of ["OUT_OF_MEMORY", "TIMEOUT", "CANCELLED", "FAILED", "RUNNING"]) assert.equal(review(state).sbatch, "", state);
  assert.match(review("OUT_OF_MEMORY").assessments.find((a) => a.resource === "内存").text, /申请不足/);
  assert.equal(review("TIMEOUT").assessments.find((a) => a.resource === "时长").kind, "risk");
  const r = review("COMPLETED", [top, { ...batch, maxRss: "62G" }]);
  assert.equal(r.assessments.find((a) => a.resource === "内存").kind, "risk");
  assert.doesNotMatch(r.sbatch, /--mem/);
});

test("异常与空输出：不补零、不串作业，TRES 类型与总计兼容，长字段整体拒收", () => {
  assert.equal(buildResourceReview(null), null);
  assert.equal(buildResourceReview({ id: "1", rows: [null, {}, { id: 1 }] }), null);
  assert.deepEqual(parseWatchOutput("").resources, []);
  assert.deepEqual(parseTres("broken,gres/gpumem=N/A,gres/gpuutil=0"), { "gres/gpumem": "N/A", "gres/gpuutil": "0" });
  const r = review("COMPLETED", [{ ...top, reqTres: "gres/gpu:a100=1,gres/gpu:v100=2", elapsed: "0", totalCpu: "bad", timeLimit: "UNLIMITED" }, { ...batch, maxRss: "", totalCpu: "", tresMax: "gres/gpuutil=0,gres/gpumem=N/A" }, { ...batch, id: "999.batch", maxRss: "999T" }]);
  assert.equal(r.requestedGpus, 3);
  assert.equal(r.gpuUtilPeak, 0);
  assert.equal(r.maxRssBytes, null);
  assert.equal(r.totalCpuSeconds, null);
  assert.equal(r.timeLimitSeconds, null);
  assert.equal(r.sbatch, "");
  assert.equal(resourceAdvice().sbatch, "");
  const truncated = buildResourceReview({ id: "48213", rows: [top, batch], truncated: true }, { state: "COMPLETED" }, 1000);
  assert.doesNotMatch(truncated.sbatch, /--mem|--cpus-per-task/);
  assert.match(truncated.detail, /明细未取全/);
  const parsed = parseWatchOutput(JSON.stringify({ k: "resource", id: "1", rows: [{ id: "1", tresMax: "x".repeat(4097) }] }));
  assert.equal(parsed.resources[0].rows[0].tresMax, null);
});
