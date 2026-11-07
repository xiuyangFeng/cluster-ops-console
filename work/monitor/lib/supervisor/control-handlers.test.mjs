// 控制信箱的动作路由（特征化测试：结果形状与 reason 文案是 monitor 侧 operations-runner 的契约）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_ACTION_HANDOFF_EXIT,
  CONTROL_ACTION_PROXY_HANDOFF,
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_ACTION_TAKEOVER_TUNNEL,
  handoffExitSignature,
  proxyHandoffSignature,
} from "../supervisor-control.mjs";
import { createControlHandlers } from "./control-handlers.mjs";
import { buildTunnelSignature } from "./tunnel-spec.mjs";

const cfg = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };

function scene({ effectiveProxyPort = 8888 } = {}) {
  const calls = [];
  const timers = [];
  const probes = [];
  const state = { effectiveProxyPort };
  const restartResult = { status: "succeeded", phase: "verified", reason: "", evidence: { pid: 7001 } };
  const controllers = new Map([
    ["server-01", {
      config: cfg,
      controller: {
        restartControlled: async (config) => {
          calls.push(["restart", config]);
          return restartResult;
        },
      },
    }],
  ]);
  const proxyRelease = {
    requestRelease: async () => {},
    clearRelease: async () => {},
    recordDraining: async () => {},
    clearDraining: async () => {},
  };
  const handoffResult = { status: "succeeded", phase: "verified", reason: "", evidence: {} };
  const proxyController = {
    handoff: async (config, options) => {
      calls.push(["proxy-handoff", config, options]);
      return handoffResult;
    },
  };
  const handlers = createControlHandlers({
    state,
    controllers,
    proxyController,
    instanceId: "abcd1234",
    startHandoffExit: (trigger) => calls.push(["handoff-exit", trigger]),
    proxyRelease,
    probe: async (...args) => {
      probes.push(args);
      return { ok: true };
    },
    selfPid: 4321,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { handlers, calls, timers, probes, state, proxyRelease, restartResult, handoffResult };
}

const request = (action, fields) => ({ request: { action, ...fields } });

test("控制信箱路由：只处理四种动作", () => {
  const { handlers } = scene();
  assert.deepEqual(Object.keys(handlers).sort(), [
    CONTROL_ACTION_HANDOFF_EXIT,
    CONTROL_ACTION_PROXY_HANDOFF,
    CONTROL_ACTION_RESTART_TUNNEL,
    CONTROL_ACTION_TAKEOVER_TUNNEL,
  ].sort());
});

test("restart-tunnel：未知服务器 / 签名变化 → queued 失败且不动隧道；签名一致 → 受控重启该 controller", async () => {
  const s = scene();
  const restart = s.handlers[CONTROL_ACTION_RESTART_TUNNEL];
  assert.deepEqual(await restart(request(CONTROL_ACTION_RESTART_TUNNEL, { serverId: "nope", targetSignature: "x" })), {
    status: "failed", phase: "queued", reason: "no managed tunnel for nope", evidence: {},
  });
  assert.deepEqual(await restart(request(CONTROL_ACTION_RESTART_TUNNEL, { serverId: "server-01", targetSignature: "-R stale" })), {
    status: "failed", phase: "queued", reason: "target signature changed since preview", evidence: {},
  });
  assert.deepEqual(s.calls, [], "前两种都不得触碰隧道");
  const result = await restart(request(CONTROL_ACTION_RESTART_TUNNEL, { serverId: "server-01", targetSignature: buildTunnelSignature(cfg) }));
  assert.equal(result, s.restartResult, "结果原样透传");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][1], cfg, "用 controller 当前登记的配置重启");
});

test("handoff-exit：只认本实例签名；受理后 50ms 才开始退出（先让信箱写出结果）", async () => {
  const s = scene();
  const handoff = s.handlers[CONTROL_ACTION_HANDOFF_EXIT];
  assert.deepEqual(await handoff(request(CONTROL_ACTION_HANDOFF_EXIT, { targetSignature: handoffExitSignature("other000") })), {
    status: "failed", phase: "queued", reason: "handoff request targets another supervisor instance", evidence: {},
  });
  assert.deepEqual(s.timers, []);
  const accepted = await handoff(request(CONTROL_ACTION_HANDOFF_EXIT, { targetSignature: handoffExitSignature("abcd1234") }));
  assert.deepEqual(accepted, { status: "succeeded", phase: "accepted", reason: "", evidence: { pid: 4321 } });
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, 50);
  assert.deepEqual(s.calls, [], "返回前不得开始退出");
  s.timers[0].fn();
  assert.deepEqual(s.calls, [["handoff-exit", "mailbox"]]);
});

test("proxy-handoff：端口未钉死 / 端口已变 → queued 失败；钉死端口按请求时的状态现读", async () => {
  const s = scene({ effectiveProxyPort: null });
  const proxyHandoff = s.handlers[CONTROL_ACTION_PROXY_HANDOFF];
  assert.deepEqual(await proxyHandoff(request(CONTROL_ACTION_PROXY_HANDOFF, { targetSignature: proxyHandoffSignature(8888) })), {
    status: "failed", phase: "queued", reason: "supervisor has not pinned its proxy port yet", evidence: {},
  });
  s.state.effectiveProxyPort = 8888; // 首拍之后才钉死：处理器必须看到新值
  assert.deepEqual(await proxyHandoff(request(CONTROL_ACTION_PROXY_HANDOFF, { targetSignature: proxyHandoffSignature(8890) })), {
    status: "failed", phase: "queued", reason: "proxy port changed since request", evidence: {},
  });
  assert.deepEqual(s.calls, []);
  const result = await proxyHandoff(request(CONTROL_ACTION_PROXY_HANDOFF, { targetSignature: proxyHandoffSignature(8888) }));
  assert.equal(result, s.handoffResult);
  const [, config, options] = s.calls[0];
  assert.deepEqual(config, { localPort: 8888 });
  assert.equal(options.requestRelease, s.proxyRelease.requestRelease);
  assert.equal(options.clearRelease, s.proxyRelease.clearRelease);
  assert.equal(options.recordDraining, s.proxyRelease.recordDraining);
  assert.equal(options.clearDraining, s.proxyRelease.clearDraining);
  await options.probe(8888);
  assert.deepEqual(s.probes, [[8888]], "探活用注入的 probe");
});
