import { existsSync as fsExistsSync } from "node:fs";
import path from "node:path";

import { SERVER_ID_PATTERN } from "./validators.mjs";

function hostKeyFileName(serverId) {
  const raw = String(serverId || "").trim();
  const id = SERVER_ID_PATTERN.test(raw) ? raw : String(serverId || "server").replace(/[^A-Za-z0-9._-]/g, "_");
  return `known_hosts-${id || "server"}`;
}

export function resolveHostKeyPath(dataDir, serverId) {
  if (!dataDir) throw new Error("host-key store 需要 dataDir");
  return path.join(dataDir, "ssh", hostKeyFileName(serverId));
}

export function resolveKnownHostsIfPresent(dataDir, serverId, { existsSync = fsExistsSync } = {}) {
  if (!dataDir || !serverId) return undefined;
  try {
    const knownHostsPath = resolveHostKeyPath(dataDir, serverId);
    return existsSync(knownHostsPath) ? knownHostsPath : undefined;
  } catch {
    return undefined;
  }
}

export function buildHostKeyArgs({ knownHostsPath } = {}) {
  const args = ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"];
  if (knownHostsPath) {
    const value = String(knownHostsPath);
    if (/[\r\n\0]/.test(value)) throw new Error("known_hosts 路径含非法控制字符");
    // -o is parsed again using ssh_config grammar; UserKnownHostsFile accepts
    // a whitespace-separated list even when it arrives as one argv element.
    const escaped = /[\s"\\]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
    args.push("-o", `UserKnownHostsFile=${escaped}`, "-o", "GlobalKnownHostsFile=/dev/null");
  }
  return args;
}

export function parseKeyscanLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function parseFingerprints(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.+?)\s+\(([^)]+)\)$/);
      if (!match) return { raw: line };
      return { bits: Number(match[1]), sha256: match[2], host: match[3], type: match[4] };
    });
}
