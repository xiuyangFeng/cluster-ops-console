// 诊断包取数与页面脚本错误落盘：全部在 os.tmpdir() 下的临时运行目录里做，路径显式注入。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "../logger.mjs";
import { assembleDiagnosticsBundle, beijingStamp, diagnosticsFilename, LOG_TAIL_LINES, parseTailLine, summarizeProcessRecord } from "./bundle.mjs";
import { CLIENT_ERROR_LIMITS, createClientErrorGate, normalizeClientError } from "./client-errors.mjs";
import { createDiagnosticsService, readTailLines, readTailWithRotation } from "./service.mjs";

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "diag-service-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  mkdirSync(path.join(runtimeDir, "logs"));
  return runtimeDir;
}

const ndjson = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

test("bundle：文件名与可读时间都按北京时间", () => {
  const ms = Date.UTC(2026, 9, 13, 18, 5, 9); // 北京时间 10-14 02:05:09
  assert.equal(beijingStamp(ms).compact, "20261014-020509");
  assert.equal(beijingStamp(ms).text, "2026-10-14 02:05:09 北京时间");
  assert.equal(diagnosticsFilename(ms), "cluster-workbench-diagnostics-20261014-020509.json");
});

test("bundle：解析不了 / 超长的行保留原文开头；进程登记只留摘要", () => {
  assert.deepEqual(parseTailLine('{"a":1}'), { a: 1 });
  assert.deepEqual(parseTailLine("not json"), { raw: "not json" });
  assert.deepEqual(parseTailLine("x".repeat(5000)), { raw: "x".repeat(5000) }, "解析时不截断，截断在脱敏之后");
  const summary = summarizeProcessRecord("tunnel-server-01", {
    pid: 4321, command: "ssh", args: ["-N", "-R", "7891:127.0.0.1:8888", "node04"], startedAt: "2026-10-14T00:00:00.000Z",
    parentPid: 1, signature: "-R 7891:127.0.0.1:8888 node04", configIdentity: "x".repeat(4000),
  }, { alive: true });
  assert.deepEqual(summary, {
    name: "tunnel-server-01", pid: 4321, alive: true, startedAt: "2026-10-14T00:00:00.000Z", command: "ssh",
    args: ["-N", "-R", "7891:127.0.0.1:8888", "node04"], parentPid: 1, hasSignature: true,
  });
});

test("bundle：整份脱敏，替换次数写进 summary；读失败的块以 { error } 出现", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const { bundle, filename, bytes, redactions } = assembleDiagnosticsBundle({
    app: { version: "2.64.0" },
    config: { servers: [{ id: "s1", host: "login.example", sshUser: "alice", password: "pw-pw-pw-pw" }] },
    logs: { ops: { entries: [{ message: `GET /api/events?token=${secret}` }, { message: `token leaked ${secret}` }] } },
    processes: { error: "EACCES" },
  }, { generatedAt: Date.UTC(2026, 9, 14), secrets: [secret] });
  assert.match(filename, /^cluster-workbench-diagnostics-\d{8}-\d{6}\.json$/);
  assert.equal(bundle.schema, "cluster-workbench-diagnostics");
  assert.equal(bundle.config.servers[0].host, "login.example");
  assert.equal(bundle.config.servers[0].sshUser, "alice");
  assert.equal(bundle.config.servers[0].password, "[已隐藏]");
  assert.equal(JSON.stringify(bundle).includes(secret), false);
  assert.deepEqual(bundle.processes, { error: "EACCES" });
  assert.equal(bundle.summary.redactions, redactions);
  assert.ok(redactions >= 3);
  assert.ok(bundle.summary.contents.length >= 5);
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(bundle)));
});

