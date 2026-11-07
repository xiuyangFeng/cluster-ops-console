// T04b 控制信箱的动作处理器：monitor 经 runtime/control/<instanceId>/ 请求单隧道重启、
// supervisor 交接退出、本地代理平滑交接。
// supervisor 自行校验目标签名与 controller 归属；未知归属 / foreign 状态不通过
// 该动作杀任何远端进程（只会返回 failed，保持既有保护与退避）。
import {
  CONTROL_ACTION_HANDOFF_EXIT,
  CONTROL_ACTION_PROXY_HANDOFF,
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_ACTION_TAKEOVER_TUNNEL,
  handoffExitSignature,
  proxyHandoffSignature,
} from "../supervisor-control.mjs";
import { probeProxyHealth } from "./proxy-health.mjs";
import { buildTunnelSignature } from "./tunnel-spec.mjs";

// state：supervisor 共享状态（首拍钉死的 effectiveProxyPort 在处理请求时现读）；controllers：
// Map<serverId, { config, controller }>；proxyRelease：代理交接的四个落盘动作（见 runtime-io），
// 键名即 proxyController.handoff 的选项名。
export function createControlHandlers({
  state,
  controllers,
  proxyController,
  instanceId,
  startHandoffExit,
  proxyRelease,
  probe = probeProxyHealth,
  selfPid = process.pid,
  setTimer = setTimeout,
} = {}) {
  return {
    [CONTROL_ACTION_RESTART_TUNNEL]: async ({ request }) => {
      const entry = controllers.get(request.serverId);
      if (!entry) {
        return { status: "failed", phase: "queued", reason: `no managed tunnel for ${request.serverId}`, evidence: {} };
      }
      const config = entry.config;
      const signature = buildTunnelSignature(config);
      if (signature !== request.targetSignature) {
        return { status: "failed", phase: "queued", reason: "target signature changed since preview", evidence: {} };
      }
      return entry.controller.restartControlled(config);
    },
    // 「让这台承载」：与单隧道重启同一套签名校验，之后交给控制器（只结束本账号另一台 Mac 的同端口会话）。
    [CONTROL_ACTION_TAKEOVER_TUNNEL]: async ({ request }) => {
      const entry = controllers.get(request.serverId);
      if (!entry) {
        return { status: "failed", phase: "queued", reason: `no managed tunnel for ${request.serverId}`, evidence: {} };
      }
      const config = entry.config;
      if (buildTunnelSignature(config) !== request.targetSignature) {
        return { status: "failed", phase: "queued", reason: "target signature changed since preview", evidence: {} };
      }
      if (typeof entry.controller.takeOverControlled !== "function") {
        return { status: "failed", phase: "queued", reason: "tunnel controller does not support takeover", evidence: {} };
      }
      return entry.controller.takeOverControlled(config);
    },
    [CONTROL_ACTION_HANDOFF_EXIT]: async ({ request }) => {
      if (request.targetSignature !== handoffExitSignature(instanceId)) {
        return { status: "failed", phase: "queued", reason: "handoff request targets another supervisor instance", evidence: {} };
      }
      // 先让信箱把结果写出去，再开始退出流程（退出本身不依赖结果文件）。
      setTimer(() => startHandoffExit("mailbox"), 50);
      return { status: "succeeded", phase: "accepted", reason: "", evidence: { pid: selfPid } };
    },
    [CONTROL_ACTION_PROXY_HANDOFF]: async ({ request }) => {
      if (!Number.isInteger(state.effectiveProxyPort)) {
        return { status: "failed", phase: "queued", reason: "supervisor has not pinned its proxy port yet", evidence: {} };
      }
      if (request.targetSignature !== proxyHandoffSignature(state.effectiveProxyPort)) {
        return { status: "failed", phase: "queued", reason: "proxy port changed since request", evidence: {} };
      }
      return proxyController.handoff({ localPort: state.effectiveProxyPort }, { probe, ...proxyRelease });
    },
  };
}
