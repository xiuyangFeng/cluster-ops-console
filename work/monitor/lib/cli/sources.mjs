// CLI 官方下载源与校验（第 2 期 P-D）。2026-10-07 在本机读了两份官方安装脚本，结论如下——
// 首选路径就是在集群上（经隧道）跑这两份脚本；回退路径在本机下载**与它们完全相同的产物**、
// 按它们同样的校验方式核对，再上传、解包到它们同样的目录结构，所以之后 `codex update` / `claude update`
// 与官方自更新照常可用。
//
// ── Codex：`curl -fsSL https://chatgpt.com/codex/install.sh | sh`（openai/codex README「Quickstart」）
//   * 版本元数据：`https://releases.openai.com/codex/channels/latest`（或 `/releases/<ver>/release.json`），
//     GitHub Releases 格式的 JSON：`tag_name: "rust-v<ver>"`，`assets[]: { name, digest: "sha256:<hex>" }`。
//     releases.openai.com 不可用时回落 `https://api.github.com/repos/openai/codex/releases/tags/rust-v<ver>`。
//   * 产物（"package" 布局）：`codex-package-<target>.tar.gz`，Linux x64 的 target 是
//     `x86_64-unknown-linux-musl`（静态 musl，与 glibc 版本无关）；0.160.1 约 160MB。
//     下载地址 `https://releases.openai.com/codex/releases/<ver>/<asset>`，回落
//     `https://github.com/openai/codex/releases/download/rust-v<ver>/<asset>`。
//   * 校验：先下 `codex-package_SHA256SUMS`，它自己的 sha256 必须等于元数据里该资产的 digest；
//     再从 SHA256SUMS 取 tar.gz 的 sha256 核对产物（元数据里 tar.gz 自己的 digest 也一致，这里两者都核）。
//   * 布局：`${CODEX_HOME:-~/.codex}/packages/standalone/`：
//       releases/<ver>-<target>/{bin/codex, bin/codex-code-mode-host, codex-path/rg, codex-resources/{bwrap,…},
//                                 codex-package.json, codex → bin/codex}
//       current → releases/<ver>-<target>（mv -Tf 原子换软链）
//       auto-update-version = "<ver>-<target>"（只有装 latest 通道时写；装指定版本时官方会删掉它——
//                             codex 的定时自更新据此判断当前选择是否跟随 latest，所以回退安装也照写）
//       install.lock（flock）
//     `~/.local/bin/codex → <root>/current/bin/codex`。Linux 上 release 目录必须带可执行的 codex-resources/bwrap。
//   * 解包：tar.gz 根目录就是 release 目录的内容，官方 `tar -xzf … -C .staging.<name>.$$` 后 chmod 0755
//     bin/codex、bin/codex-code-mode-host、codex-path/rg（及 bwrap），再 `ln -sf bin/codex codex`、mv 成正式目录。
//   * 环境变量：CODEX_NON_INTERACTIVE=1 跳过「卸载 npm 版？」「现在启动？」两个提问（无 tty 时本来也跳过）；
//     不传 --release（= latest 通道），否则会删掉 auto-update-version、关掉官方定时自更新。
//   * 下载落在 `mktemp -d`（受 TMPDIR 控制）里。注意 releases.openai.com 的资产下载带 `--max-time 300`：
//     隧道约 114KB/s 时 160MB 要二十多分钟，必然超时、再回落 GitHub 从头重下。所以首选路径给安装器设
//     `CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false`（README 写明的开关），直接走 GitHub Releases
//     （元数据 api.github.com、产物 github.com，curl 无总时长上限；同一产物、同一 sha256 校验）。
//
// ── Claude Code：`curl -fsSL https://claude.ai/install.sh | bash`
//   * 下载源 `https://downloads.claude.ai/claude-code-releases`：`/latest`（纯文本版本号）、
//     `/<ver>/manifest.json`（`platforms["linux-x64"].{ checksum: sha256 hex, size }`）、
//     `/<ver>/<platform>/claude`（原生单文件 ELF，2.1.292 约 251MB）。
//     有 zstd 时先下 `/<ver>/<platform>/claude.zst`（约 88MB），按 `manifest.zst.json` 的 checksum 校验压缩包，
//     解压后再按 manifest.json 的 checksum 校验原文件。平台名：x64 / arm64，musl 系统加 `-musl`。
//   * 下载落在 `~/.claude/downloads/claude-<ver>-<platform>[.zst]`，curl 同样没有总时长上限；
//     校验过后执行 `<下载的二进制> install`，由它自己把自己放进 `~/.local/share/claude/versions/<ver>`
//     （单个文件、无子目录）并把 `~/.local/bin/claude` 软链到它，然后删掉下载文件。
//     （`claude update` 是另一条路：原生更新器有总时长 deadline，9 月在集群上超时留下 0 字节 versions 文件。
//       首选路径因此用 install.sh 而不是 `claude update`。）
//   * npm 平台包 `@anthropic-ai/claude-code-linux-x64` 的 tgz 里也是同一个二进制（9 月手工升级用过），
//     但回退路径改用上面的官方源：校验口径与官方安装器一致，且 claude.zst 比 npm tgz（约 97MB）还小。
//
// 本文件只有纯函数 + 经注入 fetch 的元数据解析，不碰集群、不下载产物本体。
import { isStrictVersion } from "./versions.mjs";

