// supervisor 日志策略：消息级别推断、代理输出分级、ssh stderr 噪声过滤，以及 supervisor
// 自己的 log() 实现（stdout 一行 + 结构化日志一条）。

export function inferSupervisorLogLevel(message, fields = {}) {
  if (fields.level === "error" || fields.level === "warn" || fields.level === "info") return fields.level;
  const m = String(message || "");
  if (/\[FATAL|spawn error|Permission denied|exited code=[1-9]|connect-fail /i.test(m)) return "error";
  if (/failed quickly|next retry|not verified|connect-deny |backoff|Hot-reloading/i.test(m)) return "warn";
  return "info";
}

export function classifyProxyLogLine(text) {
  const s = String(text || "").trim();
  if (!s) return { persist: false, level: "info" };
  if (/connect-fail |\[FATAL/i.test(s)) {
    return { persist: true, level: "error", nextAction: "检查上游目标是否可达，以及本地代理白名单" };
  }
  if (/connect-deny /i.test(s)) {
    return { persist: true, level: "warn", nextAction: "确认 proxyAllowedTargets 含该 host:port，更新配置后重启本地代理" };
  }
  if (/\bconnect host=/i.test(s)) {
    return { persist: false, level: "info" };
  }
  return { persist: true, level: "info" };
}

export function isSshStderrNoise(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  return /^debug\d:/i.test(s);
}

// stdout 仅供手工前台运行时查看：monitor 以 stdio:"ignore" 启动 supervisor，不再有
// nohup 重定向（旧注释提到的 work/channel-supervisor.log 在打包模式下会落进 .app 包内，
// 已废弃）。持久日志只写结构化日志 <dataRoot>/runtime/logs/supervisor.ndjson，
// 失败不影响保活循环。
// getFileLogger / getChannelId 都是 getter：结构化日志只在真正作为 supervisor 进程运行时
// 才创建（被 import 时不落盘），活跃服务器随配置变化，均在每次写日志时现读。
export function createSupervisorLog({ getFileLogger = () => null, getChannelId = () => null } = {}) {
  return function log(message, fields) {
    const { level: requestedLevel, ...rest } = fields || {};
    const level = inferSupervisorLogLevel(message, { level: requestedLevel });
    const currentServerId = getChannelId();
    const correlated = {
      ...(currentServerId ? { channelId: currentServerId } : {}),
      ...rest,
    };
    const extra = correlated.nextAction ? ` nextAction=${correlated.nextAction}` : "";
    console.log(`${new Date().toISOString()} ${message}${extra}`);
    try {
      const fileLogger = getFileLogger();
      if (fileLogger && typeof fileLogger[level] === "function") fileLogger[level](message, correlated);
      else if (fileLogger) fileLogger.info(message, correlated);
    } catch {
      // 忽略：日志写入绝不允许中断 supervisor
    }
  };
}
