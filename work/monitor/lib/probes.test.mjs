import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { splitEndpointRtt } from "./agents/codex.mjs";
import { resolveClaudeEndpointTarget } from "./agents/reclaude.mjs";
import { createChannelToolkit } from "./probes.mjs";
import { buildProbeSshArgs } from "./ssh-args.mjs";
// getProcesses 的产物直接喂给它：两者的"活跃隧道"判据必须是同一套，
// 分开断言只会让两边悄悄漂移。
import { isActiveTunnelUp } from "../monitor-core.mjs";

// probes.mjs 的 run* 函数不直接导出（v1.5.2 命名习惯），统一经 createChannelToolkit(...).registerProbes(...)
// 抓取传给 scheduler.registerProbe 的 spec.run 间接调用——与调度器实际驱动方式完全一致，
// execFileImpl 全程注入假 ssh 结果，零真实 SSH / 零触达生产实例。

function baseConfig() {
  return {
    servers: [{ id: "server-01", name: "主集群服务器", host: "myserver", remotePort: 7891, localPort: 8888 }],
  };
}

test("channel toolkit 以 activeServerId 选择主通道服务器", () => {
  const config = {
    activeServerId: "server-tengxun",
    servers: [
      ...baseConfig().servers,
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 },
    ],
  };
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => config });
  assert.equal(toolkit.getMainServerConfig(config).id, "server-tengxun");
});

// v2.18：slow 采集探针对每台未禁用服务器各注册一枚（含活跃服务器与 tunnel:false 的
// "只监控"条目）——旧的"跳过活跃服务器"语义随 primary-remote 一并消失。
test("slow 采集探针为每台未禁用服务器各注册一枚（含活跃服务器与 tunnel:false）", () => {
  const config = {
    activeServerId: "server-tengxun",
    servers: [
      ...baseConfig().servers,
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 },
      { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, tunnel: false },
      { id: "server-blocked", host: "blocked", remotePort: 7895, disabled: true },
    ],
  };
  const registered = [];
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => config });
  const ids = toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => registered.push(spec.id) },
    servers: config.servers,
    activeServerId: config.activeServerId,
    getShouldBeRunning: () => true,
  });
  assert.deepEqual(ids, [
    "collect:slow:server-01",
    "collect:slow:server-tengxun",
    "collect:slow:server-aliyun",
  ]);
  assert.deepEqual(registered, ids, "disabled 条目不得注册探针");
});

test("slow 采集探针注册规格：60s / resources 层 / usesSsh / 只看 shouldBeRunning", () => {
  const specs = new Map();
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => baseConfig() });
  let running = true;
  toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec) },
    servers: baseConfig().servers,
    activeServerId: "server-01",
    getShouldBeRunning: () => running,
  });
  const spec = specs.get("collect:slow:server-01");
  assert.ok(spec, "collect:slow:server-01 未注册");
  assert.equal(spec.layer, "resources");
  assert.equal(spec.intervalMs, 60000);
  assert.equal(spec.usesSsh, true);
  assert.equal(spec.enabled(), true);
  running = false;
  assert.equal(spec.enabled(), false);
});

function buildReclaudeCombinedOutput({
  versionOutput = "reclaude version v1.4.2",
  statusOutput = "daemon: running\nlogin: ok",
  deviceOutput = "__RECLAUDE_DEVICE_BOUND__",
  stateOutput = JSON.stringify({ gateway: { healthy: true } }),
  logsOutput = "2026-07-02T10:00:00Z request completed status=200",
} = {}) {
  return [
    "__RECLAUDE_VERSION_BEGIN__", versionOutput, "__RECLAUDE_VERSION_END__",
    "__RECLAUDE_STATUS_BEGIN__", statusOutput, "__RECLAUDE_STATUS_END__",
    "__RECLAUDE_DEVICE_BEGIN__", deviceOutput, "__RECLAUDE_DEVICE_END__",
    "__RECLAUDE_STATE_BEGIN__", stateOutput, "__RECLAUDE_STATE_END__",
    "__RECLAUDE_LOGS_BEGIN__", logsOutput, "__RECLAUDE_LOGS_END__",
  ].join("\n");
}

async function captureProbeRun(toolkit, probeId) {
  let captured = null;
  toolkit.registerProbes({
    scheduler: { registerProbe: (spec) => { if (spec.id === probeId) captured = spec; } },
    getShouldBeRunning: () => true,
    isChannelOk: () => true,
    getTunnelUp: () => true,
  });
  assert.ok(captured, `probe ${probeId} 未注册`);
  return captured.run();
}

// ---------------------------------------------------------------------------
// B1: runReclaudeProbe 应零新增 SSH 地从已抓的 logs/state.json 判定账号层故障
// ---------------------------------------------------------------------------

test("runReclaudeProbe: 真实脱敏 device_revoked 日志 → health/accountFault=revoked, level=error", async () => {
  const revokedLogLine =
    'reclaude account sync: sync current account: unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑，请在终端重新运行 reclaude 完成登录..."}}';
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({
      code: 0,
      stdout: buildReclaudeCombinedOutput({ logsOutput: revokedLogLine }),
      stderr: "",
    }),
  });

  const result = await captureProbeRun(toolkit, "reclaude");
  assert.equal(result.level, "error");
  assert.equal(result.data.health, "revoked");
  assert.equal(result.data.accountFault, "revoked");
  assert.match(result.data.output, /device_revoked/);
});

test("runReclaudeProbe: 真实脱敏 account_banned 日志 → health/accountFault=banned, level=error", async () => {
  const bannedLogLine =
    'reclaude account sync: sync current account: unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用"}}';
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({
      code: 0,
      stdout: buildReclaudeCombinedOutput({ logsOutput: bannedLogLine }),
      stderr: "",
    }),
  });

  const result = await captureProbeRun(toolkit, "reclaude");
  assert.equal(result.level, "error");
  assert.equal(result.data.health, "banned");
  assert.equal(result.data.accountFault, "banned");
});

test("runReclaudeProbe: 干净日志不受影响，仍按既有 daemon/login/gateway 逻辑判 ready", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({ code: 0, stdout: buildReclaudeCombinedOutput(), stderr: "" }),
  });

  const result = await captureProbeRun(toolkit, "reclaude");
  assert.equal(result.level, "ok");
  assert.equal(result.data.health, "ready");
  assert.equal(result.data.accountFault, null);
});

test("runReclaudeProbe: v1.2.x status 无 login 字段时用 device.json 绑定标记判 ready", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({
      code: 0,
      stdout: buildReclaudeCombinedOutput({
        versionOutput: "v1.2.5",
        statusOutput: "daemon_running: true\ndaemon_reachable: true\nclaude_path: /home/kai/.local/bin/claude\ngateway_healthy: true",
        stateOutput: "",
      }),
      stderr: "",
    }),
  });

  const result = await captureProbeRun(toolkit, "reclaude");
  assert.equal(result.level, "ok");
  assert.equal(result.data.health, "ready");
  assert.equal(result.data.loggedIn, true);
  assert.equal(result.data.daemonRunning, true);
});

// ---------------------------------------------------------------------------
// B2: runEndpointProbe 端点判定放宽——不再绑死字面量 HTTP/2 405
// ---------------------------------------------------------------------------

