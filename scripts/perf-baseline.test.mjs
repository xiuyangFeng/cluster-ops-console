import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "./perf-baseline.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("perf-baseline: 1 秒 fixture 产出数字且不声称生产实测", () => {
  const result = spawnSync(process.execPath, ["scripts/perf-baseline.mjs", "--duration-ms=1000"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, "fixture-short-baseline");
  assert.match(report.disclaimer, /not a 10-minute production measurement/);
  assert.equal(typeof report.eventLoopDelayMs.p95, "number");
  assert.equal(typeof report.rssMb.end, "number");
  assert.ok(Number.isFinite(report.processCpu.cpuPct));
  assert.equal(report.scheduler.inflightProbes, 0);
  assert.equal(report.scheduler.sshActive, 0);
  assert.equal(report.logger.queuedBytes, 0);
  assert.equal(report.metricsStore.dirty, false);
  assert.equal(report.syntheticSse.bytes, report.syntheticSse.messages * Buffer.byteLength(`:hb ${Date.now()}\n\n`), "count each synthetic frame once");
  assert.match(report.syntheticSse.transport, /no HTTP/);
  assert.ok(report.simulatedSshLaunches > 0);
  assert.equal(report.measured.includes("sse-bytes"), false);
  assert.ok(report.notMeasured.includes("HTTP/SSE throughput and backpressure"));
  assert.ok(Array.isArray(report.notMeasured));
});

test("perf-baseline: invalid or unbounded duration is normalized", () => {
  assert.equal(parseArgs(["node", "script", "--duration-ms=Infinity"]).durationMs, 30000);
  assert.equal(parseArgs(["node", "script", "--duration-ms=999999999"]).durationMs, 600000);
  assert.equal(parseArgs(["node", "script", "--duration-ms=-1"]).durationMs, 1000);
});
