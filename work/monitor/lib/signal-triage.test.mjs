import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TRIAGE_RULES, classifySignal, deriveTriageView } from "./signal-triage.mjs";

// 健康快照基线：三层全绿。各用例在此之上叠加单一故障证据，
// 保证命中的是目标规则而不是残留证据。
function healthySnapshot() {
  return {
    health: "ready",
    layers: {
      channel: {
        level: "ok",
        detail: { supervisorUp: true, localProxyUp: true, tunnelUp: true, remotePortOpen: true },
      },
      agents: {
        codex: { level: "ok", health: "ready", expiry: null },
        "claude-codewing": { level: "ok", health: "ready", expiry: null },
      },
    },
    agentsStatus: {
      codex: { ok: true, health: "ready" },
      "claude-codewing": { ok: true, health: "ready", accountFault: null, loggedIn: true, gatewayOk: true },
    },
  };
}

const SIGNAL = { id: "gateway-unhealthy", category: "gateway", severity: "error", title: "网关不健康" };

describe("TRIAGE_RULES 规则表", () => {
  it("顺序即 SOP 优先级：account → auth → setup → channel → upstream → unknown", () => {
    assert.deepEqual(
      TRIAGE_RULES.map((r) => r.rootCause),
      ["account", "auth", "setup", "channel", "upstream", "unknown"],
    );
  });

  it("每条规则都有 label / advice / severity / match（数据结构可扩展契约）", () => {
    for (const rule of TRIAGE_RULES) {
      assert.equal(typeof rule.label, "string");
      assert.equal(typeof rule.advice, "string");
      assert.ok(["error", "warn", "info"].includes(rule.severity), rule.rootCause);
      assert.equal(typeof rule.match, "function");
    }
  });
});

describe("classifySignal：五类根因", () => {
  it("account / revoked：agentsStatus 的 accountFault=revoked", () => {
    const snap = healthySnapshot();
    snap.agentsStatus["claude-codewing"].accountFault = "revoked";
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "account");
    assert.equal(out.label, "账号层故障");
    assert.equal(out.advice, "设备已解绑，需在服务器重新登录");
    assert.equal(out.severity, "error");
  });

  it("account / banned：layers.agents 的 health=banned 也是账号层证据", () => {
    const snap = healthySnapshot();
    snap.layers.agents["claude-codewing"].health = "banned";
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "account");
    assert.equal(out.advice, "绑定账号被封禁，需更换账号");
  });

  it("account / expired：任一 agent 凭证 expiry.level=expired（codex 凭证过期场景）", () => {
    const snap = healthySnapshot();
    snap.layers.agents.codex.expiry = { level: "expired", remainingMs: -1000 };
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "account");
    assert.equal(out.advice, "凭证已过期，需在服务器重新登录刷新凭证");
  });

  it("account / 信号条目自证：account-revoked 信号在 agentsStatus 尚未跟上时也判 account", () => {
    // 日志信号先于 reclaude 探针复核到达（forceRun 由信号触发），快照还是全绿——
    // 这正是当年"排查很久才发现是账号层"的时序，分类器必须吃信号自身证据。
    const out = classifySignal(
      { id: "account-revoked", category: "account", severity: "error" },
      healthySnapshot(),
    );
    assert.equal(out.rootCause, "account");
    assert.equal(out.advice, "设备已解绑，需在服务器重新登录");
  });

  it("auth：loggedIn === false → 等待设备登录授权", () => {
    const snap = healthySnapshot();
    snap.agentsStatus["claude-codewing"].loggedIn = false;
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "auth");
    assert.equal(out.label, "登录授权未完成");
    assert.equal(out.advice, "等待设备登录授权");
    assert.equal(out.severity, "warn");
  });

  it("channel：隧道/代理/远端口任一明确 false → 通道断开", () => {
    for (const key of ["localProxyUp", "tunnelUp", "remotePortOpen"]) {
      const snap = healthySnapshot();
      snap.layers.channel.level = "error";
      snap.layers.channel.detail[key] = false;
      const out = classifySignal(SIGNAL, snap);
      assert.equal(out.rootCause, "channel", `detail.${key}=false 应判 channel`);
      assert.equal(out.label, "通道断开");
      assert.equal(out.advice, "通道断开，等待自愈或点一键修复");
      assert.equal(out.severity, "error");
    }
  });

  it("upstream：通道 ok 但 agent 端点探测失败（health=degraded）", () => {
    const snap = healthySnapshot();
    snap.agentsStatus.codex.health = "degraded";
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "upstream");
    assert.equal(out.label, "上游 API 不可达");
    assert.equal(out.advice, "上游 API 不可达，通常是服务端抖动，稍候重试");
    assert.equal(out.severity, "warn");
  });

  it("upstream：全局 health=degraded 同样算上游证据（codex endpoint 失败的收敛值）", () => {
    const snap = healthySnapshot();
    snap.health = "degraded";
    assert.equal(classifySignal(SIGNAL, snap).rootCause, "upstream");
  });

  it("upstream / rate-limited 与 http-5xx：通道正常时给出无需重启隧道的智能分流建议", () => {
    const snap = healthySnapshot();
    const rateOut = classifySignal({ id: "rate-limited", category: "request", severity: "warn" }, snap);
    assert.equal(rateOut.rootCause, "upstream");
    assert.match(rateOut.advice, /429 \/ 配额限制.*无需重启隧道/);
    const err5xx = classifySignal({ id: "http-5xx", category: "request", severity: "warn" }, snap);
    assert.equal(err5xx.rootCause, "upstream");
    assert.match(err5xx.advice, /5xx 服务端异常.*无需重启隧道/);
  });

  it("unknown：三层全绿且无任何故障证据 → 兜底", () => {
    const out = classifySignal(SIGNAL, healthySnapshot());
    assert.equal(out.rootCause, "unknown");
    assert.equal(out.label, "根因未定位");
    assert.equal(out.advice, "根因未定位，查看日志与 Doctor 输出");
    assert.equal(out.severity, "info");
  });
});

