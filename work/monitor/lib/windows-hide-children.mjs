// windows-hide-children.mjs —— Windows 安装版：子进程一律不弹黑色命令行窗口。
//
// 为什么需要：桌面 App 的各进程（Electron 主进程，以及以 ELECTRON_RUN_AS_NODE 跑的 monitor-server /
// channel-supervisor / 本地代理）都是 GUI 子系统的 exe，自己没有控制台。它们每起一个控制台程序
// （ssh.exe、powershell、tasklist …），Windows 就给那个子进程新开一个可见的控制台窗口——监控每拍都在
// 跑 ssh，桌面上就会不停闪黑框。网页模式（node.exe 在终端里跑）没有这个问题：子进程共用父进程的控制台。
//
// 做法：在这些入口最先 import 本模块，把 node:child_process 的 spawn / exec 系列包一层——调用方没写
// windowsHide 时补上 true（写了 false 的原样尊重），再用 syncBuiltinESMExports 让各模块
// `import { spawn } from "node:child_process"` 拿到的绑定也换成包过的版本。只在 Windows 且跑在
// Electron 里时生效；macOS / Linux / 网页模式完全不动。
//
// 必须是入口的第一个 import：ESM 按 import 顺序求值，之后的模块在顶层取到的 execFile
// （例如 promisify(execFile)）才是包过的。

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const PATCHED = Symbol.for("codex-monitor.windows-hide-children");

export function shouldHideChildWindows({ platform = process.platform, versions = process.versions } = {}) {
  return platform === "win32" && Boolean(versions?.electron);
}

// 给一次调用的参数补上 windowsHide。argvSlot：第二个参数可以是参数数组（spawn / execFile 一族）；
// exec 一族第二个参数直接是选项。只在调用方没写 windowsHide 时补，不改调用方传进来的对象。
export function withWindowsHide(args, { argvSlot }) {
  const out = [...args];
  let i = 1;
  if (argvSlot && (Array.isArray(out[1]) || (out[1] == null && out.length > 2))) i = 2;
  const opts = out[i];
  if (opts && typeof opts === "object" && !Array.isArray(opts)) {
    if (opts.windowsHide === undefined) out[i] = { ...opts, windowsHide: true };
  } else if (opts == null && i < out.length) {
    out[i] = { windowsHide: true };
  } else if (opts == null || typeof opts === "function") {
    out.splice(i, 0, { windowsHide: true });
  }
  return out;
}

const METHODS = [
  ["spawn", true],
  ["spawnSync", true],
  ["execFile", true],
  ["execFileSync", true],
  ["exec", false],
  ["execSync", false],
];

export function installWindowsHide(cp = childProcess) {
  if (cp[PATCHED]) return false;
  for (const [name, argvSlot] of METHODS) {
    const original = cp[name];
    if (typeof original !== "function") continue;
    const wrapped = function (...args) {
      return original.apply(this, withWindowsHide(args, { argvSlot }));
    };
    // promisify(execFile / exec) 靠这个自定义实现才 resolve 成 { stdout, stderr }；丢了它，
    // 包过的版本被 promisify 后只会拿到 stdout。
    const custom = original[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args) => custom(...withWindowsHide(args, { argvSlot })),
      });
    }
    cp[name] = wrapped;
  }
  cp[PATCHED] = true;
  return true;
}

if (shouldHideChildWindows()) {
  installWindowsHide(childProcess);
  syncBuiltinESMExports();
}