export const CODEX_INSTALL_SCRIPT_URL = "https://chatgpt.com/codex/install.sh";
export const CLAUDE_INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";
export const CODEX_RELEASES_BASE = "https://releases.openai.com/codex";
export const CODEX_GITHUB_DOWNLOAD_BASE = "https://github.com/openai/codex/releases/download";
export const CODEX_GITHUB_API_BASE = "https://api.github.com/repos/openai/codex/releases/tags";
export const CLAUDE_DOWNLOAD_BASE = "https://downloads.claude.ai/claude-code-releases";
export const CODEX_SHA256SUMS_ASSET = "codex-package_SHA256SUMS";

const SHA256_HEX = /^[a-f0-9]{64}$/;
export const isSha256 = (v) => typeof v === "string" && SHA256_HEX.test(v);

// 远端 `uname -m` + 是否 musl → 两家的平台名。不支持的架构返回 null。
export function codexTargetFor({ arch }) {
  if (arch === "x86_64" || arch === "amd64") return "x86_64-unknown-linux-musl";
  if (arch === "aarch64" || arch === "arm64") return "aarch64-unknown-linux-musl";
  return null;
}

export function claudePlatformFor({ arch, musl = false }) {
  const a = arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : null;
  if (!a) return null;
  return `linux-${a}${musl ? "-musl" : ""}`;
}

export const codexPackageAsset = (target) => `codex-package-${target}.tar.gz`;
export const codexReleaseName = (version, target) => `${version}-${target}`;

// GitHub Releases 格式的元数据 → Map(资产名 → sha256 hex)；digest 不是 sha256:<64 hex> 的条目跳过。
export function parseReleaseAssetDigests(json) {
  const out = new Map();
  for (const asset of Array.isArray(json?.assets) ? json.assets : []) {
    const name = typeof asset?.name === "string" ? asset.name : "";
    const m = typeof asset?.digest === "string" ? asset.digest.match(/^sha256:([0-9a-fA-F]{64})$/) : null;
    if (name && m) out.set(name, m[1].toLowerCase());
  }
  return out;
}

export function releaseTagVersion(json) {
  const tag = typeof json?.tag_name === "string" ? json.tag_name : "";
  const v = tag.startsWith("rust-v") ? tag.slice(6) : "";
  return isStrictVersion(v) ? v : null;
}