test("runEndpointProbe: 上游把 405 换成 404 时仍判 ok（不再误判 down 触发 restart）", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({
      code: 0,
      stdout: "HTTP/1.1 200 Connection Established\nHTTP/2 404",
      stderr: "",
    }),
  });

  const result = await captureProbeRun(toolkit, "endpoint");
  assert.equal(result.level, "ok");
  assert.equal(result.data.ok, true);
});

test("runEndpointProbe: 隧道都没建立（无 Connection Established）判不可达", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({ code: 1, stdout: "curl: (28) Connection timed out", stderr: "" }),
  });

  const result = await captureProbeRun(toolkit, "endpoint");
  assert.equal(result.level, "error");
  assert.equal(result.data.ok, false);
});

test("runEndpointProbe: curl 补的 rtt 行拆成 latencyMs，不进展示输出；远端命令仍是只读的一次 HEAD", async () => {
  let capturedCommand = "";
  const headers = "HTTP/1.1 200 Connection Established\r\n\r\nHTTP/2 405 \r\ndate: Sat, 03 Oct 2026 10:26:05 GMT\r\n";
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args.at(-1);
      return { code: 0, stdout: `${headers}rtt=0.263418\n`, stderr: "" };
    },
  });
  const result = await captureProbeRun(toolkit, "endpoint");
  assert.equal(result.level, "ok");
  assert.equal(result.data.latencyMs, 263);
  assert.doesNotMatch(result.data.output, /rtt=/);
  assert.match(result.data.output, /HTTP\/2 405/);
  assert.match(capturedCommand, /curl -I --connect-timeout 10 -w 'rtt=%\{time_total\}\\n' https:\/\/chatgpt\.com\/backend-api\/codex\/responses 2>&1 \| sed -n -e '1,14p' -e '15,\$\{\/\^rtt=\/p;\}'$/);
  assert.doesNotMatch(capturedCommand, /[>]\s*[^&]|\btee\b|-o\s/, "不落文件");
});

test("splitEndpointRtt: 失败时是等到放弃为止的时间；没有标记行返回 null 且原文不动", () => {
  assert.deepEqual(splitEndpointRtt("curl: (28) Connection timed out after 10002 milliseconds\nrtt=10.002113\n"), {
    latencyMs: 10002,
    output: "curl: (28) Connection timed out after 10002 milliseconds\n",
  });
  assert.deepEqual(splitEndpointRtt("HTTP/2 405 \r\nrtt=0,5\r\nserver: cloudflare"), { latencyMs: 500, output: "HTTP/2 405 \r\nserver: cloudflare" });
  assert.deepEqual(splitEndpointRtt("HTTP/1.1 200 Connection Established\nHTTP/2 404"), { latencyMs: null, output: "HTTP/1.1 200 Connection Established\nHTTP/2 404" });
  assert.deepEqual(splitEndpointRtt("x-rtt=1.5\n"), { latencyMs: null, output: "x-rtt=1.5\n" }, "只认独占一行的标记");
  assert.deepEqual(splitEndpointRtt(undefined), { latencyMs: null, output: "" });
});

test("resolveClaudeEndpointTarget: 优先 agent 明示目标，其次从 proxyAllowedTargets 读取，旧配置回落 Anthropic", () => {
  assert.deepEqual(
    resolveClaudeEndpointTarget({
      agents: [{ id: "claude-codewing", endpointTarget: "custom-api.example.com:9444" }],
      proxyAllowedTargets: ["api.relay-demo.example:9443"],
    }),
    { host: "custom-api.example.com", port: 9444, authority: "custom-api.example.com:9444", configured: true },
  );
  assert.equal(resolveClaudeEndpointTarget({ proxyAllowedTargets: ["api.relay-demo.example:9443"] }).authority, "api.relay-demo.example:9443");
  assert.equal(resolveClaudeEndpointTarget({ proxyAllowedTargets: ["not a shell-safe target; rm -rf /"] }).authority, "api.anthropic.com:443");
  assert.equal(resolveClaudeEndpointTarget({}).configured, false);
});

test("runClaudeEndpointProbe: 配置白名单 close-api:9443 为探测目标并保留 401 可达语义", async () => {
  let capturedCommand = "";
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({
      proxyAllowedTargets: ["api.relay-demo.example:9443"],
      servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
    }),
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args.at(-1);
      return { code: 0, stdout: "401 0.125", stderr: "" };
    },
  });
  const result = await captureProbeRun(toolkit, "claude-endpoint");
  assert.equal(result.level, "ok");
  assert.equal(result.data.target, "api.relay-demo.example:9443");
  assert.equal(result.data.configuredTarget, true);
  assert.match(capturedCommand, /https:\/\/api\.relay-demo\.example:9443\/v1\/models/);
  assert.doesNotMatch(capturedCommand, /api\.anthropic\.com/);
});

test("runClaudeEndpointProbe: 自建 API 未实现 /v1/models 的 404 仍证明链路可达", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({
      proxyAllowedTargets: ["api.relay-demo.example:9443"],
      servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
    }),
    execFileImpl: async () => ({ code: 0, stdout: "404 0.125", stderr: "" }),
  });
  const result = await captureProbeRun(toolkit, "claude-endpoint");
  assert.equal(result.level, "ok");
  assert.equal(result.data.httpCode, 404);
});

// ---------------------------------------------------------------------------
// B3: 凭证原文读取截断放宽到 16384（旧 head -c 2048 会把真实 ~4.4KB auth.json
// 拦腰截断成非法 JSON，使 parseAgentExpiry 恒返回 unknown）。
// ---------------------------------------------------------------------------

test("runDoctorProbe: 远端命令用 head -c 16384 读取 ~/.codex/auth.json，不再是 2048", async () => {
  let capturedCommand = null;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args[args.length - 1];
      return {
        code: 0,
        stdout: [
          "18 ok | 0 notes | 0 warn | 0 fail",
          "__CODEX_AUTH_BEGIN__",
          JSON.stringify({ expiresAt: Date.now() + 10 * 864e5 }),
          "__CODEX_AUTH_END__",
        ].join("\n"),
        stderr: "",
      };
    },
  });

  await captureProbeRun(toolkit, "doctor");
  assert.match(capturedCommand, /head -c 16384/);
  assert.doesNotMatch(capturedCommand, /head -c 2048\b/);
});

test("runDoctorProbe: doctor 带隧道代理运行（与交互式终端同一联网环境），否则 reachability 直连外网恒失败", async () => {
  let capturedCommand = null;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args[args.length - 1];
      return { code: 0, stdout: "20 ok | 2 notes | 1 warn | 0 fail degraded", stderr: "" };
    },
  });

  await captureProbeRun(toolkit, "doctor");
  const doctorCmd = capturedCommand.split("; ")[0];
  assert.match(doctorCmd, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:7891 /);
  assert.match(doctorCmd, /https_proxy=http:\/\/127\.0\.0\.1:7891 /);
  assert.match(doctorCmd, /NO_PROXY=localhost,127\.0\.0\.1,::1 codex doctor --summary --ascii$/);
});

test("runReclaudeProbe: 远端命令用 head -c 16384 读取 ~/.reclaude/state.json，不再是 2048", async () => {
  let capturedCommand = null;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async (_cmd, args) => {
      capturedCommand = args[args.length - 1];
      return { code: 0, stdout: buildReclaudeCombinedOutput(), stderr: "" };
    },
  });

  await captureProbeRun(toolkit, "reclaude");
  assert.match(capturedCommand, /head -c 16384/);
  assert.match(capturedCommand, /test -s ~\/\.reclaude\/device\.json/);
  assert.doesNotMatch(capturedCommand, /head -c 2048\b/);
});

