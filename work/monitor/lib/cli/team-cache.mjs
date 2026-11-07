// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 这里的 ${…} 是远端 sh 的参数展开，不是漏写的模板串
// 团队 CLI 安装包缓存（v2.89）：集群共享目录 `<hubDir>/cli-cache/<cli>/<版本>/<官方产物文件名>`。
//
// 为什么：同事第一次装 Codex（约 160MB）/ Claude Code（约 250MB）时，经个人隧道下载常要几十分钟。
// 管理员在工作台里「发布到团队缓存」一次（本机下载官方产物、按官方清单校验、经 ssh 传到共享目录），
// 之后每个同事安装都在集群内拷贝，几秒完成、不走外网。
//
// 信任模型：缓存目录只是**字节来源**，不是信任来源。共享目录（/public/agent-hub 是 1777）任何集群用户都能
// 往里放东西，所以安装时：
//   1. 版本与文件名只从缓存里**列**出来（白名单正则过滤）；
//   2. 该版本的 sha256 由**本机**向官方源取（sources.mjs 的 resolveArtifact，与本机下载回退同一份清单）；
//   3. 集群上先把缓存文件拷进本人的私有上传目录（umask 077），对拷贝出来的那份核 sha256——
//      核过之后共享文件再被换掉也影响不到这次安装；落盘命令（remote-scripts 的 activate）再核一次。
//   sha256 不符 / 官方清单取不到 → 不用缓存，照原样走官方安装器 → 本机下载上传。
//
// 文件名与 sources.mjs 的产物一致：codex `codex-package-<target>.tar.gz`，Claude 原文件 `claude-<版本>-<平台>`
// （存未压缩的原文件：落盘命令直接用，集群上不需要 zstd）。
//
// 本文件只有纯函数：路径校验、远端命令（wrapSh 包好）、输出解析与「用不用缓存」的判定。
import { compareVersions } from "./catalog.mjs";
import { REMOTE_CLI_DIR } from "./remote-scripts.mjs";
import { codexPackageAsset, isSha256 } from "./sources.mjs";
import { isStrictVersion } from "./versions.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export const CLI_CACHE_SUBDIR = "cli-cache";
// 每个 CLI 在缓存里保留的版本数（发布新版后删掉更旧的；只删得掉自己发布的）。
export const CACHE_KEEP_VERSIONS = 2;

const SAFE_DIR = /^\/[A-Za-z0-9._/-]{1,200}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;

function argError(message) {
  return Object.assign(new Error(message), { code: "EARG" });
}

// 共享根目录（hubDir）是否可以安全地拼进远端脚本：绝对路径、白名单字符、没有 `..` 段、不以 / 结尾。
export function isSafeHubDir(dir) {
  if (typeof dir !== "string" || !SAFE_DIR.test(dir) || dir.endsWith("/")) return false;
  return !dir.split("/").some((seg) => seg === ".." || seg === ".");
}

export function cliCacheDir(hubDir) {
  if (!isSafeHubDir(hubDir)) throw argError(`共享目录非法: ${hubDir}`);
  return `${hubDir}/${CLI_CACHE_SUBDIR}`;
}

function assertCli(cli) {
  if (cli !== "codex" && cli !== "claude") throw argError(`未知 CLI: ${cli}`);
}

// 这个 CLI 的这个版本在缓存里应该叫什么。target：codex 是 codexTargetFor 的结果，Claude 是 claudePlatformFor 的结果。
export function cacheFileName(cli, version, target) {
  if (!isStrictVersion(version) || typeof target !== "string" || !target) return null;
  const name = cli === "codex" ? codexPackageAsset(target) : cli === "claude" ? `claude-${version}-${target}` : null;
  return name && SAFE_FILE.test(name) ? name : null;
}

// ---------------------------------------------------------------------------
// 列出缓存（拼进安装预检，也单独用于界面的「团队缓存」一行）
// ---------------------------------------------------------------------------

