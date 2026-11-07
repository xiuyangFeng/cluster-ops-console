import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyHealth,
  computeTunnelBackoffSec,
  computeRepairBackoffMs,
  classifyAgentHealth,
  normalizeAgentConfig,
  getSupervisorCommand,
  isActiveTunnelUp,
  parseReclaudeStatus,
  parseReclaudeCombinedOutput,
  parseRemoteProbeOutput,
  parseDoctorSummary,
  parseProcessList,
  buildNetworkChannel,
  buildAgentOverview,
  buildClaudeAgentStatus,
  buildCodexAgentStatus,
  detectAccountFault,
  isEndpointReachable,
  TUNNEL_RECORD_PREFIX,
  tunnelRecordName,
} from "./monitor-core.mjs";

test("parseProcessList finds local proxy and reverse tunnel processes", () => {
  const output = `
  501 111 1 0 ?? node work/local_http_connect_proxy.mjs
  501 112 1 0 ?? ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver
  501 113 1 0 ?? grep local_http_connect_proxy
  `;

  assert.deepEqual(parseProcessList(output, { host: "myserver", remotePort: 7891, localPort: 8888 }), {
    localProxy: [{ pid: "111", command: "node work/local_http_connect_proxy.mjs" }],
    reverseTunnel: [
      { pid: "112", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" },
    ],
    supervisor: [],
  });
});

test("parseProcessList: 没有活跃服务器时不识别任何隧道（不凭空假设 myserver:7891）", () => {
  const output = `
  501 111 1 0 ?? node work/local_http_connect_proxy.mjs
  501 112 1 0 ?? ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver
  501 113 1 0 ?? node work/monitor/channel-supervisor.mjs
  `;
  assert.deepEqual(parseProcessList(output), {
    localProxy: [{ pid: "111", command: "node work/local_http_connect_proxy.mjs" }],
    reverseTunnel: [],
    supervisor: [{ pid: "113", command: "node work/monitor/channel-supervisor.mjs" }],
  });
  assert.deepEqual(parseProcessList(output, null, { tunnels: [{ id: "server-01", host: "myserver", remotePort: 7891 }] }).reverseTunnel, [],
    "隧道清单里没有本地端口、也没有活跃服务器时同样不猜 8888");
});

test("parseDoctorSummary extracts ok, warn, fail counts", () => {
  const output = `
Connectivity
  [ok] websocket connected
-------------------------------------------------------------
18 ok | 1 notes | 0 warn | 0 fail ok
`;

  assert.deepEqual(parseDoctorSummary(output), {
    ok: 18,
    notes: 1,
    warn: 0,
    fail: 0,
    raw: "18 ok | 1 notes | 0 warn | 0 fail ok",
    warnItems: [],
  });
});

test("parseDoctorSummary extracts [!!] warn item details and dedupes Notes echo", () => {
  // 真实场景：codex doctor 会在 Notes 汇总区把正文里的 [!!] 行重复一遍
  const output = `
Notes
   [up] updates      0.151.0 available (current 0.144.1)
   [!!] threads      rollout files are missing from the state DB
-------------------------------------------------------------

Environment
  [ok] state        databases healthy
  [!!] threads      rollout files are missing from the state DB
-------------------------------------------------------------
17 ok | 2 notes | 1 warn | 0 fail degraded
`;

  const summary = parseDoctorSummary(output);
  assert.equal(summary.warn, 1);
  assert.deepEqual(summary.warnItems, [
    { name: "threads", text: "rollout files are missing from the state DB" },
  ]);
});

test("classifyHealth reports ready only when all required checks pass", () => {
  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      doctor: { fail: 0, warn: 0 },
    }),
    "ready",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: false,
      remotePortOpen: false,
      doctor: { fail: 1, warn: 0 },
    }),
    "down",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      doctor: { fail: 0, warn: 2 },
    }),
    // warn 是建议级提示不影响使用，不再拖成 degraded（曾让控制台常年黄条"服务降级"）
    "ready",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      doctor: { fail: 1, warn: 0 },
    }),
    "degraded",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: false,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      doctor: { fail: 0, warn: 0 },
    }),
    "degraded",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      doctor: { fail: 1, warn: 0 },
    }),
    "degraded",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: false,
      supervisorUp: false,
      localProxyUp: false,
      tunnelUp: false,
    }),
    "stopped",
  );

  assert.equal(
    classifyHealth({
      shouldBeRunning: false,
      supervisorUp: true,
      localProxyUp: false,
      tunnelUp: false,
    }),
    "waiting",
  );
});

