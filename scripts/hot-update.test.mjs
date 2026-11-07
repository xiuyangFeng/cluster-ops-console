import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseLsofTxtPaths, selectPrunable, swapBack } from "./hot-update/bundle.mjs";
import { isDesktopMainCommand, monitorMatchesBuild } from "./hot-update/control-plane.mjs";
import { compareTunnelPids, planDataPlane } from "./hot-update/data-plane.mjs";
import { APP_NAME, resolveLayout, withAppDir } from "./hot-update/layout.mjs";
import { main, parseArgs } from "./hot-update/orchestrate.mjs";
import { runSmokeCli } from "./hot-update/smoke.mjs";

// 全部用例只在临时目录里造假 .app，exec/fetch/信号/冒烟/时钟全部注入假实现：
// 不做真构建、不发真信号、不碰 8877/8888 与真实数据目录。

const TOKEN = "secret-token-should-never-be-logged";
const DESKTOP_PID = 424242;

function writeBundle(appPath, info) {
  const res = path.join(appPath, "Contents/Resources/app");
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/MacOS", APP_NAME), "bin");
  fs.writeFileSync(path.join(res, "build-info.json"), JSON.stringify(info));
}

function readLiveInfo(layout) {
  return JSON.parse(fs.readFileSync(path.join(layout.appResources, "build-info.json"), "utf8"));
}

const V1 = { version: "1.0.0", gitCommit: "aaa1111", builtAt: "2026-09-01T00:00:00Z", components: { supervisor: "s1", proxy: "p1" } };
const V2 = { version: "2.0.0", gitCommit: "bbb2222", builtAt: "2026-09-28T00:00:00Z", components: { supervisor: "s2", proxy: "p2" } };

