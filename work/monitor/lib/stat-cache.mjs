import { createHash } from "node:crypto";
import { readFileSync as fsReadFileSync, statSync as fsStatSync } from "node:fs";

// 按文件戳（ino/size/mtime/ctime）缓存"读文件 → 派生值"的结果。
// supervisor 每 5s 一拍同步重读分层配置、对每台服务器的 known_hosts 做 readFileSync+sha256，
// 而这些文件绝大多数时间不变。戳不变就复用上次的派生值；maxAgeMs 兜底强制重读，
// 防御同毫秒、同大小的原地改写（mtime 粒度问题）这类戳碰撞。
//
// 文件戳：不存在记 "missing"，stat 失败记错误码——"文件消失"与"文件出现"都会改变戳。
export function fileStamp(filePath, { statSync = fsStatSync } = {}) {
  if (!filePath) return "none";
  try {
    const st = statSync(filePath);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch (error) {
    return error && error.code === "ENOENT" ? "missing" : `err:${error?.code || "unknown"}`;
  }
}

export function createStampedCache({ statSync = fsStatSync, now = Date.now, maxAgeMs = 60000 } = {}) {
  const entries = new Map(); // key -> { stamp, value, at }

  // paths：参与戳的文件列表；compute()：戳变化（或过期）时重新计算。compute 抛错不缓存，
  // 原样抛给调用方（配置损坏时 supervisor 走"保留上一份有效配置"的既有路径）。
  function get(key, paths, compute) {
    const stamp = paths.map((p) => fileStamp(p, { statSync })).join("|");
    const hit = entries.get(key);
    const at = now();
    if (hit && hit.stamp === stamp && at - hit.at < maxAgeMs) return hit.value;
    const value = compute();
    entries.set(key, { stamp, value, at });
    return value;
  }

  function clear() {
    entries.clear();
  }

  return { get, clear };
}

// known_hosts 内容修订号（sha256 hex）；文件不存在/不可读返回 null。按文件戳缓存：
// supervisor 与探针 SSH 参数构造每拍都要它，内容却只在人工确认主机密钥时才变。
const knownHostsCache = createStampedCache();

export function knownHostsRevision(knownHostsPath, { cache = knownHostsCache, readFileSync = fsReadFileSync } = {}) {
  if (!knownHostsPath) return null;
  try {
    return cache.get(`known-hosts:${knownHostsPath}`, [knownHostsPath], () => {
      try {
        return createHash("sha256").update(readFileSync(knownHostsPath)).digest("hex");
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  }
}
