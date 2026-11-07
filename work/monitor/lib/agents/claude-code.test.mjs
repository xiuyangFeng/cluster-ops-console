import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { bus, EVENTS } from "../event-bus.mjs";
import { applyModulePreferences } from "../modules/catalog.mjs";
import { createProbeScheduler } from "../probe-scheduler.mjs";
import { createStateStore } from "../state-store.mjs";
import { CLAUDE_CODE_PROBE_ID, claudeCodeAdapter } from "./claude-code.mjs";
import { codexAdapter } from "./codex.mjs";
import { adapterForAgent, adapterForProbeId, enabledAgentProbeIds, listAgentAdapters } from "./registry.mjs";
import { STEADY_ACTIVE_INTERVAL_MS, STEADY_AFTER_OK_STREAK, STEADY_IDLE_INTERVAL_MS, STEADY_PROBE_IDS } from "./steady-interval.mjs";

// 2026-10-07 只读核实 myserver（kai）的真实探测输出（--version 段与 curl 段为同日实测值）。
const CY_OUTPUT = [
  "__CLI_BEGIN__",
  "user=kai",
  "keys.env=",
  "claude.installed=1",
  "claude.command=/public/newhome/kai/.local/bin/claude",
  "claude.path=/public/newhome/kai/.local/share/claude/versions/2.1.292",
  "claude.versionCached=1",
  "claude.version=2.1.292 (Claude Code)",
  "claude.npmGlobal=0",
  "claude.oauth=1",
  "claude.subscription=max",
  "claude.settingsEnv=",
  "claude.baseUrl=",
  "claude.apiKeyHelper=0",
  "claude.reclaude=1",
  "claude.primaryApiKey=0",
  "endpoint=401 0.361395",
  "__CLI_END__",
].join("\n");

function ctxWith(stdout, calls = []) {
  const server = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
  return {
    getConfig: async () => ({ servers: [server] }),
    getMainServerConfig: () => server,
    sshArgsFor: () => ["-o", "BatchMode=yes", "myserver"],
    probeSshFailureReason: (code) => `ssh exit ${code}`,
    execCollector: async (invocation) => {
      calls.push(invocation);
      return { code: stdout ? 0 : 255, stdout, stderr: stdout ? "" : "Connection refused" };
    },
  };
}

const runProbe = (ctx) => claudeCodeAdapter.probeSpecs(ctx).find((s) => s.id === CLAUDE_CODE_PROBE_ID).run();

test("注册：kind claude-code、探针 id 进入启用适配器探针集合（按配置门控）", () => {
  assert.equal(adapterForProbeId("claude-code"), claudeCodeAdapter);
  assert.equal(adapterForAgent({ id: "claude-code", kind: "claude-code" }), claudeCodeAdapter);
  const cfg = applyModulePreferences(normalizeAgentConfig({ agents: [{ id: "claude-code", name: "Claude Code", kind: "claude-code" }], servers: [] }));
  assert.ok(enabledAgentProbeIds(cfg).includes("claude-code"));
  const off = applyModulePreferences({ ...cfg, agents: cfg.agentCatalog, disabledModules: ["agent:claude-code"] });
  assert.ok(!enabledAgentProbeIds(off).includes("claude-code"));
  assert.ok(!enabledAgentProbeIds(normalizeAgentConfig({ servers: [] })).includes("claude-code"), "团队配置没有该条目时零足迹");
});