// ---------------------------------------------------------------------------
// B2: classifyHealth 纳入 claudeEndpoint——单链路故障判 degraded 而非 down
// （down 会触发 supervisor 全局 restart，杀掉本来健康的隧道，对应用层故障无益）
// ---------------------------------------------------------------------------

test("classifyHealth: claudeEndpoint 单独失败（codex 正常）→ degraded，而非当前的 ready", () => {
  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      endpoint: { ok: true },
      claudeEndpoint: { ok: false },
      doctor: { fail: 0, warn: 0 },
    }),
    "degraded",
  );
});

test("classifyHealth: codex endpoint 单独失败（claude 正常）→ degraded，不再是 down", () => {
  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      endpoint: { ok: false },
      claudeEndpoint: { ok: true },
      doctor: { fail: 0, warn: 0 },
    }),
    "degraded",
  );
});

test("classifyHealth: codex 与 claude endpoint 同时失败仍是 degraded——down 只由通道层（代理/隧道/远端口）触发", () => {
  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      endpoint: { ok: false },
      claudeEndpoint: { ok: false },
      doctor: { fail: 0, warn: 0 },
    }),
    "degraded",
  );
});

test("classifyHealth: 通道层（隧道/代理/远端口）任一断开仍是 down，不受 endpoint 影响", () => {
  assert.equal(
    classifyHealth({
      shouldBeRunning: true,
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: false,
      remotePortOpen: false,
      endpoint: { ok: true },
      claudeEndpoint: { ok: true },
      doctor: { fail: 0, warn: 0 },
    }),
    "down",
  );
});

test("isEndpointReachable: 放宽为 CONNECT 建立且上游有 HTTP 响应，不再绑死字面量 HTTP/2 405", () => {
  assert.equal(isEndpointReachable("HTTP/1.1 200 Connection Established\nHTTP/2 405"), true);
  assert.equal(
    isEndpointReachable("HTTP/1.1 200 Connection Established\nHTTP/2 404"),
    true,
    "上游把 405 换成 404 等其它状态码不应再被误判为端点不可达",
  );
  assert.equal(
    isEndpointReachable("curl: (28) Connection timed out after 10000 milliseconds"),
    false,
    "连隧道都没建立时必须判不可达",
  );
  assert.equal(isEndpointReachable(""), false);
  // 关键回归：隧道建立但上游被 RST/超时、只剩 CONNECT 应答行时，必须判不可达——
  // CONNECT 行自身含 "HTTP/1.1 200"，不能让它自满足状态行正则。
  assert.equal(
    isEndpointReachable("HTTP/1.1 200 Connection Established"),
    false,
    "仅有 CONNECT 握手行、无上游状态行时必须判不可达",
  );
  assert.equal(
    isEndpointReachable("* CONNECT phase\n< HTTP/1.1 200 Connection Established\n* upstream reset by peer"),
    false,
    "隧道建立但上游 RST、无上游状态行时必须判不可达",
  );
});

test("parseProcessList finds the channel supervisor", () => {
  const output = "501 221 1 0 ?? node work/monitor/channel-supervisor.mjs";

  assert.deepEqual(parseProcessList(output).supervisor, [
    { pid: "221", command: "node work/monitor/channel-supervisor.mjs" },
  ]);
});

test("parseProcessList 识别 Windows node.exe 拉起的 supervisor（热接管不 regress）", () => {
  const output = "501 221 1 0 ?? C:\\Program Files\\nodejs\\node.exe work/monitor/channel-supervisor.mjs";
  assert.deepEqual(parseProcessList(output).supervisor, [
    { pid: "221", command: "node.exe work/monitor/channel-supervisor.mjs" },
  ]);
});

