// 坏文件留档的跨模块接线（v2.64，lib/corrupt-archive.mjs）：runtime 下各 JSON 存储读到解析不了的文件时，
// 一律先改名留档（<名字>.corrupt-<北京时间>，0600）、经自己的 logger 记一条 ops 警告，再按空表重建；
// 装配处给每个存储都接上了 appendLog。全程只在临时目录里。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBriefStore } from "../work/monitor/lib/brief/store.mjs";
import { CORRUPT_EVENT } from "../work/monitor/lib/corrupt-archive.mjs";
import { createDirUsageStore, DIR_USAGE_FILE } from "../work/monitor/lib/dir-usage/store.mjs";
import { createDiskGrowthStore, DISK_GROWTH_FILE } from "../work/monitor/lib/disk-growth/store.mjs";
import { createIncidentPersister } from "../work/monitor/lib/incidents/persister.mjs";
import { createIncidentStore } from "../work/monitor/lib/incidents/store.mjs";
import { createDiagnosesStore, DIAGNOSES_FILE } from "../work/monitor/lib/jobs/diagnoses-store.mjs";
import { createJobRegistry, REGISTRY_FILE } from "../work/monitor/lib/jobs/registry.mjs";
import { createSubrunStore, SUBRUNS_FILE } from "../work/monitor/lib/jobs/subrun-store.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "../work/monitor/lib/jobs/watch-store.mjs";
import { createMetricsStore } from "../work/monitor/lib/metrics-store.mjs";
import { createGuideStore } from "../work/monitor/lib/onboarding-guide/store.mjs";
import { createUsageStore } from "../work/monitor/lib/usage/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";
const NOW = Date.UTC(2026, 9, 14, 1, 5, 7); // 北京时间 2026-10-14 09:05:07
const STAMP = "20261014-090507";
const GARBAGE = '{"truncated": [1, 2, ';

function tmpRuntime(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-corrupt-wiring-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plant(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, GARBAGE, { mode: 0o644 });
}

function assertArchived(filePath, logs, label) {
  const archive = `${filePath}.corrupt-${STAMP}`;
  assert.equal(fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === GARBAGE, false, `${label}：坏文件不再留在原处`);
  assert.equal(fs.readFileSync(archive, "utf8"), GARBAGE, `${label}：留档内容就是原文件`);
  if (posix) assert.equal(fs.statSync(archive).mode & 0o777, 0o600, `${label}：留档 0600`);
  const warn = logs.find((entry) => entry.fields?.event === CORRUPT_EVENT && entry.fields.file === path.basename(filePath));
  assert.ok(warn, `${label}：记了一条 store-corrupt 警告`);
  assert.equal(warn.fields.level, "warn");
  assert.doesNotMatch(warn.message, /truncated/, `${label}：日志里没有文件内容`);
}

const collector = () => {
  const logs = [];
  return { logs, log: (message, fields) => logs.push({ message, fields }) };
};

