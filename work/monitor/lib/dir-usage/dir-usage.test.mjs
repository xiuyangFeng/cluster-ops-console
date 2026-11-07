import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildDirUsageView, mergeDirUsageRun, parentRel, rootLabel } from "./model.mjs";
import {
  buildDirUsageInvocation, DIR_USAGE_MAX_ENTRIES, DIR_USAGE_MAX_SEC, DIR_USAGE_REMOTE_COMMAND,
  DIR_USAGE_SCRIPT_PATH, isValidRelPath, parseDirUsageOutput,
} from "./scan.mjs";
import { createDirUsageService, DIR_USAGE_AUTO_GAP_MS, DIR_USAGE_AUTO_MAX_MS, isDirUsageEligible } from "./service.mjs";
import { createDirUsageStore, DIR_USAGE_MAX_ROOTS_PER_SERVER } from "./store.mjs";

const NOW = Date.UTC(2026, 9, 6, 6, 0);
const end = (over = {}) => JSON.stringify({
  k: "end", v: 1, home: "/public/newhome/cy", root: "", complete: false, stop: "entries",
  entries: 20000, dirsDone: 120, denied: 1, errors: 0, otherFs: 0, otherFsNames: [], dropped: 0, hardlinks: 0, sec: 2.7,
  agg1: { Digital_twin: [4000, 3900, 100, 10], ".cache": [700, 690, 50, 5] },
  agg1Over: [0, 0, 0, 0],
  agg2: { "Digital_twin/GNN": [3000, 2950, 80, 3] },
  rootFiles: [500, 480, 3],
  top: [[2000, "Digital_twin/GNN/ckpt.pt", 1990, 1790000000]],
  pending: [["Digital_twin/GNN/runs", 37], ["Digital_twin/data", 0]],
  ...over,
});

test("相对路径校验：拒绝 .. / 绝对路径 / 空段 / NUL", () => {
  for (const ok of ["", "a", "a/b", ".cache", "数据 集/x"]) assert.equal(isValidRelPath(ok), true, ok);
  for (const bad of ["/etc", "..", "a/../b", "a//b", "a/", "./a", "a\0b", 5, null]) assert.equal(isValidRelPath(bad), false, String(bad));
  assert.equal(isValidRelPath("x".repeat(20), 10), false);
});

test("调用组装：远端命令是常量，扫描根 / 游标 / 预算只走 stdin", () => {
  const inv = buildDirUsageInvocation({ server: { id: "s1", host: "myserver" }, parsed: {}, root: "Digital_twin", pending: [["a", 3]], platform: "darwin" });
  assert.equal(inv.args.at(-1), DIR_USAGE_REMOTE_COMMAND);
  assert.ok(!inv.args.join(" ").includes("Digital_twin"));
  const [script, payload] = inv.input.split("\n");
  assert.equal(JSON.parse(script), readFileSync(DIR_USAGE_SCRIPT_PATH, "utf8"));
  assert.deepEqual(JSON.parse(payload), { root: "Digital_twin", maxEntries: DIR_USAGE_MAX_ENTRIES, maxSec: DIR_USAGE_MAX_SEC, pending: [["a", 3]] });
  assert.ok(DIR_USAGE_MAX_ENTRIES <= 20000 && DIR_USAGE_MAX_SEC <= 8);
  assert.equal("pending" in JSON.parse(buildDirUsageInvocation({ server: { host: "h" }, platform: "darwin" }).input.split("\n")[1]), false);
});