test("parseProcessList 识别打包 Electron 二进制（ELECTRON_RUN_AS_NODE）拉起的 supervisor 与 proxy", () => {
  const output = [
    "  501 86915 90772   0  8:56AM ??         0:00.32 /Users/u/Codex Operations Console.app/Contents/MacOS/Codex Operations Console work/monitor/channel-supervisor.mjs",
    "  501 86916 86915   0  8:56AM ??         0:00.20 /Users/u/Codex Operations Console.app/Contents/MacOS/Codex Operations Console work/local_http_connect_proxy.mjs",
  ].join("\n");
  const parsed = parseProcessList(output);
  assert.deepEqual(parsed.supervisor.map((p) => p.pid), ["86915"]);
  assert.deepEqual(parsed.localProxy.map((p) => p.pid), ["86916"]);
});

test("getSupervisorCommand 返回跨平台 spawn 规格，不含 bash/nohup", () => {
  const spec = getSupervisorCommand("/tmp/codex space");
  assert.equal(spec.cwd, "/tmp/codex space");
  assert.deepEqual(spec.args, ["work/monitor/channel-supervisor.mjs"]);
  assert.equal(spec.execPath, process.execPath);
  assert.equal(spec.env.CODEX_MONITOR_APP_ROOT, "/tmp/codex space");
  assert.ok(!JSON.stringify(spec).includes("nohup"));
  assert.ok(!JSON.stringify(spec).includes("bash"));
});

test("getSupervisorCommand 打包路径注入可写 data/runtime 环境变量", () => {
  const spec = getSupervisorCommand("/Applications/Ops.app/Contents/Resources/app", {
    dataRoot: "/Users/test/Library/Application Support/Ops Console",
    runtimeDir: "/Users/test/Library/Application Support/Ops Console/runtime",
    configPath: "/Applications/Ops.app/Contents/Resources/app/config.json",
    localConfigPath: "/Users/test/Library/Application Support/Ops Console/config.local.json",
  });

  assert.equal(spec.cwd, "/Applications/Ops.app/Contents/Resources/app");
  assert.equal(spec.env.CODEX_MONITOR_APP_ROOT, "/Applications/Ops.app/Contents/Resources/app");
  assert.equal(spec.env.CODEX_MONITOR_DATA_DIR, "/Users/test/Library/Application Support/Ops Console");
  assert.equal(spec.env.CODEX_MONITOR_CONFIG_PATH, "/Applications/Ops.app/Contents/Resources/app/config.json");
  assert.equal(spec.env.CODEX_MONITOR_LOCAL_CONFIG_PATH, "/Users/test/Library/Application Support/Ops Console/config.local.json");
  assert.deepEqual(spec.mkdir, [
    "/Users/test/Library/Application Support/Ops Console",
    "/Users/test/Library/Application Support/Ops Console/runtime",
  ]);
  assert.deepEqual(spec.args, ["work/monitor/channel-supervisor.mjs"]);
});

test("parseRemoteProbeOutput extracts port state and load metrics", () => {
  const output = `
__PORT_OPEN__
master
 13:37:41 up 23 days, 20:52, 3 users,  load average: 1.45, 1.20, 0.91
              total        used        free      shared  buff/cache   available
Mem:          377Gi       115Gi        32Gi       4.0Gi       230Gi       255Gi
/dev/sda1      44T         39T        5.0T        89% /public/newhome/cy
`;

  assert.deepEqual(parseRemoteProbeOutput(output), {
    ok: true,
    remotePortOpen: true,
    host: "master",
    cpu: 100,
    ram: 31,
    disk: 89,
    cores: null,
    output: output.trim(),
  });
});

test("parseRemoteProbeOutput normalizes cpu by nproc core count when present", () => {
  const output = `
__PORT_OPEN__
master
 13:37:41 up 23 days, 20:52, 3 users,  load average: 14.75, 12.20, 10.91
              total        used        free      shared  buff/cache   available
Mem:          377Gi       115Gi        32Gi       4.0Gi       230Gi       255Gi
/dev/sda1      44T         39T        5.0T        89% /public/newhome/cy
nproc: 32
`;

  const parsed = parseRemoteProbeOutput(output);
  assert.equal(parsed.cores, 32);
  assert.equal(parsed.cpu, 46); // 14.75 / 32 = 46%，与前端 load-panel 实时展示同单位
});

