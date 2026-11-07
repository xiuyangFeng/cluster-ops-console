// 自动修复执行器（v2.64）：只修坏的那条、执行前再看一眼、放弃不占预算、时间线写人话。
// 用真策略表 + 假通道 / 假单隧道执行器驱动，不起进程、不碰 runtime。
import assert from "node:assert/strict";
import test from "node:test";

import { createAutoRepairPolicy } from "../lib/auto-repair-policy.mjs";
import { AUTO_CHANNEL_RESTART_NOTE, createAutoRepairRunner, freshenChannelTriage } from "./auto-repair-runner.mjs";

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 默认：主集群隧道断开 60 秒、阿里云隧道正常、本机进程都在——策略会产出 restart-tunnel(server-01)。
function harness({ view: patch = {}, tunnelError = null, restartResult = { ok: true } } = {}) {
  let clock = 1_800_000_000_000;
  const events = [];
  const forced = [];
  const logs = [];
  const timeline = [];
  const view = {
    shouldBeRunning: true,
    repairInFlight: false,
    activeServerId: "server-01",
    triage: { rootCause: "channel", since: clock - 60_000 },
    processes: { supervisorUp: true, localProxyUp: true },
    tunnels: [{ serverId: "server-01", level: "error" }, { serverId: "server-aliyun", level: "ok" }],
    wakeGapMs: 0,
    ...patch,
  };
  let onRefresh = () => {};
  const policy = createAutoRepairPolicy({
    now: () => clock,
    log: (fields) => logs.push({ message: `auto-repair: ${fields.ruleId} ${fields.kind}（${fields.mode}）`, ...fields }),
  });
  const runner = createAutoRepairRunner({
    policy,
    scheduler: {
      forceRun: async (id, options) => {
        forced.push({ id, ...(options || {}) });
        return {};
      },
    },
    channel: {
      restartChannel: async (options) => {
        events.push(["restart-channel", options.context.operationId]);
        return restartResult;
      },
    },
    restartTunnel: async (input) => {
      events.push(["restart-tunnel", input.serverId, input.operationId]);
      if (tunnelError) throw tunnelError;
      return { state: "queued" };
    },
    refreshBeforeExecute: async () => {
      events.push(["refresh"]);
      onRefresh();
    },
    describeServer: (id) => ({ "server-01": "主集群服务器 (myserver)", "server-aliyun": "阿里云" })[id] || id,
    noteChannelStop: (note) => events.push(["note", note]),
    buildView: () => ({ ...view, now: clock }),
    appendLog: (message, fields) => logs.push({ message, ...(fields || {}) }),
    timeline: (level, message, fields) => timeline.push({ level, message, ...(fields || {}) }),
    randomUUID: (() => {
      let n = 0;
      return () => `op-${++n}`;
    })(),
  });
  return {
    runner,
    policy,
    view,
    events,
    forced,
    logs,
    timeline,
    advance: (ms) => {
      clock += ms;
      if (view.triage) view.triage.since = clock - 60_000;
    },
    onRefresh: (fn) => {
      onRefresh = fn;
    },
  };
}

test("一条隧道坏、另一条好：只重启坏的那条（单隧道通路），不碰整个通道；时间线写「自动修复：重启 X 隧道」", async () => {
  const h = harness();
  await h.runner.evaluate();
  assert.deepEqual(h.events, [["refresh"], ["restart-tunnel", "server-01", "op-1"]], "先复核再执行，且只重启 server-01");
  const entry = h.timeline.at(-1);
  assert.equal(entry.message, "自动修复：重启 主集群服务器 (myserver) 隧道");
  assert.equal(entry.kind, "restart-tunnel");
  assert.equal(entry.serverId, "server-01");
  assert.equal(entry.trigger, "auto");
  assert.equal(entry.ok, true);
  assert.equal(entry.operationId, "op-1");
  const decision = h.logs.find((l) => l.kind === "restart-tunnel" && l.mode === "execute");
  assert.equal(decision.serverId, "server-01", "决策日志写明要重启哪一条");
  assert.match(decision.reason, /只重启 server-01 的隧道/);
});

test("多条都坏：重启整个通道，期间停止原因写成自动修复，结束清掉", async () => {
  const h = harness({ view: { tunnels: [{ serverId: "server-01", level: "error" }, { serverId: "server-aliyun", level: "error" }] } });
  await h.runner.evaluate();
  assert.deepEqual(h.events, [["refresh"], ["note", AUTO_CHANNEL_RESTART_NOTE], ["restart-channel", "op-1"], ["note", null]]);
  assert.equal(h.timeline.at(-1).message, "自动修复：重启整个通道");
  assert.equal(h.timeline.at(-1).kind, "restart-channel");
});

