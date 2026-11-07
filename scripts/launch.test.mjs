import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUTOSTART_ENV, AUTOSTART_FLAG, LAUNCHER_PATH_ENV } from "../work/monitor/lib/autostart/launch-flag.mjs";
import { LAUNCHER_NODE_ENV, RESPAWN_ENV, RESTART_EXIT_CODE } from "../work/monitor/lib/self-update/restart-code.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assessSetup } from "../work/monitor/lib/onboarding.mjs";
import { mergeConfig } from "../work/monitor/lib/config-loader.mjs";
import {
  browserOpenCommand,
  consoleUrl,
  detectSetupState,
  readSetupState,
  setupHintLines,
  shouldOpenBrowser,
  ELECTRON_BOOT_GRACE_MS,
  electronFailureLines,
  shouldFallbackToWeb,
  launcherEvent,
  launcherExitCode,
  monitorExitMessage,
  shouldRespawn,
} from "./launch.mjs";
import { isMainModule, isSameModulePath } from "./lib/is-main.mjs";

const team = {
  servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
};

test("detectSetupState: 个人层不存在 → 从没跑过向导", () => {
  assert.deepEqual(detectSetupState({ team, localState: "missing" }), { needsSetup: true, reason: "no-local-config" });
});

test("detectSetupState: 个人层存在但缺 sshUser 且 server-01 启用 → 向导没走完", () => {
  assert.deepEqual(detectSetupState({ team, local: { activeServerId: "server-01" } }), { needsSetup: true, reason: "missing-ssh-user" });
});

test("detectSetupState: 全局 sshUser 已写 → 正常", () => {
  assert.deepEqual(detectSetupState({ team, local: { sshUser: "kai" } }), { needsSetup: false, reason: null });
});

test("detectSetupState: server-01 被个人层屏蔽（我不在这个集群）→ 不需要 sshUser", () => {
  const local = { servers: [{ id: "server-01", disabled: true }] };
  assert.equal(detectSetupState({ team, local }).needsSetup, false);
});

test("detectSetupState: 团队层没有 server-01 时只看个人层是否存在", () => {
  assert.equal(detectSetupState({ team: { servers: [] }, local: {} }).needsSetup, false);
});

test("detectSetupState: 个人层损坏 → 只提示不引导重跑", () => {
  assert.deepEqual(detectSetupState({ team, localState: "invalid" }), { needsSetup: false, reason: "invalid-local-config" });
});

test("readSetupState: 通过注入的读文件区分 ENOENT / 损坏 / 正常", () => {
  const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
  const reader = (localContent) => (p) => {
    if (p === "team.json") return JSON.stringify(team);
    if (localContent instanceof Error) throw localContent;
    return localContent;
  };
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "local.json", readFile: reader(enoent) }).reason, "no-local-config");
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "local.json", readFile: reader("{oops") }).reason, "invalid-local-config");
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "local.json", readFile: reader("[]") }).reason, "invalid-local-config");
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "local.json", readFile: reader('{"sshUser":"kai"}') }).needsSetup, false);
});

test("readSetupState: 团队层读不到时不打扰", () => {
  const readFile = () => { throw new Error("boom"); };
  assert.deepEqual(readSetupState({ configPath: "x", localConfigPath: "y", readFile }), { needsSetup: false, reason: null });
});

test("setupHintLines: 还没接入时指向页面里的接入引导（命令行向导只作后备），正常时无输出", () => {
  assert.deepEqual(setupHintLines({ needsSetup: false, reason: null }), []);
  for (const reason of ["no-local-config", "missing-ssh-user", "missing-port"]) {
    const text = setupHintLines({ reason }).join("\n");
    assert.match(text, /接入引导/, reason);
    assert.match(text, /后备[\s\S]*npm run setup/, reason);
    assert.doesNotMatch(text, /请先在仓库根目录执行|请执行: npm run setup/, "不再要求先回终端跑向导");
  }
  assert.match(setupHintLines({ reason: "no-local-config" }).join("\n"), /白名单/);
  assert.match(setupHintLines({ reason: "missing-ssh-user" }).join("\n"), /白名单/);
  assert.match(setupHintLines({ reason: "invalid-local-config" }, { localConfigPath: "/d/config.local.json" }).join("\n"), /\/d\/config\.local\.json 不是有效的 JSON/);
});