describe("classifySignal：优先级压制", () => {
  it("账号故障与通道断同时存在 → 判 account（先修根因，不追现象）", () => {
    const snap = healthySnapshot();
    snap.agentsStatus["claude-codewing"].accountFault = "revoked";
    snap.layers.channel.level = "error";
    snap.layers.channel.detail.tunnelUp = false;
    snap.layers.channel.detail.remotePortOpen = false;
    const out = classifySignal(SIGNAL, snap);
    assert.equal(out.rootCause, "account");
    assert.equal(out.advice, "设备已解绑，需在服务器重新登录");
  });

  it("auth 与通道断同时存在 → 判 auth（auth 优先级高于 channel）", () => {
    const snap = healthySnapshot();
    snap.agentsStatus["claude-codewing"].loggedIn = false;
    snap.layers.channel.detail.tunnelUp = false;
    assert.equal(classifySignal(SIGNAL, snap).rootCause, "auth");
  });

  it("通道断时 degraded 不判 upstream（upstream 要求通道 ok）", () => {
    const snap = healthySnapshot();
    snap.layers.channel.level = "error";
    snap.layers.channel.detail.remotePortOpen = false;
    snap.agentsStatus.codex.health = "degraded";
    assert.equal(classifySignal(SIGNAL, snap).rootCause, "channel");
  });
});

describe("classifySignal：快照缺字段安全兜底", () => {
  it("snapshot 为 null/undefined/空对象 → unknown，绝不抛错", () => {
    for (const snap of [null, undefined, {}, { layers: null }, { layers: {}, agentsStatus: null }]) {
      const out = classifySignal(SIGNAL, snap);
      assert.equal(out.rootCause, "unknown");
    }
  });

  it("signal 为 null 也不抛错（仅靠快照证据分类）", () => {
    const snap = healthySnapshot();
    snap.layers.channel.detail.tunnelUp = false;
    assert.equal(classifySignal(null, snap).rootCause, "channel");
  });

  it("channel.detail 缺字段不误判为通道断（undefined ≠ false）", () => {
    const out = classifySignal(SIGNAL, { layers: { channel: { level: "waiting", detail: {} } } });
    assert.equal(out.rootCause, "unknown");
  });

  it("agentsStatus 条目为 null / 非对象时跳过而非抛错", () => {
    const out = classifySignal(SIGNAL, {
      layers: {},
      agentsStatus: { codex: null, weird: "not-an-object", ok: { health: "ready" } },
    });
    assert.equal(out.rootCause, "unknown");
  });
});

describe("deriveTriageView", () => {
  it("空输入产出全无证据视图", () => {
    const view = deriveTriageView(null, null);
    assert.equal(view.accountFaults.size, 0);
    assert.equal(view.credentialExpired, false);
    assert.equal(view.authPending, false);
    assert.equal(view.channelDown, false);
    assert.equal(view.channelOk, false);
    assert.equal(view.upstreamDegraded, false);
  });
});
