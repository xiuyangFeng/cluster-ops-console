// log-signals 探针的新信号出口：根因分诊 → signal 源日志 → 历史复盘计数。

import { classifySignal } from "../lib/signal-triage.mjs";

// v2.17 根因分诊接线（纯函数）：对每条新信号（只对 warn/error；info 是采样取证，不分诊）
// 调用分类器，把 rootCause / rootCauseLabel / rootCauseAdvice 写到信号对象上。两个写入面：
//  - newSignals 里的对象与信号引擎 active 表共享引用（log-signals.mjs 的 fire()
//    存入 active 与返回的是同一对象），后续每轮 getActiveSignals() 的浅拷贝
//    都会自动带上分类字段——SSE lite.activeSignals 与 /api/status 的
//    layers.signals.active 两条数据通路零协议改动拿到分类；
//  - activeSignals 是本轮探针在回调之前生成的浅拷贝数组（log-tail-probe.mjs
//    先 getActiveSignals 再调 onSignals），须按 id 补写，让本轮探针结果
//    （state-store 的 lastKnownSignalsData 也存这份）当轮即可见。
// 注意：同规则在冷却窗口内被新行再次命中时，引擎会用不带分类字段的新 hit 覆盖
// active 条目且不回调本函数——红条根因行短暂消失（前端按可选字段处理），
// 冷却窗口过后重新上报即恢复；分类以信号日志条目为准绳，不追求 active 表恒有。
export function attachTriage(newSignals, activeSignals, snapshot, classify = classifySignal) {
  for (const sig of newSignals || []) {
    if (!sig || sig.severity === "info") continue;
    const triage = classify(sig, snapshot);
    if (!triage) continue;
    sig.rootCause = triage.rootCause;
    sig.rootCauseLabel = triage.label;
    sig.rootCauseAdvice = triage.advice;
    for (const active of activeSignals || []) {
      if (active && active.id === sig.id) {
        active.rootCause = triage.rootCause;
        active.rootCauseLabel = triage.label;
        active.rootCauseAdvice = triage.advice;
      }
    }
  }
  return newSignals;
}

// toolkit.registerProbes 的 onLogSignals 回调。
export function createLogSignalsHandler({ store, signalLogger, historyStore }) {
  return function onLogSignals(newSignals, activeSignals) {
    // v2.17 根因分诊：快照取信号发生当拍的 state-store（layers=通道/agent 层级、
    // agentsStatus=accountFault/loggedIn/expiry、health=全局），SOP 规则表见
    // lib/signal-triage.mjs。只在批内确有 warn/error 信号时才取快照
    // （getLegacyStatus 含 queryLogs，info 采样批不必付这份成本）。
    if ((newSignals || []).some((sig) => sig && sig.severity !== "info")) {
      // 同一份 layers 既喂给 getLegacyStatus 的 summary，也直接交给分诊快照——
      // 两处必须来自同一次快照，否则分诊看到的分层与 legacy 字段可能不同时刻。
      const layers = store.getLayers();
      const legacy = store.getLegacyStatus({ layers });
      attachTriage(newSignals, activeSignals, {
        layers,
        agentsStatus: legacy.agentsStatus,
        health: legacy.health,
      });
    }
    for (const sig of newSignals) {
      // info 级是采样取证信号（:30 抖动取证），按 info 落盘：summarizeLogs 的异常
      // 聚合只统计 error/warn，采样样本不得混入异常计数抬高告警噪音。
      const write = sig.severity === "error"
        ? signalLogger.error
        : (sig.severity === "info" ? signalLogger.info : signalLogger.warn);
      write(`[${sig.title}] ${sig.sample} —— ${sig.advice}`, {
        signalId: sig.id,
        category: sig.category,
        signalSource: sig.sourceId,
        // 分诊结果是可选结构化字段：info 采样与老日志没有这些键，
        // 消费方（前端红条/时间线）一律按缺省安全处理。
        ...(sig.rootCause ? {
          rootCause: sig.rootCause,
          rootCauseLabel: sig.rootCauseLabel,
          rootCauseAdvice: sig.rootCauseAdvice,
        } : {}),
      });
      // 历史复盘的"卡顿信号"计数来源：只记 warn/error（info 是采样取证样本，
      // 与 summarizeLogs 排除 info 的理由相同——不得抬高信号计数噪音）。
      if (sig.severity !== "info") {
        historyStore.record({
          type: "signal",
          severity: sig.severity,
          signalId: sig.id,
          category: sig.category,
          title: sig.title,
          // 按天复盘时可直接统计各根因占比；分诊前的老记录无此键。
          ...(sig.rootCause ? { rootCause: sig.rootCause } : {}),
        });
      }
    }
  };
}
