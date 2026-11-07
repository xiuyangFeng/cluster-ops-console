// 资源面板模型 / HTML 片段的纯函数测试（无 DOM）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDelta,
  buildResourcePanelModel,
  diskOutlook,
  formatSize,
  formatUptime,
  metricSampleValues,
  parseHumanSize,
  pickCpuMetric,
  RESOURCE_STALE_MS,
  resourceCadenceText,
  shortGpuName,
  withSampleDeltas,
  withTrendNotes,
} from "./resources-model.js";
import { buildGpuSummaryHtml, buildGpuTableHtml, buildResourceNoticeHtml, buildTileBodyHtml, compactGpuModel } from "./resources-view.js";
import { formatBytePair } from "../store.js";

const NOW = 1_800_000_000_000;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

// 新版 sys 段原文（free -h 带表头与 available 列，df -h $HOME，nproc 标签行）。
const SYS = [
  "node05",
  " 14:20:01 up 12 days,  3:42,  2 users,  load average: 16.00, 15.20, 14.80",
  "               total        used        free      shared  buff/cache   available",
  "Mem:           251Gi        98Gi        40Gi       1.0Gi       113Gi       150Gi",
  "/dev/mapper/home  1.8T  1.1T  620G  65% /home",
  "nproc: 64",
].join("\n");

function usage(over = {}) {
  return {
    schemaVersion: 1,
    checkedAt: NOW - 12_000,
    cpu: { busyPct: 37.4, load1: 0.52, logicalCores: 64, loadNormalizedPct: 0.8, quality: "ok", ...(over.cpu || {}) },
    memory: { usedBytes: 98.2 * GiB, totalBytes: 251 * GiB, ...(over.memory || {}) },
    filesystem: over.filesystem === null ? null : {
      device: "nfs:/export/home",
      mountpoint: "/home",
      usedBytes: 1.1 * TiB,
      totalBytes: 1.8 * TiB,
      availBytes: 620 * GiB,
      usedPct: 62,
      inodeUsedPct: 12,
      ...(over.filesystem || {}),
    },
    quota: { state: "unknown" },
  };
}

function layer(over = {}) {
  return { level: "ok", reason: "负载已更新", checkedAt: NOW - 12_000, output: SYS, gpu: [], usage: usage(), ...over };
}

// ---- 格式化与解析小件 ----

test("parseHumanSize: free/df 后缀归一；认不出返回 null", () => {
  assert.equal(parseHumanSize("251Gi"), 251 * GiB);
  assert.equal(parseHumanSize("1.8T"), Math.round(1.8 * TiB));
  assert.equal(parseHumanSize("642Mi"), 642 * 1024 ** 2);
  assert.equal(parseHumanSize("512M"), 512 * 1024 ** 2);
  assert.equal(parseHumanSize("0"), 0);
  assert.equal(parseHumanSize("12GiB"), 12 * GiB);
  for (const bad of ["", null, "abc", "12X", "-1G"]) assert.equal(parseHumanSize(bad), null);
});

test("formatBytePair(compact) / formatSize: 按总量选单位，≥100 取整、其余一位小数", () => {
  const compact = { compact: true };
  assert.equal(formatBytePair(98.2 * GiB, 251 * GiB, compact), "98.2 / 251 GiB");
  assert.equal(formatBytePair(1.1 * TiB, 1.8 * TiB, compact), "1.1 / 1.8 TiB");
  assert.equal(formatBytePair(0, 16 * GiB, compact), "0 / 16 GiB");
  assert.equal(formatBytePair(null, 16 * GiB, compact), "");
  assert.equal(formatBytePair(1, 0, compact), "");
  assert.equal(formatSize(620 * GiB), "620 GiB");
  assert.equal(formatSize(152.8 * GiB), "153 GiB");
  assert.equal(formatSize(1.5 * GiB), "1.5 GiB");
  assert.equal(formatSize(null), "未知");
});

test("formatUptime: uptime 原文 → 中文时长；认不出返回空串", () => {
  assert.equal(formatUptime("up 12 days,  3:42,  2 users"), "已运行 12 天 3 小时");
  assert.equal(formatUptime("up 1 day, 5 min,  1 user"), "已运行 1 天");
  assert.equal(formatUptime("up 3:42,  1 user"), "已运行 3 小时 42 分");
  assert.equal(formatUptime("up 5 min,  1 user"), "已运行 5 分钟");
  assert.equal(formatUptime("up 2 hrs"), "已运行 2 小时");
  assert.equal(formatUptime("未知"), "");
  assert.equal(formatUptime(null), "");
});

test("shortGpuName: 去掉 NVIDIA / GeForce / Tesla 前缀", () => {
  assert.equal(shortGpuName("NVIDIA GeForce RTX 4090"), "RTX 4090");
  assert.equal(shortGpuName("NVIDIA A100-SXM4-80GB"), "A100-SXM4-80GB");
  assert.equal(shortGpuName("Tesla V100-SXM2-32GB"), "V100-SXM2-32GB");
  assert.equal(shortGpuName("NVIDIA RTX A6000"), "RTX A6000");
  assert.equal(shortGpuName(""), "");
  assert.equal(shortGpuName(null), "");
});

// ---- CPU 口径统一 ----

test("pickCpuMetric: busy → 归一化负载 → legacy；全缺返回 null", () => {
  assert.deepEqual(pickCpuMetric({ busyPct: 37, loadNormalizedPct: 80 }), { value: 37, kind: "busy" });
  assert.deepEqual(pickCpuMetric({ busyPct: null, loadNormalizedPct: 125 }), { value: 125, kind: "load" });
  assert.deepEqual(pickCpuMetric({ legacyLoadPct: 40 }), { value: 40, kind: "load" });
  assert.deepEqual(pickCpuMetric({ busyPct: 0 }), { value: 0, kind: "busy" }); // 0 是真实值，不是缺失
  assert.deepEqual(pickCpuMetric({}), { value: null, kind: null });
});

test("metricSampleValues: 历史样本与 tile 同口径；新样本缺口径时不混入 legacy cpu", () => {
  assert.deepEqual(metricSampleValues({ cpu: 100, ram: 40, disk: 60, cpuBusyPct: 37.5, loadNormalizedPct: 130, metricSchemaVersion: 1 }), { cpu: 37.5, ram: 40, disk: 60 });
  assert.deepEqual(metricSampleValues({ cpu: 100, ram: 40, disk: 60, cpuBusyPct: null, loadNormalizedPct: 130, metricSchemaVersion: 1 }), { cpu: 130, ram: 40, disk: 60 });
  assert.equal(metricSampleValues({ cpu: 100, cpuBusyPct: null, loadNormalizedPct: null, metricSchemaVersion: 1 }).cpu, null);
  // 旧采集脚本：只有 legacy cpu（归一化负载）
  assert.equal(metricSampleValues({ cpu: 46, ram: 1, disk: 2 }).cpu, 46);
  assert.deepEqual(metricSampleValues(null), { cpu: null, ram: null, disk: null });
});

// ---- 面板模型 ----

test("未知数据：没有任何采样 → 三块都「未采集」、级别 unknown、GPU 区隐藏", () => {
  for (const input of [{}, { layer: null, remoteLoad: null }, { remoteLoad: { ok: false, output: "" } }]) {
    const m = buildResourcePanelModel({ ...input, host: "fixture.invalid", now: NOW });
    assert.equal(m.hasData, false);
    assert.equal(m.host, "fixture.invalid");
    for (const t of Object.values(m.tiles)) {
      assert.equal(t.display, "未采集");
      assert.equal(t.value, null);
      assert.equal(t.level, "unknown");
      assert.equal(t.gauge, 0);
      assert.deepEqual(t.details, ["等待首次采样"]);
    }
    assert.equal(m.tiles.disk.note, "");
    assert.deepEqual(m.gpu, { cards: [], summary: null, groups: [] });
    assert.equal(m.freshness.level, "unknown");
    assert.equal(m.freshness.text, "尚未采样");
    assert.deepEqual(m.sample, { cpu: null, cpuKind: null, ram: null, disk: null });
  }
});

