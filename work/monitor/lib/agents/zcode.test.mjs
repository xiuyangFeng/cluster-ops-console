import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "../event-bus.mjs";
import { applyModulePreferences } from "../modules/catalog.mjs";
import { createChannelToolkit } from "../probes.mjs";
import { createStateStore } from "../state-store.mjs";
import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { codexAdapter } from "./codex.mjs";
import { reclaudeAdapter } from "./reclaude.mjs";
import { agentAdapterEnabled, adapterForProbeId } from "./registry.mjs";
import {
  evaluateZcodeProxyConfig,
  parseZcodeManifestVersion,
  parseZcodeSections,
  parseZcodeServerProcess,
  ZCODE_PROBE_ID,
  zcodeAdapter,
} from "./zcode.mjs";

// ---------------------------------------------------------------------------
// fixture：2026-09 对 myserver 只读侦察抓到的真实输出。
// - setting.json：~/.zcode/v2/setting.json 实际内容（无凭证字段，可整体入库）；
//   httpProxy 指向反向隧道 7891 即健康基线。
// - manifest：~/.zcode/server/.asset-components/glm.json 实际内容（zcode 应用
//   版本不落盘服务端，组件清单是唯一可采集的版本事实）。
// - ps：侦察时健康稳态下无 zcode-server 进程（由 sshd 随会话按需拉起）；
//   进程行按真实安装路径构造（server 自带 node 跑 zcode-server.cjs）。
// ---------------------------------------------------------------------------

const REAL_SETTING_JSON = `{
  "recentProjects": [],
  "locale": "zh-CN",
  "localePreference": "system",
  "terminalInheritSystemProfile": true,
  "httpProxy": "http://127.0.0.1:7891",
  "httpProxyNoProxy": "localhost,127.0.0.1,::1",
  "embeddedBrowserAllowInsecureCertificates": false,
  "computerUseComposerEntryHidden": true,
  "taskAutoArchiveEnabled": false,
  "closeToTrayOnWindows": true,
  "messageStreamShowReasoning": true,
  "zcodeInteractionBehavior": "queue",
  "enabledBuiltinAgentCliProviders": [
    "glm"
  ],
  "memoryEnabled": false,
  "lastWorkspaceSession": [],
  "receivePreviewUpdates": false,
  "skippedElectronUpdateVersions": {}
}`;

const REAL_GLM_MANIFEST =
  '{"id":"glm","version":"0.13.3","sha256":"eded83c139cd6597f1769644ea7620c0dde1824411bd9de86c10bf56de86920e","platformArch":"linux-x64"}';

const ZCODE_SERVER_PS_LINE =
  "/public/newhome/kai/.zcode/server/node /public/newhome/kai/.zcode/server/zcode-server.cjs";

function combinedOutput({
  installed = true,
  manifest = REAL_GLM_MANIFEST,
  settingPresent = true,
  setting = REAL_SETTING_JSON,
  ps = "",
} = {}) {
  return [
    "__ZCODE_INSTALL_BEGIN__",
    installed ? "__ZCODE_SERVER_PRESENT__" : "__ZCODE_SERVER_ABSENT__",
    "__ZCODE_INSTALL_END__",
    "__ZCODE_MANIFEST_BEGIN__",
    manifest,
    "__ZCODE_MANIFEST_END__",
    "__ZCODE_SETTING_STATE_BEGIN__",
    settingPresent ? "__ZCODE_SETTING_PRESENT__" : "__ZCODE_SETTING_ABSENT__",
    "__ZCODE_SETTING_STATE_END__",
    "__ZCODE_SETTING_BEGIN__",
    settingPresent ? setting : "",
    "__ZCODE_SETTING_END__",
    "__ZCODE_PS_BEGIN__",
    ps,
    "__ZCODE_PS_END__",
  ].join("\n");
}

function zcodeConfig({ remotePort = 7891 } = {}) {
  return normalizeAgentConfig({
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [
      {
        id: "zcode",
        name: "Zcode",
        command: "zcode",
        diagnosticLabel: "Zcode 代理配置",
        endpointLabel: "Zcode 模型代理",
        switchLabel: "Server",
        kind: "zcode",
      },
    ],
    servers: [
      { id: "server-01", name: "主集群服务器", host: "myserver", remotePort, localPort: 8888 },
    ],
  });
}