// ---------------------------------------------------------------------------
// v2.10 / v2.18: log-signals 探针接线——注册规格 + 账号层信号触发 forceRun("reclaude") 复核。
// v2.18 起该探针走 fast profile 采集脚本（__CT_BEGIN 段），不再自建 __LOGSRC_ 命令串。
// ---------------------------------------------------------------------------

// collect.sh 的段落形状（ct_emit 逐字）：__CT_BEGIN <name>__ / 正文 / __CT_END <name>__。
function ctSection(name, body) {
  return `__CT_BEGIN ${name}__\n${body}\n__CT_END ${name}__`;
}

function fastOutput({ logs = "", state = "", ports = "" } = {}) {
  return [
    ctSection("reclaude-logs", logs),
    ctSection("reclaude-state", state),
    ctSection("ports", ports),
  ].join("\n");
}

function slowOutput({
  sys = "",
  gpu = "",
  agents = "",
  ports = "",
} = {}) {
  return [
    ctSection("sys", sys),
    ctSection("gpu", gpu),
    ctSection("agents", agents),
    ctSection("ports", ports),
  ].join("\n");
}

// 抓取 collect:slow:<serverId> 的 spec 并跑一轮。
function slowProbeSpec(toolkit, serverId, servers) {
  let spec = null;
  toolkit.registerLoadProbes({
    scheduler: { registerProbe: (s) => { if (s.id === `collect:slow:${serverId}`) spec = s; } },
    servers,
    activeServerId: serverId,
    getShouldBeRunning: () => true,
  });
  assert.ok(spec, `collect:slow:${serverId} 未注册`);
  return spec;
}

test("registerProbes: processes 间隔为 5 秒，短于 lifecycle 的 6 秒 freshness 窗口", () => {
  const registered = new Map();
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    execFileImpl: async () => ({ code: 0, stdout: "UID PID\n", stderr: "" }),
  });
  toolkit.registerProbes({
    scheduler: { registerProbe: (def) => registered.set(def.id, def), forceRun: () => Promise.resolve() },
    getShouldBeRunning: () => true,
    isChannelOk: () => true,
  });
  const def = registered.get("processes");
  assert.ok(def);
  assert.equal(def.intervalMs, 5000);
  assert.equal(def.timeoutMs, 10000);
});

describe("registerProbes: log-signals", () => {
  it("注册 10s 间隔的 log-signals 探针；门控只看 shouldBeRunning，不受通道熔断影响", () => {
    const registered = new Map();
    const scheduler = {
      registerProbe: (def) => registered.set(def.id, def),
      forceRun: () => Promise.resolve(),
    };
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({ servers: [{ id: "server-01", host: "h", remotePort: 7891 }] }),
      execFileImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    let running = true;
    toolkit.registerProbes({
      scheduler,
      getShouldBeRunning: () => running,
      isChannelOk: () => false,
      getTunnelUp: () => true,
    });
    const def = registered.get("log-signals");
    assert.ok(def, "未注册 log-signals 探针");
    assert.equal(def.layer, "agents");
    assert.equal(def.intervalMs, 10000);
    assert.equal(def.timeoutMs, 15000);
    assert.equal(def.usesSsh, true);
    // v2.18：它是 remotePortOpen 的唯一数据源。若跟着通道熔断走，通道一断就再也
    // 拿不到端口结论 → 通道永远恢复不了（死锁）。所以只看 shouldBeRunning。
    assert.equal(def.enabled(), true, "isChannelOk=false 时仍必须运行");
    running = false;
    assert.equal(def.enabled(), false, "手动停止通道时才跳过");
    assert.equal(typeof def.run, "function");
  });

  it("primary-remote 与 load:* 探针不再注册（已被 fast/slow 采集探针取代）", () => {
    const registered = new Map();
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => baseConfig(),
      execFileImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    toolkit.registerProbes({
      scheduler: { registerProbe: (def) => registered.set(def.id, def), forceRun: () => Promise.resolve() },
      getShouldBeRunning: () => true,
      isChannelOk: () => true,
    });
    toolkit.registerLoadProbes({
      scheduler: { registerProbe: (def) => registered.set(def.id, def) },
      servers: baseConfig().servers,
      activeServerId: "server-01",
      getShouldBeRunning: () => true,
    });
    assert.equal(registered.has("primary-remote"), false);
    assert.equal([...registered.keys()].some((id) => id.startsWith("load:")), false);
  });

  it("账号层新信号触发 forceRun('reclaude') 并透传 onLogSignals", async () => {
    const registered = new Map();
    const forced = [];
    const scheduler = {
      registerProbe: (def) => registered.set(def.id, def),
      forceRun: (id) => {
        forced.push(id);
        return Promise.resolve();
      },
    };
    const revokedLine = 'unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑"}}';
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({ servers: [{ id: "server-01", host: "h", remotePort: 7891 }] }),
      execFileImpl: async () => ({ code: 0, stdout: fastOutput({ logs: revokedLine }), stderr: "" }),
    });
    const received = [];
    toolkit.registerProbes({
      scheduler,
      getShouldBeRunning: () => true,
      isChannelOk: () => true,
      getTunnelUp: () => true,
      onLogSignals: (newSignals) => received.push(...newSignals),
    });
    const result = await registered.get("log-signals").run();
    assert.equal(result.level, "error");
    assert.deepEqual(forced, ["reclaude"]);
    assert.equal(received[0].id, "account-revoked");
  });

  it("v2.47 reclaude 模块关闭：不扫 reclaude 两段、不触发 forceRun，端口结论照常（探针本身仍注册）", async () => {
    const registered = new Map();
    const forced = [];
    const scheduler = {
      registerProbe: (def) => registered.set(def.id, def),
      forceRun: (id) => {
        forced.push(id);
        return Promise.resolve();
      },
    };
    const revokedLine = 'unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑"}}';
    // 运行配置 agents[] 已按 disabledModules 过滤：只剩 codex。
    const config = {
      activeServerId: "server-01",
      agents: [{ id: "codex", kind: "codex" }],
      servers: [{ id: "server-01", host: "h", remotePort: 7891 }],
    };
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => config,
      execFileImpl: async () => ({
        code: 0,
        stdout: fastOutput({ logs: revokedLine, ports: "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*" }),
        stderr: "",
      }),
    });
    const received = [];
    toolkit.registerProbes({
      scheduler,
      config,
      getShouldBeRunning: () => true,
      isChannelOk: () => true,
      onLogSignals: (newSignals) => received.push(...newSignals),
    });
    assert.ok(registered.has("log-signals"), "log-signals 永不随模块关闭");
    assert.equal(registered.has("reclaude"), false);
    const result = await registered.get("log-signals").run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.level, "ok", "账号层信号来自 reclaude 日志段，关闭后不再识别");
    assert.equal(result.data.sourceIds.some((id) => id.startsWith("reclaude-")), false);
    assert.deepEqual(forced, []);
    assert.deepEqual(received, []);
    assert.equal(result.data.remotePortOpen, true, "端口证据不受影响");
  });

  it("fast 采集：ports 段决定 data.ports 与 data.remotePortOpen", async () => {
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({
        activeServerId: "server-01",
        servers: [
          { id: "server-01", host: "myserver", remotePort: 7891 },
          { id: "server-tengxun", host: "tengxunserver", remotePort: 7893 },
        ],
      }),
      execFileImpl: async () => ({
        code: 0,
        stdout: fastOutput({ logs: "normal", ports: "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*" }),
        stderr: "",
      }),
    });
    const result = await captureProbeRun(toolkit, "log-signals");
    assert.equal(result.level, "ok");
    assert.deepEqual(result.data.ports, { 7891: true }, "只采本服务器自己的 remotePort");
    assert.equal(result.data.remotePortOpen, true);
  });

  it("fast 采集只打活跃服务器一条 SSH（其余服务器由 60s 的 slow 探针覆盖）", async () => {
    const calls = [];
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({
        activeServerId: "server-tengxun",
        servers: [
          { id: "server-01", host: "myserver", remotePort: 7891 },
          { id: "server-tengxun", host: "tengxunserver", remotePort: 7893 },
          { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, tunnel: false },
        ],
      }),
      execFileImpl: async (_cmd, args) => {
        calls.push(args.at(-2));
        return { code: 0, stdout: fastOutput({ logs: "normal" }), stderr: "" };
      },
    });
    await captureProbeRun(toolkit, "log-signals");
    assert.deepEqual(calls, ["tengxunserver"], "只对活跃服务器发起一条 SSH");
  });

  it("fast 采集：远端端口未监听时 remotePortOpen=false（旧 primary-remote 的端口判据）", async () => {
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => baseConfig(),
      execFileImpl: async () => ({ code: 0, stdout: fastOutput({ logs: "normal", ports: "" }), stderr: "" }),
    });
    const result = await captureProbeRun(toolkit, "log-signals");
    assert.equal(result.data.remotePortOpen, false);
  });

  it("fast 采集：SSH 失败 → level=error、data=null、不产生信号", async () => {
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => baseConfig(),
      execFileImpl: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host myserver port 22: Connection refused" }),
    });
    const result = await captureProbeRun(toolkit, "log-signals");
    assert.equal(result.level, "error");
    assert.equal(result.error, true);
    assert.equal(result.data, null);
    assert.match(result.reason, /refused:/);
  });

  it("fast 采集：脚本经 stdin 送达、远端命令只有 env … sh -s（零残留）", async () => {
    let captured = null;
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => baseConfig(),
      execFileImpl: async (cmd, args, options) => {
        captured = { cmd, args, options };
        return { code: 0, stdout: fastOutput({ logs: "normal" }), stderr: "" };
      },
    });
    await captureProbeRun(toolkit, "log-signals");
    assert.equal(captured.cmd, "ssh");
    assert.equal(captured.args.at(-1), "env CT_PROFILE='fast' CT_PORTS='7891' sh -s");
    assert.ok(captured.options.input.startsWith("#!/bin/sh"), "脚本正文必须经 stdin 送达");
    assert.equal(captured.options.timeoutMs, 15000);
  });
});

