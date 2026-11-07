import assert from "node:assert/strict";
import test from "node:test";

import { sha256OfText } from "./download.mjs";
import {
  claudePlatformFor,
  codexTargetFor,
  parseClaudeManifest,
  parseReleaseAssetDigests,
  parseSha256Sums,
  resolveClaudeArtifact,
  resolveCodexArtifact,
  resolveOfficialLatest,
  resolveOfficialSizes,
} from "./sources.mjs";

const ASSET = "codex-package-x86_64-unknown-linux-musl.tar.gz";
const PKG_SHA = "3".repeat(64);
const SUMS = `${"1".repeat(64)}  codex-package-aarch64-apple-darwin.tar.gz\n${PKG_SHA}  ${ASSET}\n`;
const meta = (sumsDigest = sha256OfText(SUMS), version = "0.160.1") => ({
  tag_name: `rust-v${version}`,
  assets: [
    { name: "codex-package_SHA256SUMS", digest: `sha256:${sumsDigest}` },
    { name: ASSET, digest: `sha256:${PKG_SHA}` },
    { name: "weird", digest: "md5:abc" },
  ],
});

test("平台名：x86_64 → codex 的 musl target / Claude 的 linux-x64（musl 系统加 -musl）", () => {
  assert.equal(codexTargetFor({ arch: "x86_64" }), "x86_64-unknown-linux-musl");
  assert.equal(codexTargetFor({ arch: "aarch64" }), "aarch64-unknown-linux-musl");
  assert.equal(codexTargetFor({ arch: "ppc64le" }), null);
  assert.equal(claudePlatformFor({ arch: "x86_64", musl: false }), "linux-x64");
  assert.equal(claudePlatformFor({ arch: "x86_64", musl: true }), "linux-x64-musl");
});

test("解析：release 元数据 digest、SHA256SUMS、Claude manifest", () => {
  const d = parseReleaseAssetDigests(meta());
  assert.equal(d.get(ASSET), PKG_SHA);
  assert.equal(d.has("weird"), false);
  assert.equal(parseSha256Sums(SUMS, ASSET), PKG_SHA);
  assert.equal(parseSha256Sums(SUMS, "nope"), null);
  const manifest = { platforms: { "linux-x64": { binary: "claude", checksum: "A".repeat(64), size: 251456696 } } };
  assert.deepEqual(parseClaudeManifest(manifest, "linux-x64"), { sha256: "a".repeat(64), size: 251456696 });
  assert.equal(parseClaudeManifest(manifest, "linux-arm64"), null);
});

test("codex 产物：releases.openai.com 元数据 + SHA256SUMS 双重校验；主源挂了回落 GitHub", async () => {
  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    if (url.startsWith("https://releases.openai.com")) throw new Error("HTTP 503");
    return meta();
  };
  const fetchText = async (url) => {
    seen.push(url);
    return SUMS;
  };
  const a = await resolveCodexArtifact({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fetchJson, fetchText, sha256OfText });
  assert.equal(a.sha256, PKG_SHA);
  assert.equal(a.releaseName, "0.160.1-x86_64-unknown-linux-musl");
  assert.equal(a.urls[0], `https://github.com/openai/codex/releases/download/rust-v0.160.1/${ASSET}`);
  assert.ok(seen.includes("https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.1"));
});

test("codex 产物：SHA256SUMS 自身校验和不符 / 版本对不上 → 拒绝", async () => {
  const bad = resolveCodexArtifact({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fetchJson: async () => meta("f".repeat(64)), fetchText: async () => SUMS, sha256OfText });
  await assert.rejects(bad, /校验和不符/);
  const wrong = resolveCodexArtifact({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fetchJson: async () => meta(undefined, "0.159.2"), fetchText: async () => SUMS, sha256OfText });
  await assert.rejects(wrong, /版本与 0\.160\.1 不符/);
  await assert.rejects(resolveCodexArtifact({ version: "x", target: "t", fetchJson: async () => ({}), fetchText: async () => "", sha256OfText }), /版本号非法/);
});

test("Claude 产物：manifest 的 sha256 / size；本机能解 zstd 时附上 .zst", async () => {
  const fetchJson = async (url) => (url.endsWith("manifest.zst.json")
    ? { platforms: { "linux-x64": { checksum: "c".repeat(64), size: 88133859 } } }
    : { platforms: { "linux-x64": { checksum: "b".repeat(64), size: 251456696 } } });
  const a = await resolveClaudeArtifact({ version: "2.1.292", platform: "linux-x64", fetchJson, zstd: true });
  assert.equal(a.urls[0], "https://downloads.claude.ai/claude-code-releases/2.1.292/linux-x64/claude");
  assert.equal(a.sha256, "b".repeat(64));
  assert.equal(a.compressed.urls[0], "https://downloads.claude.ai/claude-code-releases/2.1.292/linux-x64/claude.zst");
  assert.equal(a.compressed.size, 88133859);
  const plain = await resolveClaudeArtifact({ version: "2.1.292", platform: "linux-x64", fetchJson, zstd: false });
  assert.equal(plain.compressed, undefined);
});

test("官方 latest 与首选路径进度分母", async () => {
  assert.equal(await resolveOfficialLatest("codex", { fetchJson: async () => ({ tag_name: "rust-v0.160.1" }) }), "0.160.1");
  assert.equal(await resolveOfficialLatest("claude", { fetchText: async () => "2.1.292\n" }), "2.1.292");
  const sizes = await resolveOfficialSizes("codex", { version: "0.160.1", arch: "x86_64", contentLength: async (url) => (url.includes("github.com") ? 160785122 : null) });
  assert.deepEqual(sizes, { raw: 160785122, compressed: null });
});