function setup(t, {
  live = V1,
  desktopRunning = true,
  desktopCmdline,
  sigusr2Restarts = true,
  pending = ["supervisor"],
  dataPlanePresent = true,
  dataPlaneExtra = {},
  upgradeBusyTimes = 0,
  upgradeResponse,
  smokeOk = true,
  codesignOk = true,
  buildOk = true,
  lsof = { code: 1, stdout: "" },
  backups = [],
  isTTY = false,
  promptAnswer = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hot-update-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: V2.version }));
  const dataDir = path.join(root, "data");
  const layout = resolveLayout({ rootDir: root, env: { CODEX_MONITOR_DATA_DIR: dataDir }, homeDir: root });
  if (live) writeBundle(layout.appDir, live);
  fs.mkdirSync(layout.runtimeDir, { recursive: true });
  if (desktopRunning) fs.writeFileSync(path.join(layout.runtimeDir, "desktop-main.pid.json"), JSON.stringify({ name: "desktop-main", pid: DESKTOP_PID }));
  backups.forEach((b, i) => {
    const p = path.join(layout.backupRoot, b.name);
    writeBundle(p, b.info || V1);
    const time = new Date(Date.UTC(2026, 0, 1 + i));
    fs.utimesSync(p, time, time);
  });

  const state = {
    now: 1_000_000,
    logs: [],
    runs: [],
    kills: [],
    posts: [],
    alive: new Set(desktopRunning ? [DESKTOP_PID] : []),
    monitor: live ? { build: { version: live.version, gitCommit: live.gitCommit, builtAt: live.builtAt }, startedAt: 1 } : null,
    buildCalls: 0,
  };
  const cmdline = desktopCmdline ?? path.join(layout.appDir, "Contents/MacOS", APP_NAME);

  const ctx = {
    platform: "darwin",
    log: (line) => state.logs.push(line),
    isTTY,
    prompt: async () => promptAnswer,
    now: () => state.now,
    sleep: async (ms) => { state.now += ms; },
    isAlive: (pid) => state.alive.has(pid),
    kill: (pid, sig) => {
      state.kills.push({ pid, sig });
      if (sig === "SIGUSR2" && sigusr2Restarts) {
        // 模拟 B：控制面从现役路径重启，报告磁盘上的构建。
        const info = readLiveInfo(layout);
        state.monitor = { build: { version: info.version, gitCommit: info.gitCommit, builtAt: info.builtAt }, startedAt: state.now + 10 };
      }
    },
    smoke: async () => (smokeOk ? { ok: true } : { ok: false, detail: "boom" }),
    computeHashes: async () => V2.components,
    fs: {
      readFile: (p, enc) => fsp.readFile(p, enc),
      stat: (p) => fsp.stat(p),
      readdir: (p) => fsp.readdir(p),
      realpath: (p) => fsp.realpath(p),
      rename: (a, b) => fsp.rename(a, b),
      mkdir: (p) => fsp.mkdir(p, { recursive: true }),
      rm: (p) => fsp.rm(p, { recursive: true, force: true }),
      rmdir: (p) => fsp.rmdir(p),
    },
    run: async (cmd, args) => {
      state.runs.push([cmd, ...args]);
      if (cmd === "bash" && args.includes("--output")) {
        state.buildCalls += 1;
        if (args.includes("--dry-run")) return { code: 0, stdout: "Staging build -> x\n", stderr: "" };
        if (!buildOk) return { code: 1, stdout: "", stderr: "" };
        writeBundle(args[args.indexOf("--output") + 1], V2);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "codesign") return codesignOk ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "invalid signature" };
      if (cmd === "ps") return state.alive.has(Number(args.at(-1))) ? { code: 0, stdout: `${cmdline}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      if (cmd === "lsof") return typeof lsof === "function" ? lsof(layout) : lsof;
      if (cmd === "open") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${cmd}`);
    },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      assert.equal(u.hostname, "127.0.0.1");
      const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
      if (!state.monitor) throw new Error("ECONNREFUSED");
      if (u.pathname === "/api/session") return reply(200, { token: TOKEN });
      const auth = init.headers?.["x-auth-token"];
      if (auth !== TOKEN) return reply(401, { error: "invalid auth token" });
      if (u.pathname === "/api/build-info") {
        const body = { monitorRunning: state.monitor };
        if (dataPlanePresent) body.dataPlane = { running: V1.components, bundle: V2.components, pending, ...dataPlaneExtra };
        return reply(200, body);
      }
      if (u.pathname === "/api/data-plane/upgrade" && init.method === "POST") {
        const req = JSON.parse(init.body);
        state.posts.push(req);
        if (state.posts.length <= upgradeBusyTimes) return reply(409, { error: "channel repair/restart in progress" });
        return reply(200, upgradeResponse || {
          ok: true,
          steps: ["spawn new supervisor", "adopt tunnels", "old supervisor exited"],
          tunnels: { before: { "tunnel.server-01": 111 }, after: { "tunnel.server-01": 111 } },
          proxy: req.components.includes("proxy") ? { beforePid: 50, afterPid: 51 } : { beforePid: 50, afterPid: 50 },
        });
      }
      return reply(404, {});
    },
  };
  return { ctx, state, layout, root };
}

const logText = (state) => state.logs.join("\n");

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("parseArgs handles flags, rollback id and invalid input", () => {
  assert.deepEqual(parseArgs([]).opts.rollback, false);
  const r = parseArgs(["--rollback", "2.0.0-20260101000000", "--dry-run"]).opts;
  assert.equal(r.rollback, true);
  assert.equal(r.rollbackId, "2.0.0-20260101000000");
  assert.equal(r.dryRun, true);
  assert.equal(parseArgs(["--rollback", "--launch"]).opts.rollbackId, "");
  assert.match(parseArgs(["--bogus"]).error, /未知参数/);
  assert.match(parseArgs(["--rollback", "../etc"]).error, /非法备份 id/);
  assert.match(parseArgs(["--port", "8877"]).error, /未知参数: --port/, "--port 已移除：控制面端口固定");
  assert.match(parseArgs(["--dry-run=1"]).error, /未知参数: --dry-run/);
  assert.match(parseArgs(["2.0.0-x"]).error, /未知参数: 2\.0\.0-x/, "备份 id 只能跟在 --rollback 后");
  assert.match(parseArgs(["--rollback", "a", "b"]).error, /未知参数: b/);
  assert.equal(parseArgs(["-h"]).opts.help, true);
  assert.match(parseArgs(["--with-proxy", "--no-data-plane"]).error, /互斥/);
  assert.equal(parseArgs(["--install-only"]).opts.installOnly, true);
  assert.match(parseArgs(["--install-only", "--launch"]).error, /互斥/);
  assert.match(parseArgs(["--install-only", "--with-proxy"]).error, /互斥/);
});

