// v2.51 日志按段向前读取：路径只来自本机登记 / 诊断记录、与已显示末尾衔接、游标身份校验、缓存 / 合并 / 限流 / 槽位。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDiagnosesStore } from "./diagnoses-store.mjs";
import { createLogReadbackService, parseSegmentQuery, READBACK_INFLIGHT_MAX, sizeFromFingerprint } from "./log-readback.mjs";
import { SEGMENT_REMOTE_COMMAND, textSignature } from "./log-segment.mjs";
import { createJobRegistry } from "./registry.mjs";
import { createJobWatchStore } from "./watch-store.mjs";

const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const pyTest = PYTHON && process.platform !== "win32" ? test : test.skip;
const CONFIG = { servers: [{ id: "server-01", host: "myserver" }, { id: "server-me", host: "mine", source: "personal" }] };
const NOW = 1791014400000;
const q = (o) => parseSegmentQuery(new URLSearchParams(o));

// 本机 python3 充当远端：真跑 remote/log-segment.py。
async function localRemote(invocation) {
  const bootstrap = SEGMENT_REMOTE_COMMAND.slice("python3 -c '".length, -1);
  const res = spawnSync(PYTHON, ["-c", bootstrap], { input: invocation.input, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function harness({ exec = localRemote, config = CONFIG, registryEntries = [], diagnosis = null, watchJobs = [] } = {}) {
  const registry = createJobRegistry({ now: () => NOW });
  if (registryEntries.length) {
    await registry.observe("server-01", { user: "kai", total: registryEntries.length, complete: true, entries: registryEntries, badLines: 0 });
  }
  const diagnoses = createDiagnosesStore({ now: () => NOW });
  if (diagnosis) await diagnoses.putMany([diagnosis]);
  const watchStore = createJobWatchStore({ now: () => NOW });
  if (watchJobs.length) {
    await watchStore.update((d) => {
      d.watches.push({ id: "w1", serverId: "server-01", label: "x", muted: false, createdAt: NOW, jobs: watchJobs });
    });
  }
  const calls = [];
  const service = createLogReadbackService({
    registry,
    diagnoses,
    watchStore,
    getConfig: async () => config,
    execCollector: async (invocation, server) => {
      calls.push({ payload: JSON.parse(invocation.input.split("\n")[1]), host: server.host });
      return exec(invocation);
    },
    now: () => NOW,
  });
  return { service, calls, registry };
}

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "log-readback-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const regEntry = (dir, extra = {}) => ({ jobId: "18765", arrayJobId: "18765", arrayTaskId: null, name: "xp", workDir: dir, stdout: "logs/xp_%j.log", stderr: "logs/xp_%j.err", command: null, ...extra });

test("参数校验：作业号 / 入口 / 流 / 游标逐项严格，游标字段要么齐全要么没有", () => {
  assert.deepEqual(q({ jobId: "18765", from: "watch", log: "stdout" }), { jobId: "18765", from: "watch", log: "stdout", cursor: null, fresh: false });
  assert.equal(q({ jobId: "1_2", from: "diagnosis", log: "3", fresh: "1" }).fresh, true);
  const cursor = q({ jobId: "1", from: "watch", log: "stderr", before: "10", ino: "99", size: "20", mtimeMs: "5", sig: `3-${"f".repeat(40)}` }).cursor;
  assert.deepEqual(cursor, { before: 10, ino: "99", size: 20, mtimeMs: 5, sig: `3-${"f".repeat(40)}` });
  const bad = [
    { jobId: "1;ls", from: "watch", log: "stdout" },
    { jobId: "1", from: "other", log: "stdout" },
    { jobId: "1", from: "watch", log: "0" },
    { jobId: "1", from: "diagnosis", log: "stdout" },
    { jobId: "1", from: "diagnosis", log: "6" },
    { jobId: "1", from: "watch", log: "stdout", ino: "1" },
    { jobId: "1", from: "watch", log: "stdout", before: "0", ino: "1", size: "5" },
    { jobId: "1", from: "watch", log: "stdout", before: "9", ino: "1", size: "5" },
    { jobId: "1", from: "watch", log: "stdout", before: "3", ino: "x", size: "5" },
    { jobId: "1", from: "watch", log: "stdout", before: "3", ino: "1", size: "5", sig: "zz" },
    { jobId: "1", from: "watch", log: "stdout", before: "3", ino: "1", size: "5", fresh: "1" },
    { jobId: "1", from: "watch", log: "stdout", path: "/etc/passwd", fresh: "yes" },
  ];
  for (const params of bad) assert.throws(() => q(params), (err) => err.status === 400, JSON.stringify(params));
});

test("进度指纹里取文件大小：按整段路径定位，路径本身含 : 与 | 也不串", () => {
  const fp = "/a/x:1.log:120:1791000000.5|/b/o|k.log:3456:1791000001";
  assert.equal(sizeFromFingerprint(fp, "/a/x:1.log"), 120);
  assert.equal(sizeFromFingerprint(fp, "/b/o|k.log"), 3456);
  assert.equal(sizeFromFingerprint(fp, "/k.log"), null);
  assert.equal(sizeFromFingerprint("/a:null:null", "/a"), null);
});

pyTest("关注入口：路径由本机登记表展开；与「进度依据」同一文件时从那段末尾的起点往前接", async () => {
  await withDir(async (dir) => {
    const lines = Array.from({ length: 3000 }, (_, i) => `step ${i} loss ${(i / 7).toFixed(3)}`);
    const body = `${lines.join("\n")}\n`;
    const logs = path.join(dir, "logs");
    mkdirSync(logs);
    const out = path.join(logs, "xp_18765.log");
    writeFileSync(out, body);
    writeFileSync(path.join(logs, "xp_18765.err"), "warn: a\nwarn: b\n");
    const size = Buffer.byteLength(body);
    const tail = body.slice(-2048);
    const progress = { status: "ok", checkedAt: NOW - 60_000, path: out, tail, fingerprint: `${out}:${size}:1791000000.25`, unchangedSince: NOW };
    const { service, calls } = await harness({ registryEntries: [regEntry(dir)], watchJobs: [{ id: "18765", name: "xp", state: "RUNNING", progress }] });

    const first = await service.read("server-01", q({ jobId: "18765", from: "watch", log: "stdout" }));
    assert.equal(calls[0].host, "myserver");
    assert.deepEqual(calls[0].payload.expect, { size, sig: textSignature(tail) });
    assert.equal(first.end, size - Buffer.byteLength(tail), "区间右端 = 已显示末尾的起点");
    assert.equal(first.text + tail, body.slice(first.start), "与已显示末尾逐字节衔接");
    assert.deepEqual([first.continuous, first.anchorCheckedAt, first.anchorText, first.role, first.path], [true, NOW - 60_000, null, "stdout", out]);
    assert.ok(first.dropped > 0 && first.next.before === first.start);

    const second = await service.read("server-01", q({ jobId: "18765", from: "watch", log: "stdout", ...Object.fromEntries(Object.entries(first.next).map(([k, v]) => [k, String(v)])) }));
    assert.equal(second.end, first.start);
    assert.equal(second.text + first.text, body.slice(second.start, first.end));
    assert.equal(second.notes.length, 0);

    // stderr 不是「进度依据」显示的文件：从当前末尾读起，标明不衔接。
    const err = await service.read("server-01", q({ jobId: "18765", from: "watch", log: "stderr" }));
    assert.deepEqual([err.text, err.atStart, err.next, err.continuous], ["warn: a\nwarn: b\n", true, null, false]);
  });
});

pyTest("诊断入口：按记录里的文件序号读，带回取证时保存的末尾；旧记录没有大小时按当前末尾对齐并说明", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "train_9.log");
    const body = `${Array.from({ length: 5000 }, (_, i) => `epoch ${i}`).join("\n")}\nKeyError: 'arm'\n`;
    writeFileSync(file, body);
    const size = Buffer.byteLength(body);
    const tail = body.slice(-4096);
    const base = { jobId: "9", serverId: "server-01", category: "python", headline: "KeyError", state: "FAILED" };
    {
      const { service, calls } = await harness({ diagnosis: { ...base, files: [{ path: file, role: "stdout", size, tail }] } });
      const seg = await service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }));
      assert.deepEqual(calls[0].payload.expect, { size, sig: textSignature(tail) });
      assert.equal(seg.text + seg.anchorText, body.slice(seg.start));
      assert.deepEqual([seg.role, seg.continuous, seg.notes], ["stdout", true, []]);
      await assert.rejects(service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "1" })), (e) => e.status === 404);
      await assert.rejects(service.read("server-01", q({ jobId: "8", from: "diagnosis", log: "0" })), (e) => e.status === 404);
    }
    {
      const { service, calls } = await harness({ diagnosis: { ...base, files: [{ path: file, tail }] } });
      const seg = await service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }));
      assert.deepEqual(calls[0].payload.skip, Buffer.byteLength(tail));
      assert.equal(seg.text + seg.anchorText, body.slice(seg.start));
      assert.equal(seg.role, null);
      assert.match(seg.notes[0], /没有记下取证时的文件大小/);
    }
  });
});

