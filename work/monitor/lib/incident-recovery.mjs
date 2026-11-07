import { isServerEnabled } from "./config-loader.mjs";
import { adapterForProbeId } from "./agents/registry.mjs";
import { LOG_SIGNALS_PROBE_ID, serverIdFromCollectSlow } from "./probe-ids.mjs";

// 绑定活跃服务器、结果带 probeContext.serverId 的探针：fast 采集 + 各适配器的 agent 探针
// （由注册表 probeIds 派生，不再维护静态清单）。
const isActiveContextProbe = (id) => id === LOG_SIGNALS_PROBE_ID || Boolean(adapterForProbeId(id));

// 恢复只消费服务器自身的新端口采样，不用视角切换或重复进程快照凑成功次数。
export function recoverConnectionIncidents({ id, result, activeServerId, layers, incidentStore, shouldBeRunning }) {
  if (!shouldBeRunning || !result) return false;
  const serverId = id === LOG_SIGNALS_PROBE_ID ? result.probeContext?.serverId || activeServerId
    : serverIdFromCollectSlow(id);
  if (!serverId || (id === LOG_SIGNALS_PROBE_ID && serverId !== activeServerId)) return false;
  const entry = layers.tunnels?.[serverId];
  const data = result.data;
  const hasSample = typeof data?.remotePortOpen === 'boolean' || (data?.ports && Object.keys(data.ports).length > 0);
  // 不看 result.level：fast 采集的 level 结算的是日志里的卡顿信号，slow 采集的 level 是负载段读没读到，
  // 都不是链路结论。断线时 reclaude 自报的「网关不健康」会让 fast 采集红满 10 分钟（信号存活期），
  // 按 level 判的话，通道早已恢复、事件却要再挂 10 分钟，120 秒内自愈的短断也撤不掉候选、照样转正。
  // 采集失败的轮次没有端口结论（data 为空或端口判为未开放），过不了下面两个条件。
  const ok = hasSample && entry?.tunnelUp === true && entry.remotePortOpen === true;
  for (const component of ['tunnel', 'channel']) {
    const channelOk = component !== 'channel' || (layers.channel?.detail?.localProxyUp === true && layers.channel?.detail?.supervisorUp === true);
    const report = ok && channelOk ? 'reportSuccess' : 'reportUnknown';
    incidentStore[report]({ serverId, component });
  }
  return true;
}
// 事件消费者独立校验采样归属：状态库丢弃迟到结果后，总线仍会通知其他订阅者。
export function incidentProbeServerId({ id, result, activeServerId, servers }) {
  const activeProbe = isActiveContextProbe(id);
  const serverId = activeProbe ? result?.probeContext?.serverId : serverIdFromCollectSlow(id);
  if (!serverId || (activeProbe && serverId !== activeServerId)) return null;
  return isServerEnabled({ servers }, serverId) ? serverId : null;
}
