// 开机自启业务层：全部在 os.tmpdir() 下的沙盒里跑。文件操作经一层「越界即失败」的 fs 包装，
// launchctl 是记录调用的假执行器——真实的 ~/Library/LaunchAgents、启动文件夹与 launchctl 一次都不碰。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDesktopPathEnv as buildPathEnvFor, stripDesktopPathEnv as stripPathEnvFor } from "../../desktop/context.mjs";

// 桌面壳的 PATH 前缀只在 macOS 上加；这里的用例都是 macOS 场景，宿主是 Windows 时也按 macOS 算。
const buildDesktopPathEnv = (value) => buildPathEnvFor(value, "darwin");
const stripDesktopPathEnv = (value) => stripPathEnvFor(value, "darwin");
import { buildLaunchAgentPlist, LAUNCH_AGENT_FILE, LAUNCH_AGENT_LABEL, parseLaunchAgentPlist } from "./launch-agent.mjs";
import { AUTOSTART_ENV, AUTOSTART_MARKER, LAUNCHER_PATH_ENV } from "./launch-flag.mjs";
import { createAutostartService } from "./service.mjs";
import { buildStartupCmd, STARTUP_FILE_NAME } from "./windows-startup.mjs";

const USER_PATH = "/Users/t/.nvm/versions/node/v24.11.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const NOT_LOADED = { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };

// 每个用例一个沙盒目录；timeline 按发生顺序记下写文件、改名、删除与每一次命令执行。
function sandbox(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autostart-svc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const timeline = [];
  const inside = (file) => {
    const resolved = path.resolve(String(file));
    assert.ok(resolved === root || resolved.startsWith(`${root}${path.sep}`), `越界访问：${file}`);
    return path.basename(resolved).replace(/\.tmp\.[\d.]+$/, ".tmp");
  };
  const fs = {
    readFile(file, ...rest) {
      inside(file);
      return fsp.readFile(file, ...rest);
    },
    writeFile(file, ...rest) {
      timeline.push(`write ${inside(file)}`);
      return fsp.writeFile(file, ...rest);
    },
    rename(from, to) {
      inside(from);
      timeline.push(`rename ${inside(to)}`);
      return fsp.rename(from, to);
    },
    unlink(file) {
      timeline.push(`unlink ${inside(file)}`);
      return fsp.unlink(file);
    },
    mkdir(dir, options) {
      inside(dir);
      return fsp.mkdir(dir, options);
    },
    chmod(file, mode) {
      inside(file);
      return fsp.chmod(file, mode);
    },
  };
  const execResults = [];
  const exec = async (command, args, options) => {
    timeline.push(`exec ${[command, ...args].join(" ")}`);
    exec.calls.push({ command, args, options });
    return execResults.shift() ?? NOT_LOADED;
  };
  exec.calls = [];
  const logs = [];
  return { root, fs, exec, execResults, timeline, logs, log: (message, fields) => logs.push([message, fields]) };
}

// macOS 源码安装的一份服务：homeDir 在沙盒里，plist 落在沙盒的 Library/LaunchAgents。
function macService(box, { rootDir = "/Users/t/cluster-workbench", env = {}, ...rest } = {}) {
  const homeDir = path.join(box.root, "home");
  const service = createAutostartService({
    platform: "darwin",
    rootDir,
    homeDir,
    uid: 501,
    env: { PATH: USER_PATH, ...env },
    fs: box.fs,
    exec: box.exec,
    log: box.log,
    ...rest,
  });
  return { service, homeDir, file: path.join(homeDir, "Library", "LaunchAgents", LAUNCH_AGENT_FILE) };
}

