// v2.57：官方 CLI 没装是中性状态——组里很多人只用 codex 或只用 Claude。
// 端到端：真实适配器探针 run（假 SSH）→ 真实状态仓 → 真实事件观察者 + 事件存储（无打开门槛，
// 任何一次立案都会立刻可见）。未安装 → 不立案、不计入注意力、整体健康不降级；已安装连不通 → 照常告警。
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { createIncidentObservers } from "../../server/incident-sync.mjs";
import { bus, EVENTS } from "../event-bus.mjs";
import { createIncidentStore } from "../incidents/store.mjs";
import { applyModulePreferences } from "../modules/catalog.mjs";
import { createStateStore } from "../state-store.mjs";
import { claudeCodeAdapter } from "./claude-code.mjs";
import { CODEX_NOT_INSTALLED_MARKER, codexAdapter } from "./codex.mjs";

const SERVER = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };

const CLAUDE_MISSING = "__CLI_BEGIN__\nclaude.installed=0\nendpoint=401 0.3\n__CLI_END__\n";
const CLAUDE_UNREACHABLE = [
  "__CLI_BEGIN__",
  "claude.installed=1",
  "claude.path=/h/.local/share/claude/versions/2.1.292",
  "claude.version=2.1.292 (Claude Code)",
  "claude.oauth=1",
  "claude.subscription=max",
  "endpoint=000 10.002",
  "__CLI_END__",
].join("\n");
// codex 没装：doctor 命令 127，安装态检查打出标记（auth 段为空）。
const CODEX_MISSING = `bash: codex: command not found\n${CODEX_NOT_INSTALLED_MARKER}\n__CODEX_AUTH_BEGIN__\n__CODEX_AUTH_END__\n`;

function adapterCtx(reply) {
  return {
    getConfig: async () => ({ servers: [SERVER] }),
    getMainServerConfig: () => SERVER,
    sshArgsFor: () => ["myserver"],
    probeSshFailureReason: (code) => `ssh exit ${code}`,
    execFileCmd: async (_cmd, args) => reply(args.at(-1)),
    execCollector: async (invocation) => reply(invocation.args.at(-1)),
  };
}

function setup() {
  const config = applyModulePreferences(normalizeAgentConfig({
    activeServerId: "server-01",
    servers: [SERVER],
    agents: [{ id: "claude-code", name: "Claude Code", kind: "claude-code" }],
  }));
  const store = createStateStore({ config });
  const incidentStore = createIncidentStore({ openGate: {} });
  const observers = createIncidentObservers({
    store,
    incidentStore,
    getMergedConfig: () => config,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  });
  bus.on(EVENTS.PROBE_UPDATED, observers.onProbeUpdated);
  bus.on(EVENTS.STATUS_CHANGED, observers.onStatusChanged);
  let clock = Date.now();
  const emit = (id, result) => {
    clock += 30_000;
    bus.emit(EVENTS.PROBE_UPDATED, {
      id,
      layer: "agents",
      result: { ...result, checkedAt: clock, nextCheckAt: clock + 90_000, durationMs: 5, error: false, probeContext: { serverId: "server-01" } },
    });
  };
  const dispose = () => {
    bus.off(EVENTS.PROBE_UPDATED, observers.onProbeUpdated);
    bus.off(EVENTS.STATUS_CHANGED, observers.onStatusChanged);
    store.dispose();
  };
  return { store, incidentStore, emit, dispose };
}

async function runSpecs(adapter, reply) {
  const specs = adapter.probeSpecs(adapterCtx(reply));
  const out = [];
  for (const spec of specs) out.push([spec.id, await spec.run()]);
  return out;
}