// ---------------------------------------------------------------------------
// v2.18 slow 采集探针：CT_PORTS / 各段解析
// ---------------------------------------------------------------------------

describe("collect:slow 采集探针", () => {
  const THREE_SERVERS = [
    { id: "server-01", name: "主集群服务器", host: "myserver", remotePort: 7891, localPort: 8888 },
    { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", remotePort: 7893 },
    { id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", remotePort: 7894, tunnel: false },
  ];

  function toolkitFor(stdout, onCall) {
    return createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({ activeServerId: "server-01", servers: THREE_SERVERS }),
      execFileImpl: async (cmd, args, options) => {
        if (onCall) onCall({ cmd, args, options });
        return { code: 0, stdout: typeof stdout === "function" ? stdout() : stdout, stderr: "" };
      },
    });
  }

  it("CT_PORTS 只带该服务器自己的 remotePort", async () => {
    const calls = [];
    const toolkit = toolkitFor(slowOutput({ sys: "myserver" }), (call) => calls.push(call.args.at(-1)));
    await slowProbeSpec(toolkit, "server-01", THREE_SERVERS).run();
    assert.equal(calls[0], "env CT_PROFILE='slow' CT_PORTS='7891' sh -s", "不再携带其它服务器的端口与 hub/心跳参数");
  });

  it("各段解析：load / gpu / agents / ports", async () => {
    const toolkit = toolkitFor(slowOutput({
      sys: [
        "node05",
        " 14:20:01 up 12 days,  3:42,  2 users,  load average: 0.52, 0.48, 0.45",
        "Mem:            31G        12G        18G       1.0G       1.2G        18G",
        "/dev/sda1       458G  120G  315G  28% /",
        "nproc: 8",
      ].join("\n"),
      gpu: [
        "0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
        "1, NVIDIA GeForce RTX 4090, 512 MiB, 24564 MiB, 37 %",
        "2, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
        "3, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %",
      ].join("\n"),
      agents: "codex=1\nreclaude=1\nzcode=0\nreclaudeActive=active\nuser=kai\nhostname=node05",
      ports: "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*",
    }));
    const result = await slowProbeSpec(toolkit, "server-01", THREE_SERVERS).run();
    assert.equal(result.level, "ok");
    assert.equal(result.data.load.cpu, 7); // 有 nproc 行时按核数归一化：0.52/8 ≈ 7%
    assert.equal(result.data.load.ram, 39);
    assert.equal(result.data.load.disk, 28);
    assert.equal(result.data.gpu.length, 4);
    assert.deepEqual(result.data.gpu[1], {
      index: 1, name: "NVIDIA GeForce RTX 4090", memUsedMb: 512, memTotalMb: 24564, util: 37,
    });
    assert.equal(result.data.agents.codex, true);
    assert.equal(result.data.agents.zcode, false);
    assert.equal(result.data.agents.user, "kai");
    assert.equal(result.data.remotePortOpen, true);
    assert.equal("hub" in result.data, false);
  });

  // v2.62：gpuapp 行尾的作业号 + proc-top 段。
  it("v2.62：采集账号自己的 GPU 进程按作业合并（账号取 agents 段），proc-top 段进 data.procTop", async () => {
    const stdout = [
      ctSection("sys", "node05"),
      ctSection("gpu", [
        "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71",
        "gpuapp=GPU-8a88|kai|4412|python|48213",
        "gpuapp=GPU-8a88|kai|5358|python|48214",
        "gpuapp=GPU-8a88|lin|800|python|48300",
      ].join("\n")),
      ctSection("agents", "codex=1\nuser=kai\nhostname=node05"),
      ctSection("ports", ""),
      ctSection("proc-top", "sampled=40\nslurm=1\ntop=kai|1449.0|0.0|126000000|0|12|0\ntop=lin|0.0|554.0|0|67000000|0|6"),
    ].join("\n");
    const result = await slowProbeSpec(toolkitFor(stdout), "server-01", THREE_SERVERS).run();
    assert.deepEqual(result.data.gpu[0].users, [
      { user: "kai", memMb: 9770, jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }] },
      { user: "lin", memMb: 800 },
    ]);
    assert.equal(result.data.procTop.sampled, 40);
    assert.equal(result.data.procTop.slurm, true);
    assert.deepEqual(result.data.procTop.users.map((u) => [u.user, u.cpuJobPct, u.cpuOtherPct]), [["kai", 1449, 0], ["lin", 0, 554]]);
    assert.deepEqual(Object.keys(result.data), ["load", "usage", "gpu", "agents", "ports", "remotePortOpen", "slurm", "procTop", "tunnelEgress"], "旧字段顺序不变，新字段加在最后");
  });

  it("v2.62：agents 段没回来时账号取 slurm 段的 user；旧采集脚本（没有 proc-top 段、gpuapp 四段）→ procTop 为 null、不带 jobs", async () => {
    const gpuNew = "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71\ngpuapp=GPU-8a88|kai|4412|python|48213";
    const viaSlurm = [ctSection("sys", "node05"), ctSection("gpu", gpuNew), ctSection("slurm", "state=ok\nuser=kai")].join("\n");
    const fromSlurm = await slowProbeSpec(toolkitFor(viaSlurm), "server-01", THREE_SERVERS).run();
    assert.equal(fromSlurm.data.agents, null);
    assert.deepEqual(fromSlurm.data.gpu[0].users, [{ user: "kai", memMb: 4412, jobs: [{ id: "48213", memMb: 4412 }] }]);
    assert.equal(fromSlurm.data.procTop, null, "段缺失");

    const old = slowOutput({ sys: "node05", gpu: "gpu=0, GPU-8a88, NVIDIA GeForce RTX 4090, 9806, 24564, 100, 57, 210.71\ngpuapp=GPU-8a88|kai|4412|python", agents: "user=kai" });
    const legacy = await slowProbeSpec(toolkitFor(old), "server-01", THREE_SERVERS).run();
    assert.deepEqual(legacy.data.gpu[0].users, [{ user: "kai", memMb: 4412 }]);
    assert.equal(legacy.data.procTop, null);

    const empty = [ctSection("sys", "node05"), ctSection("proc-top", "")].join("\n");
    assert.equal((await slowProbeSpec(toolkitFor(empty), "server-01", THREE_SERVERS).run()).data.procTop, null, "空段（远端 ps 不可用 / 超时）");
  });

  it("tunnel-egress 段进 data.tunnelEgress；段缺失 / 空段 → null，远端没有 ss → state: absent", async () => {
    const stdout = [
      ctSection("sys", "node05"),
      ctSection("tunnel-egress", "state=ok\nport=7891\ndetail=full\ntotal=3|1200|18000\nothers=0|-|-\nprogs=1\nprog=codex|3|1200|18000"),
    ].join("\n");
    const result = await slowProbeSpec(toolkitFor(stdout), "server-01", THREE_SERVERS).run();
    assert.deepEqual(result.data.tunnelEgress.programs, [{ name: "codex", conns: 3, sentBytes: 1200, recvBytes: 18000 }]);
    assert.equal(result.data.tunnelEgress.port, 7891);

    const missing = await slowProbeSpec(toolkitFor(ctSection("sys", "node05")), "server-01", THREE_SERVERS).run();
    assert.equal(missing.data.tunnelEgress, null, "旧采集脚本没有这一段");
    const empty = [ctSection("sys", "node05"), ctSection("tunnel-egress", "")].join("\n");
    assert.equal((await slowProbeSpec(toolkitFor(empty), "server-01", THREE_SERVERS).run()).data.tunnelEgress, null);
    const absent = [ctSection("sys", "node05"), ctSection("tunnel-egress", "state=absent\nport=7891")].join("\n");
    assert.equal((await slowProbeSpec(toolkitFor(absent), "server-01", THREE_SERVERS).run()).data.tunnelEgress.state, "absent");
  });

  it("SSH 失败（无任何段落）→ level=error、data=null，且带 classifySshFailure 的原因", async () => {
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({ activeServerId: "server-01", servers: THREE_SERVERS }),
      execFileImpl: async () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)." }),
    });
    const result = await slowProbeSpec(toolkit, "server-01", THREE_SERVERS).run();
    assert.equal(result.level, "error");
    assert.equal(result.data, null);
    assert.match(result.reason, /auth:/);
  });

  it("未知服务器 id → error 且不发起任何 SSH", async () => {
    let calls = 0;
    const toolkit = createChannelToolkit({
      rootDir: "/tmp",
      getConfig: async () => ({ activeServerId: "server-01", servers: [] }),
      execFileImpl: async () => {
        calls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    let spec = null;
    toolkit.registerLoadProbes({
      scheduler: { registerProbe: (s) => { spec = s; } },
      servers: [THREE_SERVERS[0]],
      activeServerId: "server-01",
      getShouldBeRunning: () => true,
    });
    const result = await spec.run();
    assert.equal(result.level, "error");
    assert.match(result.reason, /未知服务器/);
    assert.equal(calls, 0);
  });
});

test("buildProbeSshArgs: ControlMaster 走家目录，并带上个人身份 -i/-l", () => {
  // 连接复用是非 win32 才有的行为，显式注入平台，免得断言随 CI 宿主漂移。
  const args = buildProbeSshArgs(
    { host: "myserver" },
    { sshIdentityFile: "/tmp/id_ed25519_codextunnel", sshUser: "cluster-alice" },
    { platform: "darwin" },
  );
  const joined = args.join(" ");
  assert.ok(joined.includes("ControlMaster=auto"));
  assert.ok(joined.includes("ControlPath=~/.ssh/control-%r@%h:%p"));
  assert.ok(!joined.includes("Application Support"));
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("/tmp/id_ed25519_codextunnel"));
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("-l"));
  assert.ok(args.includes("cluster-alice"));
  assert.equal(args.at(-1), "myserver");
});

