// v2.54：没领反向端口时界面显示"未领取"，绝不回落成 7891（那是别人的端口）。
import assert from "node:assert/strict";
import test from "node:test";

import { chainDetailHtml } from "./render/chain.js";
import { buildChainDetail, buildChainModel, UNCLAIMED_PORT_TEXT, validationRoundTrip } from "./render/chain-model.js";
import { buildChecklistModel, getDiagnosticMsg, shouldShowOnboarding } from "./render/checklist.js";
import { buildSignalBanner } from "./render/signal-banner.js";
import { buildValidationSummary, buildValidationSummaryLabel, sortValidationItems } from "./render/validation-model.js";

const NOW = 1_800_000_000_000;

// 同事刚装好、还没领端口：代理起来了，隧道没有（supervisor 不为它建隧道）。
const unclaimed = {
  health: "down",
  shouldBeRunning: true,
  supervisorUp: true,
  localProxyUp: true,
  tunnelUp: false,
  remotePortOpen: false,
  activeServerId: "server-01",
  activeServer: { id: "server-01", name: "主集群服务器 (myserver)", host: "myserver", localPort: 8888 },
  serversBrief: { "server-01": { ok: true, name: "主集群服务器 (myserver)" } },
  networkChannel: { host: "myserver", localProxyUrl: "http://127.0.0.1:8888", remoteProxyUrl: null },
  onboarding: "partial",
  onboardingReason: "missing-port",
  setupCommand: "npm run setup",
  layers: {
    validation: {
      "server-01": {
        level: "ok",
        reason: "已验证 2 项，失败 0 项，跳过 1 项",
        checkedAt: NOW - 60_000,
        items: [
          { key: "remoteProxyTest", ok: null, skipped: "missing-port", durationMs: 0, output: "未领取反向端口，跳过经隧道出网测试" },
          { key: "agentVersion:codex", ok: true, durationMs: 300, output: "codex 0.160.1" },
          { key: "workspaceSmokeCommand", ok: true, durationMs: 120, output: "workspace ready" },
        ],
      },
    },
  },
};

test("链路主干：远端节点写「主机 · 未领取端口」，不出现任何端口号", () => {
  const model = buildChainModel(unclaimed);
  const remote = model.nodes.find((n) => n.key === "remote");
  assert.equal(remote.sub, `myserver · ${UNCLAIMED_PORT_TEXT}`);
  assert.ok(!JSON.stringify(model).includes("7891"));
  // 有端口时照旧「主机:端口」
  const claimed = buildChainModel({ ...unclaimed, activeServer: { ...unclaimed.activeServer, remotePort: 7892 } });
  assert.equal(claimed.nodes.find((n) => n.key === "remote").sub, "myserver:7892");
});

test("链路主干：没领端口时隧道 / 远端画成灰色 setup（不是红色中断），phase=setup；后端 summary 给 setup 时同样", () => {
  for (const status of [unclaimed, { ...unclaimed, summary: { transport: { state: "setup" } } }]) {
    const model = buildChainModel(status);
    const states = Object.fromEntries(model.nodes.map((n) => [n.key, n.state]));
    assert.equal(states.tunnel, "setup");
    assert.equal(states.remote, "setup");
    assert.equal(model.phase, "setup");
    assert.ok(!model.nodes.some((n) => n.state === "error"));
  }
  // 领了端口、隧道真断：照旧红色中断
  const broken = buildChainModel({ ...unclaimed, activeServer: { ...unclaimed.activeServer, remotePort: 7892 } });
  assert.equal(broken.nodes.find((n) => n.key === "tunnel").state, "error");
});

test("卡顿红条：分诊为 setup 的信号不出红条，其它 error 信号照旧", () => {
  const setupSignal = { id: "request-timeout", severity: "error", rootCause: "setup", title: "请求超时" };
  assert.equal(buildSignalBanner([setupSignal]), null);
  assert.ok(buildSignalBanner([setupSignal, { ...setupSignal, rootCause: "channel" }]));
});

