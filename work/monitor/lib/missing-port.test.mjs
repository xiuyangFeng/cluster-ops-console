// v2.54 端口登记：团队层不再预烤 remotePort 后，"没领端口"是正常状态。
// 这组测试锁死一条底线：缺端口（或端口写坏）时任何运行时代码都不得回落 7891——
// supervisor 不建隧道、探针不拼 :undefined / {{remotePort}}、状态与界面显示"未领取"。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildNetworkChannel, normalizeAgentConfig } from "../monitor-core.mjs";
import { listServersMissingPort, loadLayeredConfig, mergeConfig, resolveTunnelTargets } from "./config-loader.mjs";
import { assessSetup, createOnboardingAssessmentProbe, createOnboardingProbe } from "./onboarding.mjs";
import { createOperationsRunner } from "./operations-runner.mjs";
import { createChannelToolkit } from "./probes.mjs";
import { buildChannelLayer, deriveChannelFlags, deriveChannelLevel } from "./state/channel-layer.mjs";
import { createConfigLoader, resolveSupervisorConfig } from "./supervisor/config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// 集成后的团队层形状：仓库 config.json 去掉 server-01.remotePort（validationProfile 的 {{remotePort}} 保留）。
function teamConfigWithoutPort() {
  const team = JSON.parse(readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
  for (const s of team.servers) delete s.remotePort;
  return team;
}

function layered(team, local) {
  const files = { "/team.json": JSON.stringify(team), ...(local === undefined ? {} : { "/local.json": JSON.stringify(local) }) };
  return loadLayeredConfig({
    configPath: "/team.json",
    localConfigPath: "/local.json",
    readFileSync: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return files[p];
    },
    onLocalError: () => {},
  });
}

const noPortServer = { id: "server-01", host: "myserver", localPort: 8888 };

// ---- 配置层 ----

test("resolveTunnelTargets：缺 remotePort 的条目静默跳过（不 warn）；写了但非法才 warn", () => {
  const warnings = [];
  const targets = resolveTunnelTargets({
    servers: [
      noPortServer,
      { id: "blank", host: "myserver", remotePort: "" },
      { id: "nul", host: "myserver", remotePort: null },
      { id: "bad", host: "myserver", remotePort: "7892; id" },
      { id: "ok", host: "other", remotePort: 7893 },
    ],
  }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(targets.map((t) => [t.serverId, t.remotePort]), [["ok", 7893]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"bad"/);
});

test("listServersMissingPort：启用、要建隧道、却没有可用端口的服务器；仅监控 / 屏蔽 / 有端口的不算", () => {
  const merged = {
    servers: [
      noPortServer,
      { id: "bad", host: "x", remotePort: "abc" },
      { id: "monitor-only", host: "x", tunnel: false },
      { id: "off", host: "x", disabled: true },
      { id: "ok", host: "x", remotePort: "7893" },
    ],
  };
  assert.deepEqual(listServersMissingPort(merged).map((s) => s.id), ["server-01", "bad"]);
  assert.deepEqual(listServersMissingPort({}), []);
});

test("normalizeAgentConfig：缺端口保持缺失且不告警；非法端口剔除并告警；合法端口与键位逐字不变", () => {
  const warnings = [];
  const out = normalizeAgentConfig({
    servers: [
      noPortServer,
      { id: "blank", host: "myserver", remotePort: "" },
      { id: "bad", host: "myserver", remotePort: 0 },
      { id: "ok", host: "myserver", remotePort: "7893", localPort: 8893, extra: 1 },
    ],
  }, { warn: (m) => warnings.push(m) });
  const byId = Object.fromEntries(out.servers.map((s) => [s.id, s]));
  for (const id of ["server-01", "blank", "bad"]) assert.equal(Object.hasOwn(byId[id], "remotePort"), false, id);
  assert.equal(warnings.length, 1, "只有写了且非法的才告警");
  assert.match(warnings[0], /"bad"/);
  assert.deepEqual(Object.keys(byId.ok), ["id", "host", "remotePort", "localPort", "extra"]);
  assert.equal(byId.ok.remotePort, 7893);
  assert.ok(!JSON.stringify(out.servers).includes("7891"));
});

// ---- supervisor：没领端口就不产出任何隧道 ----

test("supervisor：团队层无 remotePort、个人层无 portOverrides → 不产出任何隧道，也绝不出现 7891", () => {
  const team = teamConfigWithoutPort();
  for (const local of [undefined, {}, { sshUser: "alice" }]) {
    const resolved = resolveSupervisorConfig(layered(team, local));
    assert.deepEqual(resolved.tunnels, [], JSON.stringify(local));
    assert.equal(Object.hasOwn(resolved, "remotePort"), false);
    assert.ok(!JSON.stringify(resolved).includes("7891"), "任何字段里都不该冒出 7891");
  }
});

test("supervisor：个人层 portOverrides 领到的端口才建隧道（kai 的 7891 也只来自个人层）", () => {
  const team = teamConfigWithoutPort();
  const alice = resolveSupervisorConfig(layered(team, { sshUser: "alice", portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } }));
  assert.deepEqual(alice.tunnels.map((t) => [t.id, t.host, t.remotePort, t.localPort]), [["server-01", "myserver", 7892, 8892]]);
  const cy = resolveSupervisorConfig(layered(team, { sshUser: "kai", portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } }));
  assert.deepEqual(cy.tunnels.map((t) => [t.remotePort, t.localPort]), [[7891, 8888]]);
});

