// resource-usage 行为测试（T03，验收 A12–A16）。纯函数，无 IO，无真实集群。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildResourceUsage,
  computeCpuBusy,
  computeLoadNormalizedPct,
  humanSizeToBytes,
  USAGE_SCHEMA_VERSION,
} from "./resource-usage.mjs";
import { parseCpuStat, parseFilesystem } from "./collector.mjs";
import { buildLegacyMetricSamples, procStatLine, FIXTURE_BOOT_ID, FIXTURE_MOUNT } from "./m1-fixtures.mjs";

const BOOT = FIXTURE_BOOT_ID;

function cpuStatFixture({ user = 100, nice = 0, system = 50, idle = 800, iowait = 20, irq = 0, softirq = 10, steal = 0, guest = 0, guest_nice = 0, bootId = BOOT } = {}) {
  return parseCpuStat(`cpu=${procStatLine({ user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice }).replace(/^cpu\s*/, "")}\nboot_id=${bootId}\n`);
}

// ---- A12: 首样本 / 正常差分 / 重启 / 计数器回退 ----

test("A12: 首样本（无上一帧）→ busyPct=null 且 quality=insufficient，不补零", () => {
  const usage = buildResourceUsage({ prev: null, cpuStat: cpuStatFixture(), sysText: "nproc: 4", checkedAt: 1000 });
  assert.equal(usage.cpu.busyPct, null);
  assert.equal(usage.cpu.quality, "insufficient");
});

test("A12: 正常差分——公式正确且上限 100", () => {
  const first = cpuStatFixture({ user: 100, nice: 0, system: 50, idle: 800, iowait: 20, irq: 0, softirq: 10, steal: 0 });
  // 第二帧：deltaTotal = 1110-980 = 130；deltaIdle = (890+20)-(800+20) = 90
  // → busy = (130-90)/130 = 30.8%。
  const second = cpuStatFixture({ user: 130, nice: 0, system: 60, idle: 890, iowait: 20, irq: 0, softirq: 10, steal: 0 });
  const diff = computeCpuBusy(first, second, { prevBootId: BOOT, currBootId: BOOT });
  assert.equal(diff.busyPct, 30.8);
  assert.equal(diff.quality, "ok");
  const usage = buildResourceUsage({
    prev: { counters: first, bootId: BOOT },
    cpuStat: second,
    sysText: "nproc: 4",
    checkedAt: 2000,
  });
  assert.equal(usage.cpu.busyPct, 30.8);
  assert.equal(usage.schemaVersion, USAGE_SCHEMA_VERSION);
});

test("A12: boot_id 改变（重启）→ busyPct=null 且 quality=reset", () => {
  const first = cpuStatFixture({ bootId: "boot-old" });
  const second = cpuStatFixture({ bootId: BOOT });
  const diff = computeCpuBusy(first, second, { prevBootId: "boot-old", currBootId: BOOT });
  assert.equal(diff.busyPct, null);
  assert.equal(diff.quality, "reset");
});

test("A12: 计数器回退 / deltaTotal<=0 → 不出现负值，quality=reset", () => {
  const first = cpuStatFixture({ idle: 800 });
  const regress = cpuStatFixture({ idle: 700, user: 50 });
  const diff = computeCpuBusy(first, regress, { prevBootId: BOOT, currBootId: BOOT });
  assert.equal(diff.busyPct, null);
  assert.equal(diff.quality, "reset");
  const same = cpuStatFixture({ idle: 800 });
  const frozen = computeCpuBusy(first, same, { prevBootId: BOOT, currBootId: BOOT });
  assert.equal(frozen.busyPct, null);
  assert.ok(frozen.deltaTotal <= 0);
});

// ---- A13: guest 不重复相加；busy 与负载分别展示；负载可 >100 ----

test("A13: guest/guest_nice 不重复相加（它们的值不影响 busy 差分）", () => {
  const a = computeCpuBusy(
    cpuStatFixture({ idle: 800, guest: 0, guest_nice: 0 }),
    cpuStatFixture({ idle: 900, guest: 0, guest_nice: 0 }),
    { prevBootId: BOOT, currBootId: BOOT },
  );
  const b = computeCpuBusy(
    cpuStatFixture({ idle: 800, guest: 500, guest_nice: 300 }),
    cpuStatFixture({ idle: 900, guest: 560, guest_nice: 310 }),
    { prevBootId: BOOT, currBootId: BOOT },
  );
  // Linux 的 user/nice 已包含 guest 时间：本实现不读 guest 列，两帧差分一致。
  assert.equal(a.busyPct, b.busyPct);
});

test("A13: loadNormalizedPct 可超过 100；busy 恒在 0–100", () => {
  assert.equal(computeLoadNormalizedPct(38.4, 32), 120);
  assert.equal(computeLoadNormalizedPct(2.4, 96), 2.5);
  assert.equal(computeLoadNormalizedPct(null, 32), null);
  assert.equal(computeLoadNormalizedPct(2, 0), null);
  const over = computeCpuBusy(
    cpuStatFixture({ idle: 800, user: 100 }),
    cpuStatFixture({ idle: 810, user: 200 }),
    { prevBootId: BOOT, currBootId: BOOT },
  );
  assert.ok(over.busyPct <= 100 && over.busyPct >= 0);
});

