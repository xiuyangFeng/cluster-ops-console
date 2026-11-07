// scripts/test-tz.mjs —— 把整套 npm test 放到别的机器时区下各跑一遍（npm run test:tz）。
//
// 用法：
//   npm run test:tz                                  # 时区表：work/monitor/lib/test-timezones.mjs 的 TEST_TIME_ZONES
//   npm run test:tz -- Asia/Tokyo Europe/Berlin      # 只跑指定的时区
//   npm run test:tz -- UTC --test-name-pattern=趋势   # 以 - 开头的参数原样追加给 node --test
//
// 为什么要有它：历史日文件、用量、简报、隧道稳定性、Slurm 的时刻都按北京时间，开发机又都在 UTC+8——
// 代码或测试不小心用了本机时区，本机 npm test 照样全绿，只有 CI（UTC）会红。口径敏感的用例已经用
// inEveryTimeZone 在进程内换时区自查；这里是整套测试的兜底，提交前 / 动了时间相关代码后跑一遍。
//
// 测试命令取自 package.json 的 scripts.test（不另写一份 glob）；TZ 经子进程的环境变量传入、不过 shell，
// Windows 上同样可用（`TZ=UTC npm test` 这种写法在 cmd / PowerShell 里不成立）。逐个时区串行跑：
// 并行会互相抢 CPU，时序敏感的用例容易误报。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { TEST_TIME_ZONES } from "../work/monitor/lib/test-timezones.mjs";
import { isMainModule } from "./lib/is-main.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

// `node --test --test-concurrency=4 "scripts/*.test.mjs" "work/**/*.test.mjs"` → 去掉开头的 node 之后的参数。
// 只认「node + 参数、双引号包住含通配符的参数」这一种写法；换成别的形式（串联命令、环境变量前缀）就报错，
// 提醒同步改这里，而不是悄悄跑一套不一样的测试。
export function parseTestCommand(script) {
  const tokens = [...String(script ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
  if (tokens[0] !== "node" || !tokens.includes("--test") || tokens.some((token) => /^(&&|\|\||;|\|)$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))) {
    throw new Error(`package.json 的 scripts.test 不是单条 node --test 命令，scripts/test-tz.mjs 需要同步调整：${script}`);
  }
  return tokens.slice(1);
}

// 子进程的参数：npm test 的选项 + 固定的报告格式 + 命令行追加的选项，最后才是测试文件的通配符。
// 选项必须排在通配符前面——排在后面的既不报错也不生效（实测 --test-name-pattern 放在后面时照样跑了全部用例）。
// 报告格式固定成 spec：不指定的话，stdout 不是终端时旧版 Node 会改用 TAP，统计行就认不出来了。
export function buildChildArgs(testArgs, extra = []) {
  const firstFile = testArgs.findIndex((arg) => !arg.startsWith("-"));
  const split = firstFile < 0 ? testArgs.length : firstFile;
  return [...testArgs.slice(0, split), "--test-reporter=spec", "--test-reporter-destination=stdout", ...extra, ...testArgs.slice(split)];
}

// 命令行参数 → { zones, extra }：不以 - 开头的是时区名（必须是本机 ICU 认识的 IANA 名字），其余原样传给 node --test。
export function splitArgs(argv, defaults = TEST_TIME_ZONES) {
  const zones = [];
  const extra = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      extra.push(arg);
      continue;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: arg });
    } catch {
      throw new Error(`不认识的时区：${arg}（要 IANA 名字，如 UTC、America/Los_Angeles、Pacific/Auckland）`);
    }
    zones.push(arg);
  }
  return { zones: zones.length ? zones : [...defaults], extra };
}

// spec 报告末尾的统计行（ℹ tests / pass / fail / skipped）与失败清单（✖ failing tests: 之后的部分）。
export function summarize(output) {
  const count = (name) => {
    const match = new RegExp(`^ℹ ${name} (\\d+)$`, "m").exec(output);
    return match ? Number(match[1]) : null;
  };
  const at = output.indexOf("✖ failing tests:");
  return { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), failures: at < 0 ? "" : output.slice(at).trimEnd() };
}

function runZone(zone, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: { ...process.env, TZ: zone },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolve({ zone, code: 1, output: `${output}\n${error.stack || error}`, ms: Date.now() - started }));
    child.once("close", (code, signal) => resolve({ zone, code: code ?? 1, signal, output, ms: Date.now() - started }));
  });
}

async function main(argv) {
  let zones;
  let args;
  try {
    const parsed = splitArgs(argv);
    zones = parsed.zones;
    args = buildChildArgs(parseTestCommand(JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).scripts.test), parsed.extra);
  } catch (error) {
    console.error(`test:tz：${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.log(`test:tz —— 依次在 ${zones.join("、")} 下运行：node ${args.join(" ")}`);
  const failed = [];
  for (const zone of zones) {
    const result = await runZone(zone, args);
    const stats = summarize(result.output);
    const seconds = Math.round(result.ms / 1000);
    if (result.code === 0) {
      console.log(`✔ TZ=${zone}：${stats.pass ?? "?"} 通过${stats.skipped ? `，${stats.skipped} 跳过` : ""}（${seconds} 秒）`);
      continue;
    }
    failed.push(zone);
    console.log(`✖ TZ=${zone}：${stats.fail ?? "?"} 失败 / ${stats.tests ?? "?"}（${seconds} 秒${result.signal ? `，信号 ${result.signal}` : ""}）`);
    // 有失败清单就只打清单；没有（运行器自己崩了）就把输出的尾巴打出来。
    console.log(stats.failures || result.output.split("\n").slice(-60).join("\n"));
  }
  if (failed.length) {
    console.log(`\ntest:tz 失败：${failed.join("、")}。单独复现：npm run test:tz -- ${failed[0]}`);
    process.exitCode = 1;
  } else {
    console.log(`\ntest:tz 通过：${zones.length} 个时区全绿。`);
  }
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