test("执行前复核：刷新后通道已恢复 → 放弃执行，记 ops「skipped: recovered」，不进时间线", async () => {
  const h = harness();
  h.onRefresh(() => {
    h.view.triage = null; // 刷新进程探针后通道层已离开 error，视图不再给 channel 分诊
  });
  await h.runner.evaluate();
  assert.deepEqual(h.events, [["refresh"]], "没有任何重启");
  const skip = h.logs.find((l) => l.skipped === "recovered");
  assert.ok(skip, JSON.stringify(h.logs));
  assert.match(skip.message, /^auto-repair: channel-down-restart skipped: recovered/);
  assert.match(skip.message, /不计入窗口上限/);
  assert.equal(skip.trigger, "auto");
  assert.equal(skip.event, "auto-repair");
  assert.deepEqual(h.timeline, []);
  assert.equal(h.policy.getState().lastActions.at(-1).skipped, "recovered");
});

test("复核放弃的不计入窗口上限，也不留冷却：之后仍可再执行两次才升级人工", async () => {
  const h = harness();
  let recovered = true;
  h.onRefresh(() => {
    if (recovered) h.view.triage = null;
  });
  for (let i = 0; i < 2; i += 1) {
    h.view.triage = { rootCause: "channel", since: 0 };
    h.advance(0); // 决策时仍是"断开 60 秒"，复核时才发现已恢复
    await h.runner.evaluate();
  }
  assert.equal(h.events.filter((e) => e[0] === "refresh").length, 2, "紧挨着的两拍都做出了决策：冷却已退回");
  assert.equal(h.logs.filter((l) => l.skipped === "recovered").length, 2);
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 0);

  recovered = false;
  h.view.triage = { rootCause: "channel", since: 0 };
  h.advance(0);
  await h.runner.evaluate(); // 紧接着就能执行：冷却已退回
  h.advance(61_000);
  await h.runner.evaluate();
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 2, "两次放弃没占用 10 分钟 2 次的预算");
  assert.equal(h.runner.isExhausted(), false);
  h.advance(61_000);
  await h.runner.evaluate();
  assert.equal(h.runner.isExhausted(), true, "真执行满两次后照常升级人工");
});

test("复核时要重启的那条已经好了（别的还坏）→ 同样放弃", async () => {
  const h = harness();
  h.onRefresh(() => {
    h.view.tunnels = [{ serverId: "server-01", level: "ok" }, { serverId: "server-aliyun", level: "ok" }];
  });
  await h.runner.evaluate();
  assert.deepEqual(h.events, [["refresh"]]);
  assert.ok(h.logs.some((l) => l.skipped === "recovered"));
});

test("复核时别的修复已在进行（用户手动重启）→ 放弃（busy），不打架", async () => {
  const h = harness();
  h.onRefresh(() => {
    h.view.repairInFlight = true;
  });
  await h.runner.evaluate();
  assert.deepEqual(h.events, [["refresh"]]);
  assert.ok(h.logs.some((l) => l.skipped === "busy"));
});

test("单隧道操作被拒 409（已有单隧道操作在执行）→ 放弃并退回预算", async () => {
  const h = harness({ tunnelError: statusError(409, "已有单隧道操作在执行") });
  await h.runner.evaluate();
  assert.ok(h.logs.some((l) => l.skipped === "busy"));
  assert.deepEqual(h.timeline, []);
  await h.runner.evaluate();
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 2, "没留冷却，下一拍还能再试");
});

test("单隧道操作不可用 503（supervisor 快照不可用）→ 改为重启整个通道，时间线注明", async () => {
  const h = harness({ tunnelError: statusError(503, "supervisor 运行快照不可用") });
  await h.runner.evaluate();
  assert.deepEqual(h.events.slice(1), [
    ["restart-tunnel", "server-01", "op-1"],
    ["note", AUTO_CHANNEL_RESTART_NOTE],
    ["restart-channel", "op-1"],
    ["note", null],
  ]);
  const entry = h.timeline.at(-1);
  assert.equal(entry.message, "自动修复：重启整个通道（单隧道重启暂不可用）");
  assert.equal(entry.kind, "restart-channel");
  assert.equal(entry.fallbackFrom, "restart-tunnel");
  assert.ok(h.logs.some((l) => l.level === "warn" && /改为重启整个通道/.test(l.message)));
});

