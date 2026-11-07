import assert from "node:assert/strict";
import test from "node:test";
import { buildProgress, buildResourceReview, parseMemoryBytes, progressView, WATCH_FRESH_MS } from "./watch-model.mjs";

const NOW = 1791200000000;
const memory = 1024 ** 3;
test("资源复盘保留 steps RSS / CPU，不将顶层缺失当零，ReqMem 按每核/节点展开", () => {
  const rows = [
    { id: "12", cpus: "4", nodes: "2", reqMem: "2Gc", elapsed: "100", totalCpu: "00:00:00", maxRss: "" },
    { id: "12.batch", maxRss: "1572864K", totalCpu: "00:03:20" },
    { id: "12.extern", maxRss: "1M", totalCpu: "00:00:00" },
    { id: "13.batch", maxRss: "50G", totalCpu: "01:00:00" },
  ];
  const a = buildResourceReview({ id: "12", rows }, { name: "train", state: "COMPLETED" }, NOW);
  assert.equal(a.requestedMemoryBytes, 8 * memory);
  assert.equal(a.maxRssBytes, 1.5 * memory);
  assert.equal(a.cpuEfficiency, 0.5);
  assert.equal(a.totalCpuSeconds, 200);
  assert.match(a.detail, /最大单任务/);
  assert.equal(buildResourceReview({ id: "12", rows: [{ ...rows[0], reqMem: "2Gn" }] }, {}, NOW).requestedMemoryBytes, 4 * memory);
  assert.equal(buildResourceReview({ id: "12", rows: [{ ...rows[0], reqTres: "cpu=4,mem=10G,node=2" }] }, {}, NOW).requestedMemoryBytes, 10 * memory);
});

test("无记账字段诚实未知；整作业 TotalCPU 已存在时不把 steps 再加一次", () => {
  const absent = buildResourceReview({ id: "12", rows: [{ id: "12", cpus: "", totalCpu: "00:00:00", maxRss: "0", elapsed: "0", reqMem: "0" }] }, {}, NOW);
  for (const key of ["allocCpus", "requestedMemoryBytes", "maxRssBytes", "totalCpuSeconds", "elapsedSeconds", "cpuEfficiency"]) assert.equal(absent[key], null, key);
  const existing = buildResourceReview({ id: "12", rows: [{ id: "12", cpus: "2", elapsed: "100", totalCpu: "00:02:00" }, { id: "12.batch", totalCpu: "00:02:00" }] }, {}, NOW);
  assert.equal(existing.totalCpuSeconds, 120);
  assert.equal(existing.cpuEfficiency, 0.6);
  const fractional = buildResourceReview({ id: "12", rows: [{ id: "12", cpus: "1", elapsed: "1", totalCpu: "00:00.125" }] }, {}, NOW);
  assert.equal(fractional.totalCpuSeconds, 0.125);
  assert.equal(fractional.cpuEfficiency, 0.125);
  assert.equal(parseMemoryBytes("N/A"), null);
});

const record = { files: [{ path: "/logs/train.log", mtime: NOW / 1000 - 86400, size: 500, tail: "Epoch: 3/20\nglobal_step=120\nloss: .25" }], remoteNow: NOW / 1000 };
test("旧日志首样本不报停滞；连续有效采样越过阈值才报，并抽取最后 step/epoch", () => {
  let p = buildProgress(record, null, { now: NOW, silenceMinutes: 10 });
  assert.equal(p.status, "ok");
  assert.deepEqual([p.step, p.epoch], [120, 3]);
  p = buildProgress(record, p, { now: NOW + 5 * 60000, silenceMinutes: 10 });
  assert.equal(p.status, "quiet");
  p = buildProgress(record, p, { now: NOW + 10 * 60000, silenceMinutes: 10 });
  assert.equal(p.status, "stalled");
  assert.match(p.detail, /可能仍在准备数据/);
  assert.equal(progressView(p, NOW + 10 * 60000 + WATCH_FRESH_MS + 1, "RUNNING").status, "stale");
});

test("v2.62 轮转采样：给了更宽的连续窗口，隔得久一些的两次采样也连得上；窗口记在结果里，「采样已过期」按同一个值判", () => {
  const wide = 21 * 60000;
  let p = buildProgress(record, null, { now: NOW, silenceMinutes: 30, freshMs: wide });
  assert.equal(p.freshMs, wide);
  p = buildProgress(record, p, { now: NOW + 20 * 60000, silenceMinutes: 30, freshMs: wide });
  assert.equal(p.status, "quiet", "20 分钟后再读到同样的内容：连得上，还不满 30 分钟");
  assert.equal(progressView(p, NOW + 40 * 60000, "RUNNING").status, "quiet", "下一次轮到之前不算过期");
  assert.equal(progressView(p, NOW + 20 * 60000 + wide + 1, "RUNNING").status, "stale");
  assert.equal("freshMs" in progressView(p, NOW + 40 * 60000, "RUNNING"), false, "窗口是内部口径，不随视图给出去");
  p = buildProgress(record, p, { now: NOW + 40 * 60000, silenceMinutes: 30, freshMs: wide });
  assert.equal(p.status, "stalled");
  assert.equal(buildProgress(record, p, { now: NOW + 40 * 60000 + wide + 1, silenceMinutes: 30, freshMs: wide }).status, "ok", "超过放宽后的窗口照样重建基线");
  // 不给、或给得比默认还窄：与原来完全一样，结果里也不多出字段。
  const plain = buildProgress(record, null, { now: NOW, silenceMinutes: 10 });
  assert.equal("freshMs" in plain, false);
  assert.deepEqual(buildProgress(record, null, { now: NOW, silenceMinutes: 10, freshMs: 60000 }), plain);
  assert.equal(buildProgress(record, plain, { now: NOW + WATCH_FRESH_MS + 1, silenceMinutes: 10, freshMs: 60000 }).status, "ok");
  assert.equal(progressView({ ...plain, freshMs: "broken" }, NOW + WATCH_FRESH_MS + 1, "RUNNING").status, "stale", "盘上的值不是数字时按默认窗口");
});

test("断采、SSH失败、未来mtime均不推断停滞；恢复日志增长重建基线", () => {
  const p = buildProgress(record, null, { now: NOW, silenceMinutes: 10 });
  assert.equal(buildProgress(record, p, { now: NOW + WATCH_FRESH_MS + 1, silenceMinutes: 10 }).status, "ok");
  assert.equal(buildProgress(null, p, { now: NOW + 10 * 60000, silenceMinutes: 10 }).status, "unavailable");
  assert.equal(buildProgress({ ...record, files: [{ ...record.files[0], mtime: NOW / 1000 + 3600 }] }, p, { now: NOW, silenceMinutes: 10 }).status, "unavailable");
  assert.equal(buildProgress({ ...record, files: [{ ...record.files[0], size: 600 }] }, p, { now: NOW + 10 * 60000, silenceMinutes: 10 }).status, "ok");
});