test("启动不会停下来等终端输入：首次运行检测只打印提示（双击启动的人面对的是页面，不是终端）", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /askLine|setup-wizard\.mjs/, "launch.mjs 不再提问、不再代跑命令行向导");
});

test("shouldOpenBrowser: --no-open / 环境变量 / CI / 无图形会话的 Linux 均不打开", () => {
  assert.equal(shouldOpenBrowser({ argv: [], env: {}, platform: "darwin" }), true);
  assert.equal(shouldOpenBrowser({ argv: [], env: {}, platform: "win32" }), true);
  assert.equal(shouldOpenBrowser({ argv: ["--no-open"], env: {}, platform: "darwin" }), false);
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(shouldOpenBrowser({ argv: [AUTOSTART_FLAG], env: { DISPLAY: ":0" }, platform }), false, `开机自启不弹浏览器（${platform}）`);
  }
  assert.equal(shouldOpenBrowser({ argv: [], env: { CODEX_MONITOR_NO_OPEN: "1" }, platform: "darwin" }), false);
  assert.equal(shouldOpenBrowser({ argv: [], env: { CI: "true" }, platform: "win32" }), false);
  assert.equal(shouldOpenBrowser({ argv: [], env: {}, platform: "linux" }), false);
  assert.equal(shouldOpenBrowser({ argv: [], env: { DISPLAY: ":0" }, platform: "linux" }), true);
});

test("browserOpenCommand: 三平台命令", () => {
  const url = "http://127.0.0.1:8877";
  assert.deepEqual(browserOpenCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserOpenCommand("linux", url), { command: "xdg-open", args: [url] });
  const win = browserOpenCommand("win32", url);
  assert.equal(win.command, "cmd");
  assert.deepEqual(win.args, ["/c", "start", '""', url]);
  assert.equal(win.options.windowsVerbatimArguments, true);
});

test("consoleUrl: 默认 8877，尊重合法 PORT", () => {
  assert.equal(consoleUrl({}), "http://127.0.0.1:8877");
  assert.equal(consoleUrl({ PORT: "9001" }), "http://127.0.0.1:9001");
  assert.equal(consoleUrl({ PORT: "0" }), "http://127.0.0.1:8877", "网页启动不会把随机端口打印成不可达的 0");
  assert.equal(consoleUrl({ PORT: "abc" }), "http://127.0.0.1:8877");
});

// ---- 修复轮：launch 与 /api/status.onboarding 同一判定 ----
const sshCy = (host) => (host === "myserver" ? "kai" : "");

test("detectSetupState: ~/.ssh/config 的 Host 别名解析出 User 时，个人层缺 sshUser 不算没走完", () => {
  assert.deepEqual(detectSetupState({ team, local: { activeServerId: "server-01" }, resolveSshUser: sshCy }), { needsSetup: false, reason: null });
  // 解析不出（别名不同）仍判向导没走完
  assert.equal(detectSetupState({ team, local: {}, resolveSshUser: () => "" }).reason, "missing-ssh-user");
});

test("detectSetupState: 个人层缺失但 ssh 别名能解析 User → 视为可用，仅提示", () => {
  const state = detectSetupState({ team, localState: "missing", resolveSshUser: sshCy });
  assert.equal(state.needsSetup, false);
  assert.equal(state.reason, "no-local-config-ssh-ok");
  assert.equal(state.sshUser, "kai");
  const text = setupHintLines(state).join("\n");
  assert.match(text, /User=kai/);
});

test("detectSetupState 与 assessSetup（/api/status.onboarding）在同一输入上结论一致", () => {
  const cases = [
    { localState: "missing", local: {}, resolveSshUser: () => "" },
    { localState: "missing", local: {}, resolveSshUser: sshCy },
    { localState: "ok", local: {}, resolveSshUser: () => "" },
    { localState: "ok", local: {}, resolveSshUser: sshCy },
    { localState: "ok", local: { sshUser: "kai" }, resolveSshUser: () => "" },
  ];
  for (const c of cases) {
    const launch = detectSetupState({ team, ...c });
    const merged = mergeConfig(team, c.localState === "ok" ? c.local : {}, { warn: () => {} });
    const onboarding = assessSetup({ localState: c.localState, merged, resolveSshUser: c.resolveSshUser }).state;
    assert.equal(launch.needsSetup, onboarding === "needs-setup" || onboarding === "partial", JSON.stringify({ c: { ...c, resolveSshUser: String(c.resolveSshUser) }, launch, onboarding }));
  }
});

