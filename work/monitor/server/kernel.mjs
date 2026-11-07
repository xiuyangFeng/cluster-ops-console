// 内核基础件：ops / timeline / signal 三个日志器、操作上下文、历史与指标存储、进程注册表。
// 只负责构造（metrics 启动时 load 一次），不注册任何事件监听——监听器由 telemetry.mjs 等
// 按装配顺序挂上，事件分发顺序只取决于 start.mjs 里的调用次序。

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { createHistoryStore } from "../lib/history-store.mjs";
import { createLogger } from "../lib/logger.mjs";
import { createMetricsStore } from "../lib/metrics-store.mjs";
import { createProcessRegistry } from "../lib/process-registry.mjs";

export function createKernel({ runtimeDir }) {
  const logsDir = path.join(runtimeDir, "logs");
  const opsLogger = createLogger("ops", { dir: logsDir, defaultFields: { sessionId: randomBytes(4).toString("hex") } });
  const operationStorage = new AsyncLocalStorage();

  // ops 日志唯一入口：显式 fields 优先，否则继承当前请求的操作上下文（operationId 等）。
  // level 只认 error/warn，其余一律 info；日志失败绝不外抛。
  function appendLog(message, fields) {
    try {
      const merged = { ...(fields || operationStorage.getStore() || {}) };
      const level = merged.level === "error" || merged.level === "warn" ? merged.level : "info";
      delete merged.level;
      opsLogger[level](message, merged);
    } catch {}
  }

  // 状态时间线：STATUS_CHANGED 的逐 key 变迁落盘为 timeline.ndjson（与其它 logger 同目录/同轮转），
  // 供人工排查；/api/timeline 只出内存 ring（YAGNI 不做文件回读）。
  const timelineLogger = createLogger("timeline", { dir: logsDir });
  // 自动修复 / 远端动作 / 单隧道操作共用的时间线写入口（此前三处各有一份相同闭包）。
  function writeTimeline(level, message, fields) {
    try {
      (level === "warn" ? timelineLogger.warn : timelineLogger.info)(message, fields);
    } catch {}
  }

  // v2.16：历史持久化（按天复盘）。timeline.ndjson 受 2MB 轮转限制只够"最近"排查，
  // 回答"昨晚断了几次、每次多久恢复"需要按天分文件、30 天保留的独立存储。
  const historyStore = createHistoryStore({ dir: path.join(runtimeDir, "history") });

  // v2.10：卡顿反馈信号日志——log-signals 探针的新信号落地为 signal 源日志，
  // 经 LOG_APPENDED 自动进入 /api/logs 与 SSE，前端时间线零协议改动。
  const signalLogger = createLogger("signal", { dir: logsDir });

  // metrics.json 解析不了时先留档再按空表重来，并记一条 ops 警告（lib/corrupt-archive.mjs）。
  const metricsStore = createMetricsStore({ filePath: path.join(runtimeDir, "metrics.json"), log: appendLog });
  metricsStore.load();

  const registry = createProcessRegistry({
    runtimeDir,
    // 死进程 pid.json 的 GC（maintenanceSweep 约 60s 一次调 listRuntimeProcesses）
    // 此前静默 unlink，生产上无法追溯"记录是谁删的、为什么删"。这里落一条 ops 日志：
    // reason 里带"进程不存在/命令行不匹配(pid 复用)"的具体判死原因。
    onReclaim: ({ name, pid, reason }) => {
      appendLog(`registry GC: reclaimed stale pid record ${name} (pid=${pid}, ${reason})`);
    },
  });

  return {
    logsDir,
    operationStorage,
    appendLog,
    timelineLogger,
    writeTimeline,
    historyStore,
    signalLogger,
    metricsStore,
    registry,
  };
}
