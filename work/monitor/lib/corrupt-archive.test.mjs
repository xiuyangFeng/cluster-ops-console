import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveCorruptFile,
  archiveCorruptFileSync,
  archiveNameFor,
  CORRUPT_EVENT,
  corruptArchiveKey,
  corruptStamp,
  isCorruptArchiveName,
  isParseFailure,
  staleArchives,
} from "./corrupt-archive.mjs";
import { inEveryTimeZone } from "./test-timezones.mjs";

const posix = process.platform !== "win32";
// 北京时间 2026-10-14 09:05:07 = UTC 01:05:07。
const T0 = Date.UTC(2026, 9, 14, 1, 5, 7);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("corruptStamp：北京时间，与本机时区无关；跨北京日界也对", async () => {
  await inEveryTimeZone(() => {
    assert.equal(corruptStamp(T0), "20261014-090507");
    assert.equal(corruptStamp(Date.UTC(2026, 9, 14, 16, 0, 0)), "20261015-000000");
  });
});

test("留档名：同一秒撞名加 -2、-3；排序键与识别", () => {
  assert.equal(archiveNameFor("job-watch.json", "20261014-090507"), "job-watch.json.corrupt-20261014-090507");
  assert.equal(archiveNameFor("a.json", "20261014-090507", ["a.json.corrupt-20261014-090507"]), "a.json.corrupt-20261014-090507-2");
  assert.equal(archiveNameFor("a.json", "20261014-090507", ["a.json.corrupt-20261014-090507", "a.json.corrupt-20261014-090507-2"]), "a.json.corrupt-20261014-090507-3");
  assert.ok(isCorruptArchiveName("metrics.json.corrupt-20261014-090507"));
  assert.ok(isCorruptArchiveName("2026-10-01.json.corrupt-20261014-090507-12"));
  assert.ok(!isCorruptArchiveName("metrics.json"));
  assert.ok(!isCorruptArchiveName("metrics.json.corrupt-2026"));
  assert.deepEqual(corruptArchiveKey("a.json.corrupt-20261014-090507-3"), ["20261014-090507", 3]);
  assert.deepEqual(corruptArchiveKey("a.json.corrupt-20261014-090507"), ["20261014-090507", 1]);
  assert.ok(isParseFailure(new SyntaxError("x")));
  assert.ok(!isParseFailure(Object.assign(new Error("x"), { code: "ENOENT" })));
});

test("staleArchives：只看这个文件自己的留档，保留最新 2 份，其余旧 → 新列出", () => {
  const names = [
    "a.json",
    "a.json.corrupt-20261012-100000",
    "a.json.corrupt-20261014-090507-2",
    "a.json.corrupt-20261014-090507",
    "a.json.corrupt-20261013-000000",
    "a.json.bak.corrupt-20261001-000000", // 别的文件的留档
    "a.json.corrupt-20261001-000000.tmp", // 不是留档
    "b.json.corrupt-20261001-000000",
  ];
  assert.deepEqual(staleArchives("a.json", names), ["a.json.corrupt-20261012-100000", "a.json.corrupt-20261013-000000"]);
  assert.deepEqual(staleArchives("a.json", names, 3), ["a.json.corrupt-20261012-100000"]);
  assert.deepEqual(staleArchives("b.json", names), []);
});

for (const [kind, archive] of [["异步", archiveCorruptFile], ["同步", archiveCorruptFileSync]]) {
  test(`${kind}：坏文件改名留档（0600）、同名留档最多 2 份、写一条 ops 警告，日志里没有文件内容`, async (t) => {
    const dir = tmpDir(t);
    const filePath = path.join(dir, "job-watch.json");
    const other = path.join(dir, "job-registry.json.corrupt-20200101-000000");
    fs.writeFileSync(other, "keep me");
    const logs = [];
    const log = (message, fields) => logs.push({ message, fields });
    let clock = T0;
    const now = () => clock;

    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(filePath, `{"secret":"tok-${i}"`, { mode: 0o644 });
      const result = await archive(filePath, { now, log, label: "作业关注" });
      assert.ok(result.archived, `第 ${i + 1} 次留档成功`);
      assert.equal(fs.existsSync(filePath), false, "原文件已经挪走，调用方按空表重建");
      assert.equal(fs.readFileSync(result.archived, "utf8"), `{"secret":"tok-${i}"`);
      if (posix) assert.equal(fs.statSync(result.archived).mode & 0o777, 0o600);
      clock += 1000;
    }
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      "job-registry.json.corrupt-20200101-000000",
      "job-watch.json.corrupt-20261014-090508",
      "job-watch.json.corrupt-20261014-090509",
    ]);
    assert.equal(logs.length, 3);
    for (const { message, fields } of logs) {
      assert.equal(fields.level, "warn");
      assert.equal(fields.event, CORRUPT_EVENT);
      assert.equal(fields.file, "job-watch.json");
      assert.match(message, /^作业关注（job-watch\.json）不是有效的 JSON，原文件已留档为 job-watch\.json\.corrupt-\d{8}-\d{6}，按空表重建$/);
      assert.doesNotMatch(message, /tok-/);
    }
    assert.equal(logs[2].fields.removed, 1);
  });

  test(`${kind}：同一秒坏两次不互相覆盖；文件已经不在时只记警告`, async (t) => {
    const dir = tmpDir(t);
    const filePath = path.join(dir, "metrics.json");
    const log = [];
    fs.writeFileSync(filePath, "{");
    const first = await archive(filePath, { now: () => T0, log: (_m, f) => log.push(f) });
    fs.writeFileSync(filePath, "[");
    const second = await archive(filePath, { now: () => T0, log: (_m, f) => log.push(f) });
    assert.equal(path.basename(first.archived), "metrics.json.corrupt-20261014-090507");
    assert.equal(path.basename(second.archived), "metrics.json.corrupt-20261014-090507-2");
    assert.equal(fs.readFileSync(first.archived, "utf8"), "{");

    const gone = await archive(path.join(dir, "missing.json"), { now: () => T0, log: (m, f) => log.push({ m, ...f }), action: "重新生成口令" });
    assert.equal(gone.archived, null);
    assert.equal(log.at(-1).error, "ENOENT");
    assert.match(log.at(-1).m, /missing\.json不是有效的 JSON，留档没有成功，重新生成口令/);
  });
}
