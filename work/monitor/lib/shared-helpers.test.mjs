import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as probeIds from "./probe-ids.mjs";
import { StatusError, statusError } from "./status-error.mjs";
import { writeFileAtomic, writePrivateFileAtomicSync } from "./atomic-file.mjs";

test("probe-ids: 构造与反解互逆，非本前缀返回 null", () => {
  assert.equal(probeIds.collectSlowProbeId("s1"), "collect:slow:s1");
  assert.equal(probeIds.validationProbeId("s1"), "validation:s1");
  assert.equal(probeIds.serverIdFromCollectSlow("collect:slow:s1"), "s1");
  assert.equal(probeIds.serverIdFromCollectSlow("collect:slow:"), null);
  assert.equal(probeIds.serverIdFromCollectSlow("validation:s1"), null);
  assert.equal(probeIds.serverIdFromValidation("validation:s2"), "s2");
  assert.equal(probeIds.boundServerIdOf("collect:slow:a"), "a");
  assert.equal(probeIds.boundServerIdOf("validation:b"), "b");
  assert.equal(probeIds.boundServerIdOf("log-signals"), null);
  assert.equal(probeIds.boundServerIdOf(undefined), null);
});

test("status-error: 子类保留类名与 status，extra 字段并入", () => {
  class RemoteThing extends StatusError {}
  const err = new RemoteThing(409, "冲突", { code: "busy" });
  assert.ok(err instanceof StatusError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "RemoteThing");
  assert.equal(err.status, 409);
  assert.equal(err.code, "busy");
  const plain = statusError("不存在", 404);
  assert.equal(plain.status, 404);
  assert.equal(plain.message, "不存在");
});

test("atomic-file: 0600 落盘、覆盖写、失败清理临时文件", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
  try {
    const target = path.join(dir, "nested", "secret.json");
    writePrivateFileAtomicSync(target, "a\n");
    writePrivateFileAtomicSync(target, "b\n");
    assert.equal(fs.readFileSync(target, "utf8"), "b\n");
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["secret.json"]);

    const failing = { ...fs, renameSync: () => { throw new Error("rename boom"); } };
    assert.throws(() => writePrivateFileAtomicSync(target, "c\n", { fs: failing }), /rename boom/);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["secret.json"], "失败后不残留 .tmp");
    assert.equal(fs.readFileSync(target, "utf8"), "b\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic-file: 异步版 0600 落盘、覆盖写、失败清理临时文件", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-async-"));
  try {
    const target = path.join(dir, "state.json");
    // 同一毫秒并发写同一目标：临时文件名不冲突，两次都成功。
    await Promise.all([
      writeFileAtomic(target, "a\n", { now: () => 1 }),
      writeFileAtomic(target, "b\n", { now: () => 1 }),
    ]);
    assert.match(fs.readFileSync(target, "utf8"), /^[ab]\n$/);
    await writeFileAtomic(target, "c\n");
    assert.equal(fs.readFileSync(target, "utf8"), "c\n");
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["state.json"]);

    const failing = { ...fs.promises, rename: async () => { throw new Error("rename boom"); } };
    await assert.rejects(writeFileAtomic(target, "d\n", { fs: failing }), /rename boom/);
    assert.deepEqual(fs.readdirSync(dir), ["state.json"], "失败后不残留 .tmp");
    assert.equal(fs.readFileSync(target, "utf8"), "c\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config-loader.selectMainServer / isServerEnabled: 跳过屏蔽条目，按 active → server-01 → 首条回落", async () => {
  const { selectMainServer, isServerEnabled } = await import("./config-loader.mjs");
  const merged = {
    activeServerId: "b",
    servers: [{ id: "server-01" }, { id: "b", disabled: true }, { id: "c" }],
  };
  assert.equal(selectMainServer(merged).id, "server-01", "active 被屏蔽时回落 server-01");
  assert.equal(selectMainServer({ ...merged, activeServerId: "c" }).id, "c");
  assert.equal(selectMainServer({ servers: [{ id: "x" }, { id: "y" }] }).id, "x");
  assert.equal(selectMainServer({ servers: [{ id: "x", disabled: true }] }), undefined);
  assert.equal(selectMainServer(undefined), undefined);
  assert.equal(isServerEnabled(merged, "c"), true);
  assert.equal(isServerEnabled(merged, "b"), false);
  assert.equal(isServerEnabled(merged, "nope"), false);
});
