// 向导第 5 步（scripts/setup/cli-install.mjs）：纯函数 + 在临时「集群 HOME」里端到端演练（假 ssh = 本机 sh，
// 假官方安装器）。不联网：本机侧网络指向一个立即拒绝的端口，取不到的只是首选路径进度条的分母。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runInstallJob } from "../work/monitor/lib/cli/install.mjs";
import { parsePreflight } from "../work/monitor/lib/cli/remote-scripts.mjs";
import {
  buildCodexPackage,
  fakeRemote,
  fakeUpload,
  installFakeCurl,
  makeHome,
  runLocal,
  writeEnvSh,
  writeFakeCodexInstaller,
} from "../work/monitor/lib/cli/test-support.mjs";
import { describePreflight, installClis, installPrompt } from "./setup/cli-install.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;
const LATEST = { codex: { latest: "0.160.1" }, claude: { latest: "2.1.292" } };
const versions = { getLatest: async () => LATEST };
const deadUpstream = async () => ({ host: "127.0.0.1", port: 9 });

const pf = (lines) => parsePreflight("codex", `${lines.join("\n")}\nend=1\n`);

test("describePreflight / installPrompt：未装问安装、落后问更新、已最新不问、检测失败不问", () => {
  const none = pf(["visible=none"]);
  assert.equal(describePreflight("codex", none, "0.160.1"), "Codex：未安装，最新 0.160.1");
  assert.match(installPrompt("codex", none, "0.160.1"), /安装 Codex 0\.160\.1/);
  const old = pf(["current=0.159.2-x86_64-unknown-linux-musl"]);
  assert.equal(describePreflight("codex", old, "0.160.1"), "Codex：已装 0.159.2，最新 0.160.1");
  assert.match(installPrompt("codex", old, "0.160.1"), /从 0\.159\.2 更新到 0\.160\.1/);
  const fresh = pf(["current=0.160.1-x86_64-unknown-linux-musl"]);
  assert.equal(describePreflight("codex", fresh, "0.160.1"), "Codex：已装 0.160.1，已是最新");
  assert.equal(installPrompt("codex", fresh, "0.160.1"), null);
  assert.equal(installPrompt("codex", parsePreflight("codex", ""), "0.160.1"), null);
  assert.match(describePreflight("codex", parsePreflight("codex", ""), null), /检测失败/);
});

test("--dry-run：照常只读检测，但不提问、不安装", { skip }, async (t) => {
  const { home } = makeHome(t);
  const asked = [];
  const out = await installClis({ id: "server-01", host: "x" }, {
    dryRun: true, versions, remote: fakeRemote(home), getUpstream: deadUpstream, ask: async (q) => { asked.push(q); return "y"; }, write: () => {},
  });
  assert.equal(out.status, "dry-run");
  assert.deepEqual(out.results.map((r) => [r.id, r.action]), [["codex", "dry-run"], ["claude", "dry-run"]]);
  assert.deepEqual(asked, []);
});

// ---- v2.57 后续：Ctrl+C 走与工作台「取消」同一条清理路径 ----

async function waitUntil(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test("Ctrl+C：安装进行中按一次 → 结束集群上的官方安装器、清理完再以 130 退出；后面的 CLI 不再问", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const pkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: pkg.srcDir })}"`, "export FAKE_MODE=hang"]);
  let interrupt = null;
  let unhooked = 0;
  let job = null;
  const exits = [];
  const asked = [];
  const pending = installClis({ id: "server-01", host: "x" }, {
    dryRun: false,
    versions,
    remote: fakeRemote(home),
    upload: fakeUpload(home),
    getUpstream: deadUpstream,
    ask: async (q) => {
      asked.push(q);
      return "y";
    },
    write: () => {},
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => {
        unhooked += 1;
        interrupt = null;
      };
    },
    exit: (code) => exits.push(code),
    runJob: (j, deps, opts) => {
      job = j;
      return runInstallJob(j, deps, { ...opts, pollMs: 40 });
    },
  });
  const pidFile = () => path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId, "pid");
  assert.ok(await waitUntil(() => job?.phase === "official" && job.remoteJobId && fs.existsSync(pidFile())), "官方安装器跑起来了");
  const pid = Number(fs.readFileSync(pidFile(), "utf8"));
  assert.equal(typeof interrupt, "function", "安装期间接管了 Ctrl+C");

  interrupt();
  const out = await pending;
  assert.deepEqual(exits, [130], "清理做完才退出，退出码按惯例 130");
  assert.equal(job.status, "cancelled");
  assert.throws(() => process.kill(pid, 0), "集群上的官方安装器已结束");
  assert.equal(fs.readFileSync(path.join(path.dirname(pidFile()), "exit"), "utf8").trim(), "143");
  assert.equal(out.status, "cancelled");
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [["codex", "cancelled"]]);
  assert.equal(asked.length, 1, "没有再去问 Claude Code");
  assert.equal(unhooked, 1, "安装结束后把 Ctrl+C 还回去");
  assert.equal(runLocal(home, 'ls "$HOME/.local/bin/codex" 2>/dev/null').stdout.trim(), "", "集群上什么都没装");
});

test("Ctrl+C：落盘 / 切软链期间按一次只提示等它跑完（不发取消）；再按一次才强制退出", { skip }, async (t) => {
  const { home } = makeHome(t);
  let interrupt = null;
  let finish = null;
  let seenSignal = null;
  const exits = [];
  const pending = installClis({ id: "server-01", host: "x" }, {
    dryRun: false,
    versions,
    remote: fakeRemote(home),
    getUpstream: deadUpstream,
    ask: async (q) => (q.includes("Codex") ? "y" : ""),
    write: () => {},
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => {};
    },
    exit: (code) => exits.push(code),
    // 假流程：停在不可取消的落盘阶段，由测试放行。
    runJob: (job, _deps, { signal }) => new Promise((resolve) => {
      seenSignal = signal;
      Object.assign(job, { phase: "activate", phaseText: "集群上解包、冒烟并切换", cancellable: false });
      finish = () => {
        Object.assign(job, { status: "succeeded", installedVersion: "0.160.1", path: "fallback" });
        resolve(job);
      };
    }),
  });
  assert.ok(await waitUntil(() => finish));
  interrupt();
  assert.equal(seenSignal.aborted, false, "临界阶段不发取消信号");
  assert.deepEqual(exits, [], "也不退出");
  interrupt();
  assert.deepEqual(exits, [130], "第二次：强制退出");
  finish();
  const out = await pending;
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [["codex", "ok"], ["claude", "skipped"]]);
});

test("端到端：codex 回答 y → 经假官方安装器装好；Claude 回车跳过", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const pkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: pkg.srcDir })}"`]);
  const answers = { Codex: "y", "Claude Code": "" };
  const written = [];
  const out = await installClis({ id: "server-01", host: "x" }, {
    dryRun: false,
    versions,
    remote: fakeRemote(home),
    upload: fakeUpload(home),
    getUpstream: deadUpstream,
    ask: async (q) => answers[Object.keys(answers).find((k) => q.includes(k))],
    write: (s) => written.push(s),
    runJob: (job, deps, opts) => import("../work/monitor/lib/cli/install.mjs").then((m) => m.runInstallJob(job, deps, { ...opts, pollMs: 40 })),
  });
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [["codex", "ok"], ["claude", "skipped"]]);
  assert.equal(out.results[0].version, "0.160.1");
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
  assert.ok(written.some((s) => s.includes("集群上运行官方安装器")), "终端里刷了进度");
});
