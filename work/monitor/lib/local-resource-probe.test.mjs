import assert from "node:assert/strict";
import test from "node:test";
import { createLocalResourceProbe, parseLocalProcesses, parseProcessCpuTime } from "./local-resource-probe.mjs";

test("parseProcessCpuTime handles ps elapsed CPU formats", () => {
  assert.equal(parseProcessCpuTime("00:01:02.500"), 62500);
  assert.equal(parseProcessCpuTime("1-00:00:00"), 86400000);
  assert.equal(parseProcessCpuTime("bad"), null);
});

test("local probe uses host counters and monotonic interval CPU, first frame unknown", async () => {
  let clock = 0;
  let wall = 1700000000000;
  let user = 100;
  let idle = 1000;
  let selfMicros = 1000;
  const probe = createLocalResourceProbe({ platform: "linux",
    cpuSnapshot: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }],
    totalMemory: () => 1000, freeMemory: () => 400,
    cpuUsage: () => ({ user: selfMicros, system: 0 }), memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
    monotonicNow: () => clock, now: () => wall,
    execFile: async () => ({ code: 0, stdout: " 10 100 00:00:01.000 Fri Sep 12 00:00:00 2026 node\n" }) });
  const first = await probe.sample();
  assert.equal(first.host.busyPct, null);
  assert.equal(first.self.cpuPct, null);
  assert.equal(first.topProcesses[0].cpuPct, null);
  assert.equal(first.quality, "insufficient");
  clock = 1000;
  wall -= 10000; // Wall-clock corrections cannot create a CPU spike.
  user += 100;
  idle += 300;
  selfMicros += 250000;
  const second = await probe.sample();
  assert.equal(second.host.busyPct, 25);
  assert.equal(second.self.cpuPct, 25);
  assert.equal(second.topProcesses[0].cpuPct, 0);
  assert.equal(second.host.memory.usedPct, 60);
  assert.equal(second.topProcesses[0].name, "node");
  assert.equal("topProcesses" in probe.getSummary(), false);
});

test("local probe tracks arbitrary processes and PID reuse, with bounded topN", async () => {
  let output = " 1 100 00:00:01.000 Fri Sep 12 00:00:00 2026 shell\n 2 200 00:00:02.000 Fri Sep 12 00:00:00 2026 worker\n";
  let t = 0;
  const probe = createLocalResourceProbe({ platform: "darwin", processLimit: 1, cpuSnapshot: () => [{ times: { user: 1, sys: 1, idle: 1, nice: 1, irq: 1 } }],
    totalMemory: () => 1000, freeMemory: () => 500, monotonicNow: () => (t += 1000), now: () => 1700000000000,
    cpuUsage: () => ({ user: 1, system: 1 }), execFile: async () => ({ code: 0, stdout: output }) });
  await probe.sample();
  output = " 1 100 00:00:03.000 Fri Sep 12 00:00:00 2026 shell\n 2 200 00:00:02.000 Fri Sep 12 00:00:00 2026 worker\n";
  const sample = await probe.sample();
  assert.equal(sample.topProcesses.length, 1);
  assert.equal(sample.topProcesses[0].pid, 1);
  assert.equal(sample.topProcesses[0].cpuPct, 100);
  assert.equal(parseLocalProcesses(output, "darwin").length, 2);
});

test("local probe deduplicates concurrent sample and dispose invalidates in-flight result", async () => {
  let resolveExec;
  const exec = () => new Promise((resolve) => { resolveExec = resolve; });
  const probe = createLocalResourceProbe({ platform: "linux", execFile: exec });
  const a = probe.sample();
  const b = probe.sample();
  assert.equal(a, b);
  probe.dispose();
  resolveExec({ code: 0, stdout: "", stderr: "" });
  assert.equal(await a, null);
  assert.equal(probe.getLast(), null);
});


test("PID reuse, CPU counter reset and truncated process output never report bogus CPU", async () => {
  let clock = 0;
  let started = "Fri Sep 12 00:00:00 2026";
  let cpu = "00:00:10.000";
  let truncated = false;
  const probe = createLocalResourceProbe({ platform: "linux", monotonicNow: () => clock,
    execFile: async () => ({ code: 0, truncated, stdout: ` 10 100 ${cpu} ${started} worker\n` }) });
  await probe.sample();
  clock += 1000;
  started = "Fri Sep 12 00:01:00 2026";
  cpu = "00:00:01.000";
  assert.equal((await probe.sample()).topProcesses[0].cpuPct, null);
  clock += 1000;
  cpu = "00:00:00.000";
  assert.equal((await probe.sample()).topProcesses[0].cpuPct, null);
  truncated = true;
  assert.equal((await probe.sample()).processQuality, "insufficient");
  assert.deepEqual(probe.getLast().topProcesses, []);
});

test("Windows uses fixed noninteractive argv and returns all accessible process names", async () => {
  let clock = 0;
  let cpuMs = 0;
  const probe = createLocalResourceProbe({ platform: "win32", monotonicNow: () => clock,
    execFile: async (command, args, options) => {
      assert.match(command, /\\powershell\.exe$/i);
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
      assert.equal(options.maxOutputBytes, 256 * 1024);
      assert.equal(options.timeoutMs, 2000);
      assert.equal(options.shell, undefined);
      assert.doesNotMatch(args.join(" "), /CommandLine|Environment/);
      return { code: 0, stdout: JSON.stringify([{ pid: 123, name: "custom worker", rssBytes: 1024, cpuMs, started: "123456" }]) };
    } });
  await probe.sample();
  clock = 1000;
  cpuMs = 250;
  const data = await probe.sample();
  assert.equal(data.topProcesses[0].name, "custom worker");
  assert.equal(data.topProcesses[0].cpuPct, 25);
  assert.equal("command" in data.topProcesses[0], false);
});

test("CPU hotplug and counter reset reset host baseline, missing process platform degrades", async () => {
  let cores = [{ times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } }];
  const probe = createLocalResourceProbe({ platform: "unknown", cpuSnapshot: () => cores, execFile: () => { throw new Error("must not spawn"); } });
  await probe.sample();
  cores = [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }];
  assert.equal((await probe.sample()).host.busyPct, null);
  cores = [...cores, ...cores];
  assert.equal((await probe.sample()).host.busyPct, null);
  assert.equal(probe.getLast().processQuality, "unsupported");
});