test("parseRemoteProbeOutput caps normalized cpu at 100 under overload", () => {
  const output = `
__PORT_OPEN__
master
 13:37:41 up 1 day,  1:00, 1 user,  load average: 9.80, 9.00, 8.50
nproc: 4
`;

  assert.equal(parseRemoteProbeOutput(output).cpu, 100); // 9.8/4=245% 封顶
});

test("buildCodexAgentStatus: warn-only 保持 ready，fail 才降级", () => {
  const warnOnly = buildCodexAgentStatus(
    { ok: true, summary: { ok: 17, fail: 0, warn: 1, notes: 2, raw: "17 ok | 2 notes | 1 warn | 0 fail degraded" } },
    { ok: true },
  );
  assert.equal(warnOnly.health, "ready");
  assert.equal(warnOnly.ok, true);

  const withFail = buildCodexAgentStatus(
    { ok: true, summary: { ok: 16, fail: 1, warn: 0, notes: 0, raw: "" } },
    { ok: true },
  );
  assert.equal(withFail.health, "degraded");
});

test("normalizeAgentConfig keeps codex as the default active agent", () => {
  const config = normalizeAgentConfig({
    activeServerId: "server-01",
    servers: [{ id: "server-01", host: "myserver", localPort: 8888, remotePort: 7891 }],
  });

  assert.equal(config.activeAgentId, "codex");
  assert.deepEqual(
    config.agents.map((agent) => agent.id),
    ["codex", "claude-codewing"],
  );
  assert.equal(config.agents.find((agent) => agent.id === "claude-codewing").command, "reclaude");
});

test("parseReclaudeStatus extracts daemon, claude path, version, and login state", () => {
  const statusOutput = `
daemon: running
claude path: /home/kai/.reclaude/bin/claude
current org: lab-shared
login: ok
`;
  const versionOutput = "reclaude version v1.4.2";
  const gatewayOutput = "https://gateway.codewing.link 128ms ok";
  const logsOutput = "2026-07-02T10:00:00Z request completed status=200";

  assert.deepEqual(parseReclaudeStatus({ statusOutput, versionOutput, gatewayOutput, logsOutput }), {
    installed: true,
    daemonRunning: true,
    loggedIn: true,
    claudePath: "/home/kai/.reclaude/bin/claude",
    version: "v1.4.2",
    gatewayOk: true,
    gatewayOutput: gatewayOutput,
    stateOutput: "",
    logsOutput: logsOutput,
  });
});

test("parseReclaudeCombinedOutput splits one remote command into diagnostic sections", () => {
  const output = `
__RECLAUDE_VERSION_BEGIN__
reclaude version v1.4.2
__RECLAUDE_VERSION_END__
__RECLAUDE_STATUS_BEGIN__
daemon: running
login: ok
__RECLAUDE_STATUS_END__
__RECLAUDE_GATEWAY_BEGIN__
gateway ok 118ms
__RECLAUDE_GATEWAY_END__
__RECLAUDE_LOGS_BEGIN__
request status=200
__RECLAUDE_LOGS_END__
`;

  assert.deepEqual(parseReclaudeCombinedOutput(output), {
    versionOutput: "reclaude version v1.4.2",
    statusOutput: "daemon: running\nlogin: ok",
    gatewayOutput: "gateway ok 118ms",
    deviceOutput: "",
    stateOutput: "",
    logsOutput: "request status=200",
  });
});

test("parseReclaudeStatus: v1.2.x snake_case status + device binding 判定已登录", () => {
  const parsed = parseReclaudeStatus({
    versionOutput: "v1.2.5",
    statusOutput: [
      "daemon_running: true",
      "daemon_reachable: true",
      "claude_path: /public/newhome/kai/.local/bin/claude",
      "gateway_healthy: true",
    ].join("\n"),
    deviceOutput: "__RECLAUDE_DEVICE_BOUND__",
  });

  assert.equal(parsed.daemonRunning, true);
  assert.equal(parsed.loggedIn, true);
  assert.equal(parsed.claudePath, "/public/newhome/kai/.local/bin/claude");
  assert.equal(parsed.gatewayOk, true);
});

