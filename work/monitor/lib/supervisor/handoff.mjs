// supervisor 的两种退出：热更新交接退出（子进程全部留给下一任）与显式 shutdown（停掉
// 全部子进程/接管进程并清理登记）。两条路径都有时间预算，这里不许新增 await 环节：
//   - 交接：tickBudgetMs 4000 + flushBudgetMs 300 < monitor 侧 data-plane-upgrade 的 oldExitMs 5000；
//   - shutdown：子进程等待 1500 + 日志 200 < monitor stopProcess 对 supervisor 的 2s SIGKILL 死线。
import { tunnelRecordName } from "../../monitor-core.mjs";
import { flushAllLoggers } from "../logger.mjs";
import { waitForPidExit } from "../process-registry.mjs";

// ---------------------------------------------------------------------------
// 热更新：supervisor 交接退出（SIGUSR2 或信箱 handoff-exit）
// ---------------------------------------------------------------------------
// 与 shutdown 的根本区别：不杀任何子进程、不删隧道/代理的注册表记录，
// 只删自己的 supervisor 记录（且仅当它仍指向本进程），刷日志后 exit 0。
// 步骤：置 stopping（主循环不再起新一拍、信箱不再认领）→ 等进行中的一拍收尾（有界，
// 防止在 spawn 与登记之间退出留下无登记的 ssh）→ 释放密码 broker 等进程内资源 →
// 删自己的记录 → 刷日志 → exit(0)。
export async function performHandoffExit({
  trigger = "unknown",
  setStopping = () => {},
  waitForTick = async () => {},
  // 信箱在飞那一轮的收尾等待（见 createControlMailbox 的 whenIdle）。
  // 与 waitForTick 共用同一个 tickBudgetMs 预算，保证整个等待是有界的。
  waitForMailboxIdle = async () => {},
  // 4000 = killCurrentAndWait 最坏耗时（RESPAWN_WAIT_BUDGET_MS 2000 + ensurePidExited 的
  // SIGKILL 宽限 1000）+ 起新 ssh 并登记的余量。此前 2500 盖不住 SIGKILL 升级那条路，
  // 旧 ssh 扛住 SIGTERM 时仍会在"旧的已停、新的没起"之间 exit。上限须留在 monitor 侧
  // data-plane-upgrade 的 oldExitMs（5000）之内：4000 + flushBudgetMs 300 + 收尾 < 5000。
  tickBudgetMs = 4000,
  releaseResources = async () => {},
  removeOwnRecord = async () => {},
  flushLogs = async () => {},
  flushBudgetMs = 300,
  exit = (code) => process.exit(code),
  log: logImpl = () => {},
  sleep: sleepImpl = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  }),
} = {}) {
  setStopping();
  logImpl(`supervisor handoff requested (${trigger}); leaving tunnels and local proxy running for the next supervisor`, {
    event: "supervisor-handoff",
  });
  await Promise.race([
    Promise.resolve()
      .then(async () => {
        await Promise.resolve().then(waitForTick).catch(() => {});
        // 信箱里可能正跑着"单隧道受控重启"（停旧 ssh → 起新 ssh 的复合动作）。
        // 它不在 tick 的 promise 里，只等 waitForTick 就会在动作中途 exit(0)：
        // 结果是旧进程已停、新进程没起、注册表记录还在——下一任 supervisor 接手时
        // 看到一条"存在但已死"的记录，用户侧表现为隧道一直红着且没有任何操作日志。
        await Promise.resolve().then(waitForMailboxIdle).catch(() => {});
      })
      .catch(() => {}),
    sleepImpl(tickBudgetMs),
  ]);
  await Promise.resolve().then(releaseResources).catch(() => {});
  await Promise.resolve().then(removeOwnRecord).catch(() => {});
  logImpl("supervisor handoff complete, exiting 0", { event: "supervisor-handoff" });
  await Promise.race([Promise.resolve().then(flushLogs).catch(() => {}), sleepImpl(flushBudgetMs)]);
  exit(0);
}

// shutdown 时区分"本进程子进程"与"接管来的进程"（热更新 / supervisor 重启后接管）：
// 子进程直接 SIGTERM；接管来的没有 child 句柄，只能按注册表（命令行复核）停止——
// 这类记录不能被一刀切删掉，否则进程活着、登记没了，变成谁也停不掉的孤儿。
export function partitionShutdownRecords(plan, readMeta = () => null) {
  const childPids = new Set((plan.children || []).map((child) => child.pid));
  const adopted = [];
  const remove = [];
  for (const name of plan.recordNames || []) {
    if (name === "channel-supervisor") {
      remove.push(name);
      continue;
    }
    let meta = null;
    try {
      meta = readMeta(name);
    } catch {
      meta = null;
    }
    if (meta && Number.isInteger(meta.pid) && meta.pid > 0 && !childPids.has(meta.pid)) adopted.push(name);
    else remove.push(name);
  }
  return { adopted, remove };
}

