import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_REPAIR_RULES,
  DEFAULT_AUTO_REPAIR_CONFIG,
  createAutoRepairPolicy,
  createRateLimiter,
  isRuleEnabled,
  normalizeAutoRepairConfig,
} from "./auto-repair-policy.mjs";

// 可控时钟：策略层所有限频判定都靠注入的 now，测试绝不依赖真实计时器
// （限频窗口是 10 分钟，真等一次测试就废了）。
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
    set(ms) {
      t = ms;
      return t;
    },
  };
}

// 健康基线视图：护栏全开、无触发证据。各用例只叠加自己关心的那一项，
// 避免"顺带命中另一条规则"污染断言。
function baseView(overrides = {}) {
  return {
    now: 1_700_000_000_000,
    shouldBeRunning: true,
    repairInFlight: false,
    activeServerId: "myserver",
    triage: null,
    processes: { supervisorUp: true, localProxyUp: true },
    wakeGapMs: 0,
    ...overrides,
  };
}

// 通道断开视图：rootCause 取分诊表里"通道断开"的实际取值（signal-triage 的 "channel"），
// 设计文档写的 "channel-down" 在代码里并不存在——这里跟代码走。
function channelDownView(downForMs, overrides = {}) {
  const now = 1_700_000_000_000;
  return baseView({
    now,
    triage: { rootCause: "channel", since: now - downForMs },
    ...overrides,
  });
}

describe("AUTO_REPAIR_RULES 规则表", () => {
  it("首发两条规则，id/tier/限频常量与设计一致", () => {
    assert.deepEqual(
      AUTO_REPAIR_RULES.map((rule) => rule.id),
      ["wake-recheck", "channel-down-restart"],
    );
    const byId = new Map(AUTO_REPAIR_RULES.map((rule) => [rule.id, rule]));
    assert.equal(byId.get("wake-recheck").tier, "L1");
    assert.equal(byId.get("wake-recheck").cooldownMs, 60_000);
    assert.equal(byId.get("wake-recheck").maxPerWindow, Number.POSITIVE_INFINITY);
    assert.equal(byId.get("channel-down-restart").tier, "L2");
    assert.equal(byId.get("channel-down-restart").cooldownMs, 60_000);
    assert.equal(byId.get("channel-down-restart").maxPerWindow, 2);
    assert.equal(byId.get("channel-down-restart").windowMs, 600_000);
  });

  it("每条规则都具备 detect/action/title，且动作 kind 落在封闭集合内", () => {
    const allowed = new Set(["force-probes", "restart-channel"]);
    for (const rule of AUTO_REPAIR_RULES) {
      assert.equal(typeof rule.detect, "function");
      assert.equal(typeof rule.action, "function");
      assert.equal(typeof rule.title, "string");
      assert.ok(rule.title.length > 0);
      const trigger = { reason: "test" };
      assert.ok(allowed.has(rule.action(baseView(), trigger).kind));
    }
  });
});

describe("wake-recheck（L1 唤醒复核）", () => {
  const rule = AUTO_REPAIR_RULES.find((r) => r.id === "wake-recheck");

  it("挂钟跳变恰好 90000ms 不触发（阈值是 >，不是 >=）", () => {
    assert.equal(rule.detect(baseView({ wakeGapMs: 90_000 })), null);
  });

  it("挂钟跳变 90001ms 触发", () => {
    assert.ok(rule.detect(baseView({ wakeGapMs: 90_001 })));
  });

  it("动作是覆盖熔断的强制探针，含活跃服务器的慢采集", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const [action] = policy.evaluate(baseView({ wakeGapMs: 120_000, activeServerId: "server-tengxun" }));
    assert.equal(action.ruleId, "wake-recheck");
    assert.equal(action.tier, "L1");
    assert.equal(action.kind, "force-probes");
    assert.deepEqual(action.payload, {
      probeIds: ["processes", "log-signals", "collect:slow:server-tengxun"],
      overrideBreaker: true,
    });
    assert.equal(action.observeOnly, false);
    assert.equal(typeof action.reason, "string");
  });

  it("没有活跃服务器时不拼出半截的 collect:slow: 探针 id", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const [action] = policy.evaluate(baseView({ wakeGapMs: 120_000, activeServerId: "" }));
    assert.deepEqual(action.payload.probeIds, ["processes", "log-signals"]);
  });

  it("60s 冷却内不重复产出，冷却过后恢复", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => baseView({ now: clock.now(), wakeGapMs: 120_000 });

    assert.equal(policy.evaluate(view()).length, 1);
    clock.advance(59_999);
    assert.deepEqual(policy.evaluate(view()), []);
    clock.advance(2);
    assert.equal(policy.evaluate(view()).length, 1);
  });

  it("maxPerWindow 为 Infinity：连续多轮冷却过后都能继续产出，且不 escalate", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => baseView({ now: clock.now(), wakeGapMs: 120_000 });

    for (let i = 0; i < 6; i += 1) {
      const actions = policy.evaluate(view());
      assert.equal(actions.length, 1, `第 ${i + 1} 轮应产出动作`);
      assert.equal(actions[0].kind, "force-probes");
      clock.advance(60_001);
    }
  });
});