// isDesktopMainCommand 比对的是 macOS ps 输出的 .app 主二进制路径（app:update 只在 darwin 上运行，
// 见 orchestrate.mjs 的平台闸门）；win32 上 path.join 会拼出反斜杠路径，用例无意义，跳过。
test("isDesktopMainCommand accepts only the bare app binary", { skip: process.platform === "win32" }, () => {
  const appDir = "/Users/me/repo/Codex Operations Console.app";
  const bin = `${appDir}/Contents/MacOS/Codex Operations Console`;
  assert.equal(isDesktopMainCommand(bin, appDir), true);
  assert.equal(isDesktopMainCommand(`${bin} -psn_0_12345`, appDir), true);
  assert.equal(isDesktopMainCommand(`${bin} work/monitor/monitor-server.mjs`, appDir), false);
  assert.equal(isDesktopMainCommand(`${bin} /x/work/monitor/channel-supervisor.mjs`, appDir), false);
  assert.equal(isDesktopMainCommand(`${bin} Helper`, appDir), false);
  assert.equal(isDesktopMainCommand(`/other/Codex Operations Console.app/Contents/MacOS/Codex Operations Console`, appDir), false);
  assert.equal(isDesktopMainCommand(`${appDir}/Contents/Frameworks/Codex Operations Console Helper.app/x`, appDir), false);
  assert.equal(isDesktopMainCommand("", appDir), false);
});

test("monitorMatchesBuild requires the new build and a restart after the signal", () => {
  const exp = { version: "2.0.0", gitCommit: "bbb", builtAt: "t2" };
  assert.equal(monitorMatchesBuild({ build: { version: "2.0.0", gitCommit: "bbb", builtAt: "t2" }, startedAt: 5000 }, exp, 4000), true);
  assert.equal(monitorMatchesBuild({ build: { version: "1.0.0", gitCommit: "aaa" }, startedAt: 5000 }, exp, 4000), false);
  assert.equal(monitorMatchesBuild({ build: { version: "2.0.0", gitCommit: "bbb", builtAt: "t1" }, startedAt: 5000 }, exp, 4000), false, "same commit rebuild must match builtAt");
  assert.equal(monitorMatchesBuild({ build: { version: "2.0.0", gitCommit: "bbb", builtAt: "t2" }, startedAt: 100 }, exp, 40_000), false, "stale process answered");
  assert.equal(monitorMatchesBuild({ build: null }, exp, 0), false);
  assert.equal(monitorMatchesBuild({ build: { version: "2.0.0" } }, {}, 0), false);
});

test("planDataPlane hands off supervisor by default and proxy only on opt-in", () => {
  assert.deepEqual(planDataPlane({ pending: ["supervisor", "proxy"] }).components, ["supervisor"]);
  assert.deepEqual(planDataPlane({ pending: ["supervisor", "proxy"] }, { withProxy: true }).components, ["supervisor", "proxy"]);
  assert.deepEqual(planDataPlane({ pending: ["proxy"] }, { proxyConfirmed: true }).components, ["proxy"]);
  assert.deepEqual(planDataPlane({ pending: ["evil"] }).pending, []);
  assert.deepEqual(planDataPlane(undefined).components, []);
});

test("compareTunnelPids flags changed or vanished tunnels but not new ones", () => {
  assert.equal(compareTunnelPids({ a: 1 }, { a: 1, b: 2 }).unchanged, true);
  assert.equal(compareTunnelPids({ a: 1 }, { a: 1 }).verified, true);
  // 交接前没有隧道：没有 pid 变化，但也不能算"已核对未中断"。
  const empty = compareTunnelPids({}, { a: 5, b: 6 });
  assert.equal(empty.unchanged, true);
  assert.equal(empty.verified, false);
  assert.deepEqual(compareTunnelPids({ a: 1, c: 3 }, { a: 9 }).changed, [
    { name: "a", before: 1, after: 9 },
    { name: "c", before: 3, after: null },
  ]);
});