test("macOS：关 → 开 → 重复开 → 关。打开只写 plist、不调 launchctl；重复打开不重写；关闭先 bootout 再删文件", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box);

  assert.deepEqual(await service.status(), {
    supported: true,
    method: "launch-agent",
    enabled: false,
    state: "off",
    file: `~${path.sep}${path.join("Library", "LaunchAgents", LAUNCH_AGENT_FILE)}`,
    target: null,
    fromAutostart: false,
    caveats: [],
    reason: null,
    manualCommand: null,
    detail: null,
  });
  assert.equal(existsSync(file), false, "查状态不产生任何文件");
  assert.deepEqual(box.timeline, []);

  const on = await service.setEnabled(true);
  assert.equal(on.enabled, true);
  assert.equal(on.state, "on");
  assert.equal(on.changed, true);
  assert.equal(on.launchd, null);
  const written = readFileSync(file, "utf8");
  assert.equal(written, buildLaunchAgentPlist({ repoRoot: "/Users/t/cluster-workbench", pathEnv: USER_PATH }));
  assert.deepEqual(box.timeline, [`write ${LAUNCH_AGENT_FILE}.tmp`, `rename ${LAUNCH_AGENT_FILE}`], "同目录临时文件 + 改名；没有任何命令执行");
  assert.deepEqual(readdirSync(path.dirname(file)), [LAUNCH_AGENT_FILE], "没有留下临时文件");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o644);
  if (process.platform === "darwin") {
    const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }

  box.timeline.length = 0;
  const again = await service.setEnabled(true);
  assert.equal(again.changed, false);
  assert.equal(again.enabled, true);
  assert.deepEqual(box.timeline, [], "内容没变不重写");

  const off = await service.setEnabled(false);
  assert.deepEqual([off.enabled, off.state, off.changed, off.launchd], [false, "off", true, "not-loaded"]);
  assert.deepEqual(box.timeline, [`exec launchctl bootout gui/501/${LAUNCH_AGENT_LABEL}`, `unlink ${LAUNCH_AGENT_FILE}`], "先 bootout 再删 plist");
  assert.equal(box.exec.calls[0].options.timeoutMs > 0, true);
  assert.equal(existsSync(file), false);
  assert.deepEqual(box.logs, [], "任务没加载过是常态，不记警告");

  box.timeline.length = 0;
  const offAgain = await service.setEnabled(false);
  assert.deepEqual([offAgain.enabled, offAgain.changed, offAgain.launchd], [false, false, null]);
  assert.deepEqual(box.timeline, [], "已经关着：什么都不做");
});