const STORES = [
  {
    label: "磁盘增长归因",
    file: (rt) => path.join(rt, DISK_GROWTH_FILE),
    async run(filePath, log) {
      const store = createDiskGrowthStore({ filePath, log, now: () => NOW });
      assert.equal(await store.get("server-01"), null);
      await store.update("server-01", (draft) => { draft.home = "/home/amy"; });
    },
  },
  {
    label: "作业关注与提醒规则",
    file: (rt) => path.join(rt, JOB_WATCH_FILE),
    async run(filePath, log) {
      const store = createJobWatchStore({ filePath, log, now: () => NOW });
      assert.deepEqual((await store.snapshot()).watches, []);
      await store.update((data) => { data.quietUntil = NOW; });
    },
  },
  {
    label: "编排作业子任务游标",
    file: (rt) => path.join(rt, SUBRUNS_FILE),
    async run(filePath, log) {
      const store = createSubrunStore({ filePath, log, now: () => NOW });
      assert.deepEqual((await store.snapshot()).jobs, []);
    },
  },
  {
    label: "作业登记",
    file: (rt) => path.join(rt, REGISTRY_FILE),
    async run(filePath, log) {
      const store = createJobRegistry({ filePath, log, now: () => NOW });
      await store.load();
      assert.equal(store.size(), 0);
    },
  },
  {
    label: "失败作业诊断",
    file: (rt) => path.join(rt, DIAGNOSES_FILE),
    async run(filePath, log) {
      const store = createDiagnosesStore({ filePath, log, now: () => NOW });
      await store.load();
      assert.equal(store.size(), 0);
    },
  },
  {
    label: "目录占用扫描",
    file: (rt) => path.join(rt, DIR_USAGE_FILE),
    async run(filePath, log) {
      const store = createDirUsageStore({ filePath, log, now: () => NOW });
      assert.deepEqual(await store.list("server-01"), []);
    },
  },
  {
    label: "资源指标",
    file: (rt) => path.join(rt, "metrics.json"),
    async run(filePath, log) {
      const store = createMetricsStore({ filePath, log, now: () => NOW });
      store.load();
      assert.deepEqual(store.query({}).samples, []);
      await store.dispose?.();
    },
  },
  {
    label: "接入引导进度",
    file: (rt) => path.join(rt, "onboarding-guide.json"),
    async run(filePath, log) {
      const store = createGuideStore({ filePath, stepIds: ["hostkey"], log, now: () => NOW });
      assert.equal(store.load().phase, "idle");
    },
  },
  {
    label: "Agent 用量（游标）",
    file: (rt) => path.join(rt, "usage", "server-01", "cursors.json"),
    async run(filePath, log) {
      const store = createUsageStore({ rootDir: path.dirname(path.dirname(filePath)), log, now: () => NOW });
      assert.deepEqual(await store.getCursors("server-01"), {});
    },
  },
  {
    label: "简报归档",
    file: (rt) => path.join(rt, "briefs", "2026-10-13.json"),
    async run(filePath, log) {
      const store = createBriefStore({ dir: path.dirname(filePath), log, now: () => NOW });
      assert.equal(await store.read("2026-10-13"), null);
      assert.deepEqual(await store.listDays(), [], "留档不会被当成某一天的简报");
    },
  },
];

for (const entry of STORES) {
  test(`${entry.label}：解析不了 → 留档 + ops 警告 → 按空表重建`, async (t) => {
    const rt = tmpRuntime(t);
    const filePath = entry.file(rt);
    plant(filePath);
    const { logs, log } = collector();
    await entry.run(filePath, log);
    assertArchived(filePath, logs, entry.label);
  });
}

test("事件记录：主文件与已关闭文件各自留档，按空表加载", async (t) => {
  const rt = tmpRuntime(t);
  const filePath = path.join(rt, "incidents.json");
  const closedPath = path.join(rt, "incidents-closed.json");
  plant(filePath);
  plant(closedPath);
  const { logs, log } = collector();
  const store = createIncidentStore({ now: () => NOW, log: () => {} });
  const persister = createIncidentPersister({ store, filePath, log, now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await persister.load();
  persister.dispose();
  assertArchived(filePath, logs, "事件主文件");
  assertArchived(closedPath, logs, "已关闭事件");
});

test("读不出（不是解析失败）的文件不留档：只有内容坏了才挪走", async (t) => {
  const rt = tmpRuntime(t);
  const filePath = path.join(rt, JOB_WATCH_FILE);
  fs.mkdirSync(filePath); // 读它会 EISDIR
  const { logs, log } = collector();
  const store = createJobWatchStore({ filePath, log, now: () => NOW });
  await store.snapshot();
  assert.ok(fs.statSync(filePath).isDirectory());
  assert.equal(logs.some((entry) => entry.fields?.event === CORRUPT_EVENT), false);
});

test("装配处给每个会留档的存储都接上了 ops 日志", () => {
  const start = fs.readFileSync(path.join(ROOT, "work/monitor/server/start.mjs"), "utf8");
  for (const pattern of [
    /createUsageStore\(\{[^}]*log: appendLog/,
    /createJobRegistry\(\{[^}]*log: appendLog/,
    /createDiagnosesStore\(\{[^}]*log: appendLog/,
    /createJobWatchStore\(\{[^}]*log: appendLog/,
    /createDirUsageStore\(\{[^}]*log: appendLog/,
    /createDiskGrowthStore\(\{[^}]*log: appendLog/,
    /createProxyAuthStore\(\{[^}]*log: appendLog/,
  ]) assert.match(start, pattern);
  assert.match(fs.readFileSync(path.join(ROOT, "work/monitor/server/kernel.mjs"), "utf8"), /createMetricsStore\(\{[^}]*log: appendLog/);
  assert.match(fs.readFileSync(path.join(ROOT, "work/monitor/server/incident-sync.mjs"), "utf8"), /createIncidentPersister\(\{[^}]*log: appendLog/);
});
