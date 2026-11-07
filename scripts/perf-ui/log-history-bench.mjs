// node scripts/perf-ui/log-history-bench.mjs <tree> <out.json>
// 固定两份接近 2MB 的轮转日志；只写 fixture 临时目录。测解析与完整 HTTP 回溯，不访问真实 SSH。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withBench } from "./harness.mjs";

const [tree, out] = process.argv.slice(2);
const { parseNdjsonTail } = await import(pathToFileURL(path.resolve(tree, "work/monitor/lib/logger.mjs")));
const part = `${Array.from({ length: 9500 }, (_, i) => JSON.stringify({ ts: 1792224000000 + i, source: "supervisor", level: "info", message: `${i} ${"workload ".repeat(14)}` })).join("\n")}\n`;
const raw = part + part;
const parseMs = [];
for (let i = 0; i < 35; i++) {
  const start = performance.now();
  const result = parseNdjsonTail(raw, { source: "supervisor", limit: 500, tailLines: 500 });
  parseMs.push(performance.now() - start);
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries.at(-1).message.split(" ")[0], "9499");
}
const httpMs = [];
await withBench(tree, null, async ({ port, token }) => {
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/logs?source=supervisor&limit=500&since=0`, { headers: { "x-auth-token": token } });
    const result = await response.json();
    httpMs.push(performance.now() - start);
    assert.equal(response.status, 200);
    assert.equal(result.entries.length, 500);
  }
}, { setupData(dir) {
  const logs = path.join(dir, "runtime/logs");
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ["supervisor.ndjson.1", "supervisor.ndjson"]) fs.writeFileSync(path.join(logs, name), part);
} });
const stats = (all) => {
  const sorted = all.slice(5).sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)] };
};
const report = { tree, bytes: Buffer.byteLength(raw), samples: 30, warmups: 5, parseMs: stats(parseMs), httpMs: stats(httpMs) };
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