test("macOS：写进 plist 的是启动器带下来的 PATH（顺序原样）；没有时才用监控服务自己的", async (t) => {
  const box = sandbox(t);
  const launcherPath = "/usr/bin:/bin:/Users/t/tools/bin";
  const desktopPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${launcherPath}`;
  const { service, file } = macService(box, { env: { PATH: desktopPath, [LAUNCHER_PATH_ENV]: launcherPath } });
  await service.setEnabled(true);
  assert.ok(readFileSync(file, "utf8").includes("<string>/usr/bin:/bin:/Users/t/tools/bin:/usr/sbin:/sbin</string>"), "桌面壳往 PATH 前面插的那串目录不带进去");

  const other = sandbox(t);
  const fallback = macService(other, { env: { PATH: launcherPath } });
  await fallback.service.setEnabled(true);
  assert.ok(readFileSync(fallback.file, "utf8").includes("<string>/usr/bin:/bin:/Users/t/tools/bin:/usr/sbin:/sbin</string>"));
});

test("macOS 桌面壳：更新后「重启界面」起来的那一份（PATH 叠了几段前缀）写进 plist 的仍是启动器当时的 PATH", async (t) => {
  // 手动启动时 nvm 的 node 排在 Homebrew 前面；桌面壳入口每起一次就往最前面插一段 /opt/homebrew/bin:/usr/local/bin:…
  const launcherPath = "/Users/t/.nvm/versions/node/v24.11.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const inherited = buildDesktopPathEnv(launcherPath); // 旧实例加过一次前缀，重启界面的新实例继承到的就是它
  const recovered = stripDesktopPathEnv(inherited); // 新版入口在再加前缀之前取回，经环境变量带给监控服务
  const box = sandbox(t);
  const { service, file } = macService(box, { desktopShell: true, env: { PATH: buildDesktopPathEnv(inherited), [LAUNCHER_PATH_ENV]: recovered } });
  assert.deepEqual((await service.status()).caveats, []);
  await service.setEnabled(true);
  const written = readFileSync(file, "utf8");
  assert.ok(written.includes(`<string>${launcherPath}</string>`), "顺序与手动启动时一致：nvm 的 node 仍排在最前");
  assert.ok(!written.includes("<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin"), "不是桌面壳改过顺序的那一份");
});

test("macOS 桌面壳：拿不到启动时的 PATH（入口还是更新前的旧代码）→ 不猜：打开开关 409 并说明怎么办，已经开着的仍可以关", async (t) => {
  const box = sandbox(t);
  const desktopPath = buildDesktopPathEnv("/Users/t/.nvm/versions/node/v24.11.0/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  const { service, file } = macService(box, { desktopShell: true, env: { PATH: desktopPath } });
  const status = await service.status();
  assert.deepEqual([status.supported, status.enabled, status.caveats], [true, false, ["launcher-path-unknown"]]);
  await assert.rejects(service.setEnabled(true), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, "launcher-path-unknown");
    assert.match(err.message, /拿不到启动时的 PATH.*完全退出工作台，从桌面图标再启动一次/);
    return true;
  });
  assert.equal(existsSync(file), false, "什么都没写");
  assert.deepEqual(box.timeline, []);

  // 之前（手动启动的那一份）已经开过：这一份里照样显示开着、可以关掉；关掉之后同样开不回来。
  await macService(box).service.setEnabled(true);
  assert.equal((await service.status()).enabled, true);
  const off = await service.setEnabled(false);
  assert.deepEqual([off.enabled, off.changed], [false, true]);
  await assert.rejects(service.setEnabled(true), (err) => err.code === "launcher-path-unknown");
  assert.equal(existsSync(file), false);

  // 网页模式（不在桌面壳里）没带这个变量时可以用自己的 PATH：它没被改过顺序。
  const web = sandbox(t);
  const plain = macService(web, { desktopShell: false, env: { PATH: "/Users/t/.nvm/versions/node/v24.11.0/bin:/usr/bin:/bin:/usr/sbin:/sbin" } });
  assert.deepEqual((await plain.service.status()).caveats, []);
  assert.equal((await plain.service.setEnabled(true)).enabled, true);
});

test("macOS：关闭时 launchd 里确实有这个任务 → bootout 成功后删文件", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box);
  await service.setEnabled(true);
  box.execResults.push({ code: 0, stdout: "", stderr: "" });
  const off = await service.setEnabled(false);
  assert.equal(off.launchd, "booted-out");
  assert.equal(existsSync(file), false);
});

test("macOS：这一份就是开机自启拉起来的 → 关闭时不执行 bootout（那会把自己结束掉），只删 plist", async (t) => {
  for (const env of [{ [AUTOSTART_ENV]: "1" }, { XPC_SERVICE_NAME: LAUNCH_AGENT_LABEL }]) {
    const box = sandbox(t);
    const { service, file } = macService(box, { env });
    assert.equal((await service.status()).fromAutostart, true, JSON.stringify(env));
    await service.setEnabled(true);
    box.timeline.length = 0;
    const off = await service.setEnabled(false);
    assert.deepEqual([off.enabled, off.changed, off.launchd, off.fromAutostart], [false, true, "left-running", true]);
    assert.deepEqual(box.timeline, [`unlink ${LAUNCH_AGENT_FILE}`], "没有任何命令执行");
    assert.equal(box.exec.calls.length, 0);
    assert.equal(existsSync(file), false);
  }
  // 终端里手动启动的一份：launchd 给的服务名不是这个任务。
  const manual = sandbox(t);
  assert.equal((await macService(manual, { env: { XPC_SERVICE_NAME: "0", [AUTOSTART_ENV]: "0" } }).service.status()).fromAutostart, false);
});

test("macOS：bootout 以别的退出码失败或超时，plist 照样删掉，并记一条警告", async (t) => {
  for (const result of [
    { code: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error\n" },
    { code: 1, stdout: "", stderr: "spawn launchctl ENOENT" },
    { code: 3, stdout: "", stderr: "", timedOut: true },
  ]) {
    const box = sandbox(t);
    const { service, file } = macService(box);
    await service.setEnabled(true);
    box.execResults.push(result);
    const off = await service.setEnabled(false);
    assert.deepEqual([off.enabled, off.launchd], [false, "failed"], JSON.stringify(result));
    assert.equal(existsSync(file), false);
    assert.equal(box.logs.length, 1);
    assert.match(box.logs[0][0], /launchctl bootout exited/);
    assert.equal(box.logs[0][1].level, "warn");
  }
});

test("macOS：改过安装目录后再开——旧 plist 指向别处时显示为关着；在这里打开就改成启动这一份；在这里关不动别处那一份", async (t) => {
  const box = sandbox(t);
  const old = macService(box, { rootDir: "/Users/t/old-place" });
  await old.service.setEnabled(true);
  const { service, file } = macService(box, { rootDir: "/Users/t/new place/工作台" });

  const before = await service.status();
  assert.deepEqual([before.enabled, before.state, before.target], [false, "other-install", "/Users/t/old-place/start.sh"]);

  box.timeline.length = 0;
  const off = await service.setEnabled(false);
  assert.deepEqual([off.state, off.changed, off.launchd], ["other-install", false, null]);
  assert.deepEqual(box.timeline, [], "对这一份来说本来就是关着的：不删文件、不执行命令");
  assert.deepEqual(parseLaunchAgentPlist(readFileSync(file, "utf8")).program[1], "/Users/t/old-place/start.sh");

  const on = await service.setEnabled(true);
  assert.deepEqual([on.enabled, on.state, on.target, on.changed], [true, "on", null, true]);
  assert.deepEqual(parseLaunchAgentPlist(readFileSync(file, "utf8")).program, ["/bin/bash", "/Users/t/new place/工作台/start.sh", "--autostart"]);
  assert.equal(box.exec.calls.length, 0);
  // 原来那个安装目录现在看到的是「指向别处」。
  assert.equal((await old.service.status()).state, "other-install");
});

test("macOS：同名文件不是工作台放的 → 开和关都拒绝（409），文件一个字节不动，也不执行命令", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box);
  mkdirSync(path.dirname(file), { recursive: true });
  const foreign = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LAUNCH_AGENT_LABEL}</string><key>ProgramArguments</key><array><string>/Users/t/cluster-workbench/start.sh</string></array></dict></plist>\n`;
  writeFileSync(file, foreign);

  const status = await service.status();
  assert.deepEqual([status.supported, status.enabled, status.state], [true, false, "foreign"], "指向同一个 start.sh 也不算：没有标记");
  for (const enabled of [true, false]) {
    await assert.rejects(service.setEnabled(enabled), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "foreign-file");
      assert.match(err.message, /不是工作台放的，没有改动它/);
      assert.ok(err.message.includes(LAUNCH_AGENT_FILE));
      return true;
    });
  }
  assert.equal(readFileSync(file, "utf8"), foreign);
  assert.deepEqual(box.timeline, []);
});

