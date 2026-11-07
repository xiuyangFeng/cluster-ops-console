// v2.57 评审后续：装了，但非交互 SSH 的 PATH 里找不到——不是「未安装」。
//
// 把 codex / Claude Code 装在 nvm、npm 自定义前缀等只有交互 shell 才加进 PATH 的位置的人，工作台的 doctor
// 根本跑不起来（exit 127）。v2.57.0 把这种情况归进了中性的「未安装」（灰色、不计入注意力），PATH 问题被藏了
// 起来。现在：卡片黄色、根因行说出装在哪、计入注意力并立案；真没装的仍是中性。
// codex 这一路是真跑的：适配器拼出的远端命令原样交给本机 shell，在假 HOME 里执行（零 SSH）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { createIncidentObservers } from "../../server/incident-sync.mjs";
import { OFF_PATH_ADVICE, offPathDirGlobs } from "../cli/detect.mjs";
import { bus, EVENTS } from "../event-bus.mjs";
import { createIncidentStore } from "../incidents/store.mjs";
import { applyModulePreferences } from "../modules/catalog.mjs";
import { createStateStore } from "../state-store.mjs";
import { CLAUDE_CODE_PROBE_ID, claudeCodeAdapter } from "./claude-code.mjs";
import { CODEX_NOT_INSTALLED_MARKER, CODEX_OFF_PATH_MARKER, codexAdapter } from "./codex.mjs";

const SERVER = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
const NVM_CODEX = "~/.nvm/versions/node/v22.11.0/bin/codex";
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((file) => existsSync(file));
const skip = process.platform === "win32";

function writeExec(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// 适配器上下文：doctor 的远端命令在本机 shell 里真跑（假 HOME、最小 PATH——相当于非交互 SSH）；
// 端点探针的 curl 不真发，给一份「可达」的回显。
function realShellCtx(home, { shell = "/bin/sh", calls = [] } = {}) {
  const run = (command) => {
    calls.push(command);
    if (!command.includes("codex doctor")) return { code: 0, stdout: "HTTP/1.1 200 Connection Established\n\nHTTP/2 401\nrtt=0.3\n", stderr: "" };
    const res = spawnSync(shell, ["-c", command], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home }, timeout: 20000 });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return {
    getConfig: async () => ({ servers: [SERVER] }),
    getMainServerConfig: () => SERVER,
    sshArgsFor: () => ["myserver"],
    probeSshFailureReason: (code) => `ssh exit ${code}`,
    execFileCmd: async (_cmd, args) => run(args.at(-1)),
  };
}

// 真实状态仓 + 真实事件观察者与事件存储（无打开门槛：任何一次立案立刻可见）。
function setup() {
  const config = applyModulePreferences(normalizeAgentConfig({
    activeServerId: "server-01",
    servers: [SERVER],
    agents: [{ id: "claude-code", name: "Claude Code", kind: "claude-code" }],
  }));
  const store = createStateStore({ config });
  const incidentStore = createIncidentStore({ openGate: {} });
  const observers = createIncidentObservers({ store, incidentStore, getMergedConfig: () => config, getShouldBeRunning: () => true, isClosing: () => false });
  bus.on(EVENTS.PROBE_UPDATED, observers.onProbeUpdated);
  bus.on(EVENTS.STATUS_CHANGED, observers.onStatusChanged);
  let clock = Date.now();
  return {
    store,
    incidentStore,
    emit(id, result) {
      clock += 30_000;
      bus.emit(EVENTS.PROBE_UPDATED, { id, layer: "agents", result: { ...result, checkedAt: clock, nextCheckAt: clock + 90_000, durationMs: 5, error: false, probeContext: { serverId: "server-01" } } });
    },
    dispose() {
      bus.off(EVENTS.PROBE_UPDATED, observers.onProbeUpdated);
      bus.off(EVENTS.STATUS_CHANGED, observers.onStatusChanged);
      store.dispose();
    },
  };
}

const specOf = (specs, id) => specs.find((s) => s.id === id);