test("selectPrunable keeps newest and never deletes a backup whose binary is executing", () => {
  const backups = ["n1", "n2", "n3", "n4"].map((name) => ({ name, path: `/r/dist/backup/${name}`, realPath: `/r/dist/backup/${name}` }));
  const busy = parseLsofTxtPaths(`p123\nfTXT\nn/r/dist/backup/n3/Contents/MacOS/${APP_NAME}\np9\nn/usr/lib/dyld\n`);
  const { remove, skippedBusy } = selectPrunable(backups, { keep: 2, busyPaths: busy });
  assert.deepEqual(remove.map((b) => b.name), ["n4"]);
  assert.deepEqual(skippedBusy.map((b) => b.name), ["n3"]);
  assert.deepEqual(selectPrunable(backups, { keep: 2, busyPaths: [], protect: ["/r/dist/backup/n4"] }).remove.map((b) => b.name), ["n3"]);
  // 前缀相同但不同目录不能误判为占用
  assert.deepEqual(selectPrunable(backups, { keep: 2, busyPaths: ["/r/dist/backup/n3x/bin"] }).skippedBusy, []);
});

// ---------------------------------------------------------------------------
// 编排流程（假 ctx）
// ---------------------------------------------------------------------------

test("non-macOS platforms get a clear message and no action", async (t) => {
  const { ctx, state, layout } = setup(t);
  ctx.platform = "linux";
  assert.equal(await main([], ctx, layout), 2);
  assert.match(logText(state), /只适用于 macOS/);
  assert.equal(state.runs.length, 0);
});

test("happy path: staged build, swap, SIGUSR2, supervisor handoff with unchanged tunnels", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["supervisor", "proxy"] });
  const code = await main([], ctx, layout);
  assert.equal(code, 0, logText(state));
  const buildRun = state.runs.find((r) => r[0] === "bash" && r.includes("--output"));
  assert.ok(buildRun[buildRun.indexOf("--output") + 1].startsWith(layout.stagingRoot), "must build into staging");
  assert.deepEqual(readLiveInfo(layout).gitCommit, V2.gitCommit);
  const backups = fs.readdirSync(layout.backupRoot);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^1\.0\.0-\d{14}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.backupRoot, backups[0], "Contents/Resources/app/build-info.json"), "utf8")).gitCommit, V1.gitCommit, "backup dir is the old .app");
  assert.deepEqual(state.kills, [{ pid: DESKTOP_PID, sig: "SIGUSR2" }]);
  assert.deepEqual(state.posts, [{ components: ["supervisor"] }], "proxy is not handed off without opt-in");
  assert.match(logText(state), /隧道未中断/);
  assert.match(logText(state), /tunnel\.server-01=111/);
  assert.match(logText(state), /proxy 交接需 --with-proxy/);
  assert.doesNotMatch(logText(state), new RegExp(TOKEN), "token must never be printed");
  assert.equal(fs.existsSync(layout.stagingRoot) ? fs.readdirSync(layout.stagingRoot).length : 0, 0, "empty staging dir cleaned");
});

test("--with-proxy hands off supervisor and proxy", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["supervisor", "proxy"] });
  assert.equal(await main(["--with-proxy"], ctx, layout), 0, logText(state));
  assert.deepEqual(state.posts, [{ components: ["supervisor", "proxy"] }]);
  assert.match(logText(state), /代理 pid: 50 → 51/);
});

test("interactive TTY confirmation enables proxy handoff", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["proxy"], isTTY: true, promptAnswer: true });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  assert.deepEqual(state.posts, [{ components: ["proxy"] }]);
});

test("no pending data plane components means zero data-plane disturbance", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: [] });
  assert.equal(await main([], ctx, layout), 0);
  assert.equal(state.posts.length, 0);
  assert.match(logText(state), /零扰动/);
});

test("--no-data-plane skips the upgrade call", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["supervisor"] });
  assert.equal(await main(["--no-data-plane"], ctx, layout), 0);
  assert.equal(state.posts.length, 0);
});

test("missing dataPlane field (older control plane) is skipped gracefully", async (t) => {
  const { ctx, state, layout } = setup(t, { dataPlanePresent: false });
  assert.equal(await main([], ctx, layout), 0);
  assert.equal(state.posts.length, 0);
  assert.match(logText(state), /未提供 dataPlane/);
});

