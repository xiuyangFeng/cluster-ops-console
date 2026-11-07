import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseUsageScanOutput, USAGE_REMOTE_COMMAND } from "./scan.mjs";
import { createUsageService, isUsageEligible, usageServers } from "./service.mjs";
import { createUsageStore } from "./store.mjs";

const NOW = Date.UTC(2026, 9, 2, 15 - 8, 0); // 北京时间 15:00
const config = {
  servers: [
    { id: "server-01", host: "myserver", name: "主集群", source: "team" },
    { id: "server-me", host: "mybox", source: "personal" },
    { id: "server-off", host: "x", source: "team", disabled: true },
  ],
};

const line = (rec) => JSON.stringify(rec);
const OUTPUT = [
  line({ k: "s", a: "claude", sid: "cl-1", cwd: "/home/u/proj", t: NOW / 1000 - 600 }),
  line({ k: "c", a: "claude", sid: "cl-1", rid: "req_1", t: NOW / 1000 - 120, m: "claude-opus-5-5", st: "ok", in: 3, cw: 100, cr: 900, o: 20, p: 1003 }),
  line({ k: "cur", f: "/home/u/.claude/projects/p/cl-1.jsonl", i: "77", o: 900, mt: NOW / 1000, s: {} }),
  line({ k: "end", complete: true, files: 1, pending: 1, bytes: 900, sec: 0.2, roots: { codex: false, claude: true }, home: "/home/u" }),
].join("\n");

