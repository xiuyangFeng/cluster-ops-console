// scripts/setup/proxy-credential.mjs —— 向导读本机的代理口令（v2.64），给第 4 步重写集群 env.sh 时用。
//
// 只读：口令文件的唯一写入方仍是监控服务（lib/egress/proxy-auth-store.mjs）。这里与监控服务用同一个存储模块、
// 同一套数据目录解析（server/runtime-env.mjs 的 resolveServerLocations：CODEX_MONITOR_DATA_DIR 等覆盖都认，
// 源码模式落在 work/runtime/），所以向导看到的口令与模式就是工作台此刻用的那一份。
//
// 返回的 credential 是口令原文：只交给 lib/cluster-env.mjs 渲染 env.sh / settings.json，经 ssh 的标准输入送到
// 集群——不进命令行、不打印、不写日志（给人看的地方一律经 maskProxyCredential 打码）。
import path from "node:path";

import { createProxyAuthStore } from "../../work/monitor/lib/egress/proxy-auth-store.mjs";
import { PROXY_AUTH_FILE } from "../../work/monitor/lib/proxy/auth.mjs";
import { resolveServerLocations } from "../../work/monitor/server/runtime-env.mjs";

export const PROXY_AUTH_MODE_LABELS = Object.freeze({ off: "关", observe: "只记录", enforce: "强制" });

// 监控服务的口令文件在哪（与 server/start.mjs 的 createProxyAuthStore 同一个路径）。
export function defaultProxyAuthPath(env = process.env) {
  return path.join(resolveServerLocations(env).runtimeDir, PROXY_AUTH_FILE);
}

// → { mode, credential, issue }
//   mode        "off" | "observe" | "enforce"（文件不在、坏了、读不出来都按关）
//   credential  { user, password } | null：存着的口令，模式是关时也给（「曾写到过集群」时要照带）
//   issue       null | { state: "invalid" | "unreadable", reason }：文件有问题（这时 credential 为 null）
export function readLocalProxyAuth({ env = process.env, filePath = defaultProxyAuthPath(env) } = {}) {
  const store = createProxyAuthStore({ filePath });
  const state = store.getPublicState();
  return { mode: state.mode, credential: store.getStoredCredential(), issue: state.issue };
}