test("新采集口径（usage）：CPU 利用率 + 负载明细、内存字节对、共享卷与配额说明", () => {
  const m = buildResourcePanelModel({ layer: layer(), remoteLoad: { ok: true, output: SYS }, host: "fb", now: NOW });
  assert.equal(m.host, "node05");
  const { cpu, memory, disk } = m.tiles;
  assert.equal(cpu.title, "CPU");
  assert.equal(cpu.qualifier, "利用率");
  assert.equal(cpu.display, "37");
  assert.equal(cpu.unit, "%");
  assert.equal(cpu.level, "ok");
  assert.deepEqual(cpu.details, ["负载 0.52 · 64 核", "已运行 12 天 3 小时"]);
  assert.equal(cpu.note, "");
  assert.equal(memory.title, "内存");
  assert.equal(memory.display, "39");
  // "可用"取 free 的 available 列（150Gi），不是 total-used
  assert.deepEqual(memory.details, ["98.2 / 251 GiB", "可用 150 GiB"]);
  assert.equal(disk.title, "磁盘");
  assert.equal(disk.display, "62"); // df capacity 原值优先于 used/total 自算
  // 挂载点并在注释行里，明细行只留容量（腾出的位置给走势判断与范围高低值，见 withTrendNotes）
  assert.deepEqual(disk.details, ["1.1 / 1.8 TiB · 剩余 620 GiB"]);
  assert.equal(disk.note, "共享卷 /home（$HOME 所在）· 个人配额未知");
  assert.deepEqual(m.sample, { cpu: 37.4, cpuKind: "busy", ram: (98.2 / 251) * 100, disk: 62 });
  assert.equal(m.freshness.level, "ok");
  assert.equal(m.freshness.text, "采样于 12 秒前");
  assert.match(m.freshness.title, /采样时间 .* · 每 60 秒采样一次/);
});

test("busyPct 为 null（首样本/重置）：大字回落归一化负载并标注「负载估算」，可 >100", () => {
  const insufficient = buildResourcePanelModel({
    layer: layer({ usage: usage({ cpu: { busyPct: null, loadNormalizedPct: 125, load1: 80, quality: "insufficient" } }) }),
    now: NOW,
  });
  const cpu = insufficient.tiles.cpu;
  assert.equal(cpu.value, 125);
  assert.equal(cpu.display, "125");
  assert.equal(cpu.gauge, 100); // 仪表封顶，数字不封顶
  assert.equal(cpu.qualifier, "负载估算");
  assert.equal(cpu.level, "critical");
  assert.equal(cpu.note, "利用率需两次采样，暂以负载估算");
  assert.equal(insufficient.sample.cpuKind, "load");
  const reset = buildResourcePanelModel({
    layer: layer({ usage: usage({ cpu: { busyPct: null, loadNormalizedPct: 10, quality: "reset" } }) }),
    now: NOW,
  });
  assert.equal(reset.tiles.cpu.note, "采样计数已重置，暂以负载估算");
  // busy 与负载都缺（旧 nproc 缺失）→ 未知，不拿 load1×100 冒充
  const none = buildResourcePanelModel({
    layer: layer({ output: "", usage: usage({ cpu: { busyPct: null, loadNormalizedPct: null, logicalCores: null } }) }),
    now: NOW,
  });
  assert.equal(none.tiles.cpu.value, null);
  assert.equal(none.tiles.cpu.display, "未知");
  assert.deepEqual(none.tiles.cpu.details, ["负载 0.52 · 核数未知"]);
});

test("旧采集脚本（usage=null）：全部回落解析 sys 原文", () => {
  const m = buildResourcePanelModel({ layer: { level: "ok", checkedAt: NOW - 3000, output: SYS, gpu: [], usage: null }, remoteLoad: { ok: true, output: SYS }, now: NOW });
  assert.equal(m.tiles.cpu.value, 25); // 16 / 64
  assert.equal(m.tiles.cpu.qualifier, "负载估算");
  assert.equal(m.tiles.cpu.note, "暂以负载估算");
  assert.equal(m.tiles.memory.display, "39");
  assert.deepEqual(m.tiles.memory.details, ["98 / 251 GiB", "可用 150 GiB"]);
  assert.equal(m.tiles.disk.value, 65);
  assert.deepEqual(m.tiles.disk.details, ["1.1 / 1.8 TiB · 剩余 620 GiB"]);
  assert.equal(m.tiles.disk.note, "共享卷 /home（$HOME 所在）· 个人配额未知");
  assert.equal(m.freshness.text, "刚刚采样");
  // 更老的输出（无 nproc）：CPU 未知而不是 load1×100
  const ancient = buildResourcePanelModel({ remoteLoad: { ok: true, output: "h\n up 1 day, load average: 0.52, 0.4, 0.3\nMem: 31G 12G 18G\n/dev/sda1 458G 120G 315G 28% /" }, now: NOW });
  assert.equal(ancient.tiles.cpu.value, null);
  assert.equal(ancient.tiles.memory.value, (12 / 31) * 100);
  assert.equal(ancient.tiles.disk.value, 28);
  assert.equal(ancient.freshness.text, "采样时间未知");
});

test("磁盘 95%：严重档；inode 逼近告警线才显示并参与分档", () => {
  const full = buildResourcePanelModel({
    layer: layer({ usage: usage({ filesystem: { usedPct: 95, usedBytes: 1.71 * TiB, availBytes: 90 * GiB } }) }),
    now: NOW,
  });
  assert.equal(full.tiles.disk.level, "critical");
  assert.equal(full.tiles.disk.display, "95");
  assert.equal(full.tiles.disk.details[0], "1.7 / 1.8 TiB · 剩余 90 GiB");
  const inodes = buildResourcePanelModel({
    layer: layer({ usage: usage({ filesystem: { usedPct: 40, inodeUsedPct: 93 } }) }),
    now: NOW,
  });
  assert.equal(inodes.tiles.disk.level, "critical"); // inode 满同样写不进文件
  assert.equal(inodes.tiles.disk.details[1], "inode 93%");
  assert.equal(buildResourcePanelModel({ layer: layer(), now: NOW }).tiles.disk.details.length, 1, "inode 不高时不占明细位");
});

test("磁盘注释行：挂载点并进「共享卷」说明；配额已知时只写挂载点；挂载点未知时不留空格", () => {
  const noteOf = (over) => buildResourcePanelModel({ layer: layer({ output: "", usage: { ...usage(over), ...(over.quota ? { quota: over.quota } : {}) } }), now: NOW }).tiles.disk.note;
  assert.equal(noteOf({}), "共享卷 /home（$HOME 所在）· 个人配额未知");
  assert.equal(noteOf({ filesystem: { mountpoint: "" } }), "共享卷（$HOME 所在）· 个人配额未知");
  assert.equal(noteOf({ quota: { state: "ok" } }), "挂载点 /home");
  assert.equal(noteOf({ quota: { state: "ok" }, filesystem: { mountpoint: "" } }), "");
});

test("分档沿用 thresholds.js：内存 70 警告 / 90 严重，CPU 85 严重", () => {
  const at = (usedPct) => buildResourcePanelModel({
    layer: layer({ output: "", usage: usage({ memory: { usedBytes: usedPct, totalBytes: 100 } }) }),
    now: NOW,
  }).tiles.memory.level;
  assert.equal(at(69), "ok");
  assert.equal(at(70), "warn");
  assert.equal(at(90), "critical");
  const cpu = buildResourcePanelModel({ layer: layer({ usage: usage({ cpu: { busyPct: 85 } }) }), now: NOW }).tiles.cpu;
  assert.equal(cpu.level, "critical");
});

test("无 GPU（空数组/缺字段/畸形）：GPU 区隐藏", () => {
  for (const gpu of [[], undefined, null, "x", [null, 42]]) {
    assert.deepEqual(buildResourcePanelModel({ layer: layer({ gpu }), now: NOW }).gpu, { cards: [], summary: null, groups: [] });
  }
});