test("parseReclaudeStatus: 设备绑定缺失时明确判定需登录，未知时保持三态", () => {
  assert.equal(parseReclaudeStatus({
    versionOutput: "v1.2.5",
    statusOutput: "daemon_running: true",
    deviceOutput: "__RECLAUDE_DEVICE_UNBOUND__",
  }).loggedIn, false);
  assert.equal(parseReclaudeStatus({
    versionOutput: "v1.2.5",
    statusOutput: "daemon_running: true",
  }).loggedIn, null);
});

test("parseReclaudeStatus: state.json gateway.healthy 决定 gatewayOk", () => {
  const ok = parseReclaudeStatus({
    statusOutput: "daemon: running",
    versionOutput: "reclaude v1.2.3",
    stateOutput: JSON.stringify({ gateway: { healthy: true } }),
  });
  assert.equal(ok.gatewayOk, true);
  const bad = parseReclaudeStatus({ stateOutput: JSON.stringify({ gateway: { healthy: false } }) });
  assert.equal(bad.gatewayOk, false);
});

test("parseReclaudeStatus: state.json 缺失时回落旧 gatewayOutput 正则，二者皆无则 null", () => {
  assert.equal(parseReclaudeStatus({ gatewayOutput: "gateway test: OK connected" }).gatewayOk, true);
  assert.equal(parseReclaudeStatus({}).gatewayOk, null, "未知不得误报降级");
});

test("parseReclaudeCombinedOutput: 解析 RECLAUDE_STATE 分节", () => {
  const out = "__RECLAUDE_STATE_BEGIN__\n{\"gateway\":{\"healthy\":true}}\n__RECLAUDE_STATE_END__";
  assert.equal(parseReclaudeCombinedOutput(out).stateOutput, '{"gateway":{"healthy":true}}');
});

test("classifyAgentHealth separates missing install, login, gateway, and ready states", () => {
  assert.equal(classifyAgentHealth({ installed: false }), "missing");
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: false }), "auth-required");
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: true, gatewayOk: false }), "degraded");
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: true, gatewayOk: true }), "ready");
});

// ---------------------------------------------------------------------------
// B1: 账号层探针——device_revoked(401) / account_banned(403) 检测（97 分钟盲区修复）
// ---------------------------------------------------------------------------

test("detectAccountFault: 真实脱敏日志——device_revoked(401) → revoked，account_banned(403) → banned，干净日志 → null", () => {
  const revokedLine =
    'reclaude account sync: sync current account: unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑，请在终端重新运行 reclaude 完成登录..."}}';
  assert.equal(detectAccountFault(revokedLine, ""), "revoked");

  const bannedLine =
    'reclaude account sync: sync current account: unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用"}}';
  assert.equal(detectAccountFault(bannedLine, ""), "banned");

  assert.equal(
    detectAccountFault("2026-07-02T10:00:00Z request completed status=200", ""),
    null,
    "干净日志不得误报",
  );
  assert.equal(detectAccountFault("", ""), null, "空输入不得误报");
});

test("detectAccountFault: 同时扫描 stateOutput（不止 logsOutput）", () => {
  const stateJson = JSON.stringify({
    lastError: { code: "device_revoked", status: 401, message: "此设备已被解绑" },
  });
  assert.equal(detectAccountFault("", stateJson), "revoked");
});

test("detectAccountFault: 宁可漏报不可误报——故障 code 与 status 数字须同时出现", () => {
  assert.equal(detectAccountFault("curl exit status 401 from unrelated probe", ""), null, "无 code 字段的裸 401 不得判红");
  assert.equal(detectAccountFault("changelog mentions device_revoked handling in code", ""), null, "无 status 数字的裸 code 提及不得判红");
});

