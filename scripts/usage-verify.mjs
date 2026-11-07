#!/usr/bin/env node
// 用量采集核对：拿真实服务器的会话日志，核对「控制台采集管线」与「独立真值算法」是否一致。
//
//   node scripts/usage-verify.mjs [serverId]      默认取配置里第一台团队服务器
//
// 两路数据：
//   采集管线：与控制台完全相同的 buildUsageScanInvocation → ssh → parseUsageScanOutput → usage store，
//             从空游标开始一轮轮扫到 complete（即首轮回填），数据写进临时目录，不碰 runtime/。
//   独立真值：另一段远端 Python（不复用 usage-scan.py 的任何逻辑）全量解析日志——
//             Claude 按 requestId 去重（取用量最大的一份）后按北京时间归日求和；Codex 取每个会话文件最后一次
//             token_count 的累计值（total_token_usage）求和。
// 输出逐 Agent × 日期的对照表与差异，任何一项不一致时退出码 1。只读远端，不写服务器任何文件。

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLayeredConfig } from "../work/monitor/lib/config-loader.mjs";
import { execFileWithInput } from "../work/monitor/lib/exec.mjs";
import { buildProbeSshArgs } from "../work/monitor/lib/ssh-args.mjs";
import { buildUsageScanInvocation, parseUsageScanOutput } from "../work/monitor/lib/usage/scan.mjs";
import { usageServers } from "../work/monitor/lib/usage/service.mjs";
import { createUsageStore, USAGE_RETENTION_DAYS } from "../work/monitor/lib/usage/store.mjs";
import { USAGE_TZ_OFFSET_SEC } from "../work/monitor/lib/usage/time.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ROUNDS = 40;

// 独立真值脚本：刻意写成最朴素的全量解析，与采集脚本不共享代码路径。
const TRUTH_SCRIPT = `
import json, os, sys, glob, time
args = json.loads(sys.stdin.read())
off, since = args['tzOffsetSec'], args['since']
home = os.path.expanduser('~')
def day(t): return time.strftime('%Y-%m-%d', time.gmtime(t + off))
def ts(s):
    import calendar
    base = calendar.timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S'))
    return base + (float('0.' + s[20:].rstrip('Z').split('+')[0]) if len(s) > 20 and s[19] == '.' else 0)
out = {'claude': {}, 'codex_files': 0, 'codex': {'input': 0, 'output': 0}}
# Claude：全量解析，requestId 去重（取用量最大的一份），合成错误另计
calls = {}
errors = {}
for f in glob.glob(home + '/.claude/projects/**/*.jsonl', recursive=True):
    if os.path.getmtime(f) < since: continue
    for line in open(f, errors='replace'):
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('type') != 'assistant' or not isinstance(d.get('message'), dict): continue
        m = d['message']; u = m.get('usage')
        if not isinstance(u, dict) or not d.get('timestamp'): continue
        t = ts(d['timestamp'])
        if t < since: continue
        if d.get('isApiErrorMessage') or m.get('model') == '<synthetic>':
            errors[d.get('uuid')] = t; continue
        rid = d.get('requestId') or m.get('id')
        total = sum(u.get(k, 0) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'))
        if rid and (rid not in calls or total > calls[rid][2] or (total == calls[rid][2] and t < calls[rid][0])): calls[rid] = (t, u, total)
for t, u, _ in calls.values():
    row = out['claude'].setdefault(day(t), [0, 0, 0, 0, 0, 0])
    row[0] += 1; row[1] += u.get('input_tokens', 0); row[2] += u.get('cache_creation_input_tokens', 0)
    row[3] += u.get('cache_read_input_tokens', 0); row[4] += u.get('output_tokens', 0)
for t in errors.values():
    out['claude'].setdefault(day(t), [0, 0, 0, 0, 0, 0])[5] += 1
# Codex：每个会话文件最后一次 token_count 的累计值
for f in glob.glob(home + '/.codex/sessions/**/*.jsonl', recursive=True):
    if os.path.getmtime(f) < since: continue
    last = None
    for line in open(f, errors='replace'):
        if '"token_count"' not in line: continue
        try: info = (json.loads(line).get('payload') or {}).get('info') or {}
        except ValueError: continue
        if info.get('total_token_usage'): last = info['total_token_usage']
    if last:
        out['codex_files'] += 1
        out['codex']['input'] += last.get('input_tokens', 0); out['codex']['output'] += last.get('output_tokens', 0)
print(json.dumps(out))
`;

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    total += name.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (a, b) => (b === 0 ? (a === 0 ? "0%" : "∞") : `${(((a - b) / b) * 100).toFixed(3)}%`);

