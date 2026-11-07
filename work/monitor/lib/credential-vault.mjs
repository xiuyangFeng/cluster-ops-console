import { randomUUID } from "node:crypto";
import {
  chmodSync as fsChmod,
  mkdirSync as fsMkdir,
  readFileSync as fsRead,
  renameSync as fsRename,
  unlinkSync as fsUnlink,
  writeFileSync as fsWrite,
} from "node:fs";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { statusError } from "./status-error.mjs";
import { assertVaultPassword } from "./vault-ipc.mjs";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function canPersistWithSafeStorage(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage?.isEncryptionAvailable?.()) return false;
    // Linux basic_text uses a hard-coded key when no OS secret service exists.
    if (platform === "linux" && (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() === "basic_text")) return false;
    return true;
  } catch { return false; }
}

// 惰性选择后端：首次 put/get/delete 时才调 resolveBackend() 决定加密落盘还是内存，之后固定。
// 原因：macOS 上 safeStorage.isEncryptionAvailable() 本身就会同步读钥匙串里的 Safe Storage 密钥；
// .app 是 ad-hoc 签名、每次构建签名都不同，新构建第一次读就弹授权框并阻塞 Electron 主进程——
// 放在启动时，界面在授权前根本起不来。惰性后，没存过密码的机器永远不碰钥匙串。
export function createLazyVault(resolveBackend) {
  let backend = null;
  const target = () => {
    backend ??= resolveBackend();
    return backend;
  };
  return {
    get kind() {
      return backend ? backend.kind : "pending";
    },
    put: (password) => target().put(password),
    get: (authRef) => target().get(authRef),
    delete: (authRef) => target().delete(authRef),
  };
}

export function createMemoryVault({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const items = new Map();

  function expire(authRef) {
    const item = items.get(authRef);
    if (!item) return null;
    if (item.expiresAt <= now()) {
      items.delete(authRef);
      return null;
    }
    return item;
  }

  return {
    kind: "memory",
    async put(password) {
      const value = assertVaultPassword(password);
      const authRef = `mem:${randomUUID()}`;
      const expiresAt = now() + ttlMs;
      items.set(authRef, { password: value, expiresAt });
      return { authRef, expiresAt: new Date(expiresAt).toISOString(), persisted: false };
    },
    async get(authRef) {
      return expire(authRef)?.password || null;
    },
    async delete(authRef) {
      items.delete(authRef);
      return { ok: true };
    },
  };
}

export function createEncryptedFileVault({
  filePath,
  encrypt,
  decrypt,
  now = Date.now,
  readFileSync = fsRead,
  writeFileSync = fsWrite,
  mkdirSync = fsMkdir,
  chmodSync = fsChmod,
  renameSync = fsRename,
  unlinkSync = fsUnlink,
} = {}) {
  if (typeof encrypt !== "function" || typeof decrypt !== "function") {
    throw new Error("加密保管需要 encrypt/decrypt");
  }
  const privateFs = { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync };

  function readStore() {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { version: 1, items: {} };
    } catch (err) {
      if (err?.code === "ENOENT") return { version: 1, items: {} };
      throw err;
    }
  }

  function writeStore(store) {
    const body = `${JSON.stringify({ version: 1, items: store.items || {} }, null, 2)}\n`;
    writePrivateFileAtomicSync(filePath, body, { fs: privateFs, now });
  }

  return {
    kind: "keychain",
    async put(password) {
      const value = assertVaultPassword(password);
      const authRef = `vault:${randomUUID()}`;
      const store = readStore();
      store.items[authRef] = { ciphertext: encrypt(value), createdAt: new Date(now()).toISOString() };
      writeStore(store);
      return { authRef, persisted: true };
    },
    async get(authRef) {
      if (!authRef) return null;
      const item = readStore().items?.[authRef];
      if (!item?.ciphertext) return null;
      try {
        return decrypt(item.ciphertext);
      } catch {
        return null;
      }
    },
    async delete(authRef) {
      const store = readStore();
      if (store.items?.[authRef]) {
        delete store.items[authRef];
        writeStore(store);
      }
      return { ok: true };
    },
  };
}

export function createHttpVaultClient({
  baseUrl,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl || !token) throw new Error("vault client 需要本机地址和 token");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("vault client 只允许本机 HTTP 地址");
  }

  async function request(path, body) {
    const res = await fetchImpl(`${url.origin}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        "x-vault-token": token,
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw statusError(data.error || `vault HTTP ${res.status}`, res.status, { code: data.code });
    }
    return data;
  }

  return {
    kind: "keychain",
    async put(password) {
      return request("/put", { password: assertVaultPassword(password) });
    },
    async get(authRef) {
      const data = await request("/get", { authRef });
      return data.password || null;
    },
    async delete(authRef) {
      return request("/delete", { authRef });
    },
  };
}

export function isPersistedAuthRef(authRef) {
  return typeof authRef === "string" && authRef.startsWith("vault:");
}