test("macOS：读不出那个位置（比如是个目录）→ 状态如实标 unknown，开和关都拒绝", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box);
  mkdirSync(file, { recursive: true });
  const status = await service.status();
  assert.deepEqual([status.enabled, status.state], [false, "unknown"]);
  assert.equal(typeof status.detail, "string");
  for (const enabled of [true, false]) {
    await assert.rejects(service.setEnabled(enabled), (err) => err.status === 409 && err.code === "unreadable");
  }
  assert.equal(statSync(file).isDirectory(), true);
  assert.deepEqual(box.timeline, []);
});

test("macOS：写不进去 / 删不掉时说清是哪个文件、什么原因（500），不留半截文件", async (t) => {
  const box = sandbox(t);
  // 目录不可写：临时文件就写不出来。
  const denied = async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
  const { service, file } = macService(box, { fs: { ...box.fs, writeFile: denied } });
  await assert.rejects(service.setEnabled(true), (err) => {
    assert.equal(err.status, 500);
    assert.equal(err.code, "io-failed");
    assert.match(err.message, /^写不了 ~.*com\.clusterworkbench\.launcher\.plist（EACCES）。$/);
    return true;
  });
  assert.deepEqual(readdirSync(path.dirname(file)), [], "没有留下任何文件");
  assert.equal((await service.status()).enabled, false);
  assert.equal(box.exec.calls.length, 0);

  // 删除失败：文件还在，如实报错（launchd 那边已经放下了任务，下次登录仍会加载这个文件——状态以文件为准）。
  const other = sandbox(t);
  const failing = macService(other, { fs: { ...other.fs, unlink: async () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } } });
  await failing.service.setEnabled(true);
  await assert.rejects(failing.service.setEnabled(false), (err) => err.status === 500 && err.code === "io-failed" && /^删不掉 .*（EPERM）。$/.test(err.message));
  assert.equal(existsSync(failing.file), true);
  assert.equal((await failing.service.status()).enabled, true);
});