test("supervisor 配置加载：端口写坏只在第一次告警，修好后再写坏会重新告警；始终不建隧道", async () => {
  let current = { servers: [{ id: "server-01", host: "myserver", remotePort: "oops" }] };
  const logs = [];
  const loader = createConfigLoader({
    configPath: "/team.json",
    localConfigPath: "/local.json",
    log: (message, fields) => logs.push({ message, fields }),
    readLayeredConfig: () => structuredClone(current),
  });
  const warnCount = () => logs.filter((l) => l.fields?.level === "warn").length;
  assert.deepEqual((await loader.loadConfig()).tunnels, []);
  assert.deepEqual((await loader.loadConfig()).tunnels, []);
  assert.equal(warnCount(), 1, "每拍重算，但同一条告警只落一次");
  current = { servers: [{ id: "server-01", host: "myserver", remotePort: 7892 }] };
  assert.equal((await loader.loadConfig()).tunnels[0].remotePort, 7892);
  current = { servers: [{ id: "server-01", host: "myserver", remotePort: "oops" }] };
  await loader.loadConfig();
  assert.equal(warnCount(), 2, "修好后再写坏重新告警");
});

// ---- onboarding ----

test("assessSetup：主服务器要建隧道却没端口 → partial / missing-port（用户名缺失优先）", () => {
  const team = teamConfigWithoutPort();
  const merged = mergeConfig(team, { sshUser: "alice" }, { warn: () => {} });
  assert.deepEqual(assessSetup({ merged }), { state: "partial", reason: "missing-port", host: "myserver", sshUser: "alice" });
  assert.deepEqual(assessSetup({ merged: mergeConfig(team, {}, { warn: () => {} }) }), { state: "partial", reason: "missing-ssh-user" });
  assert.equal(assessSetup({ localState: "missing", merged: mergeConfig(team, {}, { warn: () => {} }), resolveSshUser: () => "alice" }).reason, "missing-port");
  // 领了端口 → ready；主服务器仅监控 / 被屏蔽 → 不要端口
  const claimed = mergeConfig(team, { sshUser: "alice", portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } }, { warn: () => {} });
  assert.deepEqual(assessSetup({ merged: claimed }), { state: "ready", reason: null });
  assert.equal(assessSetup({ merged: { sshUser: "alice", servers: [{ ...noPortServer, tunnel: false }] } }).state, "ready");
  assert.equal(assessSetup({ merged: { sshUser: "alice", servers: [{ ...noPortServer, disabled: true }, { id: "p", host: "h", remotePort: 7900 }] } }).state, "ready");
});

test("onboarding 探针：完整判定带 reason（/api/status.onboardingReason），旧接口仍只返回 state", () => {
  const getMerged = () => ({ sshUser: "alice", servers: [noPortServer] });
  const assessment = createOnboardingAssessmentProbe({ exists: () => true, getMerged })();
  assert.deepEqual(assessment, { state: "partial", reason: "missing-port" });
  assert.equal(createOnboardingProbe({ exists: () => true, getMerged })(), "partial");
  assert.deepEqual(createOnboardingAssessmentProbe({ exists: () => true, getMerged: () => ({ sshUser: "a", servers: [{ ...noPortServer, remotePort: 7892 }] }) })(), { state: "ready", reason: null });
});

// ---- 状态层 ----