describe("channel-down-restart（L2 通道断开重启）", () => {
  const rule = AUTO_REPAIR_RULES.find((r) => r.id === "channel-down-restart");

  it("通道断开持续 29.9s 不触发", () => {
    assert.equal(rule.detect(channelDownView(29_900)), null);
  });

  it("通道断开持续恰好 30s 触发（阈值是 >=）", () => {
    assert.ok(rule.detect(channelDownView(30_000)));
  });

  it("根因不是通道断开时不触发", () => {
    const now = 1_700_000_000_000;
    for (const rootCause of ["account", "auth", "upstream", "unknown"]) {
      const view = baseView({ now, triage: { rootCause, since: now - 600_000 } });
      assert.equal(rule.detect(view), null, `${rootCause} 不应触发通道重启`);
    }
  });

  it("本机 supervisor 或本地代理缺席时不触发（缺前提，重启只会白跑）", () => {
    assert.equal(rule.detect(channelDownView(60_000, { processes: { supervisorUp: false, localProxyUp: true } })), null);
    assert.equal(rule.detect(channelDownView(60_000, { processes: { supervisorUp: true, localProxyUp: false } })), null);
  });

  it("triage 缺失或 since 非数字时不触发（证据不足按不触发处理）", () => {
    assert.equal(rule.detect(baseView()), null);
    assert.equal(rule.detect(baseView({ triage: { rootCause: "channel" } })), null);
    assert.equal(rule.detect(baseView({ triage: { rootCause: "channel", since: "x" } })), null);
  });

  it("产出 restart-channel 动作并带 force:true", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const [action] = policy.evaluate(channelDownView(45_000));
    assert.equal(action.ruleId, "channel-down-restart");
    assert.equal(action.tier, "L2");
    assert.equal(action.kind, "restart-channel");
    assert.deepEqual(action.payload, { force: true });
    assert.equal(action.escalate, undefined);
  });

  it("窗口内第 3 次不产出动作，只返回一次 escalate；换窗口后恢复", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });

    assert.equal(policy.evaluate(view())[0].kind, "restart-channel");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].kind, "restart-channel");

    clock.advance(60_001); // 冷却已过，只剩窗口上限挡着
    const third = policy.evaluate(view());
    assert.equal(third.length, 1);
    assert.equal(third[0].kind, "escalate");
    assert.equal(third[0].escalate, true);
    assert.equal(third[0].ruleId, "channel-down-restart");
    assert.equal(third[0].reason, "auto repair limit reached");

    // 同一窗口内再评估：escalate 只上报一次，不刷屏
    clock.advance(1_000);
    assert.deepEqual(policy.evaluate(view()), []);
    clock.advance(60_000);
    assert.deepEqual(policy.evaluate(view()), []);

    // 首次执行落在窗口起点，10 分钟后滑出，预算恢复
    clock.advance(600_000);
    const revived = policy.evaluate(view());
    assert.equal(revived.length, 1);
    assert.equal(revived[0].kind, "restart-channel");
  });

  it("窗口过期后 escalate 去重也重置（新窗口再次超限会再报一次）", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });

    const runToExhaustion = () => {
      policy.evaluate(view());
      clock.advance(60_001);
      policy.evaluate(view());
      clock.advance(60_001);
      return policy.evaluate(view());
    };

    assert.equal(runToExhaustion()[0].kind, "escalate");
    clock.advance(900_000); // 远超 10 分钟窗口，限频与 escalate 去重一并过期
    assert.equal(runToExhaustion()[0].kind, "escalate");
  });
});

