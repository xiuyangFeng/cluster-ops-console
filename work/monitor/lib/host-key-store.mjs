import { createHash } from "node:crypto";
import {
  chmodSync as fsChmod,
  mkdirSync as fsMkdir,
  readFileSync as fsRead,
  renameSync as fsRename,
  unlinkSync as fsUnlink,
  writeFileSync as fsWrite,
} from "node:fs";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { assertSafeHost, assertSafePort } from "./ssh-args.mjs";
import { buildHostKeyArgs, parseFingerprints, parseKeyscanLines, resolveHostKeyPath } from "./host-key-policy.mjs";
import { statusError } from "./status-error.mjs";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

export function createHostKeyStore({
  dataDir,
  execFileImpl,
  now = Date.now,
  readFileSync = fsRead,
  writeFileSync = fsWrite,
  mkdirSync = fsMkdir,
  chmodSync = fsChmod,
  renameSync = fsRename,
  unlinkSync = fsUnlink,
  fixtureMode = false,
} = {}) {
  const previews = new Map();
  // 注入的同步 fs 函数（测试用）原样交给共享原子写。
  const privateFs = { mkdirSync, chmodSync, writeFileSync, renameSync, unlinkSync };

  function pathFor(serverId) {
    return resolveHostKeyPath(dataDir, serverId);
  }

  function hasConfirmed(serverId) {
    try {
      return parseKeyscanLines(readFileSync(pathFor(serverId), "utf8")).length > 0;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  function buildArgs(serverId) {
    return buildHostKeyArgs({ knownHostsPath: hasConfirmed(serverId) ? pathFor(serverId) : undefined });
  }

  function writeLines(serverId, lines) {
    const filePath = pathFor(serverId);
    const body = `${[...new Set(parseKeyscanLines(lines.join("\n")))].join("\n")}\n`;
    writePrivateFileAtomicSync(filePath, body, { fs: privateFs, now });
    return { path: filePath, count: parseKeyscanLines(body).length };
  }

  function clear(serverId) {
    try { unlinkSync(pathFor(serverId)); } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    previews.delete(serverId);
  }

  async function preview({ host, sshPort = 22, serverId } = {}) {
    const safeHost = assertSafeHost(host, "address");
    const port = assertSafePort(sshPort, "sshPort");
    if (fixtureMode) {
      return { ok: false, code: "dns", fingerprints: [], nextAction: "fixture 模式不扫描真实主机密钥" };
    }
    if (typeof execFileImpl !== "function") throw new Error("host-key preview 需要 execFileImpl");
    const scanned = await execFileImpl("ssh-keyscan", ["-T", "5", "-p", String(port), safeHost], { timeoutMs: 8000 });
    const lines = parseKeyscanLines(scanned.stdout);
    if (!lines.length) {
      return { ok: false, code: "hostkey", fingerprints: [], nextAction: "未能读取主机密钥，请检查地址与端口" };
    }
    const hashed = await execFileImpl("ssh-keygen", ["-lf", "-"], { timeoutMs: 4000, input: `${lines.join("\n")}\n` });
    const fingerprints = parseFingerprints(hashed.stdout);
    if (hashed.code !== 0 || hashed.timedOut || !fingerprints.length || fingerprints.some((fingerprint) => !fingerprint.sha256)) {
      if (serverId) previews.delete(serverId);
      return { ok: false, code: "hostkey", fingerprints: [], nextAction: "无法验证主机密钥指纹，请重新扫描" };
    }
    const linesHash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24);
    if (serverId) {
      previews.set(serverId, { lines, linesHash, fingerprints, expiresAt: now() + PREVIEW_TTL_MS });
    }
    return { ok: true, host: safeHost, sshPort: port, fingerprints, linesHash };
  }

  function confirm(serverId, { linesHash, lines } = {}) {
    if (lines !== undefined) {
      throw statusError("确认主机密钥不得提交原始密钥行，请重新预览", 400, { code: "hostkey-lines-forbidden" });
    }
    const cached = previews.get(serverId);
    if (cached && cached.expiresAt <= now()) previews.delete(serverId);
    const live = previews.get(serverId);
    if (!live?.lines?.length) {
      throw statusError("请先预览并确认主机密钥指纹", 400, { code: "hostkey-required" });
    }
    const expectedHash = createHash("sha256").update(live.lines.join("\n")).digest("hex").slice(0, 24);
    if (!linesHash || linesHash !== expectedHash) {
      throw statusError("主机密钥已变化，请重新预览后再确认", 409, { code: "hostkey-mismatch" });
    }
    const saved = writeLines(serverId, live.lines);
    previews.delete(serverId);
    return { ok: true, ...saved, fingerprints: live.fingerprints || [] };
  }

  return { pathFor, hasConfirmed, buildArgs, writeLines, clear, preview, confirm };
}
