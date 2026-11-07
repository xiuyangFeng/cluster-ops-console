// render-skip.js —— 模块级渲染跳过（v2.13.0）。
// SSE status 事件高频到达时，rAF 合并后那一帧仍会全量跑所有渲染子模块；其中
// checklist/topology/load-panel/alert-banner 等是无条件重写 DOM 的。这里提供统一的
// 「签名未变则跳过」包装器：签名由各模块显式声明自己消费的输入切片，切片不变就
// 完全不触碰 DOM。与 reconcileList 的 item 级增量互补——后者管"列表内逐项"，本模块管
// "整个子模块要不要跑"。
//
// 注意：显示相对时间文案（"3 分钟前"）的模块必须把 RELATIVE_TIME_BUCKET_MS 时间桶
// 算进签名，否则数据不变时相对时间会冻结在最后一次渲染。

// 相对时间刷新粒度：数据不变时每 30s 仍允许重渲一次，让"X 分钟前"不至于长期停滞。
export const RELATIVE_TIME_BUCKET_MS = 30000;

// 纯函数（可单测）：当前时间桶编号。同桶内视为"相对时间文案大概率相同"。
export function timeBucket(now = Date.now()) {
  return Math.floor(Number(now) / RELATIVE_TIME_BUCKET_MS);
}

// 高阶函数：把普通渲染函数包装为带签名的记忆化版本。
// - 首次调用必然执行（hasRendered 门闩），避免初始态被空签名误跳过；
// - 返回是否真正渲染了（便于测试与调用方统计）；
// - lastSignature 在 renderFn 成功返回后才更新，renderFn 抛错不会污染缓存，
//   下一轮仍会重试渲染而不是带着坏状态静默跳过。
export function createMemoRender(renderFn, buildSignature) {
  let lastSignature = null;
  let hasRendered = false;
  return (...args) => {
    const signature = buildSignature(...args);
    if (hasRendered && signature === lastSignature) return false;
    renderFn(...args);
    lastSignature = signature;
    hasRendered = true;
    return true;
  };
}