function withService(execCollector, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-service-"));
  const store = createUsageStore({ rootDir: dir, now: () => NOW });
  const service = createUsageService({
    store, getConfig: async () => config, dataDir: dir, execCollector,
    probeSshFailureReason: (code) => `ssh exit ${code}`, now: () => NOW,
  });
  return Promise.resolve(fn(service, store)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("采集范围：团队服务器，个人服务器与已禁用的不采集", () => {
  assert.deepEqual(usageServers(config).map((s) => s.id), ["server-01"]);
  assert.equal(isUsageEligible({ id: "x", source: "team", monitorEnabled: false }), false);
});

test("一轮扫描：游标经 stdin 带回远端，结果入库后可在摘要里看到", () => {
  const seen = [];
  return withService(async (invocation) => {
    seen.push(invocation);
    return { code: 0, stdout: OUTPUT, stderr: "" };
  }, async (service) => {
    const first = await service.runScan("server-01");
    assert.equal(first.level, "ok");
    assert.equal(first.data.added, 1);
    assert.equal(seen[0].args.at(-1), USAGE_REMOTE_COMMAND);
    await service.runScan("server-01");
    assert.deepEqual(JSON.parse(seen[1].input.split("\n")[1]).cursors, { "/home/u/.claude/projects/p/cl-1.jsonl": { i: "77", o: 900, mt: NOW / 1000, s: {} } });

    const summary = await service.summary({ range: 1 });
    assert.equal(summary.kpis.calls, 1);
    assert.equal(summary.kpis.fresh, 103);
    assert.equal(summary.sessions[0].project, "~/proj");
    assert.equal(summary.sources[0].id, "server-01");
    assert.equal(summary.sources[0].complete, true);
    const detail = await service.sessionDetail(summary.sessions[0].key);
    assert.equal(detail.turns[0].calls[0].rid, "req_1");
    assert.equal((await service.runScan("server-me")).level, "skipped");
  });
});

test("空转的一轮扫描（没有新调用、游标没动）不让摘要缓存失效；有新调用的一轮才重建快照", () => {
  const end = { k: "end", complete: true, files: 0, pending: 0, bytes: 0, sec: 0.01, roots: { codex: false, claude: true }, home: "/home/u" };
  const fresh = [
    line({ k: "c", a: "claude", sid: "cl-1", rid: "req_2", t: NOW / 1000 - 60, m: "claude-opus-5-5", st: "ok", in: 1, cw: 0, cr: 10, o: 2, p: 11 }),
    line({ k: "cur", f: "/home/u/.claude/projects/p/cl-1.jsonl", i: "77", o: 1800, mt: NOW / 1000, s: {} }),
    line({ ...end, files: 1, pending: 1 }),
  ].join("\n");
  const outputs = [OUTPUT, line(end), line(end), fresh];
  return withService(async () => ({ code: 0, stdout: outputs.shift(), stderr: "" }), async (service, store) => {
    // 快照是摘要里最贵的一步（复制 62 天的全部调用）；数它被重建了几次。
    let rebuilt = 0;
    const snapshot = store.snapshot;
    store.snapshot = (...args) => {
      rebuilt += 1;
      return snapshot(...args);
    };
    await service.runScan("server-01");
    assert.equal((await service.summary({ range: 1 })).kpis.calls, 1);
    assert.equal(rebuilt, 1);

    for (let i = 0; i < 2; i += 1) {
      const idle = await service.runScan("server-01");
      assert.deepEqual([idle.level, idle.data.added, idle.data.updated], ["ok", 0, 0]);
      const summary = await service.summary({ range: 1 });
      assert.deepEqual([summary.kpis.calls, summary.sources[0].complete], [1, true]);
    }
    assert.equal(rebuilt, 1, "空转的两轮之后摘要仍用同一份快照");

    await service.runScan("server-01");
    assert.equal((await service.summary({ range: 1 })).kpis.calls, 2);
    assert.equal(rebuilt, 2);
  });
});

test("远端没有 python3 / SSH 失败：报错但保留已有数据", () => withService(
  async () => ({ code: 127, stdout: "", stderr: "bash: python3: command not found" }),
  async (service, store) => {
    const result = await service.runScan("server-01");
    assert.equal(result.level, "error");
    assert.match(result.reason, /python3/);
    assert.match((await store.getScanStatus("server-01")).lastError, /python3/);
  },
));

test("冷启动：启动扫描取游标与首页摘要并发，摘要不缓存加载中途的空数据", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-service-cold-"));
  try {
    // 上次运行已落盘 1 条调用
    await createUsageStore({ rootDir: dir, now: () => NOW }).ingest("server-01", parseUsageScanOutput(OUTPUT));
    // 重启：新 store + 新服务，扫描（getCursors）与摘要同时到达
    const store = createUsageStore({ rootDir: dir, now: () => NOW });
    const service = createUsageService({ store, getConfig: async () => config, dataDir: dir, execCollector: async () => assert.fail("不扫描"), probeSshFailureReason: () => "", now: () => NOW });
    const [cursors, first] = await Promise.all([store.getCursors("server-01"), service.summary({ range: 1 })]);
    assert.equal(Object.keys(cursors).length, 1);
    assert.equal(first.kpis.calls, 1);
    assert.equal((await service.summary({ range: 1 })).kpis.calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("保留期：常驻进程时钟前进 91 天，不等新扫描，摘要的 coverageStart 前移、旧调用消失", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-service-retention-"));
  try {
    let clock = NOW;
    const store = createUsageStore({ rootDir: dir, now: () => clock });
    const service = createUsageService({
      store, getConfig: async () => config, dataDir: dir, probeSshFailureReason: () => "", now: () => clock,
      execCollector: async () => ({ code: 0, stdout: OUTPUT, stderr: "" }),
    });
    await service.runScan("server-01");
    const before = await service.summary({ range: 30 });
    assert.equal(before.coverageStart, "2026-10-02");
    assert.equal(before.kpis.calls, 1);

    clock = NOW + 91 * 86400 * 1000;
    const after = await service.summary({ range: 30 });
    assert.equal(after.coverageStart, null);
    assert.equal(after.kpis.calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("关闭用量模块后不扫描", async () => {
  const service = createUsageService({ store: {}, getConfig: async () => ({ ...config, modules: { usage: false } }), execCollector: () => assert.fail("disabled scan") });
  assert.equal((await service.runScan("server-01")).level, "skipped");
});