test("8 卡：摘要（卡数/型号/平均利用率/显存合计/空闲卡）+ 每卡显存按 gpuMemory 分档", () => {
  const gpu = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    name: "NVIDIA A100-SXM4-80GB",
    memUsedMb: [0, 400, 40960, 65536, 78643, 81000, 20480, 300][i],
    memTotalMb: 81920,
    util: [0, 3, 50, 90, 100, 97, 20, 0][i],
  }));
  const m = buildResourcePanelModel({ layer: layer({ gpu }), now: NOW });
  assert.equal(m.gpu.cards.length, 8);
  const s = m.gpu.summary;
  assert.equal(s.count, 8);
  assert.equal(s.model, "A100-SXM4-80GB");
  assert.equal(s.avgUtil, 45); // (0+3+50+90+100+97+20+0)/8 = 45
  assert.equal(s.idle, 3); // #0 #1 #7：利用率 ≤5% 且显存 <10%
  assert.equal(s.memText, `${((0 + 400 + 40960 + 65536 + 78643 + 81000 + 20480 + 300) / 1024).toFixed(1)} / 640.0 GB`);
  const [c0, , c2, c3, c4] = m.gpu.cards;
  assert.equal(c0.name, "A100-SXM4-80GB");
  assert.equal(c0.figures, "0% · 0.0 / 80.0 GB");
  assert.equal(c0.memLevel, "ok");
  assert.equal(c2.memLevel, "ok"); // 50%
  assert.equal(c3.memLevel, "warn"); // 80%
  assert.equal(c4.memLevel, "critical"); // 96%
  assert.match(c4.title, /^#4 NVIDIA A100-SXM4-80GB · 利用率 100% · 显存 76\.8 \/ 80\.0 GB$/);
  // 混合型号：摘要不写型号
  const mixed = buildResourcePanelModel({ layer: layer({ gpu: [gpu[0], { ...gpu[1], name: "NVIDIA H100 80GB HBM3" }] }), now: NOW });
  assert.equal(mixed.gpu.summary.model, "");
  // 字段缺失：不出 NaN，写「未知」
  const partial = buildResourcePanelModel({ layer: layer({ gpu: [{ index: 3 }] }), now: NOW }).gpu;
  assert.equal(partial.cards[0].name, "GPU 3");
  assert.equal(partial.cards[0].util, null);
  assert.equal(partial.cards[0].memLevel, "unknown");
  assert.equal(partial.cards[0].figures, "利用率未知 · 显存未知");
  assert.equal(partial.summary.avgUtil, null);
  assert.equal(partial.summary.memText, "");
});

test("新鲜度：陈旧转 warn、采集失败转 error（显示残留数据的采样时刻）、跳过为 unknown", () => {
  const stale = buildResourcePanelModel({ layer: layer({ usage: { ...usage(), checkedAt: NOW - RESOURCE_STALE_MS - 60_000 } }), now: NOW });
  assert.equal(stale.freshness.level, "warn");
  assert.equal(stale.freshness.text, "数据较旧 · 采样于 4 分钟前");
  const failed = buildResourcePanelModel({ layer: layer({ level: "error", reason: "采集失败 (ssh 超时)", checkedAt: NOW - 2000 }), now: NOW });
  assert.equal(failed.freshness.level, "error");
  assert.equal(failed.freshness.text, "采集失败 · 数据采于 12 秒前");
  assert.match(failed.freshness.title, /^采集失败 \(ssh 超时\) · 采样时间 .* · 最近尝试 /);
  assert.equal(failed.hasData, true); // 残留数据照常显示，由胶囊说明它不新鲜
  // 旧通路 ok:false 且带着上次输出（无 usage）：采样时刻未知
  const legacyFailed = buildResourcePanelModel({ remoteLoad: { ok: false, output: SYS }, layer: { checkedAt: NOW - 1000 }, now: NOW });
  assert.equal(legacyFailed.freshness.text, "采集失败 · 显示上次数据");
  const skipped = buildResourcePanelModel({ layer: { level: "skipped", reason: "探针已跳过", checkedAt: NOW }, now: NOW });
  assert.equal(skipped.freshness.level, "unknown");
  assert.equal(skipped.freshness.text, "采样已暂停");
});

test("环比：按上一采样给方向与点差；持平不显示；CPU 口径不同不比较", () => {
  assert.equal(buildDelta(null, 40), null);
  assert.equal(buildDelta(40, 40.3), null);
  assert.deepEqual(buildDelta(33.2, 37.4), { dir: "up", text: "↑ 4.2", title: "较上一采样 +4.2 个百分点" });
  assert.deepEqual(buildDelta(60, 40), { dir: "down", text: "↓ 20", title: "较上一采样 −20 个百分点" });
  const base = buildResourcePanelModel({ layer: layer(), now: NOW });
  const withPrev = withSampleDeltas(base, { cpu: 33.2, cpuKind: "busy", ram: 45, disk: 62 });
  assert.equal(withPrev.tiles.cpu.delta.text, "↑ 4.2");
  assert.equal(withPrev.tiles.memory.delta.dir, "down");
  assert.equal(withPrev.tiles.disk.delta, null);
  assert.equal(base.tiles.cpu.delta, null, "不改入参");
  const kindChanged = withSampleDeltas(base, { cpu: 10, cpuKind: "load", ram: 39, disk: 62 });
  assert.equal(kindChanged.tiles.cpu.delta, null);
  // buildResourcePanelModel 直接给 prev 等价
  assert.deepEqual(buildResourcePanelModel({ layer: layer(), now: NOW, prev: { cpu: 33.2, cpuKind: "busy", ram: 45, disk: 62 } }), withPrev);
});

// ---- 趋势注记（范围内高低值、磁盘走势）----

const DAY = 86_400_000;

// 近 days 天的小时均值序列（/api/metrics/range 的形状经 charts.parseRangePayload 之后）：值由 valueAt(第几天) 给出。
function weekSeries(valueAt, { days = 7, stepHours = 1 } = {}) {
  const ts = [];
  const values = [];
  for (let h = 0; h <= days * 24; h += stepHours) {
    ts.push(NOW - days * DAY + h * 3_600_000);
    values.push(valueAt(h / 24));
  }
  return { ts, values };
}

test("diskOutlook: 在涨给速度与写满天数；下降 / 持平如实说；数据不足不下结论", () => {
  // 每天涨 1 个点（80 → 87）：当前 87%，还剩 13 个点 → 约 13 天
  assert.equal(diskOutlook(weekSeries((d) => 80 + d), 87), "近 7 天每天约涨 1.0%，按这个速度约 13 天写满");
  // 涨得很慢：速度写两位小数；90 天写不满就不给天数（口径同今日简报）
  assert.equal(diskOutlook(weekSeries((d) => 50 + 0.06 * d), 50.4), "近 7 天每天约涨 0.06%，按这个速度三个月内写不满");
  // 眼看要满：至少写 1 天
  assert.equal(diskOutlook(weekSeries((d) => 92 + d), 99.8), "近 7 天每天约涨 1.0%，按这个速度约 1 天写满");
  // 下降：7 天前的读数 → 当前读数
  assert.equal(diskOutlook(weekSeries((d) => 93 - d), 86), "近 7 天 93% → 86%，在下降，暂无写满风险");
  // 持平：斜率不过 0.05%/天，起止相差不到 1 个点
  assert.equal(diskOutlook(weekSeries(() => 29), 29), "近 7 天基本持平");
  assert.equal(diskOutlook(weekSeries((d) => 29 + 0.005 * d), 29), "近 7 天基本持平");
  // 记录不满 7 天：按实际天数说
  assert.equal(diskOutlook(weekSeries((d) => 60 + d, { days: 3 }), 63), "近 3 天每天约涨 1.0%，按这个速度约 37 天写满");
  // 不足两天 / 点太少 / 当前读数未知 / 没有序列：不下结论
  assert.equal(diskOutlook(weekSeries((d) => 60 + d, { days: 1 }), 61), "");
  assert.equal(diskOutlook(weekSeries((d) => 60 + d, { stepHours: 24 }), 67), "");
  assert.equal(diskOutlook(weekSeries((d) => 60 + d), null), "");
  assert.equal(diskOutlook(null, 60), "");
});