test("未安装（codex 与 Claude Code 都没装）：中性 not-installed，不立案、不计入注意力、整体健康不降级", async () => {
  const h = setup();
  try {
    const healthBefore = h.store.getLegacyStatus().health;
    for (let round = 0; round < 4; round += 1) {
      for (const [id, result] of await runSpecs(codexAdapter, () => ({ code: 127, stdout: CODEX_MISSING, stderr: "" }))) {
        assert.equal(result.level, "ok", `${id}：未安装不是探针失败`);
        h.emit(id, result);
      }
      for (const [id, result] of await runSpecs(claudeCodeAdapter, () => ({ code: 0, stdout: CLAUDE_MISSING, stderr: "" }))) {
        assert.equal(result.level, "ok");
        h.emit(id, result);
      }
    }
    const legacy = h.store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.codex.health, "not-installed");
    assert.equal(legacy.agentsStatus["claude-code"].health, "not-installed");
    const layers = h.store.getLayers();
    assert.equal(layers.agents.codex.level, "skipped");
    assert.equal(layers.agents["claude-code"].level, "skipped");
    assert.match(layers.agents["claude-code"].reason, /未安装/);
    assert.equal(h.incidentStore.counts().open, 0, "不立案");
    assert.equal(h.incidentStore.query({ state: "open" }).incidents.length, 0);
    assert.equal(legacy.summary.agentCounts.attention, 0, "不计入注意力");
    assert.equal(legacy.health, healthBefore, "整体健康不因未安装而变化");
    assert.equal(legacy.endpoint.ok, null, "codex 没装时端点检测暂停，不报不可达");
    const stage = legacy.bridgeStages?.["agent-endpoint"];
    assert.ok(!stage || (stage.consecutiveFailures === 0 && stage.lastSuccessAt == null), "数据链路「Agent 端点」一段不写结论（保持「尚无数据」）");
    const readiness = legacy.readiness?.agents?.["claude-code"];
    if (readiness) assert.notEqual(readiness.runtime?.state, "fail");
  } finally {
    h.dispose();
  }
});

test("已安装但连不通：照常告警（degraded → 立案、计入注意力）", async () => {
  const h = setup();
  try {
    for (let round = 0; round < 3; round += 1) {
      for (const [id, result] of await runSpecs(claudeCodeAdapter, () => ({ code: 0, stdout: CLAUDE_UNREACHABLE, stderr: "" }))) {
        assert.equal(result.level, "warn");
        h.emit(id, result);
      }
    }
    const legacy = h.store.getLegacyStatus();
    assert.equal(legacy.agentsStatus["claude-code"].health, "degraded");
    assert.equal(h.store.getLayers().agents["claude-code"].level, "warn");
    assert.equal(legacy.summary.agentCounts.attention, 1);
    const open = h.incidentStore.query({ state: "open" }).incidents;
    assert.ok(open.some((incident) => incident.agentId === "claude-code" && incident.component === "agent"), "Claude Code 立案");
  } finally {
    h.dispose();
  }
});

test("从未安装到装上：下一轮 doctor 即恢复正常检测（端点探针不再跳过）", async () => {
  const replies = [{ code: 127, stdout: CODEX_MISSING, stderr: "" }];
  const calls = [];
  const specs = codexAdapter.probeSpecs(adapterCtx((cmd) => {
    calls.push(cmd);
    return replies.shift() || { code: 0, stdout: "HTTP/2 401\nrtt=0.3\n", stderr: "" };
  }));
  const doctor = specs.find((s) => s.id === "doctor");
  const endpoint = specs.find((s) => s.id === "endpoint");
  assert.equal((await doctor.run()).data.notInstalled, true);
  const skipped = await endpoint.run();
  assert.equal(skipped.data.ok, null);
  assert.equal(calls.length, 1, "没装时端点探针不发 SSH");
  replies.push({ code: 0, stdout: "18 ok | 0 warn | 0 fail\n__CODEX_AUTH_BEGIN__\n__CODEX_AUTH_END__\n", stderr: "" });
  const installed = await doctor.run();
  assert.equal(installed.data.notInstalled, undefined);
  assert.equal(installed.level, "ok");
  await endpoint.run();
  assert.equal(calls.length, 3, "装上后端点探针恢复");
  assert.match(calls[0], /test -x "\$HOME\/\.local\/bin\/codex" \|\| command -v codex/);
});
