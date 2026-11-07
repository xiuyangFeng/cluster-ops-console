import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SIGNAL_RULES, createSignalEngine, detectAccountFault } from "./log-signals.mjs";

const REVOKED_LINE = 'unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑"}}';
const BANNED_LINE = 'unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用"}}';

describe("SIGNAL_RULES", () => {
  it("包含全部规则且 id 唯一", () => {
    const ids = SIGNAL_RULES.map((r) => r.id);
    assert.deepEqual(new Set(ids).size, ids.length);
    for (const id of ["account-revoked", "account-banned", "rate-limited", "request-timeout", "connection-reset", "http-5xx", "gateway-unhealthy", "connect-deny"]) {
      assert.ok(ids.includes(id), `缺少规则 ${id}`);
    }
  });
});

describe("createSignalEngine.scan", () => {
  it("账号解绑行触发 account-revoked（code 与 status 同行才判定）", () => {
    const t = 1000;
    const engine = createSignalEngine({ now: () => t });
    const { newSignals } = engine.scan("reclaude-logs", REVOKED_LINE);
    assert.equal(newSignals.length, 1);
    assert.equal(newSignals[0].id, "account-revoked");
    assert.equal(newSignals[0].category, "account");
    assert.equal(newSignals[0].severity, "error");
    assert.equal(newSignals[0].sourceId, "reclaude-logs");
  });

  it("裸 401 无故障 code 不误报（宁可漏报不可误报）", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const { newSignals } = engine.scan("reclaude-logs", "unexpected status 401: something else");
    assert.equal(newSignals.length, 0);
  });

  it("同一行第二轮重复出现不再触发（行级去重）", () => {
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    assert.equal(engine.scan("reclaude-logs", REVOKED_LINE).newSignals.length, 1);
    t += 10000;
    const second = engine.scan("reclaude-logs", REVOKED_LINE);
    assert.equal(second.newSignals.length, 0);
    assert.equal(second.newLineCount, 0);
  });

  it("新行内容在冷却窗口内命中同一规则不重复上报，窗口过后再报", () => {
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    assert.equal(engine.scan("reclaude-logs", `${REVOKED_LINE} attempt=1`).newSignals.length, 1);
    t += 60000; // 冷却窗口(300000ms)内
    assert.equal(engine.scan("reclaude-logs", `${REVOKED_LINE} attempt=2`).newSignals.length, 0);
    t += 300001; // 冷却窗口外
    assert.equal(engine.scan("reclaude-logs", `${REVOKED_LINE} attempt=3`).newSignals.length, 1);
  });

  it("不同源独立冷却", () => {
    const t = 1000;
    const engine = createSignalEngine({ now: () => t });
    assert.equal(engine.scan("reclaude-logs", REVOKED_LINE).newSignals.length, 1);
    assert.equal(engine.scan("other-src", REVOKED_LINE).newSignals.length, 1);
  });

  it("429 触发 rate-limited(warn)；ECONNRESET 触发 connection-reset", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const a = engine.scan("reclaude-logs", "request failed with status 429 rate limited").newSignals;
    assert.equal(a.length, 1);
    assert.equal(a[0].id, "rate-limited");
    assert.equal(a[0].severity, "warn");
    const b = engine.scan("reclaude-logs", "stream error: read ECONNRESET").newSignals;
    assert.equal(b.length, 1);
    assert.equal(b[0].id, "connection-reset");
  });

  it("request timeout 需要请求上下文限定词，普通句子不误报", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    assert.equal(engine.scan("s", "upstream request timeout after 30000ms").newSignals.length, 1);
    assert.equal(engine.scan("s", "set idle timeout config to 5m").newSignals.length, 0);
  });

  it("http-5xx：unexpected status 502 触发", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const hits = engine.scan("s", "unexpected status 502: bad gateway").newSignals;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "http-5xx");
  });

  it("仅真实代理 connect-deny 行触发，普通提及或缺字段不误报", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const hit = engine.scan("local-proxy-log", "[proxy] connect-deny host=api.relay-demo.example port=9443").newSignals;
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, "connect-deny");
    assert.equal(hit[0].severity, "error");
    assert.equal(engine.scan("local-proxy-log", "documentation says connect-deny host=api.relay-demo.example port=9443").newSignals.length, 0);
    assert.equal(engine.scan("local-proxy-log", "[proxy] connect-deny target=api.relay-demo.example port=9443").newSignals.length, 0);
    assert.equal(engine.scan("local-proxy-log", "[proxy] connect-deny host=api.relay-demo.example").newSignals.length, 0);
  });

  it("snapshot 源：gateway.healthy=false 触发 gateway-unhealthy；true 不触发；坏 JSON 不炸", () => {
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    const bad = engine.scan("reclaude-state", JSON.stringify({ gateway: { healthy: false } }), { snapshot: true });
    assert.equal(bad.newSignals.length, 1);
    assert.equal(bad.newSignals[0].id, "gateway-unhealthy");
    t += 300001;
    const ok = engine.scan("reclaude-state", JSON.stringify({ gateway: { healthy: true } }), { snapshot: true });
    assert.equal(ok.newSignals.length, 0);
    assert.doesNotThrow(() => engine.scan("reclaude-state", "{broken json", { snapshot: true }));
  });

  it("sample 字段在写入 active 表前脱敏，避免敏感 token 经未鉴权只读 API 原样透出", () => {
    // sample 会直接流入 layers.signals.active[]/lite.activeSignals[]，由未鉴权的
    // GET /api/status、/api/status-lite、SSE status 事件原样输出——含 Bearer token 的
    // 日志行必须在进入 active 表之前就脱敏。
    const engine = createSignalEngine({ now: () => 1000 });
    const line = ("upstream request timeout: Authorization: Bearer sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345 connect failed");
    const { newSignals } = engine.scan("reclaude-logs", line);
    assert.equal(newSignals.length, 1);
    assert.equal(newSignals[0].id, "request-timeout");
    assert.doesNotMatch(newSignals[0].sample, /sk-proj-|Bearer sk-/, "敏感 token 不得原样出现在 sample 里");
    assert.match(newSignals[0].sample, /\[REDACTED\]/, "脱敏后应留下 [REDACTED] 占位");

    // getActiveSignals() 返回的 active 表条目同样是脱敏后的 sample（同一份 hit 对象）。
    const active = engine.getActiveSignals().find((s) => s.id === "request-timeout");
    assert.ok(active);
    assert.doesNotMatch(active.sample, /sk-proj-/);
  });

  it("snapshot 源不做行级去重：故障持续存在时冷却窗口过后能再次上报", () => {
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    const state = JSON.stringify({ gateway: { healthy: false } });
    assert.equal(engine.scan("reclaude-state", state, { snapshot: true }).newSignals.length, 1);
    t += 300001;
    assert.equal(engine.scan("reclaude-state", state, { snapshot: true }).newSignals.length, 1);
  });
});

