import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { COLLECTOR_SCRIPT_PATH, parseCollectorOutput } from "./collector.mjs";
import { parseTunnelEgress, TUNNEL_EGRESS_MAX_PROGRAMS } from "./tunnel-egress.mjs";

// ---------------------------------------------------------------------------
// parseTunnelEgress：白名单解析。
// ---------------------------------------------------------------------------

test("parseTunnelEgress：完整段 → 汇总、看不到进程的连接与逐程序行", () => {
  const parsed = parseTunnelEgress([
    "state=ok",
    "port=7891",
    "detail=full",
    "total=5|1258396|18874575",
    "others=1|5|7",
    "progs=2",
    "prog=codex|3|1258391|18874568",
    "prog=claude|1|-|-",
  ].join("\n"));
  assert.deepEqual(parsed, {
    state: "ok",
    port: 7891,
    detail: "full",
    total: { conns: 5, sentBytes: 1258396, recvBytes: 18874575 },
    others: { conns: 1, sentBytes: 5, recvBytes: 7 },
    programCount: 2,
    programs: [
      { name: "codex", conns: 3, sentBytes: 1258391, recvBytes: 18874568 },
      { name: "claude", conns: 1, sentBytes: null, recvBytes: null },
    ],
  });
});

test("parseTunnelEgress：没有连接 / ss 不认 -p（basic）/ 没有 ss / 查询失败 / 没端口", () => {
  const empty = parseTunnelEgress("state=ok\nport=7891\ndetail=full\ntotal=0|-|-\nothers=0|-|-\nprogs=0");
  assert.equal(empty.total.conns, 0);
  assert.deepEqual(empty.programs, []);

  const basic = parseTunnelEgress("state=ok\nport=7891\ndetail=basic\ntotal=4|-|-\nprogs=0");
  assert.equal(basic.detail, "basic");
  assert.equal(basic.others, null, "basic 没有 others：所有连接都看不到进程");
  assert.deepEqual(basic.total, { conns: 4, sentBytes: null, recvBytes: null });

  assert.deepEqual(parseTunnelEgress("state=absent\nport=7891"), {
    state: "absent", port: 7891, detail: null, total: null, others: null, programCount: 0, programs: [],
  });
  assert.equal(parseTunnelEgress("state=error\nport=7891").state, "error");
  assert.equal(parseTunnelEgress("state=skip:no-ports").state, "skip");
  assert.equal(parseTunnelEgress("state=skip:bad-ports").port, null);
});

test("parseTunnelEgress：空段 / 不认识的 state / ok 却截断在 total 之前 → null", () => {
  for (const text of [undefined, null, "", "garbage", "state=weird\ntotal=1|-|-", "state=ok\nport=7891\ndetail=full"]) {
    assert.equal(parseTunnelEgress(text), null, JSON.stringify(text));
  }
});

test("parseTunnelEgress：畸形行整行不计，程序名白名单、去重、最多 20 个", () => {
  const rows = [
    "prog=codex|2|10|20",
    "prog=codex|9|10|20", // 重名：先到先得
    "prog=bad name|1|1|1",
    'prog=<script>|1|1|1',
    "prog=x|abc|1|1",
    "prog=y|1|1.5|1",
    "prog=z|1|-1|1",
    "prog=|1|1|1",
    "prog=ok_1|1|1|1|extra",
    ...Array.from({ length: 30 }, (_, i) => `prog=p${i}|1|-|-`),
  ];
  const parsed = parseTunnelEgress(["state=ok", "port=99999", "total=99|-|-", "detail=strange", ...rows].join("\n"));
  assert.equal(parsed.port, null, "端口越界 → null");
  assert.equal(parsed.detail, "full", "认不出的 detail 按 full");
  assert.equal(parsed.programs.length, TUNNEL_EGRESS_MAX_PROGRAMS);
  assert.deepEqual(parsed.programs.slice(0, 2).map((p) => [p.name, p.conns]), [["codex", 2], ["ok_1", 1]]);
  assert.ok(!parsed.programs.some((p) => /\s|</.test(p.name)));
  assert.equal(parsed.programCount, TUNNEL_EGRESS_MAX_PROGRAMS, "没有 progs 行时按收下的行数");
  assert.equal(parseTunnelEgress("state=ok\ntotal=1|x|1"), null, "total 畸形 → 当作没采到");
});

// ---------------------------------------------------------------------------
// collect.sh 真跑：假 ss 放 PATH 里（/bin/sh 与 dash 各一遍）。
// ---------------------------------------------------------------------------

const SHELLS = ["/bin/sh", "/bin/dash"].filter((sh) => spawnSync(sh, ["-c", "exit 0"]).status === 0);