test("远端节点详情：说明没领端口、远端监听标「未领取端口」，跳过的校验项画成灰色而不是失败", () => {
  const model = buildChainModel(unclaimed);
  const detail = buildChainDetail(unclaimed, model, "remote@server-01", { nowMs: NOW });
  assert.match(detail.desc, /还没领取反向端口/);
  const facts = Object.fromEntries(detail.facts.map((f) => [f.label, f.value.map((v) => (typeof v === "string" ? v : v.b)).join("")]));
  assert.equal(facts.远端监听, UNCLAIMED_PORT_TEXT);
  assert.match(facts.经隧道往返, /未领取端口/);
  assert.match(facts.环境校验, /2\/2 通过 · .*跳过 1 项/);
  assert.equal(detail.checks.at(-1).key, "remoteProxyTest", "跳过项垫底");
  assert.equal(detail.checks.at(-1).skipped, true);
  assert.ok(!JSON.stringify(detail).includes("7891"));
  const html = chainDetailHtml(detail);
  assert.match(html, /data-ok="skip"/);
  assert.match(html, /未领取端口/);
  assert.equal(validationRoundTrip(unclaimed, "server-01"), null, "没跑过就没有往返");
  // 整链诊断（diag）同样是"未领取"而不是"隧道断开"
  assert.match(detail.diag.title, /还没领取反向端口/);
});

test("横幅：missing-port 引导卡（打开接入引导领取并登记；打包 .app 与源码模式一致；自己加的服务器去服务器管理填）", () => {
  assert.equal(shouldShowOnboarding(unclaimed), true);
  const src = getDiagnosticMsg(unclaimed);
  assert.equal(src.title, "还没领取反向端口");
  assert.equal(src.action.kind, "open-guide");
  assert.equal(src.onboarding, true);
  assert.match(src.body, /会在集群上登记/);
  assert.ok(src.body.includes(src.action.label));
  assert.doesNotMatch(src.body, /npm run setup|终端/);
  assert.ok(!src.body.includes("7891"));
  const cmd = "CODEX_MONITOR_LOCAL_CONFIG_PATH='/d/config.local.json' npm run setup";
  assert.deepEqual(getDiagnosticMsg({ ...unclaimed, packaged: true, setupCommand: cmd }), src);
  // 个人服务器没有登记目录：查看中的是它且没端口时，引向服务器管理
  const personal = getDiagnosticMsg({ ...unclaimed, onboarding: "ready", onboardingReason: null, activeServer: { ...unclaimed.activeServer, source: "personal" } });
  assert.equal(personal.title, "还没填写反向端口");
  assert.equal(personal.action.kind, "open-settings");
});

test("横幅：onboarding 不是 missing-port（如查看中的是另一台没端口的团队服务器）时，down 分支也给「未领取」而不是隧道断开", () => {
  const other = { ...unclaimed, onboarding: "ready", onboardingReason: null };
  assert.equal(shouldShowOnboarding(other), false);
  const msg = getDiagnosticMsg(other);
  assert.equal(msg.title, "还没领取反向端口");
  // 仅监控的服务器本来就没有隧道，不算未领取
  const monitorOnly = getDiagnosticMsg({ ...other, activeServer: { ...other.activeServer, tunnel: false } });
  assert.notEqual(monitorOnly.title, "还没领取反向端口");
});

test("清单卡模型：远端卡显示「未领取」，没有通道信息时也不假设 7891", () => {
  const remote = buildChecklistModel(unclaimed).find((i) => i.key === "remote");
  assert.equal(remote.tag, "未领取");
  assert.match(remote.desc, /还没领取反向端口/);
  const bare = buildChecklistModel({ ...unclaimed, networkChannel: undefined }).find((i) => i.key === "remote");
  assert.equal(bare.tag, "未领取");
  const ok = buildChecklistModel({ ...unclaimed, remotePortOpen: true, networkChannel: { ...unclaimed.networkChannel, remoteProxyUrl: "http://127.0.0.1:7892" } }).find((i) => i.key === "remote");
  assert.equal(ok.tag, "7892 监听");
});

test("校验汇总：跳过项不进 total、不算失败，标签追加「跳过 N 项」；排序失败置顶、跳过垫底", () => {
  const items = [
    { key: "skip", skipped: "missing-port", ok: null },
    { key: "pass", ok: true, durationMs: 10 },
    { key: "fail", ok: false, durationMs: 20 },
  ];
  const summary = buildValidationSummary(items);
  assert.deepEqual([summary.total, summary.failCount, summary.passed, summary.skippedCount, summary.allOk], [2, 1, 1, 1, false]);
  assert.equal(buildValidationSummaryLabel(summary), "1/2 失败 · 最慢 fail 20ms · 跳过 1 项");
  assert.deepEqual(sortValidationItems(items).map((i) => i.key), ["fail", "pass", "skip"]);
  assert.equal(buildValidationSummaryLabel(buildValidationSummary([{ key: "a", ok: true, durationMs: 5 }])), "1/1 通过 · 最慢 a 5ms", "没有跳过项时文案逐字不变");
});
