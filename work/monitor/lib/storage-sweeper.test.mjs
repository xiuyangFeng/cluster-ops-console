import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { formatHistoryDate } from "./history-store.mjs";
import { createStorageSweeper } from "./storage-sweeper.mjs";

// 全部用例走内存 fake fs：不建临时目录、不落真实磁盘，也不依赖运行机器的真实日期
// （history 的"保留今天与昨天"用注入的 now 与 formatHistoryDate 现算，跨时区稳定）。

const ROOT = "/rt";
const DAY_MS = 24 * 60 * 60 * 1000;

// files: { "logs/ops.ndjson.2": { bytes, mtimeMs } }；failDelete: 删除（rm / rmdir）必失败的相对路径集合。
// dirs: { "control/ab12cd34/requests": { mtimeMs } }——空目录与要带 mtime 的目录显式写在这里（有文件的目录
// 仍可只由文件路径隐含）。文件与目录都可以带 symlink: true，表示这个目录项是符号链接：目录项类型既不是
// 文件也不是目录，lstat 说它不是目录；顺着它读目录、或对目录用 rm，都算被测代码越界，直接让用例失败。
function createFakeFs(files, { failDelete = new Set(), missingRoot = false, dirs = {} } = {}) {
  const store = new Map(Object.entries(files));
  const dirStore = new Map(Object.entries(dirs));
  const deleted = [];
  const removedDirs = [];
  // sweeper 用 path.join 拼路径，Windows 上分隔符是 "\"；这里统一归一成 "/" 以便与
  // 用 "/" 书写的 fixture key 比对（被测代码本身只按路径分段分类，与分隔符无关）。
  const rel = (p) => (p === ROOT ? "" : p.slice(ROOT.length + 1).split(path.sep).join("/"));
  const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const hasChildren = (key) => [...store.keys(), ...dirStore.keys()].some((k) => k.startsWith(`${key}/`));
  const isDir = (key) => key === "" || dirStore.has(key) || hasChildren(key);

  return {
    deleted,
    removedDirs,
    store,
    dirStore,
    async readdir(dir, opts) {
      assert.equal(opts?.withFileTypes, true, "sweeper 必须用 withFileTypes 读目录");
      if (missingRoot) throw enoent();
      const relDir = rel(dir);
      assert.ok(!dirStore.get(relDir)?.symlink, `不得顺着符号链接读目录：${relDir}`);
      if (!isDir(relDir)) throw enoent();
      const prefix = relDir ? `${relDir}/` : "";
      const children = new Map(); // name -> "file" | "dir" | "link"
      for (const [key, record] of [...store, ...dirStore]) {
        if (prefix && !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash !== -1) children.set(rest.slice(0, slash), children.get(rest.slice(0, slash)) ?? "dir");
        else children.set(rest, record.symlink ? "link" : store.has(key) ? "file" : "dir");
      }
      return [...children].map(([name, type]) => ({
        name,
        isDirectory: () => type === "dir",
        isFile: () => type === "file",
      }));
    },
    // stat 跟随符号链接（sweeper 只拿它量文件大小）。
    async stat(filePath) {
      const key = rel(filePath);
      const record = store.get(key) ?? dirStore.get(key);
      if (!record) throw enoent();
      return { size: record.bytes ?? 0, mtimeMs: record.mtimeMs ?? 0 };
    },
    async lstat(target) {
      const key = rel(target);
      const record = store.get(key) ?? dirStore.get(key);
      if (!record && !isDir(key)) throw enoent();
      const directory = !store.has(key) && !record?.symlink;
      return { isDirectory: () => directory, mtimeMs: record?.mtimeMs ?? 0 };
    },
    async rm(filePath) {
      const key = rel(filePath);
      assert.ok(!dirStore.has(key) && !hasChildren(key), `目录只能用 rmdir 删：${key}`);
      if (failDelete.has(key)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      if (!store.has(key)) throw enoent();
      store.delete(key);
      deleted.push(key);
    },
    // 非递归：只删得掉空的真目录。
    async rmdir(target, opts) {
      assert.equal(opts, undefined, "rmdir 不带 recursive");
      const key = rel(target);
      if (!dirStore.has(key) || dirStore.get(key).symlink) throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      if (failDelete.has(key) || hasChildren(key)) throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
      dirStore.delete(key);
      removedDirs.push(key);
    },
  };
}

// 一份固定的超限目录：总计 1550 字节。
//  受保护：logs/ops.ndjson(300)、history/<今天>(100)、history/<昨天>(100)、metrics.json(100)、supervisor.pid.json(50)
//  可淘汰：logs/sig.ndjson.3(100)、logs/sig.ndjson.2(200)、logs/ops.ndjson.2(200)、
//          history/<10天前>(100)、history/<5天前>(100)、logs/ops.ndjson.1(200)
const NOW = 1756800000000;
const TODAY = formatHistoryDate(NOW);
const YESTERDAY = formatHistoryDate(NOW - DAY_MS);
const OLDEST_DAY = formatHistoryDate(NOW - 10 * DAY_MS);
const OLDER_DAY = formatHistoryDate(NOW - 5 * DAY_MS);

function overBudgetTree() {
  return {
    "logs/ops.ndjson": { bytes: 300, mtimeMs: 100 },
    "logs/ops.ndjson.1": { bytes: 200, mtimeMs: 90 },
    "logs/ops.ndjson.2": { bytes: 200, mtimeMs: 50 }, // 与 sig.ndjson.2 同级，mtime 更新 → 后扔
    "logs/sig.ndjson.2": { bytes: 200, mtimeMs: 10 }, // 同级最旧 → 先扔
    "logs/sig.ndjson.3": { bytes: 100, mtimeMs: 80 }, // N 最大 → 整层最先扔（哪怕 mtime 更新）
    [`history/${OLDEST_DAY}.ndjson`]: { bytes: 100, mtimeMs: 1 },
    [`history/${OLDER_DAY}.ndjson`]: { bytes: 100, mtimeMs: 2 },
    [`history/${YESTERDAY}.ndjson`]: { bytes: 100, mtimeMs: 3 },
    [`history/${TODAY}.ndjson`]: { bytes: 100, mtimeMs: 4 },
    "metrics.json": { bytes: 100, mtimeMs: 5 },
    "supervisor.pid.json": { bytes: 50, mtimeMs: 6 },
  };
}

function makeSweeper(files, options = {}) {
  const fs = createFakeFs(files, options);
  const logs = [];
  const live = options.liveControlInstanceId;
  const sweeper = createStorageSweeper({
    runtimeDir: ROOT,
    budgetBytes: options.budgetBytes ?? 1000,
    now: () => NOW,
    fs,
    log: (message, fields) => logs.push({ message, ...fields }),
    // 给了才接：不给 = 装配处不知道当前 supervisor 是谁（缺省行为）。传 Error 表示取实例号时抛错。
    ...("liveControlInstanceId" in options ? {
      getLiveControlInstanceId: async () => {
        if (live instanceof Error) throw live;
        return live;
      },
    } : {}),
  });
  return { sweeper, fs, logs };
}

test("storage-sweeper: measure 按 kind 分类统计，不删任何文件", async () => {
  const { sweeper, fs } = makeSweeper(overBudgetTree());
  const result = await sweeper.measure();

  assert.equal(result.usedBytes, 1550);
  assert.deepEqual(result.byKind, {
    logs: 300, // 活动 ndjson
    logRotations: 700, // .1 + .2 + .2 + .3
    history: 400, // 四个按天文件
    metrics: 100,
    corrupt: 0,
    other: 50, // pid 记录
  });
  assert.deepEqual(fs.deleted, [], "measure 是只读的");
});

test("storage-sweeper: 坏文件留档（<名字>.corrupt-<时间戳>）单列计入；超预算时排在多余分卷之后、旧 history 之前，按留档时刻旧的先清", async () => {
  const tree = {
    ...overBudgetTree(),
    // metrics.json 的留档不能被当成 metrics（那一类永不删）；子目录里的留档同样认得。
    "metrics.json.corrupt-20261014-090507": { bytes: 60, mtimeMs: 999 },
    "job-watch.json.corrupt-20261012-000000": { bytes: 40, mtimeMs: 1 },
    "usage/server-01/days/2026-10-01.json.corrupt-20261014-090507-2": { bytes: 30, mtimeMs: 0 },
  };
  const { sweeper: measurer } = makeSweeper(tree);
  const measured = await measurer.measure();
  assert.equal(measured.usedBytes, 1550 + 130);
  assert.equal(measured.byKind.corrupt, 130);
  assert.equal(measured.byKind.metrics, 100);

  // 1680 → 目标 1000：多余分卷 500（→1180）→ 三份留档（→1050）→ 最旧一天 history（→950）。
  const { sweeper, fs } = makeSweeper(tree);
  const result = await sweeper.sweep();
  assert.deepEqual(fs.deleted, [
    "logs/sig.ndjson.3",
    "logs/sig.ndjson.2",
    "logs/ops.ndjson.2",
    "job-watch.json.corrupt-20261012-000000", // 留档最早
    "metrics.json.corrupt-20261014-090507", // 同一秒：不带序号的在前
    "usage/server-01/days/2026-10-01.json.corrupt-20261014-090507-2",
    `history/${OLDEST_DAY}.ndjson`,
  ]);
  assert.equal(result.usedBytes, 950);
  assert.ok(fs.store.has("metrics.json"), "现役 metrics.json 不动");

  // 预算宽裕：留档不看预算，一份都不删（每个文件本来最多 2 份）。
  const { sweeper: roomy, fs: roomyFs } = makeSweeper(tree, { budgetBytes: 10_000 });
  await roomy.sweep();
  assert.deepEqual(roomyFs.deleted.filter((key) => key.includes(".corrupt-")), []);
});

test("storage-sweeper: 超限时按 分卷N降序 → history 最旧 → .1 的顺序淘汰，达标即停", async () => {
  const { sweeper, fs } = makeSweeper(overBudgetTree());
  const result = await sweeper.sweep();

  // 1550 → 目标 1000：先清多余分卷（100+200+200=500 → 1050 仍超），再吃最旧的一天 history。
  assert.deepEqual(fs.deleted, [
    "logs/sig.ndjson.3", // N=3 最旧分卷优先
    "logs/sig.ndjson.2", // 同为 N=2，mtime 更早
    "logs/ops.ndjson.2",
    `history/${OLDEST_DAY}.ndjson`, // 进入 history 层，日期最旧优先
  ]);
  assert.equal(result.usedBytes, 950);
  assert.equal(result.budgetBytes, 1000);
  assert.equal(result.overBudget, false);
  assert.deepEqual(
    result.evicted.map((e) => e.kind),
    ["logRotations", "logRotations", "logRotations", "history"],
  );
  assert.deepEqual(result.evicted[0], { path: path.join(ROOT, "logs", "sig.ndjson.3"), bytes: 100, kind: "logRotations" });
  // 达标即停：.1 分卷与次旧的 history 都还在。
  assert.ok(fs.store.has("logs/ops.ndjson.1"));
  assert.ok(fs.store.has(`history/${OLDER_DAY}.ndjson`));
});

test("storage-sweeper: targetRatio 0.5 清到一半，活动文件/metrics/pid/今昨 history 一律不删并告警", async () => {
  const { sweeper, fs, logs } = makeSweeper(overBudgetTree());
  const result = await sweeper.sweep({ targetRatio: 0.5 });

  // 目标 500：三层可淘汰的 900 字节全部清空后仍剩 650，受保护文件不再动。
  assert.deepEqual(fs.deleted, [
    "logs/sig.ndjson.3",
    "logs/sig.ndjson.2",
    "logs/ops.ndjson.2",
    `history/${OLDEST_DAY}.ndjson`,
    `history/${OLDER_DAY}.ndjson`,
    "logs/ops.ndjson.1", // 最后才动 .1
  ]);
  assert.deepEqual([...fs.store.keys()].sort(), [
    `history/${TODAY}.ndjson`,
    `history/${YESTERDAY}.ndjson`,
    "logs/ops.ndjson",
    "metrics.json",
    "supervisor.pid.json",
  ].sort());
  assert.equal(result.usedBytes, 650);
  assert.equal(result.overBudget, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  assert.equal(logs[0].event, "storage-over-budget");
});

test("storage-sweeper: 未超预算时只清没人再读的旧分卷（N ≥ 2），其余一个文件都不删", async () => {
  const { sweeper, fs, logs } = makeSweeper(overBudgetTree(), { budgetBytes: 100000 });
  const result = await sweeper.sweep();

  // logger 只留、也只读 .1：.2 / .3 不等超预算就删（N 大的先删，与超预算时同一顺序）。
  assert.deepEqual(fs.deleted, ["logs/sig.ndjson.3", "logs/sig.ndjson.2", "logs/ops.ndjson.2"]);
  assert.deepEqual(result.evicted.map((e) => [e.kind, e.bytes]), [["logRotations", 100], ["logRotations", 200], ["logRotations", 200]]);
  assert.equal(result.usedBytes, 1050);
  assert.equal(result.overBudget, false);
  assert.deepEqual(logs, []);
  // .1、活动文件、全部 history（含最旧的两天）、metrics、pid 记录原样留着。
  assert.deepEqual([...fs.store.keys()].sort(), [
    `history/${OLDEST_DAY}.ndjson`,
    `history/${OLDER_DAY}.ndjson`,
    `history/${TODAY}.ndjson`,
    `history/${YESTERDAY}.ndjson`,
    "logs/ops.ndjson",
    "logs/ops.ndjson.1",
    "metrics.json",
    "supervisor.pid.json",
  ].sort());
  assert.equal(sweeper.getState().evicted, 3);

  // 下一轮没有可清的了。
  assert.deepEqual((await sweeper.sweep()).evicted, []);
});

// v2.64 的三份自身故障日志（desktop 归 Electron 主进程、launcher 归启动器、renderer 归监控服务）不用登记：
// 清理器按文件名形状认 logs/ 下的一切——活动文件受保护、.1 计入分卷最后才动、.2 及更早不看预算就删。
test("storage-sweeper: desktop / launcher / renderer 三份日志与 ops 同等对待（活动文件不删、.1 最后、.N≥2 直接清）", async () => {
  const tree = {
    "logs/desktop.ndjson": { bytes: 300, mtimeMs: 100 },
    "logs/desktop.ndjson.1": { bytes: 300, mtimeMs: 60 },
    "logs/launcher.ndjson": { bytes: 100, mtimeMs: 100 },
    "logs/launcher.ndjson.1": { bytes: 100, mtimeMs: 70 },
    "logs/renderer.ndjson": { bytes: 200, mtimeMs: 100 },
    "logs/renderer.ndjson.1": { bytes: 200, mtimeMs: 50 },
    "logs/renderer.ndjson.2": { bytes: 50, mtimeMs: 10 },
  };
  const measured = await makeSweeper(tree).sweeper.measure();
  assert.deepEqual(measured.byKind, { logs: 600, logRotations: 650, history: 0, metrics: 0, corrupt: 0, other: 0 });

  const roomy = makeSweeper(tree, { budgetBytes: 100000 });
  await roomy.sweeper.sweep();
  assert.deepEqual(roomy.fs.deleted, ["logs/renderer.ndjson.2"], "没人读的旧分卷不看预算就删");

  const tight = makeSweeper(tree, { budgetBytes: 1000 });
  const result = await tight.sweeper.sweep({ targetRatio: 0.5 });
  assert.deepEqual(tight.fs.deleted, ["logs/renderer.ndjson.2", "logs/renderer.ndjson.1", "logs/desktop.ndjson.1", "logs/launcher.ndjson.1"], ".1 按 mtime 从旧到新");
  assert.deepEqual([...tight.fs.store.keys()].sort(), ["logs/desktop.ndjson", "logs/launcher.ndjson", "logs/renderer.ndjson"], "活动文件一个不删");
  assert.equal(result.usedBytes, 600);
});

test("storage-sweeper: 「不看预算就删」只认 logs/ 下的普通文件——别处的同名文件与符号链接不在此列", async () => {
  const { sweeper, fs } = makeSweeper({
    "logs/ops.ndjson": { bytes: 300, mtimeMs: 100 },
    "logs/ops.ndjson.2": { bytes: 200, mtimeMs: 50 },
    "logs/sig.ndjson.2": { bytes: 200, mtimeMs: 10, symlink: true }, // 目录项是符号链接
    "tunnel-ledger.ndjson.2": { bytes: 100, mtimeMs: 5 }, // 不在 logs/ 下：不是 logger 的分卷
    "usage/server-01/days/x.ndjson.3": { bytes: 100, mtimeMs: 5 },
  }, { budgetBytes: 100000 });
  await sweeper.sweep();
  assert.deepEqual(fs.deleted, ["logs/ops.ndjson.2"]);

  // 超预算时的老路径不变：符号链接形式的多余分卷仍在第一层（rm 只摘链接本身）。
  sweeper.setBudget(650);
  const result = await sweeper.sweep();
  assert.deepEqual(fs.deleted, ["logs/ops.ndjson.2", "logs/sig.ndjson.2"]);
  assert.equal(result.usedBytes, 500);
});

// ── 控制信箱的孤儿目录（runtime/control/<instanceId>/{requests,processing,results}）──

const HOUR_MS = 60 * 60 * 1000;
// 一棵信箱目录：实例目录 + 三个空子目录，mtime 统一在 ageMs 之前（缺省 3 天）。
function controlTree(id, { ageMs = 3 * DAY_MS } = {}) {
  const mtimeMs = NOW - ageMs;
  return Object.fromEntries([`control/${id}`, ...["processing", "requests", "results"].map((sub) => `control/${id}/${sub}`)].map((key) => [key, { mtimeMs }]));
}

test("storage-sweeper: 控制信箱只清「不是当前实例、子目录全空、整棵早于 24 小时」的目录，逐层 rmdir、不碰任何文件", async () => {
  const old = { mtimeMs: NOW - 3 * DAY_MS };
  const dirs = {
    ...controlTree("aaaa0001"), // 当前 supervisor 的：再旧再空也不动
    ...controlTree("bbbb0002"), // 孤儿 → 删
    ...controlTree("cccc0003"), // results 里还留着一份结果 → 留
    ...controlTree("dddd0004"), // 23 小时前还有请求进出过（子目录 mtime 新）→ 留
    ...controlTree("eeee0005", { ageMs: HOUR_MS }), // 一小时前才建的 → 留
    ...controlTree("abcd0006"), // 混进了认不得的子目录 → 留
    ...controlTree("abcd0007"), // results 是符号链接 → 留
    ...controlTree("not-an-instance"), // 名字不是实例号 → 留
    "control/ffff0008": { ...old, symlink: true }, // 整棵是个符号链接 → 留
    "control/abcd0009": old, // 三个子目录都没有的空壳 → 删
    "control/dddd0004/requests": { mtimeMs: NOW - 23 * HOUR_MS },
    "control/abcd0006/extra": old,
    "control/abcd0007/results": { ...old, symlink: true },
  };
  const files = {
    "logs/ops.ndjson": { bytes: 300, mtimeMs: 100 },
    "control/cccc0003/results/6fe02ade-659f-45d5-8af9-0625a095368b.json": { bytes: 400, ...old },
  };
  const { sweeper, fs, logs } = makeSweeper(files, { dirs, budgetBytes: 100000, liveControlInstanceId: "aaaa0001" });
  const before = [...fs.dirStore.keys()];
  const result = await sweeper.sweep();

  assert.deepEqual(fs.removedDirs, [
    "control/bbbb0002/processing", "control/bbbb0002/requests", "control/bbbb0002/results", "control/bbbb0002",
    "control/abcd0009",
  ]);
  assert.deepEqual([...fs.dirStore.keys()], before.filter((key) => !key.startsWith("control/bbbb0002") && key !== "control/abcd0009"));
  assert.deepEqual(fs.deleted, [], "信箱清理不删任何文件");
  assert.deepEqual(result.evicted, [], "evicted 只数文件");
  assert.equal(result.usedBytes, 700);
  assert.deepEqual(logs, [{
    message: "storage sweep: 清掉 2 个已退出的 supervisor 留下的空控制信箱目录",
    level: "info", event: "storage-control-orphans", controlDirs: 2,
  }]);

  // 下一轮没有可清的：不删、不再写日志。
  await sweeper.sweep();
  assert.equal(fs.removedDirs.length, 5);
  assert.equal(logs.length, 1);
});

test("storage-sweeper: 不知道当前 supervisor 的实例号时，信箱目录一棵都不删", async () => {
  const cases = [
    {}, // 装配处没接
    { liveControlInstanceId: null }, // 没有新鲜的运行快照
    { liveControlInstanceId: "" },
    { liveControlInstanceId: "../bbbb0002" }, // 形状不对的值不当实例号用
    { liveControlInstanceId: 42 },
    { liveControlInstanceId: new Error("snapshot unreadable") },
  ];
  for (const options of cases) {
    const { sweeper, fs, logs } = makeSweeper({}, { dirs: { ...controlTree("bbbb0002"), ...controlTree("cccc0003") }, budgetBytes: 100000, ...options });
    await sweeper.sweep();
    assert.deepEqual(fs.removedDirs, [], JSON.stringify(Object.keys(options)));
    assert.deepEqual(logs, []);
  }
  // measure 只读：知道实例号也不删。
  const { sweeper, fs } = makeSweeper({}, { dirs: controlTree("bbbb0002"), liveControlInstanceId: "aaaa0001" });
  await sweeper.measure();
  assert.deepEqual(fs.removedDirs, []);
});

test("storage-sweeper: control 本身是符号链接时整个信箱清理跳过", async () => {
  const { sweeper, fs } = makeSweeper({}, {
    dirs: { control: { mtimeMs: 1, symlink: true } },
    budgetBytes: 100000, liveControlInstanceId: "aaaa0001",
  });
  await sweeper.sweep(); // fake fs：顺着符号链接 readdir 会让用例失败
  assert.deepEqual(fs.removedDirs, []);
});

test("storage-sweeper: rmdir 被挡住（判定之后才落进来文件）时这一棵留到下一轮，不改用递归删除；其余照清", async () => {
  const { sweeper, fs, logs } = makeSweeper({}, {
    dirs: { ...controlTree("bbbb0002"), ...controlTree("cccc0003") },
    failDelete: new Set(["control/bbbb0002/results"]),
    budgetBytes: 100000, liveControlInstanceId: "aaaa0001",
  });
  await sweeper.sweep();
  assert.deepEqual(fs.removedDirs, [
    "control/bbbb0002/processing", "control/bbbb0002/requests",
    "control/cccc0003/processing", "control/cccc0003/requests", "control/cccc0003/results", "control/cccc0003",
  ]);
  assert.deepEqual([...fs.dirStore.keys()], ["control/bbbb0002", "control/bbbb0002/results"]);
  assert.deepEqual(fs.deleted, [], "fake fs：对目录调 rm 会让用例失败");
  assert.equal(logs[0].controlDirs, 1);
});

test("storage-sweeper: runtime 目录不存在时 measure/sweep 都按 0 处理，不抛错", async () => {
  const { sweeper } = makeSweeper({}, { missingRoot: true, budgetBytes: 10 });

  assert.deepEqual(await sweeper.measure(), {
    usedBytes: 0,
    byKind: { logs: 0, logRotations: 0, history: 0, metrics: 0, corrupt: 0, other: 0 },
  });
  const result = await sweeper.sweep();
  assert.deepEqual(result.evicted, []);
  assert.equal(result.usedBytes, 0);
  assert.equal(result.overBudget, false);
});

test("storage-sweeper: 单个文件删除失败被忽略，其余候选继续淘汰", async () => {
  const { sweeper, fs } = makeSweeper(overBudgetTree(), {
    failDelete: new Set(["logs/sig.ndjson.2"]),
  });
  const result = await sweeper.sweep();

  // sig.ndjson.2 删不掉（200 字节仍计入），淘汰只好一路下探到 history 两天 + .1 分卷。
  assert.deepEqual(fs.deleted, [
    "logs/sig.ndjson.3",
    "logs/ops.ndjson.2",
    `history/${OLDEST_DAY}.ndjson`,
    `history/${OLDER_DAY}.ndjson`,
    "logs/ops.ndjson.1",
  ]);
  assert.ok(fs.store.has("logs/sig.ndjson.2"), "删除失败的文件仍在");
  assert.ok(!result.evicted.some((e) => e.path.endsWith("sig.ndjson.2")), "失败的文件不计入 evicted");
  assert.equal(result.usedBytes, 850, "失败文件的 200 字节不得从占用里扣减");
  assert.equal(result.overBudget, false);
});

test("storage-sweeper: getState 反映最近一次 sweep 的占用/预算/时间/淘汰数，setBudget 热更新", async () => {
  const { sweeper } = makeSweeper(overBudgetTree());

  assert.deepEqual(sweeper.getState(), {
    usedBytes: null, // 还没测过
    budgetBytes: 1000,
    lastSweepAt: null,
    evicted: 0,
  });

  await sweeper.sweep();
  assert.deepEqual(sweeper.getState(), {
    usedBytes: 950,
    budgetBytes: 1000,
    lastSweepAt: NOW,
    evicted: 4,
  });

  // 预算调大后再扫：无需淘汰，evicted 归零（是"上一次"的计数而非累计）。
  sweeper.setBudget(100000);
  await sweeper.sweep();
  assert.deepEqual(sweeper.getState(), {
    usedBytes: 950,
    budgetBytes: 100000,
    lastSweepAt: NOW,
    evicted: 0,
  });
});

test("storage-sweeper: dispose 之后 sweep 不再删任何文件", async () => {
  const { sweeper, fs } = makeSweeper(overBudgetTree());
  sweeper.dispose();
  const result = await sweeper.sweep();
  assert.deepEqual(fs.deleted, []);
  assert.deepEqual(result.evicted, []);
});
