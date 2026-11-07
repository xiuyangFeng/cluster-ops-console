#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isMainModule } from "./lib/is-main.mjs";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".sh", ".html", ".css", ".toml", ".env", ".command"]);
const KEY_HEADER = new RegExp(["-----BEGIN ", "(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?", "PRIVATE KEY-----"].join(""));
const TOKEN_ASSIGNMENT = /\b(?:AUTH_TOKEN|CODEX_MONITOR_VAULT_TOKEN|API_KEY|OPENAI_API_KEY|access_token|refresh_token|apiKey|api_key)["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{24,})/g;
const PROVIDER_TOKEN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g;
// 团队层 config.json 允许出现的既定部署地址（同集群同事的共同入口）。地址本身不写进源码：
// 私有仓库在 scripts/release-scan-allow.json 里登记 { "deploymentIps": [...] }，导出公开快照时这个文件不带走
// （scripts/export-public.mjs），公开仓库里没有它，config.json 出现任何公网 IP 都会被拦下。
export const ALLOW_FILE = "scripts/release-scan-allow.json";

export function readAllowedDeploymentIps(root, readFile = readFileSync) {
  try {
    const list = JSON.parse(readFile(path.join(root, ALLOW_FILE), "utf8"))?.deploymentIps;
    return new Set(Array.isArray(list) ? list.filter((ip) => typeof ip === "string") : []);
  } catch {
    return new Set();
  }
}

export function isPrivateOrDocIp(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function looksLikeSecret(value) {
  if (/^(?:YOUR_|EXAMPLE_|PLACEHOLDER|REDACTED)/i.test(value)) return false;
  return new Set(value).size >= 8;
}

function forbiddenName(rel, artifact) {
  const base = path.posix.basename(rel);
  if (/^(?:config\.local\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa|known_hosts(?:[-.]|$)|keychain\.json|auth-token$)/i.test(base)) return true;
  if (/\.(?:pem|p12|pfx|key)$/i.test(base)) return true;
  return artifact && (/\.(?:log(?:\.\d+)?|ndjson|pid(?:\.json)?)$/i.test(base)
    || /^(?:(?:secrets?|credentials?|auth)\.json|vault(?:[-.][\w.-]+)?\.json|\.env(?:\.[\w.-]+)?)$/i.test(base)
    || /(?:^|\/)(?:runtime|logs|\.ssh|credentials|vault)(?:\/|$)/i.test(rel));
}

export function scanRelease({ root = process.cwd(), artifactDir, spawnSyncImpl = spawnSync, allowedDeploymentIps } = {}) {
  const findings = [];
  const allowedIps = allowedDeploymentIps instanceof Set ? allowedDeploymentIps : readAllowedDeploymentIps(path.resolve(root));
  const report = (file, category) => findings.push({ file, category });
  const baseDir = path.resolve(artifactDir || root);
  let names = [];
  if (artifactDir) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else names.push(path.relative(baseDir, full).split(path.sep).join("/"));
      }
    };
    try { walk(baseDir); } catch { report(".", "artifact-unreadable"); }
  } else {
    const result = spawnSyncImpl("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: baseDir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || result.error) return { ok: false, findings: [{ file: ".", category: "git-inventory-failed" }], scannedFiles: 0 };
    names = [...new Set(result.stdout.split("\0").filter(Boolean))];
  }
  for (const rel of names) {
    const file = path.resolve(baseDir, rel);
    if (!file.startsWith(`${baseDir}${path.sep}`)) { report(rel, "path-outside-root"); continue; }
    if (forbiddenName(rel, Boolean(artifactDir))) report(rel, "private-runtime-file");
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code !== "ENOENT") report(rel, "file-unreadable");
      continue;
    }
    if (stat.isSymbolicLink()) { report(rel, "symlink-not-scanned"); continue; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_TEXT_BYTES) {
      if (TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) report(rel, "text-exceeds-scan-budget");
      continue;
    }
    let bytes;
    try { bytes = readFileSync(file); } catch { report(rel, "file-unreadable"); continue; }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (KEY_HEADER.test(text)) report(rel, "private-key-header");
    if ([...text.matchAll(TOKEN_ASSIGNMENT)].some((match) => looksLikeSecret(match[1]))
      || [...text.matchAll(PROVIDER_TOKEN)].some((match) => looksLikeSecret(match[0]))) report(rel, "hardcoded-token");
    if (path.posix.basename(rel) === "config.json") {
      if ((text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).some((ip) => !isPrivateOrDocIp(ip) && !allowedIps.has(ip))) report(rel, "deployment-public-ipv4");
      if (/"password"\s*:/.test(text)) report(rel, "password-field");
    }
  }
  if (!artifactDir && names.includes("package.json") && names.includes("package-lock.json")) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(baseDir, "package.json"), "utf8"));
      const lock = JSON.parse(readFileSync(path.join(baseDir, "package-lock.json"), "utf8"));
      if (pkg.version !== lock.version || (lock.packages?.[""] && pkg.version !== lock.packages[""].version)) report("package-lock.json", "package-version-mismatch");
    } catch { report("package-lock.json", "package-metadata-unreadable"); }
  }
  return { ok: findings.length === 0, findings, scannedFiles: names.length };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const artifactDir = args[0] === "--artifact-dir" && args.length === 2 ? args[1] : undefined;
  if (args.length && !artifactDir) { console.error(JSON.stringify({ ok: false, findings: [{ file: ".", category: "invalid-arguments" }] })); process.exit(1); }
  const result = scanRelease({ artifactDir });
  (result.ok ? console.log : console.error)(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
