// 开机自启的跨模块接线（源码级）：监控服务装配、HTTP 路由、桌面壳入口与网桥、前端入口。
// 各模块自己的行为在同目录的测试里（lib/autostart/*.test.mjs、desktop/login-item.test.mjs、
// app/settings-autostart.test.mjs、scripts/launch.test.mjs）；这里只锁住「接上了，而且接对了」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listImportClosure } from "../work/monitor/lib/component-version.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 去掉整行注释再断言「代码里没有某个调用」：注释里会提到它们。
const codeOf = (source) => source.replace(/^\s*\/\/.*$/gm, "");

test("监控服务装配：自启服务带着安装形态与 fixture 开关创建，并交给 HTTP 路由", () => {
  const start = read("work/monitor/server/start.mjs");
  // fixtureMode 必须传下去：冒烟、界面预览、自更新自检都以 fixture 模式起监控服务，
  // 那时自启文件只在内存里——漏传就会去动真实的登录启动项。
  assert.match(start, /const autostart = createAutostartService\(\{ rootDir, packaged: isPackagedApp\(rootDir\), fixtureMode, env, log: appendLog \}\);/);
  const routerCall = start.slice(start.indexOf("const router = createHttpRouter({"), start.indexOf("// ---- 监听 + 热接管 ----"));
  assert.match(routerCall, /^\s+autostart,$/m);
  const router = read("work/monitor/lib/http-router.mjs");
  assert.match(router, /createAutostartRoutes\(\{ autostart, appendLog \}\)/);
});

