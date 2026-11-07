// 出网控制面服务：用真实的 configManager（临时目录里的团队 / 个人配置）走完整写入路径，
// 网络侧（系统代理识别、/proxy-health、自测、SSH）全部注入。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigValidationError } from "../config-loader.mjs";
import { createConfigManager } from "../config-hot-reload.mjs";
import { createEgressService, resolveEffectiveUpstream } from "./service.mjs";

const SYSTEM = { source: "scutil", proxy: { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897", scheme: "https" }, socks: null, pac: null, error: null };

function setup(t, { team = {}, personal = {}, ...overrides } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "egress-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const localConfigPath = path.join(dir, "config.local.json");
  writeFileSync(configPath, JSON.stringify({ servers: [{ id: "server-01", host: "login.example", remotePort: 7891, localPort: 8888 }], ...team }));
  writeFileSync(localConfigPath, JSON.stringify({ revision: 1, ...personal }));
  const manager = createConfigManager({ configPath, localConfigPath });
  const calls = { refresh: 0, detect: [], health: [], remote: [], slots: [] };
  const service = createEgressService({
    getConfig: () => manager.loadConfig(),
    getPersonalConfig: manager.getPersonalConfig,
    savePersonalConfig: manager.savePersonalConfig,
    refreshConfigIntoKernel: async () => {
      calls.refresh += 1;
    },
    detector: {
      detect: async (opts) => {
        calls.detect.push(opts);
        return SYSTEM;
      },
    },
    readProxyHealth: async (port) => {
      calls.health.push(port);
      return { running: true, supportsEgress: true, mode: "direct", upstream: null };
    },
    ...overrides,
  });
  const readPersonal = () => JSON.parse(readFileSync(localConfigPath, "utf8"));
  return { service, calls, readPersonal };
}

test("getStatus：出网方式（个人层）、系统代理、代理实际状态、白名单分个人 / 团队、代理端口", async (t) => {
  const { service, calls } = setup(t, {
    team: { proxyAllowedTargets: ["team.example.com:9443", "shared.example.com:8443"] },
    personal: { egress: { mode: "manual", url: "http://127.0.0.1:7890" }, proxyAllowedTargets: ["Mine.example.com:9443", "shared.example.com:8443", "10.0.0.1:1"] },
  });
  const status = await service.getStatus();
  assert.deepEqual(status.egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.equal(status.configIssue, null);
  assert.deepEqual(status.systemProxy, SYSTEM);
  assert.deepEqual(status.effective, { running: true, supportsEgress: true, mode: "direct", upstream: null });
  assert.deepEqual(status.allowlist, { personal: ["mine.example.com:9443", "shared.example.com:8443"], team: ["team.example.com:9443"], max: 32 }, "无效条目不展示；两层都有的算个人的（可删）");
  assert.equal(status.proxyPort, 8888);
  assert.deepEqual(calls.health, [8888]);
});

test("getStatus：活跃服务器切换后优先使用 supervisor 新鲜快照里的实际代理端口", async (t) => {
  const { service, calls } = setup(t, {
    team: {
      activeServerId: "server-02",
      servers: [
        { id: "server-01", host: "login.example", remotePort: 7891, localPort: 8888 },
        { id: "server-02", host: "other.example", remotePort: 7892, localPort: 8892 },
      ],
    },
    getConnectionTargets: () => ({
      source: "supervisor-snapshot",
      freshness: "fresh",
      effectiveProxyPort: { value: 8888 },
    }),
  });
  const status = await service.getStatus();
  assert.equal(status.proxyPort, 8888);
  assert.deepEqual(calls.health, [8888]);
});

test("getStatus：effective.upstream 由控制面在本机算（代理不再发布上游地址），按代理实际生效的方式取值", async (t) => {
  let health = { running: true, supportsEgress: true, mode: "manual", upstream: "leaked.example:1" };
  const { service } = setup(t, {
    personal: { egress: { mode: "manual", url: "http://127.0.0.1:7890" } },
    readProxyHealth: async () => health,
  });
  assert.deepEqual((await service.getStatus()).effective, { running: true, supportsEgress: true, mode: "manual", upstream: "127.0.0.1:7890" }, "忽略健康结果里自带的 upstream");
  health = { running: true, supportsEgress: true, mode: "system" };
  assert.equal((await service.getStatus()).effective.upstream, "127.0.0.1:7897", "代理还在 system：显示系统代理识别结果");
  health = { running: true, supportsEgress: true, mode: "direct" };
  assert.equal((await service.getStatus()).effective.upstream, null);
  health = { running: false, supportsEgress: false, mode: null };
  assert.deepEqual((await service.getStatus()).effective, { running: false, supportsEgress: false, mode: null, upstream: null });
});

test("getEffective：与 getStatus().effective 同口径；不读口令与使用记录；系统代理只在代理按 system 生效时才识别", async (t) => {
  let health = { running: true, supportsEgress: true, mode: "manual" };
  const proxyAuth = { getView: async () => assert.fail("getEffective 不该读口令视图") };
  const { service, calls } = setup(t, {
    personal: { egress: { mode: "manual", url: "http://127.0.0.1:7890" } },
    readProxyHealth: async (port) => {
      calls.health.push(port);
      return health;
    },
    proxyAuth,
  });
  assert.deepEqual(await service.getEffective(), { running: true, supportsEgress: true, mode: "manual", upstream: "127.0.0.1:7890" });
  assert.deepEqual(calls.health, [8888]);
  assert.deepEqual(calls.detect, [], "manual 用不上系统代理识别");
  health = { running: true, supportsEgress: true, mode: "system" };
  assert.deepEqual(await service.getEffective(), { running: true, supportsEgress: true, mode: "system", upstream: "127.0.0.1:7897" });
  assert.equal(calls.detect.length, 1);
  health = { running: true, supportsEgress: true, mode: "direct" };
  assert.equal((await service.getEffective()).upstream, null);
  health = { running: false, supportsEgress: false, mode: null };
  assert.deepEqual(await service.getEffective(), { running: false, supportsEgress: false, mode: null, upstream: null });
  assert.equal(calls.detect.length, 1, "代理不在跑时不识别系统代理");
});

test("resolveEffectiveUpstream：旧版代理 / 指回自己的上游 / 系统代理未识别 → null", () => {
  const live = { running: true, supportsEgress: true };
  assert.equal(resolveEffectiveUpstream({ health: { ...live, mode: "manual" }, egress: { url: "http://[::1]:7890" }, proxyPort: 8888 }), "[::1]:7890");
  assert.equal(resolveEffectiveUpstream({ health: { ...live, mode: "manual" }, egress: { url: "http://0.0.0.0:8888" }, proxyPort: 8888 }), null, "代理会丢弃指回自己的上游");
  assert.equal(resolveEffectiveUpstream({ health: { ...live, mode: "manual" }, egress: {}, proxyPort: 8888 }), null);
  assert.equal(resolveEffectiveUpstream({ health: { ...live, mode: "system" }, systemProxy: { proxy: null, socks: { host: "127.0.0.1", port: 7891 } }, proxyPort: 8888 }), null);
  assert.equal(resolveEffectiveUpstream({ health: { running: true, supportsEgress: false, mode: null }, egress: { url: "http://127.0.0.1:7890" }, proxyPort: 8888 }), null);
});

test("setMode：写个人层 egress（本机代理自行热载），刷新内核；切走再切回「手动」沿用之前的地址", async (t) => {
  const { service, calls, readPersonal } = setup(t);
  await service.setMode({ mode: "manual", url: "http://127.0.0.1:7890/" });
  assert.deepEqual(readPersonal().egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  await service.setMode({ mode: "system" });
  assert.deepEqual(readPersonal().egress, { mode: "system", url: "http://127.0.0.1:7890" }, "保留填过的地址");
  const status = await service.setMode({ mode: "manual" });
  assert.deepEqual(status.egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.equal(calls.refresh, 3);
  assert.equal(readPersonal().revision, 4, "每次写都走 revision 乐观并发");
});

test("setMode：手动地址指回本机代理自己 / 方式非法 / 地址非法 → ConfigValidationError，个人层不动", async (t) => {
  const { service, readPersonal } = setup(t);
  const before = readPersonal();
  for (const input of [
    { mode: "manual", url: "http://127.0.0.1:8888" },
    { mode: "manual", url: "http://localhost:8888/" },
    { mode: "manual", url: "http://0.0.0.0:8888" },
    { mode: "manual", url: "http://[::]:8888" },
    { mode: "tun" },
    { mode: "manual", url: "socks5://127.0.0.1:7891" },
    { mode: "manual" },
  ]) {
    await assert.rejects(service.setMode(input), (err) => err instanceof ConfigValidationError, JSON.stringify(input));
  }
  assert.deepEqual(readPersonal(), before);
});

test("updateAllowlist：add 收 host:port 或中转站地址（自动取 host:port），重复不重写；remove 删除；443 / 内网地址给出说明", async (t) => {
  const { service, readPersonal } = setup(t, { personal: { proxyAllowedTargets: ["keep.example.com:9443"] } });
  let status = await service.updateAllowlist({ add: "Relay.Example.com:8443" });
  assert.deepEqual(status.allowlist.personal, ["keep.example.com:9443", "relay.example.com:8443"]);
  status = await service.updateAllowlist({ add: "https://api.relay-demo.example:9443/v1" });
  assert.deepEqual(readPersonal().proxyAllowedTargets, ["keep.example.com:9443", "relay.example.com:8443", "api.relay-demo.example:9443"]);
  const revision = readPersonal().revision;
  await service.updateAllowlist({ add: "relay.example.com:8443" });
  assert.equal(readPersonal().revision, revision, "已存在：不写盘");

  status = await service.updateAllowlist({ remove: "keep.example.com:9443" });
  assert.deepEqual(status.allowlist.personal, ["relay.example.com:8443", "api.relay-demo.example:9443"]);

  const messageOf = async (input) => {
    try {
      await service.updateAllowlist(input);
    } catch (err) {
      assert.ok(err instanceof ConfigValidationError);
      return err.errors?.[0]?.message || err.message;
    }
    assert.fail(`应拒绝 ${JSON.stringify(input)}`);
  };
  assert.match(await messageOf({ add: "https://api.example.com/v1" }), /443 端口默认放行/);
  assert.match(await messageOf({ add: "http://10.0.3.7:8000/v1" }), /内网/);
  assert.match(await messageOf({ add: "192.168.1.5:9443" }), /内网/);
  assert.match(await messageOf({ add: "relay.example.com:443" }), /443 端口默认放行/);
  assert.match(await messageOf({ add: "relay.example.com" }), /主机名:端口/);
  assert.match(await messageOf({}), /add.*remove/);
});

test("runSelfTest：直连全挂且识别到系统代理 → 直测系统代理，通则建议改用系统代理；并发点击复用同一轮", async (t) => {
  const probes = [];
  const { service, calls } = setup(t, {
    runLocal: async ({ proxyPort }) => {
      await new Promise((r) => setTimeout(r, 20));
      return ["api.openai.com", "chatgpt.com"].map((target) => ({ target, ok: false, stage: "proxy", message: `本机代理连不上目标（HTTP 502）@${proxyPort}` }));
    },
    probe: async (opts) => {
      probes.push(opts);
      return { target: opts.target, ok: true, ms: 80 };
    },
  });
  const [a, b] = await Promise.all([service.runSelfTest(), service.runSelfTest()]);
  assert.equal(a, b);
  assert.equal(a.scope, "local");
  assert.equal(a.proxyPort, 8888);
  assert.equal(a.results.length, 2);
  assert.deepEqual(probes.map((p) => [p.proxy.url, p.target, p.viaLocalProxy]), [["http://127.0.0.1:7897", "api.openai.com", false]]);
  assert.equal(a.suggestion.action, "use-system");
  assert.deepEqual(calls.detect.at(-1), { force: true }, "自测时强制重识别系统代理");
  assert.equal(a.full, undefined);
});

test("runSelfTest scope=full：占一个 SSH 槽位在活跃服务器上 curl -x 反向端口，解析结果；缺端口 / 未装配时说明原因", async (t) => {
  const { service, calls } = setup(t, {
    runLocal: async () => [{ target: "api.openai.com", ok: true, ms: 50 }],
    runRemote: async (server, _config, command, opts) => {
      calls.remote.push([server.id, command, opts.timeoutMs]);
      return { code: 0, stdout: "\nCW 200 401 0.5\nCW_EXIT=0\n", stderr: "" };
    },
    acquireSshSlot: async (opts) => {
      calls.slots.push(opts);
      return () => calls.slots.push("released");
    },
  });
  const report = await service.runSelfTest({ scope: "full" });
  assert.equal(report.suggestion, null);
  assert.equal(report.full.ok, true);
  assert.equal(report.full.serverId, "server-01");
  assert.match(calls.remote[0][1], /-x http:\/\/127\.0\.0\.1:7891 /);
  assert.deepEqual(calls.slots, [{ hostKey: "login.example" }, "released"]);

  const sshDown = setup(t, {
    runLocal: async () => [{ target: "api.openai.com", ok: true, ms: 50 }],
    runRemote: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host login.example port 22: Connection refused" }),
  });
  const failed = await sshDown.service.runSelfTest({ scope: "full" });
  assert.equal(failed.full.stage, "ssh");
  assert.match(failed.full.message, /SSH 连不上服务器（确认集群 sshd 可达/);

  // 注意：normalizeAgentConfig 目前会给缺 remotePort 的条目回落 7891，这里直接注入未归一化的配置测分支。
  const noPort = setup(t, {
    getConfig: async () => ({ servers: [{ id: "server-01", host: "login.example", localPort: 8888 }] }),
    runLocal: async () => [],
    runRemote: async () => assert.fail("不该 SSH"),
  });
  assert.match((await noPort.service.runSelfTest({ scope: "full" })).full.message, /还没有反向端口/);
  const noServer = setup(t, { team: { servers: [] }, runLocal: async () => [], runRemote: async () => assert.fail("不该 SSH") });
  assert.match((await noServer.service.runSelfTest({ scope: "full" })).full.message, /没有可用的服务器/);

  const unwired = setup(t, { runLocal: async () => [] });
  assert.match((await unwired.service.runSelfTest({ scope: "full" })).full.message, /不可用/);
});