// 现代 ss 的输出：-i 的明细在下一行（Tab 开头）；只过滤一个状态时不打 State 列。
const SS_FULL = [
  "Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
  '0      0          127.0.0.1:53422     127.0.0.1:7891 users:(("codex",pid=1234,fd=23))',
  "\t cubic wscale:7,7 rto:204 rtt:0.05/0.025 mss:65483 bytes_sent:1300000 bytes_acked:1258291 bytes_received:18874368 segs_out:10",
  '0      0          127.0.0.1:53424     127.0.0.1:7891 users:(("codex",pid=1234,fd=24),("codex",pid=1240,fd=3))',
  "\t cubic bytes_acked:100 bytes_received:200",
  '0      0          127.0.0.1:53425     127.0.0.1:7891 users:(("codex",pid=1250,fd=9))',
  "\t cubic bytes_sent:4096 bytes_received:3", // 老内核：没有 bytes_acked，退回 bytes_sent
  // 别的账号的连接：非 root 的 ss -p 不标进程
  "0      0          127.0.0.1:53426     127.0.0.1:7891",
  "\t cubic bytes_acked:5 bytes_received:7",
  // 程序名带空格与 |：换成 _；内核不给字节 → -
  '0      0              [::1]:53428         [::1]:7891 users:(("my tool|x",pid=99,fd=4))',
  "\t cubic rto:204",
  // 老版本 ss 的 IPv6 写法与 users 老格式，同一行接着 -i 明细
  '0      0   ::ffff:127.0.0.1:53429 ::ffff:127.0.0.1:7891 users:(("claude",4321,7)) cubic bytes_acked:10 bytes_received:20',
  // 对端不是回环（别处的 7891）：不计
  '0      0           10.0.0.5:53430      10.0.0.9:7891 users:(("evil",pid=1,fd=4))',
  "\t cubic bytes_acked:5 bytes_received:7",
  // 端口只是前缀相同：不计
  '0      0          127.0.0.1:53431     127.0.0.1:78910 users:(("evil",pid=1,fd=5))',
].join("\n");

// FAKE_SS_MODE：full（默认）/ no-p（-p / -i 报错，-tn 正常）/ fail（都报错）/ many（25 个程序）/ hang（被 timeout 杀掉）
const FAKE_SS = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SS_LOG"
case "$FAKE_SS_MODE" in
  fail) echo "ss: bad" >&2; exit 1 ;;
  hang) exit 124 ;;
esac
case "$1" in
  -tnpi)
    [ "$FAKE_SS_MODE" = no-p ] && { echo "ss: invalid option -- p" >&2; exit 1; }
    if [ "$FAKE_SS_MODE" = many ]; then
      echo "Recv-Q Send-Q Local Address:Port Peer Address:Port Process"
      i=0
      while [ $i -lt 25 ]; do
        j=0
        while [ $j -le $i ]; do
          printf '0 0 127.0.0.1:%s 127.0.0.1:7891 users:(("prog%s",pid=1,fd=3))\\n' "$((40000 + i * 100 + j))" "$i"
          printf '\\t cubic bytes_acked:1 bytes_received:%s\\n' "$i"
          j=$((j + 1))
        done
        i=$((i + 1))
      done
    else
      cat "$FAKE_SS_FIXTURE"
    fi ;;
  -tn)
    echo "Recv-Q Send-Q Local Address:Port Peer Address:Port"
    echo "0 0 127.0.0.1:53422 127.0.0.1:7891"
    echo "0 0 127.0.0.1:53423 127.0.0.1:7891"
    echo "0 0 10.0.0.5:53430 10.0.0.9:7891" ;;
  *) exit 1 ;;
