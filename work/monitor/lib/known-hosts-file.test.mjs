import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendKnownHosts, KnownHostsWriteError, knownHostsLookupName } from "./known-hosts-file.mjs";

const posix = process.platform !== "win32";
const LINE_A = "box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAaaa";
const LINE_B = "box.example ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYbbb";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-known-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("文件不存在：建目录与文件（0600），写入给的行", (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, ".ssh", "known_hosts");
  assert.deepEqual(appendKnownHosts(filePath, [LINE_A, LINE_B]), { added: 2 });
  assert.equal(fs.readFileSync(filePath, "utf8"), `${LINE_A}\n${LINE_B}\n`);
  if (posix) {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  }
});

test("已有内容且末尾没有换行：先补一个换行再追加，原有内容一字不动", (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, "known_hosts");
  const original = "# 我自己的注释\nold.example ssh-rsa AAAAold";
  fs.writeFileSync(filePath, original, { mode: 0o644 });
  assert.deepEqual(appendKnownHosts(filePath, [LINE_A]), { added: 1 });
  assert.equal(fs.readFileSync(filePath, "utf8"), `${original}\n${LINE_A}\n`);
  if (posix) assert.equal(fs.statSync(filePath).mode & 0o777, 0o644, "已有文件的权限不改");
});

test("去重：文件里已有的不再写（含首尾空白与 CRLF），这次给的行里重复的只写一次", (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, "known_hosts");
  fs.writeFileSync(filePath, `  ${LINE_A}  \r\n`);
  assert.deepEqual(appendKnownHosts(filePath, [LINE_A, LINE_B, ` ${LINE_B}`, "", null]), { added: 1 });
  assert.equal(fs.readFileSync(filePath, "utf8"), `  ${LINE_A}  \r\n${LINE_B}\n`);
  // 全都已有：一个字节都不写（不碰 mtime 之外的任何东西，也不调用追加）。
  let appended = 0;
  assert.deepEqual(appendKnownHosts(filePath, [LINE_A, LINE_B], { appendFileSync: () => { appended += 1; } }), { added: 0 });
  assert.equal(appended, 0);
});

test("读出错（EACCES 等，不是 ENOENT）：抛出且不写——不再当空文件把原有内容盖掉", () => {
  const calls = [];
  const deny = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const io = {
    readFileSync: () => { throw deny; },
    appendFileSync: (...args) => calls.push(["append", ...args]),
    mkdirSync: (...args) => calls.push(["mkdir", ...args]),
  };
  assert.throws(() => appendKnownHosts("/home/u/.ssh/known_hosts", [LINE_A], io), (error) => {
    assert.ok(error instanceof KnownHostsWriteError);
    assert.equal(error.code, "known-hosts-unreadable");
    assert.equal(error.errno, "EACCES");
    assert.equal(error.cause, deny);
    assert.match(error.message, /读不出 \/home\/u\/\.ssh\/known_hosts（EACCES），为免覆盖原有内容，没有写入/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test("真实的读错误（known_hosts 是个目录）同样不写", { skip: !posix }, (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, "known_hosts");
  fs.mkdirSync(filePath);
  assert.throws(() => appendKnownHosts(filePath, [LINE_A]), /known-hosts|读不出/);
  assert.ok(fs.statSync(filePath).isDirectory());
  assert.deepEqual(fs.readdirSync(filePath), []);
});

test("写不进去：抛出 known-hosts-write-failed，带原始错误码", () => {
  const io = {
    readFileSync: () => `${LINE_A}\n`,
    appendFileSync: () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); },
    mkdirSync: () => {},
  };
  assert.throws(() => appendKnownHosts("/x/known_hosts", [LINE_B], io), (error) => error.code === "known-hosts-write-failed" && error.errno === "EROFS" && /写不进 \/x\/known_hosts（EROFS）/.test(error.message));
});

test("软链接：追加写进它指向的文件，链接本身还是链接", { skip: !posix }, (t) => {
  const dir = tmpDir(t);
  const target = path.join(dir, "dotfiles", "known_hosts");
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, `${LINE_A}\n`, { mode: 0o600 });
  const link = path.join(dir, "ssh", "known_hosts");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(target, link);
  assert.deepEqual(appendKnownHosts(link, [LINE_A, LINE_B]), { added: 1 });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "链接没有被一个普通文件替换掉");
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.readFileSync(target, "utf8"), `${LINE_A}\n${LINE_B}\n`);
});

test("knownHostsLookupName：22 端口记主机名，其余记 [host]:port", () => {
  assert.equal(knownHostsLookupName("h", 22), "h");
  assert.equal(knownHostsLookupName("h", null), "h");
  assert.equal(knownHostsLookupName("h", 2222), "[h]:2222");
});