describe("evaluate 护栏（规则不可绕过）", () => {
  const clock = () => fakeClock();

  it("enabled=false → 空数组", () => {
    const policy = createAutoRepairPolicy({ config: { enabled: false }, now: clock().now });
    assert.deepEqual(policy.evaluate(channelDownView(120_000)), []);
    assert.deepEqual(policy.evaluate(baseView({ wakeGapMs: 120_000 })), []);
  });

  it("shouldBeRunning=false（用户手动停止通道）→ 空数组", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: clock().now });
    assert.deepEqual(policy.evaluate(channelDownView(120_000, { shouldBeRunning: false })), []);
    assert.deepEqual(policy.evaluate(baseView({ wakeGapMs: 120_000, shouldBeRunning: false })), []);
  });

  it("repairInFlight=true（runbook 进行中）→ 空数组，避免与人工修复打架", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: clock().now });
    assert.deepEqual(policy.evaluate(channelDownView(120_000, { repairInFlight: true })), []);
  });

  it("单条规则被关掉时其它规则照常工作", () => {
    const policy = createAutoRepairPolicy({
      config: { rules: { "channel-down-restart": false } },
      now: clock().now,
    });
    assert.deepEqual(policy.evaluate(channelDownView(120_000)), []);
    const actions = policy.evaluate(baseView({ wakeGapMs: 120_000 }));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].ruleId, "wake-recheck");
  });

  it("护栏拦下时不消耗限频预算（停机期间不该烧掉修复次数）", () => {
    const c = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: c.now });
    for (let i = 0; i < 5; i += 1) {
      policy.evaluate(channelDownView(120_000, { now: c.now(), shouldBeRunning: false }));
      c.advance(60_001);
    }
    const actions = policy.evaluate(channelDownView(120_000, { now: c.now() }));
    assert.equal(actions[0].kind, "restart-channel");
  });

  it("同一 view 里每条规则最多一个动作，两条规则可同时命中", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: clock().now });
    const view = channelDownView(120_000, { wakeGapMs: 120_000 });
    const actions = policy.evaluate(view);
    assert.deepEqual(
      actions.map((a) => a.ruleId).sort(),
      ["channel-down-restart", "wake-recheck"],
    );
  });

  it("残缺 view 不抛错（缺字段一律按不触发处理）", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: clock().now });
    assert.deepEqual(policy.evaluate(undefined), []);
    assert.deepEqual(policy.evaluate({}), []);
    assert.deepEqual(policy.evaluate({ shouldBeRunning: true }), []);
    assert.deepEqual(policy.evaluate({ shouldBeRunning: true, triage: "boom", processes: 42 }), []);
  });

  it("view 不带 now 时回落到注入时钟", () => {
    const c = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: c.now });
    const view = {
      shouldBeRunning: true,
      repairInFlight: false,
      activeServerId: "myserver",
      processes: { supervisorUp: true, localProxyUp: true },
      wakeGapMs: 0,
      triage: { rootCause: "channel", since: c.now() - 30_000 },
    };
    assert.equal(policy.evaluate(view)[0].kind, "restart-channel");
  });
});