test("通道层：没领端口判 skipped + setupPending（配置未完成，不是故障）并说明原因；detail.remotePort 为 null；networkChannel 远端地址为 null", () => {
  const main = { id: "server-01", host: "myserver", localPort: 8888 };
  const processes = { localProxy: [1], reverseTunnel: [], supervisor: [1], tunnelsByServer: { "server-01": [] } };
  const flags = deriveChannelFlags({ main, shouldBeRunning: true, processes, remotePortOpen: false });
  const levelInfo = deriveChannelLevel({ main, shouldBeRunning: true, hasProcessesResult: false, flags });
  assert.deepEqual(levelInfo, { level: "skipped", reason: "未领取反向端口，隧道不会建立", setupPending: true, setupReason: "missing-port" });
  assert.equal(deriveChannelLevel({ main, shouldBeRunning: false, hasProcessesResult: true, flags }).reason, "通道已手动停止");
  const layer = buildChannelLayer({ main, levelInfo, flags, procResult: null, remoteResult: null });
  assert.equal(layer.detail.remotePort, null);
  assert.equal(layer.setupPending, true);
  assert.equal(layer.detail.setupPending, true, "分诊 / 自动修复 / readiness 只读 detail，标记必须也在 detail 上");
  assert.equal(layer.detail.setupReason, "missing-port");
  // 有端口的同一台：标记不出现（字段形状与 v2.53 一致）
  const claimed = { ...main, remotePort: 7892 };
  const claimedLevel = deriveChannelLevel({ main: claimed, shouldBeRunning: true, hasProcessesResult: true, flags });
  assert.equal(claimedLevel.level, "error");
  assert.equal(Object.hasOwn(buildChannelLayer({ main: claimed, levelInfo: claimedLevel, flags }).detail, "setupPending"), false);
  const channel = buildNetworkChannel({ shouldBeRunning: true, localProxyUp: true, tunnelUp: false, remotePortOpen: false, server: main });
  assert.equal(channel.remoteProxyUrl, null);
  assert.equal(channel.localProxyUrl, "http://127.0.0.1:8888");
  assert.equal(buildNetworkChannel({ server: { ...main, remotePort: 7892 } }).remoteProxyUrl, "http://127.0.0.1:7892");
});

// ---- 探针：没端口不拼命令 ----

test("环境校验：没领端口时 remoteProxyTest 跳过（不发 SSH、不带 {{remotePort}}），其余项照跑，不算失败", async () => {
  const team = teamConfigWithoutPort();
  const config = normalizeAgentConfig(layered(team, { sshUser: "alice" }));
  const sent = [];
  const toolkit = createChannelToolkit({
    rootDir: ".",
    getConfig: async () => config,
    execFileImpl: async (_cmd, args) => {
      sent.push(args.at(-1));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const res = await toolkit.runValidationProbe("server-01");
  assert.ok(sent.length > 0, "其余项照跑");
  assert.ok(sent.every((cmd) => !cmd.includes("{{remotePort}}") && !cmd.includes("127.0.0.1:undefined") && !cmd.includes("7891")));
  const proxyItem = res.data.items.find((i) => i.key === "remoteProxyTest");
  assert.deepEqual(proxyItem, { key: "remoteProxyTest", ok: null, skipped: "missing-port", durationMs: 0, output: "未领取反向端口，跳过经隧道出网测试" });
  assert.equal(res.level, "ok");
  assert.match(res.reason, /失败 0 项，跳过 1 项/);
});

test("环境校验：领了端口时 {{remotePort}} 换成个人端口照常执行", async () => {
  const config = normalizeAgentConfig(layered(teamConfigWithoutPort(), { sshUser: "alice", portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } }));
  const sent = [];
  const toolkit = createChannelToolkit({
    rootDir: ".",
    getConfig: async () => config,
    execFileImpl: async (_cmd, args) => {
      sent.push(args.at(-1));
      return { code: 0, stdout: "200", stderr: "" };
    },
  });
  const res = await toolkit.runValidationProbe("server-01");
  assert.ok(sent.some((cmd) => cmd.includes("-x http://127.0.0.1:7892 ")));
  assert.equal(res.data.items.some((i) => i.skipped), false);
});

test("Agent 探针：活跃服务器没领端口 → skipped，不发任何 SSH（绝不拼 :undefined 或借别人的端口）", async () => {
  const config = normalizeAgentConfig({ sshUser: "alice", servers: [noPortServer] });
  let sshCalls = 0;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => config,
    execFileImpl: async () => {
      sshCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const specs = new Map();
  toolkit.registerProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec) },
    getShouldBeRunning: () => true,
    isChannelOk: () => true,
    getTunnelUp: () => true,
  });
  for (const id of ["doctor", "endpoint", "reclaude", "claude-endpoint"]) {
    assert.ok(specs.has(id), `${id} 未注册`);
    const result = await specs.get(id).run();
    assert.equal(result.level, "skipped", id);
    assert.match(result.reason, /未领取反向端口/);
  }
  assert.equal(sshCalls, 0);
});

test("单隧道重启：没领端口的服务器在预览阶段就拒绝（400），不生成带 :undefined 的签名", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "missing-port-ops-"));
  try {
    const runner = createOperationsRunner({
      runtimeDir: dir,
      getConfig: async () => ({ servers: [{ id: "server-01", host: "myserver", localPort: 8888 }] }),
      getSnapshot: () => ({
        schemaVersion: 1, instanceId: "abcdef1234567890", pid: 1, startedAt: 1, observedAt: 2, configRevision: "r",
        build: {}, capabilities: { scopedTunnelRestart: true, controlProtocol: 1 }, effectiveProxyPort: 8888, targets: {}, stale: false,
      }),
      now: () => 1000,
      log: () => {},
      timeline: () => {},
    });
    await assert.rejects(
      () => runner.preview({ action: "restart-tunnel", target: { serverId: "server-01" } }),
      (err) => err.status === 400 && /还没有领取反向端口/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