// ---- A14: 共享文件系统与个人配额分开 ----

test("A14: 共享 44TB 文件系统照实展示，quota 恒为 unknown，字节换算正确", () => {
  const fs = parseFilesystem([
    "state=ok",
    `device=/dev/mapper/share-home`,
    "total_kb=43980465111040",
    "used_kb=38000000000000",
    "avail_kb=5980465111040",
    "capacity_pct=86",
    `mount=${FIXTURE_MOUNT}`,
    "inodes_total=2147483648",
    "inodes_used=98765432",
    "inode_pct=5",
  ].join("\n"));
  const usage = buildResourceUsage({ filesystem: fs, sysText: "", checkedAt: 1000 });
  assert.equal(usage.filesystem.mountpoint, FIXTURE_MOUNT);
  assert.equal(usage.filesystem.totalBytes, 43980465111040 * 1024);
  assert.equal(usage.filesystem.usedBytes, 38000000000000 * 1024);
  assert.equal(usage.filesystem.usedPct, 86, "df 原值（可用空间口径）直接透出，不自行换算");
  assert.equal(usage.filesystem.inodeUsedPct, 5);
  assert.deepEqual(usage.quota, { state: "unknown" }, "个人配额未知，不得用共享卷占用填充");
});

test("A14: filesystem 段缺失/unavailable → null，不是空对象冒充已测", () => {
  assert.equal(buildResourceUsage({ filesystem: null }).filesystem, null);
  const unavailable = parseFilesystem("state=unavailable\n");
  assert.equal(buildResourceUsage({ filesystem: unavailable }).filesystem, null);
});

// ---- A15: 旧历史兼容 ----

test("A15: 旧 metrics 样本不被重新解释（无新字段），legacy cpu 仍是归一化负载", () => {
  for (const sample of buildLegacyMetricSamples({ count: 2 })) {
    assert.equal(sample.cpuBusyPct, undefined);
    assert.equal(sample.loadNormalizedPct, undefined);
  }
});

test("A15: cpu-stat/filesystem 段缺失（旧采集脚本）→ busy insufficient，不抛错", () => {
  const usage = buildResourceUsage({
    prev: null,
    cpuStat: null,
    filesystem: null,
    sysText: "node05\nload average: 1.00\nMem: 251Gi 31Gi 120Gi\nnproc: 64",
    checkedAt: 1000,
  });
  assert.equal(usage.cpu.busyPct, null);
  assert.equal(usage.cpu.load1, 1.0, "sys 段的 load1 仍然可解析");
  assert.equal(usage.cpu.loadNormalizedPct, 1.6);
  assert.equal(usage.memory.totalBytes, 251 * 1024 ** 3, "free -h 的 GiB 字段换算为字节");
  assert.equal(usage.memory.usedBytes, 31 * 1024 ** 3);
});

// ---- A16: 无 GPU / GPU 低利用率不推断"可申请" ----

test("A16: usage 不产生任何'可申请/剩余配额'字段", () => {
  const usage = buildResourceUsage({ cpuStat: cpuStatFixture(), sysText: "nproc: 4", checkedAt: 1000 });
  assert.ok(!("gpuAvailable" in usage));
  assert.ok(!("gpuFree" in usage));
});

// ---- humanSizeToBytes / 段解析畸形输入 ----

test("humanSizeToBytes: Ki/Mi/Gi/Ti 与裸数字；畸形返回 null", () => {
  assert.equal(humanSizeToBytes("251Gi"), 251 * 1024 ** 3);
  assert.equal(humanSizeToBytes("31.5Gi"), Math.round(31.5 * 1024 ** 3));
  assert.equal(humanSizeToBytes("642Mi"), 642 * 1024 ** 2);
  assert.equal(humanSizeToBytes("1.4Ti"), Math.round(1.4 * 1024 ** 4));
  assert.equal(humanSizeToBytes("1024"), 1024);
  assert.equal(humanSizeToBytes("abc"), null);
  assert.equal(humanSizeToBytes(""), null);
  assert.equal(humanSizeToBytes(null), null);
});

test("cpu-stat/filesystem 解析对畸形输入逐字段降级", () => {
  const badCpu = parseCpuStat("cpu=unknown\nboot_id=not-valid!!");
  assert.equal(badCpu.present, true);
  assert.equal(badCpu.user, null);
  assert.equal(badCpu.bootId, null);
  const emptyCpu = parseCpuStat("");
  assert.equal(emptyCpu.present, false);
  const badFs = parseFilesystem("state=ok\ntotal_kb=abc\ncapacity_pct=-3\nmount=");
  assert.equal(badFs.totalKb, null);
  assert.equal(badFs.capacityPct, null);
  assert.equal(badFs.mount, null);
});
