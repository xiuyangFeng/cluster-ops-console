import assert from "node:assert/strict";
import test from "node:test";

import { mergeConfig, writeActiveSelection, writePersonalConfig } from "./config-loader.mjs";
import { createConfigAudit, hashSecretRef } from "./config-audit.mjs";
import { createServerRegistry } from "./server-registry.mjs";

function memoryFs(initial = {}) {
  const files = { ...initial };
  const modes = {};
  return {
    files,
    modes,
    readFileSync: (p) => {
      if (!(p in files)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files[p];
    },
    writeFileSync: (p, body, opts) => {
      files[p] = String(body);
      if (opts?.mode) modes[p] = opts.mode;
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
      if (modes[from]) {
        modes[to] = modes[from];
        delete modes[from];
      }
    },
    mkdirSync: () => {},
    chmodSync: (p, mode) => { modes[p] = mode; },
    copyFileSync: (from, to) => { if (from in files) files[to] = files[from]; },
    unlinkSync: (p) => { delete files[p]; },
  };
}

function writeOpts(fs) {
  return { localConfigPath: "/local.json", fs };
}

test("writePersonalConfig: 拒绝个人层 validationProfile/password，并写入 revision/0600", () => {
  const fs = memoryFs({ "/local.json": "{}\n" });
  assert.throws(() => writePersonalConfig({
    ...writeOpts(fs),
    patch: { servers: [{ id: "box", host: "10.0.0.8", remotePort: 7895, sshUser: "ubuntu", validationProfile: { remoteProxyTest: "id" } }] },
  }), /未通过校验/);
  assert.throws(() => writePersonalConfig({
    ...writeOpts(fs),
    patch: { servers: [{ id: "box", host: "10.0.0.8", remotePort: 7895, sshUser: "ubuntu", password: "secret" }] },
  }), /未通过校验/);

  const saved = writePersonalConfig({
    ...writeOpts(fs),
    patch: { servers: [{ id: "box", address: "10.0.0.8", remotePort: 7895, sshUser: "ubuntu", sshPort: 2222 }] },
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.servers[0].host, "10.0.0.8");
  assert.equal(saved.servers[0].sshPort, 2222);
  assert.equal("validationProfile" in saved.servers[0], false);
  assert.equal(fs.modes["/local.json"], 0o600);
});

test("writePersonalConfig: expectedRevision 冲突返回 409 且不改快照", () => {
  const fs = memoryFs({ "/local.json": JSON.stringify({ revision: 3, sshUser: "kai" }) });
  assert.throws(() => writePersonalConfig({
    ...writeOpts(fs),
    expectedRevision: 2,
    patch: { activeServerId: "server-02" },
  }), (err) => err.status === 409);
  assert.match(fs.files["/local.json"], /"sshUser":"kai"/);
  assert.match(fs.files["/local.json"], /"revision":3/);
});

test("config-audit: 敏感字段只写哈希", () => {
  const lines = [];
  const audit = createConfigAudit({
    filePath: "/tmp/audit.ndjson",
    writeFileSync: (_p, body) => lines.push(String(body)),
  });
  const event = audit.record({
    action: "credentials",
    serverId: "box",
    result: "ok",
    fields: { password: "s3cret", sshIdentityFile: "/Users/me/.ssh/id_ed25519" },
  });
  assert.equal(event.fieldRefs.password, hashSecretRef("s3cret"));
  assert.equal(JSON.stringify(event).includes("s3cret"), false);
  assert.equal(lines[0].includes("s3cret"), false);
});

function registryHarness({ execResult, now = Date.now } = {}) {
  const fs = memoryFs({ "/local.json": "{}\n" });
  let merged = {
    servers: [{ id: "server-01", host: "myserver", source: "team", remotePort: 7891, localPort: 8888 }],
  };
  const refreshes = [];
  const registry = createServerRegistry({
    now,
    localConfigPath: "/local.json",
    writePersonalConfigImpl: (args) => writePersonalConfig({ ...writeOpts(fs), ...args }),
    readPersonalConfigImpl: () => {
      try { return JSON.parse(fs.files["/local.json"] || "{}"); } catch { return {}; }
    },
    getMergedConfig: () => merged,
    refreshConfigIntoKernel: async () => {
      refreshes.push(true);
      const personal = JSON.parse(fs.files["/local.json"] || "{}");
      merged = {
        servers: [
          { id: "server-01", host: "myserver", source: "team", remotePort: 7891, localPort: 8888 },
          ...(personal.servers || []).map((s) => ({ ...s, source: "personal" })),
        ],
      };
    },
    execFileImpl: async () => execResult || { code: 0, stdout: "", stderr: "", timedOut: false },
  });
  return { registry, fs, refreshes, getMerged: () => merged };
}

test("ServerRegistry: 回收期内同 id 必须恢复，7 天边界后只能新建", async () => {
  let clock = 1700000000000;
  const { registry } = registryHarness({ now: () => clock });
  const input = { id: "trash-fixture", address: "fixture.invalid", sshUser: "fixture" };
  await registry.add(input);
  const deleted = await registry.remove(input.id);
  assert.equal(deleted.tombstoneUntil, clock + 7 * 86400000);
  await assert.rejects(() => registry.add(input), (err) => err.code === "server-in-trash");
  clock += 7 * 86400000 - 1;
  const restored = await registry.restore(input.id);
  assert.equal(restored.disabled, true);
  await registry.remove(input.id);
  clock += 7 * 86400000;
  assert.equal(registry.list().tombstones.length, 0);
  await assert.rejects(() => registry.restore(input.id), (err) => err.code === "no-tombstone");
  assert.equal((await registry.add(input)).id, input.id);
});

test("ServerRegistry: 新增/幂等/字段错误/脱敏列表", async () => {
  const { registry } = registryHarness();
  await assert.rejects(() => registry.add({ address: "10.0.0.8", sshPort: 22 }), /独立 SSH 用户名/);
  const added = await registry.add({ name: "腾讯云", address: "10.0.0.8", sshPort: 2222, sshUser: "ubuntu", remotePort: 7893 });
  assert.equal(added.state, "configured");
  assert.equal(added.sshPort, 2222);
  assert.equal(added.hasIdentityFile, false);
  const again = await registry.add({ id: added.id, address: "10.0.0.8", sshUser: "ubuntu", remotePort: 7893 });
  assert.equal(again.id, added.id);
  const listed = registry.list();
  assert.equal(listed.servers.some((s) => s.id === added.id), true);
  const personalCard = listed.servers.find((s) => s.id === added.id);
  assert.equal(personalCard.remotePort, 7893);
  assert.equal(personalCard.sshUser, "ubuntu");
  assert.equal(JSON.stringify(listed).includes("password"), false);
  assert.equal(JSON.stringify(listed).includes("authRef"), false);
  assert.equal(personalCard.hasPersistedCredential, false);
});

test("ServerRegistry: 团队 PATCH 只带默认 remotePort 不得改团队端口", async () => {
  const { registry, fs, getMerged } = registryHarness();
  await registry.update("server-01", {
    name: "主集群服务器",
    address: "myserver",
    sshPort: 22,
    sshUser: "ubuntu",
    remotePort: 7895,
    tunnel: true,
    monitorEnabled: true,
  });
  const personal = JSON.parse(fs.files["/local.json"] || "{}");
  assert.equal((personal.servers || []).some((s) => s.id === "server-01" && s.remotePort === 7895), false);
  assert.equal(getMerged().servers.find((s) => s.id === "server-01").remotePort, 7891);
});

test("writePersonalConfig: 个人服务器缺少 sshUser 拒绝写入", () => {
  const fs = memoryFs({ "/local.json": "{}\n" });
  assert.throws(() => writePersonalConfig({
    ...writeOpts(fs),
    patch: { servers: [{ id: "box", host: "10.0.0.8", remotePort: 7895 }] },
  }), /独立 SSH 用户名|未通过校验/);
});

test("ServerRegistry: 无效 authRef 拒绝绑定；restore 保管库空则清引用", async () => {
  const items = new Map();
  const vault = {
    kind: "keychain",
    async put(password) {
      const authRef = `vault:${password}`;
      items.set(authRef, password);
      return { authRef, persisted: true };
    },
    async get(authRef) { return items.get(authRef) || null; },
    async delete(authRef) { items.delete(authRef); return { ok: true }; },
  };
  const { fs } = registryHarness();
  const withVault = createServerRegistry({
    localConfigPath: "/local.json",
    writePersonalConfigImpl: (args) => writePersonalConfig({ ...writeOpts(fs), ...args }),
    readPersonalConfigImpl: () => JSON.parse(fs.files["/local.json"] || "{}"),
    getMergedConfig: () => ({ servers: JSON.parse(fs.files["/local.json"] || "{}").servers || [] }),
    refreshConfigIntoKernel: async () => {},
    credentialVault: vault,
  });
  const added = await withVault.add({ address: "10.0.0.12", sshUser: "ubuntu", remotePort: 7899 });
  const stored = await vault.put("once-secret");
  await withVault.putCredentials(added.id, { authRef: stored.authRef });
  assert.equal(JSON.stringify(withVault.list()).includes("authRef"), false);
  assert.equal(withVault.list().servers.find((s) => s.id === added.id).hasPersistedCredential, true);
  await assert.rejects(() => withVault.putCredentials(added.id, { authRef: "vault:missing-ref" }), /失效|无效/);
  await withVault.remove(added.id);
  const restored = await withVault.restore(added.id);
  assert.equal(restored.credentialStatus, "reenter-required");
  assert.equal(restored.hasPersistedCredential, false);
  assert.equal(JSON.parse(fs.files["/local.json"]).servers[0].authRef, undefined);
});

test("ServerRegistry: fixture 模式测试连接不发起 SSH", async () => {
  const calls = [];
  const fs = memoryFs({ "/local.json": "{}\n" });
  let merged = { servers: [{ id: "server-01", host: "myserver", source: "team", remotePort: 7891, localPort: 8888 }] };
  const registry = createServerRegistry({
    localConfigPath: "/local.json",
    writePersonalConfigImpl: (args) => writePersonalConfig({ ...writeOpts(fs), ...args }),
    readPersonalConfigImpl: () => JSON.parse(fs.files["/local.json"] || "{}"),
    getMergedConfig: () => merged,
    refreshConfigIntoKernel: async () => {
      const personal = JSON.parse(fs.files["/local.json"] || "{}");
      merged = {
        servers: [
          { id: "server-01", host: "myserver", source: "team", remotePort: 7891, localPort: 8888 },
          ...(personal.servers || []).map((s) => ({ ...s, source: "personal" })),
        ],
      };
    },
    execFileImpl: async (...args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
    fixtureMode: true,
  });
  const added = await registry.add({ address: "box.invalid", sshUser: "ubuntu", remotePort: 7896 });
  const result = await registry.testConnection(added.id);
  assert.equal(result.code, "dns");
  assert.equal(calls.length, 0);
});

test("ServerRegistry: 测试连接错误码不崩溃；删除只清理本 id", async () => {
  const { registry, getMerged } = registryHarness({
    execResult: { code: 255, stdout: "", stderr: "Permission denied (publickey).", timedOut: false },
  });
  const added = await registry.add({ address: "10.0.0.9", sshUser: "ubuntu", remotePort: 7896 });
  const testResult = await registry.testConnection(added.id);
  assert.equal(testResult.ok, false);
  assert.equal(testResult.code, "auth");
  const removed = await registry.remove(added.id);
  assert.equal(removed.state, "removed");
  assert.equal(getMerged().servers.some((s) => s.id === "server-01"), true);
  assert.equal(getMerged().servers.some((s) => s.id === added.id), false);
});

test("ServerRegistry: PATCH 冲突与凭据不落盘", async () => {
  const { registry, fs } = registryHarness();
  const added = await registry.add({ address: "10.0.0.10", sshUser: "ubuntu", remotePort: 7897 });
  await assert.rejects(() => registry.update(added.id, { name: "x", expectedRevision: 999 }), (err) => err.status === 409);
  const creds = await registry.putCredentials(added.id, { password: "once" });
  assert.match(creds.authRef, /^mem:/);
  assert.equal(creds.persisted, false);
  assert.equal(fs.files["/local.json"].includes("once"), false);
  assert.match(JSON.parse(fs.files["/local.json"]).servers[0].authRef, /^mem:/);
});

test("ServerRegistry: 密码经 askpass 交给 SSH，不进 argv/env/JSON", { skip: process.platform === "win32" }, async () => {
  const calls = [];
  const { registry, fs } = registryHarness({
    execResult: { code: 0, stdout: "", stderr: "", timedOut: false },
  });
  const added = await registry.add({ address: "10.0.0.11", sshUser: "ubuntu", remotePort: 7898 });
  const withAskpass = createServerRegistry({
    localConfigPath: "/local.json",
    writePersonalConfigImpl: (args) => writePersonalConfig({ ...writeOpts(fs), ...args }),
    readPersonalConfigImpl: () => JSON.parse(fs.files["/local.json"] || "{}"),
    getMergedConfig: () => ({ servers: [{ ...added, source: "personal" }] }),
    refreshConfigIntoKernel: async () => {},
    execFileImpl: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, env: options.env || {} });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    askpassDir: "/tmp/askpass-test",
  });
  await withAskpass.putCredentials(added.id, { password: "once-secret" });
  const result = await withAskpass.testConnection(added.id);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].args).includes("once-secret"), false);
  assert.equal(JSON.stringify(calls[0].env).includes("once-secret"), false);
  assert.equal(calls[0].args.includes("BatchMode=no"), true);
  assert.equal(calls[0].env.SSH_ASKPASS_REQUIRE, "force");
  assert.ok(calls[0].env.SSH_ASKPASS);
  assert.ok(calls[0].env.CODEX_ASKPASS_URL);
  assert.ok(calls[0].env.CODEX_ASKPASS_TOKEN);
  assert.equal(calls[0].env.SSH_ASKPASS_SECRET_FILE, undefined);
  assert.equal(fs.files["/local.json"].includes("once-secret"), false);
});