test("classifyAgentHealth: accountFault revoked/banned 优先于 loggedIn，但 installed=false 仍最优先", () => {
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: true, accountFault: "revoked" }), "revoked");
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: true, accountFault: "banned" }), "banned");
  assert.equal(classifyAgentHealth({ installed: false, accountFault: "revoked" }), "missing", "未安装优先于账号故障");
  assert.equal(classifyAgentHealth({ installed: true, loggedIn: false, accountFault: null }), "auth-required");
});

test("buildClaudeAgentStatus: daemon 健康 + Claude API 可达 → ready", () => {
  const s = buildClaudeAgentStatus(
    { installed: true, loggedIn: true, gatewayOk: true, version: "v1.2.3", output: "st" },
    { ok: true, httpCode: 401, latencyMs: 320, output: "401" },
  );
  assert.equal(s.health, "ready");
  assert.equal(s.ok, true);
  assert.equal(s.endpointLabel, "Claude API");
});

test("buildClaudeAgentStatus: Claude API 不可达 → degraded；未探测不降级", () => {
  const base = { installed: true, loggedIn: true, gatewayOk: true };
  assert.equal(buildClaudeAgentStatus(base, { ok: false, output: "timeout" }).health, "degraded");
  assert.equal(buildClaudeAgentStatus(base, { ok: null, output: "" }).health, "ready");
  assert.equal(buildClaudeAgentStatus({ installed: false }, { ok: true }).health, "missing");
  assert.equal(buildClaudeAgentStatus({ installed: true, loggedIn: false }, { ok: true }).health, "auth-required");
});

test("buildClaudeAgentStatus: reclaudeData.accountFault 判 revoked/banned，优先于 gatewayOk/endpoint", () => {
  const revoked = buildClaudeAgentStatus(
    { installed: true, loggedIn: true, gatewayOk: true, accountFault: "revoked" },
    { ok: true },
  );
  assert.equal(revoked.health, "revoked");
  assert.equal(revoked.ok, false);

  const banned = buildClaudeAgentStatus(
    { installed: true, loggedIn: true, gatewayOk: true, accountFault: "banned" },
    null,
  );
  assert.equal(banned.health, "banned");
  assert.equal(banned.ok, false);
});

test("buildAgentOverview: revoked/banned 健康态的 tag/summary 给出重新运行 reclaude 登录的指引", () => {
  const agents = normalizeAgentConfig({}).agents;

  const revokedOverview = buildAgentOverview(agents, { "claude-codewing": { health: "revoked" } }, "claude-codewing");
  const revokedCard = revokedOverview.find((a) => a.id === "claude-codewing");
  assert.equal(revokedCard.tag, "账号被解绑");
  assert.match(revokedCard.summary, /reclaude/);
  assert.match(revokedCard.summary, /登录/);

  const bannedOverview = buildAgentOverview(agents, { "claude-codewing": { health: "banned" } }, "claude-codewing");
  const bannedCard = bannedOverview.find((a) => a.id === "claude-codewing");
  assert.equal(bannedCard.tag, "账号被封");
  assert.match(bannedCard.summary, /reclaude/);
  assert.match(bannedCard.summary, /登录/);
});

test("buildNetworkChannel preserves legacy status fields while adding shared tunnel metadata", () => {
  const channel = buildNetworkChannel({
    shouldBeRunning: true,
    localProxyUp: true,
    tunnelUp: true,
    remotePortOpen: true,
    server: { id: "server-01", host: "myserver", localPort: 8888, remotePort: 7891 },
  });

  assert.deepEqual(channel, {
    shouldBeRunning: true,
    localProxyUp: true,
    tunnelUp: true,
    remotePortOpen: true,
    host: "myserver",
    localProxyUrl: "http://127.0.0.1:8888",
    remoteProxyUrl: "http://127.0.0.1:7891",
    topology: "HTTP_CONNECT_REVERSE_TUNNEL",
  });
});