pyTest("游标失效：日志被删除 / 截断后返回 409 + code，不拿旧游标读新文件；fresh 可从当前末尾重读", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "o.log");
    writeFileSync(file, "line\n".repeat(20000));
    const base = { jobId: "9", serverId: "server-01", category: "unknown", headline: "?", state: "FAILED" };
    const { service } = await harness({ diagnosis: { ...base, files: [{ path: file, role: "stdout", size: 100000, tail: "line\n" }] } });
    const first = await service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }));
    const cursor = Object.fromEntries(Object.entries(first.next).map(([k, v]) => [k, String(v)]));
    writeFileSync(file, "new\n");
    await assert.rejects(service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0", ...cursor })), (e) => e.status === 409 && e.code === "truncated");
    const fresh = await service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0", fresh: "1" }));
    assert.deepEqual([fresh.text, fresh.continuous, fresh.anchorText], ["new\n", false, null]);
    rmSync(file);
    await assert.rejects(service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0", fresh: "1" })), (e) => e.status === 409 && e.code === "missing");
  });
});

test("关注入口的授权：只读关注中的作业、只读登记表里本人作业的路径；数组子作业用实际编号展开 %j", async () => {
  const seen = [];
  const exec = async (inv) => {
    seen.push(JSON.parse(inv.input.split("\n")[1]).path);
    return { code: 0, stdout: JSON.stringify({ k: "seg", start: 0, end: 2, dropped: 0, size: 2, ino: "1", mt: 1, t: "ok" }) };
  };
  const entries = [
    { jobId: "18784", arrayJobId: "18781", arrayTaskId: "2", name: "arr", workDir: "/w", stdout: "/w/xp_%j.log", stderr: null, command: null },
    { jobId: "18790", arrayJobId: "18790", arrayTaskId: null, name: "pending", workDir: "/w", stdout: "/w/p_%j.log", stderr: null, command: null },
  ];
  const { service } = await harness({ exec, registryEntries: entries, watchJobs: [{ id: "18781_2", state: "RUNNING" }, { id: "18799", state: "RUNNING" }] });
  await service.read("server-01", q({ jobId: "18781_2", from: "watch", log: "stdout" }));
  assert.deepEqual(seen, ["/w/xp_18784.log"]);
  await assert.rejects(service.read("server-01", q({ jobId: "18790", from: "watch", log: "stdout" })), (e) => e.status === 404, "登记了但没关注：拒绝");
  await assert.rejects(service.read("server-01", q({ jobId: "18799", from: "watch", log: "stdout" })), (e) => e.status === 409, "关注了但没登记：拒绝");
  await assert.rejects(service.read("server-me", q({ jobId: "18781_2", from: "watch", log: "stdout" })), (e) => e.status === 404, "个人服务器不在采集范围");
  const off = await harness({ exec, config: { ...CONFIG, modules: { jobs: false } } });
  await assert.rejects(off.service.read("server-01", q({ jobId: "1", from: "watch", log: "stdout" })), (e) => e.status === 409);
  assert.equal(seen.length, 1, "被拒的请求不发 SSH");
});