// 默认配置：normalizeAgentConfig 只物化 codex / claude-codewing，无 zcode 条目。
function defaultConfig() {
  return normalizeAgentConfig({
    activeServerId: "server-01",
    servers: [
      { id: "server-01", name: "主集群服务器", host: "myserver", remotePort: 7891, localPort: 8888 },
    ],
  });
}

function probeResult(level, data, reason = "") {
  const checkedAt = Date.now();
  return { level, reason, data, checkedAt, nextCheckAt: checkedAt + 90000, durationMs: 3, error: level === "error" };
}

function makeToolkit({ config, execFileImpl }) {
  return createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => config,
    execFileImpl,
  });
}

// 生产启动路径：registerProbes 按传入的运行配置同步注册启用适配器的探针（v2.47 起不再有
// 「恒启用同步 / 门控微任务」两条路径）。
function registerIntoMap({ config, execFileImpl }) {
  const registered = new Map();
  makeToolkit({ config, execFileImpl }).registerProbes({
    scheduler: { registerProbe: (spec) => registered.set(spec.id, spec) },
    config,
    getShouldBeRunning: () => true,
    isChannelOk: () => true,
    getTunnelUp: () => true,
  });
  return registered;
}

// ---------------------------------------------------------------------------
// 解析纯函数
// ---------------------------------------------------------------------------

test("zcode: 组件清单版本解析（真实 glm.json）；缺失/损坏 → null", () => {
  assert.equal(parseZcodeManifestVersion(REAL_GLM_MANIFEST), "glm 0.13.3");
  assert.equal(parseZcodeManifestVersion(""), null);
  assert.equal(parseZcodeManifestVersion("{not json"), null);
  assert.equal(parseZcodeManifestVersion('"just a string"'), null);
  assert.equal(parseZcodeManifestVersion('{"id":"glm"}'), null, "无 version 字段不硬造");
});

test("zcode: httpProxy 漂移判定四态 + 缺字段（本地解析侧比对）", () => {
  const expected = "http://127.0.0.1:7891";
  // 在（真实 setting.json，指向 7891）
  const ok = evaluateZcodeProxyConfig({ settingRaw: REAL_SETTING_JSON, settingPresent: true, expected });
  assert.equal(ok.state, "ok");
  assert.equal(ok.actual, "http://127.0.0.1:7891");
  // 不在（漂移到别的端口——per-user 路由改端口后 setting.json 未跟上是最典型场景）
  const drifted = evaluateZcodeProxyConfig({
    settingRaw: REAL_SETTING_JSON.replace("http://127.0.0.1:7891", "http://127.0.0.1:7893"),
    settingPresent: true,
    expected,
  });
  assert.equal(drifted.state, "drifted");
  assert.equal(drifted.actual, "http://127.0.0.1:7893");
  // 文件缺失
  assert.equal(
    evaluateZcodeProxyConfig({ settingRaw: "", settingPresent: false, expected }).state,
    "file-missing",
  );
  // JSON 损坏（含顶层非对象）
  assert.equal(
    evaluateZcodeProxyConfig({ settingRaw: "{broken", settingPresent: true, expected }).state,
    "invalid-json",
  );
  assert.equal(
    evaluateZcodeProxyConfig({ settingRaw: "[1,2]", settingPresent: true, expected }).state,
    "invalid-json",
  );
  // 字段缺失/文件为空
  assert.equal(
    evaluateZcodeProxyConfig({ settingRaw: '{"locale":"zh-CN"}', settingPresent: true, expected }).state,
    "missing-field",
  );
  assert.equal(
    evaluateZcodeProxyConfig({ settingRaw: "", settingPresent: true, expected }).state,
    "missing-field",
  );
  // 尾斜杠/大小写归一化不算漂移
  assert.equal(
    evaluateZcodeProxyConfig({
      settingRaw: '{"httpProxy":"HTTP://127.0.0.1:7891/"}',
      settingPresent: true,
      expected,
    }).state,
    "ok",
  );
});

test("zcode: zcode-server 进程判定（侦察实态：健康稳态可以没有进程）", () => {
  assert.deepEqual(parseZcodeServerProcess(""), { running: false, count: 0 });
  assert.deepEqual(parseZcodeServerProcess(ZCODE_SERVER_PS_LINE), { running: true, count: 1 });
  assert.deepEqual(
    parseZcodeServerProcess(`${ZCODE_SERVER_PS_LINE}\n${ZCODE_SERVER_PS_LINE} --child`),
    { running: true, count: 2 },
  );
});

