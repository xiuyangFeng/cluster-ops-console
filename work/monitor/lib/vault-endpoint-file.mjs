// vault-endpoint-file.mjs —— 凭据保管（vault）本机端点的"现读"交接文件。
//
// 背景：Electron 主进程每次启动都会随机生成 vault token、listen(0) 拿随机端口，再经环境变量
// CODEX_MONITOR_VAULT_URL/TOKEN 传给 monitor-server 及其后代（supervisor）。"重启界面"
// （app.relaunch）只重启控制面，数据面 supervisor 存活下来，但它的环境变量里还是旧实例的
// URL/token——旧端口已关闭，此后任何密码认证隧道的重连 / 远端探测都会永久失败。
//
// 解法：Electron 把当前端点写进 runtimeDir 下的 0600 文件（原子写，每次启动重写；显式退出时
// 删除）。数据面每次用到 vault 时现读这个文件，读不到 / 不可信再回落环境变量。
// 文件校验：URL 必须是本机 loopback HTTP；登记的 pid 必须仍存活（崩溃残留的旧文件不采信）。
// 本模块除显式传入的 fs 实现外零副作用。

import {
  chmodSync as fsChmod,
  mkdirSync as fsMkdir,
  readFileSync as fsRead,
  renameSync as fsRename,
  unlinkSync as fsUnlink,
  writeFileSync as fsWrite,
} from "node:fs";
import path from "node:path";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { createHttpVaultClient } from "./credential-vault.mjs";
// isPidAlive 把 EPERM（进程属于别的用户）也按不存活处理：别人的进程对本文件不可信。
import { isPidAlive } from "./process-registry.mjs";

const VAULT_ENDPOINT_FILENAME = "vault-endpoint.json";

export function vaultEndpointPath(runtimeDir) {
  return path.join(runtimeDir, VAULT_ENDPOINT_FILENAME);
}

// 与 createHttpVaultClient 同一口径：仅 http://127.0.0.1 / http://[::1]，无凭据/路径/查询。
export function isLoopbackVaultUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:"
      && ["127.0.0.1", "[::1]"].includes(url.hostname)
      && Boolean(url.port)
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === "/";
  } catch {
    return false;
  }
}

function isValidToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(token);
}

// 原子写（tmp + rename），新建目录 0700、文件 0600。runtimeDir 已存在时不改它的权限
// （chmodDir: false）：那是整个运行目录，收紧与否不归本文件决定。
export function writeVaultEndpointFile({
  runtimeDir,
  url,
  token,
  pid = process.pid,
  now = Date.now,
  mkdirSync = fsMkdir,
  writeFileSync = fsWrite,
  renameSync = fsRename,
  chmodSync = fsChmod,
  unlinkSync = fsUnlink,
} = {}) {
  if (!runtimeDir) throw new Error("runtimeDir 必填");
  if (!isLoopbackVaultUrl(url)) throw new Error("vault 端点只允许本机 loopback HTTP 地址");
  if (!isValidToken(token)) throw new Error("vault token 格式不合法");
  const body = `${JSON.stringify({ version: 1, url, token, pid, writtenAt: new Date(now()).toISOString() })}\n`;
  return writePrivateFileAtomicSync(vaultEndpointPath(runtimeDir), body, {
    fs: { mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync },
    now,
    pid,
    chmodDir: false,
  });
}

// 只删自己写的（pid 一致）：重启后新实例已重写的文件，旧实例不能删。
export function removeVaultEndpointFile({ runtimeDir, pid = process.pid, readFileSync = fsRead, unlinkSync = fsUnlink } = {}) {
  if (!runtimeDir) return false;
  const target = vaultEndpointPath(runtimeDir);
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (Number(parsed?.pid) !== Number(pid)) return false;
    unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

// 读取并校验；任何不可信（缺失 / 损坏 / 非 loopback / token 非法 / 写入者已死）→ null。
export function readVaultEndpointFile({ runtimeDir, readFileSync = fsRead, pidAlive = isPidAlive } = {}) {
  if (!runtimeDir) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(vaultEndpointPath(runtimeDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!isLoopbackVaultUrl(parsed.url) || !isValidToken(parsed.token)) return null;
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
  return { url: parsed.url, token: parsed.token, pid };
}

// 候选端点（按优先级、去重）：现读文件 > 启动时环境变量。
export function resolveVaultEndpoints({ runtimeDir, env = process.env, readFileSync = fsRead, pidAlive = isPidAlive } = {}) {
  const out = [];
  const fromFile = readVaultEndpointFile({ runtimeDir, readFileSync, pidAlive });
  if (fromFile) out.push({ url: fromFile.url, token: fromFile.token, source: "file" });
  const envUrl = env?.CODEX_MONITOR_VAULT_URL;
  const envToken = env?.CODEX_MONITOR_VAULT_TOKEN;
  if (envUrl && envToken && isLoopbackVaultUrl(envUrl)
    && !out.some((e) => e.url === envUrl && e.token === envToken)) {
    out.push({ url: envUrl, token: envToken, source: "env" });
  }
  return out;
}

// 依次尝试候选端点取密码：第一个拿到密码的胜出。某个端点报错（旧端口已关闭等）就试下一个；
// 全部可达但都没有该 authRef → null；没有任何端点成功应答且至少一个报错 → 抛出最后一个错误；
// 一个候选都没有 → null（调用方按"凭据已失效"处理）。
export async function readPasswordFromVaultEndpoints({
  authRef,
  runtimeDir,
  env = process.env,
  readFileSync = fsRead,
  pidAlive = isPidAlive,
  createClient = createHttpVaultClient,
} = {}) {
  const endpoints = resolveVaultEndpoints({ runtimeDir, env, readFileSync, pidAlive });
  let lastError = null;
  let answered = false;
  for (const endpoint of endpoints) {
    try {
      const client = createClient({ baseUrl: endpoint.url, token: endpoint.token });
      const password = await client.get(authRef);
      answered = true;
      if (password) return password;
    } catch (err) {
      lastError = err;
    }
  }
  if (!answered && lastError) throw lastError;
  return null;
}