test("readSetupState: 注入 resolveSshUser 透传给判定", () => {
  const readFile = (p) => (p === "team.json" ? JSON.stringify(team) : "{}");
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "l.json", readFile }).reason, "missing-ssh-user");
  assert.equal(readSetupState({ configPath: "team.json", localConfigPath: "l.json", readFile, resolveSshUser: sshCy }).needsSetup, false);
});

test("桌面壳没起来 → 回退网页模式：启动后很快被信号终止或非零退出才算；正常关窗与跑久了再崩都不回退", () => {
  // Apple Silicon 上签名失效的 Electron：一启动就被 SIGKILL。
  assert.equal(shouldFallbackToWeb({ code: null, signal: "SIGKILL", elapsedMs: 300 }), true);
  assert.equal(shouldFallbackToWeb({ code: 1, signal: null, elapsedMs: 2000 }), true, "主进程启动期抛错秒退");
  assert.equal(shouldFallbackToWeb({ code: 0, signal: null, elapsedMs: 800 }), false, "正常退出（含单实例锁让位）");
  assert.equal(shouldFallbackToWeb({ code: null, signal: "SIGKILL", elapsedMs: ELECTRON_BOOT_GRACE_MS }), false, "已经跑起来一阵了：不是没起来");
  assert.equal(shouldFallbackToWeb({ code: 1, signal: null, elapsedMs: 3 * 60 * 1000 }), false);
  assert.equal(shouldFallbackToWeb({ code: null, signal: "SIGKILL", elapsedMs: 300, argv: ["--no-web-fallback"] }), false, "可显式关掉");
  assert.equal(shouldFallbackToWeb({ code: null, signal: "SIGKILL", elapsedMs: Number.NaN }), false);
  assert.equal(shouldFallbackToWeb(), false);
});

test("桌面壳没起来的提示：说清发生了什么；macOS 给出重签命令与「别点移到废纸篓」，其它平台给重装入口", () => {
  const mac = electronFailureLines({ code: null, signal: "SIGKILL", platform: "darwin" }).join("\n");
  assert.match(mac, /没能启动（被系统终止（SIGKILL）），已改用网页模式/);
  assert.match(mac, /xattr -cr node_modules\/electron\/dist\/Electron\.app && codesign --force --deep --sign - node_modules\/electron\/dist\/Electron\.app/);
  assert.match(mac, /不要点「移到废纸篓」/);
  const linux = electronFailureLines({ code: 1, signal: null, platform: "linux" }).join("\n");
  assert.match(linux, /退出码 1/);
  assert.match(linux, /npm run electron:install/);
  assert.doesNotMatch(linux, /codesign/);
});

test("isSameModulePath: 经软链（含中文路径）启动也能识别为主模块；不同文件/空参/坏 URL 为假", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-链接-"));
  try {
    const realDir = path.join(dir, "真实目录");
    mkdirSync(realDir);
    const real = path.join(realDir, "launch.mjs");
    writeFileSync(real, "");
    const linkDir = path.join(dir, "软链目录");
    symlinkSync(realDir, linkDir, "dir");
    const linkFile = path.join(dir, "link.mjs");
    symlinkSync(real, linkFile);
    const moduleUrl = pathToFileURL(real).href;
    assert.equal(isSameModulePath(real, moduleUrl), true);
    assert.equal(isSameModulePath(path.join(linkDir, "launch.mjs"), moduleUrl), true, "软链目录");
    assert.equal(isSameModulePath(linkFile, moduleUrl), true, "软链文件");
    assert.equal(isSameModulePath(path.join(dir, "other.mjs"), moduleUrl), false);
    assert.equal(isSameModulePath("", moduleUrl), false);
    assert.equal(isSameModulePath(real, "not a url"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lib/is-main: isMainModule 按传入的 argv 路径判定", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, self), true);
  assert.equal(isMainModule(import.meta.url, path.join(path.dirname(self), "launch.mjs")), false);
  assert.equal(isMainModule(import.meta.url, ""), false);
});

test("scripts 各 CLI 入口统一经 lib/is-main.mjs 判定是否直接执行（不再各写一份）", () => {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["launch", "setup-wizard", "hot-update", "clean", "release-scan", "perf-baseline", "install-electron-runtime"]) {
    const src = readFileSync(path.join(scriptsDir, `${name}.mjs`), "utf8");
    assert.match(src, /import \{[^}]*\bisMainModule\b[^}]*\} from "\.\/lib\/is-main\.mjs"/, `${name}.mjs 应 import 共享守卫`);
    assert.match(src, /if \(isMainModule\(import\.meta\.url\)\)/, `${name}.mjs 应以 isMainModule(import.meta.url) 守卫入口`);
    assert.doesNotMatch(src, /process\.argv\[1\]\s*&&|pathToFileURL\(process\.argv\[1\]\)/, `${name}.mjs 不应再手写 argv[1] 比较`);
  }
});

