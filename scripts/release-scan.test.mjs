import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPrivateOrDocIp, scanRelease } from "./release-scan.mjs";

const scanner = fileURLToPath(new URL("./release-scan.mjs", import.meta.url));
function fixture(callback) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-scan-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    const put = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
    return callback(dir, put);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("release scan inventories tracked and untracked docs, scanner source does not flag itself", () => fixture((dir, put) => {
  put("scripts/release-scan.mjs", readFileSync(scanner));
  assert.equal(spawnSync("git", ["add", "."], { cwd: dir }).status, 0);
  assert.equal(scanRelease({ root: dir }).ok, true);
  const header = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  put("docs/example.md", `${header}\nfixture`);
  const result = scanRelease({ root: dir });
  assert.deepEqual(result.findings, [{ file: "docs/example.md", category: "private-key-header" }]);
  assert.equal(JSON.stringify(result).includes(header), false);
}));

test("release scan recognizes concrete token values, not code references or placeholders", () => fixture((dir, put) => {
  const name = ["AUTH", "TOKEN"].join("_");
  put("safe.mjs", `const token = process.env.${name};\nconst example = 'YOUR_PLACEHOLDER_TOKEN_VALUE';\n`);
  assert.equal(scanRelease({ root: dir }).ok, true);
  const value = ["AbcD2345", "efGh6789", "IjKl0MnOpQrStUvW"].join("");
  put("docs/configuration.md", `${name}="${value}"`);
  const result = scanRelease({ root: dir });
  assert.deepEqual(result.findings, [{ file: "docs/configuration.md", category: "hardcoded-token" }]);
  assert.equal(JSON.stringify(result).includes(value), false);
}));

test("release scan fails closed on Git errors and scans packaged runtime paths", () => fixture((dir, put) => {
  assert.equal(scanRelease({ root: dir, spawnSyncImpl: () => ({ status: 128, stdout: "" }) }).ok, false);
  put("payload/config.local.json", "{}");
  put("payload/runtime/credentials.json", "{}");
  put("payload/logs/supervisor.ndjson", "{}");
  put("payload/vault-secret.json", "{}");
  put("payload/secrets.json", "{}");
  put("payload/ordinary.mjs", "export const value = 1;");
  const result = scanRelease({ artifactDir: path.join(dir, "payload") });
  assert.deepEqual(result.findings.map((item) => item.file).sort(), ["config.local.json", "logs/supervisor.ndjson", "runtime/credentials.json", "secrets.json", "vault-secret.json"]);
}));

test("config.json 只放行 release-scan-allow.json 登记的团队部署地址，其它公网 IP 仍然拦下", () => fixture((dir, put) => {
  put("config.json", JSON.stringify({ servers: [{ id: "server-01", sshHostName: "198.18.7.7" }] }));
  assert.deepEqual(scanRelease({ root: dir }).findings, [{ file: "config.json", category: "deployment-public-ipv4" }], "没有登记文件（公开仓库）：一律拦下");
  put("scripts/release-scan-allow.json", JSON.stringify({ deploymentIps: ["198.18.7.7"] }));
  assert.equal(scanRelease({ root: dir }).ok, true, "登记过的团队入口地址不应告警");
  put("config.json", JSON.stringify({ servers: [{ id: "server-01", sshHostName: "198.18.7.8" }] }));
  assert.deepEqual(scanRelease({ root: dir }).findings, [{ file: "config.json", category: "deployment-public-ipv4" }]);
  assert.equal(scanRelease({ root: dir, allowedDeploymentIps: new Set(["198.18.7.8"]) }).ok, true, "可直接注入白名单");
}));

test("IPv4 documentation exceptions cover only exact TEST-NET ranges", () => {
  for (const ip of ["192.0.2.1", "198.51.100.99", "203.0.113.255", "10.1.2.3", "172.31.255.2", "192.168.1.2"]) assert.equal(isPrivateOrDocIp(ip), true, ip);
  for (const ip of ["198.51.99.1", "198.18.0.1", "192.0.3.1", "203.0.114.1", "172.32.0.1"]) assert.equal(isPrivateOrDocIp(ip), false, ip);
});

test("release scan blocks mismatched lockfile versions", () => fixture((dir, put) => {
  put("package.json", JSON.stringify({ version: "1.2.3" }));
  put("package-lock.json", JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.2" } } }));
  assert.deepEqual(scanRelease({ root: dir }).findings, [{ file: "package-lock.json", category: "package-version-mismatch" }]);
}));