describe("getActiveSignals", () => {
  it("契约：同一规则跨源命中归并为一条——firstSeenAt 取最早命中，sourceId 取最近命中源", () => {
    // 所有日志源都是同一台主服务器上同一故障的不同观察面：同一故障类型（rule.id）
    // 不因出现在两个日志里就显示两条。此测试把该归并行为固定为明示契约。
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    engine.scan("reclaude-logs", REVOKED_LINE);
    t = 5000; // 不同源冷却独立，第二源无需等冷却窗口
    engine.scan("reclaude-state", REVOKED_LINE);
    const active = engine.getActiveSignals().filter((s) => s.id === "account-revoked");
    assert.equal(active.length, 1, "同一规则跨源命中只保留一条 active 条目");
    assert.equal(active[0].firstSeenAt, 1000, "firstSeenAt 是跨源最早命中时刻");
    assert.equal(active[0].lastSeenAt, 5000);
    assert.equal(active[0].sourceId, "reclaude-state", "sourceId 是最近一次命中的源");
  });

  it("TTL 内保留、超时移除；error 排在 warn 前", () => {
    let t = 1000;
    const engine = createSignalEngine({ now: () => t });
    engine.scan("s", "request failed with status 429 rate limited");
    engine.scan("s", REVOKED_LINE);
    let active = engine.getActiveSignals();
    assert.equal(active.length, 2);
    assert.equal(active[0].severity, "error");
    t += 600001;
    active = engine.getActiveSignals();
    assert.equal(active.length, 0);
  });
});

// ---- :30 抖动采样规则（2026-07-02 v2 终审跟进：采样取证，不是告警）----
// 生产观察：每小时 :30 (CST) 有一次约 6s 的探测超时抖动，单次、下轮即恢复、来源未明。
// 该规则只负责取证：命中探测超时类日志行时在 sample 里固化命中分钟数，便于人工
// 统计是否集中在 :30±2。绝不能升级为告警：info 级（新增的最低级）、非 account
// 类目（不触发 forceRun）、不进红条（红条只认 severity==="error"）。