test("输出解析：远端输出当不可信数据——根不符 / 坏游标整轮作废，坏字段丢弃", () => {
  const ok = parseDirUsageOutput(`noise\n${end()}`, { expectRoot: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.run.complete, false);
  assert.deepEqual(ok.run.pending, [["Digital_twin/GNN/runs", 37], ["Digital_twin/data", 0]]);
  assert.equal(ok.run.top[0].path, "Digital_twin/GNN/ckpt.pt");
  assert.equal(parseDirUsageOutput(end(), { expectRoot: "other" }).ok, false);
  assert.equal(parseDirUsageOutput(end({ pending: [["../etc", 0]] })).ok, false);
  assert.equal(parseDirUsageOutput(end({ pending: [["a", -1]] })).ok, false);
  assert.equal(parseDirUsageOutput(end({ home: "relative" })).ok, false);
  assert.equal(parseDirUsageOutput("").code, "no-output");
  assert.equal(parseDirUsageOutput("{bad").code, "bad-output");
  assert.equal(parseDirUsageOutput(JSON.stringify({ k: "err", code: "outside-home" })).code, "outside-home");
  assert.equal(parseDirUsageOutput(JSON.stringify({ k: "err", code: "<script>" })).code, "remote-error");
  const dirty = parseDirUsageOutput(end({
    agg1: { "a/b": [1, 1, 1, 1], "..": [1, 1, 1, 1], good: [1, 2, 3, 4], neg: [-1, 0, 0, 0], short: [1, 2] },
    agg2: { single: [1, 1, 1, 1], "x/y": [5, 5, 0, 0] },
    top: [[1, "/abs", 1, 1], [9, "ok.bin", 9, "bad"]],
    complete: true,
  }));
  assert.deepEqual(Object.keys(dirty.run.agg1), ["good"]);
  assert.deepEqual(Object.keys(dirty.run.agg2), ["x/y"]);
  assert.deepEqual(dirty.run.top, [{ path: "ok.bin", blocks: 9, size: 9, mtime: null }]);
  // complete 声称扫完但游标不空 → 按未扫完处理
  assert.equal(dirty.run.complete, false);
});

test("累加：同一扫描根逐轮相加，换根或重新扫描从零开始；大文件按路径去重保留最大", () => {
  const r1 = parseDirUsageOutput(end()).run;
  const a = mergeDirUsageRun(null, r1, { now: NOW });
  const r2 = parseDirUsageOutput(end({
    complete: true, stop: "done", entries: 500, dirsDone: 40, denied: 0,
    agg1: { Digital_twin: [1000, 1000, 20, 1], fresh: [10, 10, 1, 0] },
    agg2: { "Digital_twin/GNN": [900, 900, 10, 0] },
    rootFiles: [0, 0, 0],
    top: [[2500, "Digital_twin/GNN/ckpt.pt", 2500, 1790000001], [100, "fresh/a", 100, 1]],
    pending: [],
  })).run;
  const b = mergeDirUsageRun(a, r2, { now: NOW + 1000 });
  assert.equal(b.runs, 2);
  assert.equal(b.entries, 20500);
  assert.equal(b.complete, true);
  assert.deepEqual(b.agg1.Digital_twin, [5000, 4900, 120, 11]);
  assert.deepEqual(b.agg2["Digital_twin/GNN"], [3900, 3850, 90, 3]);
  assert.equal(b.top.length, 2);
  assert.equal(b.top[0].blocks, 2500);
  assert.equal(b.startedAt, NOW);
  assert.equal(a.runs, 1, "累加不改写上一轮的记录");
  const other = mergeDirUsageRun(b, { ...r2, root: "Digital_twin" }, { now: NOW });
  assert.equal(other.runs, 1);
  assert.equal(other.entries, 500);
});

test("视图：还没轮到的一级目录标 queued（游标里只有它自己、一条没处理过），扫到一半的不标", () => {
  const run = parseDirUsageOutput(end({
    agg1: { a: [4096, 0, 0, 0], b: [9000, 8000, 3, 1], c: [5000, 4000, 2, 0], d: [7000, 6000, 4, 0] },
    agg2: {},
    pending: [["a", 0], ["b/x", 0], ["c", 5]],
  })).run;
  const byName = Object.fromEntries(buildDirUsageView(mergeDirUsageRun(null, run, { now: NOW })).children.map((c) => [c.name, [c.partial, c.queued]]));
  assert.deepEqual(byName, { a: [true, true], b: [true, false], c: [true, false], d: [false, false] });
});

test("视图：未扫完的项标 partial，第二层只列最大的几项、其余 = 父目录 − 已列出", () => {
  const view = buildDirUsageView(mergeDirUsageRun(null, parseDirUsageOutput(end()).run, { now: NOW }));
  assert.equal(view.label, "~");
  assert.equal(view.parent, null);
  assert.equal(view.complete, false);
  assert.equal(view.scanned.entries, 20000);
  assert.equal(view.scanned.pendingDirs, 2);
  assert.deepEqual(view.children.map((c) => [c.name, c.partial]), [["Digital_twin", true], [".cache", false]]);
  const dt = view.children[0];
  assert.equal(dt.sub[0].rel, "Digital_twin/GNN");
  assert.equal(dt.subRest.blocks, 1000);
  assert.deepEqual(view.totals, { blocks: 5200, size: 5070, files: 153, dirs: 17 });
  assert.equal(view.topFiles[0].rel, "Digital_twin/GNN/ckpt.pt");
  assert.equal(view.knownCaches[0].rel, ".cache");
  const detailedCache = buildDirUsageView(mergeDirUsageRun(null, parseDirUsageOutput(end({
    agg1: { ".cache": [700, 690, 50, 5], ".conda": [900, 880, 65000, 10] },
    agg2: { ".cache/huggingface": [600, 590, 30, 3], ".cache/pip": [100, 100, 20, 2] },
  })).run, { now: NOW }));
  assert.deepEqual(detailedCache.knownCaches.map((c) => c.rel), [".conda", ".cache/huggingface", ".cache/pip"]);
  assert.equal(detailedCache.knownCaches[0].cleanCmd, "conda clean -a -y");
  assert.equal(detailedCache.knownCaches[0].highFileDensity, true);
  assert.equal(detailedCache.knownCaches[1].cleanCmd, "huggingface-cli delete-cache");
  assert.equal(detailedCache.knownCaches[1].highFileDensity, false);
  assert.equal(detailedCache.children.find((c) => c.name === ".conda").highFileDensity, true);
  assert.equal(rootLabel("a/b"), "~/a/b");
  assert.equal(parentRel("a/b"), "a");
  assert.equal(parentRel("a"), "");
  assert.equal(buildDirUsageView(null), null);
});

test("存储：0600 原子写、每台服务器最多保留 6 个扫描根、重启后可读回", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dir-usage-store-"));
  try {
    const file = path.join(dir, "rt", "dir-usage.json");
    const store = createDirUsageStore({ filePath: file });
    const run = parseDirUsageOutput(end()).run;
    for (let i = 0; i < DIR_USAGE_MAX_ROOTS_PER_SERVER + 2; i += 1) {
      await store.put("s1", mergeDirUsageRun(null, { ...run, root: `d${i}` }, { now: NOW + i }));
    }
    const list = await store.list("s1");
    assert.equal(list.length, DIR_USAGE_MAX_ROOTS_PER_SERVER);
    assert.equal(list[0].root, `d${DIR_USAGE_MAX_ROOTS_PER_SERVER + 1}`);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const reopened = createDirUsageStore({ filePath: file });
    assert.equal((await reopened.get("s1", "d7")).root, "d7");
    assert.equal(await reopened.get("s1", "d0"), null);
    writeFileSync(file, "{broken");
    assert.deepEqual(await createDirUsageStore({ filePath: file }).list("s1"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeService({ exec, config, ...extra }) {
  const store = createDirUsageStore();
  const slots = [];
  const service = createDirUsageService({
    store,
    getConfig: async () => config,
    dataDir: os.tmpdir(),
    execCollector: exec,
    probeSshFailureReason: (code) => `ssh exit ${code}`,
    now: () => NOW,
    ...extra,
  });
  const acquireSshSlot = async (opts) => {
    slots.push(opts);
    return () => slots.push("release");
  };
  return { service, store, slots, acquireSshSlot };
}

const CONFIG = { servers: [{ id: "s1", host: "myserver", source: "team" }, { id: "me", host: "box", source: "personal" }] };

test("服务：只对团队服务器开放；扫描占全局 SSH 槽位并释放；续扫带回游标", async () => {
  assert.equal(isDirUsageEligible(CONFIG.servers[1]), false);
  const inputs = [];
  const outputs = [end(), end({ complete: true, stop: "done", pending: [] })];
  const { service, slots, acquireSshSlot } = makeService({
    config: CONFIG,
    exec: async (inv) => { inputs.push(JSON.parse(inv.input.split("\n")[1])); return { code: 0, stdout: outputs.shift(), stderr: "" }; },
  });
  assert.deepEqual(await service.get("me"), { eligible: false, serverId: "me" });
  await assert.rejects(service.scan("me", {}, { acquireSshSlot }), { status: 404 });
  assert.equal((await service.get("s1")).scan, null);
  await assert.rejects(service.scan("s1", { mode: "continue" }, { acquireSshSlot }), { status: 409 });
  const first = await service.scan("s1", { root: "" }, { acquireSshSlot });
  assert.equal(first.scan.complete, false);
  assert.deepEqual(slots, [{ hostKey: "myserver" }, "release"]);
  const second = await service.scan("s1", { root: "", mode: "continue" }, { acquireSshSlot });
  assert.deepEqual(inputs[1].pending, [["Digital_twin/GNN/runs", 37], ["Digital_twin/data", 0]]);
  assert.equal(inputs[0].pending, undefined);
  assert.equal(second.scan.complete, true);
  assert.equal(second.scan.runs, 2);
  assert.equal((await service.get("s1")).scan.runs, 2);
  await assert.rejects(service.scan("s1", { root: "../x" }, { acquireSshSlot }), { status: 400 });
  await assert.rejects(service.scan("s1", { root: "" }, {}), { status: 503 });
});

test("服务：远端拒绝 / SSH 失败不动已存结果；同一台同时只允许一轮", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const queue = [
    async () => ({ code: 0, stdout: end(), stderr: "" }),
    async () => ({ code: 0, stdout: JSON.stringify({ k: "err", code: "outside-home" }), stderr: "" }),
    async () => ({ code: 255, stdout: "", stderr: "Connection refused" }),
    async () => { await gate; return { code: 0, stdout: end(), stderr: "" }; },
  ];
  const { service, acquireSshSlot } = makeService({ config: CONFIG, exec: () => queue.shift()() });
  await service.scan("s1", {}, { acquireSshSlot });
  await assert.rejects(service.scan("s1", { mode: "continue" }, { acquireSshSlot }), /不在 \$HOME 内/);
  await assert.rejects(service.scan("s1", { mode: "continue" }, { acquireSshSlot }), { status: 502 });
  const view = await service.get("s1");
  assert.equal(view.scan.runs, 1);
  const slow = service.scan("s1", { mode: "continue" }, { acquireSshSlot });
  await new Promise((r) => setImmediate(r));
  assert.equal((await service.get("s1")).running, true);
  await assert.rejects(service.scan("s1", {}, { acquireSshSlot }), { status: 409 });
  release();
  assert.equal((await slow).scan.runs, 2);
});

const settle = async (service, serverId = "s1") => {
  for (let i = 0; i < 200; i += 1) {
    const view = await service.get(serverId);
    if (!view.auto?.running) return view;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("auto scan did not settle");
};

test("自动续扫：点一次，一轮接一轮扫到完成；每轮各占一次 SSH 槽位，轮间歇一会儿；期间不能再开一轮", async () => {
  const outputs = [end(), end(), end({ complete: true, stop: "done", pending: [] })];
  const inputs = [];
  const sleeps = [];
  let hold = null;
  const { service, slots, acquireSshSlot } = makeService({
    config: CONFIG,
    exec: async (inv) => {
      inputs.push(JSON.parse(inv.input.split("\n")[1]));
      if (hold) await hold;
      return { code: 0, stdout: outputs.shift(), stderr: "" };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await assert.rejects(service.startAuto("me", {}, { acquireSshSlot }), { status: 404 });
  await assert.rejects(service.startAuto("s1", { mode: "continue" }, { acquireSshSlot }), { status: 409 }, "没有可继续的扫描");
  await assert.rejects(service.startAuto("s1", {}, {}), { status: 503 });
  assert.equal((await service.get("s1")).auto, null);

  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const started = await service.startAuto("s1", { root: "" }, { acquireSshSlot });
  assert.deepEqual([started.auto.running, started.auto.rounds, started.auto.root], [true, 0, ""], "立刻返回，扫描在后台");
  await assert.rejects(service.startAuto("s1", { root: "" }, { acquireSshSlot }), { status: 409 });
  await assert.rejects(service.scan("s1", { root: "" }, { acquireSshSlot }), { status: 409 });
  hold = null;
  release();

  const done = await settle(service);
  assert.deepEqual([done.auto.running, done.auto.reason, done.auto.rounds, done.auto.error], [false, "done", 3, null]);
  assert.deepEqual([done.scan.complete, done.scan.runs, done.scan.scanned.entries], [true, 3, 60000]);
  assert.deepEqual(sleeps, [DIR_USAGE_AUTO_GAP_MS, DIR_USAGE_AUTO_GAP_MS]);
  assert.equal(inputs[0].pending, undefined);
  assert.deepEqual(inputs[1].pending, [["Digital_twin/GNN/runs", 37], ["Digital_twin/data", 0]], "第二轮起带着上一轮的游标");
  assert.deepEqual(slots, [{ hostKey: "myserver" }, "release", { hostKey: "myserver" }, "release", { hostKey: "myserver" }, "release"]);
});

test("自动续扫：停止 = 这一轮做完并入库后不再发下一轮；中途失败停下并记原因，已扫到的留着、可以接着扫；到时长上限先停", async () => {
  // 停止
  let release;
  const calls = [];
  const stopping = makeService({
    config: CONFIG,
    exec: async () => { calls.push(1); await new Promise((resolve) => { release = resolve; }); return { code: 0, stdout: end(), stderr: "" }; },
    sleep: async () => {},
  });
  await stopping.service.startAuto("s1", {}, { acquireSshSlot: stopping.acquireSshSlot });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await stopping.service.stopAuto("s1")).auto.stopping, true);
  release();
  const stopped = await settle(stopping.service);
  assert.deepEqual([stopped.auto.reason, stopped.auto.rounds, stopped.auto.stopping, stopped.scan.runs, calls.length], ["stopped", 1, false, 1, 1]);
  assert.equal((await stopping.service.stopAuto("s1")).auto.running, false, "没在扫时停止是空操作");

  // 中途失败
  const outputs = [{ code: 0, stdout: end(), stderr: "" }, { code: 255, stdout: "", stderr: "ssh: connect to host: Operation timed out" }, { code: 0, stdout: end({ complete: true, stop: "done", pending: [] }), stderr: "" }];
  const failing = makeService({ config: CONFIG, exec: async () => outputs.shift(), sleep: async () => {} });
  await failing.service.startAuto("s1", {}, { acquireSshSlot: failing.acquireSshSlot });
  const failed = await settle(failing.service);
  assert.deepEqual([failed.auto.reason, failed.auto.rounds, failed.scan.runs, failed.scan.complete], ["error", 1, 1, false]);
  assert.match(failed.auto.error, /扫描失败 \(ssh exit 255\)/);
  await failing.service.startAuto("s1", { mode: "continue" }, { acquireSshSlot: failing.acquireSshSlot });
  assert.deepEqual([(await settle(failing.service)).auto.reason, (await failing.service.get("s1")).scan.complete], ["done", true]);

  // 时长上限
  let clock = NOW;
  const long = makeService({ config: CONFIG, now: () => clock, exec: async () => { clock += DIR_USAGE_AUTO_MAX_MS; return { code: 0, stdout: end(), stderr: "" }; }, sleep: async () => {} });
  await long.service.startAuto("s1", {}, { acquireSshSlot: long.acquireSshSlot });
  const limited = await settle(long.service);
  assert.deepEqual([limited.auto.reason, limited.auto.rounds, limited.scan.complete], ["limit", 1, false]);
});

test("isScanning：单轮扫描与自动续扫进行中为真，结束即假，按服务器分开（磁盘增长归因的定时测量据此让路）", async () => {
  let release;
  const { service, acquireSshSlot } = makeService({
    config: CONFIG,
    exec: async () => { await new Promise((resolve) => { release = resolve; }); return { code: 0, stdout: end({ complete: true, stop: "done", pending: [] }), stderr: "" }; },
    sleep: async () => {},
  });
  assert.equal(service.isScanning("s1"), false);
  const single = service.scan("s1", {}, { acquireSshSlot });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([service.isScanning("s1"), service.isScanning("me"), service.isScanning("nope")], [true, false, false]);
  release();
  await single;
  assert.equal(service.isScanning("s1"), false);

  release = null;
  await service.startAuto("s1", {}, { acquireSshSlot });
  assert.equal(service.isScanning("s1"), true, "自动续扫一发起就算");
  for (let i = 0; i < 50 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  release();
  await settle(service);
  assert.equal(service.isScanning("s1"), false);
});

// 真实远端脚本：在临时 $HOME 上跑，验证有界、可续扫、不跟随符号链接、只读。
const python = spawnSync("python3", ["--version"]).status === 0 && process.platform !== "win32";
function runScript(home, payload) {
  const input = `${JSON.stringify(readFileSync(DIR_USAGE_SCRIPT_PATH, "utf8"))}\n${JSON.stringify(payload)}`;
  const cmd = DIR_USAGE_REMOTE_COMMAND.replace(/^python3 -c '/, "").replace(/'$/, "");
  // PYTHONDONTWRITEBYTECODE：macOS 自带的 /usr/bin/python3 会往 $HOME/Library/Caches/com.apple.python 写字节码缓存，
  // 临时 HOME 里凭空多出一个 Library 目录，扫描结果就和用例造的目录对不上（只在 Mac 上失败，Linux CI 通过）。
  const res = spawnSync("python3", ["-c", cmd], { input, env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
  return res.stdout;
}

test("远端脚本：分轮续扫的累计等于一次扫完；符号链接不跟随；越出 $HOME 拒绝", { skip: !python }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dir-usage-home-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "dir-usage-out-"));
  try {
    mkdirSync(path.join(home, "proj", "runs", "r1"), { recursive: true });
    mkdirSync(path.join(home, "data"), { recursive: true });
    for (let i = 0; i < 25; i += 1) writeFileSync(path.join(home, "data", `f${i}`), "x".repeat(100 * i));
    writeFileSync(path.join(home, "proj", "runs", "r1", "ckpt.bin"), Buffer.alloc(200000, 1));
    writeFileSync(path.join(home, "top.txt"), "hi");
    writeFileSync(path.join(outside, "secret.bin"), Buffer.alloc(500000, 1));
    symlinkSync(outside, path.join(home, "escape"));
    const before = readFileSync(path.join(home, "top.txt"), "utf8");

    const full = parseDirUsageOutput(runScript(home, {}), { expectRoot: "" });
    assert.equal(full.ok, true);
    assert.equal(full.run.complete, true);
    assert.ok(!full.run.top.some((f) => f.path.startsWith("escape/")), "不跟随符号链接");
    assert.equal(full.run.top[0].path, "proj/runs/r1/ckpt.bin");

    let record = null;
    let pending = null;
    for (let i = 0; i < 50; i += 1) {
      const out = parseDirUsageOutput(runScript(home, { maxEntries: 4, ...(pending ? { pending } : {}) }), { expectRoot: "" });
      assert.equal(out.ok, true);
      assert.ok(out.run.entries <= 4, "每轮条目数真正受限");
      record = mergeDirUsageRun(record, out.run, { now: NOW + i });
      if (out.run.complete) break;
      pending = out.run.pending;
    }
    assert.equal(record.complete, true);
    assert.ok(record.runs > 3);
    const once = mergeDirUsageRun(null, full.run, { now: NOW });
    assert.equal(record.entries, once.entries);
    assert.deepEqual(record.agg1, once.agg1);
    assert.deepEqual(record.rootFiles, once.rootFiles);

    const sub = parseDirUsageOutput(runScript(home, { root: "proj" }), { expectRoot: "proj" });
    assert.deepEqual(Object.keys(sub.run.agg1), ["runs"]);
    assert.equal(parseDirUsageOutput(runScript(home, { root: "escape" }), { expectRoot: "escape" }).code, "outside-home");
    assert.equal(parseDirUsageOutput(runScript(home, { root: "../x" }), { expectRoot: "../x" }).code, "bad-root");
    assert.equal(parseDirUsageOutput(runScript(home, { root: "top.txt" }), { expectRoot: "top.txt" }).code, "not-dir");
    assert.equal(readFileSync(path.join(home, "top.txt"), "utf8"), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("远端脚本：扫描根下的目录先扫名字不带点的、再扫隐藏的，同组按名字；本层没列完时先接着列它", { skip: !python }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dir-usage-order-"));
  try {
    for (const dir of [".cache", "zeta", "alpha", ".aaa"]) {
      mkdirSync(path.join(home, dir, "sub"), { recursive: true });
      writeFileSync(path.join(home, dir, "sub", "f"), "x");
    }
    // 4 个条目刚好把扫描根列完：栈底 → 栈顶，下一轮从栈顶（alpha）开始。
    const listed = parseDirUsageOutput(runScript(home, { maxEntries: 4 }), { expectRoot: "" });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.run.pending, [[".cache", 0], [".aaa", 0], ["zeta", 0], ["alpha", 0]]);

    // 扫描根只列了一半：它的游标留在栈顶，已经列出的两个目录排在它下面。
    const half = parseDirUsageOutput(runScript(home, { maxEntries: 2 }), { expectRoot: "" });
    assert.deepEqual(half.run.pending.at(-1), ["", 2]);
    assert.equal(half.run.pending.length, 3);

    // 一轮一轮扫完：先完成的是 alpha，累计与一次扫完相同。
    const full = mergeDirUsageRun(null, parseDirUsageOutput(runScript(home, {}), { expectRoot: "" }).run, { now: NOW });
    let record = null;
    let pending = null;
    const finishedOrder = [];
    for (let i = 0; i < 60; i += 1) {
      const out = parseDirUsageOutput(runScript(home, { maxEntries: 3, ...(pending ? { pending } : {}) }), { expectRoot: "" });
      assert.equal(out.ok, true);
      record = mergeDirUsageRun(record, out.run, { now: NOW + i });
      for (const c of buildDirUsageView(record).children) if (!c.partial && !finishedOrder.includes(c.name)) finishedOrder.push(c.name);
      if (out.run.complete) break;
      pending = out.run.pending;
    }
    assert.equal(record.complete, true);
    assert.deepEqual(finishedOrder, ["alpha", "zeta", ".aaa", ".cache"]);
    assert.equal(record.entries, full.entries);
    assert.deepEqual(record.agg1, full.agg1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
