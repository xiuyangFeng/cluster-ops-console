import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKOFF_CAP_MS,
  BACKOFF_GRACE_MS,
  BACKOFF_RESUME_SPREAD_MS,
  classifySshTransport,
  createProbeBackoff,
  isProbeBackoffEnabled,
} from "./probe-backoff.mjs";

const HOST = "cluster.example";

// 假时钟 + 固定随机数（0.5 = 不抖动）。
function harness(options = {}) {
  let clock = 1_000_000;
  const events = [];
  const backoff = createProbeBackoff({
    now: () => clock,
    rng: () => 0.5,
    enabled: true,
    onEvent: (event) => events.push(event),
    ...options,
  });
  return {
    backoff,
    events,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    // 失败到过了宽限期：首次失败后每 10 秒再失败一次，直到进入退避。
    enter(hostKey = HOST) {
      backoff.observe(hostKey, "fail");
      while (!backoff.isHolding(hostKey)) {
        clock += 10_000;
        backoff.observe(hostKey, "fail");
      }
    },
    // 到点 → 放行一条探路的 → 它失败。返回这次失败后排出的间隔。
    failCanary(hostKey = HOST, probeId = "fast") {
      const next = backoff.getView()[hostKey].nextProbeAt;
      if (clock < next) clock = next;
      assert.ok(backoff.hostsAwaitingCanary().includes(hostKey));
      assert.equal(backoff.admit(hostKey, probeId), true);
      backoff.observe(hostKey, "fail");
      backoff.settle(hostKey, probeId);
      return backoff.getView()[hostKey].nextProbeAt - clock;
    },
  };
}

test("classifySshTransport：255 或超时且远端没有任何输出才算连不上；有输出或正常退出算连得上；其余说明不了", () => {
  assert.equal(classifySshTransport({ code: 255, stdout: "", stderr: "ssh: connect to host x port 22: Operation timed out" }), "fail");
  assert.equal(classifySshTransport({ code: 255, stdout: "  \n", stderr: "Permission denied (publickey)." }), "fail");
  assert.equal(classifySshTransport({ code: 1, stdout: "", stderr: "", timedOut: true }), "fail");
  assert.equal(classifySshTransport({ code: 0, stdout: "", stderr: "" }), "ok");
  assert.equal(classifySshTransport({ code: 255, stdout: "__SECTION__ sys\n", stderr: "" }), "ok");
  assert.equal(classifySshTransport({ code: 1, stdout: "partial", stderr: "", timedOut: true }), "ok");
  assert.equal(classifySshTransport({ code: 1, stdout: "", stderr: "spawn ssh ENOENT" }), null);
  assert.equal(classifySshTransport({ code: 2, stdout: "", stderr: "grep: no match" }), null);
  assert.equal(classifySshTransport(null), null);
});

test("开关：v2.64 起默认开；只有自动修复总开关关着或规则显式 false 才关；环境变量两个方向都优先", () => {
  assert.equal(isProbeBackoffEnabled({}), true);
  assert.equal(isProbeBackoffEnabled({ config: {} }), true);
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { enabled: true, observeOnly: false } } }), true);
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { rules: { "probe-backoff": true } } } }), true);
  // 只认布尔 false：写错成字符串的不算关，按默认开
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { rules: { "probe-backoff": "no" } } } }), true);
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { rules: { "probe-backoff": false } } } }), false);
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { enabled: false, rules: { "probe-backoff": true } } } }), false);
  assert.equal(isProbeBackoffEnabled({ config: { autoRepair: { enabled: false } } }), false);
  assert.equal(isProbeBackoffEnabled({ env: { CODEX_MONITOR_PROBE_BACKOFF: "1" }, config: { autoRepair: { enabled: false } } }), true);
  assert.equal(isProbeBackoffEnabled({ env: { CODEX_MONITOR_PROBE_BACKOFF: "off" }, config: { autoRepair: { rules: { "probe-backoff": true } } } }), false);
  assert.equal(isProbeBackoffEnabled({ env: { CODEX_MONITOR_PROBE_BACKOFF: "off" } }), false);
  assert.equal(isProbeBackoffEnabled({ env: { CODEX_MONITOR_PROBE_BACKOFF: "" }, config: { autoRepair: { rules: { "probe-backoff": false } } } }), false);
});