test("macOS：安装目录在「文稿 / 桌面 / 下载」或外接磁盘上时带一条提醒；别处没有", async (t) => {
  const box = sandbox(t);
  // 用户目录与安装目录都是 macOS 形状的字符串（在哪个系统上跑都一样）；plist 的位置单独指到沙盒里。
  const homeDir = "/Users/t";
  const caveatsOf = async (rootDir) => (await createAutostartService({
    platform: "darwin", rootDir, homeDir, uid: 501, env: {}, fs: box.fs, exec: box.exec, launchAgentFile: path.join(box.root, "agent.plist"),
  }).status()).caveats;
  assert.deepEqual(await caveatsOf(`${homeDir}/Documents/集群codex连接`), ["protected-folder"]);
  assert.deepEqual(await caveatsOf(`${homeDir}/Desktop/wb`), ["protected-folder"]);
  assert.deepEqual(await caveatsOf(`${homeDir}/Downloads/wb`), ["protected-folder"]);
  assert.deepEqual(await caveatsOf(`${homeDir}/Library/Mobile Documents/com~apple~CloudDocs/wb`), ["protected-folder"]);
  assert.deepEqual(await caveatsOf("/Volumes/SSD/wb"), ["protected-folder"]);
  assert.deepEqual(await caveatsOf(`${homeDir}/cluster-workbench`), []);
  assert.deepEqual(await caveatsOf(`${homeDir}/DocumentsOther/wb`), [], "只是名字前缀相同");
});

test("macOS：安装目录的路径里有换行等字符 → 不支持，开关不可用，不写任何文件", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box, { rootDir: "/Users/t/bad\ndir" });
  const status = await service.status();
  assert.deepEqual([status.supported, status.method, status.reason, status.file], [false, "launch-agent", "unsafe-path", null]);
  await assert.rejects(service.setEnabled(true), (err) => err.status === 409 && err.code === "unsafe-path");
  assert.equal(existsSync(file), false);
  assert.deepEqual(box.timeline, []);
});

// Windows 后端：路径是 Windows 形状的字符串，启动文件夹指到沙盒里——在任何系统上都能跑。
function winService(box, { rootDir = "C:\\Users\\张三\\cluster-workbench", env = {}, ...rest } = {}) {
  const startupDir = path.join(box.root, "Startup");
  const service = createAutostartService({
    platform: "win32",
    rootDir,
    homeDir: "C:\\Users\\张三",
    uid: null,
    env: { USERPROFILE: "C:\\Users\\张三", ...env },
    fs: box.fs,
    exec: box.exec,
    startupDir,
    ...rest,
  });
  return { service, file: path.join(startupDir, STARTUP_FILE_NAME) };
}

