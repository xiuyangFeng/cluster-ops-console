import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSignalEngine } from "./log-signals.mjs";
import { createSectionScanner } from "./log-tail-probe.mjs";

const REVOKED_LINE = 'unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑"}}';

// ---------------------------------------------------------------------------
// v2.18 零残留采集：scanSections 直接吃已解析的段落（collector 的 fast profile），
// 不自建 SSH 命令。
// ---------------------------------------------------------------------------

describe("createSectionScanner.scanSections", () => {
  it("命中账号行：level=error、onSignals 收到新信号与活跃列表", async () => {
    const calls = [];
    const scan = createSectionScanner({
      engine: createSignalEngine({ now: () => 1000 }),
      now: () => 1000,
      onSignals: (n, a) => calls.push({ n, a }),
    });
    const result = await scan({ "reclaude-logs": REVOKED_LINE, "reclaude-state": "" });
    assert.equal(result.level, "error");
    assert.equal(result.data.signals.length, 1);
    assert.equal(result.data.activeSignals[0].id, "account-revoked");
    assert.deepEqual(result.data.sourceIds, ["reclaude-logs", "reclaude-state"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].n[0].id, "account-revoked");
  });

  it("干净日志：level=ok、lastActivityAt 随新行推进", async () => {
    let t = 1000;
    const scan = createSectionScanner({ engine: createSignalEngine({ now: () => t }), now: () => t });
    const first = await scan({
      "reclaude-logs": "normal request done r1",
      "reclaude-state": '{"gateway":{"healthy":true}}',
    });
    assert.equal(first.level, "ok");
    assert.equal(first.data.lastActivityAt, 1000);
    t = 21000;
    const second = await scan({ "reclaude-logs": "normal request done r2", "reclaude-state": "" });
    assert.equal(second.data.lastActivityAt, 21000);
  });

  it("同样的尾巴重复抓取不推进 lastActivityAt、不重复报信号", async () => {
    let t = 1000;
    const calls = [];
    const scan = createSectionScanner({
      engine: createSignalEngine({ now: () => t }),
      now: () => t,
      onSignals: (n) => calls.push(n),
    });
    const sections = { "reclaude-logs": `normal request done once\n${REVOKED_LINE}`, "reclaude-state": "" };
    await scan(sections);
    t = 31000;
    const second = await scan(sections);
    assert.equal(second.data.lastActivityAt, 1000);
    assert.equal(second.data.signals.length, 0);
    assert.equal(calls.length, 1);
  });

  it("仅 info 级采样信号活跃时探针 level 仍为 ok（采样取证不得升级面板状态）", async () => {
    // probe-timeout-sample 是 :30 抖动取证规则：只进 activeSignals 供人工统计，
    // 不允许把 log-signals 探针面板从 ok 拉成 warn/error（那是告警语义）。
    const ts = new Date(2026, 6, 28, 12, 30, 5).getTime();
    const scan = createSectionScanner({ engine: createSignalEngine({ now: () => ts }), now: () => ts });
    const result = await scan({
      "reclaude-logs": "probe primary-remote failed: timeout after 6000ms",
      "reclaude-state": "",
    });
    const sampleHits = result.data.activeSignals.filter((s) => s.id === "probe-timeout-sample");
    assert.equal(sampleHits.length, 1, "采样信号应进入 activeSignals 供取证");
    assert.match(sampleHits[0].sample, /\[minute=30\]/);
    assert.equal(result.level, "ok", "info 级采样信号不得把探针 level 升为 warn/error");
    assert.match(result.reason, /无异常信号|采样/, "reason 不应宣称存在活跃卡顿信号");
  });

  it("本地代理 connect-deny 来源接入信号层，且不影响远端来源", async () => {
    const scan = createSectionScanner({
      engine: createSignalEngine({ now: () => 1000 }),
      now: () => 1000,
      getLocalProxyLog: async () => "[proxy] connect-deny host=api.relay-demo.example port=9443",
    });
    const result = await scan({ "reclaude-logs": "normal", "reclaude-state": "" });
    assert.equal(result.level, "error");
    assert.equal(result.data.activeSignals[0].id, "connect-deny");
    assert.ok(result.data.sourceIds.includes("local-proxy-log"));
    assert.ok(result.data.sourceIds.includes("reclaude-logs"));
  });

  it("远端采集失败（remoteFailed）：level=error、error 标记、data=null、不产生信号", async () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const calls = [];
    const scan = createSectionScanner({ engine, now: () => 1000, onSignals: (n) => calls.push(n) });
    const result = await scan({}, { remoteFailed: true, failureReason: "ssh exit 255" });
    assert.equal(result.level, "error");
    assert.equal(result.error, true);
    assert.equal(result.data, null);
    assert.match(result.reason, /ssh exit 255/);
    assert.equal(calls.length, 0);
    assert.equal(engine.getActiveSignals().length, 0);
  });

  it("远端失败但本地有证据时不伪装为正常：仍 error，且带上远端失败原因", async () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const scan = createSectionScanner({
      engine,
      now: () => 1000,
      getLocalProxyLog: async () => "[proxy] connect-deny host=api.relay-demo.example port=9443",
    });
    const result = await scan({}, { remoteFailed: true, failureReason: "ssh exit 255" });
    assert.equal(result.level, "error");
    assert.match(result.reason, /ssh exit 255/);
    assert.equal(result.data.activeSignals[0].id, "connect-deny");
  });

  it("缺段（collector 只回了一段）不抛，缺的那段按空串扫描", async () => {
    const engine = createSignalEngine({ now: () => 1000 });
    const scan = createSectionScanner({ engine, now: () => 1000 });
    const result = await scan({ "reclaude-logs": "normal request done" });
    assert.equal(result.level, "ok");
    assert.deepEqual(result.data.sourceIds, ["reclaude-logs", "reclaude-state"]);
  });
});
