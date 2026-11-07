// vault 端点现读文件：重启界面后存活的 supervisor 靠它拿到新实例的 vault 端口/token。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMemoryVault } from "./credential-vault.mjs";
import { createVaultHttpServer } from "./vault-ipc.mjs";
import {
  isLoopbackVaultUrl,
  readPasswordFromVaultEndpoints,
  readVaultEndpointFile,
  removeVaultEndpointFile,
  resolveVaultEndpoints,
  vaultEndpointPath,
  writeVaultEndpointFile,
} from "./vault-endpoint-file.mjs";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const alive = () => true;
const dead = () => false;

function tmpRuntime() {
  return path.join(mkdtempSync(path.join(tmpdir(), "vault-endpoint-")), "runtime");
}

test("isLoopbackVaultUrl 只接受本机 loopback HTTP 根路径", () => {
  assert.equal(isLoopbackVaultUrl("http://127.0.0.1:5000"), true);
  assert.equal(isLoopbackVaultUrl("http://127.0.0.1:5000/"), true);
  assert.equal(isLoopbackVaultUrl("http://[::1]:5000"), true);
  for (const bad of ["https://127.0.0.1:5000", "http://10.0.0.1:5000", "http://localhost:5000", "http://127.0.0.1", "http://u:p@127.0.0.1:5000", "http://127.0.0.1:5000/x", "http://127.0.0.1:5000/?a=1", "", null, "not a url"]) {
    assert.equal(isLoopbackVaultUrl(bad), false, String(bad));
  }
});

test("写入：原子、0600、每次重写；读回校验 pid 存活", () => {
  const runtimeDir = tmpRuntime();
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5001", token: TOKEN_A, pid: 4242 });
  const file = vaultEndpointPath(runtimeDir);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(runtimeDir).mode & 0o777, 0o700);
  }
  assert.deepEqual(readVaultEndpointFile({ runtimeDir, pidAlive: alive }), { url: "http://127.0.0.1:5001", token: TOKEN_A, pid: 4242 });
  // 写入者已死（崩溃残留）→ 不采信
  assert.equal(readVaultEndpointFile({ runtimeDir, pidAlive: dead }), null);
  // 重启后新实例重写
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5002", token: TOKEN_B, pid: 4343 });
  assert.equal(readVaultEndpointFile({ runtimeDir, pidAlive: alive }).url, "http://127.0.0.1:5002");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 4343);
});

test("写入：不改已存在 runtimeDir 的权限；注入的 fs 生效，rename 失败时清掉临时文件", { skip: process.platform === "win32" }, () => {
  const runtimeDir = tmpRuntime();
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o755);
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5001", token: TOKEN_A, pid: 4242 });
  assert.equal(statSync(runtimeDir).mode & 0o777, 0o755, "runtimeDir 是整个运行目录，不能被顺手收紧");
  const renameSync = () => { throw new Error("rename boom"); };
  assert.throws(
    () => writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5002", token: TOKEN_B, pid: 4343, renameSync }),
    /rename boom/,
  );
  assert.deepEqual(readdirSync(runtimeDir), ["vault-endpoint.json"], "失败后不残留 .tmp");
  assert.equal(JSON.parse(readFileSync(vaultEndpointPath(runtimeDir), "utf8")).pid, 4242);
});