test("bundle：先脱敏再截断——超过 4 KB 的行里，截断点附近的令牌不会以半截的形式漏出", () => {
  const secret = `Zx9QwErTy7UiOp${"AsDfGh1234567890abcdefXYZ"}`;
  // ① 解析不了的长行（原文），令牌正好跨过 4096 处的截断点
  const rawLine = `${"x".repeat(4096 - 12)} "token":"${secret}" tail`;
  // ② 能解析、序列化后超过 4 KB 的对象
  const jsonLine = JSON.stringify({ msg: "y".repeat(5000), token: secret, password: "pw-pw-pw-pw" });
  // ③ 本来就没有收尾引号的文本（别处截断过的）
  const cutLine = `prefix ${"z".repeat(100)} "access_token":"${secret}`;
  const { bundle } = assembleDiagnosticsBundle({
    logs: { ops: { entries: [rawLine, jsonLine, cutLine].map(parseTailLine) } },
    tunnelLedger: { entries: [parseTailLine(rawLine)] },
  });
  const text = JSON.stringify(bundle);
  for (const part of [secret, secret.slice(0, 10), "pw-pw-pw-pw"]) assert.equal(text.includes(part), false, part);
  const [first, second, third] = bundle.logs.ops.entries;
  assert.deepEqual([first.truncated, first.raw.length], [true, 4096]);
  assert.deepEqual([second.truncated, second.raw.length], [true, 4096]);
  assert.match(second.raw, /^\{"msg":"y+/, "对象先序列化再截");
  assert.equal(third.raw, `prefix ${"z".repeat(100)} "access_token":"[已隐藏]"`);
  assert.equal(bundle.tunnelLedger.entries[0].truncated, true);
});

test("readTailLines / readTailWithRotation：只取末尾，当前文件不够时从 .1 补齐", async (t) => {
  const dir = tempRuntime(t);
  const file = path.join(dir, "logs", "ops.ndjson");
  assert.equal(await readTailLines(file, 10), null);
  writeFileSync(`${file}.1`, ndjson(Array.from({ length: 5 }, (_, i) => ({ n: `old-${i}` }))));
  writeFileSync(file, ndjson([{ n: "new-0" }, { n: "new-1" }]));
  const tail = await readTailWithRotation(file, 4);
  assert.deepEqual(tail.entries.map((e) => e.n), ["old-3", "old-4", "new-0", "new-1"]);
  assert.equal(tail.fromRotated, 2);
  // 读字节上限：开头那半行丢掉
  writeFileSync(file, ndjson(Array.from({ length: 100 }, (_, i) => ({ n: i, pad: "y".repeat(50) }))));
  const limited = await readTailLines(file, 1000, { maxBytes: 1024 });
  assert.ok(limited.lines.length < 100 && limited.lines.length > 5);
  assert.equal(limited.more, true);
  assert.doesNotThrow(() => limited.lines.map((line) => JSON.parse(line)));
});

test("service.buildBundle：日志各取末尾 300 行、断线账本、进程登记（只读）、存储占用、未结事件、配置与状态", async (t) => {
  const runtimeDir = tempRuntime(t);
  const logsDir = path.join(runtimeDir, "logs");
  writeFileSync(path.join(logsDir, "ops.ndjson"), ndjson(Array.from({ length: LOG_TAIL_LINES + 50 }, (_, i) => ({ ts: i, level: "info", message: `line ${i}` }))));
  writeFileSync(path.join(logsDir, "desktop.ndjson"), ndjson([{ ts: 1, level: "error", message: "uncaughtException: boom", stack: "Error: boom\n    at x" }]));
  writeFileSync(path.join(logsDir, "renderer.ndjson"), ndjson([{ ts: 2, level: "error", event: "renderer-error", message: "页面脚本错误（未捕获异常）：x" }]));
  writeFileSync(path.join(logsDir, "launcher.ndjson.1"), ndjson([{ ts: 0, level: "error", event: "gate-ssh-missing", message: "启动失败：未检测到 ssh 客户端" }]));
  writeFileSync(path.join(logsDir, "ignored.log"), "plain text");
  writeFileSync(path.join(runtimeDir, "tunnel-ledger.ndjson"), ndjson(Array.from({ length: 250 }, (_, i) => ({ v: 1, type: i % 2 ? "up" : "down", serverId: "s1", at: i }))));
  writeFileSync(path.join(runtimeDir, "channel-supervisor.pid.json"), JSON.stringify({ name: "channel-supervisor", pid: 999999, command: "node", args: ["work/monitor/channel-supervisor.mjs"] }));
  writeFileSync(path.join(runtimeDir, "broken.pid.json"), "{");
  const pidFileBefore = readFileSync(path.join(runtimeDir, "channel-supervisor.pid.json"), "utf8");

  const authToken = "feedfacefeedfacefeedfacefeedface";
  const service = createDiagnosticsService({
    runtimeDir,
    version: "2.64.0",
    getConfig: async () => ({ activeServerId: "s1", servers: [{ id: "s1", host: "node04.example", sshUser: "alice" }], apiKey: "k-k-k-k-k-k" }),
    getBuildInfo: async () => ({ monitorRunning: { build: { version: "2.64.0" } } }),
    incidentStore: { query: ({ state }) => ({ incidents: state === "open" ? [{ incidentId: "i1", component: "tunnel", lifecycle: "open" }] : [] }) },
    storageSweeper: { measure: async () => ({ usedBytes: 1234, byKind: { logs: 1000 } }), getState: () => ({ budgetBytes: 50, lastSweepAt: 7 }) },
    getSecrets: () => ({ secrets: [authToken], users: [] }),
    env: { CODEX_MONITOR_LAUNCHER_NODE: "24.1.0" },
    pidAlive: (pid) => pid === 999999,
    now: () => Date.UTC(2026, 9, 14),
    rendererLogger: { error() {}, dispose() {} },
  });
  const { bundle } = await service.buildBundle({ status: { health: "ok", note: `token ${authToken}` } });

  assert.equal(bundle.app.version, "2.64.0");
  assert.equal(bundle.app.build.monitorRunning.build.version, "2.64.0");
  assert.equal(bundle.runtime.node, process.versions.node);
  assert.ok("electron" in bundle.runtime);
  assert.equal(bundle.platform.platform, process.platform);
  assert.equal(bundle.config.servers[0].host, "node04.example");
  assert.equal(bundle.config.apiKey, "[已隐藏]");
  assert.equal(bundle.status.health, "ok");
  assert.equal(JSON.stringify(bundle).includes(authToken), false, "已知秘密不出现在包里");
  assert.deepEqual(bundle.openIncidents.map((i) => i.incidentId), ["i1"]);
  assert.deepEqual(Object.keys(bundle.logs).sort(), ["desktop", "ops", "renderer"], "只收 *.ndjson（只剩 .1 分卷的不单列）");
  assert.equal(bundle.logs.renderer.entries[0].event, "renderer-error");
  assert.equal(bundle.logs.ops.entries.length, LOG_TAIL_LINES);
  assert.equal(bundle.logs.ops.entries.at(-1).message, `line ${LOG_TAIL_LINES + 49}`);
  assert.equal(bundle.logs.desktop.entries[0].message, "uncaughtException: boom");
  assert.equal(bundle.tunnelLedger.entries.length, 200);
  assert.equal(bundle.tunnelLedger.entries.at(-1).at, 249);
  assert.deepEqual(bundle.processes.map((p) => [p.name, p.alive ?? p.error]), [["broken", "读不出登记文件"], ["channel-supervisor", true]]);
  assert.deepEqual(bundle.storage, { usedBytes: 1234, byKind: { logs: 1000 }, budgetBytes: 50, lastSweepAt: 7 });
  assert.equal(readFileSync(path.join(runtimeDir, "channel-supervisor.pid.json"), "utf8"), pidFileBefore, "导出不改进程登记");
});

test("service.buildBundle：取配置抛错只影响那一块", async (t) => {
  const runtimeDir = tempRuntime(t);
  const service = createDiagnosticsService({ runtimeDir, getConfig: async () => { throw new Error("config broken"); }, rendererLogger: { error() {} } });
  const { bundle } = await service.buildBundle({});
  assert.deepEqual(bundle.config, { error: "config broken" });
  assert.deepEqual(bundle.logs, {});
  assert.deepEqual(bundle.tunnelLedger, { entries: [] });
});

test("normalizeClientError：截断消息与栈、剥掉位置里的查询串、kind 只认两种", () => {
  assert.equal(normalizeClientError(null), null);
  assert.equal(normalizeClientError({ kind: "error" }), null, "没有消息");
  assert.equal(normalizeClientError({ kind: "warning", message: "x" }), null);
  const entry = normalizeClientError({
    kind: "error",
    message: `boom\u0000${"m".repeat(600)}`,
    source: "http://127.0.0.1:8877/assets/js/app.js?token=abc#x",
    line: 12, column: "7", stack: "s".repeat(5000), page: "island", occurrences: 3, extra: "dropped",
  });
  assert.equal(entry.kind, "error");
  assert.ok(entry.message.startsWith("boomm"));
  assert.ok(entry.message.length <= CLIENT_ERROR_LIMITS.message + 10);
  assert.equal(entry.script, "http://127.0.0.1:8877/assets/js/app.js");
  assert.deepEqual([entry.line, entry.column, entry.page, entry.occurrences], [12, 7, "island", 3]);
  assert.ok(entry.stack.length <= CLIENT_ERROR_LIMITS.stack + 10);
  assert.equal("extra" in entry, false);
  assert.equal(normalizeClientError({ kind: "unhandledrejection", message: "x", page: "../evil" }).page, "main");
  const noPlace = normalizeClientError({ kind: "unhandledrejection", message: "x", line: null, column: "" });
  assert.deepEqual([noPlace.line, noPlace.column, noPlace.script], [null, null, ""], "没有位置就是 null，不是第 0 行");
});

test("client error gate：同一条一分钟内只收一次；每分钟 10 条、每小时 60 条；被挡的条数记到下一条", () => {
  let now = 0;
  const gate = createClientErrorGate({ now: () => now });
  const make = (i) => ({ kind: "error", message: `m${i}`, script: "a.js", line: 1, column: 1 });
  assert.deepEqual(gate.accept(make(0)), { ok: true, droppedBefore: 0 });
  assert.deepEqual(gate.accept(make(0)), { ok: false, reason: "duplicate" });
  assert.deepEqual(gate.accept(make(1)), { ok: true, droppedBefore: 1 }, "被挡的那条记在下一条放行的记录上");
  for (let i = 2; i < 10; i += 1) assert.deepEqual(gate.accept(make(i)), { ok: true, droppedBefore: 0 });
  assert.deepEqual(gate.accept(make(10)), { ok: false, reason: "rate-limited" });
  assert.deepEqual(gate.accept(make(11)), { ok: false, reason: "rate-limited" });
  now = 61_000;
  assert.deepEqual(gate.accept(make(0)), { ok: true, droppedBefore: 2 }, "去重窗口过了，计数里带上被挡的两条");
  // 每小时上限
  let accepted = 11;
  for (let minute = 2; minute < 60 && accepted < 70; minute += 1) {
    now = minute * 60_000;
    for (let i = 0; i < 10; i += 1) if (gate.accept(make(`${minute}-${i}`)).ok) accepted += 1;
  }
  assert.equal(accepted, 60);
});

test("service.recordClientError：写进 renderer 日志（监控服务是唯一写入方），重复的不再写", async (t) => {
  const runtimeDir = tempRuntime(t);
  const logsDir = path.join(runtimeDir, "logs");
  const logger = createLogger("renderer-test-client", { dir: logsDir });
  t.after(() => logger.dispose());
  const service = createDiagnosticsService({ runtimeDir, rendererLogger: logger });
  assert.deepEqual(service.recordClientError({ kind: "bogus" }), { ok: false, reason: "invalid" });
  assert.deepEqual(service.recordClientError({ kind: "error", message: "TypeError: x is undefined", source: "/app.js?token=zzz", line: 3, column: 9, stack: "at f" }), { ok: true });
  assert.deepEqual(service.recordClientError({ kind: "error", message: "TypeError: x is undefined", source: "/app.js", line: 3, column: 9 }), { ok: false, reason: "duplicate" });
  await logger.flush();
  const rows = readFileSync(path.join(logsDir, "renderer-test-client.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "error");
  assert.equal(rows[0].event, "renderer-error");
  assert.equal(rows[0].source, "renderer-test-client", "日志来源不被脚本位置盖掉");
  assert.equal(rows[0].script, "/app.js", "位置不带查询串");
  assert.match(rows[0].message, /^页面脚本错误（未捕获异常）：TypeError: x is undefined$/);
});