test("zcode: 标记分段解析三值语义（标记缺失 = SSH 未到达，非未安装）", () => {
  const sections = parseZcodeSections(combinedOutput());
  assert.equal(sections.installed, true);
  assert.equal(sections.settingPresent, true);
  assert.match(sections.manifestRaw, /glm/);
  const gone = parseZcodeSections("ssh: connect to host myserver port 22: Operation timed out");
  assert.equal(gone.installed, null);
  assert.equal(gone.settingPresent, null);
});

// ---------------------------------------------------------------------------
// 探针 run：命令纯静态、期望值从配置 remotePort 本地推导
// ---------------------------------------------------------------------------

test("zcode 探针: 远端命令为纯静态串（不掺 remotePort 插值），期望值本地比对", async () => {
  let capturedCommand = null;
  const config = zcodeConfig({ remotePort: 7893 });
  const registered = registerIntoMap({
    config,
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args[args.length - 1];
      return { code: 0, stdout: combinedOutput(), stderr: "" };
    },
  });
  const spec = registered.get(ZCODE_PROBE_ID);
  assert.ok(spec, "配置含 kind:zcode 时探针必须注册");
  const result = await spec.run();
  // 命令串不含任何端口数字：期望值 http://127.0.0.1:7893 只存在于本地比对侧。
  assert.ok(!/789\d/.test(capturedCommand), "remotePort 不得进入远端命令串");
  assert.match(capturedCommand, /__ZCODE_INSTALL_BEGIN__/);
  assert.match(capturedCommand, /grep -v grep/);
  assert.ok(!capturedCommand.includes("(("), "不得出现双括号（bash 算术表达式陷阱）");
  // 真实 setting.json 指向 7891，而该服务器 remotePort=7893 → 判漂移。
  assert.equal(result.level, "warn");
  assert.equal(result.data.proxyConfig.state, "drifted");
  assert.equal(result.data.proxyConfig.expected, "http://127.0.0.1:7893");
});

test("zcode 探针: 健康基线（7891 + 无常驻进程）→ ok，进程不在不降级", async () => {
  const registered = registerIntoMap({
    config: zcodeConfig(),
    execFileImpl: async () => ({ code: 0, stdout: combinedOutput(), stderr: "" }),
  });
  const spec = registered.get(ZCODE_PROBE_ID);
  assert.equal(spec.layer, "agents");
  assert.equal(spec.usesSsh, true);
  assert.equal(spec.intervalMs, 90000);
  assert.equal(typeof spec.enabled, "function", "熔断门控由 registerProbes 统一补齐");
  const result = await spec.run();
  assert.equal(result.level, "ok");
  assert.equal(result.data.ok, true);
  assert.equal(result.data.version, "glm 0.13.3");
  assert.equal(result.data.serverRunning, false);
  assert.match(result.reason, /就绪/);
  assert.match(result.data.output, /非故障/);
});

test("zcode 探针: SSH 未到达（标记全缺）→ error 且 data 为空，不伪造未安装", async () => {
  const registered = registerIntoMap({
    config: zcodeConfig(),
    execFileImpl: async () => ({
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host myserver port 22: Operation timed out",
    }),
  });
  const result = await registered.get(ZCODE_PROBE_ID).run();
  assert.equal(result.level, "error");
  assert.equal(result.data, null);
  assert.match(result.reason, /探测未完成/);
});

// ---------------------------------------------------------------------------
// 三态 health 合成 + degradedReason
// ---------------------------------------------------------------------------