test("Windows：开 = 在「启动」文件夹写一个带标记的 .cmd，关 = 删掉它；全程不执行任何命令", async (t) => {
  const box = sandbox(t);
  const { service, file } = winService(box);
  const initial = await service.status();
  assert.deepEqual([initial.supported, initial.method, initial.enabled, initial.state, initial.file], [true, "startup-folder", false, "off", file]);

  const on = await service.setEnabled(true);
  assert.deepEqual([on.enabled, on.state, on.changed], [true, "on", true]);
  const text = readFileSync(file, "utf8");
  assert.equal(text, buildStartupCmd({ repoRoot: "C:\\Users\\张三\\cluster-workbench", userProfile: "C:\\Users\\张三" }));
  assert.ok(text.includes(AUTOSTART_MARKER));
  assert.match(text, /^start "" \/d "%USERPROFILE%\\cluster-workbench" \/min cmd \/c \.\\start-console\.cmd --autostart\r$/m);
  assert.deepEqual(readdirSync(path.dirname(file)), [STARTUP_FILE_NAME]);

  box.timeline.length = 0;
  assert.equal((await service.setEnabled(true)).changed, false);
  assert.deepEqual(box.timeline, [], "重复打开不重写");

  const off = await service.setEnabled(false);
  assert.deepEqual([off.enabled, off.state, off.changed, off.launchd], [false, "off", true, null]);
  assert.equal(existsSync(file), false);
  assert.equal(box.exec.calls.length, 0, "不用计划任务、不用注册表、不调任何命令");
});

test("Windows：指向别的安装目录时显示为关着、可改到这里；不是工作台放的不覆盖；读不到启动文件夹时不支持", async (t) => {
  const box = sandbox(t);
  const old = winService(box, { rootDir: "D:\\old\\wb" });
  await old.service.setEnabled(true);
  const { service, file } = winService(box);
  const before = await service.status();
  assert.deepEqual([before.enabled, before.state, before.target], [false, "other-install", "D:\\old\\wb\\start-console.cmd"]);
  assert.equal((await service.setEnabled(false)).changed, false);
  assert.equal((await service.setEnabled(true)).state, "on");
  // 盘符与目录名的大小写不同仍是同一个安装目录。
  assert.equal((await winService(box, { rootDir: "c:\\users\\张三\\CLUSTER-WORKBENCH" }).service.status()).state, "on");

  const foreign = '@echo off\r\nstart "" "C:\\something\\else.exe"\r\n';
  writeFileSync(file, foreign);
  assert.equal((await service.status()).state, "foreign");
  await assert.rejects(service.setEnabled(true), (err) => err.status === 409 && err.code === "foreign-file");
  await assert.rejects(service.setEnabled(false), (err) => err.status === 409 && err.code === "foreign-file");
  assert.equal(readFileSync(file, "utf8"), foreign);

  const noAppData = createAutostartService({ platform: "win32", rootDir: "C:\\wb", homeDir: "C:\\Users\\a", env: {}, fs: box.fs, exec: box.exec });
  const status = await noAppData.status();
  assert.deepEqual([status.supported, status.method, status.reason], [false, "startup-folder", "no-startup-folder"]);
  await assert.rejects(noAppData.setEnabled(true), (err) => err.status === 409 && err.code === "no-startup-folder");
  const badRoot = winService(box, { rootDir: 'C:\\a"b' });
  assert.equal((await badRoot.service.status()).reason, "unsafe-path");
  assert.equal(box.exec.calls.length, 0);
});

// 任何文件操作与命令执行都算失败：用来证明某条路径上一次系统调用都没有。
const forbidden = (label) => new Proxy({}, { get: (_target, name) => () => assert.fail(`${label} 不该被调用：${String(name)}`) });
const forbiddenExec = () => assert.fail("不该执行任何命令");