test("buildAgentOverview returns same-page summaries for every configured agent", () => {
  const agents = normalizeAgentConfig({ activeAgentId: "claude-codewing" }).agents;
  const overview = buildAgentOverview(agents, {
    codex: { health: "ready", summary: { ok: 18, fail: 0, warn: 0 } },
    "claude-codewing": { health: "auth-required", version: "v1.4.2" },
  }, "claude-codewing");

  assert.deepEqual(overview, [
    {
      id: "codex",
      name: "Codex",
      kind: "codex",
      health: "ready",
      selected: false,
      tag: "Ready",
      summary: "18 项通过，0 项失败",
    },
    {
      id: "claude-codewing",
      name: "Claude CodeWing",
      kind: "reclaude",
      health: "auth-required",
      selected: true,
      tag: "需登录",
      summary: "ReClaude 已安装，等待 CodeWing 设备登录",
    },
  ]);
});

// ---------------------------------------------------------------------------
// v2.4 加固：服务器字段收口校验（端口/host 会插值进远端 shell 命令串）
// ---------------------------------------------------------------------------

test("normalizeAgentConfig: 非法 host/localPort 回落默认值、非法 remotePort 剔除并告警，合法值原样保留", () => {
  const warnings = [];
  const config = normalizeAgentConfig({
    servers: [
      { id: "ok", host: "my-server.lan", localPort: 8899, remotePort: 7900 },
      { id: "bad", host: "x; rm -rf ~", localPort: "7891; reboot", remotePort: 99999 },
    ],
  }, { warn: (m) => warnings.push(m) });

  const ok = config.servers.find((s) => s.id === "ok");
  assert.equal(ok.host, "my-server.lan");
  assert.equal(ok.localPort, 8899);
  assert.equal(ok.remotePort, 7900);

  const bad = config.servers.find((s) => s.id === "bad");
  assert.equal(bad.host, "myserver", "含 shell 元字符的 host 必须回落");
  assert.equal(bad.localPort, 8888, "非整数端口必须回落");
  assert.equal(Object.hasOwn(bad, "remotePort"), false, "越界 remotePort 剔除（按未领取端口处理），绝不回落 7891");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"bad".*99999/);
});

test("normalizeHost 放行合法 ssh 目标（user@host / IPv6），仅拦 shell 元字符", () => {
  const config = normalizeAgentConfig({
    servers: [
      { id: "a", host: "ubuntu@203.0.113.7", localPort: 8888, remotePort: 7891 },
      { id: "b", host: "[fe80::1]", localPort: 8888, remotePort: 7891 },
      { id: "c", host: "my server; ls", localPort: 8888, remotePort: 7891 },
    ],
  });
  assert.equal(config.servers.find((s) => s.id === "a").host, "ubuntu@203.0.113.7");
  assert.equal(config.servers.find((s) => s.id === "b").host, "[fe80::1]");
  assert.equal(config.servers.find((s) => s.id === "c").host, "myserver", "含空格/分号必须回落");
});

test("computeTunnelBackoffSec: 快速起步、持续失败拉长到 300s 上限", () => {
  assert.equal(computeTunnelBackoffSec(1), 5);
  assert.equal(computeTunnelBackoffSec(2), 10);
  assert.equal(computeTunnelBackoffSec(5), 80);
  assert.equal(computeTunnelBackoffSec(6), 160);
  assert.equal(computeTunnelBackoffSec(7), 300, "第 7 次起封顶 300s（轰炸削减与自愈时效的平衡）");
  assert.equal(computeTunnelBackoffSec(20), 300);
  assert.equal(computeTunnelBackoffSec(0), 5, "非法输入回落首档");
});

test("computeRepairBackoffMs: 首次 5s，上限 60s，避免 supervisor 雪崩拉起", () => {
  assert.equal(computeRepairBackoffMs(1), 5_000);
  assert.equal(computeRepairBackoffMs(2), 10_000);
  assert.equal(computeRepairBackoffMs(4), 40_000);
  assert.equal(computeRepairBackoffMs(5), 60_000);
  assert.equal(computeRepairBackoffMs(20), 60_000);
});

// ---- v2.18 多隧道：按服务器归类 ssh -R 进程 ----