test("探针：一次 SSH，脚本走 stdin，只探 Claude、带本人端口做连通性；kai 实测输出 → 就绪", async () => {
  const calls = [];
  const result = await runProbe(ctxWith(CY_OUTPUT, calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "ssh");
  assert.equal(calls[0].args.at(-1), "env CT_CLI_IDS='claude' CT_ENDPOINT_PORT='7891' sh -s");
  assert.match(calls[0].input, /^#!\/bin\/sh/);
  assert.equal(result.level, "ok");
  assert.equal(result.reason, "Claude Code 2.1.292 就绪（Max 订阅 · 经 ReClaude 代理）");
  const status = claudeCodeAdapter.buildStatus({ last: result.data });
  assert.equal(status.health, "ready");
  assert.equal(status.version, "2.1.292");
  assert.equal(status.kind, "native");
  assert.equal(status.login, "subscription");
  assert.equal(status.loggedIn, true);
  assert.equal(status.managedBy, "reclaude");
  assert.deepEqual(status.endpoint, { ok: true, latencyMs: 361, httpCode: 401, output: "HTTP 401" });
  assert.match(status.output, /Claude Code 2\.1\.292 · 原生安装/);
  assert.match(status.output, /curl -x http:\/\/127\.0\.0\.1:7891/);
});

test("判级：未安装 → 中性 not-installed / 探针 ok；未登录 → auth-required / warn；端点不可达 → degraded / warn", async () => {
  const missing = await runProbe(ctxWith("__CLI_BEGIN__\nclaude.installed=0\nendpoint=401 0.3\n__CLI_END__"));
  assert.equal(missing.level, "ok", "没装不是故障（只用 codex 的同事）");
  assert.equal(missing.reason, "Claude Code 未安装（可在 配置 → 命令行工具 安装）");
  const missingStatus = claudeCodeAdapter.buildStatus({ last: missing.data });
  assert.equal(missingStatus.health, "not-installed");
  assert.equal(missingStatus.degradedReason, null);
  assert.equal(missing.data.endpoint, null, "未安装不报连通性");

  const noLogin = await runProbe(ctxWith("__CLI_BEGIN__\nclaude.installed=1\nclaude.path=/h/.local/share/claude/versions/2.1.291\nclaude.version=2.1.291 (Claude Code)\nclaude.oauth=0\nendpoint=401 0.3\n__CLI_END__"));
  assert.equal(noLogin.level, "warn");
  const noLoginStatus = claudeCodeAdapter.buildStatus({ last: noLogin.data });
  assert.equal(noLoginStatus.health, "auth-required");
  assert.equal(noLoginStatus.loggedIn, false);

  const down = await runProbe(ctxWith(CY_OUTPUT.replace("endpoint=401 0.361395", "endpoint=000 10.002")));
  assert.equal(down.level, "warn");
  const downStatus = claudeCodeAdapter.buildStatus({ last: down.data });
  assert.equal(downStatus.health, "degraded");
  assert.equal(downStatus.degradedReason, "降级：Anthropic API 经隧道不可达");
  assert.equal(downStatus.endpoint.latencyMs, null, "失败时不给延迟（是超时值）");
});

test("SSH 没到远端：data 为空、保留上一轮事实；熔断轮只换占位输出", async () => {
  const fail = await runProbe(ctxWith(""));
  assert.equal(fail.level, "error");
  assert.equal(fail.data, null);
  assert.match(fail.reason, /ssh exit 255/);

  const state = claudeCodeAdapter.createInitialState();
  const helpers = { getPreviousStatus: () => ({ health: "ready", output: "旧" }) };
  const ok = await runProbe(ctxWith(CY_OUTPUT));
  assert.equal(claudeCodeAdapter.onProbeResult({ id: CLAUDE_CODE_PROBE_ID, result: ok, state, helpers }).status.health, "ready");
  assert.deepEqual(claudeCodeAdapter.onProbeResult({ id: CLAUDE_CODE_PROBE_ID, result: fail, state, helpers }), {});
  assert.equal(claudeCodeAdapter.buildStatus(state).health, "ready");
  const skipped = claudeCodeAdapter.onProbeResult({ id: CLAUDE_CODE_PROBE_ID, result: { level: "skipped" }, state, helpers });
  assert.equal(skipped.status.health, "ready");
  assert.match(skipped.status.output, /熔断/);
  assert.equal(claudeCodeAdapter.isSkipped(state), true);
  assert.deepEqual(claudeCodeAdapter.healthInputs(state), {}, "不参与全局健康聚合");
  assert.deepEqual(claudeCodeAdapter.legacyFields(state), {});
});

// ── 节奏（v2.57 评审后续）：与 codex doctor 同一套自适应口径，稳态不再 90 秒一次 SSH ──

test("节奏：间隔函数与 doctor 逐轮相同——连续 3 轮 ok 降到 5 分钟，warn / error / 熔断跳过立即回 90 秒", () => {
  const spec = claudeCodeAdapter.probeSpecs(ctxWith(CY_OUTPUT)).find((s) => s.id === CLAUDE_CODE_PROBE_ID);
  const doctor = codexAdapter.probeSpecs({}).find((s) => s.id === "doctor");
  assert.equal(typeof spec.intervalMs, "function");
  const levels = ["ok", "ok", "ok", "ok", "warn", "ok", "ok", "skipped", "ok", "ok", "ok", "error", "ok"];
  const got = levels.map((level) => spec.intervalMs({ level }));
  assert.deepEqual(got, [90000, 90000, 300000, 300000, 90000, 90000, 90000, 90000, 90000, 90000, 300000, 90000, 90000]);
  assert.deepEqual(got, levels.map((level) => doctor.intervalMs({ level })), "两枚探针同一套口径");
  assert.deepEqual([STEADY_ACTIVE_INTERVAL_MS, STEADY_IDLE_INTERVAL_MS, STEADY_AFTER_OK_STREAK], [90000, 300000, 3]);
  assert.match(claudeCodeAdapter.moduleHint.cost, /稳态降到 5 分钟/);
  // 每次 probeSpecs() 一份独立计数
  const fresh = claudeCodeAdapter.probeSpecs(ctxWith(CY_OUTPUT))[0];
  assert.equal(fresh.intervalMs({ level: "ok" }), 90000);
});

test("节奏：走自适应间隔的适配器探针正是 STEADY_PROBE_IDS（通道恢复时插队补跑的名单）", () => {
  const adaptive = listAgentAdapters().flatMap((adapter) => adapter.probeSpecs({}).filter((s) => typeof s.intervalMs === "function").map((s) => s.id));
  assert.deepEqual(adaptive.sort(), [...STEADY_PROBE_IDS].sort());
  assert.ok(STEADY_PROBE_IDS.includes(CLAUDE_CODE_PROBE_ID));
});

// 真实调度器 + 假时钟：数 30 分钟里实际发出的 SSH 次数。
async function countSshRuns(stdout, { minutes = 30 } = {}) {
  let clock = 0;
  const scheduler = createProbeScheduler({ now: () => clock, jitterRatio: 0 });
  const launchedAt = [];
  const ctx = ctxWith(stdout);
  const exec = ctx.execCollector;
  ctx.execCollector = async (invocation) => {
    launchedAt.push(clock / 1000);
    return exec(invocation);
  };
  const [spec] = claudeCodeAdapter.probeSpecs(ctx);
  scheduler.registerProbe({ layer: "agents", usesSsh: true, hostKey: "myserver", ...spec });
  for (; clock <= minutes * 60000; clock += 1000) {
    scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return launchedAt;
}

test("节奏：就绪稳态 30 分钟只发 8 次 SSH（固定 90 秒是 21 次）；没装同样降频；端点不通保持 90 秒", async () => {
  assert.deepEqual(await countSshRuns(CY_OUTPUT), [0, 90, 180, 480, 780, 1080, 1380, 1680]);
  // 没装是中性的 ok：只用 codex 的同事不该为一个没装的 CLI 每 90 秒付一次 SSH
  assert.equal((await countSshRuns("__CLI_BEGIN__\nclaude.installed=0\n__CLI_END__")).length, 8);
  const down = await countSshRuns(CY_OUTPUT.replace("endpoint=401 0.361395", "endpoint=000 10.002"));
  assert.equal(down.length, 21);
  assert.deepEqual(down.slice(0, 4), [0, 90, 180, 270]);
});

test("状态仓端到端：启用时合成 agentsStatus['claude-code'] 与层级；概览带版本与登录方式", async () => {
  const config = applyModulePreferences(normalizeAgentConfig({
    activeServerId: "server-01",
    servers: [{ id: "server-01", host: "myserver", remotePort: 7891 }],
    agents: [{ id: "claude-code", name: "Claude Code", kind: "claude-code" }],
  }));
  const store = createStateStore({ config });
  try {
    assert.equal(store.getLegacyStatus().agentsStatus["claude-code"].health, "waiting");
    const result = await runProbe(ctxWith(CY_OUTPUT));
    const checkedAt = Date.now();
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: CLAUDE_CODE_PROBE_ID,
      layer: "agents",
      result: { ...result, checkedAt, nextCheckAt: checkedAt + 90000, durationMs: 5, error: false, probeContext: { serverId: "server-01" } },
    });
    const legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus["claude-code"].health, "ready");
    assert.equal(legacy.agentsStatus["claude-code"].loginDetail, "Max 订阅 · 经 ReClaude 代理");
    assert.equal(store.getLayers().agents["claude-code"].level, "ok");
    assert.ok(legacy.agentsOverview.some((a) => a.id === "claude-code" && a.health === "ready"));
  } finally {
    store.dispose();
  }
});