test("changed tunnel pids are reported as failure", async (t) => {
  const { ctx, state, layout } = setup(t, {
    upgradeResponse: { ok: true, steps: [], tunnels: { before: { "tunnel.server-01": 111 }, after: { "tunnel.server-01": 222 } }, proxy: {} },
  });
  assert.equal(await main([], ctx, layout), 1);
  assert.match(logText(state), /隧道 pid 发生变化/);
  assert.equal(readLiveInfo(layout).gitCommit, V2.gitCommit, "control plane stays on the new bundle");
});

test("no tunnels before the handoff: reported as unverifiable, never as ✓ uninterrupted", async (t) => {
  const { ctx, state, layout } = setup(t, {
    upgradeResponse: { ok: true, steps: [], tunnels: { before: {}, after: { "tunnel.server-01": 5007 } }, proxy: {} },
  });
  assert.equal(await main([], ctx, layout), 0, "handoff itself succeeded");
  assert.match(logText(state), /交接前没有运行中的隧道，无法核对隧道连续性/);
  assert.doesNotMatch(logText(state), /✓ 隧道未中断/);
});

test("control plane that never reports the new build triggers automatic rollback", async (t) => {
  const { ctx, state, layout } = setup(t, { sigusr2Restarts: false });
  assert.equal(await main([], ctx, layout), 1);
  assert.equal(readLiveInfo(layout).gitCommit, V1.gitCommit, "old bundle restored");
  assert.deepEqual(state.kills.map((k) => k.sig), ["SIGUSR2", "SIGUSR2"]);
  assert.equal(state.posts.length, 0);
  assert.match(logText(state), /自动回退/);
  const staged = fs.readdirSync(layout.stagingRoot);
  assert.equal(staged.length, 1);
  const parked = fs.readdirSync(path.join(layout.stagingRoot, staged[0]));
  assert.ok(parked.some((n) => n.includes(".failed-")), "failed bundle parked for inspection");
  assert.equal(fs.existsSync(layout.backupRoot) ? fs.readdirSync(layout.backupRoot).length : 0, 0);
});

test("smoke failure aborts before touching the live app or sending signals", async (t) => {
  const { ctx, state, layout } = setup(t, { smokeOk: false });
  assert.equal(await main([], ctx, layout), 1);
  assert.equal(readLiveInfo(layout).gitCommit, V1.gitCommit);
  assert.equal(state.kills.length, 0);
  assert.match(logText(state), /冒烟失败/);
});

test("codesign failure aborts before swap", async (t) => {
  const { ctx, state, layout } = setup(t, { codesignOk: false });
  assert.equal(await main([], ctx, layout), 1);
  assert.equal(readLiveInfo(layout).gitCommit, V1.gitCommit);
  assert.equal(state.kills.length, 0);
});

test("build failure aborts", async (t) => {
  const { ctx, state, layout } = setup(t, { buildOk: false });
  assert.equal(await main([], ctx, layout), 1);
  assert.equal(readLiveInfo(layout).gitCommit, V1.gitCommit);
  assert.match(logText(state), /构建失败/);
});

test("desktop not running: swap only, no signal, no data plane unless --launch", async (t) => {
  const { ctx, state, layout } = setup(t, { desktopRunning: false });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  assert.equal(readLiveInfo(layout).gitCommit, V2.gitCommit);
  assert.equal(state.kills.length, 0);
  assert.equal(state.posts.length, 0);
  assert.ok(!state.runs.some((r) => r[0] === "open"));
});

test("--install-only: swap with the desktop running but send no signal, no rollback, no data plane", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["supervisor"] });
  assert.equal(await main(["--install-only"], ctx, layout), 0, logText(state));
  assert.equal(readLiveInfo(layout).gitCommit, V2.gitCommit, "new bundle is live on disk");
  assert.equal(state.kills.length, 0, "no SIGUSR2: the user restarts the UI from the banner");
  assert.equal(state.posts.length, 0, "data plane is untouched until the control plane restarts");
  assert.match(logText(state), /重启界面（隧道不中断）/);
});

test("--launch opens the new app when the desktop is not running", async (t) => {
  const { ctx, state, layout } = setup(t, { desktopRunning: false });
  const origRun = ctx.run;
  ctx.run = async (cmd, args, o) => {
    const res = await origRun(cmd, args, o);
    if (cmd === "open") state.monitor = { build: { version: V2.version, gitCommit: V2.gitCommit, builtAt: V2.builtAt }, startedAt: state.now + 5 };
    return res;
  };
  assert.equal(await main(["--launch"], ctx, layout), 0, logText(state));
  assert.ok(state.runs.some((r) => r[0] === "open" && r[1] === layout.appDir));
  assert.deepEqual(state.posts, [{ components: ["supervisor"] }]);
});

