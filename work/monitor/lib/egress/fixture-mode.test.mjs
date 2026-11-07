// fixture 模式下的出网服务（v2.62）：不发任何本机或远端的网络请求，也不执行系统命令。
// 隔离的 fixture 监控服务是拿来冒烟与看界面的；它加载的是仓库里真实的团队配置，「本机代理端口」就是用户
// 正在用的那个代理——此前每打开一次配置浮层，它就去读一次那里的 /proxy-health。
// 做法：把所有碰得到网络 / 系统的依赖都换成「一调用就抛错」的替身，然后把每个入口走一遍。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigManager } from "../config-hot-reload.mjs";
import { createProxyAuthService } from "./proxy-auth-service.mjs";
import { createProxyAuthStore } from "./proxy-auth-store.mjs";
import { createEgressService } from "./service.mjs";

function setup(t, { fixtureMode = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "egress-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const localConfigPath = path.join(dir, "config.local.json");
  // 与仓库里的团队配置同形：团队服务器、本机代理端口 8888。
  writeFileSync(configPath, JSON.stringify({ activeServerId: "server-01", servers: [{ id: "server-01", name: "主集群", host: "myserver", remotePort: 7891, localPort: 8888 }] }));
  writeFileSync(localConfigPath, JSON.stringify({ revision: 1 }));
  const manager = createConfigManager({ configPath, localConfigPath });
  const touched = [];
  const forbidden = (name) => (...args) => {
    touched.push(name);
    throw new Error(`fixture 模式不该调用 ${name}（${JSON.stringify(args).slice(0, 80)}）`);
  };
  const authFile = path.join(dir, "runtime", "proxy-auth.json");
  const proxyAuth = createProxyAuthService({
    store: createProxyAuthStore({ filePath: authFile }),
    usagePath: path.join(dir, "runtime", "proxy-usage.json"),
    getConfig: () => manager.loadConfig(),
    getClusterEnvSync: forbidden("clusterEnvSync"),
    fixtureMode,
  });
  const service = createEgressService({
    getConfig: () => manager.loadConfig(),
    getPersonalConfig: manager.getPersonalConfig,
    savePersonalConfig: manager.savePersonalConfig,
    detector: { detect: forbidden("detector.detect") },
    readProxyHealth: forbidden("readProxyHealth"),
    runLocal: forbidden("runLocal"),
    probe: forbidden("probe"),
    runRemote: forbidden("runRemote"),
    acquireSshSlot: forbidden("acquireSshSlot"),
    proxyAuth,
    fixtureMode,
  });
  return { service, touched, authFile, localConfigPath };
}

test("fixture：读状态不识别系统代理、不读本机代理的 /proxy-health；代理与系统代理是固定的夹具值", async (t) => {
  const { service, touched } = setup(t);
  const status = await service.getStatus();
  assert.deepEqual(touched, []);
  assert.deepEqual(status.effective, { running: false, supportsEgress: false, mode: null, upstream: null });
  assert.deepEqual(status.systemProxy, { source: "fixture", proxy: null, socks: null, pac: null, error: null });
  assert.equal(status.proxyPort, 8888, "端口照配置回显，但没有人去连它");
  assert.equal(status.proxyAuth.mode, "off");
  assert.deepEqual(status.proxyAuth.proxy, { state: "not-running", mode: null, since: null }, "fixture 里没有代理在跑");
  assert.equal(status.proxyAuth.cluster, null, "fixture 下不看集群");
});

test("fixture：getEffective（出网健康用）同样不读 /proxy-health、不识别系统代理", async (t) => {
  const { service, touched } = setup(t);
  assert.deepEqual(await service.getEffective(), { running: false, supportsEgress: false, mode: null, upstream: null });
  assert.deepEqual(touched, []);
});

test("fixture：改出网方式、改白名单照常写进（fixture 自己的）个人配置，回显同样不碰网络", async (t) => {
  const { service, touched, localConfigPath } = setup(t);
  const saved = await service.setMode({ mode: "manual", url: "http://127.0.0.1:7890" });
  assert.deepEqual(saved.egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  await service.updateAllowlist({ add: "relay.example.com:9443" });
  assert.deepEqual(JSON.parse(readFileSync(localConfigPath, "utf8")).proxyAllowedTargets, ["relay.example.com:9443"]);
  assert.deepEqual(touched, []);
});

test("fixture：自测回一份夹具结果——形状与真的一样，但一个连接、一条 SSH 都没发", async (t) => {
  const { service, touched } = setup(t);
  const local = await service.runSelfTest({ scope: "local" });
  assert.deepEqual(local, {
    scope: "local",
    fixture: true,
    proxyPort: 8888,
    effective: { running: false, supportsEgress: false, mode: null, upstream: null },
    results: [],
    systemCheck: null,
    suggestion: { kind: "fixture", text: "fixture 模式不做出网自测：不经本机代理发连接，也不发 SSH。" },
  });
  const full = await service.runSelfTest({ scope: "full" });
  assert.deepEqual(full.full, { ok: false, stage: "fixture", message: "fixture 模式不发起真实 SSH" });
  assert.deepEqual(full.results, []);
  assert.deepEqual(touched, []);
});

test("fixture：代理口令照常读写（在 fixture 自己的运行目录里）；「把口令写到集群」409，不读集群也不发 SSH", async (t) => {
  const { service, touched, authFile } = setup(t);
  const saved = await service.setProxyAuth({ mode: "observe" });
  assert.equal(saved.proxyAuth.mode, "observe");
  assert.equal(JSON.parse(readFileSync(authFile, "utf8")).mode, "observe");
  assert.deepEqual(saved.effective, { running: false, supportsEgress: false, mode: null, upstream: null });
  assert.deepEqual(saved.proxyAuth.proxy, { state: "not-running", mode: null, since: null });
  for (const body of [{}, { confirm: true }]) {
    await assert.rejects(service.syncProxyAuth(body), { status: 409, code: "fixture", message: "fixture 模式不发起真实 SSH" });
  }
  assert.deepEqual(await service.getUsage(), { windowHours: 24, since: null, updatedAt: null, recording: true, totals: { connections: 0, up: 0, down: 0 }, recent: null, targets: [], other: null });
  // 打开口令之后的自测也一样：不会带着口令去连本机代理。
  await service.runSelfTest({ scope: "full" });
  assert.deepEqual(touched, []);
});

test("对照：不是 fixture 时这些依赖确实会被用到（替身没有白放）", async (t) => {
  const { service, touched } = setup(t, { fixtureMode: false });
  await assert.rejects(service.getStatus(), /fixture 模式不该调用/);
  assert.ok(touched.includes("detector.detect") || touched.includes("readProxyHealth"), JSON.stringify(touched));
});
