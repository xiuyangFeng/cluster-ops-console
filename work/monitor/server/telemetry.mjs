// 遥测旁路监听：状态时间线 / 通道恢复补跑（doctor + 被熔断跳过的探针）/ 探针指标与历史采样。
// 每个 register* 只挂一个监听器；挂载时机（即同一事件内的分发顺序）由 start.mjs 决定：
//   STATUS_CHANGED：时间线/历史 → 恢复补跑 → 事件合并 → 自动修复
//   PROBE_UPDATED ：state-store → 事件合并 → 自动修复(log-signals) → 指标/历史
//   LEVELS_REBASED：历史基线（只有这一个监听方）
// 监听器一律整体 try/catch 或只做不抛的调用：抛错会沿 bus.emit 冒泡回探针归并路径。

import { adapterForProbeId } from "../lib/agents/registry.mjs";
import { STEADY_PROBE_IDS } from "../lib/agents/steady-interval.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { serverIdFromCollectSlow, serverIdFromValidation } from "../lib/probe-ids.mjs";

// 通道闸门：两个只读判据，探针调度 / 配置内核桥 / 指标采样共用。
export function createChannelGates(store) {
  return {
    getTunnelUp: () => store.getLayers().channel.detail.tunnelUp === true,
    // 熔断门：通道 ok = tunnelUp && remotePortOpen（v1.5.2 低频轮询的同一判据）。
    isChannelOk: () => {
      const detail = store.getLayers().channel.detail;
      return detail.tunnelUp === true && detail.remotePortOpen === true;
    },
  };
}

// 时间线落盘 + 历史旁路。createLogger 没有 onAppend 钩子，timeline 的唯一写入点就是这个
// STATUS_CHANGED 监听器——在调用点旁路一份进 history 是侵入最小的挂法（logger 契约零改动）。
export function registerStatusTimeline({ timelineLogger, historyStore }) {
  bus.on(EVENTS.STATUS_CHANGED, ({ transitions }) => {
    try {
      for (const t of transitions || []) {
        timelineLogger.info(`${t.key}: ${t.from} -> ${t.to}`, t);
        historyStore.record({ type: "transition", ...t });
      }
    } catch {}
  });
}

// 历史基线：变迁条目只记「变了什么」，按天复盘 / 泳道图还要知道起点（形状见 history-store.mjs）。
//  - 注入 provider：history-store 需要基线时向它取当前全量级别快照；
//  - 挂载时立刻 checkpoint 一次落下启动基线，之后每分钟检查一次是否跨天（跨天后即便一直
//    没有别的写入，也在零点后一分钟内记下当时的状态）；
//  - 查看视角切换 / 删停服务器让状态键集合换了一批却没有变迁（state-store 发 LEVELS_REBASED）
//    时另记一份，复盘才不会把不再跟踪的键的旧状态一直延续下去。
// 返回注销函数（供测试）。
export const HISTORY_BASELINE_CHECK_MS = 60_000;

export function registerHistoryBaseline({ historyStore, getLevelSnapshot, checkMs = HISTORY_BASELINE_CHECK_MS }) {
  historyStore.setBaselineProvider(() => {
    try {
      return getLevelSnapshot();
    } catch {
      return null;
    }
  });
  const check = () => {
    try {
      historyStore.checkpoint();
    } catch {}
  };
  const onRebased = (payload) => {
    try {
      historyStore.recordBaseline({ cause: "view", view: payload?.view, levels: payload?.levels });
    } catch {}
  };
  check();
  const timer = setInterval(check, checkMs);
  if (typeof timer.unref === "function") timer.unref();
  bus.on(EVENTS.LEVELS_REBASED, onRebased);
  return () => {
    clearInterval(timer);
    bus.off(EVENTS.LEVELS_REBASED, onRebased);
    historyStore.setBaselineProvider(null);
  };
}

// 通道进入 ok（故障恢复，或热启动后首次 ok）时立刻补跑：
//  - 自适应降频的诊断探针（doctor / claude-code，已注册的）：v2.16 降频的配套插队，不必等自适应窗口
//   （健康稳态下是 5 分钟）走完——通道断开又恢复得快时，它们可能一轮都没到期、没被熔断跳过，
//    手里还是断开之前的结论；
//  - 最近一次结果是门控跳过的全部探针（agent 诊断 / 验证等被通道熔断跳过的）：跳过轮按
//    完整间隔排下一次（agent 90s、验证 5 分钟），不补跑的话通道早已恢复，面板仍挂着
//    「通道异常，熔断跳过」和熔断占位带来的假「降级」。热启动首拍尤其如此——首个
//    processes 结果回来之前通道还是 waiting，熔断门不开，agent / 验证探针全被跳过。
// forceRun 自带 inflight 去重、5s 防抖、SSH 槽位排队与熔断礼貌跳过（enabled=false 时
// 不写结果不发事件），通道抖动不会造成探测风暴。返回注销函数（供测试）。
export function registerRerunOnRecovery({ scheduler }) {
  const onStatusChanged = ({ transitions }) => {
    const channelRecovered = (transitions || []).some((t) => t.key === "channel" && t.to === "ok");
    if (!channelRecovered) return;
    // 只补跑已注册的（对应 Agent 模块被关掉后探针已注销，forceRun 只会空转报错）。
    const steady = STEADY_PROBE_IDS.filter((id) => scheduler.isRegistered(id));
    for (const id of new Set([...steady, ...scheduler.listGateSkipped()])) {
      scheduler.forceRun(id).catch(() => {});
    }
  };
  bus.on(EVENTS.STATUS_CHANGED, onStatusChanged);
  return () => bus.off(EVENTS.STATUS_CHANGED, onStatusChanged);
}

