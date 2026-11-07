#!/usr/bin/env node
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../work/monitor/lib/logger.mjs";
import { createMetricsStore } from "../work/monitor/lib/metrics-store.mjs";
import { createProbeScheduler } from "../work/monitor/lib/probe-scheduler.mjs";
import { isMainModule } from "./lib/is-main.mjs";

export function parseArgs(argv) {
  const out = { durationMs: 30_000, out: "" };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--duration-ms=")) out.durationMs = Number.isFinite(Number(arg.slice(14))) ? Math.min(600000, Math.max(1000, Number(arg.slice(14)) || 30000)) : 30000;
    if (arg.startsWith("--out=")) out.out = arg.slice(6);
  }
  return out;
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

export async function runBaseline(args) {
  const dir = mkdtempSync(join(tmpdir(), "codex-perf-"));
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const logger = createLogger("perf-baseline", { dir, maxBytes: 2 * 1024 * 1024 });
  const metrics = createMetricsStore({
    filePath: join(dir, "metrics.json"),
    flushDebounceMs: 200,
    now: Date.now,
  });
  const scheduler = createProbeScheduler({
    now: Date.now,
    sshConcurrency: 3,
    perHostSshLimit: 2,
  });

  let simulatedSshLaunches = 0;
  const running = new Set();
  for (let i = 0; i < 20; i += 1) {
    scheduler.registerProbe({
      id: `local:${i}`,
      layer: "channel",
      intervalMs: 1000,
      timeoutMs: 200,
      usesSsh: false,
      run: async () => {
        logger.info("local-probe", { i });
        metrics.addSample({ serverId: `s${i % 4}`, cpu: i, ram: 1, disk: 1 });
        return { level: "ok", reason: "fixture" };
      },
    });
  }
  for (let i = 0; i < 8; i += 1) {
    scheduler.registerProbe({
      id: `ssh:${i}`,
      layer: "resources",
      intervalMs: 2000,
      timeoutMs: 300,
      usesSsh: true,
      hostKey: `host-${i % 3}`,
      run: async () => {
        simulatedSshLaunches += 1;
        const pending = new Promise((resolve) => setTimeout(resolve, 5));
        running.add(pending);
        await pending;
        running.delete(pending);
        return { level: "ok", reason: "fixture-ssh" };
      },
    });
  }

  const sseClients = [];
  let sseBytes = 0;
  let sseMessages = 0;
  for (let i = 0; i < 4; i += 1) {
    sseClients.push({
      writableLength: 0,
      write(chunk) {
        sseBytes += Buffer.byteLength(chunk);
        sseMessages += 1;
      },
      end() {},
    });
  }

  const started = performance.now();
  const rssStart = rssMb();
  let rssPeak = rssStart;
  const cpuStart = process.cpuUsage();
  const tick = setInterval(() => {
    scheduler.tick();
    rssPeak = Math.max(rssPeak, rssMb());
    const payload = `:hb ${Date.now()}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  }, 100);

  await new Promise((resolve) => setTimeout(resolve, args.durationMs));
  clearInterval(tick);
  await Promise.all([...running]);
  await logger.flush();
  await metrics.dispose();
  const cpuDelta = process.cpuUsage(cpuStart);
  const elapsedMs = performance.now() - started;
  const rssEnd = rssMb();
  histogram.disable();

  const loopNs = [
    histogram.min,
    histogram.mean,
    histogram.stddev,
    histogram.percentile(50),
    histogram.percentile(95),
    histogram.max,
  ].map((n) => Math.round(n / 1e6 * 100) / 100);

  const report = {
    schemaVersion: 1,
    kind: "fixture-short-baseline",
    disclaimer: "This is a scripted in-process fixture, not a 10-minute production measurement.",
    durationMs: Math.round(elapsedMs),
    processCpu: {
      userMs: cpuDelta.user / 1000,
      systemMs: cpuDelta.system / 1000,
      cpuPct: Math.round((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000) * 1000) / 10,
      basis: "one-core-100-percent; fixture harness only",
    },
    eventLoopDelayMs: {
      min: loopNs[0],
      mean: loopNs[1],
      p50: loopNs[3],
      p95: loopNs[4],
      max: loopNs[5],
    },
    rssMb: { start: rssStart, end: rssEnd, peak: rssPeak, delta: Math.round((rssEnd - rssStart) * 10) / 10 },
    simulatedSshLaunches,
    syntheticSse: { clients: sseClients.length, bytes: sseBytes, messages: sseMessages, transport: "in-memory-counter; no HTTP socket or router" },
    logger: logger.stats(),
    scheduler: scheduler.getMetrics() || null,
    metricsStore: metrics.stats(),
    measured: ["fixture-event-loop-delay", "fixture-process-cpu", "fixture-rss", "logger-queue", "scheduler-metrics"],
    notMeasured: ["10-minute production idle CPU", "real SSH to cluster hosts", "HTTP/SSE throughput and backpressure", "Electron window render count", "status API P95 against a live desktop session"],
  };

  await logger.dispose();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  return report;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv);
  const report = await runBaseline(args);
  console.log(JSON.stringify(report, null, 2));
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
}