describe("observeOnly 观察模式", () => {
  it("动作带 observeOnly:true，日志 mode 为 observe", () => {
    const clock = fakeClock();
    const logs = [];
    const policy = createAutoRepairPolicy({
      config: { observeOnly: true },
      now: clock.now,
      log: (entry) => logs.push(entry),
    });
    const [action] = policy.evaluate(channelDownView(120_000));
    assert.equal(action.observeOnly, true);
    assert.equal(action.kind, "restart-channel");
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      level: "info",
      event: "auto-repair",
      ruleId: "channel-down-restart",
      kind: "restart-channel",
      mode: "observe",
      reason: action.reason,
    });
  });

  it("观察模式同样计入限频（否则观察模式会刷屏且与真实节奏不符）", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: { observeOnly: true }, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });

    assert.equal(policy.evaluate(view()).length, 1);
    clock.advance(30_000);
    assert.deepEqual(policy.evaluate(view()), []); // 冷却
    clock.advance(30_002);
    assert.equal(policy.evaluate(view()).length, 1);
    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].kind, "escalate"); // 窗口上限同样生效
  });

  it("执行模式的日志 mode 为 execute", () => {
    const clock = fakeClock();
    const logs = [];
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now, log: (e) => logs.push(e) });
    policy.evaluate(baseView({ wakeGapMs: 120_000 }));
    assert.equal(logs[0].mode, "execute");
    assert.equal(logs[0].event, "auto-repair");
  });

  it("log 抛错不影响动作产出（日志绝不反噬策略主流程）", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({
      config: {},
      now: clock.now,
      log: () => {
        throw new Error("sink down");
      },
    });
    assert.equal(policy.evaluate(baseView({ wakeGapMs: 120_000 })).length, 1);
  });
});

describe("normalizeAutoRepairConfig", () => {
  it("空/坏输入一律回落默认", () => {
    for (const raw of [undefined, null, 42, "on", [], () => {}]) {
      assert.deepEqual(normalizeAutoRepairConfig(raw), DEFAULT_AUTO_REPAIR_CONFIG);
    }
  });

  it("非布尔的 enabled/observeOnly 回落默认", () => {
    const cfg = normalizeAutoRepairConfig({ enabled: "false", observeOnly: 1 });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.observeOnly, false);
  });

  it("rules 深合并：只覆盖给到的键，其余保持默认", () => {
    const cfg = normalizeAutoRepairConfig({ rules: { "channel-down-restart": false } });
    assert.deepEqual(cfg.rules, {
      "channel-down-restart": false,
      "orphan-tunnel-adopt": true,
      "stale-session-reclaim": true,
      "wake-recheck": true,
    });
  });

  it("rules 非对象或值非布尔时回落默认", () => {
    assert.deepEqual(normalizeAutoRepairConfig({ rules: "all" }).rules, DEFAULT_AUTO_REPAIR_CONFIG.rules);
    assert.deepEqual(normalizeAutoRepairConfig({ rules: { "wake-recheck": "no" } }).rules, DEFAULT_AUTO_REPAIR_CONFIG.rules);
  });

  it("保留未知规则 id 的布尔开关（新规则先行下发配置也能生效）", () => {
    const cfg = normalizeAutoRepairConfig({ rules: { "future-rule": false } });
    assert.equal(cfg.rules["future-rule"], false);
    assert.equal(cfg.rules["wake-recheck"], true);
  });

  it("输出与默认对象隔离，改结果不污染 DEFAULT_AUTO_REPAIR_CONFIG", () => {
    const cfg = normalizeAutoRepairConfig({});
    cfg.rules["wake-recheck"] = false;
    cfg.enabled = false;
    assert.equal(DEFAULT_AUTO_REPAIR_CONFIG.rules["wake-recheck"], true);
    assert.equal(DEFAULT_AUTO_REPAIR_CONFIG.enabled, true);
  });

  it("已归一化的配置再归一化保持不变（幂等）", () => {
    const once = normalizeAutoRepairConfig({ observeOnly: true, rules: { "wake-recheck": false } });
    assert.deepEqual(normalizeAutoRepairConfig(once), once);
  });
});

describe("isRuleEnabled", () => {
  it("总开关关掉时任何规则都不启用", () => {
    assert.equal(isRuleEnabled({ enabled: false, rules: { "wake-recheck": true } }, "wake-recheck"), false);
  });

  it("规则显式 false 才算关闭，未列出的按启用", () => {
    assert.equal(isRuleEnabled(DEFAULT_AUTO_REPAIR_CONFIG, "wake-recheck"), true);
    assert.equal(isRuleEnabled({ rules: { "wake-recheck": false } }, "wake-recheck"), false);
    assert.equal(isRuleEnabled({}, "brand-new-rule"), true);
  });

  it("坏配置按默认处理，不抛错", () => {
    assert.equal(isRuleEnabled(undefined, "wake-recheck"), true);
    assert.equal(isRuleEnabled("nope", "wake-recheck"), true);
    assert.equal(isRuleEnabled({ rules: null }, "wake-recheck"), true);
  });
});