test("writePersonalConfig: 损坏文件、重复 id、非法布尔和版本冲突均不落盘", () => {
  const broken = memoryFs({ "/local.json": "{broken" });
  assert.throws(() => writePersonalConfig({ ...writeOpts(broken), patch: {} }), /原文件未改动/);
  assert.throws(() => writeActiveSelection({ ...writeOpts(broken), patch: { activeServerId: "other" } }), /原文件未改动/);
  assert.equal(broken.files["/local.json"], "{broken");
  const fs = memoryFs({ "/local.json": "{}" });
  const server = { id: "box", host: "box.invalid", sshUser: "me", tunnel: false };
  for (const servers of [[server, server], [{ ...server, disabled: "false" }]]) {
    assert.throws(() => writePersonalConfig({ ...writeOpts(fs), patch: { servers } }), /校验/);
  }
  assert.throws(() => writePersonalConfig({ ...writeOpts(fs), patch: {}, expectedRevision: 4 }), e => e.status === 409);
  assert.equal(fs.files["/local.json"], "{}");
});

test("writePersonalConfig: 旧别名条目可以禁用且保留身份与说明，不chmod仓库目录", () => {
  const legacy = { id: "legacy", host: "old-alias", remotePort: 7893, description: "保留说明", sshIdentityFile: "/key" };
  const fs = memoryFs({ "/local.json": JSON.stringify({ servers: [legacy] }) });
  const saved = writePersonalConfig({ ...writeOpts(fs), patch: { servers: [{ ...legacy, disabled: true }] } });
  assert.equal(saved.servers[0].description, "保留说明");
  assert.equal(saved.servers[0].sshIdentityFile, "/key");
  assert.equal(fs.modes["/"], undefined, "不 chmod 个人配置所在目录");
});

