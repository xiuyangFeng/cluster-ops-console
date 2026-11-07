import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { execFileWithInput } from "../exec.mjs";
import { buildUsageScanInvocation, loadUsageScript, parseUsageScanOutput, USAGE_REMOTE_COMMAND, USAGE_SCAN_MAX_OUT_BYTES } from "./scan.mjs";
import { createUsageStore } from "./store.mjs";

const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
// 「扫描器：…」这几条在本机真跑 remote/usage-scan.py（生产里它只在集群的 Linux + python3 上执行），
// 需要 POSIX 环境，win32 上跳过——与 jobs/ dir-usage 下其它真跑远端 Python 脚本的用例同一约定。
// Windows runner 上的失败现场（2026-10-07 CI）：UnicodeEncodeError ... '\udc8f' in position 34，栈只有
// 引导命令那一帧（File "<string>", line 1）。原因是 Windows 的 python 把管道 stdin 按 ANSI 代码页
// （cp1252）+ surrogateescape 解码，脚本源码第 34 字节（「量」字 UTF-8 的 0x8F）在 cp1252 里没有定义，
// 变成孤立代理 \udc8f，引导命令 compile() 把源码编回 UTF-8 时抛错——脚本一行都没执行到，与它怎么写
// 输出无关。即使绕过这一步，Windows 的 python 展开 ~ 时不看 HOME（用例靠它把扫描指向临时目录）。
const PY_SKIP = process.platform === "win32" ? "真跑远端 Python 脚本需要 POSIX 环境（脚本只在集群的 Linux 上运行）" : PYTHON ? false : "本机没有 python3";
const pyTest = (name, fn) => test(name, { skip: PY_SKIP }, fn);

const iso = (sec) => new Date(sec * 1000).toISOString();
const T0 = Date.UTC(2026, 9, 2, 6, 0, 0) / 1000;

function codexLines({ sid = "cx-1", version = "0.159.2", records = true } = {}) {
  const lines = [
    { timestamp: iso(T0), type: "session_meta", payload: { id: sid, cwd: "/home/u/proj-a", cli_version: version } },
    { timestamp: iso(T0 + 1), type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "/home/u/proj-a" } },
    { timestamp: iso(T0 + 2), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  ];
  if (records) {
    lines.push({ timestamp: iso(T0 + 10), type: "token_usage_record", payload: { session_id: sid, turn_id: "turn-1", response_id: "resp_1", usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10 } } });
  }
  lines.push({ timestamp: iso(T0 + 11), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258400, total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 }, last_token_usage: { input_tokens: 1000 } } } });
  if (records) {
    lines.push({ timestamp: iso(T0 + 20), type: "token_usage_record", payload: { session_id: sid, turn_id: "turn-1", response_id: "resp_2", usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 80 } } });
  }
  lines.push({ timestamp: iso(T0 + 21), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258400, total_token_usage: { input_tokens: 2200, cached_input_tokens: 1600, output_tokens: 130, total_tokens: 2330 }, last_token_usage: { input_tokens: 1200 } } } });
  // 重复的 token_count（真实日志里常见）：差分为 0，不应产生调用
  lines.push({ timestamp: iso(T0 + 22), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2200, cached_input_tokens: 1600, output_tokens: 130, total_tokens: 2330 } } } });
  lines.push({ timestamp: iso(T0 + 30), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } });
  lines.push({ timestamp: iso(T0 + 31), type: "response_item", payload: { type: "message", content: "x".repeat(200) } });
  return lines;
}

function claudeAssistant({ sid = "cl-1", rid, t, usage, model = "claude-opus-5-5", sidechain = false, extra = {} }) {
  return { type: "assistant", sessionId: sid, cwd: "/home/u/proj-b", isSidechain: sidechain, requestId: rid, timestamp: iso(t), uuid: `u-${rid}-${t}`, message: { model, usage, content: [{ type: "text", text: "hi" }] }, ...extra };
}

function claudeLines() {
  const usage = { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 40 };
  return [
    { type: "user", sessionId: "cl-1", cwd: "/home/u/proj-b", timestamp: iso(T0), message: { content: "go" } },
    // 同一 requestId 写了三行（按内容块），最后一行的 output 最终
    claudeAssistant({ rid: "req_A", t: T0 + 5, usage: { ...usage, output_tokens: 10 } }),
    claudeAssistant({ rid: "req_A", t: T0 + 6, usage: { ...usage, output_tokens: 20 } }),
    claudeAssistant({ rid: "req_A", t: T0 + 7, usage }),
    // 分叉 / 恢复会话复制进来的副本：usage 全为 0，不能覆盖真实值
    claudeAssistant({ rid: "req_A", t: T0 + 7, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } }),
    claudeAssistant({ rid: "req_B", t: T0 + 20, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 9500, output_tokens: 60 } }),
    { type: "assistant", sessionId: "cl-1", cwd: "/home/u/proj-b", timestamp: iso(T0 + 25), uuid: "err-1", isApiErrorMessage: true, apiErrorStatus: 502, message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "API Error: 502" }] } },
    // 无状态码的错误（实测文案）；以及没有 usage 字段的错误——同样要记一次失败
    { type: "assistant", sessionId: "cl-1", cwd: "/home/u/proj-b", timestamp: iso(T0 + 26), uuid: "err-2", isApiErrorMessage: true, error: "server_error", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "API Error: The response stopped arriving.\nThe response above may be incomplete." }] } },
    { type: "assistant", sessionId: "cl-1", cwd: "/home/u/proj-b", timestamp: iso(T0 + 27), uuid: "err-3", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: `Bearer abc.def ${"y".repeat(400)}` }] } },
    { type: "system", subtype: "turn_duration", sessionId: "cl-1", timestamp: iso(T0 + 30), uuid: "turn-x", durationMs: 30000 },
    { type: "system", subtype: "compact_boundary", sessionId: "cl-1", timestamp: iso(T0 + 31), uuid: "cb-1" },
  ];
}

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "usage-scan-"));
  const codexDir = path.join(home, ".codex", "sessions", "2026", "10", "02");
  const claudeDir = path.join(home, ".claude", "projects", "-home-u-proj-b");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(path.join(claudeDir, "cl-1", "subagents"), { recursive: true });
  const files = {
    codex: path.join(codexDir, "rollout-new.jsonl"),
    codexOld: path.join(codexDir, "rollout-old.jsonl"),
    claude: path.join(claudeDir, "cl-1.jsonl"),
    sub: path.join(claudeDir, "cl-1", "subagents", "agent-1.jsonl"),
  };
  writeFileSync(files.codex, jsonl(codexLines()));
  writeFileSync(files.codexOld, jsonl(codexLines({ sid: "cx-old", version: "0.141.0", records: false })));
  writeFileSync(files.claude, jsonl(claudeLines()));
  writeFileSync(files.sub, jsonl([claudeAssistant({ rid: "req_S", t: T0 + 12, sidechain: true, usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 800, output_tokens: 5 } })]));
  return { home, files };
}