test("zcode buildStatus: ready / degraded（漂移三种文案）/ missing 三态", () => {
  const adapter = zcodeAdapter;
  const state = adapter.createInitialState();

  // 首屏：waiting
  assert.equal(adapter.buildStatus(state).health, "waiting");

  // ready：安装 + 代理指向隧道（进程不在不影响）
  state.last = {
    ok: true,
    installed: true,
    version: "glm 0.13.3",
    proxyConfig: { state: "ok", expected: "http://127.0.0.1:7891", actual: "http://127.0.0.1:7891" },
    serverRunning: false,
    output: "server bundle: present",
  };
  let entry = adapter.buildStatus(state);
  assert.equal(entry.health, "ready");
  assert.equal(entry.ok, true);
  assert.equal(entry.degradedReason, null);
  assert.equal(entry.endpoint.ok, true, "通用端点语义：代理配置正确 = 端点可达");
  assert.equal(entry.diagnosticLabel, "Zcode 代理配置");

  // degraded：漂移/缺字段/文件缺失/JSON 损坏 → 文案各自点名根因，都带 TLS 后果
  state.last = {
    ...state.last,
    ok: false,
    proxyConfig: { state: "drifted", expected: "http://127.0.0.1:7891", actual: "http://127.0.0.1:7893" },
  };
  entry = adapter.buildStatus(state);
  assert.equal(entry.health, "degraded");
  assert.equal(entry.endpoint.ok, false);
  assert.equal(
    entry.degradedReason,
    "降级：zcode 代理配置漂移（httpProxy 应为 http://127.0.0.1:7891），远程会话将 TLS 失败",
  );

  state.last = { ...state.last, proxyConfig: { state: "file-missing", expected: "http://127.0.0.1:7891", actual: null } };
  assert.match(adapter.buildStatus(state).degradedReason, /配置缺失.*TLS 失败/);
  state.last = { ...state.last, proxyConfig: { state: "invalid-json", expected: "http://127.0.0.1:7891", actual: null } };
  assert.match(adapter.buildStatus(state).degradedReason, /配置损坏.*TLS 失败/);

  // missing：未安装
  state.last = { ok: false, installed: false, version: null, proxyConfig: null, serverRunning: false, output: "" };
  entry = adapter.buildStatus(state);
  assert.equal(entry.health, "missing");
  assert.equal(entry.degradedReason, null);
  assert.equal(entry.endpoint.ok, null, "未安装时端点语义为待探测，不硬判失败");
});

// ---------------------------------------------------------------------------
// 门控：config 无 zcode 条目 → 零探针、零状态
// ---------------------------------------------------------------------------

test("zcode 门控（统一规则）: 运行配置 agents[] 有映射条目才启用；设置页关闭即不启用", () => {
  assert.equal(agentAdapterEnabled(zcodeAdapter, zcodeConfig()), true);
  assert.equal(agentAdapterEnabled(zcodeAdapter, defaultConfig()), false);
  assert.equal(agentAdapterEnabled(zcodeAdapter, {}), false);
  // codex/reclaude 由 normalizeAgentConfig 默认物化 → 默认启用；无 agents 数组的替身配置按默认口径
  assert.equal(agentAdapterEnabled(codexAdapter, defaultConfig()), true);
  assert.equal(agentAdapterEnabled(reclaudeAdapter, {}), true);
  // 个人层 disabledModules 过滤后的运行配置：三个都能关
  const off = applyModulePreferences({ ...zcodeConfig(), disabledModules: ["agent:zcode", "agent:codex"] });
  assert.equal(agentAdapterEnabled(zcodeAdapter, off), false);
  assert.equal(agentAdapterEnabled(codexAdapter, off), false);
  assert.equal(agentAdapterEnabled(reclaudeAdapter, off), true);
});

test("zcode 门控: 默认配置下 registerProbes 零注册，含 zcode 条目才注册；关掉的 Agent 同样零注册", () => {
  const exec = async () => ({ code: 0, stdout: "", stderr: "" });
  const gated = registerIntoMap({ config: defaultConfig(), execFileImpl: exec });
  assert.equal(gated.get(ZCODE_PROBE_ID), undefined, "无 zcode 条目 → 探针零注册");
  for (const id of ["doctor", "endpoint", "reclaude", "claude-endpoint", "log-signals"]) {
    assert.ok(gated.get(id), `既有探针 ${id} 不受门控影响`);
  }

  const enabled = registerIntoMap({ config: zcodeConfig(), execFileImpl: exec });
  assert.ok(enabled.get(ZCODE_PROBE_ID), "有 zcode 条目 → 探针注册");
  assert.deepEqual([...enabled.keys()], ["processes", "doctor", "endpoint", "reclaude", "claude-endpoint", ZCODE_PROBE_ID, "log-signals"],
    "注册序：processes → 适配器（注册表序）→ log-signals");

  const off = registerIntoMap({
    config: applyModulePreferences({ ...zcodeConfig(), disabledModules: ["agent:zcode", "agent:codex"] }),
    execFileImpl: exec,
  });
  assert.deepEqual([...off.keys()], ["processes", "reclaude", "claude-endpoint", "log-signals"], "被关掉的 Agent 零注册，log-signals 恒在");
});

