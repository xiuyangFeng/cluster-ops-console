// vault.mjs —— 凭证保管库（SSH 一次性密码）：safeStorage 加密落盘或内存兜底 + 本机 HTTP 端点。
//
// monitor-server / supervisor 经 HTTP 端点存取密码（token 鉴权，只听 127.0.0.1；渲染层的密码
// 经 monitor-server 转到 /put，不走 IPC）。
// 钥匙串一律惰性：连"能不能加密"的判定（isEncryptionAvailable，macOS 上会读钥匙串）都推迟到
// 第一次真正存取密码（createLazyVault）；decrypt 也只在真正取密码时才调。启动时碰钥匙串会在
// 新构建上弹授权框、阻塞主进程，界面起不来。

import path from "node:path";

import { canPersistWithSafeStorage, createEncryptedFileVault, createLazyVault, createMemoryVault } from "../lib/credential-vault.mjs";
import { removeVaultEndpointFile, writeVaultEndpointFile } from "../lib/vault-endpoint-file.mjs";
import { createVaultHttpServer } from "../lib/vault-ipc.mjs";

export function createCredentialVaultService({
  ctx,
  safeStorage,
  createServer = createVaultHttpServer,
  writeEndpointFile = writeVaultEndpointFile,
  removeEndpointFile = removeVaultEndpointFile,
  logger = console,
}) {
  const { runtimePaths, vaultToken } = ctx;
  let credentialVault = null;
  let vaultHttp = null;

  function resolveBackend() {
    try {
      if (canPersistWithSafeStorage(safeStorage)) {
        return createEncryptedFileVault({
          filePath: path.join(runtimePaths.dataRoot, "runtime", "keychain.json"),
          encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
          decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(String(ciphertext), "base64")),
        });
      }
    } catch (err) {
      logger.warn("safeStorage unavailable, passwords stay in memory only:", err?.message || err);
    }
    return createMemoryVault();
  }

  async function startCredentialVault() {
    if (vaultHttp) return vaultHttp;
    credentialVault = createLazyVault(resolveBackend);
    vaultHttp = await createServer({ vault: credentialVault, token: vaultToken }).listen(0);
    // 把当前端点写进 runtime 下的 0600 文件：重启界面后存活的 supervisor 环境变量里仍是旧端口/
    // token，它每次取密码都现读这个文件（lib/vault-endpoint-file.mjs），否则密码隧道重连永久失败。
    try {
      writeEndpointFile({ runtimeDir: runtimePaths.runtimeDir, url: vaultHttp.url, token: vaultToken });
    } catch (err) {
      logger.warn("[vault] endpoint file write failed:", err?.message || err);
    }
    return vaultHttp;
  }

  // 只在显式退出（数据面已停）时调用：重启界面保留端点文件，存活的 supervisor 还要靠它找到新端点。
  async function teardownCredentialVault() {
    if (vaultHttp) {
      try { await vaultHttp.close(); } catch {}
      vaultHttp = null;
      credentialVault = null;
    }
    // 显式退出：数据面已停，端点文件随之失效（只删自己写的）。
    removeEndpointFile({ runtimeDir: runtimePaths.runtimeDir });
  }

  return { startCredentialVault, teardownCredentialVault };
}