test("关着时不记任何状态：再多失败也不按住探针", () => {
  const h = harness({ enabled: false });
  for (let i = 0; i < 20; i += 1) {
    h.backoff.observe(HOST, "fail");
    h.advance(10_000);
  }
  assert.equal(h.backoff.isHolding(HOST), false);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), []);
  assert.equal(h.backoff.admit(HOST, "fast"), true);
  assert.deepEqual(h.backoff.getView(), {});
  assert.equal(h.backoff.getMetrics().hosts, 0);
});

test("宽限期：首次失败起 30 秒内一切照旧；满 30 秒后的第一次失败进入退避，10 秒后放行第一条探路的", () => {
  const h = harness();
  h.backoff.observe(HOST, "fail");
  h.advance(BACKOFF_GRACE_MS - 1);
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.isHolding(HOST), false, "宽限期内不按住");
  assert.deepEqual(h.backoff.getView(), {}, "宽限期内不算退避");
  h.advance(1);
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.isHolding(HOST), true);
  assert.equal(h.backoff.getView()[HOST].nextProbeAt, h.now() + 10_000);
  assert.equal(h.backoff.getView()[HOST].since, h.now() - BACKOFF_GRACE_MS);
  assert.deepEqual(h.events.map((e) => e.type), ["enter"]);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [], "还没到点");
  assert.equal(h.backoff.admit(HOST, "fast"), false);
  h.advance(10_000);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST]);
});

test("宽限期内成功一次即清零：抖一下不会进入退避", () => {
  const h = harness();
  h.backoff.observe(HOST, "fail");
  h.advance(20_000);
  h.backoff.observe(HOST, "ok");
  h.advance(20_000);
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.isHolding(HOST), false, "宽限期从这次失败重新起算");
  assert.deepEqual(h.events, []);
});

test("退避阶梯：探路的每失败一次，下一次推后 10 → 20 → 40 → 80 秒，之后封顶 120 秒", () => {
  const h = harness();
  h.enter();
  const gaps = [];
  for (let i = 0; i < 7; i += 1) gaps.push(h.failCanary());
  assert.deepEqual(gaps, [20_000, 40_000, 80_000, 120_000, 120_000, 120_000, 120_000]);
  assert.deepEqual(h.events.map((e) => e.type), ["enter"], "只在进入时回调一次");
});

test("抖动 ±20%：间隔落在名义值的 0.8–1.2 倍之间", () => {
  for (const [rng, factor] of [[() => 0, 0.8], [() => 1, 1.2]]) {
    const h = harness({ rng });
    h.enter();
    assert.equal(h.backoff.getView()[HOST].nextProbeAt - h.now(), 10_000 * factor);
    for (let i = 0; i < 4; i += 1) h.failCanary();
    assert.equal(h.failCanary(), BACKOFF_CAP_MS * factor);
  }
});

test("迟到的失败不重复推后：退避中、没到下次探测时刻的失败（闸门关上前发出去的探针、手动动作）只计数", () => {
  const h = harness();
  h.enter();
  const next = h.backoff.getView()[HOST].nextProbeAt;
  h.advance(3_000);
  h.backoff.observe(HOST, "fail");
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.getView()[HOST].nextProbeAt, next);
});

test("探路的一次只放一条：在飞期间不放第二条；物理执行结算后才放下一条", () => {
  const h = harness();
  h.enter();
  h.advance(10_000);
  assert.equal(h.backoff.admit(HOST, "fast"), true);
  assert.equal(h.backoff.getView()[HOST].probing, true);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [], "探路的在飞");
  assert.equal(h.backoff.admit(HOST, "slow"), false);
  h.advance(60_000);
  assert.equal(h.backoff.admit(HOST, "slow"), false, "等多久都一样，直到它结算");
  h.backoff.settle(HOST, "slow");
  assert.equal(h.backoff.admit(HOST, "slow"), false, "别的探针结算不算数");
  h.backoff.settle(HOST, "fast");
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST], "探路的没带回结论（没发 SSH）：立刻换一条");
  assert.equal(h.backoff.admit(HOST, "slow"), true);
});