test("withTrendNotes: 明细行补范围内高低值（当前读数算进去）；磁盘卡在容量后面插走势一句话", () => {
  const base = buildResourcePanelModel({ layer: layer({ usage: usage({ filesystem: { inodeUsedPct: 93 } }) }), now: NOW });
  const trend = {
    label: "24 小时",
    extents: { cpu: { lo: 2.4, hi: 26.2 }, ram: { lo: 39.5, hi: 44 }, disk: { lo: 62, hi: 62 } },
    diskWeek: weekSeries((d) => 69 - d),
  };
  const m = withTrendNotes(base, trend);
  // CPU 当前 37.4% 高过范围内的最高值 26.2%：上限取当前读数（长范围画的是均值，最新变化会被抹平）
  assert.deepEqual(m.tiles.cpu.details, ["负载 0.52 · 64 核", "已运行 12 天 3 小时", { text: "24 小时内 2–37%", kind: "range" }]);
  assert.deepEqual(m.tiles.memory.details.at(-1), { text: "24 小时内 39–44%", kind: "range" });
  assert.deepEqual(m.tiles.disk.details, [
    "1.1 / 1.8 TiB · 剩余 620 GiB",
    { text: "近 7 天 69% → 62%，在下降，暂无写满风险", kind: "outlook" },
    "inode 93%",
    { text: "24 小时内稳定在 62%", kind: "range" },
  ]);
  assert.equal(m.tiles.disk.note, "共享卷 /home（$HOME 所在）· 个人配额未知");
  assert.deepEqual(base.tiles.disk.details, ["1.1 / 1.8 TiB · 剩余 620 GiB", "inode 93%"], "不改入参");
  assert.equal(m.freshness, base.freshness, "其余字段原样带过去");

  // 高低值 / 7 天序列还没取到：那一项就不出注记
  const partial = withTrendNotes(base, { label: "7 天", extents: { cpu: null, ram: { lo: 10, hi: 60 }, disk: null }, diskWeek: null });
  assert.deepEqual(partial.tiles.cpu.details, base.tiles.cpu.details);
  assert.deepEqual(partial.tiles.memory.details.at(-1), { text: "7 天内 10–60%", kind: "range" });
  assert.deepEqual(partial.tiles.disk.details, base.tiles.disk.details);

  // 当前读数未知的那块不出注记；没有任何采样时整个模型原样返回
  const noCpu = buildResourcePanelModel({
    layer: layer({ output: "", usage: usage({ cpu: { busyPct: null, loadNormalizedPct: null, logicalCores: null } }) }),
    now: NOW,
  });
  assert.deepEqual(withTrendNotes(noCpu, trend).tiles.cpu.details, noCpu.tiles.cpu.details);
  const empty = buildResourcePanelModel({ now: NOW });
  assert.equal(withTrendNotes(empty, trend), empty);
  assert.equal(withTrendNotes(base, null), base);
});

// ---- HTML 片段 ----

test("buildTileBodyHtml: 趋势注记的 kind 写在 data-kind 上，文案照样转义", () => {
  const m = withTrendNotes(buildResourcePanelModel({ layer: layer(), now: NOW }), {
    label: "30 天",
    extents: { cpu: null, ram: null, disk: { lo: 55, hi: 70 } },
    diskWeek: weekSeries((d) => 55 + d),
  });
  const html = buildTileBodyHtml(m.tiles.disk);
  assert.match(html, /<li>1\.1 \/ 1\.8 TiB · 剩余 620 GiB<\/li><li data-kind="outlook">近 7 天每天约涨 1\.0%，按这个速度约 38 天写满<\/li><li data-kind="range">30 天内 55–70%<\/li>/);
  const evil = buildTileBodyHtml({ title: "x", value: 1, display: "1", unit: "%", details: [{ text: "<img src=x>", kind: '"><b>' }] });
  assert.doesNotMatch(evil, /<img|<b>/);
  assert.match(evil, /data-kind="&quot;&gt;&lt;b&gt;">&lt;img src=x&gt;<\/li>/);
});

test("buildTileBodyHtml: 大字 + 单位 + 环比 + 明细 + 注释，全部转义；未知态不画数字", () => {
  const m = withSampleDeltas(buildResourcePanelModel({ layer: layer(), now: NOW }), { cpu: 33.2, cpuKind: "busy", ram: 39.1, disk: 62 });
  const html = buildTileBodyHtml(m.tiles.cpu);
  assert.match(html, /<span class="res-tile-value">37<\/span><span class="res-tile-unit">%<\/span>/);
  assert.match(html, /<span class="res-delta" data-dir="up" title="较上一采样 \+4\.2 个百分点">↑ 4\.2<\/span>/);
  assert.match(html, /<span class="res-tile-qualifier">利用率<\/span>/);
  assert.match(html, /<li>负载 0\.52 · 64 核<\/li><li>已运行 12 天 3 小时<\/li>/);
  assert.match(html, /class="res-tile-meter-fill" style="transform: scaleX\(0\.374\)"/, "底边用量条代替重复的环形仪表");
  assert.doesNotMatch(html, /res-ring/);
  assert.doesNotMatch(html, /class="[^"]*(green|yellow|red)/, "级别不走 className");
  const disk = buildTileBodyHtml(m.tiles.disk);
  assert.match(disk, /<p class="res-tile-note">共享卷 \/home（\$HOME 所在）· 个人配额未知<\/p>/);
  const empty = buildTileBodyHtml(buildResourcePanelModel({ now: NOW }).tiles.memory);
  assert.match(empty, /res-tile-value-empty">未采集</);
  assert.doesNotMatch(empty, /res-tile-unit/);
  assert.match(empty, /scaleX\(0\)/);
  const evil = buildTileBodyHtml({ title: "<b>", value: 1, display: "1", unit: "%", details: ["<img src=x>"], note: "\"'" });
  assert.doesNotMatch(evil, /<b>|<img/);
  assert.match(evil, /&lt;img src=x&gt;/);
  assert.doesNotThrow(() => buildTileBodyHtml(undefined));
});

test("buildGpuSummaryHtml / buildGpuTableHtml: 摘要四项 + 一张卡一行（利用率条与显存条，级别在 data-level）", () => {
  const gpu = [
    { index: 0, name: "NVIDIA GeForce RTX 4090", memUsedMb: 8294, memTotalMb: 24564, util: 37 },
    { index: 1, name: "NVIDIA GeForce RTX 4090", memUsedMb: 24000, memTotalMb: 24564, util: 100 },
  ];
  const m = buildResourcePanelModel({ layer: layer({ gpu }), now: NOW });
  const summary = buildGpuSummaryHtml(m.gpu.summary);
  assert.match(summary, /<h3>GPU<\/h3><span class="res-gpu-model">2 卡 · RTX 4090<\/span>/);
  assert.match(summary, /<dt>平均利用率<\/dt><dd>69%<\/dd>/);
  assert.match(summary, /<dt>显存合计<\/dt><dd>31\.5 \/ 48\.0 GB<\/dd>/);
  assert.match(summary, /<dt>空闲<\/dt><dd>0 卡<\/dd>/);
  assert.equal(buildGpuSummaryHtml(null), "");
  const table = buildGpuTableHtml(m.gpu.groups);
  assert.equal((table.match(/class="res-gpu-row"/g) || []).length, 2);
  assert.match(table, /<th scope="rowgroup" class="res-gpu-c-node" rowspan="2" title="2 × RTX 4090"><span class="res-gpu-node-name">node05<\/span><span class="res-gpu-node-meta">2 × RTX 4090<\/span><\/th>/);
  assert.match(table, /data-kind="util" data-level="ok" aria-label="利用率 37%"><span class="res-meter"><span class="res-meter-fill" style="transform: scaleX\(0\.37\)"><\/span><\/span><span class="res-gpu-meter-value">37<small>%<\/small><\/span>/);
  assert.match(table, /data-kind="mem" data-level="critical"[^>]*>.*scaleX\(0\.98\).*23\.4 \/ 24\.0 GB/);
  assert.match(table, /class="res-gpu-trend is-empty"[^>]*>积累中</, "没有走势数据时占位，列不塌");
  assert.equal(buildGpuTableHtml(null), "");
});


