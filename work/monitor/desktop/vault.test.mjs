import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createCredentialVaultService } from "./vault.mjs";

function makeHarness(t, { safeStorage, writeFails = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-vault-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ctx = createDesktopContext({ rootDir: "/app", env: { CODEX_MONITOR_DATA_DIR: dataDir }, platform: "darwin", homeDir: "/Users/t" });
  const calls = [];
  const warnings = [];
  const servers = [];
  const createServer = ({ vault, token }) => {
    const server = { vault, token, closed: false };
    servers.push(server);
    return {
      listen: async (port) => {
        calls.push(`listen(${port})`);
        return { url: "http://127.0.0.1:41234", close: async () => { server.closed = true; calls.push("close"); } };
      },
    };
  };
  const service = createCredentialVaultService({
    ctx,
    safeStorage,
    createServer,
    writeEndpointFile: (args) => {
      calls.push(["writeEndpointFile", args]);
      if (writeFails) throw new Error("EACCES");
    },
    removeEndpointFile: (args) => calls.push(["removeEndpointFile", args]),
    logger: { warn: (...args) => warnings.push(args.join(" ")) },
  });
  return { ctx, calls, warnings, servers, service, dataDir };
}

function fakeSafeStorage() {
  const counts = { encrypt: 0, decrypt: 0, available: 0 };
  return {
    counts,
    isEncryptionAvailable: () => { counts.available += 1; return true; },
    // Linux 上 canPersistWithSafeStorage 还要求真正的系统密钥后端（basic_text 只是硬编码密钥）。
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => { counts.encrypt += 1; return Buffer.from(`enc:${value}`); },
    decryptString: (buf) => { counts.decrypt += 1; return buf.toString().slice(4); },
  };
}

test("safeStorage 可用：加密落盘保管库 + 本机端点，写端点文件；启动不碰钥匙串（连可用性判定都推迟）", async (t) => {
  const safeStorage = fakeSafeStorage();
  const h = makeHarness(t, { safeStorage });
  const handle = await h.service.startCredentialVault();
  assert.equal(handle.url, "http://127.0.0.1:41234");
  assert.equal(h.servers.length, 1);
  assert.equal(safeStorage.counts.available, 0, "isEncryptionAvailable 在 macOS 上会读钥匙串，启动时不得调用");
  assert.equal(h.servers[0].vault.kind, "pending", "后端在第一次存取密码时才决定");
  assert.equal(h.servers[0].token, h.ctx.vaultToken);
  assert.deepEqual(h.calls, [
    "listen(0)",
    ["writeEndpointFile", { runtimeDir: h.ctx.runtimePaths.runtimeDir, url: "http://127.0.0.1:41234", token: h.ctx.vaultToken }],
  ]);
  assert.equal(safeStorage.counts.decrypt, 0);
  // 幂等：再次启动复用同一端点
  assert.equal(await h.service.startCredentialVault(), handle);
  assert.equal(h.servers.length, 1);

  // 密码经 HTTP 端点 /put 存入的就是交给 createServer 的这个保管库。
  const stored = await h.servers[0].vault.put("s3cret");
  assert.equal(stored.persisted, true);
  assert.equal(h.servers[0].vault.kind, "keychain");
  assert.equal(safeStorage.counts.available, 1, "可用性只判定一次");
  assert.equal(safeStorage.counts.encrypt, 1);
  assert.equal(safeStorage.counts.decrypt, 0, "存密码也不解密");
  assert.ok(fs.existsSync(path.join(h.dataDir, "runtime", "keychain.json")));
  assert.equal(await h.servers[0].vault.get(stored.authRef), "s3cret", "真正取密码时才解密");
  assert.equal(safeStorage.counts.decrypt, 1);
  assert.equal(safeStorage.counts.available, 1);
});

test("safeStorage 不可用 / 缺失：退回内存保管库，不落盘", async (t) => {
  const unavailable = makeHarness(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await unavailable.service.startCredentialVault();
  assert.equal((await unavailable.servers[0].vault.put("pw")).persisted, false);
  assert.equal(unavailable.servers[0].vault.kind, "memory");

  const missing = makeHarness(t, { safeStorage: undefined });
  await missing.service.startCredentialVault();
  assert.equal(await missing.servers[0].vault.get("mem:none"), null);
  assert.equal(missing.servers[0].vault.kind, "memory");
});

test("端点文件写失败只告警，不挡住启动", async (t) => {
  const h = makeHarness(t, { safeStorage: fakeSafeStorage(), writeFails: true });
  const handle = await h.service.startCredentialVault();
  assert.equal(handle.url, "http://127.0.0.1:41234");
  assert.match(h.warnings.join("\n"), /\[vault\] endpoint file write failed: EACCES/);
});

test("拆除（仅显式退出）：关端点、丢弃保管库、删端点文件；之后再启动会新建端点", async (t) => {
  const h = makeHarness(t, { safeStorage: fakeSafeStorage() });
  await h.service.startCredentialVault();
  await h.service.teardownCredentialVault();
  assert.equal(h.servers[0].closed, true);
  assert.deepEqual(h.calls.slice(-2), ["close", ["removeEndpointFile", { runtimeDir: h.ctx.runtimePaths.runtimeDir }]]);
  await h.service.startCredentialVault();
  assert.equal(h.servers.length, 2, "拆除后端点句柄已清空，再启动不会复用已关闭的端点");
  // 未启动过也照样删端点文件（只删自己写的，由 vault-endpoint-file 按 pid 判定）
  const fresh = makeHarness(t, { safeStorage: fakeSafeStorage() });
  await fresh.service.teardownCredentialVault();
  assert.deepEqual(fresh.calls, [["removeEndpointFile", { runtimeDir: fresh.ctx.runtimePaths.runtimeDir }]]);
});