test("单隧道操作其它失败 → 记失败（warn 日志 + 时间线），不连带重启通道", async () => {
  const h = harness({ tunnelError: statusError(404, "未知或已禁用的服务器") });
  await h.runner.evaluate();
  assert.equal(h.events.filter((e) => e[0] === "restart-channel").length, 0);
  assert.ok(h.logs.some((l) => l.level === "warn" && /restart failed: 未知或已禁用的服务器/.test(l.message)));
  assert.equal(h.timeline.at(-1).message, "自动修复：重启 主集群服务器 (myserver) 隧道（失败）");
  assert.equal(h.policy.getState().lastActions.at(-1).ok, false);
});

test("派发期间的并发评估静默，不消耗预算", async () => {
  const h = harness();
  const nested = [];
  h.onRefresh(() => {
    // 刷新探针会引发 STATUS_CHANGED → 再评估；此刻它必须什么都不做。
    nested.push(h.runner.evaluate());
  });
  await h.runner.evaluate();
  assert.deepEqual(await Promise.all(nested), [[]]);
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 1);
});

test("observeOnly：复核与执行都不发生", async () => {
  const h = harness();
  h.policy.setConfig({ observeOnly: true });
  await h.runner.evaluate();
  assert.deepEqual(h.events, []);
});

test("freshenChannelTriage：通道不在 error → 不给 channel 分诊；在 error → 起点取较晚者；其它根因原样", () => {
  const triage = { rootCause: "channel", since: 100 };
  assert.equal(freshenChannelTriage(triage, { level: "ok", detail: { downSinceMs: null } }), null);
  assert.equal(freshenChannelTriage(triage, { level: "skipped", detail: {} }), null);
  assert.equal(freshenChannelTriage(triage, { level: "error", detail: {} }), null, "没有断开起点按证据不足");
  assert.deepEqual(freshenChannelTriage(triage, { level: "error", detail: { downSinceMs: 250 } }), { rootCause: "channel", since: 250 });
  assert.deepEqual(freshenChannelTriage(triage, { level: "error", detail: { downSinceMs: 50 } }), { rootCause: "channel", since: 100 });
  assert.ok(Number.isNaN(freshenChannelTriage({ rootCause: "channel", since: Number.NaN }, { level: "error", detail: { downSinceMs: 50 } }).since));
  const upstream = { rootCause: "upstream", since: 1 };
  assert.equal(freshenChannelTriage(upstream, { level: "ok" }), upstream);
  assert.equal(freshenChannelTriage(null, { level: "error" }), null);
});

test("派发期间的唤醒拍不丢：派发结束后补跑一次唤醒复核（只记最近一次跳变、只补一次）", async () => {
  const h = harness();
  const deferred = [];
  h.onRefresh(() => {
    // 重启正在派发时，挂钟跳变的唤醒拍到了两次：当下都静默。
    deferred.push(h.runner.evaluate({ wakeGapMs: 120_000 }), h.runner.evaluate({ wakeGapMs: 300_000 }));
  });
  await h.runner.evaluate();
  assert.deepEqual(await Promise.all(deferred), [[], []], "派发中不并发执行");
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 1);
  assert.deepEqual(h.forced.map((f) => f.id), ["processes", "log-signals", "collect:slow:server-01"], "派发结束后补跑一次唤醒复核");
  assert.ok(h.forced.every((f) => f.overrideBreaker === true));
  const wake = h.timeline.filter((t) => t.ruleId === "wake-recheck");
  assert.equal(wake.length, 1, "只补一次");
  assert.match(wake[0].reason, /挂钟跳变 300s/, "用的是最近一次跳变");
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 1, "补跑不会在冷却内再重启");

  await h.runner.evaluate();
  assert.equal(h.forced.length, 3, "补跑过的跳变不会被下一次评估再补");
});

test("补跑的唤醒复核同样受冷却约束：60 秒内刚复核过就不再强制跑探针", async () => {
  const h = harness({ view: { triage: null } });
  await h.runner.evaluate({ wakeGapMs: 120_000 }); // 刚做过一次唤醒复核
  assert.equal(h.forced.length, 3);
  h.view.triage = { rootCause: "channel", since: 0 };
  h.advance(10_000);
  h.onRefresh(() => {
    h.runner.evaluate({ wakeGapMs: 200_000 });
  });
  await h.runner.evaluate();
  assert.equal(h.events.filter((e) => e[0] === "restart-tunnel").length, 1);
  assert.equal(h.forced.length, 3, "冷却内的补跑不强制刷探针");
  assert.equal(h.timeline.filter((t) => t.ruleId === "wake-recheck").length, 1);
});