test("GPU 卡底行：占用者按显存列前 2 个、温度功耗；空闲；摘要最高温度与总功耗", async () => {
  const { buildGpuModel, gpuOwnerText } = await import("./resources-model.js");
  const { cards, summary } = buildGpuModel([
    { index: 0, name: "NVIDIA GeForce RTX 4090", util: 98, memUsedMb: 15000, memTotalMb: 24564, tempC: 71, powerW: 401.2, users: [{ user: "kai", memMb: 14900 }] },
    { index: 1, name: "NVIDIA GeForce RTX 4090", util: 0, memUsedMb: 28, memTotalMb: 24564, tempC: 34, powerW: 18, users: [] },
    { index: 2, name: "NVIDIA GeForce RTX 4090", util: 60, memUsedMb: 20000, memTotalMb: 24564, users: [{ user: "a", memMb: 9000 }, { user: "b", memMb: 6000 }, { user: "c", memMb: 1000 }] },
  ]);
  assert.equal(cards[0].ownerText, "kai 14.6 GB");
  assert.equal(cards[0].envText, "71°C · 401 W");
  assert.equal(cards[1].ownerText, "空闲");
  assert.equal(cards[2].ownerText, "a 8.8 GB · b 5.9 GB 等 3 人");
  assert.equal(cards[2].envText, "");
  assert.ok(cards.every((c) => c.hasFoot));
  assert.equal(summary.maxTemp, 71);
  assert.ok(Math.abs(summary.totalPowerW - 419.2) < 1e-9);
  assert.equal(gpuOwnerText([], { idle: false }), "没有计算进程");
  const legacy = buildGpuModel([{ index: 0, name: "A100", util: 10, memUsedMb: 1, memTotalMb: 40000 }]);
  assert.equal(legacy.cards[0].hasFoot, false, "老采集脚本没有这些字段：不显示底行");
  assert.equal(legacy.summary.maxTemp, null);
});

test("firstSample：只在从没采到过数据时给 wait / error；有数据（哪怕过时 / 本轮失败）或采样暂停都不给", () => {
  assert.deepEqual(buildResourcePanelModel({ now: NOW }).firstSample, { state: "wait" }, "还没拿到层：在等第一次采样");
  assert.deepEqual(buildResourcePanelModel({ layer: { level: "ok", checkedAt: NOW }, now: NOW }).firstSample, { state: "wait" });
  assert.deepEqual(
    buildResourcePanelModel({ layer: { level: "error", reason: "采集失败 (ssh 超时)", checkedAt: NOW }, now: NOW }).firstSample,
    { state: "error", reason: "采集失败 (ssh 超时)" },
  );
  assert.deepEqual(buildResourcePanelModel({ remoteLoad: { ok: false }, now: NOW }).firstSample, { state: "error", reason: "" });
  assert.equal(buildResourcePanelModel({ layer: { level: "skipped", reason: "探针已跳过", checkedAt: NOW }, now: NOW }).firstSample, null);
  assert.equal(buildResourcePanelModel({ layer: layer(), now: NOW }).firstSample, null);
  const failedWithData = buildResourcePanelModel({ layer: layer({ level: "error", reason: "采集失败", checkedAt: NOW - 2000 }), now: NOW });
  assert.equal(failedWithData.hasData, true);
  assert.equal(failedWithData.firstSample, null, "有旧数据时保留旧数据，不换成空状态");
});

test("buildResourceNoticeHtml：等待为蓝色紧凑型（写真实的每分钟节奏），取不到为红色并带原因（转义），其余为空串", () => {
  const wait = buildResourceNoticeHtml({ state: "wait" });
  assert.match(wait, /^<div class="empty-state is-compact" data-tone="wait" role="status" aria-live="polite">/);
  assert.match(wait, /正在等这台服务器的第一次采样/);
  assert.match(wait, /资源每分钟经 SSH 采一次/);
  const error = buildResourceNoticeHtml({ state: "error", reason: "<b>ssh</b> 超时" });
  assert.match(error, /data-tone="error"/);
  assert.match(error, /暂时取不到这台服务器的资源数据/);
  assert.match(error, /&lt;b&gt;ssh&lt;\/b&gt; 超时；每分钟会自动重试一次。/);
  assert.match(buildResourceNoticeHtml({ state: "error" }), /采集失败；每分钟会自动重试一次。/);
  assert.equal(buildResourceNoticeHtml(null), "");
});

test("GPU 分组：登录节点 + 直连节点（node04）各一组，摘要合计全部卡；不可达 / 非直连 / 没卡的节点不算", async () => {
  const { buildGpuGroups, directGpuNodes } = await import("./resources-model.js");
  const local = [
    { index: 0, name: "NVIDIA GeForce RTX 4090", util: 100, memUsedMb: 12000, memTotalMb: 24564 },
    { index: 1, name: "NVIDIA GeForce RTX 4090", util: 100, memUsedMb: 12000, memTotalMb: 24564 },
  ];
  const slurm = { nodes: [
    { name: "master", source: "slurm", gpus: { total: 4, used: 4 } },
    { name: "node04", source: "direct", reachable: true, gpus: { total: 2, cards: [
      { index: 0, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, tempC: 36, powerW: 37.1, users: [] },
      { index: 1, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, tempC: 35, powerW: 36.2, users: [] },
    ] } },
    { name: "node09", source: "direct", reachable: false, gpus: { cards: [{ index: 0, name: "X", util: 1 }] } },
  ] };
  assert.deepEqual(directGpuNodes(slurm).map((n) => n.node), ["node04"]);
  const g = buildGpuGroups(local, slurm, "master");
  assert.deepEqual(g.groups.map((x) => [x.key, x.label, x.direct, x.cards.length]), [["", "master", false, 2], ["node04", "node04", true, 2]]);
  assert.equal(g.cards.length, 4);
  assert.equal(g.summary.count, 4);
  assert.equal(g.summary.nodes, 2);
  assert.equal(g.summary.avgUtil, 50);
  assert.equal(g.summary.idle, 2);
  assert.match(buildGpuSummaryHtml(g.summary), /4 卡 · 2 个节点/);
  const html = buildGpuTableHtml(g.groups, { trendFor: (key, index) => `<svg data-k="${key}:${index}"></svg>` });
  assert.equal((html.match(/<tbody /g) || []).length, 2, "每个节点一个 tbody");
  assert.equal((html.match(/class="res-gpu-row"/g) || []).length, 4);
  assert.equal((html.match(/rowspan=/g) || []).length, 2, "节点格每组只出现一次（rowspan 合并）");
  assert.match(html, /<span class="res-gpu-node-name">node04<\/span><span class="res-gpu-node-meta">2 × A100 40GB<\/span><span class="res-gpu-node-tag">直连<\/span>/);
  assert.match(html, /title="2 × A100-PCIE-40GB\n直连：/, "完整型号与直连说明在节点格的悬停提示里");
  assert.match(html, /data-k="node04:1"/, "直连节点的卡按节点取走势");
  assert.match(html, /data-k=":0"/, "本机卡取本机走势");

  // 只有直连节点有卡（本机没有 GPU）：也照样显示；只有一组时平铺、不出分组标题
  const only = buildGpuGroups(null, slurm, "master");
  assert.equal(only.groups.length, 1);
  assert.match(buildGpuTableHtml(only.groups), /res-gpu-node-name">node04</);
  assert.equal(only.summary.count, 2);
  // 没有直连节点：与改动前完全一致
  const plain = buildGpuGroups(local, null, "master");
  assert.equal(plain.groups.length, 1);
  assert.equal(plain.summary.nodes, undefined);
});

test("compactGpuModel：去掉接口后缀、型号与显存之间空格；其它名字不动", () => {
  assert.equal(compactGpuModel("A100-PCIE-40GB"), "A100 40GB");
  assert.equal(compactGpuModel("A100-SXM4-80GB"), "A100 80GB");
  assert.equal(compactGpuModel("RTX 4090"), "RTX 4090");
  assert.equal(compactGpuModel("H100 80GB HBM3"), "H100 80GB HBM3");
  assert.equal(compactGpuModel(""), "");
});

test("探测已放慢（layer.backoff）：采样胶囊的悬停说明不再写「每 60 秒采样一次」，改写下次探测的时刻；没有退避条目时照旧", () => {
  const nextProbeAt = new Date(2026, 9, 12, 14, 3, 20).getTime();
  assert.equal(resourceCadenceText(null), "每 60 秒采样一次");
  assert.equal(resourceCadenceText({ nextProbeAt: null }), "每 60 秒采样一次");
  assert.equal(resourceCadenceText({ nextProbeAt }), "服务器连不上，探测已放慢 · 下次 14:03:20");
  const failed = buildResourcePanelModel({
    layer: layer({ level: "error", reason: "采集失败 (ssh exit 255)", checkedAt: NOW - 2000, backoff: { nextProbeAt } }),
    now: NOW,
  });
  assert.equal(failed.freshness.level, "error");
  assert.match(failed.freshness.title, /最近尝试 .* · 服务器连不上，探测已放慢 · 下次 14:03:20$/);
  assert.equal(failed.freshness.title.includes("每 60 秒"), false);
});

// ---- v2.62：GPU 显存按作业拆分 ----

test("GPU 占用格：这张卡只有自己在用且分得出作业 →「kai · 3 个作业」；与别人合用、或没有作业信息时写法不变", async () => {
  const { gpuOwnerText } = await import("./resources-model.js");
  const mine = { user: "kai", memMb: 13622, jobs: [{ id: "48215", memMb: 6570 }, { id: "48213", memMb: 5434 }, { id: "48216", memMb: 1618 }] };
  assert.equal(gpuOwnerText([mine]), "kai · 3 个作业");
  assert.equal(gpuOwnerText([{ user: "kai", memMb: 5600, jobs: [{ id: "48217", memMb: 5600 }] }]), "kai · 1 个作业");
  // 合用的卡：这一格很窄，谁占了多少更要紧，照旧写显存（作业明细在悬停提示里）
  assert.equal(gpuOwnerText([mine, { user: "lin", memMb: 4370 }]), "kai 13.3 GB · lin 4.3 GB");
  // 老采集脚本 / 自己的进程不在作业里 / jobs 是空数组或畸形：与以前一样
  assert.equal(gpuOwnerText([{ user: "kai", memMb: 9770 }]), "kai 9.5 GB");
  assert.equal(gpuOwnerText([{ user: "kai", memMb: 9770, jobs: [] }]), "kai 9.5 GB");
  assert.equal(gpuOwnerText([{ user: "kai", memMb: 9770, jobs: "x" }]), "kai 9.5 GB");
  assert.equal(gpuOwnerText([{ user: "kai", memMb: 9770, jobs: [null, { id: 7 }, {}] }]), "kai 9.5 GB");
});

test("gpuJobLines：一个作业一行（作业号、队列快照里的作业名、显存），不在作业里的进程单列，作业太多时并成一行", async () => {
  const { gpuJobLines, GPU_JOB_LINES_MAX, slurmJobNames } = await import("./resources-model.js");
  const names = slurmJobNames({ jobs: [{ id: "48214", name: "xp_wss_min_b" }, { id: "48213", name: "xp_wss_min_a" }, { id: "9", name: "" }, null, { id: 5, name: "x" }] });
  assert.deepEqual([...names], [["48214", "xp_wss_min_b"], ["48213", "xp_wss_min_a"]]);
  const users = [
    { user: "kai", memMb: 10770, jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }, { id: "48299", memMb: null }] },
    { user: "lin", memMb: 4370 },
  ];
  assert.deepEqual(gpuJobLines(users, names), [
    "kai 在这张卡上的 3 个作业：",
    "48214 xp_wss_min_b · 5.2 GB",
    "48213 xp_wss_min_a · 4.3 GB",
    "48299 · 显存未知", // 队列快照里查不到名字：只写作业号
    "不在作业里的进程 · 1.0 GB", // 10770 − 5358 − 4412
  ]);
  assert.deepEqual(gpuJobLines(users), ["kai 在这张卡上的 3 个作业：", "48214 · 5.2 GB", "48213 · 4.3 GB", "48299 · 显存未知", "不在作业里的进程 · 1.0 GB"], "没给作业名");
  assert.deepEqual(gpuJobLines([{ user: "kai", memMb: 9770, jobs: [{ id: "1", memMb: 9770 }] }]), ["kai 在这张卡上的 1 个作业：", "1 · 9.5 GB"], "全在作业里：没有「不在作业里」那一行");
  assert.deepEqual(gpuJobLines([{ user: "lin", memMb: 4370 }]), []);
  assert.deepEqual(gpuJobLines(null), []);
  const many = [{ user: "kai", memMb: 1024 * 12, jobs: Array.from({ length: GPU_JOB_LINES_MAX + 4 }, (_, i) => ({ id: String(100 + i), memMb: 1024 })) }];
  const lines = gpuJobLines(many);
  assert.equal(lines.length, 1 + GPU_JOB_LINES_MAX + 1);
  assert.equal(lines.at(-1), "另有 4 个作业 · 4.0 GB");
});

