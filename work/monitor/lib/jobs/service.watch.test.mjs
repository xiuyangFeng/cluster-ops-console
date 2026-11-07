import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobsService } from "./service.mjs";
import { WATCH_REMOTE_COMMAND } from "./watch-scan.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "./watch-store.mjs";

const NOW = 1791014400000;
const HEADER = "now=1791014400\ntz=+0800\nuser=kai\nstate=ok\n";
const row = (state) => `${HEADER}job=12|train|${state}|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|${state === "RUNNING" ? "Unknown" : "2026-10-01T16:00:00"}|00:10:00|node03|CPU\n`;

test("jobs服务接线：登记→关注→调度槽内追加一次只读采集；flush等待在途完成与通知落盘", async () => {
  let state = "RUNNING";
  let released;
  let entered;
  const enteredWatch = new Promise((r) => { entered = r; });
  const delayed = new Promise((r) => { released = r; });
  const calls = [];
  let delayWatch = false;
  let config = { servers: [{ id: "s1", host: "cluster" }] };
  const watchStore = createJobWatchStore({ now: () => NOW });
  const service = createJobsService({
    getConfig: async () => config, watchStore, now: () => NOW, probeSshFailureReason: () => "ssh failed",
    execCollector: async (inv) => {
      calls.push(inv);
      if (inv.args.at(-1) !== WATCH_REMOTE_COMMAND) return { code: 0, stdout: row(state) };
      if (delayWatch) { entered(); await delayed; }
      return { code: 0, stdout: JSON.stringify({ k: "progress", id: "12", remoteNow: NOW / 1000, files: [{ p: "/w/job_12.log", mt: NOW / 1000, sz: 40, t: "epoch 1 step 30" }] }) };
    },
  });
  await service.observeSlurmSection("s1", "state=ok\nuser=kai\njobreg_total=1\njobreg=12|12|N/A|train|/w|/w/job_%j.log|(null)|/w/train.sh\n");
  await service.runScan("s1");
  await service.changeWatch("s1", { action: "watch", jobIds: ["12"] });
  delayWatch = true;
  const scanning = service.runScan("s1");
  await enteredWatch;
  let flushed = false;
  const flushing = service.flush().then(() => { flushed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false);
  released();
  await Promise.all([scanning, flushing]);
  const params = JSON.parse(calls.at(-1).input.split("\n")[1]);
  assert.equal(params.jobs[0].reg.stdout, "/w/job_%j.log");
  assert.equal((await service.getWatchView("s1")).watches[0].jobs[0].progress.step, 30);
  config = { ...config, modules: { jobs: false } };
  service.bindEarlyScan(null);
  await service.flush();
  state = "COMPLETED";
  const before = calls.length;
  await service.runScan("s1");
  assert.equal(calls.length, before, "关闭模块后连 sacct 都不执行");
  config = { ...config, modules: { jobs: true } };
  await service.runScan("s1");
  assert.deepEqual((await service.getWatchView()).notifications, [], "关闭期间结束的作业不补弹");
});

test("flush短预算不等挂起SSH，但用户变更和已排队watch保存仍排干", { timeout: 2000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jobs-flush-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  let releaseExec;
  let enteredExec;
  let releaseWrite;
  let enteredWrite;
  const execEntered = new Promise((r) => { enteredExec = r; });
  const writeEntered = new Promise((r) => { enteredWrite = r; });
  const writeGate = new Promise((r) => { releaseWrite = r; });
  let config = { servers: [{ id: "s1", host: "cluster" }] };
  const watchStore = createJobWatchStore({ filePath, now: () => NOW });
  const service = createJobsService({
    getConfig: async () => config, watchStore, now: () => NOW, probeSshFailureReason: () => "stopped",
    execCollector: () => { enteredExec(); return new Promise((r) => { releaseExec = r; }); },
  });
  let scanning;
  try {
    await service.getWatchView();
    scanning = service.runScan("s1");
    await execEntered;
    const queuedWrite = watchStore.update(async (data) => { enteredWrite(); await writeGate; data.quietUntil = NOW + 1000; });
    await writeEntered;
    const mutation = service.changeWatch(null, { action: "settings", quietUntil: NOW + 60000 });
    let flushed = false;
    const flushing = service.flush({ waitMs: 5 }).then(() => { flushed = true; });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(flushed, false, "短预算不能跳过用户变更与排队写入");
    releaseWrite();
    await Promise.all([queuedWrite, mutation, flushing]);
    assert.equal(flushed, true, "SSH 仍未完成时 flush 已能返回");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).quietUntil, NOW + 60000, "用户变更已真正保存到磁盘");
  } finally {
    config = { ...config, modules: { jobs: false } };
    releaseWrite?.();
    releaseExec?.({ code: 1, stdout: "", stderr: "stopped" });
    await scanning;
    await service.flush({ waitMs: 0 });
    await rm(dir, { recursive: true, force: true });
  }
});
