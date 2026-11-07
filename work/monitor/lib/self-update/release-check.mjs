// 打包安装的 App 查新版本：问 GitHub Releases 的最新正式版（只读、匿名），比 package.json 的版本高就提示去下载。
// 打包版不替换自己的文件——下载新安装包覆盖安装即可，配置与数据不在安装目录里。
//
// 仓库从 package.json 的 repository 读（公开快照导出时改写成公开仓库，见 scripts/export-public.mjs）。
// 私有仓库匿名访问是 404，那就当作没有新版本：不报错、不打扰。
import { parseNodeVersion } from "../platform.mjs";

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const RELEASE_TIMEOUT_MS = 10_000;

// package.json 的 repository（字符串或 { url }）→ "owner/name"；不是 GitHub 仓库 → null。
export function githubRepoOf(pkg) {
  const raw = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  if (typeof raw !== "string") return null;
  const m = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/.exec(raw.trim());
  return m && REPO_RE.test(m[1]) ? m[1] : null;
}

// "v2.94.0" / "2.94.0" → [2, 94, 0]；带预发布后缀（-rc.1）或读不懂 → null（不拿预发布当正式版提示）。
export function releaseVersionOf(tag) {
  const text = String(tag ?? "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(text)) return null;
  const parsed = parseNodeVersion(text);
  return parsed ? [parsed.major, parsed.minor, parsed.patch] : null;
}

export function isNewerVersion(remote, local) {
  const a = releaseVersionOf(remote);
  const b = releaseVersionOf(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// → { version, url } | null（没有正式版 / 仓库不存在或私有）。网络错误、限流照常抛出，由调用方记一笔后下次再问。
export async function fetchLatestRelease(repo, { fetchImpl = globalThis.fetch, timeoutMs = RELEASE_TIMEOUT_MS } = {}) {
  if (!REPO_RE.test(String(repo || ""))) return null;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "codex-operations-console" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  const body = await res.json();
  if (body?.draft || body?.prerelease) return null;
  const version = releaseVersionOf(body?.tag_name);
  if (!version) return null;
  const pageUrl = typeof body.html_url === "string" && body.html_url.startsWith(`https://github.com/${repo}/releases/`) ? body.html_url : `https://github.com/${repo}/releases/latest`;
  return { version: version.join("."), url: pageUrl };
}
