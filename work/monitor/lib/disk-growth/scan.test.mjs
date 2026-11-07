import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DIR_USAGE_MAX_ENTRIES, DIR_USAGE_MAX_SEC, DIR_USAGE_REMOTE_COMMAND, DIR_USAGE_TIMEOUT_MS } from "../dir-usage/scan.mjs";
import { buildHomeProbeInvocation, buildMeasureInvocation, DISK_GROWTH_SSH_TIMEOUT_MS, HOME_PROBE_COMMAND, parseHomeProbe } from "./scan.mjs";

const SERVER = { id: "s1", host: "myserver" };

test("调用组装：远端命令都是常量，集合目录与游标只走 stdin；单次 SSH 20 秒", () => {
  assert.ok(DISK_GROWTH_SSH_TIMEOUT_MS <= 20_000 && DISK_GROWTH_SSH_TIMEOUT_MS < DIR_USAGE_TIMEOUT_MS);
  assert.ok(DIR_USAGE_MAX_ENTRIES <= 20000 && DIR_USAGE_MAX_SEC <= 8, "每轮的远端预算沿用扫描器的上限");

  const root = "数据 集/it's \"q\"/outputs";
  const measure = buildMeasureInvocation({ server: SERVER, parsed: {}, root, pending: [["批次 1/units", 3]], platform: "darwin" });
  assert.equal(measure.file, "ssh");
  assert.equal(measure.args.at(-1), DIR_USAGE_REMOTE_COMMAND);
  assert.equal(measure.timeoutMs, DISK_GROWTH_SSH_TIMEOUT_MS);
  assert.ok(!measure.args.join(" ").includes("outputs"), "目录名不进命令行");
  assert.deepEqual(JSON.parse(measure.input.split("\n")[1]), { root, maxEntries: DIR_USAGE_MAX_ENTRIES, maxSec: DIR_USAGE_MAX_SEC, pending: [["批次 1/units", 3]] });
  assert.equal("pending" in JSON.parse(buildMeasureInvocation({ server: SERVER, parsed: {}, root, platform: "darwin" }).input.split("\n")[1]), false);

  const probe = buildHomeProbeInvocation({ server: SERVER, parsed: {}, platform: "darwin" });
  assert.equal(probe.args.at(-1), HOME_PROBE_COMMAND);
  assert.equal(probe.input, "", "不留着标准输入等数据");
  assert.equal(probe.timeoutMs, DISK_GROWTH_SSH_TIMEOUT_MS);
  assert.match(HOME_PROBE_COMMAND, /^sh -c '/, "经 sh 执行，不依赖对方的登录 shell");
  assert.ok(!HOME_PROBE_COMMAND.includes("myserver"));
});

test("家目录探测输出：只认 env= / real= 两行，路径不合格就当没读到", () => {
  assert.deepEqual(parseHomeProbe("env=/home/kai\nreal=/public/home/kai\n"), { home: "/public/home/kai", homeEnv: "/home/kai" });
  assert.deepEqual(parseHomeProbe("motd banner\nenv=/public/home/kai\nreal=/public/home/kai\n"), { home: "/public/home/kai", homeEnv: null });
  assert.deepEqual(parseHomeProbe("real=/家 目录/用户/\n"), { home: "/家 目录/用户", homeEnv: null });
  assert.deepEqual(parseHomeProbe("env=relative\nreal=/h/u\nreal=/other\n"), { home: "/h/u", homeEnv: null }, "同名行只认第一条");
  assert.equal(parseHomeProbe("env=/home/kai\n"), null, "cd 失败没有 real 行");
  assert.equal(parseHomeProbe("real=/\n"), null);
  assert.equal(parseHomeProbe("real=relative\n"), null);
  assert.equal(parseHomeProbe(""), null);
  assert.equal(parseHomeProbe(null), null);
});

// 真实 /bin/sh：家目录经过符号链接时，env 是原值、real 是物理路径。
test("家目录探测命令：在真实 sh 上给出 $HOME 原值与物理路径", { skip: process.platform === "win32" }, () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "disk-growth-home-")));
  try {
    const real = path.join(base, "真实 家目录", "kai");
    const link = path.join(base, "home-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const run = (home) => spawnSync("/bin/sh", ["-c", HOME_PROBE_COMMAND], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8", timeout: 60_000 });
    const linked = run(link);
    assert.equal(linked.status, 0, linked.stderr);
    assert.deepEqual(parseHomeProbe(linked.stdout), { home: real, homeEnv: link });
    assert.deepEqual(parseHomeProbe(run(real).stdout), { home: real, homeEnv: null });
    assert.equal(parseHomeProbe(run(path.join(base, "missing")).stdout), null, "家目录不存在：读不出物理路径");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