test("doctor 的远端命令：PATH 里找不到之后按 CLI 探测同一份清单再找一遍，两种结论各一个标记", async () => {
  const calls = [];
  const ctx = realShellCtx("/nonexistent", { calls });
  ctx.execFileCmd = async (_cmd, args) => {
    calls.push(args.at(-1));
    return { code: 0, stdout: "18 ok | 0 warn | 0 fail\n__CODEX_AUTH_BEGIN__\n__CODEX_AUTH_END__\n", stderr: "" };
  };
  await specOf(codexAdapter.probeSpecs(ctx), "doctor").run();
  const command = calls[0];
  assert.match(command, /test -x "\$HOME\/\.local\/bin\/codex" \|\| command -v codex >\/dev\/null 2>&1 \|\| \{ /);
  assert.ok(command.includes(`echo "${CODEX_OFF_PATH_MARKER}=$__CODEX_OFF__"`) && command.includes(`echo ${CODEX_NOT_INSTALLED_MARKER}`));
  const globs = offPathDirGlobs();
  assert.ok(globs.length > 0);
  for (const glob of globs) assert.ok(command.includes(` ${glob}`), `doctor 命令里有清单项 ${glob}`);
});

for (const shell of SHELLS) {
  test(`codex 装在 nvm 里、非交互 PATH 找不到（登录 shell ${shell}）：黄色并说出装在哪，计入注意力、立案；端点照常检测；装进 ~/.local/bin 后恢复`, { skip }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-offpath-"));
    const h = setup();
    try {
      writeExec(path.join(home, ".nvm/versions/node/v22.11.0/bin/codex"), 'echo "should never be executed"; exit 9');
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(path.join(home, ".codex/auth.json"), JSON.stringify({ tokens: { refresh_token: "SECRET-REFRESH" } }));
      const calls = [];
      const specs = codexAdapter.probeSpecs(realShellCtx(home, { shell, calls }));
      const doctor = specOf(specs, "doctor");
      const endpoint = specOf(specs, "endpoint");

      const result = await doctor.run();
      assert.equal(result.level, "warn", "不是中性的未安装，也不是 codex 自身的故障");
      assert.equal(result.reason, `codex 已安装在 ${NVM_CODEX}，但非交互 SSH 的 PATH 里找不到`);
      assert.equal(result.data.offPath, NVM_CODEX);
      assert.equal(result.data.notInstalled, undefined);
      assert.equal(result.data.code, 127, "doctor 自己的退出码照常透传");
      assert.ok(result.data.output.includes(OFF_PATH_ADVICE));
      assert.ok(!result.data.output.includes("SECRET"), "凭证原文不进展示输出");
      assert.ok(!result.data.output.includes("should never be executed"), "找到的文件不执行");
      h.emit("doctor", result);

      const reach = await endpoint.run();
      assert.equal(reach.data.ok, true, "装在别处的人是在用 codex 的：端点探针不暂停");
      assert.equal(calls.length, 2);
      h.emit("endpoint", reach);

      const legacy = h.store.getLegacyStatus();
      const status = legacy.agentsStatus.codex;
      assert.equal(status.health, "degraded");
      assert.equal(status.offPath, NVM_CODEX);
      assert.equal(status.degradedReason, `降级：已安装在 ${NVM_CODEX}，但非交互 SSH 的 PATH 里找不到`);
      assert.equal(h.store.getLayers().agents.codex.level, "warn");
      assert.equal(legacy.summary.agentCounts.attention, 1, "计入注意力");
      assert.ok(h.incidentStore.query({ state: "open" }).incidents.some((incident) => incident.agentId === "codex" && incident.component === "agent"), "立案");

      // 处理之一：用工作台装官方版（装到 ~/.local/bin）。下一轮 doctor 跑得起来，状态恢复。
      writeExec(path.join(home, ".local/bin/codex"), 'echo "18 ok | 0 warn | 0 fail"');
      const fixed = await doctor.run();
      assert.equal(fixed.level, "ok", fixed.reason);
      assert.equal(fixed.data.offPath, undefined);
      h.emit("doctor", fixed);
      const after = h.store.getLegacyStatus().agentsStatus.codex;
      assert.equal(after.health, "ready");
      assert.ok(!("offPath" in after));
    } finally {
      h.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("codex 真没装（真跑同一条命令）：仍是中性的未安装，端点探针暂停", { skip }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "codex-absent-"));
  try {
    for (const shell of SHELLS) {
      const calls = [];
      const specs = codexAdapter.probeSpecs(realShellCtx(home, { shell, calls }));
      const result = await specOf(specs, "doctor").run();
      assert.equal(result.level, "ok", shell);
      assert.equal(result.data.notInstalled, true, shell);
      assert.equal(result.data.offPath, undefined, shell);
      assert.equal((await specOf(specs, "endpoint").run()).data.ok, null);
      assert.equal(calls.length, 1, "没装时端点探针不发 SSH");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude Code 同一口径：装在 ~/.claude/local（PATH 找不到）→ 黄色并说出装在哪，端点照常展示；不是中性的未安装", async () => {
  const output = [
    "__CLI_BEGIN__",
    "claude.installed=0",
    "claude.offPath=~/.claude/local/claude",
    "claude.npmGlobal=0",
    "claude.oauth=1",
    "claude.subscription=max",
    "endpoint=401 0.3",
    "__CLI_END__",
  ].join("\n");
  const ctx = realShellCtx("/nonexistent");
  ctx.execCollector = async () => ({ code: 0, stdout: output, stderr: "" });
  const h = setup();
  try {
    const result = await specOf(claudeCodeAdapter.probeSpecs(ctx), CLAUDE_CODE_PROBE_ID).run();
    assert.equal(result.level, "warn");
    assert.equal(result.reason, "Claude Code 已安装在 ~/.claude/local/claude，但非交互 SSH 的 PATH 里找不到");
    assert.ok(result.data.output.includes(OFF_PATH_ADVICE));
    h.emit(CLAUDE_CODE_PROBE_ID, result);
    const legacy = h.store.getLegacyStatus();
    const status = legacy.agentsStatus["claude-code"];
    assert.equal(status.health, "degraded");
    assert.equal(status.installed, false, "对工作台而言不可用");
    assert.equal(status.offPath, "~/.claude/local/claude");
    assert.equal(status.degradedReason, "降级：已安装在 ~/.claude/local/claude，但非交互 SSH 的 PATH 里找不到");
    assert.deepEqual([status.endpoint.ok, status.endpoint.latencyMs], [true, 300], "端点照常展示");
    assert.equal(h.store.getLayers().agents["claude-code"].level, "warn");
    assert.equal(legacy.summary.agentCounts.attention, 1);
    assert.ok(h.incidentStore.query({ state: "open" }).incidents.some((incident) => incident.agentId === "claude-code"));

    // 真没装（没有 offPath）：照旧中性，不带 offPath 字段
    ctx.execCollector = async () => ({ code: 0, stdout: "__CLI_BEGIN__\nclaude.installed=0\nendpoint=401 0.3\n__CLI_END__\n", stderr: "" });
    const absent = await specOf(claudeCodeAdapter.probeSpecs(ctx), CLAUDE_CODE_PROBE_ID).run();
    assert.equal(absent.level, "ok");
    const absentStatus = claudeCodeAdapter.buildStatus({ last: absent.data });
    assert.equal(absentStatus.health, "not-installed");
    assert.ok(!("offPath" in absentStatus));
  } finally {
    h.dispose();
  }
});