test("ServerRegistry: 默认仅监控且无需反向端口；全动作检查revision", async () => {
  const { registry, fs } = registryHarness();
  const added = await registry.add({ id: "only", address: "only.invalid", sshUser: "me", expectedRevision: 0 });
  assert.equal(added.tunnel, false);
  assert.equal(added.remotePort, null);
  for (const action of [() => registry.add({ id: "next", address: "next.invalid", sshUser: "me", expectedRevision: 0 }), () => registry.disable(added.id, { expectedRevision: 0 }), () => registry.remove(added.id, { expectedRevision: 0 })]) {
    await assert.rejects(action, e => e.status === 409);
  }
  assert.equal(JSON.parse(fs.files["/local.json"]).servers.length, 1);
  const removed = await registry.remove(added.id, { expectedRevision: added.revision });
  await assert.rejects(() => registry.restore(added.id, { expectedRevision: 0 }), e => e.status === 409);
  const restored = await registry.restore(added.id, { expectedRevision: removed.revision });
  assert.equal(restored.disabled, true);
  assert.equal(restored.tunnelEnabled, false);
});

test("ServerRegistry: 并发新增在同revision只成功一次，下一次未带revision不丢条目", async () => {
  const { registry } = registryHarness();
  const input = id => ({ id, address: `${id}.invalid`, sshUser: "me", expectedRevision: 0 });
  const outcomes = await Promise.allSettled([registry.add(input("a")), registry.add(input("b"))]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(r => r.status === "rejected").reason.status, 409);
  await Promise.all([registry.add({ ...input("c"), expectedRevision: undefined }), registry.add({ ...input("d"), expectedRevision: undefined })]);
  assert.equal(registry.list().servers.filter(s => s.source === "personal").length, 3);
});