// 探针结果 → 指标样本 / 历史采样（纯分发，便于单测）。
export function recordProbeTelemetry({ id, result }, { metricsStore, historyStore, getTunnelUp, isChannelOk }) {
  if (!result) return;
  // agents 层探针：延迟/可用率样本（serverId = probe:<id>，kind = probe）。
  if (adapterForProbeId(id) && ["ok", "warn", "error"].includes(result.level)) {
    metricsStore.addSample({
      serverId: `probe:${id}`,
      kind: "probe",
      tunnelUp: getTunnelUp(),
      probeDurationMs: result.durationMs,
      level: result.level,
      ok: result.level === "ok",
      latencyMs: result.data?.latencyMs ?? null,
    });
    return;
  }
  const validationServerId = serverIdFromValidation(id);
  if (validationServerId) {
    const testItem = result.data?.items?.find((i) => i.key === "remoteProxyTest");
    if (testItem?.ok) {
      metricsStore.addSample({
        serverId: validationServerId,
        kind: "validation",
        cpu: 0,
        ram: 0,
        disk: 0,
        tunnelUp: getTunnelUp(),
        probeDurationMs: result.durationMs,
        proxyLatencyMs: testItem.durationMs,
      });
    }
    return;
  }
  // v2.18：资源样本的唯一来源是每台服务器的 slow 采集探针（collect:slow:<serverId>），
  // 取代旧的 primary-remote + load:* 两条通路；负载字段随之从 data.brief 改为 data.load。
  // 前缀不匹配（processes / agent 探针 / validation）一律不写资源样本。
  if (result.level !== "ok" || !result.data || !result.data.load) return;
  const serverId = serverIdFromCollectSlow(id);
  if (!serverId) return;
  const brief = result.data.load;
  // T03：新版口径字段（busyPct/归一化负载）随 usage 透传进指标与历史；usage 缺失
  // （旧采集脚本）时为 null——旧 cpu 字段保持归一化负载语义，不被重解释。
  const usage = result.data.usage || null;
  metricsStore.addSample({
    serverId,
    cpu: brief.cpu,
    ram: brief.ram,
    disk: brief.disk,
    cpuBusyPct: usage?.cpu?.busyPct ?? null,
    loadNormalizedPct: usage?.cpu?.loadNormalizedPct ?? null,
    metricSchemaVersion: usage ? usage.schemaVersion : null,
    tunnelUp: getTunnelUp(),
    probeDurationMs: result.durationMs,
    // 每卡利用率（按卡序）：有了历史，GPU 卡才画得出近 24 小时走势。没有 GPU 的机器不带这个字段。
    gpuUtil: Array.isArray(result.data.gpu) ? result.data.gpu.map((card) => card?.util) : null,
    // 直连节点（node04 这类从登录节点跳采的机器）的各卡利用率：同一轮 slow 采集的 slurm 段里就有
    nodeGpuUtil: directNodeGpuUtil(result.data.slurm),
  });
  // 历史采样旁路：每台服务器 cpu/ram/disk + 通道 health。降采样（60s/条 + 值不变
  // 跳写）由 history-store 内部把关，这里每拍直接投递即可。
  historyStore.record({
    type: "sample",
    key: serverId,
    cpu: brief.cpu,
    ram: brief.ram,
    disk: brief.disk,
    cpuBusyPct: usage?.cpu?.busyPct ?? null,
    loadNormalizedPct: usage?.cpu?.loadNormalizedPct ?? null,
    channelOk: isChannelOk(),
  });
}

// slurm 快照里直连且可达的节点 → { 节点名: [各卡利用率] }；没有就 null（metrics-store 再做一遍校验）。
export function directNodeGpuUtil(slurm) {
  const out = {};
  for (const node of Array.isArray(slurm?.nodes) ? slurm.nodes : []) {
    const cards = node?.source === "direct" && node.reachable !== false ? node.gpus?.cards : null;
    if (typeof node?.name === "string" && Array.isArray(cards) && cards.length) out[node.name] = cards.map((card) => card?.util);
  }
  return Object.keys(out).length ? out : null;
}

export function registerProbeMetrics(deps) {
  bus.on(EVENTS.PROBE_UPDATED, (event) => {
    try {
      recordProbeTelemetry(event, deps);
    } catch {}
  });
}
