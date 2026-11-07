import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { packageColleague } from "./package-colleague.mjs";
import { listImportClosure } from "../work/monitor/lib/component-version.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
function readZip(file) {
  const bytes = fs.readFileSync(file), files = new Map();
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(at + 6) & 0x800, 0x800, "UTF-8 filename flag");
    const size = bytes.readUInt32LE(at + 18), nameLen = bytes.readUInt16LE(at + 26), extraLen = bytes.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const name = bytes.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    files.set(name.replace(/^[^/]+\//, ""), inflateRawSync(bytes.subarray(start, start + size)));
    at = start + size;
  }
  assert.equal(bytes.readUInt32LE(at), 0x02014b50);
  return files;
}
test("同事包包含完整运行/向导闭包、中文说明、CRLF 入口与逐文件校验；不包含运行数据或测试", async t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-colleague-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const result = packageColleague({ rootDir, outputDir });
  const files = readZip(result.zip);
  assert.ok(files.has("先看这里.html")); assert.ok(files.has("install/开始使用.html")); assert.ok(files.has("LICENSE"));
  for (const entry of ["scripts/launch.mjs", "scripts/setup-wizard.mjs", "scripts/setup-undo.mjs", "work/monitor/monitor-server.mjs", "work/monitor/channel-supervisor.mjs", "work/local_http_connect_proxy.mjs", "work/monitor/public/app.js"]) {
    for (const rel of await listImportClosure(rootDir, entry)) assert.ok(files.has(rel), `missing ${rel}`);
  }
  for (const [name, bytes] of files) {
    assert.doesNotMatch(name, /(?:^|\/)(?:runtime|node_modules|\.git)(?:\/|$)|config\.local|\.test\.mjs$/);
    if (name.endsWith(".cmd")) assert.doesNotMatch(bytes.toString("utf8"), /(?<!\r)\n/);
  }
  const manifest = JSON.parse(files.get("bundle-manifest.json"));
  for (const file of manifest.files) assert.equal(createHash("sha256").update(files.get(file.path)).digest("hex"), file.sha256);
  assert.match(fs.readFileSync(`${result.zip}.sha256`, "utf8"), new RegExp(`^${createHash("sha256").update(fs.readFileSync(result.zip)).digest("hex")}`));
});

test("包内新增疑似密钥时拒绝产物，即使文件在运行目录里", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-package-scan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "source"), outputDir = path.join(dir, "out");
  const files = ["package.json", "package-lock.json", "config.json", "LICENSE", ".nvmrc", "start-console.cmd", "start.sh",
    "install/install-workbench.cmd", "install/install-workbench.sh", "install/diagnose-workbench.cmd", "install/开始使用.html",
    "scripts/launch.mjs", "scripts/setup-wizard.mjs", "scripts/setup-undo.mjs", "scripts/setup/placeholder.mjs", "scripts/lib/is-main.mjs", "work/local_http_connect_proxy.mjs"];
  for (const name of files) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name === "package.json" ? '{"version":"1.0.0"}' : ""); }
  fs.mkdirSync(path.join(root, "work/monitor"), { recursive: true });
  // Synthetic token; never read any real credential in this test.
  fs.writeFileSync(path.join(root, "work/monitor/accidental.json"), JSON.stringify({ API_KEY: ["test-fixture", "0123456789abcdefghijklmnopqrstuvwxyz"].join("-") }));
  assert.throws(() => packageColleague({ rootDir: root, outputDir }), /hardcoded-token/);
  assert.deepEqual(fs.readdirSync(outputDir), []);
});
