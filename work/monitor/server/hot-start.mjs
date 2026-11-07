// 启动（热接管）：listen 成功后决定是接管后台数据面、只补 supervisor，还是清场重启，
// 然后启动探针调度。fixture 模式（热更新冒烟 / 界面测试）绝不碰进程、也不启动调度器。

// 启动（热接管）决策，纯函数：
//   "preserve" supervisor 与本地代理都在 → 原样接管；
//   "adopt"    supervisor 不在，但本地代理或任一隧道还活着 → 只拉起 supervisor 让它认领存活的
//              代理/隧道，绝不 stopChannel（supervisor 崩溃后重启界面、或数据面升级途中控制面被
//              重启，都属此类——旧实现在这里清场，把仍在服务的隧道全部杀掉）；
//   "clean"    其余（什么都没有 / 只剩 supervisor 而代理缺失）→ 沿用清场后重新拉起。
export function decideHotStart(processes = {}) {
  const supervisorUp = (processes.supervisor?.length || 0) > 0;
  const proxyUp = (processes.localProxy?.length || 0) > 0;
  if (supervisorUp && proxyUp) return "preserve";
  if (supervisorUp) return "clean";
  const tunnelUp = (processes.reverseTunnel?.length || 0) > 0
    || Object.values(processes.tunnelsByServer || {}).some((list) => Array.isArray(list) && list.length > 0);
  return proxyUp || tunnelUp ? "adopt" : "clean";
}

// listen 回调体。决策失败只记日志，调度器照常启动（探针自己会把故障报出来）。
export async function runHotStart({ fixtureMode, toolkit, channel, store, scheduler, appendLog }) {
  if (fixtureMode) {
    channel.setShouldBeRunning(false);
    store.setShouldBeRunning(false);
    appendLog("fixture mode ready: process mutation and live probes disabled");
    return;
  }
  try {
    const processes = await toolkit.getProcesses();
    // 接管只依赖本项目管理面是否完整；视图活跃节点可能只监控，某一隧道
    // 缺失也由现有 supervisor 按目标恢复，不能因此停止其它健康隧道。
    const decision = decideHotStart(processes);
    if (decision === "preserve") {
      appendLog("server started, detected background supervisor and proxy. Preserving existing channels (hot start).");
      channel.setShouldBeRunning(true);
    } else if (decision === "adopt") {
      appendLog("server started, proxy/tunnels alive but no supervisor. Spawning supervisor to adopt them (no clean start).", { level: "warn", event: "supervisor-repair" });
      channel.setShouldBeRunning(true);
      // 与守护巡检同一条路径：已有 supervisor（例如 0ms 巡检刚拉起）就不重复 spawn。
      await channel.autoRepairChannel({ force: true });
    } else {
      appendLog("server started, no complete background tunnel detected. Performing clean start.");
      await channel.stopChannel();
      channel.setShouldBeRunning(true);
    }
    store.setShouldBeRunning(channel.getShouldBeRunning());
  } catch (err) {
    appendLog(`initial setup failed: ${err.message}`);
  }
  scheduler.start();
  scheduler.tick(); // 立即执行首轮探测
}