describe("probe-timeout-sample 采样规则", () => {
  it("规则存在：info 级（最低）、非 account 类目（不触发 forceRun 路径）", () => {
    const rule = SIGNAL_RULES.find((r) => r.id === "probe-timeout-sample");
    assert.ok(rule, "缺少 probe-timeout-sample 采样规则");
    assert.equal(rule.severity, "info");
    assert.notEqual(rule.category, "account", "account 类目会触发 reclaude forceRun，采样规则绝不能用");
  });

  it("命中探测超时行：sample 带 [minute=NN] 前缀（取命中时刻的本地分钟数）", () => {
    // 12:30:05 本地时间 → minute=30
    const ts = new Date(2026, 6, 28, 12, 30, 5).getTime();
    const engine = createSignalEngine({ now: () => ts });
    const { newSignals } = engine.scan("ops-logs", "probe primary-remote failed: timeout after 6000ms");
    const hit = newSignals.find((s) => s.id === "probe-timeout-sample");
    assert.ok(hit, "探测超时行应命中采样规则");
    assert.match(hit.sample, /\[minute=30\]/, "sample 必须固化命中分钟数供人工统计");
  });

  it("中文'探测超时'措辞同样命中且分钟数正确", () => {
    const ts = new Date(2026, 6, 28, 3, 7, 0).getTime();
    const engine = createSignalEngine({ now: () => ts });
    const { newSignals } = engine.scan("ops-logs", "负载探测超时 (ssh exit -)");
    const hit = newSignals.find((s) => s.id === "probe-timeout-sample");
    assert.ok(hit);
    assert.match(hit.sample, /\[minute=07\]/, "分钟数固定两位便于逐行对齐统计");
  });

  it("sample 仍走 redactSensitive 契约：带 token 的超时行脱敏后保留 minute 前缀", () => {
    const ts = new Date(2026, 6, 28, 12, 31, 0).getTime();
    const engine = createSignalEngine({ now: () => ts });
    const line = ("probe endpoint timeout after 6000ms Authorization: Bearer sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345");
    const { newSignals } = engine.scan("ops-logs", line);
    const hit = newSignals.find((s) => s.id === "probe-timeout-sample");
    assert.ok(hit);
    assert.doesNotMatch(hit.sample, /sk-proj-/, "采样 sample 同样不得泄露敏感 token");
    assert.match(hit.sample, /\[minute=31\]/);
  });

  it("普通含 timeout 字样但非探测超时的行不命中采样规则（避免噪音淹没取证样本）", () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const hits = engine.scan("ops-logs", "set idle timeout config to 5m").newSignals;
    assert.equal(hits.filter((s) => s.id === "probe-timeout-sample").length, 0);
  });

  it("getActiveSignals 排序：info 排在 error/warn 之后（不抢占告警展示位）", () => {
    const t = new Date(2026, 6, 28, 12, 30, 0).getTime();
    const engine = createSignalEngine({ now: () => t });
    engine.scan("s", "probe timeout after 6000ms");
    engine.scan("s", "request failed with status 429 rate limited");
    engine.scan("s", REVOKED_LINE);
    const active = engine.getActiveSignals();
    assert.equal(active[0].severity, "error");
    assert.equal(active.at(-1).severity, "info");
  });

  it("冷却 key 仍是 ruleId:sourceId：不同源独立采样", () => {
    const ts = new Date(2026, 6, 28, 12, 30, 0).getTime();
    const engine = createSignalEngine({ now: () => ts });
    assert.equal(engine.scan("src-a", "probe timeout after 6000ms").newSignals.length, 1);
    assert.equal(engine.scan("src-b", "probe timeout after 6000ms").newSignals.length, 1);
  });
});

describe("detectAccountFault 兼容", () => {
  it("语义与旧实现逐字一致（整段文本、code+status 双匹配）", () => {
    assert.equal(detectAccountFault(REVOKED_LINE, ""), "revoked");
    assert.equal(detectAccountFault("", BANNED_LINE), "banned");
    // code 与 status 分处两个参数也要能判定（整段拼接语义）
    assert.equal(detectAccountFault("device_revoked", 'status 401'), "revoked");
    assert.equal(detectAccountFault("unexpected status 401", ""), null);
    assert.equal(detectAccountFault("", ""), null);
  });
});