// 远端输出行：<key>=<版本>/<文件名> <字节数>（key 缺省 cache）。只列普通、可读的文件；.part 之类由
// parseCacheEntries 按文件名滤掉。
export function cacheListLines(cli, hubDir, key = "cache") {
  assertCli(cli);
  if (!/^[a-z][a-z.]{0,15}$/.test(key)) throw argError(`输出键非法: ${key}`);
  const dir = `${cliCacheDir(hubDir)}/${cli}`;
  return [
    `if [ -d "${dir}" ]; then for f in "${dir}"/*/*; do if [ -f "$f" ] && [ -r "$f" ]; then d=\${f%/*}; echo "${key}=\${d##*/}/\${f##*/} $(wc -c < "$f" | tr -d ' ')"; fi; done; fi`,
  ];
}

// 界面「团队缓存」一行用：两个 CLI 一起列。输出 hub=0|1、cache.codex=…、cache.claude=…。
export function buildCacheListCommand(hubDir) {
  return wrapSh([
    "echo \"v=1\"",
    `if [ -d "${hubDir}" ]; then echo "hub=1"; else echo "hub=0"; fi`,
    ...cacheListLines("codex", hubDir, "cache.codex"),
    ...cacheListLines("claude", hubDir, "cache.claude"),
    "echo \"end=1\"",
  ]);
}

// 某个 CLI 的官方产物文件名（任一支持的平台）：codex-package-<x86_64|aarch64>-unknown-linux-musl.tar.gz /
// claude-<同一版本>-linux-<x64|arm64>[-musl]。发布到一半的 .part.<pid> 与别人放进来的杂物都不算。
const CODEX_ASSET_NAME = /^codex-package-(?:x86_64|aarch64)-unknown-linux-musl\.tar\.gz$/;
export function isCacheArtifactName(cli, version, fileName) {
  if (cli === "codex") return CODEX_ASSET_NAME.test(fileName);
  if (cli === "claude") return fileName === `claude-${version}-linux-x64` || fileName === `claude-${version}-linux-arm64` || fileName === `claude-${version}-linux-x64-musl` || fileName === `claude-${version}-linux-arm64-musl`;
  return false;
}