test("成本：同一片段在途合并、短期缓存命中不再发 SSH；不同片段同时在读有上限；占用调度器槽位并释放", async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const exec = async (inv) => {
    runs += 1;
    const end = JSON.parse(inv.input.split("\n")[1]).end ?? 50;
    await gate;
    return { code: 0, stdout: JSON.stringify({ k: "seg", start: Math.max(0, end - 10), end, dropped: 0, size: 50, ino: "1", mt: 1, t: "x".repeat(Math.min(10, end)) }) };
  };
  const files = [{ path: "/w/a.log", role: "stdout", size: 50, tail: "" }, { path: "/w/b.log", role: "stderr", size: 50, tail: "" }, { path: "/w/c.log", role: "sibling", size: 50, tail: "" }];
  const { service } = await harness({ exec, diagnosis: { jobId: "9", serverId: "server-01", category: "unknown", headline: "?", state: "FAILED", files } });
  const slots = [];
  const acquireSshSlot = async (opts) => { slots.push(opts.hostKey); return () => slots.push("released"); };
  const a1 = service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }), { acquireSshSlot });
  const a2 = service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }), { acquireSshSlot });
  const b = service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "1" }), { acquireSshSlot });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(READBACK_INFLIGHT_MAX, 2);
  await assert.rejects(service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "2" })), (e) => e.status === 429);
  release();
  const [r1, r2] = await Promise.all([a1, a2, b]);
  assert.equal(runs, 2, "两个相同请求只发一次");
  assert.deepEqual([r1.text, r2.text], ["x".repeat(10), "x".repeat(10)]);
  assert.deepEqual(slots, ["myserver", "myserver", "released", "released"]);
  const again = await service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" }));
  assert.deepEqual([again.cached, runs], [true, 2], "缓存命中");
});

test("SSH 失败（没有可认的输出）→ 502，不缓存", async () => {
  let runs = 0;
  const exec = async () => { runs += 1; return { code: 255, stdout: "", stderr: "Connection timed out" }; };
  const { service } = await harness({ exec, diagnosis: { jobId: "9", serverId: "server-01", category: "unknown", headline: "?", state: "FAILED", files: [{ path: "/w/a.log", tail: "" }] } });
  for (let i = 0; i < 2; i += 1) await assert.rejects(service.read("server-01", q({ jobId: "9", from: "diagnosis", log: "0" })), (e) => e.status === 502 && e.code === "ssh");
  assert.equal(runs, 2);
});