describe("createRateLimiter", () => {
  it("冷却内拒绝，冷却过后放行", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 60_000, maxPerWindow: 5, windowMs: 600_000 };

    assert.equal(limiter.allow("k", opts).ok, true);
    limiter.record("k");
    const denied = limiter.allow("k", opts);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "cooldown");
    clock.advance(60_000);
    assert.equal(limiter.allow("k", opts).ok, true);
  });

  it("窗口耗尽时 reason 为 window-exhausted 且 remaining 为 0", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 0, maxPerWindow: 2, windowMs: 600_000 };

    limiter.record("k");
    clock.advance(1_000);
    limiter.record("k");
    const denied = limiter.allow("k", opts);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "window-exhausted");
    assert.equal(denied.remaining, 0);
  });

  it("窗口上限优先于冷却（先报 window-exhausted，接线层才能及时升级人工）", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 60_000, maxPerWindow: 1, windowMs: 600_000 };
    limiter.record("k");
    assert.equal(limiter.allow("k", opts).reason, "window-exhausted");
  });

  it("旧记录滑出窗口后自动回收预算", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 0, maxPerWindow: 2, windowMs: 600_000 };
    limiter.record("k");
    limiter.record("k");
    assert.equal(limiter.allow("k", opts).ok, false);
    clock.advance(600_001);
    assert.equal(limiter.allow("k", opts).ok, true);
  });

  it("remaining 反映窗口剩余额度；maxPerWindow 为 Infinity 时恒为 Infinity", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 0, maxPerWindow: 3, windowMs: 600_000 };
    assert.equal(limiter.allow("k", opts).remaining, 3);
    limiter.record("k");
    assert.equal(limiter.allow("k", opts).remaining, 2);
    limiter.record("k");
    assert.equal(limiter.allow("k", opts).remaining, 1);

    const unlimited = { cooldownMs: 0, maxPerWindow: Number.POSITIVE_INFINITY, windowMs: 600_000 };
    limiter.record("u");
    assert.equal(limiter.allow("u", unlimited).remaining, Number.POSITIVE_INFINITY);
    assert.equal(limiter.allow("u", unlimited).ok, true);
  });

  it("不同 key 各自独立计数（供 supervisor 按 serverId 复用）", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 300_000, maxPerWindow: 1, windowMs: 300_000 };
    limiter.record("orphan:server-a");
    assert.equal(limiter.allow("orphan:server-a", opts).ok, false);
    assert.equal(limiter.allow("orphan:server-b", opts).ok, true);
  });

  it("reset(key) 只清该 key；reset() 清空全部", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 60_000, maxPerWindow: 1, windowMs: 600_000 };
    limiter.record("a");
    limiter.record("b");
    limiter.reset("a");
    assert.equal(limiter.allow("a", opts).ok, true);
    assert.equal(limiter.allow("b", opts).ok, false);
    limiter.reset();
    assert.equal(limiter.allow("b", opts).ok, true);
  });

  it("缺省选项按无限制处理，不抛错", () => {
    const limiter = createRateLimiter({ now: fakeClock().now });
    assert.equal(limiter.allow("k").ok, true);
    limiter.record("k");
    assert.equal(limiter.allow("k", {}).ok, true);
  });

  it("默认时钟为 Date.now（不注入也能用）", () => {
    const limiter = createRateLimiter();
    assert.equal(limiter.allow("k", { cooldownMs: 60_000, maxPerWindow: 1, windowMs: 600_000 }).ok, true);
  });
});

