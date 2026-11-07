// 增量日志尾巴扫描：把 fast profile 采集脚本（remote/collect.sh）回来的日志段落
// 喂给信号引擎（log-signals.mjs）做增量识别。
// 设计：docs/superpowers/specs/2026-07-23-log-signal-detection-design.md
//
// kind 语义：
//   command  —— 每轮抓重叠尾巴（如 reclaude logs | tail -n 120），靠引擎行级去重取增量，
//               不依赖远端日志文件路径稳定。
//   snapshot —— 状态快照（如 state.json），每轮全量重扫，只靠冷却窗口限频。

export const DEFAULT_LOG_SOURCES = [
  { id: "reclaude-logs", kind: "command" },
  { id: "reclaude-state", kind: "snapshot" },
];

export const LOCAL_PROXY_LOG_SOURCE = { id: "local-proxy-log", kind: "local" };

// v2.18 零残留采集：信号扫描核心与"怎么把日志尾巴弄回来"解耦。
//
// 段落已经在别处拿到（fast profile 的 collector 输出）时，调用
// scanSections(sections, opts) 即可——它只做 引擎扫描 → 信号结算 → 结果合成，
// 不发起任何 SSH。
//
// lastActivityAt 是扫描器实例的内存态（每个 createSectionScanner 一份）。
export function createSectionScanner({ getLocalProxyLog, engine, now = Date.now, onSignals }) {
  let lastActivityAt = null; // command 源出现"未见过的行"的最近时刻（进程内存态，重启归零）

  return async function scanSections(sections, {
    sources = DEFAULT_LOG_SOURCES,
    remoteFailed = false,
    failureReason = "远端采集失败",
  } = {}) {
    // 本地 supervisor 结构化日志：这条来源专门承载本地代理的 connect-deny 证据
    // （它不在远端日志里）。local read 是 best-effort，失败必须静默降为空串。
    const localProxyLog = typeof getLocalProxyLog === "function"
      ? String(await Promise.resolve().then(getLocalProxyLog).catch(() => "") || "")
      : "";
    if (remoteFailed && !localProxyLog.trim()) {
      // 远端抓取失败不产生信号：网络抖动不得伪装成卡顿反馈，只按探针 error 结算。
      return { level: "error", reason: `日志抓取失败 (${failureReason})`, data: null, error: true };
    }

    const bySource = { ...(sections || {}) };
    const allSources = typeof getLocalProxyLog === "function"
      ? [...sources, LOCAL_PROXY_LOG_SOURCE]
      : sources;
    if (typeof getLocalProxyLog === "function") bySource[LOCAL_PROXY_LOG_SOURCE.id] = localProxyLog;
    const newSignals = [];
    for (const s of allSources) {
      const { newSignals: hits, newLineCount } = engine.scan(s.id, bySource[s.id] || "", {
        snapshot: s.kind === "snapshot",
      });
      newSignals.push(...hits);
      if (s.kind === "command" && newLineCount > 0) lastActivityAt = now();
    }

    const activeSignals = engine.getActiveSignals();
    if (newSignals.length && onSignals) {
      try {
        onSignals(newSignals, activeSignals);
      } catch {}
    }

    // info 级是采样取证信号（如 probe-timeout-sample 的 :30 抖动取证）：进
    // activeSignals 供人工统计，但绝不参与探针 level/reason 结算——采样不是告警，
    // 不得把面板从 ok 拉成 warn，更不能触发红条（红条另有 severity==="error" 门槛）。
    const alerting = activeSignals.filter((sig) => sig.severity !== "info");
    const level = remoteFailed || alerting.some((sig) => sig.severity === "error")
      ? "error"
      : (alerting.length ? "warn" : "ok");
    const signalReason = alerting.length ? `${alerting.length} 个活跃卡顿信号` : "无异常信号";
    // 本地代理日志仍可在远端故障时给出 CONNECT 拒绝证据，但不能借此把远端采集失败
    // 伪装成健康；两种事实一并呈现。
    const reason = remoteFailed
      ? `日志抓取失败 (${failureReason})；${signalReason}`
      : signalReason;
    return {
      level,
      reason,
      data: {
        signals: newSignals,
        activeSignals,
        lastActivityAt,
        sourceIds: allSources.map((s) => s.id),
      },
    };
  };
}
