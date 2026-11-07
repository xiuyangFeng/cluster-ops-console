import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDiagnosesStore, headBytes, sanitizeDiagnosis, STORED_SCRIPT_BYTES, STORED_TAIL_BYTES, tailBytes } from "./diagnoses-store.mjs";

const DAY = 24 * 3600_000;
const item = (jobId, endedAt, extra = {}) => ({ jobId, serverId: "s1", name: "t", state: "FAILED", exitCode: 1, endedAt, category: "python", headline: "KeyError: 'arm'", evidence: ["a"], files: [{ path: "/w/o.log", tail: "x" }], script: "#!/bin/bash", source: "registry", ...extra });

test("入库规整：字段白名单、类别 / 来源 / 作业号校验、尾部 4KB、脚本 8KB、证据 20 行（按字节不切坏汉字）", () => {
  assert.equal(sanitizeDiagnosis(item("1;x", 1)), null);
  assert.equal(sanitizeDiagnosis(item("1", 1, { category: "weird" })), null);
  const s = sanitizeDiagnosis(item("1", 1, {
    source: "elsewhere",
    evidence: Array.from({ length: 30 }, (_, i) => `l${i}${"z".repeat(400)}`),
    files: Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, tail: "汉".repeat(3000) })),
    script: "脚".repeat(5000),
    extra: "dropped",
  }));
  assert.equal(s.source, "none");
  assert.equal(s.evidence.length, 20);
  assert.ok(s.evidence[0].startsWith("l10") && s.evidence[0].length === 300);
  assert.equal(s.files.length, 6);
  assert.ok(Buffer.byteLength(s.files[0].tail) <= STORED_TAIL_BYTES && !s.files[0].tail.includes("�"));
  assert.ok(Buffer.byteLength(s.script) <= STORED_SCRIPT_BYTES && !s.script.includes("�"));
  assert.equal("extra" in s, false);
  assert.deepEqual(Object.keys(s.files[0]).sort(), ["path", "tail"], "旧形状（没有角色 / 大小）照常入库");
  const typed = sanitizeDiagnosis(item("2", 1, { files: [{ path: "/a", tail: "", role: "stderr", size: 12 }, { path: "/b", tail: "", role: "evil", size: -1 }] }));
  assert.deepEqual(typed.files, [{ path: "/a", tail: "", role: "stderr", size: 12 }, { path: "/b", tail: "" }]);
  assert.equal(tailBytes("abc", 10), "abc");
  assert.equal(headBytes("汉字", 4), "汉");
});

test("保留 30 天、上限条数、字节预算都从最旧的删起；list 新 → 旧、按服务器与 since 过滤", async () => {
  const clock = 100 * DAY;
  const store = createDiagnosesStore({ now: () => clock, maxItems: 3 });
  await store.putMany([item("1", clock - 40 * DAY), item("2", clock - 3 * DAY), item("3", clock - 2 * DAY), item("4", clock - DAY), { ...item("5", clock), serverId: "s2" }]);
  assert.equal(store.has("s1", "1"), false, "超过 30 天");
  assert.equal(store.has("s1", "2"), false, "超过条数上限");
  assert.deepEqual(store.list("s1").map((i) => i.jobId), ["4", "3"]);
  assert.deepEqual(store.list("s1", { since: clock - 1.5 * DAY }).map((i) => i.jobId), ["4"]);
  assert.deepEqual(store.list("s2").map((i) => i.jobId), ["5"]);

  const small = createDiagnosesStore({ now: () => clock, maxBytes: 6000 });
  await small.putMany(Array.from({ length: 10 }, (_, i) => item(String(i + 1), clock - (10 - i) * 1000, { evidence: ["e".repeat(250)], files: [{ path: "/o", tail: "t".repeat(500) }] })));
  assert.ok(small.size() < 10 && small.size() > 0);
  assert.ok(small.has("s1", "10"), "留下最新的");
  assert.ok(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, items: small.list("s1") })) <= 6000);
  // get 返回副本
  const got = store.get("s1", "4");
  got.evidence.push("mutated");
  assert.deepEqual(store.get("s1", "4").evidence, ["a"]);
});

test("持久化：0600 原子写、重启读回；损坏文件当空表", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "job-diag-"));
  const file = path.join(dir, "runtime", "job-diagnoses.json");
  try {
    const a = createDiagnosesStore({ filePath: file, now: () => 10 * DAY });
    assert.equal(await a.putMany([item("7", 10 * DAY)]), 1);
    assert.equal(await a.putMany([{ bogus: true }]), 0, "全是坏条目不写盘");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const b = createDiagnosesStore({ filePath: file, now: () => 10 * DAY });
    await b.load();
    assert.equal(b.get("s1", "7").headline, "KeyError: 'arm'");
    writeFileSync(file, "garbage");
    const c = createDiagnosesStore({ filePath: file, now: () => 10 * DAY, log: () => {} });
    await c.load();
    assert.equal(c.size(), 0);
    await c.putMany([item("8", 10 * DAY)]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items.map((i) => i.jobId), ["8"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