test("ServerRegistry: 删除记录脱敏且仍能恢复；修改端点撤销凭据和主机密钥", async () => {
  const { registry, fs } = registryHarness();
  const added = await registry.add({ id: "secret", address: "secret.invalid", sshUser: "me", sshIdentityFile: "/private/key" });
  await registry.putCredentials(added.id, { password: "private-password" });
  await registry.remove(added.id);
  const tombstone = registry.list().tombstones[0];
  assert.equal(tombstone.canRestore, true);
  assert.equal("snapshot" in tombstone, false);
  assert.equal(JSON.stringify(tombstone).includes("/private/key"), false);
  assert.equal(JSON.stringify(tombstone).includes("authRef"), false);
  const restored = await registry.restore(added.id);
  assert.equal(restored.credentialStatus, "reenter-required");
  assert.equal(JSON.parse(fs.files["/local.json"]).servers[0].sshIdentityFile, "/private/key");
});

test("ServerRegistry: mem引用失效返回auth-required，不回退SSH密钥", async () => {
  const calls = [];
  const registry = createServerRegistry({
    readPersonalConfigImpl: () => ({ servers: [{ id: "x", host: "x.invalid", sshUser: "me", tunnel: false, authRef: "mem:expired" }] }),
    getMergedConfig: () => ({ servers: [{ id: "x", host: "x.invalid", sshUser: "me", tunnel: false, authRef: "mem:expired" }] }),
    execFileImpl: async (...args) => { calls.push(args); return { code: 0 }; },
    askpassDir: "/tmp/unused-askpass",
  });
  const result = await registry.testConnection("x");
  assert.equal(result.code, "auth-required");
  assert.equal(calls.length, 0);
});

