// 一组探针结果的时间戳聚合（层级的 checkedAt / nextCheckAt 都由若干探针共同决定）。
// 缺席的探针（undefined）先滤掉；sort 把 undefined 时间戳排到末尾，全缺时回落 null。

// 最近一次探测时刻（取最大 checkedAt）。
export function latestCheckedAt(results) {
  return results
    .filter(Boolean)
    .map((r) => r.checkedAt)
    .sort((a, b) => b - a)[0] ?? null;
}

// 最早的下一次探测时刻（取最小 nextCheckAt）。
export function earliestNextCheckAt(results) {
  return results
    .filter(Boolean)
    .map((r) => r.nextCheckAt)
    .sort((a, b) => a - b)[0] ?? null;
}