test("parseProcessList: 两条不同 -R 端口的 ssh 归到各自 serverId，reverseTunnel 是并集", () => {
  const output = [
    "  501 111 1 0 ?? node work/local_http_connect_proxy.mjs",
    "  501 112 1 0 ?? ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver",
    "  501 113 1 0 ?? ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver",
    "  501 114 1 0 ?? ssh -N -R 127.0.0.1:9999:127.0.0.1:8888 someoneelse",
  ].join("\n");

  const parsed = parseProcessList(output, { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }, {
    proxyPort: 8888,
    tunnels: [
      { id: "server-01", host: "myserver", remotePort: 7891 },
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893 },
      { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894 },
    ],
  });

  assert.deepEqual(parsed.tunnelsByServer["server-01"].map((p) => p.pid), ["112"]);
  assert.deepEqual(parsed.tunnelsByServer["server-tengxun"].map((p) => p.pid), ["113"]);
  // 配了隧道但没起来的服务器留空数组（区别于"根本没配这台"）。
  assert.deepEqual(parsed.tunnelsByServer["server-aliyun"], []);
  // 并集里没有第三方的 9999，也没有重复条目。
  assert.deepEqual(parsed.reverseTunnel.map((p) => p.pid), ["112", "113"]);
  assert.deepEqual(parsed.localProxy.map((p) => p.pid), ["111"]);
});

test("parseProcessList: 不传第三参时输出形状逐字不变（连 tunnelsByServer 这个键都不出现）", () => {
  const output = "  501 112 1 0 ?? ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver";
  const parsed = parseProcessList(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["localProxy", "reverseTunnel", "supervisor"]);
});

test("parseProcessList: proxyPort 统一了所有 -R 的本地落点（服务器自己的 localPort 只作展示）", () => {
  // 腾讯云配置里 localPort 写的是 8890，但实际隧道落在唯一的代理端口 8888 上。
  const output = "  501 113 1 0 ?? ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver";
  const parsed = parseProcessList(output, null, {
    proxyPort: 8888,
    tunnels: [{ id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 }],
  });
  assert.deepEqual(parsed.tunnelsByServer["server-tengxun"].map((p) => p.pid), ["113"]);
});

test("isActiveTunnelUp: 给出 activeServerId 时只认活跃服务器那条隧道", () => {
  const processes = {
    supervisor: [{ pid: "1" }],
    localProxy: [{ pid: "2" }],
    reverseTunnel: [{ pid: "3" }],
    tunnelsByServer: { "server-01": [], "server-tengxun": [{ pid: "3" }] },
  };
  // 并集非空但 myserver 的那条断了 → 主链路隧道不在。
  assert.equal(isActiveTunnelUp(processes, "server-01"), false);
  assert.equal(isActiveTunnelUp(processes, "server-tengxun"), true);
  assert.equal(isActiveTunnelUp(processes, "server-unknown"), false, "未分桶的服务器按缺席处理");
  // 不给 activeServerId（或非多隧道解析结果）时沿用旧判据（看并集）。
  assert.equal(isActiveTunnelUp(processes, ""), true);
  assert.equal(isActiveTunnelUp({ ...processes, tunnelsByServer: undefined }, "server-01"), true);
  assert.equal(isActiveTunnelUp({ ...processes, reverseTunnel: [], tunnelsByServer: undefined }, "server-01"), false);
});

test("tunnelRecordName: 注册表名的权威定义在 monitor-core", () => {
  assert.equal(TUNNEL_RECORD_PREFIX, "tunnel.");
  assert.equal(tunnelRecordName("server-tengxun"), "tunnel.server-tengxun");
});

// v2.18：记录名用 "." 分隔（Windows 文件名禁止冒号），非法 id 直接抛。
test("tunnelRecordName: 点号分隔且拒绝非法 serverId", () => {
  assert.equal(tunnelRecordName("server-01"), "tunnel.server-01");
  assert.equal(tunnelRecordName("a.b-c_1"), "tunnel.a.b-c_1");
  assert.throws(() => tunnelRecordName("../x"), /unsafe serverId/);
  assert.throws(() => tunnelRecordName("x:y"), /unsafe serverId/);
  assert.throws(() => tunnelRecordName(""), /unsafe serverId/);
});