test("任何一次成功立即清零；被按住过的探针随机错开 0–15 秒恢复，手动触发的结果同样算数", () => {
  let roll = 0;
  // 依次用于：进入退避的那一步间隔、slow / usage / jobs 三条的恢复错开。
  const rolls = [0.5, 0, 1, 0.4];
  const h = harness({ rng: () => rolls[Math.min(roll++, rolls.length - 1)] });
  h.enter();
  for (const id of ["slow", "usage", "jobs"]) h.backoff.hold(HOST, id);
  h.backoff.hold(HOST, "slow");
  assert.equal(h.backoff.getMetrics().holds, 3, "同一条探针只记一次");
  h.advance(4_000);
  h.backoff.observe(HOST, "ok");
  assert.equal(h.backoff.isHolding(HOST), false);
  assert.deepEqual(h.backoff.getView(), {});
  assert.deepEqual(h.events.map((e) => e.type), ["enter", "recover"]);
  assert.equal(h.events[1].downMs, BACKOFF_GRACE_MS + 4_000);
  assert.equal(h.backoff.isResumeDeferred("slow"), false, "抽到 0：立刻恢复");
  assert.equal(h.backoff.isResumeDeferred("usage"), true);
  assert.equal(h.backoff.isResumeDeferred("jobs"), true);
  assert.equal(h.backoff.isResumeDeferred("never-held"), false);
  h.advance(BACKOFF_RESUME_SPREAD_MS * 0.4);
  assert.equal(h.backoff.isResumeDeferred("jobs"), false);
  assert.equal(h.backoff.isResumeDeferred("usage"), true);
  h.advance(BACKOFF_RESUME_SPREAD_MS * 0.6);
  assert.equal(h.backoff.isResumeDeferred("usage"), false);
  h.backoff.beat();
  assert.equal(h.backoff.getMetrics().deferred, 0);
});

test("nudge（隧道稳住了 / 隧道心跳）：下一拍就探，阶梯不重置；reset（隧道刚建立 / 配置变更）：下一拍就探且阶梯从头开始", () => {
  const h = harness();
  h.enter();
  for (let i = 0; i < 4; i += 1) h.failCanary();
  assert.equal(h.backoff.getView()[HOST].nextProbeAt - h.now(), 120_000);
  assert.equal(h.backoff.nudge(HOST), true);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST]);
  assert.equal(h.failCanary(), 120_000, "nudge 不重置阶梯");
  assert.equal(h.backoff.reset(HOST), true);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST]);
  assert.equal(h.failCanary(), 10_000, "reset 后从 10 秒重新起步");
  assert.equal(h.backoff.nudge("other.example"), false, "没在退避的主机不受影响");
  assert.equal(h.backoff.reset("other.example"), false);
});

test("休眠唤醒：两拍间隔超过 90 秒，全部退避中的主机立即从头再探；一秒一拍的正常节奏不算", () => {
  const h = harness();
  const OTHER = "b.example";
  const run = (ms) => {
    for (let t = 0; t < ms; t += 1000) {
      h.advance(1000);
      h.backoff.beat();
    }
  };
  const failBoth = () => {
    for (const host of [HOST, OTHER]) {
      if (h.backoff.isHolding(host)) assert.equal(h.backoff.admit(host, "fast"), true);
      h.backoff.observe(host, "fail");
      h.backoff.settle(host, "fast");
    }
  };
  h.backoff.beat();
  failBoth();
  run(BACKOFF_GRACE_MS);
  failBoth();
  for (let i = 0; i < 4; i += 1) {
    run(h.backoff.getView()[HOST].nextProbeAt - h.now());
    failBoth();
  }
  assert.equal(h.backoff.getView()[HOST].nextProbeAt - h.now(), 120_000);
  run(5_000);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [], "正常节拍下不提前");
  assert.deepEqual(h.events.map((e) => e.type), ["enter", "enter"]);
  h.advance(91_000);
  h.backoff.beat();
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST, OTHER]);
  assert.deepEqual(h.events.at(-1), { type: "reset", reason: "wake", hosts: 2 });
  assert.equal(h.failCanary(), 10_000, "阶梯从头开始");
});