test("桌面壳：登录项经入口注入的 app 进来，动作表、IPC 通道与 preload 三处对得上", () => {
  const main = read("electron-main.mjs");
  assert.match(main, /const loginItem = createLoginItemController\(\{ ctx, app \}\);/);
  assert.match(main, /getAutostart: loginItem\.getAutostart,\n\s+setAutostart: loginItem\.setAutostart,/);
  const ipc = read("work/monitor/desktop/ipc.mjs");
  assert.match(ipc, /ipcMain\.handle\("get-autostart", \(event\) => \{\n\s+if \(!trusted\(event\)\) throw/);
  assert.match(ipc, /ipcMain\.handle\("set-autostart", \(event, enabled\) => \{\n\s+if \(!trusted\(event\)\) throw[^\n]*\n\s+return actions\.setAutostart\(enabled === true\);/);
  const preload = read("preload.js");
  assert.match(preload, /getAutostart: \(\) => ipcRenderer\.invoke\("get-autostart"\)/);
  assert.match(preload, /setAutostart: \(enabled\) => ipcRenderer\.invoke\("set-autostart", enabled === true\)/);
  // 登录项只在桌面壳的这一个模块里碰：别处（包括监控服务一侧）都不调 Electron 的登录项接口。
  const loginItem = read("work/monitor/desktop/login-item.mjs");
  assert.match(loginItem, /app\.setLoginItemSettings\(\{ openAtLogin: enabled === true \}\)/);
  assert.doesNotMatch(read("work/monitor/lib/autostart/service.mjs"), /LoginItemSettings/);
});

test("桌面壳入口：加 PATH 前缀之前先把原来的 PATH 留给开机自启（启动器没带时才取回，已经带了的不覆盖）", () => {
  const main = read("electron-main.mjs");
  const keep = main.indexOf("process.env[LAUNCHER_PATH_ENV] ||= stripDesktopPathEnv(process.env.PATH);");
  const prefix = main.indexOf("process.env.PATH = buildDesktopPathEnv(process.env.PATH);");
  assert.ok(keep > 0 && prefix > keep, "必须赶在加前缀之前：之后再取，拿到的就是改过顺序的那一份");
  assert.equal(main.split("buildDesktopPathEnv(process.env.PATH)").length - 1, 1);
  // 监控服务这边：桌面壳里没有这个变量就不用自己的 PATH 写 plist。
  const service = read("work/monitor/lib/autostart/service.mjs");
  assert.match(service, /const pathUnknown = desktopShell && !launcherPath;/);
  assert.match(service, /desktopShell = Boolean\(process\.versions\.electron\),/);
});

test("前端入口：「启动」一节拿到桌面壳的网桥，并在配置浮层打开时读取", () => {
  const app = read("work/monitor/public/app.js");
  assert.match(app, /const settingsAutostart = createSettingsAutostart\(\{ doc, getJson, postJson, showToast, electronAPI: window\.electronAPI \|\| null \}\);/);
  assert.match(app, /dialogs\.onDialogOpen\("dlgSettings", settingsAutostart\.onOpen\);/);
});

test("数据面不受影响：自启的模块不在守护进程 / 本机代理的指纹闭包里（加这个功能不触发交接）", async () => {
  for (const entry of ["work/monitor/channel-supervisor.mjs", "work/local_http_connect_proxy.mjs"]) {
    const closure = await listImportClosure(ROOT, entry);
    assert.deepEqual(closure.filter((rel) => rel.includes("autostart") || rel.includes("login-item")), [], entry);
  }
  // 启动器与监控服务共用的约定文件不带任何依赖（scripts/ 与 work/monitor/ 两边都引它）。
  assert.doesNotMatch(read("work/monitor/lib/autostart/launch-flag.mjs"), /^\s*import\s/m);
});

test("fixture 模式的保险：文件操作与命令执行只经一处开关——fixture 下是内存文件与空操作，碰不到真实的登录启动项与 launchctl", () => {
  const service = codeOf(read("work/monitor/lib/autostart/service.mjs"));
  // 开关就这两行：fixture 模式下注入的（或缺省的真实）fs / exec 根本不会被取用。
  assert.match(service, /const io = fixtureMode \? createMemoryFs\(\) : fs;/);
  assert.match(service, /const run = fixtureMode \? async \(\) => \(\{ code: 0, stdout: "", stderr: "" \}\) : exec;/);
  // 其余地方一律 io.* / run(...)：没有任何一处绕过开关直接用 fs / nodeFs / exec / execFileWithTimeout。
  assert.doesNotMatch(service, /\bfs\.[A-Za-z]+\(/, "不直接调 fs.*");
  assert.doesNotMatch(service, /\bnodeFs\.[A-Za-z]+/, "不直接调 node:fs/promises");
  assert.doesNotMatch(service, /\bexec\(/, "不直接调 exec");
  assert.doesNotMatch(service, /execFileWithTimeout\(/, "不直接调 execFileWithTimeout");
  assert.match(service, /await writeFileAtomic\(file, text, \{ fs: io \}\);/, "原子写用的也是开关之后的那一个");
  // 内存文件系统不引用任何真实的文件接口。
  const memory = service.slice(service.indexOf("function createMemoryFs()"), service.indexOf("function isInside("));
  assert.ok(memory.length > 0);
  assert.doesNotMatch(memory, /nodeFs|node:fs|writeFileAtomic/);
});

test("写系统位置的代码都经注入：自启业务层之外没有别处写 LaunchAgents / 启动文件夹或调 launchctl", () => {
  const service = read("work/monitor/lib/autostart/service.mjs");
  // 命令与路径的默认值各只有一处，且都能被注入覆盖。
  assert.match(service, /exec = execFileWithTimeout,/);
  assert.match(service, /launchAgentFile = launchAgentPath\(homeDir\),/);
  assert.match(service, /startupDir = windowsStartupDir\(env\),/);
  assert.equal(service.split('"launchctl"').length - 1, 1, "launchctl 只有关闭时的 bootout 一处");
  assert.match(service, /run\("launchctl", \["bootout", `gui\/\$\{uid\}\/\$\{LAUNCH_AGENT_LABEL\}`\]/);
  assert.doesNotMatch(codeOf(service), /bootstrap|kickstart|"load"/, "打开开关不调 launchctl");
  for (const rel of ["work/monitor/lib/autostart/launch-agent.mjs", "work/monitor/lib/autostart/windows-startup.mjs", "work/monitor/lib/autostart/launch-flag.mjs"]) {
    assert.doesNotMatch(read(rel), /node:fs|node:child_process/, `${rel} 是纯函数模块`);
  }
});