test("a desktop-main record whose command line is a monitor script is not signalled", async (t) => {
  const { ctx, state, layout } = setup(t, { desktopCmdline: `${path.join(os.tmpdir(), "x")} work/monitor/monitor-server.mjs` });
  assert.equal(await main([], ctx, layout), 0);
  assert.equal(state.kills.length, 0);
});

test("--dry-run prints a plan and changes nothing", async (t) => {
  const { ctx, state, layout } = setup(t, { pending: ["supervisor", "proxy"] });
  assert.equal(await main(["--dry-run"], ctx, layout), 0);
  assert.equal(readLiveInfo(layout).gitCommit, V1.gitCommit);
  assert.equal(state.kills.length, 0);
  assert.equal(state.posts.length, 0);
  assert.ok(state.runs.every((r) => r[0] !== "codesign" && r[0] !== "open"));
  const build = state.runs.find((r) => r.includes("--output"));
  assert.ok(build.includes("--dry-run"));
  assert.match(logText(state), /SIGUSR2/);
  assert.match(logText(state), /将交接: supervisor/);
  assert.equal(fs.existsSync(layout.backupRoot), false);
});

test("backup pruning keeps 2 and skips a backup still executing", async (t) => {
  const backups = [{ name: "0.1.0-20260101000000" }, { name: "0.2.0-20260102000000" }, { name: "0.3.0-20260103000000" }];
  const { ctx, state, layout } = setup(t, {
    backups,
    lsof: (lay) => ({ code: 0, stdout: `p77\nn${fs.realpathSync(path.join(lay.backupRoot, "0.1.0-20260101000000"))}/Contents/MacOS/${APP_NAME}\n` }),
  });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  const left = fs.readdirSync(layout.backupRoot).sort();
  assert.ok(left.includes("0.1.0-20260101000000"), "busy backup must be kept");
  assert.ok(!left.includes("0.2.0-20260102000000"), "idle old backup pruned");
  assert.ok(left.includes("0.3.0-20260103000000"));
  assert.ok(left.some((n) => n.startsWith("1.0.0-")), "fresh backup kept");
});

test("lsof failure disables pruning instead of guessing", async (t) => {
  const backups = [{ name: "0.1.0-a" }, { name: "0.2.0-b" }, { name: "0.3.0-c" }];
  const { ctx, state, layout } = setup(t, { backups, lsof: { code: 127, stdout: "" } });
  assert.equal(await main([], ctx, layout), 0);
  assert.equal(fs.readdirSync(layout.backupRoot).length, 4);
  assert.match(logText(state), /不修剪备份/);
});

test("--rollback swaps the newest backup back in via SIGUSR2 without quitting", async (t) => {
  const OLD = { version: "0.9.0", gitCommit: "ccc0000", builtAt: "2026-08-01T00:00:00Z" };
  const { ctx, state, layout } = setup(t, { live: V2, backups: [{ name: "0.8.0-x", info: V1 }, { name: "0.9.0-y", info: OLD }], pending: [] });
  assert.equal(await main(["--rollback"], ctx, layout), 0, logText(state));
  assert.equal(readLiveInfo(layout).gitCommit, OLD.gitCommit);
  assert.deepEqual(state.kills, [{ pid: DESKTOP_PID, sig: "SIGUSR2" }]);
  const names = fs.readdirSync(layout.backupRoot);
  assert.ok(names.some((n) => n.startsWith("2.0.0-")), "current bundle saved as a backup");
  assert.ok(!names.includes("0.9.0-y"), "rolled-back backup moved into place");
  assert.equal(state.buildCalls, 0);
});

test("--rollback with an explicit id and failure path restores the target backup", async (t) => {
  const { ctx, layout } = setup(t, { live: V2, backups: [{ name: "1.0.0-x", info: V1 }], sigusr2Restarts: false });
  assert.equal(await main(["--rollback", "1.0.0-x"], ctx, layout), 1);
  assert.equal(readLiveInfo(layout).gitCommit, V2.gitCommit, "reverted to the bundle that was live");
  assert.ok(fs.existsSync(path.join(layout.backupRoot, "1.0.0-x")), "target backup put back");
});