test("本机网络地址变化：至多每 5 秒查一次，变了就全部从头再探；检测函数抛错不影响节拍", () => {
  let changed = false;
  let checks = 0;
  const h = harness({ networkChanged: () => { checks += 1; if (changed === "throw") throw new Error("boom"); return changed; } });
  h.enter();
  for (let i = 0; i < 4; i += 1) h.failCanary();
  h.backoff.beat();
  for (let i = 0; i < 4; i += 1) { h.advance(1_000); h.backoff.beat(); }
  assert.equal(checks, 1, "5 秒内只查一次");
  changed = true;
  h.advance(1_000);
  h.backoff.beat();
  assert.equal(checks, 2);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST]);
  assert.deepEqual(h.events.at(-1), { type: "reset", reason: "network", hosts: 1 });
  changed = "throw";
  h.advance(5_000);
  assert.doesNotThrow(() => h.backoff.beat());
});

test("状态作废：下次探测时刻过去 5 分钟仍没有新结论（名下已没有会发 SSH 的探针）就清掉，不让界面一直挂着", () => {
  const h = harness();
  h.enter();
  h.advance(10_000 + 5 * 60_000);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), [HOST], "刚好 5 分钟还在");
  h.advance(1);
  assert.deepEqual(h.backoff.hostsAwaitingCanary(), []);
  assert.equal(h.backoff.isHolding(HOST), false);
});

test("宽限期内相隔很久的两次失败按两轮故障算：不会因为几小时前的一次失败立刻进入退避", () => {
  const h = harness();
  h.backoff.observe(HOST, "fail");
  h.advance(3 * 3600_000);
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.isHolding(HOST), false);
  h.advance(BACKOFF_GRACE_MS);
  h.backoff.observe(HOST, "fail");
  assert.equal(h.backoff.isHolding(HOST), true);
});

test("retain / setEnabled(false)：不在配置里的主机清掉；关掉开关清空全部状态", () => {
  const h = harness();
  h.enter();
  h.enter("b.example");
  h.backoff.retain([HOST]);
  assert.deepEqual(Object.keys(h.backoff.getView()), [HOST]);
  h.backoff.setEnabled(false);
  assert.equal(h.backoff.isHolding(HOST), false);
  assert.deepEqual(h.backoff.getView(), {});
  h.backoff.setEnabled(true);
  assert.equal(h.backoff.isHolding(HOST), false, "重新打开从零开始");
});

test("性质：任意失败 / 成功 / 信号序列下，退避中的主机永远有一个有限的下次探测时刻，且离现在不超过封顶间隔的 1.2 倍", () => {
  let seed = 20261012;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let clock = 5_000_000;
  const backoff = createProbeBackoff({ now: () => clock, rng: rand, enabled: true });
  let lastAdmitAt = null;
  let worstGap = 0;
  let inFlightUntil = null;
  for (let step = 0; step < 60_000; step += 1) {
    clock += 1_000;
    backoff.beat();
    if (inFlightUntil !== null && clock >= inFlightUntil) {
      backoff.observe(HOST, rand() < 0.03 ? "ok" : "fail");
      backoff.settle(HOST, "fast");
      inFlightUntil = null;
    }
    const roll = rand();
    if (roll < 0.002) backoff.nudge(HOST);
    else if (roll < 0.003) backoff.reset(HOST);
    else if (roll < 0.004) backoff.observe(HOST, "fail"); // 手动动作的失败
    if (!backoff.isHolding(HOST)) {
      // 没在退避：探针照常跑（这里每 10 秒失败一次，把它推回退避）。
      if (step % 10 === 0 && inFlightUntil === null) backoff.observe(HOST, "fail");
      lastAdmitAt = null;
      continue;
    }
    const view = backoff.getView()[HOST];
    assert.ok(Number.isFinite(view.nextProbeAt));
    assert.ok(view.nextProbeAt - clock <= BACKOFF_CAP_MS * 1.2, `下次探测离现在 ${view.nextProbeAt - clock}ms`);
    if (backoff.hostsAwaitingCanary().includes(HOST) && backoff.admit(HOST, "fast")) {
      if (lastAdmitAt !== null) worstGap = Math.max(worstGap, clock - lastAdmitAt);
      lastAdmitAt = clock;
      inFlightUntil = clock + 1_000 + Math.floor(rand() * 15_000);
    }
  }
  // 两次探路之间最长 = 封顶间隔 ×1.2 + 一次探测的最长耗时（16 秒）+ 一拍。
  assert.ok(worstGap > 0 && worstGap <= BACKOFF_CAP_MS * 1.2 + 17_000, `最长探路间隔 ${worstGap}ms`);
});