describe("markExecuted / getState", () => {
  it("非法动作不回填 lastActions", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    policy.evaluate(channelDownView(120_000));
    policy.markExecuted(undefined, true);
    policy.markExecuted({}, true);
    policy.markExecuted("boom", false);
    assert.equal(policy.getState().lastActions[0].ok, null);
  });

  it("lastActions 记录产出的动作并回填执行结果，最多保留 20 条", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    for (let i = 0; i < 25; i += 1) {
      const [action] = policy.evaluate(baseView({ now: clock.now(), wakeGapMs: 120_000 }));
      policy.markExecuted(action, i % 2 === 0);
      clock.advance(60_001);
    }
    const { lastActions } = policy.getState();
    assert.equal(lastActions.length, 20);
    assert.equal(lastActions.at(-1).ruleId, "wake-recheck");
    assert.equal(lastActions.at(-1).ok, true); // 第 25 次（i=24，偶数）标记为成功
    assert.equal(lastActions.at(-1).kind, "force-probes");
    assert.equal(typeof lastActions.at(-1).at, "number");
  });

  it("getState 返回副本，外部改动不影响内部状态", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const [action] = policy.evaluate(baseView({ wakeGapMs: 120_000 }));
    policy.markExecuted(action, true);

    const state = policy.getState();
    state.lastActions.push({ ruleId: "fake" });
    state.lastActions[0].ok = false;
    state.config.enabled = false;

    const fresh = policy.getState();
    assert.equal(fresh.lastActions.length, 1);
    assert.equal(fresh.lastActions[0].ok, true);
    assert.equal(fresh.config.enabled, true);
  });

  it("setConfig 热切换开关，且不重置已用掉的限频预算", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });

    assert.equal(policy.evaluate(view()).length, 1);
    policy.setConfig({ observeOnly: true });
    assert.equal(policy.getState().config.observeOnly, true);
    assert.deepEqual(policy.evaluate(view()), []); // 冷却预算延续，配置切换不是重置手段

    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].observeOnly, true);

    policy.setConfig({ enabled: false });
    clock.advance(600_001);
    assert.deepEqual(policy.evaluate(view()), []);
  });

  it("setConfig 坏输入回落默认而不是清空配置", () => {
    const policy = createAutoRepairPolicy({ config: { enabled: false }, now: fakeClock().now });
    policy.setConfig("nonsense");
    assert.deepEqual(policy.getState().config, DEFAULT_AUTO_REPAIR_CONFIG);
  });
});

describe("只修坏的那条（v2.64）", () => {
  const tunnels = (main, aliyun) => [{ serverId: "server-01", level: main }, { serverId: "server-aliyun", level: aliyun }];

  it("本地代理在、恰好一条隧道坏 → restart-tunnel(该条)，原因写明只重启哪条", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    const [action] = policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "ok") }));
    assert.equal(action.kind, "restart-tunnel");
    assert.equal(action.tier, "L2");
    assert.deepEqual(action.payload, { serverId: "server-01" });
    assert.match(action.reason, /已持续 45s，只重启 server-01 的隧道/);
  });

  it("另一条状态未知（等待 / 告警）也只重启坏的那条：等待中的不算坏", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    const [action] = policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "waiting") }));
    assert.equal(action.kind, "restart-tunnel");
  });

  it("多条都坏 → restart-channel（一键修复）", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    const [action] = policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "error") }));
    assert.equal(action.kind, "restart-channel");
    assert.deepEqual(action.payload, { force: true });
    assert.match(action.reason, /执行一键修复/);
  });

  it("视图没有隧道明细（说不清哪条坏）→ 回落 restart-channel（旧调用方语义不变）", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    assert.equal(policy.evaluate(channelDownView(45_000))[0].kind, "restart-channel");
    assert.equal(createAutoRepairPolicy({ config: {}, now: fakeClock().now })
      .evaluate(channelDownView(45_000, { tunnels: "boom" }))[0].kind, "restart-channel");
  });

  it("单隧道与整通道共用同一份窗口预算（10 分钟 2 次）", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = (t) => channelDownView(120_000, { now: clock.now(), tunnels: t });
    assert.equal(policy.evaluate(view(tunnels("error", "ok")))[0].kind, "restart-tunnel");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view(tunnels("error", "error")))[0].kind, "restart-channel");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view(tunnels("error", "ok")))[0].kind, "escalate");
  });

  it("决策日志带 serverId（只在单隧道时）", () => {
    const logs = [];
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now, log: (entry) => logs.push(entry) });
    policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "ok") }));
    assert.equal(logs[0].kind, "restart-tunnel");
    assert.equal(logs[0].serverId, "server-01");
  });
});

