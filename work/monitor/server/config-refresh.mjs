// 配置热载的唯一入口（磁盘 mtime 侦测与 /api/config/* 写路径都经这里）。
// 通道 ↔ 配置内核桥 ↔ 事件同步三者互为依赖：本函数先于后两者创建，只在调用时经
// start.mjs 的 late 槽位取用它们。

import { normalizeAutoRepairConfig } from "../lib/auto-repair-policy.mjs";

// 在内核桥（lib/config-hot-reload.mjs）之外补三步：
//  1) policy.setConfig，让 autoRepair 的总开关 / observeOnly / 单规则开关改完即生效，不必重启
//     进程。setConfig 只换配置不重置限频——切 observeOnly 不能成为绕过预算的手段；
//  2) 同步事件存储的服务器生命周期（删除/禁用的服务器关闭其事件）；
//  3) 把新配置交给集群侧配置同步（lib/cluster-env-sync.mjs）：某台服务器的反向端口变了，就在后台把
//     集群上的 env.sh 改到新端口。只登记 + 触发，不等它跑完——热载不能被一次 SSH 拖住。
//  4) 探针退避（server/probe-backoff.mjs）：开关改完即生效，退避中的服务器从头再探。
//  5) 服务直达（lib/daemons/service.mjs）：「远端守护进程」模块被关、服务器被删 / 停用 / 改了连接方式时，
//     收回它名下还开着的转发（只结束工作台自己起的那几条 ssh -L）。
export function createConfigRefresher({ late, autoRepairPolicy, probeBackoff = null }) {
  return async function refreshConfigIntoKernel() {
    const parsed = await late.configKernel.refreshConfigIntoKernel();
    try {
      autoRepairPolicy.setConfig(normalizeAutoRepairConfig(parsed?.autoRepair));
    } catch {}
    await late.incidentSync.syncServerLifecycle();
    try {
      late.clusterEnvSync?.onConfigRefreshed(parsed);
    } catch {}
    try {
      probeBackoff?.onConfigRefreshed(parsed);
    } catch {}
    try {
      late.daemons?.onConfigRefreshed?.(parsed);
    } catch {}
    return parsed;
  };
}