test("GPU 逐卡：作业明细进整行的悬停提示（转义），占用格与列数、行数都不变；直连节点同样处理", async () => {
  const { buildGpuGroups, buildGpuModel } = await import("./resources-model.js");
  const card = (index, users) => ({ index, name: "NVIDIA GeForce RTX 4090", util: 100, memUsedMb: 13658, memTotalMb: 24564, tempC: 56, powerW: 232.6, users });
  const local = [
    card(0, [{ user: "kai", memMb: 9770, jobs: [{ id: "48214", memMb: 5358 }, { id: "48213", memMb: 4412 }] }]),
    card(1, [{ user: "lin", memMb: 10900 }]),
  ];
  const slurm = {
    user: "kai",
    jobs: [{ id: "48214", name: "xp_<b>" }, { id: "48213", name: "xp_wss_min_a" }, { id: "555", name: "direct_job" }],
    nodes: [{ name: "node04", source: "direct", reachable: true, gpus: { cards: [
      { index: 0, name: "NVIDIA A100-PCIE-40GB", util: 88, memUsedMb: 30000, memTotalMb: 40960, users: [{ user: "kai", memMb: 29900, jobs: [{ id: "555", memMb: 29900 }] }] },
    ] } }],
  };
  const g = buildGpuGroups(local, slurm, "master");
  assert.equal(g.cards[0].ownerText, "kai · 2 个作业");
  assert.equal(g.cards[0].title, [
    "#0 NVIDIA GeForce RTX 4090 · 利用率 100% · 显存 13.3 / 24.0 GB · 温度 56°C · 功耗 232.6 W · 占用 kai 9.5 GB",
    "kai 在这张卡上的 2 个作业：",
    "48214 xp_<b> · 5.2 GB",
    "48213 xp_wss_min_a · 4.3 GB",
  ].join("\n"));
  assert.equal(g.cards[1].ownerText, "lin 10.6 GB");
  assert.equal(g.cards[1].title.includes("\n"), false, "别人的卡：悬停提示还是原来那一行");
  assert.equal(g.cards[2].ownerText, "kai · 1 个作业");
  assert.match(g.cards[2].title, /\nkai 在这张卡上的 1 个作业：\n555 direct_job · 29\.2 GB$/);

  const html = buildGpuTableHtml(g.groups);
  assert.equal((html.match(/class="res-gpu-row"/g) || []).length, 3, "还是一张卡一行");
  assert.equal((html.match(/<th scope="col"/g) || []).length, 7, "还是 7 列");
  assert.match(html, /<span class="res-gpu-owner" data-idle="false">kai · 2 个作业<\/span>/);
  assert.match(html, /title="#0 NVIDIA GeForce RTX 4090[^"]*\nkai 在这张卡上的 2 个作业：\n48214 xp_&lt;b&gt; · 5\.2 GB\n48213 xp_wss_min_a · 4\.3 GB\n点击查看这块卡上的进程（谁、跑了多久、怎么起的）"/, "作业名来自远端，照样转义（v2.76 起提示末尾多一行「点击查看…」）");

  // 概览服务器卡也用这份模型（不传作业名）：字段照旧可用
  const plain = buildGpuModel(local);
  assert.equal(plain.cards[0].title.split("\n")[2], "48214 · 5.2 GB");
  assert.equal(plain.summary.count, 2);
});

// ---- v2.62：占用现场（谁在用 CPU / 内存、是不是 Slurm 作业）----

const GIB_KB = 1024 * 1024;
const PROC_TOP = {
  sampled: 40,
  slurm: true,
  users: [
    { user: "kai", cpuJobPct: 1449, cpuOtherPct: 12.5, rssJobKb: 126 * GIB_KB, rssOtherKb: 2 * GIB_KB, procsJob: 12, procsOther: 3 },
    { user: "lin", cpuJobPct: 0, cpuOtherPct: 554, rssJobKb: 0, rssOtherKb: 67 * GIB_KB, procsJob: 0, procsOther: 6 },
    { user: "wanglei", cpuJobPct: 310, cpuOtherPct: 0, rssJobKb: 24 * GIB_KB, rssOtherKb: 0, procsJob: 4, procsOther: 0 },
    { user: "root", cpuJobPct: 0, cpuOtherPct: 96, rssJobKb: 0, rssOtherKb: 9 * GIB_KB, procsJob: 0, procsOther: 9 },
  ],
};