describe("recheck / refund（执行前再看一眼，v2.64）", () => {
  const tunnels = (main, aliyun) => [{ serverId: "server-01", level: main }, { serverId: "server-aliyun", level: aliyun }];

  it("仍满足判据 → ok；通道已恢复（不再有 channel 分诊）→ recovered", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    const [action] = policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "ok") }));
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { tunnels: tunnels("error", "ok") })), { ok: true });
    assert.deepEqual(policy.recheck(action, baseView({ tunnels: tunnels("ok", "ok") })), { ok: false, reason: "recovered" });
    assert.deepEqual(policy.recheck(action, channelDownView(10_000)), { ok: false, reason: "precondition-changed" }, "又断了但没满 30 秒");
  });

  it("要重启的那条已经好了 → recovered；被停 / 别的修复在飞 / 规则被关 → stopped / busy / disabled", () => {
    const policy = createAutoRepairPolicy({ config: {}, now: fakeClock().now });
    const [action] = policy.evaluate(channelDownView(45_000, { tunnels: tunnels("error", "ok") }));
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { tunnels: tunnels("ok", "error") })), { ok: false, reason: "recovered" });
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { shouldBeRunning: false })), { ok: false, reason: "stopped" });
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { repairInFlight: true })), { ok: false, reason: "busy" });
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { processes: { supervisorUp: true, localProxyUp: false } })),
      { ok: false, reason: "precondition-changed" });
    policy.setConfig({ rules: { "channel-down-restart": false } });
    assert.deepEqual(policy.recheck(action, channelDownView(46_000, { tunnels: tunnels("error", "ok") })), { ok: false, reason: "disabled" });
  });

  it("认不出的动作一律放行；recheck 不碰限频", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    assert.deepEqual(policy.recheck({ ruleId: "nope", kind: "x" }, {}), { ok: true });
    assert.deepEqual(policy.recheck(null, null), { ok: true });
    for (let i = 0; i < 5; i += 1) policy.recheck({ ruleId: "channel-down-restart", kind: "restart-channel" }, channelDownView(60_000));
    assert.equal(policy.evaluate(channelDownView(60_000))[0].kind, "restart-channel");
  });

  it("refund 退回窗口预算与冷却，lastActions 标 skipped", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });
    for (let i = 0; i < 3; i += 1) {
      const [action] = policy.evaluate(view());
      assert.equal(action.kind, "restart-channel", `第 ${i + 1} 次：退回后立刻又能决策（无冷却）`);
      assert.equal(policy.refund(action, "recovered"), true);
    }
    assert.equal(policy.getState().lastActions.filter((a) => a.skipped === "recovered").length, 3);
    assert.equal(policy.evaluate(view())[0].kind, "restart-channel");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].kind, "restart-channel");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].kind, "escalate", "真执行的两次照常计入上限");
  });

  it("refund 只退最近一笔：先前已执行的那次仍占预算与冷却", () => {
    const clock = fakeClock();
    const policy = createAutoRepairPolicy({ config: {}, now: clock.now });
    const view = () => channelDownView(120_000, { now: clock.now() });
    policy.evaluate(view()); // 第一次：已执行
    clock.advance(60_001);
    const [second] = policy.evaluate(view());
    policy.refund(second, "recovered");
    assert.equal(policy.evaluate(view())[0].kind, "restart-channel", "第二笔退回后可立即再决策");
    clock.advance(60_001);
    assert.equal(policy.evaluate(view())[0].kind, "escalate", "第一次那笔没被退：窗口里已有两次");
  });
});

describe("createRateLimiter.refund（v2.64）", () => {
  it("退回最近一笔：窗口计数减一，冷却基准回到上一笔；没有可退的返回 false", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now });
    const opts = { cooldownMs: 60_000, maxPerWindow: 2, windowMs: 600_000 };
    assert.equal(limiter.refund("k"), false);
    limiter.record("k");
    clock.advance(61_000);
    limiter.record("k");
    assert.equal(limiter.allow("k", opts).reason, "window-exhausted");
    assert.equal(limiter.refund("k"), true);
    const verdict = limiter.allow("k", opts);
    assert.equal(verdict.ok, true, "第一笔在 61 秒前，冷却已过");
    assert.equal(verdict.remaining, 1);
    assert.equal(limiter.refund("k"), true);
    assert.equal(limiter.refund("k"), false);
    assert.deepEqual(limiter.allow("k", opts), { ok: true, remaining: 2 });
  });
});
