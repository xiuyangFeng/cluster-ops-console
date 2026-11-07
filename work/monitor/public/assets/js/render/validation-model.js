// validation-model.js —— 环境完整性校验（服务器配置里的 validationProfile，每 5 分钟一轮）的纯函数。
// 校验清单显示在概览「数据链路」远端节点的详情里（v2.53.3 起，服务器页不再单独放一块）。

// 汇总统计（总数 / 失败数 / 跳过数 / 最慢项）。跳过项（item.skipped，如没领端口时的
// remoteProxyTest）不算通过也不算失败，不进 total。
export function buildValidationSummary(items = []) {
  let total = 0;
  let failCount = 0;
  let skippedCount = 0;
  let slowest = null;
  for (const item of items) {
    if (item.skipped) {
      skippedCount += 1;
      continue;
    }
    total += 1;
    if (!item.ok) failCount += 1;
    const ms = Number(item.durationMs);
    if (Number.isFinite(ms) && (slowest == null || ms > slowest.durationMs)) {
      slowest = { key: item.key, durationMs: ms };
    }
  }
  return {
    total,
    failCount,
    passed: total - failCount,
    skippedCount,
    allOk: failCount === 0,
    slowestKey: slowest ? slowest.key : null,
    slowestMs: slowest ? slowest.durationMs : null,
  };
}

// 汇总文案，如「4/4 通过 · 最慢 remoteProxyTest 443ms」「1/5 失败 · 最慢 authCheck 999ms」，
// 有跳过项时追加「· 跳过 1 项」。
export function buildValidationSummaryLabel(summary) {
  const head = summary.allOk ? `${summary.passed}/${summary.total} 通过` : `${summary.failCount}/${summary.total} 失败`;
  const slow = summary.slowestKey != null ? ` · 最慢 ${summary.slowestKey} ${summary.slowestMs}ms` : "";
  const skipped = summary.skippedCount > 0 ? ` · 跳过 ${summary.skippedCount} 项` : "";
  return head + slow + skipped;
}

// 失败项置顶、跳过项垫底（稳定排序，同类之间保持原顺序）。
const itemRank = (item) => (item.skipped ? 2 : item.ok ? 1 : 0);
export function sortValidationItems(items = []) {
  return [...items].sort((a, b) => itemRank(a) - itemRank(b));
}