async function main() {
  const config = loadLayeredConfig({ configPath: path.join(rootDir, "config.json"), localConfigPath: path.join(rootDir, "config.local.json"), onLocalError: () => {} });
  const servers = usageServers(config);
  const server = process.argv[2] ? servers.find((s) => s.id === process.argv[2]) : servers[0];
  if (!server) throw new Error("没有可采集的团队服务器");
  const nowSec = Date.now() / 1000;
  const sinceSec = nowSec - USAGE_RETENTION_DAYS * 86400;
  console.log(`核对服务器 ${server.id}（${server.host}），保留期 ${USAGE_RETENTION_DAYS} 天`);

  // ---- 采集管线：从空游标回填到 complete ----
  const tmp = mkdtempSync(path.join(os.tmpdir(), "usage-verify-"));
  const store = createUsageStore({ rootDir: tmp });
  const rounds = [];
  try {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const invocation = buildUsageScanInvocation({ server, parsed: config, cursors: await store.getCursors(server.id), sinceSec });
      const started = Date.now();
      const { stdout, stderr, code } = await execFileWithInput(invocation.file, invocation.args, { input: invocation.input, timeoutMs: invocation.timeoutMs, maxOutputBytes: invocation.maxOutputBytes });
      const parsed = parseUsageScanOutput(stdout);
      if (!parsed.end) throw new Error(`第 ${round} 轮扫描失败：exit ${code} ${stderr.slice(0, 300)}`);
      const { added } = await store.ingest(server.id, parsed);
      rounds.push({ round, ms: Date.now() - started, out: stdout.length, added, files: parsed.end.files, remoteSec: parsed.end.sec, bad: parsed.badLines, complete: parsed.end.complete });
      console.log(`  第 ${round} 轮：${(rounds.at(-1).ms / 1000).toFixed(1)}s，远端 ${parsed.end.sec}s，输出 ${fmt(stdout.length)} B，文件 ${parsed.end.files}，新增调用 ${fmt(added)}，坏行 ${parsed.badLines}${parsed.end.complete ? "，已追平" : ""}`);
      if (parsed.end.complete) break;
    }
    if (!rounds.at(-1)?.complete) throw new Error(`${MAX_ROUNDS} 轮内没有追平`);

    // 追平后再扫一轮：增量应该几乎为零
    const steady = buildUsageScanInvocation({ server, parsed: config, cursors: await store.getCursors(server.id), sinceSec });
    const steadyStart = Date.now();
    const steadyRun = await execFileWithInput(steady.file, steady.args, { input: steady.input, timeoutMs: steady.timeoutMs, maxOutputBytes: steady.maxOutputBytes });
    const steadyParsed = parseUsageScanOutput(steadyRun.stdout);
    console.log(`  稳态一轮：${((Date.now() - steadyStart) / 1000).toFixed(1)}s，输出 ${fmt(steadyRun.stdout.length)} B，读到文件 ${steadyParsed.end?.files}`);

    // ---- 独立真值 ----
    const truthArgs = [...buildProbeSshArgs(server, config, {}), `python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),"usage-truth","exec"))'`];
    const tzOffsetSec = USAGE_TZ_OFFSET_SEC; // 与采集同一口径：北京时间归日
    const truthRun = await execFileWithInput("ssh", truthArgs, { input: `${JSON.stringify(TRUTH_SCRIPT)}\n${JSON.stringify({ tzOffsetSec, since: sinceSec })}`, timeoutMs: 300000, maxOutputBytes: 4 * 1024 * 1024 });
    if (truthRun.code !== 0) throw new Error(`真值脚本失败：${truthRun.stderr.slice(0, 300)}`);
    const truth = JSON.parse(truthRun.stdout);

    // ---- 对照 ----
    const snap = await store.snapshot([server.id]);
    const ours = { claude: {}, codex: { input: 0, output: 0, calls: 0, sessions: new Set() } };
    for (const c of snap.calls) {
      if (c.agent === "claude") {
        if (!ours.claude[c.day]) ours.claude[c.day] = [0, 0, 0, 0, 0, 0];
        const row = ours.claude[c.day];
        if (c.ok) { row[0] += 1; row[1] += c.inFresh; row[2] += c.cacheWrite; row[3] += c.cacheRead; row[4] += c.output; }
        else row[5] += 1;
      } else if (c.ok) {
        ours.codex.input += c.inFresh + c.cacheWrite + c.cacheRead;
        ours.codex.output += c.output;
        ours.codex.calls += 1;
        ours.codex.sessions.add(c.sid);
      }
    }
    let mismatches = 0;
    console.log("\nClaude（按日）  调用 / 普通输入 / 缓存写入 / 缓存读取 / 输出 / 失败：采集 vs 真值");
    const days = [...new Set([...Object.keys(ours.claude), ...Object.keys(truth.claude)])].sort();
    const fields = ["调用", "普通输入", "缓存写入", "缓存读取", "输出", "失败"];
    for (const day of days) {
      const a = ours.claude[day] ?? [0, 0, 0, 0, 0, 0];
      const b = truth.claude[day] ?? [0, 0, 0, 0, 0, 0];
      const diff = fields.filter((_, i) => a[i] !== b[i]);
      if (diff.length) mismatches += 1;
      console.log(`  ${day}  ${a.map(fmt).join(" / ")}${diff.length ? `   ≠ 真值 ${b.map(fmt).join(" / ")}（${diff.join("、")}）` : "   ✓"}`);
    }
    console.log(`\nCodex（全部会话合计）  文件 ${truth.codex_files}，采集到会话 ${ours.codex.sessions.size}、调用 ${fmt(ours.codex.calls)}`);
    console.log(`  输入合计  采集 ${fmt(ours.codex.input)}  真值 ${fmt(truth.codex.input)}  差 ${pct(ours.codex.input, truth.codex.input)}`);
    console.log(`  输出      采集 ${fmt(ours.codex.output)}  真值 ${fmt(truth.codex.output)}  差 ${pct(ours.codex.output, truth.codex.output)}`);
    if (ours.codex.input !== truth.codex.input || ours.codex.output !== truth.codex.output) mismatches += 1;

    console.log(`\n本机存储 ${fmt(dirSize(tmp))} B（${snap.calls.length} 次调用、${snap.sessions.length} 个会话、${snap.turns.length} 个轮次）`);
    console.log(mismatches ? `\n✗ 有 ${mismatches} 项不一致` : "\n✓ 采集结果与独立真值完全一致");
    process.exitCode = mismatches ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`核对失败：${err.message}`);
  process.exitCode = 2;
});