test("--rollback with an unknown id fails without changes", async (t) => {
  const { ctx, state, layout } = setup(t, { backups: [{ name: "1.0.0-x" }] });
  assert.equal(await main(["--rollback", "nope"], ctx, layout), 1);
  assert.match(logText(state), /找不到备份/);
  assert.equal(state.kills.length, 0);
});

test("数据面升级：新 monitor 启动期短暂 409 → 退避重试后成功", async (t) => {
  const { ctx, state, layout } = setup(t, { upgradeBusyTimes: 2 });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  assert.equal(state.posts.length, 3);
  assert.match(logText(state), /控制面暂忙/);
  assert.match(logText(state), /隧道未中断/);
});

test("数据面升级：持续 409 超过重试预算 → 如实失败", async (t) => {
  const { ctx, state, layout } = setup(t, { upgradeBusyTimes: 99 });
  assert.equal(await main([], ctx, layout), 1);
  assert.equal(state.posts.length, 6, "首发 + 5 次重试");
  assert.match(logText(state), /HTTP 409/);
});

test("数据面升级：旧 supervisor 不支持交接 → 不发 POST，如实提示重启一次通道，exit 0", async (t) => {
  const { ctx, state, layout } = setup(t, { dataPlaneExtra: { handoffSupported: false, proxyHandoffSupported: false, snapshotAvailable: true, channelRunning: true } });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  assert.equal(state.posts.length, 0);
  assert.match(logText(state), /重启一次通道/);
  assert.doesNotMatch(logText(state), /可稍后重试/);
});

test("数据面升级：通道已停止 → 不发 POST，exit 0", async (t) => {
  const { ctx, state, layout } = setup(t, { dataPlaneExtra: { handoffSupported: false, snapshotAvailable: false, channelRunning: false } });
  assert.equal(await main([], ctx, layout), 0, logText(state));
  assert.equal(state.posts.length, 0);
  assert.match(logText(state), /通道当前已停止/);
});

test("数据面升级：200 + ok:false 时打印失败步骤详情", async (t) => {
  const { ctx, state, layout } = setup(t, {
    upgradeResponse: { ok: false, steps: [{ name: "supervisor-handoff", ok: false, detail: "old supervisor pid 9 did not exit within 5000ms" }], tunnels: { before: {}, after: {} } },
  });
  assert.equal(await main([], ctx, layout), 1);
  assert.match(logText(state), /失败步骤 supervisor-handoff: old supervisor pid 9/);
});

// ---------------------------------------------------------------------------
// swapBack 的回滚：换回旧包失败时不能把 appDir 留空
// 第二步 rename（backupDir → live）失败时，新包已经被挪到 parkDir，appDir 位置为空——
// 桌面上只剩一个打不开的 .app。必须把 parkDir 换回原位。
// ---------------------------------------------------------------------------

function fakeSwapCtx(failOn) {
  const calls = [];
  const ctx = {
    fs: {
      async mkdir(target) {
        calls.push(["mkdir", target]);
      },
      async rename(from, to) {
        calls.push([from, to]);
        if (failOn(from, to)) throw new Error(`EIO ${from} -> ${to}`);
      },
    },
  };
  return { ctx, calls };
}

test("swapBack: 换回旧包失败时把新包放回原位", async () => {
  const layout = { appDir: "/live/App.app", backupRoot: "/backup" };
  const swap = { backupDir: "/backup/old" };
  const { ctx, calls } = fakeSwapCtx((from, to) => from === "/backup/old" && to === "/live/App.app");

  await assert.rejects(() => swapBack(ctx, layout, swap, "/park/new"), /EIO \/backup\/old/);

  assert.deepEqual(calls.filter((c) => c[0] !== "mkdir"), [
    ["/live/App.app", "/park/new"],
    ["/backup/old", "/live/App.app"],
    ["/park/new", "/live/App.app"],
  ], "失败后必须把 parkDir 换回 appDir");
});