// v2.59 自更新：网页模式下监控服务以约定退出码结束 = 请重新拉起（数据面不受影响）。
test("shouldRespawn: 只认约定的退出码；被信号杀掉 / 普通退出不拉；一分钟内连着要三次就停", () => {
  assert.equal(shouldRespawn({ code: RESTART_EXIT_CODE, signal: null, recent: [] }), true);
  assert.equal(shouldRespawn({ code: 0, signal: null, recent: [] }), false);
  assert.equal(shouldRespawn({ code: 1, signal: null, recent: [] }), false);
  assert.equal(shouldRespawn({ code: null, signal: "SIGTERM", recent: [] }), false);
  assert.equal(shouldRespawn({ code: RESTART_EXIT_CODE, signal: "SIGKILL", recent: [] }), false);
  const now = 1_000_000;
  assert.equal(shouldRespawn({ code: RESTART_EXIT_CODE, recent: [now - 5000, now - 3000], now }), true);
  assert.equal(shouldRespawn({ code: RESTART_EXIT_CODE, recent: [now - 5000, now - 3000, now - 1000], now }), false, "新代码起来就退：不空转");
  assert.equal(shouldRespawn({ code: RESTART_EXIT_CODE, recent: [now - 300_000, now - 200_000, now - 100_000], now }), true, "隔得久的不算连着");
});

test("monitorExitMessage: 正常退出不说话；刚更新完的新版本一起来就退 → 给出回退命令", () => {
  assert.equal(monitorExitMessage({ code: 0, signal: null }), null);
  assert.match(monitorExitMessage({ code: RESTART_EXIT_CODE, signal: null }), /连续要求重启.*npm run update -- --rollback/);
  const plain = monitorExitMessage({ code: 1, signal: null });
  assert.match(plain, /监控服务退出（code=1 signal=-）/);
  assert.doesNotMatch(plain, /rollback/, "不是更新后拉起的进程：不提回退");
  assert.match(monitorExitMessage({ code: 1, signal: null, respawned: true }), /刚更新完的新版本[\s\S]*npm run update -- --rollback/);
  assert.match(monitorExitMessage({ code: null, signal: "SIGSEGV", respawned: true }), /signal=SIGSEGV[\s\S]*rollback/);
});

test("launch.mjs 起监控服务时带上「会被重新拉起」的标记，服务据此才提供重启动作", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  assert.match(source, /\[RESPAWN_ENV\]: "1"/);
  assert.equal(RESPAWN_ENV, "CODEX_MONITOR_RESPAWN");
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("launch.mjs 把自己的 Node 版本带给监控服务：过了版本闸之后、起任何子进程之前写进环境变量", () => {
  // 桌面模式下监控服务跑在 Electron 自带的 Node 上；自更新预检目标版本的 engines.node 时要对的是这里的 Node。
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  const gate = source.indexOf("if (!isNodeVersionSupported(process.version))");
  const assigned = source.indexOf("process.env[LAUNCHER_NODE_ENV] = process.versions.node;");
  const firstSpawn = source.indexOf('if (mode === "electron")');
  assert.ok(gate > 0 && assigned > gate && firstSpawn > assigned, "赋值要在版本闸与起桌面壳 / 网页模式之间");
  assert.equal(LAUNCHER_NODE_ENV, "CODEX_MONITOR_LAUNCHER_NODE");
});

// 已经有一份在跑时再启动（再点一次桌面图标）：只打开页面，不动那一份的运行时文件。
test("已经有一份在跑：鉴权 token 的生成与落盘排在探测之后（不覆盖正在跑的那一份的 runtime/auth-token）", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  const startWeb = source.slice(source.indexOf("async function startWeb("));
  const running = startWeb.indexOf("控制台已在运行");
  const prepare = startWeb.indexOf("\n  prepareAuthToken();");
  const banner = startWeb.indexOf("集群运维工作台 (Codex Operations Console) — 网页模式");
  assert.ok(running > 0 && prepare > running && banner > prepare, "探测到已在运行就返回；之后才准备 token、打印横幅");
  // 写文件只出现在 prepareAuthToken 里，且它只有上面那一个调用点。
  const body = startWeb.slice(startWeb.indexOf("const prepareAuthToken = () => {"), startWeb.indexOf("\n  };\n") + 5);
  assert.match(body, /writeFileSync\(tokenFilePath, authToken, \{ mode: 0o600 \}\)/);
  assert.equal(source.split("writeFileSync(").length - 1, 1);
  assert.equal(source.split("prepareAuthToken()").length - 1, 1);
});

