import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStampedCache, fileStamp, knownHostsRevision } from "./stat-cache.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "stat-cache-"));
}

test("fileStamp: 不存在记 missing，内容/大小变化会改变戳", () => {
  const dir = tmp();
  const file = join(dir, "a.json");
  assert.equal(fileStamp(file), "missing");
  writeFileSync(file, "{}");
  const first = fileStamp(file);
  assert.notEqual(first, "missing");
  writeFileSync(file, "{\"x\":1}");
  assert.notEqual(fileStamp(file), first);
  rmSync(dir, { recursive: true, force: true });
});

test("createStampedCache: 戳不变复用、戳变化重算、超过 maxAgeMs 强制重算、compute 抛错不缓存", () => {
  let stamp = "1";
  let clock = 0;
  let computes = 0;
  const cache = createStampedCache({ statSync: () => ({ ino: 1, size: 1, mtimeMs: Number(stamp), ctimeMs: 0 }), now: () => clock, maxAgeMs: 1000 });
  const compute = () => { computes += 1; return { n: computes }; };
  assert.deepEqual(cache.get("k", ["/x"], compute), { n: 1 });
  assert.deepEqual(cache.get("k", ["/x"], compute), { n: 1 });
  assert.equal(computes, 1);
  stamp = "2";
  assert.deepEqual(cache.get("k", ["/x"], compute), { n: 2 });
  clock = 1500;
  assert.deepEqual(cache.get("k", ["/x"], compute), { n: 3 });
  stamp = "3";
  assert.throws(() => cache.get("k", ["/x"], () => { throw new Error("broken"); }), /broken/);
  assert.deepEqual(cache.get("k", ["/x"], compute), { n: 4 }, "失败后下一次必须重新计算");
});

test("knownHostsRevision: 按内容 sha256，文件替换后修订号随之变化，缺失为 null", () => {
  const dir = tmp();
  const file = join(dir, "known_hosts-server-01");
  const cache = createStampedCache();
  assert.equal(knownHostsRevision(file, { cache }), null);
  writeFileSync(file, "host ssh-ed25519 AAAA1\n");
  const r1 = knownHostsRevision(file, { cache });
  assert.equal(r1, createHash("sha256").update("host ssh-ed25519 AAAA1\n").digest("hex"));
  writeFileSync(file, "host ssh-ed25519 BBBB22\n");
  const r2 = knownHostsRevision(file, { cache });
  assert.notEqual(r2, r1);
  assert.equal(knownHostsRevision(undefined), null);
  rmSync(dir, { recursive: true, force: true });
});
