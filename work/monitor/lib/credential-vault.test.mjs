import assert from "node:assert/strict";
import test from "node:test";

import { canPersistWithSafeStorage, createEncryptedFileVault, createHttpVaultClient, createMemoryVault, isPersistedAuthRef } from "./credential-vault.mjs";
import { assertVaultPassword, createVaultHttpServer, isTrustedVaultIpcOrigin } from "./vault-ipc.mjs";

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
  };
}

test("memory vault: 15 分钟过期，不把密码当 persisted", async () => {
  let now = 1_000;
  const vault = createMemoryVault({ now: () => now, ttlMs: 15 * 60 * 1000 });
  const stored = await vault.put("once-secret");
  assert.match(stored.authRef, /^mem:/);
  assert.equal(stored.persisted, false);
  assert.equal(isPersistedAuthRef(stored.authRef), false);
  assert.equal(await vault.get(stored.authRef), "once-secret");
  now += 15 * 60 * 1000 + 1;
  assert.equal(await vault.get(stored.authRef), null);
});

test("encrypted file vault: JSON 只有密文，目录/文件权限收紧", async () => {
  const fs = memoryFs();
  const vault = createEncryptedFileVault({
    filePath: "/data/runtime/keychain.json",
    encrypt: (value) => `enc:${Buffer.from(value, "utf8").toString("hex")}`,
    decrypt: (cipher) => Buffer.from(String(cipher).slice(4), "hex").toString("utf8"),
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    renameSync: fs.renameSync,
    dirname: () => "/data/runtime",
  });
  const stored = await vault.put("once-secret");
  assert.match(stored.authRef, /^vault:/);
  assert.equal(stored.persisted, true);
  const raw = fs.files["/data/runtime/keychain.json"];
  assert.equal(raw.includes("once-secret"), false);
  assert.match(raw, /"ciphertext": "enc:/);
  assert.equal(fs.modes["/data/runtime"], 0o700);
  assert.equal(fs.modes["/data/runtime/keychain.json"], 0o600);
  assert.equal(await vault.get(stored.authRef), "once-secret");
  await vault.delete(stored.authRef);
  assert.equal(await vault.get(stored.authRef), null);
});

test("vault HTTP: 本机 token 校验，错误密钥拿不到密码", async () => {
  const memory = createMemoryVault();
  const http = createVaultHttpServer({ vault: memory, token: "vault-token" });
  const listener = await http.listen(0);
  try {
    const client = createHttpVaultClient({ baseUrl: listener.url, token: "vault-token" });
    const stored = await client.put("once-secret");
    assert.equal(await client.get(stored.authRef), "once-secret");
    const denied = await fetch(`${listener.url}/get`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vault-token": "wrong" },
      body: JSON.stringify({ authRef: stored.authRef }),
    });
    assert.equal(denied.status, 401);
    assert.equal(JSON.stringify(await denied.json()).includes("once-secret"), false);
  } finally {
    await listener.close();
  }
});

test("vault IPC: 只信任主窗口 origin，并限制密码类型与长度", () => {
  assert.equal(isTrustedVaultIpcOrigin("http://127.0.0.1:8877/"), true);
  assert.equal(isTrustedVaultIpcOrigin("file:///tmp/island.html"), false);
  assert.equal(isTrustedVaultIpcOrigin("http://evil.example/"), false);
  assert.equal(assertVaultPassword("once-secret"), "once-secret");
  assert.throws(() => assertVaultPassword(""), /密码/);
  assert.throws(() => assertVaultPassword({ p: "x" }), /密码/);
  assert.throws(() => assertVaultPassword("x".repeat(4097)), /密码/);
});

test("safeStorage: Linux basic_text 不得持久化；本机 vault 不接受远程地址或重定向", async () => {
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" };
  assert.equal(canPersistWithSafeStorage(storage, "linux"), false);
  assert.equal(canPersistWithSafeStorage({ ...storage, getSelectedStorageBackend: () => "gnome_libsecret" }, "linux"), true);
  assert.equal(canPersistWithSafeStorage({ isEncryptionAvailable: () => false }, "darwin"), false);
  assert.throws(() => createHttpVaultClient({ baseUrl: "http://example.invalid", token: "test" }), /本机/);
  assert.throws(() => createHttpVaultClient({ baseUrl: "http://127.0.0.1@evil.invalid", token: "test" }), /本机/);
  let options;
  const client = createHttpVaultClient({ baseUrl: "http://127.0.0.1:12345", token: "test", fetchImpl: async (_url, opts) => { options = opts; return { ok: true, json: async () => ({ password: null }) }; } });
  await client.get("missing");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal);
});