// ---- v2.62 开机自启：登录时由系统带 --autostart 拉起 ----
test("开机自启的约定：参数与环境变量名（start.sh / start-console.cmd 原样传参，两边不用改）", () => {
  assert.equal(AUTOSTART_FLAG, "--autostart");
  assert.equal(AUTOSTART_ENV, "CODEX_MONITOR_AUTOSTART");
  assert.equal(LAUNCHER_PATH_ENV, "CODEX_MONITOR_LAUNCHER_PATH");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  assert.match(readFileSync(path.join(root, "start.sh"), "utf8"), /exec "\$NODE_BIN" scripts\/launch\.mjs "\$@"/);
  assert.match(readFileSync(path.join(root, "start-console.cmd"), "utf8"), /scripts\\launch\.mjs %\*/);
});

test("launcherExitCode: 平时退出码原样带出；开机自启时「不该再拉」的那一次以 0 结束，别让 launchd 接着拉", () => {
  // 终端里启动：与改动前逐一相同。
  assert.equal(launcherExitCode({ code: 0, signal: null }), 0);
  assert.equal(launcherExitCode({ code: 1, signal: null }), 1);
  assert.equal(launcherExitCode({ code: RESTART_EXIT_CODE, signal: null }), RESTART_EXIT_CODE);
  assert.equal(launcherExitCode({ code: null, signal: "SIGTERM" }), 1);
  assert.equal(launcherExitCode({ code: null, signal: null }), 0);
  assert.equal(launcherExitCode(), 0);
  // 开机自启：异常退出仍是非零（launchd 隔一阵再拉一次），连续要求重启到上限的那一次是 0。
  assert.equal(launcherExitCode({ code: RESTART_EXIT_CODE, signal: null, autostart: true }), 0);
  assert.equal(launcherExitCode({ code: 1, signal: null, autostart: true }), 1);
  assert.equal(launcherExitCode({ code: null, signal: "SIGKILL", autostart: true }), 1);
  assert.equal(launcherExitCode({ code: 0, signal: null, autostart: true }), 0);
});