// 旧 primary-remote 的同名用例：探针 id 换成 collect:slow:server-01 后，
// 断言（身份参数 + ControlMaster + SSH 失败走 classifySshFailure）逐条不变。
test("collect:slow 假 ssh 参数列表包含身份与 ControlMaster", async () => {
  let capturedArgs = null;
  const servers = [{ id: "server-01", name: "主", host: "myserver", remotePort: 7891, localPort: 8888 }];
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ sshIdentityFile: "/tmp/id", sshUser: "bob", servers }),
    execFileImpl: async (cmd, args) => {
      capturedArgs = { cmd, args };
      return { code: 255, stdout: "", stderr: "Permission denied (publickey)." };
    },
  });
  const result = await slowProbeSpec(toolkit, "server-01", servers).run();
  assert.equal(capturedArgs.cmd, "ssh");
  const joined = capturedArgs.args.join(" ");
  assert.ok(joined.includes("-i"));
  assert.ok(joined.includes("/tmp/id"));
  assert.ok(joined.includes("IdentitiesOnly=yes"));
  assert.ok(joined.includes("-l"));
  assert.ok(joined.includes("bob"));
  // 探针内部按 process.platform 决定是否复用连接：win32 必须不带 Control*，其余平台必须带。
  const multiplexed = process.platform !== "win32";
  assert.equal(joined.includes("ControlMaster"), multiplexed);
  assert.equal(joined.includes("ControlPath=~/.ssh/control-%r@%h:%p"), multiplexed);
  assert.match(result.reason, /auth:/);
});

