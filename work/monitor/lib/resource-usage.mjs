// resource-usage.mjs —— T03 新版资源结构与 CPU 差分计算（纯函数，无 IO）。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §6.2）：
//   total = user + nice + system + idle + iowait + irq + softirq + steal
//   deltaTotal = total_now - total_previous
//   deltaIdle = (idle_now + iowait_now) - (idle_prev + iowait_prev)
//   cpuBusyPct = 100 × (deltaTotal - deltaIdle) / deltaTotal
//   loadNormalizedPct = 100 × load1 / logicalCores（可 > 100）
// guest/guest_nice 已包含在 user/nice 里，不再重复相加。cpuBusyPct 是扣除 idle 与
// iowait 的统计口径，不是进程占用之和；iowait 计数有局限，不能单值判断磁盘根因。
//
// 关键边界（A12）：
//   - 首样本 / boot_id 改变 / 计数倒退 / deltaTotal <= 0 → busyPct=null、
//     quality=insufficient/reset。保留原始有效计数供下一帧，不用 0 掩盖未知，
//     不在远端 sleep 等第二帧。
//   - 旧样本（legacy cpu = load1/核数）不被重新解释；只有归一化口径明确时才映射
//     loadNormalizedPct，永不映射到 cpuBusyPct（A15）。

export const USAGE_SCHEMA_VERSION = 1;

const CPU_QUALITY = Object.freeze({
  OK: "ok",
  INSUFFICIENT: "insufficient",
  RESET: "reset",
});

const CPU_COUNTER_NAMES = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"];
const isCounter = (value) => Number.isFinite(value) && value >= 0;

// 差分输入：{ user, nice, system, idle, iowait, irq, softirq, steal }（全为非负整数或
// null）。bootId 可选；两帧任一字段缺失 → insufficient（busyPct null）。
export function computeCpuBusy(prev, curr, { prevBootId = null, currBootId = null } = {}) {
  if (!prev || !curr) return { busyPct: null, deltaTotal: null, deltaIdle: null, quality: CPU_QUALITY.INSUFFICIENT };
  if (prevBootId && currBootId && prevBootId !== currBootId) {
    // 机器重启（或换了机器）：计数序列断裂，首帧无有效利用率。
    return { busyPct: null, deltaTotal: null, deltaIdle: null, quality: CPU_QUALITY.RESET };
  }
  if (!CPU_COUNTER_NAMES.every((name) => isCounter(prev[name]) && isCounter(curr[name]))) {
    return { busyPct: null, deltaTotal: null, deltaIdle: null, quality: CPU_QUALITY.INSUFFICIENT };
  }
  const sum = (x) => CPU_COUNTER_NAMES.reduce((acc, name) => acc + x[name], 0);
  const deltaTotal = sum(curr) - sum(prev);
  const deltaIdle = (curr.idle + curr.iowait) - (prev.idle + prev.iowait);
  // 计数倒退（deltaTotal < 0）或零增长（相邻两帧太快/计数冻结）都不可信。
  if (deltaTotal <= 0) {
    return { busyPct: null, deltaTotal, deltaIdle, quality: CPU_QUALITY.RESET };
  }
  if (deltaIdle < 0 || deltaIdle > deltaTotal) {
    // idle 增量与总量矛盾：字段异常，按 insufficient 处理而不是算出离谱值。
    return { busyPct: null, deltaTotal, deltaIdle, quality: CPU_QUALITY.INSUFFICIENT };
  }
  const busyPct = Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10;
  // busy 百分比限制 0–100（负载归一化允许超过 100，这里不允许）。
  const clamped = Math.max(0, Math.min(100, busyPct));
  return { busyPct: clamped, deltaTotal, deltaIdle, quality: CPU_QUALITY.OK };
}

export function computeLoadNormalizedPct(load1, logicalCores) {
  if (!Number.isFinite(load1) || !Number.isFinite(logicalCores) || logicalCores <= 0) return null;
  return Math.round((load1 / logicalCores) * 1000) / 10;
}