test("Linux：不支持，给出手动后台运行的命令（路径按 shell 规则加引号）；POST 409", async () => {
  const service = createAutostartService({ platform: "linux", rootDir: "/home/u/cluster workbench/it's", homeDir: "/home/u", env: {}, fs: forbidden("fs"), exec: forbiddenExec });
  const status = await service.status();
  assert.deepEqual(status, {
    supported: false,
    method: "none",
    enabled: false,
    state: "off",
    file: null,
    target: null,
    fromAutostart: false,
    caveats: [],
    reason: "platform",
    manualCommand: "nohup bash '/home/u/cluster workbench/it'\\''s/start.sh' --autostart >/dev/null 2>&1 &",
    detail: null,
  });
  await assert.rejects(service.setEnabled(true), (err) => err.status === 409 && err.code === "platform");
  await assert.rejects(service.setEnabled(false), (err) => err.status === 409 && err.code === "platform");
});

test("打包的 .app：登录项归桌面壳——这里不读写任何文件、不执行命令，开关状态如实给 null，POST 409", async () => {
  const service = createAutostartService({
    platform: "darwin",
    packaged: true,
    rootDir: "/Applications/Codex Operations Console.app/Contents/Resources/app",
    homeDir: "/Users/t",
    uid: 501,
    env: {},
    fs: forbidden("fs"),
    exec: forbiddenExec,
  });
  const status = await service.status();
  assert.deepEqual([status.supported, status.method, status.enabled, status.file, status.reason], [true, "login-item", null, null, null]);
  for (const enabled of [true, false]) {
    await assert.rejects(service.setEnabled(enabled), (err) => err.status === 409 && err.code === "desktop-only" && /桌面窗口/.test(err.message));
  }
});

test("fixture 模式：开关照常工作，但文件只在内存里——磁盘上什么都不出现，注入的 fs / exec 一次都不调", async (t) => {
  const box = sandbox(t);
  const homeDir = path.join(box.root, "home");
  for (const options of [
    { platform: "darwin", rootDir: "/Users/t/cluster-workbench", homeDir },
    { platform: "win32", rootDir: "C:\\wb", homeDir: "C:\\Users\\a", startupDir: path.join(box.root, "Startup") },
  ]) {
    const service = createAutostartService({ ...options, fixtureMode: true, uid: 501, env: { PATH: USER_PATH }, fs: forbidden("fs"), exec: forbiddenExec });
    assert.equal((await service.status()).enabled, false);
    assert.deepEqual([(await service.setEnabled(true)).enabled, (await service.status()).state], [true, "on"]);
    const off = await service.setEnabled(false);
    assert.deepEqual([off.enabled, off.changed], [false, true]);
  }
  assert.deepEqual(readdirSync(box.root), [], "沙盒里没有任何文件");
});

test("开 / 关串行：同时发出的两次操作按发出顺序一个做完再做下一个", async (t) => {
  const box = sandbox(t);
  const { service, file } = macService(box);
  const [on, off, onAgain] = await Promise.all([service.setEnabled(true), service.setEnabled(false), service.setEnabled(true)]);
  assert.deepEqual([on.enabled, off.enabled, onAgain.enabled], [true, false, true]);
  assert.deepEqual(box.timeline, [
    `write ${LAUNCH_AGENT_FILE}.tmp`,
    `rename ${LAUNCH_AGENT_FILE}`,
    `exec launchctl bootout gui/501/${LAUNCH_AGENT_LABEL}`,
    `unlink ${LAUNCH_AGENT_FILE}`,
    `write ${LAUNCH_AGENT_FILE}.tmp`,
    `rename ${LAUNCH_AGENT_FILE}`,
  ]);
  assert.equal(existsSync(file), true);
  // 前一次失败不堵住后一次。
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(service.setEnabled(true), (err) => err.code === "unreadable");
  rmSync(file, { recursive: true });
  assert.equal((await service.setEnabled(true)).enabled, true);
});