test("ServerRegistry: source缺省团队条目可屏蔽且禁止个人同id覆盖", async () => {
  const fs = memoryFs({ "/local.json": "{}" });
  const team = { servers: [{ id: "team", host: "team.invalid", remotePort: 7891 }] };
  const registry = createServerRegistry({
    localConfigPath: "/local.json",
    readPersonalConfigImpl: () => JSON.parse(fs.files["/local.json"]),
    writePersonalConfigImpl: args => writePersonalConfig({ ...writeOpts(fs), ...args }),
    getMergedConfig: () => mergeConfig(team, JSON.parse(fs.files["/local.json"])),
  });
  assert.equal(registry.list().servers[0].source, "team");
  await assert.rejects(() => registry.add({ id: "team", address: "attacker.invalid", sshUser: "me" }), e => e.status === 409);
  await registry.disable("team");
  assert.equal(registry.list().servers[0].disabled, true);
});

test("config-audit: 写入前按2MB预算滚动", () => {
  const writes = [], truncates = [];
  const audit = createConfigAudit({ filePath: "/tmp/config-audit-unit.ndjson", maxBytes: 2048, stat: () => ({ size: 2040 }), truncate: (...args) => truncates.push(args), writeFileSync: (_p, line) => writes.push(line) });
  audit.record({ action: "update", serverId: "x" });
  assert.equal(truncates.length, 1);
  assert.match(writes[0], /rotated/);
  assert.ok(Buffer.byteLength(writes.join("")) < 2048);
});