test("launch.mjs 的开机自启接线：环境变量在起子进程之前写好；桌面壳进自己的进程组；重新拉起仍由它自己做", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  const gate = source.indexOf("if (!isNodeVersionSupported(process.version))");
  const firstSpawn = source.indexOf('if (mode === "electron")');
  for (const line of [
    'process.env[LAUNCHER_PATH_ENV] = process.env.PATH ?? "";',
    'if (autostart) process.env[AUTOSTART_ENV] = "1";',
    "else delete process.env[AUTOSTART_ENV];",
  ]) {
    const at = source.indexOf(line);
    assert.ok(at > gate && at < firstSpawn, `${line} 要在版本闸与起桌面壳 / 网页模式之间`);
  }
  // 桌面壳：只有开机自启时才 detached（平时启动方式不变）。
  assert.match(source, /node_modules\/electron\/cli\.js"\), "\."\], \{ cwd: rootDir, stdio: "inherit", detached: autostart \}\)/);
  // 监控服务（网页模式）留在本进程的进程组里：launchd 结束这个任务时它跟着结束，不留孤儿。
  const monitorSpawn = source.slice(source.indexOf("const spawnMonitor = () => {"), source.indexOf("spawnMonitor();\n  if (autoOpen)"));
  assert.doesNotMatch(monitorSpawn, /detached/);
  // 退出码 75 的重新拉起仍在这里；退出码经 launcherExitCode 给出。
  assert.match(monitorSpawn, /if \(shouldRespawn\(\{ code, signal, recent: respawnedAt \}\)\) \{/);
  assert.match(monitorSpawn, /process\.exit\(launcherExitCode\(\{ code, signal, autostart: argv\.includes\(AUTOSTART_FLAG\) \}\)\);/);
  assert.doesNotMatch(source, /launchctl/, "启动器自己不碰 launchctl");
});

// 起真实子进程的用例的收尾：子进程以 detached 起（自成一个进程组），结束时对整个进程组发信号——
// 它自己起的子进程（比如启动器起的监控服务）也跟着结束，不留没人管的进程。只在它还没退出时才发
// （退出之后进程号可能已被别的进程用上）。Windows 没有进程组信号，退回只结束它自己。
function killProcessGroup(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

test("子进程用例的收尾：结束的是整个进程组，子进程起的进程也不留", { skip: process.platform === "win32" ? "Windows 没有进程组信号" : false, timeout: 180_000 }, async () => {
  // 一个不会自己退出的父进程，再起一个同样不会退出的子进程（没有 detached：与父进程同一个进程组），打出它的进程号。
  const script = 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);';
  const parent = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  let grandchild = null;
  try {
    grandchild = Number(await new Promise((resolve, reject) => {
      let out = "";
      parent.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.trim());
      });
      parent.on("error", reject);
      parent.on("exit", () => reject(new Error("父进程提前退出了")));
    }));
    assert.ok(Number.isInteger(grandchild) && grandchild > 1, `子进程的进程号：${grandchild}`);
    assert.equal(isAlive(grandchild), true);
    killProcessGroup(parent);
    // 只断言「都结束了」，不关心快慢：机器卡的时候信号送达与回收都可能慢。
    for (let i = 0; i < 600 && (isAlive(parent.pid) || isAlive(grandchild)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isAlive(parent.pid), false, "父进程结束了");
    assert.equal(isAlive(grandchild), false, "它起的子进程也结束了，没有留下");
    // 已经退出的进程不再发信号（进程号可能已被回收）。
    killProcessGroup(parent);
  } finally {
    killProcessGroup(parent);
    if (grandchild && isAlive(grandchild)) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {}
    }
  }
});

test("launcherEvent：启动失败、桌面壳起不来 / 异常退出、监控服务异常退出与「停止自动拉起」才记；正常的不记", () => {
  assert.deepEqual(launcherEvent("gate-node-version", { version: "v20.1.0" }), { level: "error", message: "启动失败：Node.js v20.1.0 不受支持", fields: { version: "v20.1.0" } });
  assert.equal(launcherEvent("gate-ssh-missing").level, "error");
  assert.deepEqual(launcherEvent("monitor-spawn-failed", { message: "spawn ENOENT", errorCode: "ENOENT" }), {
    level: "error", message: "启动失败：监控服务没能拉起（spawn ENOENT）", fields: { error: "spawn ENOENT", errorCode: "ENOENT" },
  });
  assert.match(launcherEvent("electron-spawn-failed", { message: "x" }).message, /桌面客户端没能拉起/);
  assert.deepEqual(launcherEvent("electron-boot-failed", { code: null, signal: "SIGKILL", elapsedMs: 800 }), {
    level: "warn", message: "桌面客户端没能启动（被信号 SIGKILL 终止），已改用网页模式", fields: { code: null, signal: "SIGKILL", elapsedMs: 800 },
  });
  assert.equal(launcherEvent("electron-exited", { code: 0, signal: null }), null, "正常关窗不记");
  assert.deepEqual(launcherEvent("electron-exited", { code: 3, signal: null, elapsedMs: 60_000 }).fields, { code: 3, signal: null, elapsedMs: 60_000 });
  assert.equal(launcherEvent("monitor-exited", { code: 0, signal: null }), null);
  assert.deepEqual(launcherEvent("monitor-exited", { code: 1, signal: null, respawned: true }), {
    level: "error", message: "监控服务异常退出（退出码 1）", fields: { code: 1, signal: null, respawned: true },
  });
  assert.deepEqual(launcherEvent("monitor-exited", { code: RESTART_EXIT_CODE, signal: null, respawned: true }), {
    level: "error", message: "监控服务一分钟内连续要求重启，已停止自动拉起", fields: { code: RESTART_EXIT_CODE, signal: null, respawned: true, gaveUp: true },
  });
  assert.equal(launcherEvent("monitor-exited", { code: null, signal: "SIGTERM" }).level, "error");
  assert.equal(launcherEvent("monitor-respawn", { code: RESTART_EXIT_CODE }).level, "info");
  assert.equal(launcherEvent("launcher-failed", { message: "boom" }).message, "启动失败：boom");
  assert.equal(launcherEvent("something-else"), null);
});