test("zcode 门控: 默认配置下 state-store 零状态（agentsStatus/layers 无 zcode 键）", () => {
  const store = createStateStore({ config: defaultConfig() });
  try {
    const legacy = store.getLegacyStatus();
    assert.ok(!("zcode" in legacy.agentsStatus), "agentsStatus 不得出现 zcode");
    assert.ok(!("zcode" in store.getLayers().agents), "layers.agents 不得出现 zcode");
    // 纵深防御：即使探针结果直发事件（探针本不该注册），也不物化 zcode 键。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: ZCODE_PROBE_ID,
      layer: "agents",
      result: probeResult("ok", { ok: true, installed: true, proxyConfig: { state: "ok" }, output: "x" }),
    });
    assert.ok(!("zcode" in store.getLegacyStatus().agentsStatus), "禁用适配器的结果不得合成状态");
    // 旧字段契约完好
    for (const key of ["doctor", "endpoint", "claudeEndpoint", "agentsStatus", "agentsOverview"]) {
      assert.ok(key in legacy, `旧字段 ${key} 不得因 zcode 门控缺失`);
    }
  } finally {
    store.dispose();
  }
});

test("zcode 全链路: 配置激活后探针结果合成 agentsStatus/layers，含熔断 skipped", () => {
  const store = createStateStore({ config: zcodeConfig() });
  try {
    assert.equal(store.getLegacyStatus().agentsStatus.zcode.health, "waiting");
    assert.equal(store.getLayers().agents.zcode.level, "waiting");

    // ok 轮 → ready
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: ZCODE_PROBE_ID,
      layer: "agents",
      result: probeResult("ok", {
        ok: true,
        installed: true,
        version: "glm 0.13.3",
        proxyConfig: { state: "ok", expected: "http://127.0.0.1:7891", actual: "http://127.0.0.1:7891" },
        serverRunning: false,
        output: "server bundle: present",
      }),
    });
    let legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.zcode.health, "ready");
    assert.equal(legacy.agentsStatus.zcode.version, "glm 0.13.3");
    assert.equal(store.getLayers().agents.zcode.level, "ok");
    assert.equal(typeof store.getLayers().agents.zcode.checkedAt, "number");

    // 漂移轮 → degraded + 根因透出
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: ZCODE_PROBE_ID,
      layer: "agents",
      result: probeResult("warn", {
        ok: false,
        installed: true,
        version: "glm 0.13.3",
        proxyConfig: { state: "drifted", expected: "http://127.0.0.1:7891", actual: "http://127.0.0.1:7893" },
        serverRunning: true,
        output: "httpProxy: http://127.0.0.1:7893",
      }),
    });
    legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.zcode.health, "degraded");
    assert.match(legacy.agentsStatus.zcode.degradedReason, /代理配置漂移.*TLS 失败/);
    assert.equal(store.getLayers().agents.zcode.level, "warn");

    // 熔断轮 → 层级 skipped、占位输出、既有事实不丢
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: ZCODE_PROBE_ID,
      layer: "agents",
      result: probeResult("skipped", null, "probe disabled"),
    });
    const layer = store.getLayers().agents.zcode;
    assert.equal(layer.level, "skipped");
    assert.equal(layer.reason, "通道异常，熔断跳过");
    legacy = store.getLegacyStatus();
    assert.match(legacy.agentsStatus.zcode.output, /熔断跳过 zcode 检查/);
    assert.equal(legacy.agentsStatus.zcode.health, "degraded", "熔断只换占位输出，不改写既有健康事实");

    // 全局健康聚合不被 zcode 拖累（healthInputs 为空片段）
    assert.ok(["waiting", "down", "degraded", "ready", "stopped"].includes(legacy.health));
    // 既有 agent 不受影响
    assert.equal(store.getLayers().agents.codex.level, "waiting");
  } finally {
    store.dispose();
  }
});

// ---------------------------------------------------------------------------
// 探针 id 归属
// ---------------------------------------------------------------------------

test("zcode: 探针 id 归属注册表，probeIds 与 probeSpecs 一致", () => {
  assert.equal(adapterForProbeId(ZCODE_PROBE_ID).kind, "zcode");
  assert.deepEqual(zcodeAdapter.probeIds, [ZCODE_PROBE_ID]);
  const specs = zcodeAdapter.probeSpecs({});
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, ZCODE_PROBE_ID);
});
