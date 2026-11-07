// 复盘建议只消费已归一的记账数据；不把单任务 RSS 当成多任务总峰值，也不按 GPU 峰值减卡。
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

export function resourceAdvice(r = {}) {
  const completed = r.state === "COMPLETED";
  const single = r.singleTask === true;
  const assessments = [];
  const directives = [];
  const add = (resource, kind, text) => assessments.push({ resource, kind, text });
  const cpu = r.cpuEfficiency;
  if (typeof cpu !== "number" || !Number.isFinite(cpu)) add("CPU", "unknown", "记账不足，无法判断核数是否过量");
  else if (completed && cpu < 0.5 && r.elapsedSeconds >= 300) add("CPU", "over", "平均利用偏低，申请可能过量；先核对数据加载与并行阶段");
  else add("CPU", "observed", cpu >= 0.9 ? "接近用满；平均效率不能证明核数不足" : "暂未见明显过量证据");

  const memRatio = positive(r.maxRssBytes) && positive(r.requestedMemoryBytes) ? r.maxRssBytes / r.requestedMemoryBytes : null;
  if (r.state === "OUT_OF_MEMORY") add("内存", "risk", "申请不足或单节点分布不均：发生 OOM；核对泄漏、并发与每节点限额后再增加");
  else if (!single || memRatio === null) add("内存", "unknown", "单任务 RSS 无法证明整作业峰值；缺测或多任务 / 多节点时不建议减内存");
  else if (memRatio >= 0.9) add("内存", "risk", "峰值接近或超过申请量，存在余量不足风险；先核对记账与内存波动");
  else if (completed && memRatio < 0.5) add("内存", "over", "单节点单任务峰值低于申请量的一半，申请可能过量");
  else add("内存", "observed", "暂未见明显过量证据");

  if (r.state === "TIMEOUT") add("时长", "risk", "时限不足导致终止；本次耗时不是完整训练时长，需按剩余工作量重估");
  else if (!positive(r.timeLimitSeconds) || !positive(r.elapsedSeconds)) add("时长", "unknown", "申请时限或实际耗时未知");
  else if (completed && r.elapsedSeconds < r.timeLimitSeconds / 2) add("时长", "over", "实际耗时低于时限的一半，缩短合理时限可能更容易进入回填空隙");
  else add("时长", "observed", "保留运行波动余量，耗时随数据规模变化");
  add("GPU", "unknown", r.requestedGpus === 0 ? "本作业未申请 GPU，不作 GPU 缩量判断" : positive(r.gpuMemoryPeakBytes) || r.gpuUtilPeak !== null && r.gpuUtilPeak !== undefined
    ? "仅有记账高水位，无法判断整段 GPU 效率或卡数是否过量；不据此减卡"
    : "集群未提供 GPU 实耗记账（含未启用采集或 MIG）；不据此减卡");

  // 失败 / 取消作业可能只跑过初始化阶段，绝不据它们生成缩量指令。
  if (completed && positive(r.elapsedSeconds) && r.elapsedSeconds >= 300) {
    if (single && positive(r.allocCpus) && typeof cpu === "number" && cpu > 0 && cpu < 0.5) {
      directives.push(`#SBATCH --cpus-per-task=${Math.min(r.allocCpus, Math.max(1, Math.ceil(r.allocCpus * cpu * 1.5)))}`);
    }
    if (single && memRatio !== null && memRatio < 0.5) {
      const mib = Math.max(256, Math.ceil(r.maxRssBytes * 1.5 / (256 * 1024 ** 2)) * 256);
      directives.push(`#SBATCH --mem=${mib}M`);
    }
    if (positive(r.timeLimitSeconds) && r.elapsedSeconds < r.timeLimitSeconds / 2) {
      const mins = Math.max(5, Math.ceil(r.elapsedSeconds * 1.5 / 300) * 5);
      const days = Math.floor(mins / 1440);
      const hours = Math.floor(mins % 1440 / 60);
      directives.push(`#SBATCH --time=${days ? `${days}-` : ""}${String(hours).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`);
    }
  }
  return {
    assessments,
    sbatch: directives.join("\n"),
    adviceNote: directives.length
      ? `仅用于相同规模的下一次小样本试跑：按实耗留 50% 余量，CPU 仍可能有短时并行峰值。替换原脚本的对应指令并核对 --cpus-per-gpu；内存只保留 --mem / --mem-per-cpu / --mem-per-gpu 中一种；保留任务布局、GPU 型号与卡数。`
      : "证据不足或本次未正常完成，暂不生成缩量指令；保持原申请并结合训练配置复核。",
  };
}