// 旧 "primary-remote 远端命令保持单层括号" 的接班用例：远端端口探测已从
// 「本机拼 (ss -lnt …) 命令串」改为「脚本里的 ss -ltn + 本机 parseListeningPorts」，
// 双层括号回归（v2.12）不再可能发生；这里守住它真正的结论——端口开放判定正确，
// 且本机再不往远端命令串里拼任何 shell 元字符。
test("collect:slow 远端命令不含任何 shell 元字符，端口开放判定仍然成立", async () => {
  let remoteCommand = "";
  const servers = [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }];
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ activeServerId: "server-01", servers }),
    execFileImpl: async (_cmd, args) => {
      remoteCommand = args.at(-1);
      return {
        code: 0,
        stdout: slowOutput({ sys: "master", ports: "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*" }),
        stderr: "",
      };
    },
  });
  const result = await slowProbeSpec(toolkit, "server-01", servers).run();
  assert.equal(remoteCommand, "env CT_PROFILE='slow' CT_PORTS='7891' sh -s");
  assert.doesNotMatch(remoteCommand, /[;&|`$()<>]/, "远端命令串不得含任何 shell 元字符");
  assert.equal(result.data.remotePortOpen, true);
});

test("endpoint 探针 SSH 失败走 classifySshFailure，不再只报 ssh exit", async () => {
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({
      servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
    }),
    execFileImpl: async () => ({
      code: 255,
      stdout: "",
      stderr: "ssh: connect to host myserver port 22: Connection refused",
    }),
  });
  const result = await captureProbeRun(toolkit, "endpoint");
  assert.equal(result.level, "error");
  assert.match(result.reason, /refused:/);
  assert.doesNotMatch(result.reason, /ssh exit 255$/);
});

// ---------------------------------------------------------------------------
// exec 封装统一（lib/exec.mjs）：ENOENT 不再让 Promise 永挂；execShell 死代码已删。
// ---------------------------------------------------------------------------

test("toolkit.execFile: 命令不存在（ENOENT）时 Promise 正常结算，不再永挂", async () => {
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => baseConfig() });
  const result = await toolkit.execFile("definitely-not-a-real-binary-xyz-12345", [], { timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
});

test("toolkit 不再暴露 execShell（bash -lc 拼接串死代码已删除）", () => {
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => baseConfig() });
  assert.equal(toolkit.execShell, undefined);
});

// ---------------------------------------------------------------------------
// v2.15 核数采集：nproc 段现在由 collect.sh 的 sys 段产出（collector.test.mjs 守其形状），
// 本文件继续守住"新格式归一化 / 老格式向后兼容"的解析结论。
// ---------------------------------------------------------------------------

// 老格式远端输出（无 nproc 行）与新格式（追加 nproc 行）。
const LEGACY_LOAD_STDOUT = [
  "myserver",
  " 14:20:01 up 12 days,  3:42,  2 users,  load average: 0.52, 0.48, 0.45",
  "Mem:            31G        12G        18G       1.0G       1.2G        18G",
  "/dev/sda1       458G  120G  315G  28% /",
].join("\n");
const NPROC_LOAD_STDOUT = `${LEGACY_LOAD_STDOUT}\nnproc: 8`;

// 以注入的假 sys 段驱动一轮 collect:slow:server-01。
async function runLoadProbeWith(sysText, onArgs) {
  const servers = baseConfig().servers;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ activeServerId: "server-01", servers }),
    execFileImpl: async (_cmd, args) => {
      if (onArgs) onArgs(args);
      return { code: 0, stdout: slowOutput({ sys: sysText }), stderr: "" };
    },
  });
  return slowProbeSpec(toolkit, "server-01", servers).run();
}

test("slow 采集新格式输出：nproc 行透传到 load.output 且不破坏 cpu/ram/disk 解析", async () => {
  const result = await runLoadProbeWith(NPROC_LOAD_STDOUT);
  assert.equal(result.level, "ok");
  assert.equal(result.data.load.cpu, 7); // 有 nproc 行时按核数归一化：0.52/8 ≈ 7%
  assert.equal(result.data.load.ram, 39);
  assert.equal(result.data.load.disk, 28);
  assert.match(result.data.load.output, /nproc: 8/);
});

test("slow 采集老格式输出（无 nproc 行）解析向后兼容", async () => {
  const result = await runLoadProbeWith(LEGACY_LOAD_STDOUT);
  assert.equal(result.level, "ok");
  assert.equal(result.data.load.cpu, 52);
  assert.equal(result.data.load.ram, 39);
  assert.equal(result.data.load.disk, 28);
  assert.doesNotMatch(result.data.load.output, /nproc:/);
});

test("slow 采集：sys 段缺失时如实报 error，但已到手的 gpu 段照常交出", async () => {
  const servers = baseConfig().servers;
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => ({ activeServerId: "server-01", servers }),
    execFileImpl: async () => ({
      code: 0,
      stdout: slowOutput({ sys: "", gpu: "0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %" }),
      stderr: "",
    }),
  });
  const result = await slowProbeSpec(toolkit, "server-01", servers).run();
  assert.equal(result.level, "error");
  assert.match(result.reason, /负载探测失败/);
  assert.equal(result.data.load, null);
  assert.equal(result.data.gpu.length, 1);
});


// ---- v2.18 多隧道：getProcesses 把整份隧道清单交给 parseProcessList ----
// 旧实现只传活跃服务器一条，非活跃服务器的 ssh 进程无从识别（layers.tunnels 永远
// 停在"隧道状态未知"）。零 SSH：execFileImpl 直接喂假的 `ps -ef` 输出。

const MULTI_TUNNEL_PS = [
  "  501 11 1 0 ??  0:00.01 node work/local_http_connect_proxy.mjs",
  "  501 13 1 0 ??  0:00.01 node work/monitor/channel-supervisor.mjs",
  "  501 21 1 0 ??  0:00.01 ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver",
  "  501 22 1 0 ??  0:00.01 ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver",
  "  501 23 1 0 ??  0:00.01 ssh -N -R 127.0.0.1:9999:127.0.0.1:8888 someoneelses-host",
].join("\n");

function multiTunnelConfig(overrides = {}) {
  return {
    activeServerId: "server-01",
    servers: [
      { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 },
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 },
      { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, localPort: 8891, tunnel: false },
    ],
    ...overrides,
  };
}

test("getProcesses: 两条不同 -R 的 ssh 各归到自己的 serverId，tunnel:false 的条目不建桶", async () => {
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => multiTunnelConfig(),
    execFileImpl: async () => ({ code: 0, stdout: MULTI_TUNNEL_PS, stderr: "" }),
  });

  const processes = await toolkit.getProcesses();

  assert.deepEqual(Object.keys(processes.tunnelsByServer), ["server-01", "server-tengxun"]);
  assert.deepEqual(processes.tunnelsByServer["server-01"].map((p) => p.pid), ["21"]);
  assert.deepEqual(processes.tunnelsByServer["server-tengxun"].map((p) => p.pid), ["22"]);
  // reverseTunnel 是并集，别人的 9999 隧道不在其中。
  assert.deepEqual(processes.reverseTunnel.map((p) => p.pid), ["21", "22"]);
  assert.equal(processes.supervisor.length, 1);
  assert.equal(processes.localProxy.length, 1);
});

test("getProcesses: 所有 -R 的本地端口都按 resolveProxyPort 匹配，不用条目自带的 localPort", async () => {
  // server-tengxun 配的是 localPort 8890，但隧道实际落在活跃服务器的代理端口 8888 上。
  // 拿 8890 去匹配命令行会让这台服务器永远"隧道未开启"。
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => multiTunnelConfig(),
    execFileImpl: async () => ({ code: 0, stdout: MULTI_TUNNEL_PS, stderr: "" }),
  });
  const processes = await toolkit.getProcesses();
  assert.equal(processes.tunnelsByServer["server-tengxun"].length, 1);
});

test("getProcesses: 只有次要服务器的隧道在时，活跃服务器那格为空（热接管不成立）", async () => {
  const onlySecondary = [
    "  501 11 1 0 ??  0:00.01 node work/local_http_connect_proxy.mjs",
    "  501 13 1 0 ??  0:00.01 node work/monitor/channel-supervisor.mjs",
    "  501 22 1 0 ??  0:00.01 ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver",
  ].join("\n");
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => multiTunnelConfig(),
    execFileImpl: async () => ({ code: 0, stdout: onlySecondary, stderr: "" }),
  });

  const processes = await toolkit.getProcesses();

  assert.deepEqual(processes.tunnelsByServer["server-01"], [], "配了隧道但没起来 → 空数组而不是缺键");
  assert.equal(processes.reverseTunnel.length, 1, "并集里确实有一条，只看它会误判成链路完整");
  // 主链路隧道判据必须按活跃服务器那格判，否则次要隧道还活着时主链路会被误判成完整。
  assert.equal(isActiveTunnelUp(processes, "server-01"), false);
  assert.equal(isActiveTunnelUp(processes, "server-tengxun"), true);
  assert.equal(isActiveTunnelUp(processes, ""), true, "不传 activeServerId 时沿用旧判据（看并集）");
});

test("getProcesses: 服务器配置为空时退化为旧形状（不出现 tunnelsByServer 键）", async () => {
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => ({ activeServerId: "", servers: [] }),
    execFileImpl: async () => ({ code: 0, stdout: MULTI_TUNNEL_PS, stderr: "" }),
  });
  const processes = await toolkit.getProcesses();
  assert.equal("tunnelsByServer" in processes, false);
});

test("processes 探针: tunnel 结论按活跃服务器判，不因次要隧道还活着而报 ok", async () => {
  const onlySecondary = [
    "  501 11 1 0 ??  0:00.01 node work/local_http_connect_proxy.mjs",
    "  501 13 1 0 ??  0:00.01 node work/monitor/channel-supervisor.mjs",
    "  501 22 1 0 ??  0:00.01 ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver",
  ].join("\n");
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => multiTunnelConfig(),
    execFileImpl: async () => ({ code: 0, stdout: onlySecondary, stderr: "" }),
  });

  const result = await captureProbeRun(toolkit, "processes");

  assert.equal(result.reason, "supervisor=true proxy=true tunnel=false");
  assert.equal(result.level, "warn", "探针结论必须与 layers.channel 同口径，不能自相矛盾");
});

test("processes 探针: 活跃服务器隧道在时报 ok（多隧道下的正常态）", async () => {
  const toolkit = createChannelToolkit({
    platform: "darwin", // 本组注入 POSIX ps 夹具；Windows 原生查询另测。
    rootDir: "/tmp",
    getConfig: async () => multiTunnelConfig(),
    execFileImpl: async () => ({ code: 0, stdout: MULTI_TUNNEL_PS, stderr: "" }),
  });
  const result = await captureProbeRun(toolkit, "processes");
  assert.equal(result.reason, "supervisor=true proxy=true tunnel=true");
  assert.equal(result.level, "ok");
});

test("collect:slow 确认主机密钥后探针带隔离 known_hosts", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { resolveHostKeyPath, buildHostKeyArgs } = await import("./host-key-policy.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "probe-kh-"));
  const knownHostsPath = resolveHostKeyPath(dir, "server-01");
  mkdirSync(path.dirname(knownHostsPath), { recursive: true });
  writeFileSync(knownHostsPath, "myserver ssh-ed25519 AAAA\n");
  const calls = [];
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    dataDir: dir,
    getConfig: async () => baseConfig(),
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await slowProbeSpec(toolkit, "server-01", baseConfig().servers).run();
  // buildHostKeyArgs 会对含空格/反斜杠的路径按 ssh_config 语法加引号转义（Windows 路径必然命中），
  // 所以期望值交给同一个生产函数构造，而不是自己拼裸路径。
  const expectedUserKnownHosts = buildHostKeyArgs({ knownHostsPath }).find((arg) => String(arg).startsWith("UserKnownHostsFile="));
  assert.ok(calls.some((call) => Array.isArray(call.args) && call.args.includes(expectedUserKnownHosts)));
  assert.ok(calls.some((call) => Array.isArray(call.args) && call.args.includes("GlobalKnownHostsFile=/dev/null")));
  rmSync(dir, { recursive: true, force: true });
});

test("仅监控、无服务器与全部禁用时fast/Agent探针不发起SSH", async () => {
  for (const servers of [[], [{ id: "only", host: "only.invalid", tunnel: false }], [{ id: "off", host: "off.invalid", disabled: true }]]) {
    const calls = [];
    const config = { servers, activeServerId: servers[0]?.id };
    const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => config, execFileImpl: async (...args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; } });
    for (const id of ["log-signals", "doctor", "endpoint", "reclaude", "claude-endpoint"]) {
      const result = await captureProbeRun(toolkit, id);
      assert.equal(result.level, "skipped", `${id} 应跳过`);
    }
    assert.equal(calls.length, 0);
  }
});

test("getMainServerConfig跳过disabled，validation不注册仅监控/disabled", () => {
  const config = { activeServerId: "off", servers: [{ id: "off", host: "off.invalid", disabled: true, validationProfile: { workspaceSmokeCommand: "true" } }, { id: "only", host: "only.invalid", tunnel: false, validationProfile: { workspaceSmokeCommand: "true" } }] };
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => config });
  assert.equal(toolkit.getMainServerConfig(config).id, "only");
  for (const activeServerId of ["off", "only"]) {
    assert.deepEqual(toolkit.registerValidationProbes({ scheduler: { registerProbe() { assert.fail("不可注册"); } }, servers: config.servers, activeServerId }), []);
  }
});

// ---- 性能：5s 快路径只按已知 pid 校验，全量 ps -ef 降到 ~60s 一次 ----

const PACKAGED_BIN = "/Users/u/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";

// 假 ps：-ef 返回全表（ps -ef 形），-o pid=,command= -p 按表回答（缺席 pid 非零退出、无输出）。
function fakePs(table) {
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "-ef") {
      const stdout = [...table.entries()].map(([pid, command]) => `  501 ${pid} 1 0 8:56AM ??  0:00.01 ${command}`).join("\n");
      return { code: 0, stdout, stderr: "" };
    }
    const pids = String(args.at(-1)).split(",").map(Number);
    const lines = pids.filter((pid) => table.has(pid)).map((pid) => `${String(pid).padStart(5)} ${table.get(pid)}`);
    return { code: lines.length === pids.length ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
  };
  return { calls, execFileImpl };
}

function healthyTable() {
  return new Map([
    [11, `${PACKAGED_BIN} work/local_http_connect_proxy.mjs`],
    [13, `${PACKAGED_BIN} work/monitor/channel-supervisor.mjs`],
    [21, "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver"],
    [22, "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver"],
    [90, "/usr/libexec/unrelated --daemon"],
  ]);
}

function fastPathToolkit(table, { platform = "darwin", clock = { t: 0 }, config = multiTunnelConfig() } = {}) {
  const ps = fakePs(table);
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => config,
    execFileImpl: ps.execFileImpl,
    platform,
    now: () => clock.t,
  });
  return { toolkit, ps, clock };
}

test("getProcesses 快路径：完整进程集后 5s 拍只按 pid 单查受管进程，结果与全量一致（含打包模式）", async () => {
  const table = healthyTable();
  const { toolkit, ps, clock } = fastPathToolkit(table);
  const full = await toolkit.getProcesses();
  assert.deepEqual(ps.calls, ["ps -ef"]);
  assert.equal(full.supervisor.length, 1, "打包模式 supervisor 必须被识别");
  assert.equal(full.localProxy.length, 1);

  ps.calls.length = 0;
  clock.t = 5000;
  const fast = await toolkit.getProcesses();
  assert.equal(ps.calls.includes("ps -ef"), false, "快路径不得全表扫描");
  assert.deepEqual(ps.calls.sort(), ["ps -o pid=,command= -p 11", "ps -o pid=,command= -p 13", "ps -o pid=,command= -p 21", "ps -o pid=,command= -p 22"]);
  assert.deepEqual(fast, full);
  assert.equal(isActiveTunnelUp(fast, "server-01"), true);
  assert.equal(fast.supervisor.length > 0 && fast.localProxy.length > 0, true);
});

test("getProcesses 快路径：linux 一条逗号列表查询", async () => {
  const { toolkit, ps, clock } = fastPathToolkit(healthyTable(), { platform: "linux" });
  await toolkit.getProcesses();
  ps.calls.length = 0;
  clock.t = 5000;
  await toolkit.getProcesses();
  assert.equal(ps.calls.length, 1);
  assert.match(ps.calls[0], /^ps -o pid=,command= -p [\d,]+$/);
  assert.deepEqual(ps.calls[0].split(" -p ")[1].split(",").map(Number).sort((a, b) => a - b), [11, 13, 21, 22]);
});

test("getProcesses 快路径：已知 pid 消失或命令变化立刻回落全量扫描，新 pid 当拍可见", async () => {
  const table = healthyTable();
  const { toolkit, ps, clock } = fastPathToolkit(table);
  await toolkit.getProcesses();

  // 隧道被 supervisor 重建：旧 pid 消失，新 pid 出现。
  table.delete(21);
  table.set(31, "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver");
  ps.calls.length = 0;
  clock.t = 5000;
  const afterRespawn = await toolkit.getProcesses();
  assert.ok(ps.calls.includes("ps -ef"), "pid 消失必须全量");
  assert.deepEqual(afterRespawn.tunnelsByServer["server-01"].map((p) => p.pid), ["31"]);

  // pid 复用：同一 pid 变成无关进程。
  table.set(22, "/usr/bin/some-other-thing");
  ps.calls.length = 0;
  clock.t = 10000;
  const afterReuse = await toolkit.getProcesses();
  assert.ok(ps.calls.includes("ps -ef"), "命令行变化必须全量");
  assert.deepEqual(afterReuse.tunnelsByServer["server-tengxun"], []);
});

test("getProcesses 快路径：进程集不完整时每拍全量（尽快发现新拉起的进程），超过 60s 必做全量", async () => {
  const table = healthyTable();
  table.delete(13); // supervisor 不在
  const { toolkit, ps, clock } = fastPathToolkit(table);
  await toolkit.getProcesses();
  ps.calls.length = 0;
  clock.t = 5000;
  await toolkit.getProcesses();
  assert.deepEqual(ps.calls, ["ps -ef"], "缺角色时沿用旧行为");

  table.set(13, `${PACKAGED_BIN} work/monitor/channel-supervisor.mjs`);
  clock.t = 10000;
  const recovered = await toolkit.getProcesses();
  assert.equal(recovered.supervisor.length, 1);

  // 完整之后走快路径，直到 60s 窗口到期再全量一次（发现孤儿/重复进程）。
  table.set(41, "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver"); // 重复隧道
  ps.calls.length = 0;
  clock.t = 15000;
  await toolkit.getProcesses();
  assert.equal(ps.calls.includes("ps -ef"), false);
  clock.t = 10000 + 60000;
  ps.calls.length = 0;
  const periodic = await toolkit.getProcesses();
  assert.ok(ps.calls.includes("ps -ef"));
  assert.equal(periodic.tunnelsByServer["server-01"].length, 2, "周期全量把重复隧道找出来");
});

test("getProcesses 快路径：配置变化（隧道目标）立即全量", async () => {
  const config = multiTunnelConfig();
  const { toolkit, ps, clock } = fastPathToolkit(healthyTable(), { config });
  await toolkit.getProcesses();
  config.servers[1] = { ...config.servers[1], remotePort: 7999 };
  ps.calls.length = 0;
  clock.t = 5000;
  await toolkit.getProcesses();
  assert.deepEqual(ps.calls, ["ps -ef"]);

});

// v2.33：slow 采集的 slurm 段里有直连节点时，toolkit 注入的 appendLog 在断开 / 恢复时各收到一条，
// 节点对象上挂 lastSeenAt；资源层级别不受影响（只透传）。
test("slow 采集：直连节点断开 / 恢复经注入的 appendLog 各记一条，节点挂 lastSeenAt", async () => {
  const logs = [];
  let hopStatus = "ok";
  const slurmSection = () => [
    "state=ok",
    "node=node07|idle|0/192/0/192|1.00|1|2|0|(null)|gpu:0|CPU*|none",
    `hop=node04|${hopStatus}|DOWN+NOT_RESPONDING`,
    "hopkv=node04|nproc=192",
  ].join("\n");
  const toolkit = createChannelToolkit({
    rootDir: "/tmp",
    getConfig: async () => baseConfig(),
    appendLog: (message, fields) => logs.push({ message, ...fields }),
    execFileImpl: async () => ({
      code: 0,
      stderr: "",
      stdout: [
        "__CT_BEGIN sys__", "master", " 10:00:00 up 1 day,  2 users,  load average: 0.10, 0.20, 0.30", "__CT_END sys__",
        "__CT_BEGIN slurm__", slurmSection(), "__CT_END slurm__",
      ].join("\n"),
    }),
  });
  const specs = new Map();
  toolkit.registerLoadProbes({
    scheduler: { registerProbe: (spec) => specs.set(spec.id, spec) },
    servers: baseConfig().servers,
    getShouldBeRunning: () => true,
  });
  const run = () => specs.get("collect:slow:server-01").run();
  const first = await run();
  const node04 = first.data.slurm.nodes.find((n) => n.name === "node04");
  assert.equal(node04.source, "direct");
  assert.ok(Number.isFinite(node04.lastSeenAt));
  assert.deepEqual(logs.map((l) => l.event), ["direct-node-found"]);
  hopStatus = "timeout";
  const second = await run();
  assert.equal(second.data.slurm.nodes.find((n) => n.name === "node04").lastSeenAt, node04.lastSeenAt);
  hopStatus = "ok";
  await run();
  assert.deepEqual(logs.map((l) => [l.event, l.level]), [
    ["direct-node-found", "info"],
    ["direct-node-down", "warn"],
    ["direct-node-up", "info"],
  ]);
  assert.equal(logs[1].serverId, "server-01");
});

test("fixture 模式的工具箱：CLI 最新版本不联网，取不到就是 latest:null + error", async () => {
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => baseConfig(), fixtureMode: true });
  const latest = await toolkit.cliVersions.getLatest({ wait: true });
  const entries = Object.values(latest);
  assert.ok(entries.length >= 2, "codex 与 Claude Code 都有一项");
  for (const entry of entries) {
    assert.equal(entry.latest, null);
    assert.match(entry.error, /fixture 模式不联网/);
  }
});