test("occupancyEntries：按「账号 × 作业内 / 作业外」拆开从大到小排，太小的不列；分不出作业内外时按账号合计", async () => {
  const { occupancyEntries } = await import("./resources-model.js");
  assert.deepEqual(occupancyEntries(PROC_TOP, "cpu").map((e) => [e.user, e.kind, e.value, e.procs]), [
    ["kai", "job", 1449, 12],
    ["lin", "other", 554, 6],
    ["wanglei", "job", 310, 4],
    ["root", "other", 96, 9],
    // kai 作业外的 12.5% 不到最大一项的 5%：不列
  ]);
  assert.deepEqual(occupancyEntries(PROC_TOP, "memory").map((e) => [e.user, e.kind, e.value / GIB_KB]), [
    ["kai", "job", 126], ["lin", "other", 67], ["wanglei", "job", 24], ["root", "other", 9],
  ]);
  assert.deepEqual(occupancyEntries({ ...PROC_TOP, slurm: false }, "cpu").map((e) => [e.user, e.kind, e.value, e.procs]), [
    ["kai", null, 1461.5, 15], ["lin", null, 554, 6], ["wanglei", null, 310, 4], ["root", null, 96, 9],
  ]);
  // 绝对下限：CPU 不到 1%、内存不到 64 MiB 的不算占用
  const tiny = { slurm: true, users: [{ user: "x", cpuJobPct: 0.4, cpuOtherPct: 0.9, rssJobKb: 1000, rssOtherKb: 60000, procsJob: 1, procsOther: 1 }] };
  assert.deepEqual(occupancyEntries(tiny, "cpu"), []);
  assert.deepEqual(occupancyEntries(tiny, "memory"), []);
  for (const bad of [null, undefined, {}, { users: "x" }, { users: [null, {}, { user: "" }, { user: 5 }] }]) {
    assert.deepEqual(occupancyEntries(bad, "cpu"), []);
  }
});

// 行内那一句拆开的三段拼回去（资源面板按这三段排版）：必须与 text 逐字相同——一处生成、两处用。
const inlineOf = (occupancy) => `${occupancy.label}${occupancy.first.name} ${occupancy.first.value}${occupancy.second}`;

test("buildOccupancy：行内那一句按占用从大到小写两项、只给不经 Slurm 的挂标注；悬停提示是完整排名，两种标注都写", async () => {
  const { buildOccupancy } = await import("./resources-model.js");
  const cpu = buildOccupancy(PROC_TOP, "cpu");
  assert.equal(cpu.text, "占用：kai 1449% · lin 554%（不经 Slurm）");
  // 拆开给资源面板排版的三段：在 Slurm 作业里是常态，只写「kai 1449%」；间隔号跟着第二项（它不显示时间隔号也不留）
  assert.deepEqual([cpu.label, cpu.first, cpu.second], ["占用：", { name: "kai", value: "1449%" }, " · lin 554%（不经 Slurm）"]);
  assert.equal(inlineOf(cpu), cpu.text);
  assert.equal(cpu.title, [
    "占用最多 · CPU 与内存最高的 40 个进程按账号汇总",
    "kai 1449%（Slurm 作业）· 12 个进程",
    "lin 554%（不经 Slurm）· 6 个进程",
    "wanglei 310%（Slurm 作业）· 4 个进程",
    "root 96% · 9 个进程",
    "百分比是进程启动以来的平均值，100% 相当于一个核",
  ].join("\n"));
  const memory = buildOccupancy(PROC_TOP, "memory");
  assert.equal(memory.text, "占用：kai 126 GiB · lin 67 GiB（不经 Slurm）");
  assert.equal(inlineOf(memory), memory.text);
  assert.match(memory.title, /^占用最多 · CPU 与内存最高的 40 个进程按账号汇总\nkai 126 GiB（Slurm 作业）· 12 个进程\nlin 67 GiB（不经 Slurm）· 6 个进程\n/);
  assert.match(memory.title, /\n按常驻内存计$/);
  assert.doesNotMatch(`${cpu.title}${memory.title}`, /python|\/proc|cgroup/, "只有账号名与汇总数字");
});

test("buildOccupancy：行内两项严格按占用从大到小——不把不经 Slurm 的往前提（只显示得下第一项时，留下的必须是最大的那一位）", async () => {
  const { buildOccupancy } = await import("./resources-model.js");
  const u = (user, job, other) => ({ user, cpuJobPct: job, cpuOtherPct: other, rssJobKb: 0, rssOtherKb: 0, procsJob: job ? 1 : 0, procsOther: other ? 1 : 0 });
  const build = (users, slurm = true) => buildOccupancy({ sampled: 40, slurm, users }, "cpu");
  const text = (users, slurm) => {
    const occupancy = build(users, slurm);
    assert.equal(inlineOf(occupancy), occupancy.text, "拆开的三段与整句是同一句");
    return occupancy.text;
  };
  // 不经 Slurm 的 lin 排第三：行内只写最大的两项，它在悬停提示的完整排名里
  const third = build([u("kai", 1449, 0), u("lee", 800, 0), u("lin", 0, 554)]);
  assert.equal(third.text, "占用：kai 1449% · lee 800%");
  assert.match(third.title, /\nlin 554%（不经 Slurm）· 1 个进程\n/);
  // 不经 Slurm 的排第二：跟在最大的那一位后面，标注跟着它
  assert.equal(text([u("kai", 1449, 0), u("lin", 0, 554)]), "占用：kai 1449% · lin 554%（不经 Slurm）");
  assert.equal(text([u("kai", 1449, 100)]), "占用：kai 1449% · kai 100%（不经 Slurm）");
  // 不经 Slurm 的确实最大时才在前面
  assert.equal(text([u("kai", 1449, 0), u("lin", 0, 2000)]), "占用：lin 2000%（不经 Slurm）· kai 1449%");
  assert.equal(text([u("lin", 0, 554), u("wang", 0, 300)]), "占用：lin 554%（不经 Slurm）· wang 300%（不经 Slurm）");
  // 两项都在作业里：都不带标注
  assert.equal(text([u("kai", 1449, 85), u("lee", 800, 0)]), "占用：kai 1449% · lee 800%");
  // root 的系统进程不算「不经 Slurm」：不挂标记
  assert.equal(text([u("root", 0, 300), u("kai", 200, 0)]), "占用：root 300% · kai 200%");
  // 只有一项：没有第二项，也不留间隔号
  const single = build([u("kai", 88.5, 0)]);
  assert.deepEqual([single.text, single.first, single.second], ["占用：kai 89%", { name: "kai", value: "89%" }, ""]);
  assert.equal(build([u("kai", 3.26, 0)]).first.value, "3.3%", "不到 10% 留一位小数");
  // 这台机器分不出作业内外（没有 Slurm / 没用 cgroup）：只写账号与数字，绝不说「不经 Slurm」
  assert.equal(text([u("kai", 0, 1461.5), u("lin", 0, 554)], false), "占用：kai 1462% · lin 554%");
  assert.equal(buildOccupancy({ sampled: 0, slurm: false, users: [u("root", 0, 80)] }, "cpu").title.split("\n")[0], "占用最多 · 按账号汇总");
  for (const bad of [null, undefined, {}, { users: [] }, { slurm: true, users: [u("x", 0.2, 0.3)] }]) {
    assert.equal(buildOccupancy(bad, "cpu"), null);
  }
});

