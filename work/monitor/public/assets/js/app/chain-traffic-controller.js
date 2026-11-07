// app/chain-traffic-controller.js —— 数据链路「请求之路」（v2.65）的两路旁路数据：
//   - /api/egress/usage：去向（按目标的连接数 / 上下行）与近一分钟流量（recent）。代理最多每分钟写一次用量文件，
//     20 秒拉一次足够跟上；拿到后经 onUsage 送给链路（render/chain.js setChainTraffic）。
//   - /api/metrics?kind=validation&serverId=<查看中>：环境校验每 5 分钟一次的端到端往返（proxyLatencyMs），
//     5 分钟拉一次；切换查看的服务器后由链路催一次（ensureTrips）立即重拉。经 onTrips(samples, serverId) 送给链路。
// 只在概览可见且窗口没被隐藏时轮询（与隧道稳定性同一门控）；链路面板锁定不可隐藏，由 app/panels.js 的
// enterView 调 enter / leave。拉取失败保留上一份，下一轮再试。
export const CHAIN_USAGE_POLL_MS = 20_000;
export const CHAIN_TRIPS_REFRESH_MS = 5 * 60_000;

export function createChainTrafficController({
  getJson, isViewVisible, isHidden, onVisibilityChange, getActiveServerId = () => null,
  onUsage, onTrips, now = Date.now,
}) {
  let timer = null;
  let inFlight = null;
  let tripsAt = 0;
  let tripsServer = null;

  const visible = () => isViewVisible("overview") && !isHidden();

  async function refreshTrips() {
    const serverId = getActiveServerId();
    if (!serverId) return;
    if (serverId === tripsServer && now() - tripsAt < CHAIN_TRIPS_REFRESH_MS) return;
    tripsAt = now();
    tripsServer = serverId;
    try {
      const { samples } = await getJson(`/api/metrics?kind=validation&serverId=${encodeURIComponent(serverId)}`);
      onTrips?.(Array.isArray(samples) ? samples : [], serverId);
    } catch {
      tripsAt = 0; // 下一轮再试
    }
  }

  async function refreshUsage() {
    try {
      onUsage?.(await getJson("/api/egress/usage"));
    } catch {
      // 保留上一份
    }
  }

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = Promise.all([refreshUsage(), refreshTrips()]).finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!visible()) return;
    timer = setTimeout(async () => {
      if (visible()) await refresh();
      schedule();
    }, CHAIN_USAGE_POLL_MS);
  }

  // 链路发现手上的往返样本不是查看中那台的（切换了服务器 / 首次拿到 activeServerId）：可见时立即补拉。
  function ensureTrips() {
    if (visible()) refreshTrips();
  }

  function bind() {
    onVisibilityChange?.(() => { if (visible()) { refresh(); schedule(); } else schedule(); });
  }

  function enter() {
    refresh();
    schedule();
  }

  function leave() {
    schedule();
  }

  return { bind, enter, leave, refresh, ensureTrips };
}