// cache=<版本>/<文件名> <字节数> 的值列表 → [{ version, fileName, size }]（不合法的丢弃，同版本同名去重）。
// cli 给了就只留这个 CLI 的官方产物文件名（isCacheArtifactName）。
export function parseCacheEntries(values, cli = null) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const m = String(raw).match(/^([^/\s]{1,64})\/([^/\s]{1,128}) (\d{1,15})$/);
    if (!m) continue;
    const [, version, fileName, sizeText] = m;
    const size = Number(sizeText);
    if (!isStrictVersion(version) || !SAFE_FILE.test(fileName) || !(size > 0)) continue;
    if (cli && !isCacheArtifactName(cli, version, fileName)) continue;
    const key = `${version}/${fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ version, fileName, size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 安装时用不用缓存
// ---------------------------------------------------------------------------

// entries：parseCacheEntries 的结果；target：这台集群的平台名（见 cacheFileName）。
// currentVersion：集群上现在的版本（未安装 = null）；targetVersion：这次想装的版本（latest，可能未知）。
// → { entry, reason, olderThanTarget }
//    entry=null 时 reason 说明为什么不用：none（缓存里没有这个平台的包）/ not-newer（不比现在装的新）/
//    older-than-target（这是一次更新，而缓存比最新版旧：更新就该装最新版，不拿旧缓存「更新」）。
//    首次安装时缓存比最新版旧也照用（先装上能用，olderThanTarget=true，之后可再点更新）。
export function chooseCacheEntry({ cli, entries, target, currentVersion = null, targetVersion = null }) {
  const usable = (Array.isArray(entries) ? entries : []).filter((e) => e && isStrictVersion(e.version) && e.fileName === cacheFileName(cli, e.version, target) && e.size > 0);
  if (!usable.length) return { entry: null, reason: "none", olderThanTarget: false };
  const best = usable.reduce((a, b) => ((compareVersions(b.version, a.version) ?? 0) > 0 ? b : a));
  if (currentVersion && (compareVersions(best.version, currentVersion) ?? 1) <= 0) return { entry: null, reason: "not-newer", olderThanTarget: false };
  const olderThanTarget = Boolean(targetVersion && (compareVersions(best.version, targetVersion) ?? 0) < 0);
  if (currentVersion && olderThanTarget) return { entry: null, reason: "older-than-target", olderThanTarget };
  return { entry: best, reason: null, olderThanTarget };
}

export const CACHE_SKIP_TEXT = Object.freeze({
  "not-newer": "团队缓存里的版本不比集群上现在装的新",
  "older-than-target": "团队缓存里的版本比最新版旧（更新时直接装最新版）",
});

// ---------------------------------------------------------------------------
// 安装：缓存 → 本人私有上传目录（核 sha256）→ 之后与本机上传回退同一条落盘命令
// ---------------------------------------------------------------------------

export function buildCacheCopyCommand({ hubDir, cli, version, fileName, sha256 }) {
  assertCli(cli);
  if (!isStrictVersion(version)) throw argError(`版本号非法: ${version}`);
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  if (!isSha256(sha256)) throw argError("sha256 非法");
  const src = `${cliCacheDir(hubDir)}/${cli}/${version}/${fileName}`;
  const part = `"$U/${fileName}.part"`;
  return wrapSh([
    `U="${REMOTE_CLI_DIR}/upload"`,
    `S="${src}"`,
    "sha256_of() {",
    "if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | awk '{print $1}'; else shasum -a 256 \"$1\" | awk '{print $1}'; fi",
    "}",
    "umask 077",
    "if [ ! -f \"$S\" ] || [ ! -r \"$S\" ]; then echo \"copy=missing\"; echo \"end=1\"; exit 0; fi",
    "mkdir -p \"$U\" || { echo \"copy=mkdir\"; echo \"end=1\"; exit 0; }",
    `rm -f ${part}`,
    `if ! cp "$S" ${part}; then rm -f ${part}; echo "copy=failed"; echo "end=1"; exit 0; fi`,
    `if [ "$(sha256_of ${part})" != "${sha256}" ]; then rm -f ${part}; echo "copy=badsum"; echo "end=1"; exit 0; fi`,
    `mv -f ${part} "$U/${fileName}"`,
    `echo "size=$(wc -c < "$U/${fileName}" | tr -d ' ')"`,
    "echo \"copy=ok\"",
    "echo \"end=1\"",
  ]);
}

export const CACHE_COPY_TEXT = Object.freeze({
  missing: "团队缓存里的文件不见了（可能刚被管理员替换）",
  mkdir: "集群上建上传目录失败（权限或磁盘满）",
  failed: "从团队缓存拷贝失败（磁盘满或共享盘不可读）",
  badsum: "团队缓存里的文件和官方校验和不一致（已丢弃拷贝，不会使用）",
});

// ---------------------------------------------------------------------------
// 发布（管理员）：本机下载好的官方产物经 ssh 标准输入写进共享目录
// ---------------------------------------------------------------------------

// 共享根目录必须已经存在（端口登记会把它建成 1777）：这里不替它建，否则会以 0755 建出来、挡住别人领端口。
// 目录 0755、文件 0644：所有人可读、只有发布者能改。先写 .part.<pid> → 核字节数与 sha256 → 改名。
export function buildCachePublishCommand({ hubDir, cli, version, fileName, size, sha256 }) {
  assertCli(cli);
  if (!isStrictVersion(version)) throw argError(`版本号非法: ${version}`);
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  if (!Number.isSafeInteger(size) || size <= 0) throw argError(`字节数非法: ${size}`);
  if (!isSha256(sha256)) throw argError("sha256 非法");
  const cacheDir = cliCacheDir(hubDir);
  return wrapSh([
    `H="${hubDir}"`,
    `C="${cacheDir}"`,
    `D="$C/${cli}/${version}"`,
    `F="$D/${fileName}"`,
    "P=\"$F.part.$$\"",
    "sha256_of() {",
    "if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | awk '{print $1}'; else shasum -a 256 \"$1\" | awk '{print $1}'; fi",
    "}",
    "if [ ! -d \"$H\" ]; then echo \"publish=nohub\"; echo \"end=1\"; exit 0; fi",
    "umask 022",
    "mkdir -p \"$D\" 2>/dev/null || { echo \"publish=mkdir\"; echo \"end=1\"; exit 0; }",
    `chmod 0755 "$C" "$C/${cli}" "$D" 2>/dev/null`,
    "if ! cat > \"$P\"; then rm -f \"$P\"; echo \"publish=write\"; echo \"end=1\"; exit 0; fi",
    "n=$(wc -c < \"$P\" | tr -d ' ')",
    `if [ "$n" != "${size}" ]; then rm -f "$P"; echo "publish=short"; echo "got=$n"; echo "end=1"; exit 0; fi`,
    `if [ "$(sha256_of "$P")" != "${sha256}" ]; then rm -f "$P"; echo "publish=badsum"; echo "end=1"; exit 0; fi`,
    "chmod 0644 \"$P\"",
    "mv -f \"$P\" \"$F\" || { rm -f \"$P\"; echo \"publish=move\"; echo \"end=1\"; exit 0; }",
    "echo \"publish=ok\"",
    "echo \"end=1\"",
  ]);
}

export const CACHE_PUBLISH_TEXT = Object.freeze({
  nohub: "集群上还没有团队共享目录（先在「团队管理」里初始化，或请管理员建好）",
  mkdir: "在团队共享目录里建 cli-cache 失败：目录可能被别人先建了、你没有写权限",
  write: "写入团队缓存失败（磁盘满？）",
  short: "上传的字节数不对（连接中途断开）",
  badsum: "上传后集群上复核 sha256 不符",
  move: "团队缓存里改名失败",
});

// 取消 / 失败后清掉自己留下的半截发布文件（.part.<pid>）。
export function buildCachePublishCleanupCommand({ hubDir, cli, version, fileName }) {
  assertCli(cli);
  if (!isStrictVersion(version)) throw argError(`版本号非法: ${version}`);
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  return wrapSh([
    `F="${cliCacheDir(hubDir)}/${cli}/${version}/${fileName}"`,
    "for p in \"$F\".part.*; do if [ -f \"$p\" ] && [ -O \"$p\" ]; then rm -f \"$p\"; fi; done",
    "echo \"cleanup=ok\"",
    "echo \"end=1\"",
  ]);
}

// 发布后要删掉的旧版本：按版本从新到旧，保留前 keep 个。→ 版本号数组。
export function versionsToPrune(entries, keep = CACHE_KEEP_VERSIONS) {
  const versions = [...new Set((Array.isArray(entries) ? entries : []).map((e) => e?.version).filter(isStrictVersion))];
  versions.sort((a, b) => (compareVersions(b, a) ?? 0));
  return versions.slice(Math.max(0, keep));
}

// 删旧版本目录：只删自己拥有的（-O），删不掉的（别人发布的）跳过。版本号逐个过白名单。
export function buildCachePruneCommand({ hubDir, cli, versions }) {
  assertCli(cli);
  const list = (Array.isArray(versions) ? versions : []).filter(isStrictVersion);
  if (!list.length) return null;
  const base = `${cliCacheDir(hubDir)}/${cli}`;
  return wrapSh([
    ...list.map((v) => `if [ -d "${base}/${v}" ] && [ -O "${base}/${v}" ]; then rm -rf "${base}/${v}" && echo "pruned=${v}"; fi`),
    "echo \"end=1\"",
  ]);
}