// shutdown / crashGuard 要处理的全部对象。抽成纯函数便于单测"遍历了所有 controller"。
export function buildShutdownPlan(proxyController, controllers) {
  const children = [
    proxyController.getCurrentChild(),
    ...[...controllers.values()].map((entry) => entry.controller.getCurrentChild()),
  ].filter((child) => child && !child.killed && child.pid);
  return {
    children,
    recordNames: ["channel-supervisor", "local-proxy", ...[...controllers.keys()].map((id) => tunnelRecordName(id))],
  };
}

// 交接退出的一次性入口（SIGUSR2 与信箱 handoff-exit 共用）：重复触发只认第一次。
// state 是 supervisor 的共享状态对象（见 service.mjs），这里按字段现读现写，不做快照。
// waitForMailboxIdle 是闭包：信箱与本入口互相引用，调用时才解引用信箱。
export function createHandoffExitStarter({
  state,
  controllers,
  registry,
  waitForMailboxIdle = async () => {},
  removeRuntimeRecord = async () => {},
  log = () => {},
  flushLogs = flushAllLoggers,
  exit = (code) => process.exit(code),
  sleep,
  selfPid = process.pid,
} = {}) {
  return function startHandoffExit(trigger) {
    if (state.handoffExiting) return;
    state.handoffExiting = true;
    performHandoffExit({
      trigger,
      setStopping: () => {
        state.stopping = true;
      },
      waitForTick: () => state.currentTick,
      waitForMailboxIdle,
      releaseResources: async () => {
        await Promise.all([...controllers.values()].map((entry) => entry.controller.releaseForHandoff()));
      },
      removeOwnRecord: async () => {
        // 只删仍指向本进程的记录：monitor 可能已经为下一任写好了新记录。
        const meta = registry.readMeta("channel-supervisor");
        if (meta && meta.pid === selfPid) await removeRuntimeRecord("channel-supervisor");
      },
      flushLogs: () => flushLogs(),
      exit,
      sleep,
      log,
    }).catch((err) => {
      log(`supervisor handoff failed: ${err.message}`, { level: "error", event: "supervisor-handoff" });
      exit(0);
    });
  };
}

// 显式停止（SIGINT / SIGTERM）。交接退出进行中则忽略——那会杀掉要留给下一任的子进程。
export async function runShutdown({
  state,
  proxyController,
  controllers,
  registry,
  removeRuntimeRecord = async () => {},
  log = () => {},
  waitForPidExitImpl = waitForPidExit,
  killProcess = (pid, signal) => process.kill(pid, signal),
  flushLogs = flushAllLoggers,
  exit = (code) => process.exit(code),
} = {}) {
  if (state.handoffExiting) {
    log("SIGTERM ignored: supervisor handoff exit already in progress (children stay up for the next supervisor)");
    return;
  }
  state.stopping = true;
  log("supervisor stopping");
  // SIGTERM 后轮询确认子进程真正退出，超时 SIGKILL 兜底——
  // 固定 250ms 后硬退会把 proxy/tunnel 孤儿化（reparent 到 launchd）。
  // 预算 1500ms：必须小于 monitor-server stopProcess 对 supervisor 的 2s SIGKILL 死线，
  // 否则本进程会在清理完成前被强杀，残留陈旧的注册表记录。
  const plan = buildShutdownPlan(proxyController, controllers);
  const { children } = plan;
  // 接管来的隧道/代理（热更新交接后的常态）没有 child 句柄：按注册表停（命令行复核防
  // pid 复用），成功时 stopProcess 自己删记录；失败则保留记录交给 monitor 的 stopChannel。
  const { adopted, remove } = partitionShutdownRecords(plan, (name) => registry.readMeta(name));
  for (const child of children) child.kill("SIGTERM");
  const adoptedResults = new Map();
  await Promise.all([
    ...children.map(async (child) => {
      const exited = await waitForPidExitImpl(child.pid, 1500);
      if (!exited) {
        log(`child pid ${child.pid} did not exit in 1.5s, sending SIGKILL`);
        try {
          killProcess(child.pid, "SIGKILL");
        } catch {}
      }
    }),
    ...adopted.map(async (name) => {
      const result = await registry.stopProcess(name, { forceAfterMs: 1000 }).catch((err) => ({ stopped: false, reason: err.message }));
      adoptedResults.set(name, result);
      log(`stop adopted ${name}: ${result.reason}`);
    }),
  ]);
  await Promise.all(remove.map((name) => removeRuntimeRecord(name)));
  // Stay inside the parent's 2s stop budget: child exit waits consume at most
  // 1.5s above, leaving a bounded window for the asynchronous log tail.
  let logDeadline;
  try {
    await Promise.race([flushLogs(), new Promise((resolve) => { logDeadline = setTimeout(resolve, 200); })]);
  } finally { clearTimeout(logDeadline); }
  exit(0);
}
