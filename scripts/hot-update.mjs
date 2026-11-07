// scripts/hot-update.mjs —— `npm run app:update`：不中断隧道的 .app 热更新编排器（仅 macOS）。
//
// 背景：旧流程 build-macos-app.sh 要求先退出桌面（显式退出会清理隧道）再 rm -rf + ditto 覆盖
// .app，每次更新集群侧 ssh 反向隧道都会断一下。热更新把"换包"和"换进程"拆开：
//   1. 旁路构建：build-macos-app.sh --output 构建到 dist/staging/<id>/，现役 .app 不动；
//      staged 包先做冒烟（fixture 模式跑一遍 monitor-server，临时端口 + 临时数据目录）与验签。
//   1.5 隧道保护预检（换包前）：用新包代码 + 新包 config.json + 生产个人层算换包后的隧道目标，
//      运行中的隧道会消失或签名变化就拒绝（--force 跳过）——supervisor 按路径重读现役包里的
//      config.json，换包一完成就会按新配置收敛，事后的 pid 比对救不回已停掉的隧道。
//   2. 原子换包：同卷 rename 现役 .app → dist/backup/<旧版本>-<时间戳>（备份即 .app，与
//      --rollback 的布局一致），再 rename staged → 现役路径。rename 不改 inode，正在运行的
//      旧 supervisor/proxy 二进制继续有效。
//   3. 控制面热重启：桌面在跑（进程注册表 desktop-main 记录经 pid 存活 + 命令行校验）则发
//      SIGUSR2，桌面只重启控制面（Electron 主进程 + monitor-server），等 /api/build-info 报告
//      新构建；45s 内没起来就自动换回旧包再 SIGUSR2。
//   4. 数据面按需平滑交接：supervisor 代码变了才 POST /api/data-plane/upgrade 交接，隧道 pid
//      前后必须不变；proxy 交接可选（--with-proxy / TTY 确认）；ssh 隧道本身从不重启。
//   5. 修剪备份（保留 2 份），但绝不删除仍有进程在执行其二进制的备份目录（lsof txt 判定）。
//
// 可测性：所有副作用（exec / fs / fetch / 信号 / 时钟 / 冒烟 / 交互）都经 ctx 注入；
// hot-update.test.mjs 用假 ctx 覆盖全部分支，不做真构建、不发真信号。
//
// 模块布局（scripts/hot-update/）：
//   orchestrate.mjs    参数解析 + 主流程（update / rollback / dry-run 计划）
//   bundle.mjs         原子换包 / 换回 + 备份修剪（lsof 判定仍在执行的备份）
//   smoke.mjs          staged 包冒烟（fixture 模式 monitor-server）
//   control-plane.mjs  desktop-main 识别 + SIGUSR2 热重启 + 超时自动回退
//   data-plane.mjs     supervisor/proxy 平滑交接计划与执行（隧道 pid 前后必须一致）
//   tunnel-guard.mjs   换包前的隧道保护预检（新代码算出的目标集 vs 运行中隧道签名）
//   api.mjs            本机控制面 HTTP API（token 只在内存里流转）
//   layout.mjs         路径布局与 build-info 读取
// 本文件只保留真实 ctx（下方 createRealContext）与入口守卫；测试直接 import scripts/hot-update/*.mjs。

import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import { computeComponentHashes } from "../work/monitor/lib/component-version.mjs";
import { utf8LocaleEnv } from "../work/monitor/lib/process-registry.mjs";
import { main } from "./hot-update/orchestrate.mjs";
import { resolveLayout } from "./hot-update/layout.mjs";
import { defaultSmoke } from "./hot-update/smoke.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { confirmYes } from "./lib/prompt.mjs";

// ---------------------------------------------------------------------------
// 真实 ctx
// ---------------------------------------------------------------------------

function createRealContext({ log = (line) => console.log(line) } = {}) {
  const run = (cmd, args, { inherit = false } = {}) => new Promise((resolve) => {
    if (inherit) {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.once("error", (err) => resolve({ code: 127, stdout: "", stderr: err.message }));
      child.once("exit", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
      return;
    }
    // ps/pgrep 在 C 区域下会把中文路径转义成 M-...，与 .app 路径比较永远失败；统一走 UTF-8 区域。
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, env: utf8LocaleEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 127) : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
  return {
    platform: process.platform,
    log,
    run,
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
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return err.code === "EPERM";
      }
    },
    kill: (pid, sig) => process.kill(pid, sig),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    smoke: (stagedApp) => defaultSmoke(stagedApp, { log }),
    computeHashes: (root) => computeComponentHashes(root),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: (question) => confirmYes(question),
  };
}

if (isMainModule(import.meta.url)) {
  const ctx = createRealContext();
  main(process.argv.slice(2), ctx, resolveLayout())
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`热更新异常中止: ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}
