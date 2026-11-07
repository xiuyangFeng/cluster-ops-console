import { EventEmitter } from "node:events";

// 全局单例事件总线：探针内核各模块通过它解耦通信（探针更新 / 状态变化 / 日志追加）。
// 监听方可能较多（多路 SSE 连接 + 内部聚合器），提高上限避免 MaxListeners 告警。
export const bus = new EventEmitter();
bus.setMaxListeners(50);

// 事件名与 payload 契约（后续 Task 依赖，切勿改动字符串常量）。
export const EVENTS = {
  PROBE_UPDATED: "probeUpdated", // payload: { id, layer, result }
  STATUS_CHANGED: "statusChanged", // payload: { layers, lite }
  LOG_APPENDED: "logAppended", // payload: { ts, source, level, message, ...fields }
  // 配置变化让状态键集合换了一批（切换查看视角：channel / agent:* 换成新视角的含义、
  // tunnel:<id> 增减；删停服务器 / Agent：键消失）。这不算变迁、不发 STATUS_CHANGED，
  // 历史靠它另记一份全量级别基线。
  LEVELS_REBASED: "levelsRebased", // payload: { view, levels }
};
