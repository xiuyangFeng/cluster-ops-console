// 管理员存储视图：配置解析（纯函数，无 IO）。
//
// 全部在个人层 config.local.json 的 storageAdmin 里（只属于管理员自己的电脑，不随同事包分发）：
//   "storageAdmin": {
//     "identityFile": "~/.ssh/id_ed25519_storage_admin",   // 可省略，缺省即此
//     "targets": [{ "id": "master", "label": "master", "host": "203.0.113.10", "port": 22, "roots": ["/public"] }]
//   }
// 专用密钥在服务器的 authorized_keys 里被 restrict + command= 钉死，只能跑 storage-admin.py（只读）。
import os from "node:os";
import path from "node:path";

import { isBoundedServerId } from "../validators.mjs";

export const DEFAULT_IDENTITY_NAME = "id_ed25519_storage_admin";
export const MAX_TARGETS = 8;
const MAX_ROOTS = 8;
const SAFE_HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;

export function isSafeTargetHost(host) {
  return typeof host === "string" && SAFE_HOST_RE.test(host) && !host.startsWith("-") && !host.startsWith(".");
}

// 允许扫描的根：绝对、规整、不是 /、不含 shell 元字符与空白（会写进安装脚本的 JSON 与远端配置）。
export function isSafeRoot(root) {
  if (typeof root !== "string" || root.length < 2 || root.length > 256 || !root.startsWith("/")) return false;
  if (root !== path.posix.normalize(root) || root.endsWith("/")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(root);
}

function expandHome(p, homeDir) {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

export function resolveIdentityFile(config, { homeDir = os.homedir() } = {}) {
  const raw = typeof config?.storageAdmin?.identityFile === "string" ? config.storageAdmin.identityFile.trim() : "";
  const p = raw ? expandHome(raw, homeDir) : path.join(homeDir, ".ssh", DEFAULT_IDENTITY_NAME);
  if (!path.isAbsolute(p) || p.includes("\0") || /[\r\n]/.test(p)) return null;
  return p;
}

// → [{ id, label, host, port, roots }]；不合法的条目丢弃（团队层是手编文件）。
export function resolveTargets(config) {
  const raw = config?.storageAdmin?.targets;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (out.length >= MAX_TARGETS) break;
    if (!t || typeof t !== "object") continue;
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!isBoundedServerId(id) || seen.has(id) || !isSafeTargetHost(t.host)) continue;
    const port = t.port == null ? 22 : Number(t.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const roots = (Array.isArray(t.roots) ? t.roots : []).filter(isSafeRoot).slice(0, MAX_ROOTS);
    if (!roots.length) continue;
    seen.add(id);
    const label = typeof t.label === "string" && t.label.trim() ? t.label.trim().slice(0, 64) : id;
    out.push({ id, label, host: t.host, port, roots: [...new Set(roots)] });
  }
  return out;
}

// 配置表单只预填当前连接，不保存、不发 SSH；扫描范围由管理员选择。
export function storageTargetDraft(config) {
  const servers = (config?.servers || []).filter((s) => s && s.disabled !== true);
  const active = servers.find((s) => s.id === config.activeServerId) || servers[0];
  if (!active) return { id: "storage-01", label: "存储服务器", host: "", port: 22 };
  return {
    id: active.id,
    label: active.name || active.id,
    host: active.sshHostName || active.address?.host || active.host || "",
    port: active.sshPort || 22,
  };
}
