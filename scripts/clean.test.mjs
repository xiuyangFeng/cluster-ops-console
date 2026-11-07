// scripts/clean.mjs 的目标分级：默认安全集绝不含离线包与 .app 备份，--all 才动离线包，
// 进行中的热更新旁路构建不删，目标不越出仓库根目录。只在临时目录里收集，不做删除。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STAGING_MIN_AGE_MS, collectTargets } from "./clean.mjs";

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "clean-fixture-"));
  const touch = (rel, content = "x") => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  touch("work/codex-cli-offline-build/codex-cli-linux-offline-0.144.1.tar.gz");
  touch("work/channel-supervisor.log");
  touch("work/channel-supervisor.pid");
  touch("work/runtime/logs/ops.ndjson");
  touch("dist/backup/2.25.2-1/Contents/MacOS/app");
  touch("dist/backup/2.26.0-2/Contents/MacOS/app");
  touch("dist/backup/2.24.0-0/Contents/MacOS/app");
  touch("dist/Codex Operations Console.app/Contents/MacOS/app");
  touch("dist/checksums-2.27.0.txt");
  touch("dist/claude-cli-1.0.0.tar.gz");
  touch("dist/claude-cli-1.0.0.tar.gz.sha256");
  touch("node-offline/node.tar.gz");
  touch("dist/staging/2.27.0-old/app");
  touch("dist/staging/2.27.0-fresh/app");
  return root;
}

// 断言统一用 POSIX 分隔符写，Windows 上 path.relative 给的是反斜杠。
const relPosix = (root, target) => path.relative(root, target).split(path.sep).join("/");

test("clean: 默认安全集不含离线包、备份、pid、运行数据与桌面包", () => {
  const root = fixtureRoot();
  try {
    const now = Date.now();
    const old = (now - STAGING_MIN_AGE_MS - 60_000) / 1000;
    utimesSync(path.join(root, "dist/staging/2.27.0-old"), old, old);
    const rel = collectTargets({ rootDir: root, now }).map((p) => relPosix(root, p)).sort();
    assert.deepEqual(rel, ["dist/staging/2.27.0-old", "work/channel-supervisor.log"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean: --all 才包含 CLI 离线构建目录与离线包（连同 .sha256），仍不碰备份与桌面包", () => {
  const root = fixtureRoot();
  try {
    const rel = collectTargets({ rootDir: root, all: true }).map((p) => relPosix(root, p));
    assert.ok(rel.includes("work/codex-cli-offline-build"));
    assert.ok(rel.includes("dist/claude-cli-1.0.0.tar.gz"));
    assert.ok(rel.includes("dist/claude-cli-1.0.0.tar.gz.sha256"));
    for (const forbidden of ["dist/backup", "dist/Codex Operations Console.app", "node-offline", "work/runtime", "work/channel-supervisor.pid", "dist/checksums-2.27.0.txt"]) {
      assert.ok(!rel.some((p) => p === forbidden || p.startsWith(`${forbidden}/`)), `不应包含 ${forbidden}`);
    }
    assert.ok(!rel.includes("dist/staging/2.27.0-fresh"), "刚生成的旁路构建可能属于进行中的 app:update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