test("swapBack: 回滚也失败时必须报出两个包的真实位置（不掩盖现场）", async () => {
  const layout = { appDir: "/live/App.app", backupRoot: "/backup" };
  const swap = { backupDir: "/backup/old" };
  const { ctx } = fakeSwapCtx((from, to) => to === "/live/App.app" || from === "/park/new");

  await assert.rejects(
    () => swapBack(ctx, layout, swap, "/park/new"),
    (err) => {
      assert.match(err.message, /新包在 \/park\/new/);
      assert.match(err.message, /旧包在 \/backup\/old/);
      assert.match(err.message, /原始错误/);
      assert.match(err.message, /回滚错误/);
      return true;
    },
  );
});

test("swapBack: 成功路径不做任何多余 rename", async () => {
  const layout = { appDir: "/live/App.app", backupRoot: "/backup" };
  const swap = { backupDir: "/backup/old" };
  const { ctx, calls } = fakeSwapCtx(() => false);

  await swapBack(ctx, layout, swap, "/park/new");
  assert.deepEqual(calls.filter((c) => c[0] !== "mkdir"), [
    ["/live/App.app", "/park/new"],
    ["/backup/old", "/live/App.app"],
  ]);
});

test("swapBack: 首次安装（没有旧包）直接拒绝，不移动任何东西", async () => {
  const layout = { appDir: "/live/App.app", backupRoot: "/backup" };
  const { ctx, calls } = fakeSwapCtx(() => false);
  await assert.rejects(() => swapBack(ctx, layout, { backupDir: null }, "/park/new"), /没有旧包可换回/);
  assert.deepEqual(calls, [], "拒绝时不得触碰文件系统");
});

// ---- 产物冒烟 CLI（Release CI 复用 staged 冒烟）：只测参数与退出码，冒烟本体注入 ----

test("smoke CLI: usage errors exit 2, smoke failure exits 1, pass exits 0 with an absolute .app path", async () => {
  const calls = [];
  const lines = [];
  const opts = (ok) => ({
    platform: "darwin",
    log: (line) => lines.push(line),
    smoke: async (app, { timeoutMs }) => {
      calls.push({ app, timeoutMs });
      return ok ? { ok: true } : { ok: false, detail: "staged monitor 提前退出" };
    },
  });
  assert.equal(await runSmokeCli([], opts(true)), 2);
  assert.equal(await runSmokeCli(["not-an-app"], opts(true)), 2);
  assert.equal(await runSmokeCli(["A.app", "--timeout-ms", "x"], opts(true)), 2);
  assert.equal(await runSmokeCli(["A.app"], { ...opts(true), platform: "linux" }), 2);
  assert.equal(calls.length, 0, "用法错误不起冒烟");
  assert.equal(await runSmokeCli(["Codex Operations Console.app", "--timeout-ms", "90000"], opts(true)), 0);
  assert.equal(calls[0].timeoutMs, 90000);
  assert.ok(path.isAbsolute(calls[0].app) && calls[0].app.endsWith("Codex Operations Console.app"));
  assert.equal(await runSmokeCli(["A.app"], opts(false)), 1);
  assert.equal(calls[1].timeoutMs, 60000, "缺省 60s（CI 冷启动）");
  assert.match(lines.join("\n"), /冒烟失败：staged monitor 提前退出/);
});

test("--app：热更新指定位置的 .app，只认以应用名结尾的绝对路径", { skip: process.platform === "win32" ? "热更新 .app 只在 macOS 上用，路径按 POSIX 校验" : false }, () => {
  const app = "/Applications/Codex Operations Console.app";
  assert.equal(parseArgs(["--app", app]).opts.app, app);
  assert.equal(parseArgs([]).opts.app, "");
  assert.match(parseArgs(["--app", "Applications/Codex Operations Console.app"]).error, /--app/);
  assert.match(parseArgs(["--app", "/Applications/Other.app"]).error, /--app/);
  assert.match(parseArgs(["--app", "/Applications/../tmp/Codex Operations Console.app"]).error, /--app/);
  const base = resolveLayout({ rootDir: "/repo", env: {}, homeDir: "/Users/x" });
  const moved = withAppDir(base, app);
  assert.equal(moved.appDir, app);
  assert.equal(moved.appResources, `${app}/Contents/Resources/app`);
  assert.equal(moved.backupRoot, base.backupRoot);
  assert.equal(moved.buildScript, base.buildScript);
  assert.equal(moved.localConfigPath, base.localConfigPath);
});