// SHA256SUMS 文本（"<hex>  <name>" 每行一条）里取某个资产的 sha256。
export function parseSha256Sums(text, asset) {
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

// Claude manifest(.zst).json → { sha256, size } | null。
export function parseClaudeManifest(json, platform) {
  const p = json?.platforms?.[platform];
  const sha256 = typeof p?.checksum === "string" ? p.checksum.toLowerCase() : "";
  const size = Number(p?.size);
  if (!isSha256(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
  return { sha256, size };
}

function sourceError(message) {
  return Object.assign(new Error(message), { code: "ESOURCE" });
}

// 解析 codex 回退安装要下的产物。fetchJson / fetchText 已绑好出网设置。
// → { cli, version, target, releaseName, fileName, urls, sha256, size: null }
export async function resolveCodexArtifact({ version, target, fetchJson, fetchText, sha256OfText }) {
  if (!isStrictVersion(version)) throw sourceError(`codex 版本号非法: ${version}`);
  if (!target) throw sourceError("不支持的服务器架构");
  const asset = codexPackageAsset(target);
  const sources = [
    {
      meta: `${CODEX_RELEASES_BASE}/releases/${version}/release.json`,
      file: (name) => `${CODEX_RELEASES_BASE}/releases/${version}/${name}`,
    },
    {
      meta: `${CODEX_GITHUB_API_BASE}/rust-v${version}`,
      file: (name) => `${CODEX_GITHUB_DOWNLOAD_BASE}/rust-v${version}/${name}`,
    },
  ];
  const errors = [];
  for (const src of sources) {
    try {
      const meta = await fetchJson(src.meta);
      if (releaseTagVersion(meta) !== version) throw sourceError(`元数据版本与 ${version} 不符`);
      const digests = parseReleaseAssetDigests(meta);
      const sumsDigest = digests.get(CODEX_SHA256SUMS_ASSET);
      if (!sumsDigest) throw sourceError(`元数据里没有 ${CODEX_SHA256SUMS_ASSET}`);
      const sumsText = await fetchText(src.file(CODEX_SHA256SUMS_ASSET));
      if (sha256OfText(sumsText) !== sumsDigest) throw sourceError(`${CODEX_SHA256SUMS_ASSET} 校验和不符`);
      const sha256 = parseSha256Sums(sumsText, asset);
      if (!sha256) throw sourceError(`${CODEX_SHA256SUMS_ASSET} 里没有 ${asset}`);
      const metaDigest = digests.get(asset);
      if (metaDigest && metaDigest !== sha256) throw sourceError(`${asset} 的两处校验和不一致`);
      // 产物本体两个源都给：主源下载失败时 download 换下一个地址续传（同一文件，校验和兜底）。
      const urls = [...new Set([src.file(asset), ...sources.map((s) => s.file(asset))])];
      return { cli: "codex", version, target, releaseName: codexReleaseName(version, target), fileName: asset, urls, sha256, size: null };
    } catch (err) {
      errors.push(`${new URL(src.meta).host}: ${err?.message || err}`);
    }
  }
  throw sourceError(`拿不到 codex ${version} 的官方元数据（${errors.join("；")}）`);
}

// 目标版本未知（npm dist-tags 没取到）时问官方源：codex 的 latest 通道元数据 / Claude 的 /latest。
export async function resolveOfficialLatest(cli, { fetchJson, fetchText }) {
  if (cli === "codex") {
    for (const url of [`${CODEX_RELEASES_BASE}/channels/latest`, "https://api.github.com/repos/openai/codex/releases/latest"]) {
      try {
        const v = releaseTagVersion(await fetchJson(url));
        if (v) return v;
      } catch {
        // 换下一个源
      }
    }
    return null;
  }
  const text = String(await fetchText(`${CLAUDE_DOWNLOAD_BASE}/latest`)).trim();
  return isStrictVersion(text) ? text : null;
}

// 首选路径进度条的分母（best-effort）：codex 取 GitHub 产物的 Content-Length（首选路径让安装器走 GitHub），
// Claude 取 manifest 里原文件与 .zst 的 size。→ { raw, compressed } 或 null。
export async function resolveOfficialSizes(cli, { version, arch, musl, fetchJson, contentLength }) {
  if (!isStrictVersion(version)) return null;
  if (cli === "codex") {
    const target = codexTargetFor({ arch });
    if (!target) return null;
    const raw = await contentLength(`${CODEX_GITHUB_DOWNLOAD_BASE}/rust-v${version}/${codexPackageAsset(target)}`);
    return { raw, compressed: null };
  }
  const platform = claudePlatformFor({ arch, musl });
  if (!platform) return null;
  const base = `${CLAUDE_DOWNLOAD_BASE}/${version}`;
  const raw = parseClaudeManifest(await fetchJson(`${base}/manifest.json`), platform)?.size ?? null;
  let compressed = null;
  try {
    compressed = parseClaudeManifest(await fetchJson(`${base}/manifest.zst.json`), platform)?.size ?? null;
  } catch {
    compressed = null;
  }
  return { raw, compressed };
}

// 解析 Claude 回退安装要下的产物。zstd = 本机能否解 zstd（node:zlib 有 createZstdDecompress）。
// → { cli, version, platform, fileName, urls, sha256, size, compressed?: { fileName, urls, sha256, size } }
export async function resolveClaudeArtifact({ version, platform, fetchJson, zstd = false }) {
  if (!isStrictVersion(version)) throw sourceError(`Claude 版本号非法: ${version}`);
  if (!platform) throw sourceError("不支持的服务器架构");
  const base = `${CLAUDE_DOWNLOAD_BASE}/${version}`;
  const manifest = parseClaudeManifest(await fetchJson(`${base}/manifest.json`), platform);
  if (!manifest) throw sourceError(`Claude ${version} 的 manifest 里没有 ${platform}`);
  const out = {
    cli: "claude",
    version,
    platform,
    fileName: `claude-${version}-${platform}`,
    urls: [`${base}/${platform}/claude`],
    sha256: manifest.sha256,
    size: manifest.size,
  };
  if (zstd) {
    try {
      const zst = parseClaudeManifest(await fetchJson(`${base}/manifest.zst.json`), platform);
      if (zst) out.compressed = { fileName: `${out.fileName}.zst`, urls: [`${base}/${platform}/claude.zst`], sha256: zst.sha256, size: zst.size };
    } catch {
      // 没有压缩版清单就下原文件（官方安装器同样这么回落）。
    }
  }
  return out;
}
