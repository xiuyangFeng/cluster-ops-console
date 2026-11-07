import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const electron = path.join(rootDir, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const worker = path.join(rootDir, "scripts/browser-smoke-electron.mjs");
// 必须清掉 ELECTRON_RUN_AS_NODE 再 spawn：该变量会让 Electron 二进制退化成纯 Node，
// 于是 `import { app, BrowserWindow } from "electron"` 落到 npm 包（只导出一个路径字符串）
// 并以 `does not provide an export named 'BrowserWindow'` 失败——冒烟测试以一个与真实
// 缺陷无关的错误报错。该变量在本项目打包运行时里是常态（electron-main.mjs 用它拉起
// 受管子进程），从打包好的 app 终端启动开发即被继承。
// install-electron-runtime.mjs 的 electronInstallEnv() 早已是同样的做法，此处对齐。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [worker], {
  cwd: rootDir,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
function forward(stream, destination) {
  stream.on("data", (chunk) => {
    const text = String(chunk);
    output += text;
    destination.write(text);
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

// 兜底：Electron 入口模块加载期抛错（夹具本身坏了）时进程不会自己退出，冒烟会一直挂着、
// 还留下一个孤儿 Electron。两道保险：输出里出现加载错误立刻判失败；总时长超限也判失败。
const SMOKE_TIMEOUT_MS = 240000;
const LOAD_ERROR_RE = /App threw an error during load/;
let abortReason = "";
function abort(reason) {
  if (abortReason) return;
  abortReason = reason;
  child.kill("SIGKILL");
}
const watchdog = setTimeout(() => abort(`timed out after ${SMOKE_TIMEOUT_MS / 1000}s`), SMOKE_TIMEOUT_MS);
const loadErrorPoll = setInterval(() => {
  // 给 Electron 一拍时间把错误栈打完再杀，报错信息才完整。
  if (LOAD_ERROR_RE.test(output)) setTimeout(() => abort("smoke worker threw during load"), 300);
}, 250);

const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
});
clearTimeout(watchdog);
clearInterval(loadErrorPoll);

const dataDirs = [...output.matchAll(/dataDir=([^\s]+)/g)].map((match) => match[1]);
for (const dataDir of new Set(dataDirs)) {
  await rm(dataDir, { recursive: true, force: true });
}

if (result.error) console.error(result.error.stack || result.error);
if (abortReason) console.error(`Browser smoke aborted: ${abortReason}`);
else if (result.signal) console.error(`Browser smoke Electron child exited with signal ${result.signal}`);
process.exitCode = abortReason ? 1 : result.code || (output.includes("Browser smoke passed:") ? 0 : 1);