test("ServerRegistry: 更换地址撤销旧密码绑定与hostkey，删除旧连接测试的迟到状态", async () => {
  const fs = memoryFs({ "/local.json": "{}" });
  const items = new Map(), cleared = [];
  let settleTest;
  const pendingTest = new Promise(resolve => { settleTest = resolve; });
  const registry = createServerRegistry({
    localConfigPath: "/local.json",
    readPersonalConfigImpl: () => JSON.parse(fs.files["/local.json"]),
    writePersonalConfigImpl: args => writePersonalConfig({ ...writeOpts(fs), ...args }),
    getMergedConfig: () => ({ servers: JSON.parse(fs.files["/local.json"]).servers || [] }),
    hostKeyStore: { clear: id => cleared.push(id), buildArgs: () => [] },
    credentialVault: { put: async password => { items.set("mem:one", password); return { authRef: "mem:one" }; }, get: async ref => items.get(ref), delete: async ref => { items.delete(ref); } },
    execFileImpl: async () => pendingTest,
    askpassDir: "/tmp/registry-endpoint-unit",
  });
  const added = await registry.add({ id: "x", address: "old.invalid", sshUser: "me" });
  const test = registry.testConnection(added.id);
  await registry.putCredentials(added.id, { password: "secret" });
  const changed = await registry.update(added.id, { address: "new.invalid" });
  assert.equal(changed.address, "new.invalid");
  assert.equal(JSON.parse(fs.files["/local.json"]).servers[0].authRef, undefined);
  assert.equal(items.size, 0);
  assert.deepEqual(cleared, ["x"]);
  settleTest({ code: 0, stdout: "", stderr: "" }); await test;
  assert.equal(registry.list().servers[0].state, "configured");
});

test("同名节点的不同 SSH 账号生成独立连接标识，可同时保留", async () => {
  const { registry } = registryHarness();
  const root = await registry.add({ name: "node04", address: "203.0.113.4", sshUser: "root", tunnel: false });
  const user = await registry.add({ name: "node04", address: "203.0.113.4", sshUser: "user01", tunnel: false });
  assert.notEqual(root.id, user.id);
  assert.equal(user.id, "node04-user01");
  const again = await registry.add({ name: "node04", address: "203.0.113.4", sshUser: "user01", tunnel: false });
  assert.equal(again.id, user.id);
});