esac
`;

const FAKE_TIMEOUT = `#!/bin/sh
shift
exec "$@"
`;

// 只取 tunnel-egress 段；noSs 时 PATH 里只有脚本这一段用得到的几个系统命令（没有 ss）。
function runEgress(shell, { mode = "full", ports = "7891", noSs = false, withTimeout = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-egress-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const fixture = path.join(dir, "ss-out");
    writeFileSync(fixture, `${SS_FULL}\n`);
    const log = path.join(dir, "ss.log");
    writeFileSync(log, "");
    let PATH = `${bin}:${process.env.PATH}`;
    if (noSs) {
      for (const cmd of ["awk", "head"]) {
        const real = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
        if (real) symlinkSync(real, path.join(bin, cmd));
      }
      PATH = bin;
    } else {
      writeFileSync(path.join(bin, "ss"), FAKE_SS);
      chmodSync(path.join(bin, "ss"), 0o755);
      if (withTimeout) {
        writeFileSync(path.join(bin, "timeout"), FAKE_TIMEOUT);
        chmodSync(path.join(bin, "timeout"), 0o755);
      }
    }
    const env = { ...process.env, PATH, CT_PROFILE: "slow", CT_PORTS: ports, FAKE_SS_MODE: mode, FAKE_SS_FIXTURE: fixture, FAKE_SS_LOG: log };
    // macOS 对新写出的可执行文件第一次执行要做安全评估，放在正式那一趟之前
    if (!noSs) spawnSync(path.join(bin, "ss"), ["--version"], { env, timeout: 60000 });
    const res = spawnSync(shell, [COLLECTOR_SCRIPT_PATH], { encoding: "utf8", timeout: 60000, env });
    assert.equal(res.status, 0, res.stderr);
    const { sections } = parseCollectorOutput(res.stdout);
    assert.ok("tunnel-egress" in sections, "tunnel-egress 段必须在");
    assert.ok("slurm" in sections, "后面的 slurm 段照常输出");
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => l.includes("state established")); // ports 段的 ss -ltn 不算
    return { section: sections["tunnel-egress"], calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const shell of SHELLS) {
  test(`collect.sh（${shell}）：tunnel-egress 段——按程序名汇总回环连接，看不到进程的另记，字节缺失写 -`, { skip: process.platform === "win32" }, () => {
    const { section, calls } = runEgress(shell);
    assert.deepEqual(calls, ["-tnpi state established ( dport = :7891 )"], "只查一次，端口进的是 ss 过滤式");
    assert.deepEqual(section.split("\n"), [
      "state=ok",
      "port=7891",
      "detail=full",
      "total=6|1262502|18874598",
      "others=1|5|7",
      "progs=3",
      "prog=codex|3|1262487|18874571",
      "prog=claude|1|10|20",
      "prog=my_tool_x|1|-|-",
    ]);
    const parsed = parseTunnelEgress(section);
    assert.deepEqual(parsed.programs[0], { name: "codex", conns: 3, sentBytes: 1262487, recvBytes: 18874571 });
    assert.doesNotMatch(section, /pid=|1234|53422|evil/, "不带 pid、本地端口与非回环对端");
  });

  test(`collect.sh（${shell}）：tunnel-egress 段——ss 不认 -p / -i → 退回 -tn 只数连接；都失败 → error；没有 ss → absent`, { skip: process.platform === "win32" }, () => {
    const basic = runEgress(shell, { mode: "no-p" });
    assert.deepEqual(basic.calls, ["-tnpi state established ( dport = :7891 )", "-tn state established ( dport = :7891 )"]);
    assert.deepEqual(basic.section.split("\n"), ["state=ok", "port=7891", "detail=basic", "total=2|-|-", "progs=0"]);

    assert.deepEqual(runEgress(shell, { mode: "fail" }).section.split("\n"), ["state=error", "port=7891"]);
    assert.deepEqual(runEgress(shell, { noSs: true }).section.split("\n"), ["state=absent", "port=7891"]);
  });

  test(`collect.sh（${shell}）：tunnel-egress 段——超时不再跑回退；最多 20 个程序、整段 ≤2 KB`, { skip: process.platform === "win32" }, () => {
    const hung = runEgress(shell, { mode: "hang", withTimeout: true });
    assert.equal(hung.calls.length, 1, "ss 超时（124）后不再跑 -tn");
    assert.deepEqual(hung.section.split("\n"), ["state=error", "port=7891"]);

    const many = runEgress(shell, { mode: "many" });
    const lines = many.section.split("\n");
    assert.ok(lines.includes("progs=25"));
    const progs = lines.filter((l) => l.startsWith("prog="));
    assert.equal(progs.length, 20);
    assert.equal(progs[0], "prog=prog24|25|25|600", "连接数最多的在前");
    assert.ok(Buffer.byteLength(many.section) <= 2048);
    assert.ok(lines.includes(`total=${(25 * 26) / 2}|325|${Array.from({ length: 25 }, (_, i) => i * (i + 1)).reduce((a, b) => a + b, 0)}`));
  });

  test(`collect.sh（${shell}）：tunnel-egress 段——端口取 CT_PORTS 第一个；没端口 / 越界 / 前导 0 → skip，不跑 ss`, { skip: process.platform === "win32" }, () => {
    assert.match(runEgress(shell, { ports: "7891,7892" }).calls[0], /dport = :7891 \)$/);
    for (const [ports, expected] of [["", "state=skip:no-ports"], ["70000", "state=skip:bad-ports"], ["07891", "state=skip:bad-ports"], ["7891;id", "state=skip:bad-ports"]]) {
      const { section, calls } = runEgress(shell, { ports });
      assert.equal(section, expected, ports);
      assert.deepEqual(calls, [], `${ports}：不应调用 ss`);
    }
  });
}