test("launch.mjs 的 launcher 日志接线：记完先写盘再退出；日志器第一次要记时才建（没出事不建目录）", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  const main = source.slice(source.indexOf("async function main()"), source.indexOf("const setupState = checkFirstRun"));
  for (const kind of ["gate-node-version", "gate-ssh-missing"]) {
    const at = main.indexOf(`recordLauncherEvent("${kind}"`);
    assert.ok(at > 0, kind);
    const flushAt = main.indexOf("await flushLauncherLog();", at);
    assert.ok(flushAt > at && flushAt < main.indexOf("process.exit(gateExitCode);", at), `${kind}：先写盘再退出`);
  }
  const record = source.slice(source.indexOf("function recordLauncherEvent("), source.indexOf("async function flushLauncherLog("));
  assert.match(record, /if \(!launcherLogger\) \{[\s\S]*createLogger\(LAUNCHER_LOG_SOURCE, \{ dir: paths\.logsDir/);
  assert.doesNotMatch(source.slice(0, source.indexOf("function recordLauncherEvent(")), /createLogger\(/, "模块顶层不建日志器（测试 import 不产生副作用）");
  const monitorSpawn = source.slice(source.indexOf("const spawnMonitor = () => {"), source.indexOf("spawnMonitor();\n  if (autoOpen)"));
  assert.match(monitorSpawn, /recordLauncherEvent\("monitor-exited", \{ code, signal, respawned \}\);\s*flushLauncherLog\(\)\.finally\(/);
  assert.match(source, /recordLauncherEvent\("electron-boot-failed"/);
  assert.match(source, /recordLauncherEvent\("launcher-failed"/);
  assert.doesNotMatch(source, /StandardOutPath|createWriteStream|stdio: \[[^\]]*"pipe"/, "不把子进程输出重定向到文件");
});

test("启动前的两道闸（Node 版本 / ssh）过不去：平时以 1 退出，开机自启时以 0 退出——launchd 不再每分钟空拉", () => {
  const source = readFileSync(fileURLToPath(new URL("./launch.mjs", import.meta.url)), "utf8");
  assert.match(source, /const gateExitCode = autostart \? 0 : 1;/);
  const main = source.slice(source.indexOf("async function main()"), source.indexOf("const setupState = checkFirstRun"));
  // 两道闸都用它；这一段里不再有写死的 process.exit(1)。
  assert.equal(main.split("process.exit(gateExitCode);").length - 1, 2);
  assert.doesNotMatch(main, /process\.exit\(1\)/);
  assert.ok(main.indexOf("const gateExitCode") < main.indexOf("if (!isNodeVersionSupported(process.version))"));
});

// 真的起一遍：PATH 指到一个空目录，which 都找不到，ssh 那道闸必然过不去——启动器在起任何服务之前就退出。
test("ssh 那道闸实跑：找不到 ssh 时平时退出码 1，带 --autostart 时退出码 0，两种都说明了原因", { skip: process.platform === "win32" ? "Windows 上这条链路这一轮没有验证" : false, timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CODEX_MONITOR_") || key === "AUTH_TOKEN" || key === "PORT") continue;
    env[key] = value;
  }
  // 万一闸没拦住（不该发生），后面起的也只会是 fixture 模式、临时数据目录下的监控服务，并随进程组一起被收掉。
  Object.assign(env, { PATH: path.join(dir, "empty-bin"), CODEX_MONITOR_DATA_DIR: path.join(dir, "data"), CODEX_MONITOR_FIXTURE_MODE: "1", CODEX_MONITOR_NO_OPEN: "1" });
  mkdirSync(env.PATH);
  const launch = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./launch.mjs", import.meta.url)), "--web", "--skip-setup-check", ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    t.after(() => killProcessGroup(child));
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      killProcessGroup(child);
      reject(new Error(`launch.mjs 没有在时限内退出：\n${output}`));
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
  const manual = await launch([]);
  assert.deepEqual([manual.code, manual.signal], [1, null], manual.output);
  assert.match(manual.output, /未检测到 ssh 客户端/);
  const auto = await launch([AUTOSTART_FLAG]);
  assert.deepEqual([auto.code, auto.signal], [0, null], auto.output);
  assert.match(auto.output, /未检测到 ssh 客户端/, "原因照样打印（终端里手动带这个参数时看得到）");
  // 在起任何服务之前就退出了：数据目录里只有启动链路的结构化日志（开机自启时输出被丢弃，只有它看得见），
  // 两次都记了，带 --autostart 的那次标出来。没有 auth-token、没有别的运行文件。
  const runtimeDir = path.join(dir, "data", "runtime");
  assert.deepEqual(readdirRecursive(runtimeDir), ["logs/launcher.ndjson"]);
  const rows = readFileSync(path.join(runtimeDir, "logs", "launcher.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => [r.source, r.level, r.event, r.origin, r.autostart]), [
    ["launcher", "error", "gate-ssh-missing", "launch-script", false],
    ["launcher", "error", "gate-ssh-missing", "launch-script", true],
  ]);
});

function readdirRecursive(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...readdirRecursive(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

// 真的把 launch.mjs 起一遍：端口上有一份「已经在跑」的假控制台（本用例自己起的，随机端口）。
// 数据目录指到临时目录、fixture 模式兜底；PATH 最前面放假的 open / xdg-open，真实浏览器不会被打开。
// 只断言「退出了、做了什么」，不关心快慢：机器卡的时候起一个 node 就要几十秒，时限给足。
test("已经在跑时再启动：不起第二份、不写 token 文件；带 --autostart 不开浏览器，不带时只打开页面一次", { skip: process.platform === "win32" ? "假 open 是 POSIX 脚本；Windows 上这条链路这一轮没有验证" : false, timeout: 300_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "launch-running-"));
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  const binDir = path.join(dir, "bin");
  const opened = path.join(dir, "opened.log");
  mkdirSync(binDir);
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(binDir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`);
    chmodSync(file, 0o755);
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CODEX_MONITOR_") || key === "AUTH_TOKEN" || key === "CI") continue;
    env[key] = value;
  }
  Object.assign(env, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PORT: String(server.address().port),
    CODEX_MONITOR_DATA_DIR: path.join(dir, "data"),
    CODEX_MONITOR_FIXTURE_MODE: "1",
    DISPLAY: ":99", // Linux：有图形会话才会去开浏览器
  });
  // 先各执行一次假命令：确认 PATH 上排在最前的确实是它（否则下面可能打开真实浏览器），
  // 也把新写出的可执行文件第一次执行时的系统安全评估付在这里。
  const openCommand = process.platform === "darwin" ? "open" : "xdg-open";
  assert.equal(spawnSync(openCommand, ["warmup"], { env }).status, 0);
  assert.equal(readFileSync(opened, "utf8"), "warmup\n", "PATH 上的 open 必须是假的那个");
  writeFileSync(opened, "");

  // 启动器放进自己的进程组（detached）。超时、或用例中途失败时结束的是整个进程组（killProcessGroup）：
  // 万一它没探到假控制台、自己起了监控服务，那个子进程也跟着结束。
  const launch = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./launch.mjs", import.meta.url)), "--web", "--skip-setup-check", ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    t.after(() => killProcessGroup(child));
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      killProcessGroup(child);
      reject(new Error(`launch.mjs 没有在时限内退出：\n${output}`));
    }, 120_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
  // 假 open 是被 detached 拉起的：给它一点时间把记录写完。
  const openedLines = async (expected) => {
    for (let i = 0; i < 100; i += 1) {
      const lines = readFileSync(opened, "utf8").split("\n").filter(Boolean);
      if (lines.length >= expected) return lines;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return readFileSync(opened, "utf8").split("\n").filter(Boolean);
  };

  const auto = await launch([AUTOSTART_FLAG]);
  assert.deepEqual([auto.code, auto.signal], [0, null], auto.output);
  assert.ok(auto.output.includes(`控制台已在运行：${url}`), auto.output);
  assert.doesNotMatch(auto.output, /网页模式\n|按 Ctrl\+C 停止/, "没有走到「自己起服务」那一步");
  assert.deepEqual(hits, ["GET /api/session"], "只探测了一次");
  assert.equal(existsSync(path.join(dir, "data")), false, "没有写 runtime/auth-token，数据目录都没建");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(await openedLines(0), [], "开机自启不打开浏览器");

  const manual = await launch([]);
  assert.deepEqual([manual.code, manual.signal], [0, null], manual.output);
  assert.ok(manual.output.includes(`控制台已在运行：${url}`), manual.output);
  assert.deepEqual(hits, ["GET /api/session", "GET /api/session"]);
  assert.equal(existsSync(path.join(dir, "data")), false);
  assert.deepEqual(await openedLines(1), [url], "再点一次图标：只打开页面，一次");
});
