// scripts/test-tz.mjs 的纯函数，以及「换时区跑测试」这条防线的接线（package.json 入口、CI 矩阵）。
// 这里不真的再跑一遍整套测试（那是 npm run test:tz 干的事）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { TEST_TIME_ZONES } from "../work/monitor/lib/test-timezones.mjs";
import { buildChildArgs, parseTestCommand, splitArgs, summarize } from "./test-tz.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

test("parseTestCommand: 取出 npm test 里 node 之后的参数，引号去掉、通配符原样留给 node 展开", () => {
  assert.deepEqual(
    parseTestCommand('node --test --test-concurrency=4 "scripts/*.test.mjs" "work/**/*.test.mjs"'),
    ["--test", "--test-concurrency=4", "scripts/*.test.mjs", "work/**/*.test.mjs"],
  );
  // 现在的 package.json 就是这种写法：换了写法要同步改 test-tz.mjs，而不是让它悄悄跑一套不一样的测试
  const args = parseTestCommand(pkg.scripts.test);
  assert.equal(args[0], "--test");
  assert.ok(args.includes("scripts/*.test.mjs") && args.includes("work/**/*.test.mjs"), args.join(" "));
  for (const bad of ["", "vitest run", "node scripts/x.mjs", "TZ=UTC node --test a", "node --test a && node --test b", "node --test a | tee log"]) {
    assert.throws(() => parseTestCommand(bad), /scripts\.test 不是单条 node --test 命令/, bad);
  }
});

test("buildChildArgs: 报告格式与追加的选项排在测试文件通配符之前（排在后面不生效）", () => {
  assert.deepEqual(
    buildChildArgs(["--test", "--test-concurrency=4", "scripts/*.test.mjs", "work/**/*.test.mjs"], ["--test-name-pattern=趋势"]),
    ["--test", "--test-concurrency=4", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-name-pattern=趋势", "scripts/*.test.mjs", "work/**/*.test.mjs"],
  );
  assert.deepEqual(buildChildArgs(["--test"]), ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout"]);
});

test("splitArgs: 不带参数用整张时区表；指定时区只跑指定的；以 - 开头的原样传给 node --test；时区名写错就报错", () => {
  assert.deepEqual(splitArgs([]), { zones: [...TEST_TIME_ZONES], extra: [] });
  assert.deepEqual(splitArgs(["Asia/Tokyo", "--test-name-pattern=趋势", "UTC"]), { zones: ["Asia/Tokyo", "UTC"], extra: ["--test-name-pattern=趋势"] });
  assert.deepEqual(splitArgs(["--test-only"]).zones, [...TEST_TIME_ZONES]);
  assert.throws(() => splitArgs(["Mars/Olympus_Mons"]), /不认识的时区：Mars\/Olympus_Mons/);
});

test("summarize: 认 spec 报告的统计行与失败清单", () => {
  const ok = summarize("✔ a (1ms)\nℹ tests 3325\nℹ suites 22\nℹ pass 3320\nℹ fail 0\nℹ cancelled 0\nℹ skipped 5\nℹ todo 0\n");
  assert.deepEqual(ok, { tests: 3325, pass: 3320, fail: 0, skipped: 5, failures: "" });
  const bad = summarize("✖ b (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n\n✖ failing tests:\n\ntest at x.test.mjs:1:1\n✖ b (2ms)\n  AssertionError: 1 !== 2\n\n");
  assert.equal(bad.fail, 1);
  assert.equal(bad.failures, "✖ failing tests:\n\ntest at x.test.mjs:1:1\n✖ b (2ms)\n  AssertionError: 1 !== 2");
  assert.deepEqual(summarize("node: bad option"), { tests: null, pass: null, fail: null, skipped: null, failures: "" });
});

test("时区表：每个名字本机都认识，且覆盖 UTC、UTC+8 以西、非整点偏移、UTC+8 以东", () => {
  const offsetMin = (zone) => {
    // 2026-01-15 00:00 UTC 在该时区的钟面时间 − UTC 钟面时间（分钟）
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
      .formatToParts(new Date(Date.UTC(2026, 0, 15))).map((p) => [p.type, Number(p.value)]));
    return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Date.UTC(2026, 0, 15)) / 60000;
  };
  const offsets = TEST_TIME_ZONES.map(offsetMin);
  assert.ok(offsets.includes(0), "UTC");
  assert.ok(offsets.some((m) => m < 0), "UTC 以西");
  assert.ok(offsets.some((m) => m % 60 !== 0), "非整点偏移");
  assert.ok(offsets.some((m) => m > 8 * 60), "UTC+8 以东");
  assert.ok(!offsets.includes(8 * 60), "UTC+8 就是开发机默认的时区，不用再列");
});

test("接线：npm run test:tz 指向本脚本；CI 的 test 矩阵每个 job 带 TZ，且至少一个既不是 UTC 也不是 UTC+8", () => {
  assert.equal(pkg.scripts["test:tz"], "node scripts/test-tz.mjs");
  const workflow = readFileSync(path.join(rootDir, ".github/workflows/test.yml"), "utf8");
  const testJob = workflow.slice(workflow.indexOf("\n  test:"), workflow.indexOf("\n  lint:"));
  const rows = [...testJob.matchAll(/^\s+- os: (\S+)\n\s+node-version: \S+\n(?:\s+tz: (\S+)\n)?/gm)].map((m) => ({ os: m[1], tz: m[2] ?? null }));
  assert.ok(rows.length >= 3, `没解析出 test 矩阵（${rows.length} 行）`);
  assert.deepEqual(rows.filter((row) => !row.tz), [], "每个矩阵行都要写 tz");
  for (const { tz } of rows) assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }), `矩阵里的时区名无效：${tz}`);
  const foreign = rows.filter((row) => !["UTC", "Etc/UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Taipei"].includes(row.tz));
  assert.ok(foreign.length >= 1, "至少一个 job 要跑在非 UTC、非 UTC+8 的时区");
  assert.match(testJob, /- name: Run tests\n\s+env:\n\s+TZ: \$\{\{ matrix\.tz \}\}\n\s+run: npm test/, "矩阵里的 tz 要真的传给跑测试的那一步");
});