// 按远端同一引导命令在本机跑扫描器（HOME 指向临时目录）。
function runScanner(home, payload) {
  const invocation = buildUsageScanInvocation({ server: { id: "s1", host: "example" }, cursors: payload.cursors || {}, sinceSec: payload.since ?? 0 });
  if (payload.maxOutBytes) {
    const [source, raw] = invocation.input.split("\n");
    invocation.input = `${source}\n${JSON.stringify({ ...JSON.parse(raw), maxOutBytes: payload.maxOutBytes })}`;
  }
  const bootstrap = USAGE_REMOTE_COMMAND.slice("python3 -c '".length, -1);
  const result = spawnSync(PYTHON, ["-c", bootstrap], { input: invocation.input, env: { ...process.env, HOME: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return parseUsageScanOutput(result.stdout);
}

test("调用组装：远端命令是常量，脚本与参数都走 stdin", () => {
  const invocation = buildUsageScanInvocation({ server: { id: "s1", host: "cluster" }, cursors: { "/a.jsonl": { i: "1", o: 5 } }, sinceSec: 123 });
  assert.equal(invocation.file, "ssh");
  assert.equal(invocation.args.at(-1), USAGE_REMOTE_COMMAND);
  assert.ok(invocation.args.includes("cluster"));
  const [first, second] = invocation.input.split("\n");
  assert.equal(JSON.parse(first), loadUsageScript());
  const payload = JSON.parse(second);
  assert.equal(payload.since, 123);
  assert.deepEqual(payload.cursors, { "/a.jsonl": { i: "1", o: 5 } });
  assert.ok(invocation.maxOutputBytes > 4 * 1024 * 1024);
});

test("输出解析：未知类型 / 坏行 / 越界值被丢弃或钳位", () => {
  const out = [
    JSON.stringify({ k: "c", a: "codex", sid: "s", rid: "r", t: 1.7e9, st: "ok", in: -5, cw: 2, cr: 3, o: 1e20, p: 10 }),
    JSON.stringify({ k: "c", a: "unknown", sid: "s", rid: "r", t: 1.7e9 }),
    JSON.stringify({ k: "c", a: "claude", sid: "s", rid: "e", t: 1.7e9, st: "err", code: 502, in: 99, em: "Bearer tok123\u0000 x".padEnd(900, "z") }),
    JSON.stringify({ k: "cur", f: "/x.jsonl", i: "184467440737095516150", o: 10, mt: 1.7e9, s: { sid: "s" } }),
    JSON.stringify({ k: "cur", f: "/y.jsonl", i: 12, o: 10 }),
    "not json",
    JSON.stringify({ k: "end", complete: true, files: 2, pending: 2, bytes: 100, sec: 0.5, roots: { codex: true, antigravity: true }, installed: ["codex", "antigravity", "invalid"], home: "/home/u" }),
  ].join("\n");
  const parsed = parseUsageScanOutput(out);
  assert.equal(parsed.calls.length, 2);
  assert.equal(parsed.calls[0].inFresh, 0);
  assert.equal(parsed.calls[0].output, 1e10);
  assert.deepEqual([parsed.calls[1].ok, parsed.calls[1].code, parsed.calls[1].inFresh], [false, 502, 0]);
  // 远端原文按不可信数据处理：二次脱敏、去控制字符、限 300 字符；成功调用不保存原文
  assert.equal(parsed.calls[1].errorText.length, 300);
  assert.ok(parsed.calls[1].errorText.startsWith("Bearer [REDACTED] x"), parsed.calls[1].errorText.slice(0, 40));
  assert.equal(parsed.calls[0].errorText, null);
  assert.deepEqual(Object.keys(parsed.cursors), ["/x.jsonl"]);
  assert.equal(parsed.end.home, "/home/u");
  assert.equal(parsed.end.roots.antigravity, true);
  assert.deepEqual(parsed.end.installed, ["codex", "antigravity"]);
  assert.equal(parsed.badLines, 3);
});

pyTest("扫描器：Codex 按 token_usage_record 计、Claude 按 requestId 去重、子 Agent 与失败调用", () => {
  const { home, files } = makeHome();
  try {
    appendFileSync(files.codex, jsonl([{ timestamp: iso(T0 + 40), type: "event_msg", payload: { type: "error", message: "stream disconnected: 503 Service Unavailable\napi_key=abc123" } }]));
    const parsed = runScanner(home, {});
    assert.equal(parsed.end.complete, true);
    // Codex 错误：码从 message 里取，原文同样单行化 + 脱敏
    const codexErr = parsed.calls.find((c) => c.agent === "codex" && !c.ok);
    assert.deepEqual([codexErr.code, codexErr.errorText], [503, "stream disconnected: 503 Service Unavailable api_key=[REDACTED]"]);
    assert.equal(parsed.end.home, home);
    const calls = Object.fromEntries(parsed.calls.map((c) => [c.rid, c]));

    // Codex 新版：普通输入 = input - cached - cache_write
    assert.deepEqual([calls.resp_1.inFresh, calls.resp_1.cacheWrite, calls.resp_1.cacheRead, calls.resp_1.output, calls.resp_1.prompt], [300, 100, 600, 50, 1000]);
    assert.equal(calls.resp_1.turnId, "turn-1");
    assert.equal(calls.resp_1.model, "gpt-6.1-sol");
    // 新版文件不走差分（否则会与 record 重复计数）
    assert.ok(!parsed.calls.some((c) => c.sid === "cx-1" && c.rid.startsWith("tc:")));

    // Codex 旧版：按累计值差分，重复的 token_count 不产生调用
    const old = parsed.calls.filter((c) => c.sid === "cx-old");
    assert.equal(old.length, 2);
    assert.equal(old.reduce((sum, c) => sum + c.inFresh + c.cacheRead, 0), 2200);
    assert.equal(old.reduce((sum, c) => sum + c.output, 0), 130);

    // Claude：同一 requestId 只留一条且是最后一次；input_tokens 不含缓存
    const claude = parsed.calls.filter((c) => c.agent === "claude");
    assert.equal(claude.filter((c) => c.rid === "req_A").length, 1);
    assert.deepEqual([calls.req_A.inFresh, calls.req_A.cacheWrite, calls.req_A.cacheRead, calls.req_A.output, calls.req_A.prompt], [3, 500, 9000, 40, 9503]);
    assert.equal(calls.req_S.sidechain, true);
    assert.equal(calls.req_S.sid, "cl-1");
    const errors = Object.fromEntries(claude.filter((c) => !c.ok).map((c) => [c.rid, c]));
    assert.deepEqual(Object.keys(errors).sort(), ["err:err-1", "err:err-2", "err:err-3"]);
    assert.equal(errors["err:err-1"].code, 502);
    assert.equal(errors["err:err-1"].errorText, "API Error: 502");
    // 无状态码：原文单行化；无 usage 的错误也被计入，凭据远端先脱敏、限 300 字符
    assert.equal(errors["err:err-2"].code, null);
    assert.equal(errors["err:err-2"].errorText, "API Error: The response stopped arriving. The response above may be incomplete.");
    assert.ok(errors["err:err-3"].errorText.startsWith("Bearer [REDACTED] yyy"));
    assert.equal(errors["err:err-3"].errorText.length, 300);
    // 成功调用不带原文
    assert.equal(calls.req_A.errorText, null);

    // 轮次与压缩
    assert.ok(parsed.turns.some((t) => t.agent === "claude" && t.t1 - t.t0 === 30));
    assert.ok(parsed.turns.some((t) => t.agent === "codex" && t.tid === "turn-1" && t.t0 !== null));
    assert.equal(parsed.compacts.length, 1);
    assert.ok(parsed.sessions.some((s) => s.agent === "codex" && s.window === 258400));
    assert.ok(parsed.sessions.some((s) => s.agent === "claude" && s.cwd === "/home/u/proj-b"));
    assert.equal(Object.keys(parsed.cursors).length, 4);
    assert.ok(Object.values(parsed.cursors).every((c) => typeof c.i === "string"));
    void files;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

pyTest("扫描器：增量续读、半行不读、截断后从头重读", () => {
  const { home, files } = makeHome();
  try {
    const first = runScanner(home, {});
    // 没有新内容：不产生任何记录，也不回传游标
    const idle = runScanner(home, { cursors: first.cursors });
    assert.equal(idle.calls.length, 0);
    assert.equal(Object.keys(idle.cursors).length, 0);

    // 追加一条完整调用 + 半行：只读到完整的那条，游标停在半行之前
    const extra = claudeAssistant({ rid: "req_C", t: T0 + 40, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 9600, output_tokens: 7 } });
    appendFileSync(files.claude, `${JSON.stringify(extra)}\n{"type":"assistant","sessionId":"cl-1"`);
    const next = runScanner(home, { cursors: first.cursors });
    assert.deepEqual(next.calls.map((c) => c.rid), ["req_C"]);
    const cursor = next.cursors[files.claude];
    assert.equal(cursor.o, first.cursors[files.claude].o + JSON.stringify(extra).length + 1);

    // Codex 解析状态随游标往返：续读时仍知道会话 id 与模型
    appendFileSync(files.codex, jsonl([{ timestamp: iso(T0 + 50), type: "token_usage_record", payload: { session_id: "cx-1", turn_id: "turn-2", response_id: "resp_3", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 1 } } }]));
    const codexNext = runScanner(home, { cursors: { ...first.cursors, ...next.cursors } });
    const resp3 = codexNext.calls.find((c) => c.rid === "resp_3");
    assert.equal(resp3.model, "gpt-6.1-sol");

    // 文件被截断（比游标短）：从头重读
    truncateSync(files.codex, 10);
    writeFileSync(files.codex, jsonl(codexLines()));
    const reread = runScanner(home, { cursors: { ...first.cursors, ...next.cursors, ...codexNext.cursors, [files.codex]: { ...codexNext.cursors[files.codex], o: 10 ** 9 } } });
    assert.ok(reread.calls.some((c) => c.rid === "resp_1"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

pyTest("扫描器：早于保留期且从未读过的文件跳过", () => {
  const { home } = makeHome();
  try {
    const parsed = runScanner(home, { since: Date.now() / 1000 + 3600 });
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.end.complete, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 输出预算（评审 #1）：大日志分多轮回填，每轮按 UTF-8 字节自限，游标与 end 不被截断 ──

const BOOTSTRAP = USAGE_REMOTE_COMMAND.slice("python3 -c '".length, -1);

// 走本机 exec（与生产同一条输出上限通路）跑一轮；payloadPatch 可改远端预算。
async function execScan(home, cursors, payloadPatch = {}) {
  const invocation = buildUsageScanInvocation({ server: { id: "s1", host: "example" }, cursors, sinceSec: 0 });
  const [script, payload] = invocation.input.split("\n");
  const input = `${script}\n${JSON.stringify({ ...JSON.parse(payload), ...payloadPatch })}`;
  const result = await execFileWithInput(PYTHON, ["-c", BOOTSTRAP], {
    input, timeoutMs: 60000, maxOutputBytes: invocation.maxOutputBytes,
    env: { ...process.env, HOME: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" },
  });
  assert.equal(result.code, 0, result.stderr);
  return { ...result, bytes: Buffer.byteLength(result.stdout), parsed: parseUsageScanOutput(result.stdout) };
}

// 大 Claude 日志：count 次调用，约 1/8 是带中文原文的失败调用（多字节字符，按字符计量会低估）。
function writeBigClaudeLog(file, count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const t = T0 + i;
    if (i % 8 === 7) {
      rows.push(JSON.stringify({ type: "assistant", sessionId: "big-1", cwd: "/home/u/项目-用量", timestamp: iso(t), uuid: `e-${i}`, isApiErrorMessage: true, apiErrorStatus: 529, message: { model: "<synthetic>", content: [{ type: "text", text: `接口错误：上游过载，请稍后重试（第 ${i} 次）`.repeat(3) }] } }));
    } else {
      rows.push(JSON.stringify(claudeAssistant({ sid: "big-1", rid: `req_${i}`, t, usage: { input_tokens: i % 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 900 + i, output_tokens: 7 } })));
    }
  }
  writeFileSync(file, `${rows.join("\n")}\n`);
}

pyTest("扫描器：约 6MB / 30000 条的大日志经本机 exec 多轮回填，最终全部入库", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "usage-big-"));
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "usage-big-store-"));
  try {
    const dir = path.join(home, ".claude", "projects", "-home-u-big");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "big-1.jsonl");
    writeBigClaudeLog(file, 30000);
    assert.ok(statSync(file).size > 5.5 * 1024 * 1024, `日志应约 6MB，实际 ${statSync(file).size}`);

    const store = createUsageStore({ rootDir: storeDir, now: () => (T0 + 86400) * 1000 });
    const offsets = [];
    let rounds = 0;
    let done = false;
    while (!done && rounds < 10) {
      rounds += 1;
      const { parsed, bytes, truncated } = await execScan(home, await store.getCursors("s1"));
      // 每轮都在远端预算内（UTF-8 字节），没被本机截断，游标与 end 都在
      assert.equal(truncated, false);
      assert.ok(bytes <= USAGE_SCAN_MAX_OUT_BYTES, `第 ${rounds} 轮输出 ${bytes} 字节超出预算`);
      assert.ok(parsed.end, `第 ${rounds} 轮缺 end`);
      assert.equal(parsed.badLines, 0);
      assert.ok(parsed.cursors[file], `第 ${rounds} 轮缺游标`);
      offsets.push(parsed.cursors[file].o);
      await store.ingest("s1", parsed);
      done = parsed.end.complete;
    }
    assert.ok(rounds >= 2, "6MB 日志一轮放不下，应分多轮");
    assert.equal(done, true, `${rounds} 轮后仍未追平`);
    // 游标逐轮严格前进，最后停在文件末尾
    assert.ok(offsets.every((o, i) => i === 0 || o > offsets[i - 1]), offsets.join(","));
    assert.equal(offsets.at(-1), statSync(file).size);
    const snap = await store.snapshot(["s1"]);
    assert.equal(snap.calls.length, 30000);
    assert.equal(snap.calls.filter((c) => !c.ok).length, 3750);
    assert.ok(snap.calls.filter((c) => !c.ok).every((c) => c.errorText?.startsWith("接口错误")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

pyTest("扫描器：小预算下多轮续读与一轮读完结果一致（Codex 解析状态随游标续上、Claude 跨块去重）", async () => {
  const { home, files } = makeHome();
  try {
    // 新版 Codex 追加 1500 条调用；Claude 追加 1500 次调用，每次按内容块写 2 行（同一 requestId 输出递增）
    const codexRows = [];
    const claudeRows = [];
    for (let i = 0; i < 1500; i += 1) {
      codexRows.push({ timestamp: iso(T0 + 100 + i), type: "token_usage_record", payload: { session_id: "cx-1", turn_id: `turn-${i}`, response_id: `resp_x${i}`, usage: { input_tokens: 100 + i, cached_input_tokens: 50, output_tokens: 3 } } });
      claudeRows.push(claudeAssistant({ rid: `req_x${i}`, t: T0 + 100 + i, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 1 } }));
      claudeRows.push(claudeAssistant({ rid: `req_x${i}`, t: T0 + 100 + i, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 9 } }));
    }
    appendFileSync(files.codex, jsonl(codexRows));
    appendFileSync(files.claude, jsonl(claudeRows));

    const reference = createUsageStore({ rootDir: path.join(home, "ref"), now: () => (T0 + 86400) * 1000 });
    const once = await execScan(home, {});
    assert.equal(once.parsed.end.complete, true);
    await reference.ingest("s1", once.parsed);

    const budget = 64 * 1024;
    const store = createUsageStore({ rootDir: path.join(home, "inc"), now: () => (T0 + 86400) * 1000 });
    let rounds = 0;
    for (let done = false; !done && rounds < 100; rounds += 1) {
      const { parsed, bytes } = await execScan(home, await store.getCursors("s1"), { maxOutBytes: budget });
      assert.ok(bytes <= budget, `第 ${rounds + 1} 轮输出 ${bytes} > ${budget}`);
      assert.ok(parsed.end);
      await store.ingest("s1", parsed);
      done = parsed.end.complete;
    }
    assert.ok(rounds > 3, `应分多轮，实际 ${rounds}`);
    const pick = (snap) => snap.calls.map((c) => `${c.rid}|${c.model}|${c.inFresh}|${c.cacheRead}|${c.output}|${c.ok}`).sort();
    const want = pick(await reference.snapshot(["s1"]));
    const got = pick(await store.snapshot(["s1"]));
    assert.equal(got.length, want.length);
    assert.deepEqual(got, want);
    // Codex 续读的每一轮都还知道模型（解析状态随游标往返）
    assert.ok((await store.snapshot(["s1"])).calls.filter((c) => c.rid.startsWith("resp_x")).every((c) => c.model === "gpt-6.1-sol"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 单条记录的长度上界（v2.57 评审后续）：病态日志不能让一条记录超出 LINE_MAX_BYTES ──
// 输出预算按「一行日志最多产出 LINE_MAX_BYTES 字节」留余量；有一个字段不设上限，一条病态记录就能把
// 游标与 end 挤出本机接收上限，那个文件从此每轮都从旧位置重读、永远追不平。

// 远端脚本里的常量：只执行 Emitter 之前的定义部分（不跑 main）。
function scriptConstant(name) {
  const program = "import sys\nns = {}\nexec(sys.stdin.read().split('\\nclass Emitter')[0], ns)\nprint(ns[sys.argv[1]])";
  const result = spawnSync(PYTHON, ["-c", program, name], { input: loadUsageScript(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

// 只放一个日志文件的假 HOME，跑一轮，返回原始输出行（不经本机解析——要量的就是线上的字节数）。
function scanRawLines(agent, rawLines) {
  const home = mkdtempSync(path.join(os.tmpdir(), "usage-bound-"));
  try {
    const dir = agent === "codex" ? path.join(home, ".codex", "sessions", "2026", "10", "02") : path.join(home, ".claude", "projects", "-home-u-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "log.jsonl"), `${rawLines.join("\n")}\n`);
    const invocation = buildUsageScanInvocation({ server: { id: "s1", host: "example" }, cursors: {}, sinceSec: 0 });
    const result = spawnSync(PYTHON, ["-c", BOOTSTRAP], { input: invocation.input, env: { ...process.env, HOME: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\n").filter(Boolean);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const CODEX_HEAD = [
  JSON.stringify({ timestamp: iso(T0), type: "session_meta", payload: { id: "cx-e", cwd: "/home/u/proj-a", cli_version: "0.159.2" } }),
  JSON.stringify({ timestamp: iso(T0 + 1), type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
];
const longestLine = (lines) => Math.max(...lines.map((line) => Buffer.byteLength(line) + 1));

pyTest("扫描器：Codex 错误记录的 rid 限长（时间戳原文可以任意长）；正常日志的输出逐字不变", () => {
  const lineMax = scriptConstant("LINE_MAX_BYTES");
  const lines = scanRawLines("codex", [
    ...CODEX_HEAD,
    JSON.stringify({ timestamp: iso(T0 + 40), type: "event_msg", payload: { type: "error", message: "stream error: 503 Service Unavailable" } }),
    // 时间戳前 19 个字符合法（能解析出时间），后面拖 20 万个字符
    JSON.stringify({ timestamp: `${iso(T0 + 41)}${"9".repeat(200000)}`, type: "event_msg", payload: { type: "error", message: "boom" } }),
  ]);
  const errors = lines.filter((line) => line.includes('"st":"err"'));
  assert.equal(errors.length, 2);
  // 正常记录：逐字节与修复前相同（rid = err:<sid>:<时间戳原文>）
  assert.equal(errors[0], `{"k":"c","a":"codex","sid":"cx-e","rid":"err:cx-e:${iso(T0 + 40)}","t":${T0 + 40}.0,"m":"gpt-6.1-sol","st":"err","code":503,"in":0,"cw":0,"cr":0,"o":0,"p":0,"tid":null,"em":"stream error: 503 Service Unavailable"}`);
  // 病态记录：rid 截到 160 字符（与本机入库的截断同一上限），时间照常解析
  const bad = JSON.parse(errors[1]);
  assert.equal(bad.rid.length, 160);
  assert.ok(bad.rid.startsWith(`err:cx-e:${iso(T0 + 41)}999`));
  assert.equal(bad.t, T0 + 41);
  assert.ok(longestLine(lines) <= lineMax, `最长一条 ${longestLine(lines)} 字节 > LINE_MAX_BYTES ${lineMax}`);
});

pyTest("扫描器：数值钳位——超长整数 / Infinity 不撑大记录、不让脚本崩掉；每行日志的产出都在 LINE_MAX_BYTES 以内", () => {
  const lineMax = scriptConstant("LINE_MAX_BYTES");
  const maxNum = scriptConstant("MAX_NUM");
  // 4000+ 位的整数字面量（JS 表示不了，直接拼原文）。Python 3.8 对位数没有上限，再长也照单全收。
  const big = (digits) => `1${"0".repeat(digits)}`;
  const record = (rid, usage) => `{"timestamp":"${iso(T0 + 10)}","type":"token_usage_record","payload":{"session_id":"cx-e","turn_id":"t","response_id":"${rid}","usage":${usage}}}`;
  // 字段全部取上限长度、且全是要转义成 \uXXXX 的控制字符：一行日志最坏情况下的产出
  const ctl = (n) => "\u0001".repeat(n);
  const worst = JSON.stringify({ timestamp: iso(T0 + 12), type: "token_usage_record", payload: { session_id: ctl(500), turn_id: ctl(500), response_id: ctl(500), usage: { input_tokens: 5, output_tokens: 1 } } });
  const codex = scanRawLines("codex", [
    ...CODEX_HEAD,
    record("resp_big", `{"input_tokens":${big(4200)},"cached_input_tokens":${big(4100)},"cache_write_input_tokens":${big(4000)},"output_tokens":${big(4200)}}`),
    record("resp_inf", '{"input_tokens":Infinity,"output_tokens":1e400}'),
    `{"timestamp":"${iso(T0 + 11)}","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":${big(4200)}}}}`,
    worst,
  ]);
  assert.ok(longestLine(codex) <= lineMax, `Codex 最长一条 ${longestLine(codex)} 字节 > ${lineMax}`);
  const calls = Object.fromEntries(codex.map((line) => JSON.parse(line)).filter((r) => r.k === "c").map((r) => [r.rid, r]));
  assert.deepEqual([calls.resp_big.p, calls.resp_big.o], [maxNum, maxNum]);
  assert.deepEqual([calls.resp_inf.p, calls.resp_inf.o], [maxNum, maxNum]);
  assert.ok(codex.map((line) => JSON.parse(line)).some((r) => r.k === "s" && r.w === maxNum));
  // 本机解析照旧再钳一遍（1e10），入库口径不变
  assert.equal(parseUsageScanOutput(codex.join("\n")).calls.find((c) => c.rid === "resp_big").prompt, 1e10);

  const claude = scanRawLines("claude", [
    `{"type":"assistant","sessionId":"cl-e","cwd":"/home/u/p","timestamp":"${iso(T0 + 5)}","uuid":"e-1","isApiErrorMessage":true,"apiErrorStatus":${big(4200)},"message":{"model":"<synthetic>","content":[{"type":"text","text":"x"}]}}`,
    `{"type":"system","subtype":"turn_duration","sessionId":"cl-e","timestamp":"${iso(T0 + 6)}","uuid":"t-1","durationMs":${big(4200)}}`,
    `{"type":"assistant","sessionId":"cl-e","cwd":"/home/u/p","requestId":"req_big","timestamp":"${iso(T0 + 7)}","uuid":"u-1","message":{"model":"claude-opus-5-5","usage":{"input_tokens":${big(4200)},"cache_creation_input_tokens":${big(4200)},"cache_read_input_tokens":${big(4200)},"output_tokens":${big(4200)}}}}`,
  ]);
  assert.ok(longestLine(claude) <= lineMax, `Claude 最长一条 ${longestLine(claude)} 字节 > ${lineMax}`);
  const parsed = claude.map((line) => JSON.parse(line));
  assert.equal(parsed.find((r) => r.rid === "err:e-1").code, null, "离谱的状态码不回传");
  assert.equal(parsed.find((r) => r.rid === "req_big").o, maxNum);
  assert.ok(parsed.some((r) => r.k === "t"), "超大 durationMs 不让轮次记录丢掉");
});

pyTest("扫描器：Antigravity SQLite、Gemini CLI、ZCode SQLite 与自定义 JSONL 自动发现与增量读取", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "usage-multi-"));
  try {
    // 1. 用 python3 构造 Antigravity 会话库 ~/.gemini/antigravity-cli/conversations/ag-sess-1.db
    //    以及 ZCode 库 ~/.zcode/cli/db/db.sqlite
    const agDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    const gmDir = path.join(home, ".gemini", "tmp", "hash1", "chats");
    const zcDir = path.join(home, ".zcode", "cli", "db");
    const cuDir = path.join(home, ".config", "cluster-workbench", "usage-logs");
    mkdirSync(agDir, { recursive: true });
    mkdirSync(gmDir, { recursive: true });
    mkdirSync(zcDir, { recursive: true });
    mkdirSync(cuDir, { recursive: true });

    const setupPy = `
import sqlite3, sys

def varint(n):
    out = bytearray()
    while n >= 0x80:
        out.append((n & 0x7f) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)

def pb_field_varint(f, n):
    return varint((f << 3) | 0) + varint(n)

def pb_field_bytes(f, b):
    if isinstance(b, str): b = b.encode("utf-8")
    return varint((f << 3) | 2) + varint(len(b)) + b

# Antigravity DB
ag_db = sys.argv[1]
con = sqlite3.connect(ag_db)
con.execute("CREATE TABLE trajectory_metadata_blob (data BLOB)")
con.execute("INSERT INTO trajectory_metadata_blob VALUES (?)", (b"\\x0a\\x16file:///home/u/proj-ag",))

con.execute("CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB)")
ts_start = pb_field_varint(1, int(${Math.floor(T0)}))
ts_end = pb_field_varint(1, int(${Math.floor(T0 + 15)}))
step0_meta = pb_field_bytes(1, ts_start) + pb_field_bytes(7, ts_start)
step1_meta = pb_field_bytes(1, ts_end) + pb_field_bytes(7, ts_end) + pb_field_bytes(9, pb_field_bytes(7, "bot-1"))
con.execute("INSERT INTO steps VALUES (0, 14, 3, ?, NULL)", (step0_meta,))
con.execute("INSERT INTO steps VALUES (1, 15, 3, ?, NULL)", (step1_meta,))

con.execute("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)")
usage_msg = (
    pb_field_varint(2, 2000)
    + pb_field_varint(3, 200)
    + pb_field_varint(4, 0)
    + pb_field_varint(5, 800)
    + pb_field_bytes(7, "bot-1")
)
win_msg = pb_field_bytes(10, pb_field_varint(4, 1048576))
inner = pb_field_bytes(4, usage_msg) + pb_field_bytes(9, win_msg) + pb_field_bytes(19, "gemini-3-flash-preview")
gen_blob = pb_field_bytes(1, inner)
con.execute("INSERT INTO gen_metadata VALUES (1, ?)", (gen_blob,))
con.commit()
con.close()

# ZCode DB
zc_db = sys.argv[2]
zcon = sqlite3.connect(zc_db)
zcon.execute("CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER)")
zcon.execute("INSERT INTO session VALUES ('zc-1', '/home/u/proj-zc', ?)", (int(${Math.floor(T0)} * 1000),))
zcon.execute("CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, started_at INTEGER, completed_at INTEGER)")
zcon.execute("INSERT INTO turn_usage VALUES ('zc-1', 'zt-1', ?, ?)", (int(${Math.floor(T0)} * 1000), int(${Math.floor(T0 + 18)} * 1000)))
zcon.execute("CREATE TABLE model_usage (id TEXT, session_id TEXT, turn_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, error_code TEXT, error_message TEXT, query_source TEXT)")
zcon.execute("INSERT INTO model_usage VALUES ('zm-1', 'zc-1', 'zt-1', 'glm-5.1', 'completed', ?, ?, 1700, 80, 0, 0, 1200, NULL, NULL, 'main')", (int(${Math.floor(T0)} * 1000), int(${Math.floor(T0 + 18)} * 1000)))
zcon.commit()
zcon.close()
`;
    const pyRes = spawnSync(PYTHON, ["-c", setupPy, path.join(agDir, "ag-sess-1.db"), path.join(zcDir, "db.sqlite")], { encoding: "utf8" });
    assert.equal(pyRes.status, 0, pyRes.stderr);

    // 2. Gemini CLI
    writeFileSync(path.join(home, ".gemini", "tmp", "hash1", ".project_root"), "/home/u/proj-gm\n");
    writeFileSync(path.join(gmDir, "session-gm1.jsonl"), jsonl([
      { type: "gemini", id: "gm-call-1", timestamp: iso(T0 + 10), model: "gemini-2.5-pro", tokens: { input: 600, cached: 1400, output: 90, thoughts: 30 } },
    ]));

    // 3. Custom JSONL
    writeFileSync(path.join(cuDir, "my-agent.jsonl"), jsonl([
      { id: "cu-1", sessionId: "cu-sess-1", cwd: "/home/u/proj-cu", timestamp: iso(T0 + 12), model: "deepseek-r1", usage: { input_tokens: 400, cache_read_input_tokens: 100, output_tokens: 60 } },
    ]));

    const parsed = runScanner(home, {});
    assert.equal(parsed.end.complete, true);
    assert.equal(parsed.end.roots.antigravity, true);
    assert.equal(parsed.end.roots.gemini, true);
    assert.equal(parsed.end.roots.zcode, true);
    assert.equal(parsed.end.roots.custom, true);
    assert.ok(parsed.end.installed.includes("antigravity"));
    assert.ok(parsed.end.installed.includes("zcode"));

    // Antigravity 断言
    const agCall = parsed.calls.find((c) => c.agent === "antigravity");
    assert.ok(agCall, "应扫出 Antigravity 调用");
    assert.equal(agCall.sid, "ag-sess-1");
    assert.equal(agCall.model, "gemini-3-flash-preview");
    assert.deepEqual([agCall.inFresh, agCall.cacheRead, agCall.output, agCall.prompt], [2000, 800, 200, 2800]);
    const agSess = parsed.sessions.find((s) => s.agent === "antigravity" && s.sid === "ag-sess-1");
    assert.deepEqual([agSess?.cwd, agSess?.window], ["/home/u/proj-ag", 1048576]);

    // Gemini CLI 断言
    const gmCall = parsed.calls.find((c) => c.agent === "gemini");
    assert.ok(gmCall, "应扫出 Gemini CLI 调用");
    assert.deepEqual([gmCall.inFresh, gmCall.cacheRead, gmCall.output, gmCall.prompt], [600, 1400, 120, 2000]);
    const gmSess = parsed.sessions.find((s) => s.agent === "gemini");
    assert.equal(gmSess?.cwd, "/home/u/proj-gm");

    // ZCode 断言
    const zcCall = parsed.calls.find((c) => c.agent === "zcode");
    assert.ok(zcCall, "应扫出 ZCode 调用");
    assert.equal(zcCall.model, "glm-5.1");
    assert.deepEqual([zcCall.inFresh, zcCall.cacheRead, zcCall.output, zcCall.prompt], [500, 1200, 80, 1700]);

    // Custom JSONL 断言
    const cuCall = parsed.calls.find((c) => c.agent === "custom");
    assert.ok(cuCall, "应扫出 Custom AI 调用");
    assert.equal(cuCall.model, "deepseek-r1");
    assert.deepEqual([cuCall.inFresh, cuCall.cacheRead, cuCall.output, cuCall.prompt], [400, 100, 60, 500]);

    // 增量游标再次扫描：无新增时不重读
    const second = runScanner(home, { cursors: parsed.cursors });
    assert.equal(second.calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


pyTest("OpenCode：消息原行补写、同毫秒更新、旧游标升级与失败记录不漏采，重放不重复入库", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "usage-opencode-"));
  const db = path.join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(path.dirname(db), { recursive: true });
  const python = (script) => {
    const result = spawnSync(PYTHON, ["-c", `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n${script}\nc.commit()\nc.close()`, db], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    python(`c.execute('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER)')
c.execute('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
c.execute("INSERT INTO session VALUES ('oc-session','/home/u/opencode-project',?)", (${T0 * 1000},))
for i in range(2):
 d={'role':'assistant','modelID':'gpt-6.1-sol','tokens':{'input':0,'output':0,'cache':{'read':0,'write':0}}}
 c.execute('INSERT INTO message VALUES (?,?,?,?,?)', ('msg-'+str(i),'oc-session',${T0 * 1000},1000,json.dumps(d)))`);
    const first = runScanner(home, {});
    assert.equal(first.calls.length, 0);
    python(`d={'role':'assistant','modelID':'gpt-6.1-sol','time':{'completed':${(T0 + 20) * 1000}},'tokens':{'input':400,'output':60,'reasoning':20,'cache':{'read':600,'write':100}}}
c.execute('UPDATE message SET data=?, time_updated=2000 WHERE id=?', (json.dumps(d),'msg-0'))
d={'role':'assistant','error':{'name':'APIError','data':{'statusCode':429,'message':'retry later'}},'tokens':{}}
c.execute('UPDATE message SET data=?, time_updated=2000 WHERE id=?', (json.dumps(d),'msg-1'))`);
    const second = runScanner(home, { cursors: first.cursors });
    const ok = second.calls.find(c => c.rid === "msg-0");
    assert.deepEqual([ok.inFresh, ok.cacheWrite, ok.cacheRead, ok.output, ok.prompt], [400, 100, 600, 80, 1100]);
    assert.equal(second.calls.find(c => c.rid === "msg-1").code, 429);
    const store = createUsageStore({ rootDir: path.join(home, "local-store"), now: () => (T0 + 100) * 1000 });
    await store.ingest("s1", second);
    // 同一毫秒、较小 rowid 再增长：水位的边界时间需重放，不能跳过。
    python(`d=json.loads(c.execute("SELECT data FROM message WHERE id='msg-0'").fetchone()[0])
d['tokens']['output']=90
c.execute("UPDATE message SET data=? WHERE id='msg-0'", (json.dumps(d),))`);
    const third = runScanner(home, { cursors: second.cursors });
    assert.equal(third.calls.find(c => c.rid === "msg-0").output, 110);
    await store.ingest("s1", third);
    await store.ingest("s1", third);
    const saved = await store.snapshot(["s1"]);
    assert.equal(saved.calls.length, 2);
    assert.equal(saved.calls.find(c => c.rid === "msg-0").output, 110);
    assert.equal(runScanner(home, { cursors: third.cursors }).calls.length, 0, "数据库未变化不重读");
    // 升级前 rowid 游标已越过零用量消息；新状态首次升级回补。
    const legacy = structuredClone(third.cursors);
    delete legacy[db].s.mu;
    delete legacy[db].s.mi;
    delete legacy[db].s.ocv;
    assert.equal(runScanner(home, { cursors: legacy }).calls.filter(c => c.ok).length, 1);
    // 输出预算中断时保留同一毫秒内的 rowid 页游标；不能每轮都重放第一页。
    python(`d={'role':'assistant','modelID':'gpt-6.1-sol','tokens':{'input':400,'output':60}}
for i in range(600):
 c.execute('INSERT INTO message VALUES (?,?,?,?,?)', ('page-'+str(i),'oc-session',${T0 * 1000},3000,json.dumps(d)))`);
    let page = runScanner(home, { cursors: third.cursors, maxOutBytes: 64 * 1024 });
    assert.equal(page.end.complete, false);
    assert.ok(page.cursors[db].s.mi > 0);
    const seen = new Set(page.calls.map(c => c.rid));
    let rounds = 1;
    while (!page.end.complete && rounds < 10) {
      page = runScanner(home, { cursors: page.cursors, maxOutBytes: 64 * 1024 });
      for (const c of page.calls) seen.add(c.rid);
      rounds += 1;
    }
    assert.equal(page.end.complete, true);
    assert.equal([...seen].filter(rid => rid.startsWith("page-")).length, 600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
