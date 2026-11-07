// 本地 CONNECT 代理 ↔ channel-supervisor 的进程间约定（环境变量 / 控制文件路径 / stdout 标记 /
// 注册表记录名 / /proxy-health 身份头）。两者是独立进程，只靠这些字面量对齐——放在同一个
// 叶子模块里（只依赖 node:path），两侧 import 同一份，就不会一边改了另一边没跟上。
// 注意：它同时落在两个组件的热更新指纹闭包里，改这里会让 supervisor 与 proxy 都走平滑交接，
// 这正是约定变更应有的效果。
import path from "node:path";

// 新代理以 CODEX_PROXY_HANDOFF=1 启动即进入交接模式（端口被占时重试 bind，而不是 exit 2）。
export const PROXY_HANDOFF_ENV = "CODEX_PROXY_HANDOFF";

// 与 channel-supervisor 的 proxyReleaseRequestPath 同一约定（测试交叉校验）。
export function proxyReleaseRequestPath(runtimeDir, pid) {
  return path.join(runtimeDir, "proxy-control", `release-${Number(pid)}`);
}
// 新代理第一次撞上 EADDRINUSE 时打印这一行；supervisor 看到它才去通知旧代理释放监听。
export const HANDOFF_WAITING_MARKER = "[handoff] waiting for port";

// 交接后排空中的旧代理在注册表里的名字（supervisor 在发出释放请求前登记，pid + 命令行复核）。
// 显式"退出并停止后台"按这个名字停它；它自己排空退出时删掉指向自己的那条记录。
export const DRAINING_PROXY_RECORD_NAME = "local-proxy-draining";

// /proxy-health 身份头。只有真正装上了释放监听（控制文件轮询）的代理才声明 handoff——
// supervisor 只通过控制文件发释放请求，没装监听却声明能力会让交接等到超时再回退。
export function buildProxyHealthHeaders({ pid = process.pid, component = "", handoff = false } = {}) {
  return {
    "x-codex-proxy-pid": String(pid),
    "x-codex-proxy-component": component,
    ...(handoff ? { "x-codex-proxy-handoff": "1" } : {}),
  };
}

// /proxy-health 的身份头（新版代理才有）：pid / 组件指纹 / 是否支持平滑交接。
// 旧代理没有这些头 → pid:null、component:""、handoff:false（未知按保守处理）。
export function parseProxyHealthHeaders(headers = {}) {
  const pid = Number(headers["x-codex-proxy-pid"]);
  const component = String(headers["x-codex-proxy-component"] || "");
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    component: /^[0-9a-f]{1,64}$/.test(component) ? component : "",
    handoff: headers["x-codex-proxy-handoff"] === "1",
  };
}