test("写入拒绝非 loopback URL 与非法 token；读取拒绝被篡改为外部地址的文件", () => {
  const runtimeDir = tmpRuntime();
  assert.throws(() => writeVaultEndpointFile({ runtimeDir, url: "http://192.168.1.2:80", token: TOKEN_A }));
  assert.throws(() => writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5001", token: "short" }));
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5001", token: TOKEN_A, pid: 1 });
  writeFileSync(vaultEndpointPath(runtimeDir), JSON.stringify({ url: "http://evil.example:80", token: TOKEN_A, pid: 1 }));
  assert.equal(readVaultEndpointFile({ runtimeDir, pidAlive: alive }), null);
  writeFileSync(vaultEndpointPath(runtimeDir), "{broken");
  assert.equal(readVaultEndpointFile({ runtimeDir, pidAlive: alive }), null);
});

test("删除只删自己写的", () => {
  const runtimeDir = tmpRuntime();
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:5001", token: TOKEN_A, pid: 10 });
  assert.equal(removeVaultEndpointFile({ runtimeDir, pid: 11 }), false);
  assert.equal(existsSync(vaultEndpointPath(runtimeDir)), true);
  assert.equal(removeVaultEndpointFile({ runtimeDir, pid: 10 }), true);
  assert.equal(existsSync(vaultEndpointPath(runtimeDir)), false);
  assert.equal(removeVaultEndpointFile({ runtimeDir, pid: 10 }), false);
});

test("候选端点：文件优先、env 兜底、去重、env 非 loopback 被丢弃", () => {
  const runtimeDir = tmpRuntime();
  const env = { CODEX_MONITOR_VAULT_URL: "http://127.0.0.1:6000", CODEX_MONITOR_VAULT_TOKEN: TOKEN_A };
  assert.deepEqual(resolveVaultEndpoints({ runtimeDir, env, pidAlive: alive }).map((e) => e.source), ["env"]);
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:6001", token: TOKEN_B, pid: 1 });
  assert.deepEqual(resolveVaultEndpoints({ runtimeDir, env, pidAlive: alive }).map((e) => e.source), ["file", "env"]);
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:6000", token: TOKEN_A, pid: 1 });
  assert.deepEqual(resolveVaultEndpoints({ runtimeDir, env, pidAlive: alive }).map((e) => e.source), ["file"]);
  assert.deepEqual(resolveVaultEndpoints({ runtimeDir, env: { CODEX_MONITOR_VAULT_URL: "http://1.2.3.4:1", CODEX_MONITOR_VAULT_TOKEN: TOKEN_A }, pidAlive: dead }), []);
});

test("重启界面场景：env 指向已关闭的旧端口，现读文件拿到新实例的密码（真实 loopback vault）", async () => {
  const runtimeDir = tmpRuntime();
  // 旧实例：起一个 vault 再关掉，模拟 app.relaunch 后旧端口失效
  const oldServer = createVaultHttpServer({ vault: createMemoryVault(), token: TOKEN_A });
  const oldEndpoint = await oldServer.listen(0);
  await oldEndpoint.close();
  const env = { CODEX_MONITOR_VAULT_URL: oldEndpoint.url, CODEX_MONITOR_VAULT_TOKEN: TOKEN_A };

  const vault = createMemoryVault();
  const { authRef } = await vault.put("s3cret-pass");
  const newServer = createVaultHttpServer({ vault, token: TOKEN_B });
  const newEndpoint = await newServer.listen(0);
  try {
    // 没有文件：只有失效的 env → 连接错误向上抛（与旧行为一致：本次尝试失败）
    await assert.rejects(readPasswordFromVaultEndpoints({ authRef, runtimeDir, env }));
    writeVaultEndpointFile({ runtimeDir, url: newEndpoint.url, token: TOKEN_B, pid: process.pid });
    assert.equal(await readPasswordFromVaultEndpoints({ authRef, runtimeDir, env }), "s3cret-pass");
    // 未知 authRef：可达但无此项 → null（调用方报"凭据已失效"）
    assert.equal(await readPasswordFromVaultEndpoints({ authRef: "mem:none", runtimeDir, env }), null);
  } finally {
    newServer.server.closeAllConnections();
    await newEndpoint.close();
  }
});

test("文件端点报错时回落 env 端点", async () => {
  const runtimeDir = tmpRuntime();
  writeVaultEndpointFile({ runtimeDir, url: "http://127.0.0.1:6001", token: TOKEN_B, pid: 1 });
  const env = { CODEX_MONITOR_VAULT_URL: "http://127.0.0.1:6000", CODEX_MONITOR_VAULT_TOKEN: TOKEN_A };
  const calls = [];
  const createClient = ({ baseUrl }) => ({
    get: async () => {
      calls.push(baseUrl);
      if (baseUrl.endsWith(":6001")) throw new Error("ECONNREFUSED");
      return "from-env";
    },
  });
  assert.equal(await readPasswordFromVaultEndpoints({ authRef: "vault:x", runtimeDir, env, pidAlive: alive, createClient }), "from-env");
  assert.deepEqual(calls, ["http://127.0.0.1:6001", "http://127.0.0.1:6000"]);
});