// free -h 的 "251Gi"/"1.4Ti"/"642Mi" → 字节。无法识别的形态返回 null（不猜）。
export function humanSizeToBytes(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGTPE]?i?B?)$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  // 后缀归一：iB/KiB 二进制标记与 free 的 "Gi" 简写（= GiB）都归一到 K/M/G/T 档。
  const raw = match[2].toLowerCase();
  const suffix = raw.endsWith("ib") ? raw.slice(0, -2)
    : raw.endsWith("b") ? raw.slice(0, -1)
    : raw.endsWith("i") ? raw.slice(0, -1)
    : raw;
  const power = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 }[suffix];
  if (power === undefined) return null;
  return Math.round(value * 1024 ** power);
}

/**
 * 组装 usage 对象（schemaVersion 1）。全部字段防御性读取：缺失 → null（未知），
 * 绝不用 0 冒充已测。legacy `load`（sys 段旧解析）保持原样，不进本函数。
 * @param {{
 *   prev: object|null, cpuStat: object|null, filesystem: object|null,
 *   sysText: string, checkedAt: number|null
 * }} input
 */
export function buildResourceUsage({ prev = null, cpuStat = null, filesystem = null, sysText = "", checkedAt = null } = {}) {
  // sysText：旧 sys 段原文，从中取 load average 与内存行（与 load-panel 同源文本）。
  let load1 = null;
  let logicalCores = null;
  let memUsedBytes = null;
  let memTotalBytes = null;
  if (sysText) {
    const uptimeLine = sysText.split("\n").find((l) => l.includes("load average"));
    const loadMatch = uptimeLine ? uptimeLine.match(/load average:\s*([0-9.]+)/i) : null;
    if (loadMatch) load1 = Number(loadMatch[1]);
    const nprocLine = sysText.split("\n").find((l) => /^nproc:\s*\d+$/.test(l.trim()));
    if (nprocLine) logicalCores = parseInt(nprocLine.trim().slice("nproc:".length), 10);
    const memLine = sysText.split("\n").find((l) => l.startsWith("Mem:"));
    if (memLine) {
      const parts = memLine.split(/\s+/).filter(Boolean);
      // free -h 形如：Mem: 251Gi 98Gi 40Gi ...（表头后 total=parts[1], used=parts[2]）
      memTotalBytes = humanSizeToBytes(parts[1]);
      memUsedBytes = humanSizeToBytes(parts[2]);
    }
  }

  // 段缺失（旧 supervisor 采集脚本 / 输出截断）：CPU busy 明确"无此数据"。
  const diff = cpuStat?.present
    ? computeCpuBusy(prev?.counters || null, cpuStat, {
        prevBootId: prev?.bootId ?? null,
        currBootId: cpuStat.bootId ?? null,
      })
    : { busyPct: null, quality: CPU_QUALITY.INSUFFICIENT };
  const cpu = {
    busyPct: diff.busyPct,
    load1,
    logicalCores,
    loadNormalizedPct: computeLoadNormalizedPct(load1, logicalCores),
    quality: diff.quality,
  };

  let fs = null;
  if (filesystem?.present && filesystem.state === "ok") {
    const kb = (v) => (Number.isFinite(v) && v >= 0 ? v * 1024 : null);
    fs = {
      device: filesystem.device,
      mountpoint: filesystem.mount,
      usedBytes: kb(filesystem.usedKb),
      totalBytes: kb(filesystem.totalKb),
      availBytes: kb(filesystem.availKb),
      // df 的 capacity 是"可用空间口径"的原值：不做 used/total 除法换算
      //（保留块等原因口径可能不同，换算会悄悄改写含义）。
      usedPct: filesystem.capacityPct,
      inodeUsedPct: filesystem.inodePct,
      source: "df-P",
    };
  }

  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : null,
    cpu,
    memory: {
      usedBytes: memUsedBytes,
      totalBytes: memTotalBytes,
    },
    filesystem: fs,
    // T11 前配额始终未知：df 是共享文件系统用量，不能填充个人配额（A14）。
    quota: { state: "unknown" },
  };
}
