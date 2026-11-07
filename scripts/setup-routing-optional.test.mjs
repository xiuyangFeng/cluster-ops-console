// reclaude / zcode 两步路由（v2.57）：服务器上已经有它才写。同事默认不用这两样，
// 跑一次向导不能在别人的家目录里凭空建出 ~/.zcode，也不该刷一屏"请手动执行"的 reclaude 命令。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configureReclaudeRouting, configureZcodeRouting, ZCODE_DETECT_COMMAND } from "./setup/routing.mjs";

const skip = process.platform === "win32" ? "远端脚本用本机 sh 执行，需要 POSIX 环境" : false;

// 捕获向导的终端输出（logInfo 等都走 console.log）。
async function captured(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), text: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

// 假 SSH：按命令内容应答，并记录每次调用。
function fakeSsh(respond) {
  const calls = [];
  const ssh = (host, command, options) => {
    calls.push({ host, command, options });
    return { status: 0, stdout: "", stderr: "", ...respond(command) };
  };
  return { ssh, calls };
}

// 用本机 sh 在临时 HOME 里真的执行生成的远端命令（包括 wrapSh 的引号）。
function localHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "routing-optional-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ssh = (_host, command) => {
    const res = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  return { home, ssh };
}

test("zcode：服务器上没有 ~/.zcode → 只做一次只读检测就跳过，不建目录、不写文件", async () => {
  const { ssh, calls } = fakeSsh(() => ({ stdout: "NO_ZCODE\n" }));
  const { result, text } = await captured(() => configureZcodeRouting({ host: "h" }, 7892, { ssh, dryRun: false }));
  assert.equal(result, "absent");
  assert.equal(calls.length, 1, "除了检测不再发任何命令");
  assert.equal(calls[0].command, ZCODE_DETECT_COMMAND);
  assert.match(text, /未检测到 ZCode.*跳过/);
  assert.doesNotMatch(text, /请在服务器上手动/, "没装的人不该看到手动命令");
});

test("zcode：检测本身失败（SSH 断了）同样不写", async () => {
  const { ssh, calls } = fakeSsh(() => ({ status: 255, stderr: "Connection closed" }));
  const { result } = await captured(() => configureZcodeRouting({ host: "h" }, 7892, { ssh, dryRun: false }));
  assert.equal(result, "absent");
  assert.equal(calls.length, 1);
});

test("zcode：已有 ~/.zcode → 读回、合并、原子写入；其余键保留", { skip }, async (t) => {
  const { home, ssh } = localHome(t);
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "v2", "setting.json"), JSON.stringify({ theme: "dark", httpProxy: "http://old" }));
  const { result } = await captured(() => configureZcodeRouting({ host: "h" }, 7893, { ssh, dryRun: false }));
  assert.equal(result, "written");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".zcode", "v2", "setting.json"), "utf8")), {
    theme: "dark", httpProxy: "http://127.0.0.1:7893", httpProxyNoProxy: "localhost,127.0.0.1,::1",
  });
});

test("zcode：真实 sh 下，没用过 ZCode 的账号跑完这一步家目录里什么都没多", { skip }, async (t) => {
  const { home, ssh } = localHome(t);
  const { result } = await captured(() => configureZcodeRouting({ host: "h" }, 7892, { ssh, dryRun: false }));
  assert.equal(result, "absent");
  assert.deepEqual(fs.readdirSync(home), [], "没有凭空建出 ~/.zcode");
});

test("zcode --dry-run：不发 SSH，文案写明「已有 ~/.zcode 才写」", async () => {
  const { ssh, calls } = fakeSsh(() => ({}));
  const { result, text } = await captured(() => configureZcodeRouting({ host: "h" }, 7892, { ssh, dryRun: true }));
  assert.equal(result, "dry-run");
  assert.equal(calls.length, 0);
  assert.match(text, /仅当服务器上已有 ~\/\.zcode/);
});

test("reclaude：没有它的 systemd --user 服务 → 一句说明后跳过，不写 drop-in、不重启、不甩手动命令", async () => {
  const { ssh, calls } = fakeSsh(() => ({ stdout: "NO_RECLAUDE\n" }));
  const { result, text } = await captured(() => configureReclaudeRouting({ host: "h" }, 7892, { ssh, dryRun: false }));
  assert.equal(result, "absent");
  assert.equal(calls.length, 1);
  assert.match(text, /未检测到 reclaude.*跳过/);
  assert.doesNotMatch(text, /请在服务器上手动|systemctl --user restart/, "同事默认不用 reclaude，不该看到一屏手动命令");
});

test("reclaude：有服务 → 写 drop-in 再重启；写失败才给手动命令", async () => {
  const ok = fakeSsh((command) => (/list-unit-files/.test(command) ? { stdout: "HAS_RECLAUDE\n" } : {}));
  const done = await captured(() => configureReclaudeRouting({ host: "h" }, 7891, { ssh: ok.ssh, dryRun: false }));
  assert.equal(done.result, "written");
  assert.equal(ok.calls.length, 3, "检测 → 写 drop-in → 重启");
  assert.match(ok.calls[1].command, /reclaude\.service\.d\/proxy\.conf/);
  assert.match(ok.calls[2].command, /systemctl --user daemon-reload && systemctl --user restart reclaude/);

  const bad = fakeSsh((command) => (/list-unit-files/.test(command) ? { stdout: "HAS_RECLAUDE\n" } : { status: 1, stderr: "disk full" }));
  const failed = await captured(() => configureReclaudeRouting({ host: "h" }, 7891, { ssh: bad.ssh, dryRun: false }));
  assert.equal(failed.result, "failed");
  assert.match(failed.text, /写入 .*proxy\.conf 失败: disk full/);
  assert.match(failed.text, /请在服务器上手动执行/);
});

test("reclaude --dry-run：不发 SSH，文案写明「有 reclaude 服务才写」", async () => {
  const { ssh, calls } = fakeSsh(() => ({}));
  const { result, text } = await captured(() => configureReclaudeRouting({ host: "h" }, 7892, { ssh, dryRun: true }));
  assert.equal(result, "dry-run");
  assert.equal(calls.length, 0);
  assert.match(text, /仅当服务器上有 reclaude 的 systemd --user 服务时/);
});