test("资源面板：CPU / 内存到「警告」及以上才多出占用现场那一行，平时只在悬停提示里；磁盘那块不带", () => {
  const hot = buildResourcePanelModel({
    layer: layer({ procTop: PROC_TOP, usage: usage({ cpu: { busyPct: 92 }, memory: { usedBytes: 200 * GiB, totalBytes: 251 * GiB } }) }),
    now: NOW,
  });
  assert.equal(hot.tiles.cpu.level, "critical");
  assert.equal(hot.tiles.cpu.occupancy.text, "占用：kai 1449% · lin 554%（不经 Slurm）");
  assert.equal(inlineOf(hot.tiles.cpu.occupancy), hot.tiles.cpu.occupancy.text);
  assert.equal(hot.tiles.cpu.hint, hot.tiles.cpu.occupancy.title);
  assert.equal(hot.tiles.memory.level, "warn");
  assert.equal(hot.tiles.memory.occupancy.text, "占用：kai 126 GiB · lin 67 GiB（不经 Slurm）");
  assert.deepEqual([hot.tiles.disk.occupancy, hot.tiles.disk.hint], [null, ""]);
  assert.deepEqual(hot.tiles.cpu.details, ["负载 0.52 · 64 核", "已运行 12 天 3 小时"], "原有的明细行不动");

  const calm = buildResourcePanelModel({ layer: layer({ procTop: PROC_TOP }), now: NOW });
  assert.deepEqual([calm.tiles.cpu.level, calm.tiles.memory.level], ["ok", "ok"]);
  assert.deepEqual([calm.tiles.cpu.occupancy, calm.tiles.memory.occupancy], [null, null], "平时不多出一行");
  assert.match(calm.tiles.cpu.hint, /^占用最多 · CPU 与内存最高的 40 个进程按账号汇总\nkai 1449%（Slurm 作业）/);
  assert.match(calm.tiles.memory.hint, /\nkai 126 GiB（Slurm 作业）/);

  // 旧采集脚本（层上没有 procTop / 为 null）、远端 ps 不可用：与以前完全一样
  for (const procTop of [undefined, null, "x", { users: [] }]) {
    const plain = buildResourcePanelModel({ layer: layer({ procTop, usage: usage({ cpu: { busyPct: 92 } }) }), now: NOW });
    assert.deepEqual([plain.tiles.cpu.occupancy, plain.tiles.cpu.hint, plain.tiles.memory.hint], [null, "", ""]);
  }
  // 还没采到指标：不挂
  const empty = buildResourcePanelModel({ layer: { level: "ok", checkedAt: NOW, procTop: PROC_TOP }, now: NOW });
  assert.deepEqual([empty.tiles.cpu.occupancy, empty.tiles.cpu.hint], [null, ""]);
});

test("buildTileBodyHtml：占用现场是明细里的最后一项，行内两项各是一个整体（第二项带着间隔号），账号名单独一个可收缩的元素；全部转义", async () => {
  const { buildOccupancy } = await import("./resources-model.js");
  const model = withTrendNotes(
    buildResourcePanelModel({ layer: layer({ procTop: PROC_TOP, usage: usage({ cpu: { busyPct: 92 } }) }), now: NOW }),
    { label: "24 小时", extents: { cpu: { lo: 30, hi: 95 }, ram: null, disk: null }, diskWeek: null },
  );
  const html = buildTileBodyHtml(model.tiles.cpu);
  // 标签之间没有空白（那一行 white-space: pre）；数值前的空格在 span 里面；悬停提示是完整排名、两种标注都写
  assert.match(html, new RegExp(
    '<li data-kind="range">24 小时内 30–95%</li>'
    + '<li data-kind="occupancy" title="占用最多 · CPU 与内存最高的 40 个进程按账号汇总\nkai 1449%（Slurm 作业）· 12 个进程\nlin 554%（不经 Slurm）· 6 个进程[^"]*">'
    + '<span class="res-tile-occ"><span>占用：</span><span class="res-tile-occ-name">kai</span><span> 1449%</span></span>'
    + '<span class="res-tile-occ"> · lin 554%（不经 Slurm）</span></li></ul>',
  ));
  assert.equal((html.match(/data-kind="occupancy"/g) || []).length, 1);
  assert.doesNotMatch(html.slice(html.indexOf('<span class="res-tile-occ">')), /（Slurm 作业）/, "行内不给作业里的条目挂标注");
  assert.match(html, /<div class="res-tile-title" title="占用最多 · [^"]*">CPU<span class="res-tile-qualifier">利用率<\/span><\/div>/);
  assert.match(html, /<div class="res-tile-figure" title="占用最多 · [^"]*"><span class="res-tile-value">92<\/span>/);

  // 只有一项：没有第二个元素
  const single = buildTileBodyHtml({ title: "x", value: 1, display: "1", unit: "%", occupancy: buildOccupancy({ slurm: true, users: [{ user: "kai", cpuJobPct: 88, cpuOtherPct: 0, procsJob: 1 }] }, "cpu") });
  assert.match(single, /<ul class="res-tile-details"><li data-kind="occupancy" title="[^"]*"><span class="res-tile-occ"><span>占用：<\/span><span class="res-tile-occ-name">kai<\/span><span> 88%<\/span><\/span><\/li><\/ul>/);

  // 平时：没有那一行，标题与大字照样带悬停提示
  const calm = buildTileBodyHtml(buildResourcePanelModel({ layer: layer({ procTop: PROC_TOP }), now: NOW }).tiles.cpu);
  assert.doesNotMatch(calm, /data-kind="occupancy"|res-tile-occ/);
  assert.match(calm, /<div class="res-tile-figure" title="占用最多 · /);
  // 没有占用数据：与以前逐字相同（不多出 title 属性）
  const plain = buildTileBodyHtml(buildResourcePanelModel({ layer: layer(), now: NOW }).tiles.cpu);
  assert.match(plain, /<div class="res-tile-title">CPU<span class="res-tile-qualifier">利用率<\/span><\/div><div class="res-tile-figure"><span/);
  assert.doesNotMatch(plain, /title="占用/);

  const evil = buildTileBodyHtml({
    title: "x", value: 1, display: "1", unit: "%", details: [], hint: '"><img src=x>',
    occupancy: { text: "t", title: '"><script>', label: "<i>", first: { name: "<b>a</b>", value: '"><u>' }, second: "· <s>z</s>" },
  });
  assert.doesNotMatch(evil, /<img|<b>|<script>|<i>|<u>|<s>/);
  assert.match(evil, /<li data-kind="occupancy" title="&quot;&gt;&lt;script&gt;"><span class="res-tile-occ"><span>&lt;i&gt;<\/span><span class="res-tile-occ-name">&lt;b&gt;a&lt;\/b&gt;<\/span><span> &quot;&gt;&lt;u&gt;<\/span><\/span><span class="res-tile-occ">· &lt;s&gt;z&lt;\/s&gt;<\/span><\/li>/);
  // 没有第一项（畸形）就整行不出
  for (const occupancy of [{}, { text: "占用：a 1%" }, { first: {} }, { first: { name: "" }, second: " · b 1%" }]) {
    assert.doesNotMatch(buildTileBodyHtml({ title: "x", value: 1, display: "1", unit: "%", occupancy }), /res-tile-details|res-tile-occ/);
  }
});

// 版式的不变式写在 tiles.css 里（这里没有布局引擎，只能守住规则本身；实际宽度下的表现用无头 Chrome 量）：
// 那一行固定一行高、项与项之间可换行、超出的裁掉——放不下的第二项整项落到被裁掉的第二行；
// 省略号只允许出现在账号名上，数字与标注所在的元素不收缩。
test("tiles.css：占用现场那一行放不下的项整项不显示，省略号只落在账号名上", () => {
  const css = readFileSync(new URL("../../css/tiles.css", import.meta.url), "utf8");
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `tiles.css 里应有 ${selector} 的规则`);
    return css.slice(start, css.indexOf("}", start));
  };
  const row = rule('.res-tile-details li[data-kind="occupancy"]');
  for (const decl of ["display: flex", "flex-wrap: wrap", "align-content: flex-start", "height: 1.6em", "line-height: 1.6", "overflow: hidden", "white-space: pre"]) {
    assert.ok(row.includes(`${decl};`), `那一行应有 ${decl}`);
  }
  assert.equal(row.includes("text-overflow"), false, "那一行本身不许用省略号截断（会截出半个数字）");
  assert.ok(rule(".res-tile-occ > span").includes("flex: none;"), "标签、数字与标注所在的元素不收缩");
  const name = rule(".res-tile-occ > .res-tile-occ-name");
  assert.ok(name.includes("min-width: 0;") && name.includes("text-overflow: ellipsis;"), "只有账号名可以收成省略号");
});
